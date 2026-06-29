import { chromium } from "playwright";

const WORKER_URL = process.env.WORKER_URL;

if (!WORKER_URL) {
  console.error("WORKER_URL env var required");
  process.exit(1);
}

async function main() {
  console.log("Fetching watches from", WORKER_URL);
  const watchesRes = await fetch(`${WORKER_URL}/api/watches`);
  const { watches } = await watchesRes.json();

  if (!watches || watches.length === 0) {
    console.log("No watches configured — nothing to scrape");
    return;
  }

  console.log(`Found ${watches.length} watched event(s)`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });

  const results = [];

  for (const watch of watches) {
    if (new Date(watch.date) < new Date()) {
      console.log(`Skipping ${watch.slug} — event already passed`);
      continue;
    }

    // Search TicketData for this event
    const searchName = watch.name.replace(/[-–:]/g, " ").replace(/\s+/g, " ").trim();
    const searchUrl = `https://www.ticketdata.com/search?q=${encodeURIComponent(searchName)}`;
    console.log(`\nSearching TicketData for: ${searchName}`);
    console.log(`URL: ${searchUrl}`);

    const page = await context.newPage();
    try {
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(4000);

      // Find the event link in search results and click it
      const eventLink = await page.evaluate((name) => {
        const links = document.querySelectorAll("a");
        const lower = name.toLowerCase();
        for (const a of links) {
          const text = (a.textContent || "").toLowerCase();
          if (text.includes(lower.split(" ")[0]) && a.href.includes("/event/")) {
            return a.href;
          }
        }
        // Fallback: find any event link
        for (const a of links) {
          if (a.href.includes("/event/")) return a.href;
        }
        return null;
      }, searchName);

      if (eventLink) {
        console.log(`  Found event page: ${eventLink}`);
        await page.goto(eventLink, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(4000);

        const priceData = await page.evaluate(() => {
          const text = document.body.innerText;

          // Look for "Get-In Price" or "From $X" patterns
          const patterns = [
            /get[- ]?in[- ]?price[:\s]*\$(\d[\d,]*(?:\.\d{2})?)/i,
            /from\s*\$(\d[\d,]*(?:\.\d{2})?)/i,
            /starting\s*(?:at|from)\s*\$(\d[\d,]*(?:\.\d{2})?)/i,
            /lowest[:\s]*\$(\d[\d,]*(?:\.\d{2})?)/i,
          ];
          for (const pat of patterns) {
            const m = text.match(pat);
            if (m) return { price: m[1], type: "text" };
          }

          // Look for price elements
          const selectors = [
            '[class*="price"]',
            '[class*="Price"]',
            '[data-testid*="price"]',
            'td',
            'span',
          ];
          for (const sel of selectors) {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
              const t = el.textContent?.trim() || "";
              if (/^\$\d{2,4}(\.\d{2})?$/.test(t)) {
                return { price: t.replace("$", ""), type: "element" };
              }
            }
          }

          return null;
        });

        if (priceData) {
          const price = parseFloat(priceData.price.replace(",", ""));
          console.log(`  Get-in price: $${price} (found via ${priceData.type})`);
          results.push({
            timestamp: Date.now(),
            source: "ticketdata",
            matchSlug: watch.slug,
            minPrice: price,
            maxPrice: price,
            currency: "USD",
            url: eventLink,
          });
        } else {
          console.log("  No price found on event page");
          await page.screenshot({ path: `scraper/debug-${watch.slug}-event.png`, fullPage: false });
          console.log("  Debug screenshot saved");
        }
      } else {
        console.log("  No event link found in search results");
        await page.screenshot({ path: `scraper/debug-${watch.slug}-search.png`, fullPage: false });
        console.log("  Debug screenshot saved");
      }
    } catch (err) {
      console.error(`  Error: ${err.message}`);
      await page.screenshot({ path: `scraper/debug-${watch.slug}-error.png` }).catch(() => {});
    }
    await page.close();
  }

  await browser.close();

  if (results.length > 0) {
    console.log(`\nPosting ${results.length} price(s) to worker...`);
    const res = await fetch(`${WORKER_URL}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prices: results }),
    });
    const body = await res.json();
    console.log("Worker response:", JSON.stringify(body));
  } else {
    console.log("\nNo prices scraped this run");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
