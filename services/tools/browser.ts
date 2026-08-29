import { chromium, type Browser, type Page } from "playwright";
import { PlaywrightCrawler, Dataset } from "crawlee";

export interface BrowserActionResult {
  title: string;
  url: string;
  content: string;
  screenshotBase64?: string;
}

/**
 * Autonomous Browser session tool:
 * Launches a local Chromium instance to navigate, interact, or extract text from any website.
 */
export async function browseWebpage(
  url: string,
  instructions?: {
    clickSelector?: string;
    fillSelector?: string;
    fillValue?: string;
    takeScreenshot?: boolean;
    timeoutMs?: number;
  }
): Promise<BrowserActionResult> {
  const timeoutMs = instructions?.timeoutMs || 25000;
  const browser: Browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });

  const page: Page = await context.newPage();

  try {
    // Navigate with resilient fallback
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    } catch {
      // If domcontentloaded times out on heavy dynamic resources, continue if page is partially loaded
    }

    if (instructions?.fillSelector && instructions?.fillValue) {
      try {
        await page.waitForSelector(instructions.fillSelector, { timeout: 4000 });
        await page.fill(instructions.fillSelector, instructions.fillValue);
      } catch (err: any) {
        console.warn(`[Browser] Fill selector "${instructions.fillSelector}" not found:`, err.message);
      }
    }

    if (instructions?.clickSelector) {
      try {
        await page.waitForSelector(instructions.clickSelector, { timeout: 4000 });
        await page.click(instructions.clickSelector);
        await page.waitForTimeout(1000);
      } catch (err: any) {
        console.warn(`[Browser] Click selector "${instructions.clickSelector}" not found:`, err.message);
      }
    }

    const title = (await page.title()) || url;
    const currentUrl = page.url();

    // Extract text content from main body safely
    const content = await page.evaluate(() => {
      if (!document.body) return "";
      const clone = document.body.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("script, style, noscript, svg").forEach((el) => el.remove());
      return (clone.innerText || clone.textContent || "").slice(0, 4000).trim();
    });

    let screenshotBase64: string | undefined;
    if (instructions?.takeScreenshot) {
      const buffer = await page.screenshot({ type: "jpeg", quality: 65 });
      screenshotBase64 = buffer.toString("base64");
    }

    return {
      title,
      url: currentUrl,
      content: content || `Page loaded at ${currentUrl}`,
      screenshotBase64,
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/**
 * Batch crawls and extracts data across multiple URLs using Crawlee.
 */
export async function crawlWebpages(startUrls: string[], maxRequests: number = 3): Promise<Array<{ url: string; title: string; text: string }>> {
  const results: Array<{ url: string; title: string; text: string }> = [];

  const crawler = new PlaywrightCrawler({
    maxRequestsPerCrawl: maxRequests,
    async requestHandler({ page, request }) {
      const title = await page.title();
      const text = await page.evaluate(() => document.body.innerText.slice(0, 2500));
      results.push({
        url: request.loadedUrl || request.url,
        title,
        text,
      });
    },
  });

  await crawler.run(startUrls);
  return results;
}
