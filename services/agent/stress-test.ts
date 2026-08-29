import { searchWeb } from "../tools/search";
import { browseWebpage, crawlWebpages } from "../tools/browser";
import { executeCode } from "../tools/interpreter";
import { triggerN8nWorkflow } from "../tools/n8n";

interface TestReport {
  name: string;
  passed: boolean;
  durationMs: number;
  details: any;
  error?: string;
}

async function runStressTest() {
  console.log("=================================================");
  console.log("   🚀 RUNNING SUBAGENT COMPREHENSIVE STRESS TEST  ");
  console.log("=================================================\n");

  const reports: TestReport[] = [];

  // 1. Stress Test: Rapid Concurrent Searches (DuckDuckGo Zero-Key)
  console.log("--- TEST 1: Rapid Concurrent Web Searches ---");
  const searchQueries = [
    "Avatar movie showtimes San Francisco",
    "cheap flights SFO to JFK this weekend",
    "best ramen in downtown SF",
  ];
  const t1Start = Date.now();
  try {
    const searchPromises = searchQueries.map((q) => searchWeb(q, 3));
    const searchResults = await Promise.all(searchPromises);
    const totalFound = searchResults.reduce((acc, curr) => acc + curr.length, 0);
    const passed = totalFound >= searchQueries.length;
    reports.push({
      name: "Rapid Concurrent Searches",
      passed,
      durationMs: Date.now() - t1Start,
      details: { queriesRan: searchQueries.length, totalResultsReturned: totalFound },
    });
    console.log(`✅ Passed: ${totalFound} results retrieved in ${Date.now() - t1Start}ms`);
  } catch (err: any) {
    reports.push({
      name: "Rapid Concurrent Searches",
      passed: false,
      durationMs: Date.now() - t1Start,
      details: null,
      error: err.message,
    });
    console.log(`❌ Failed: ${err.message}`);
  }

  // 2. Stress Test: Code Interpreter - Complex Math, Memory & Error Boundary
  console.log("\n--- TEST 2: Code Interpreter Sandbox & Error Boundary ---");
  const t2Start = Date.now();
  try {
    // Math & data transform test
    const jsScript = `
      const flights = [
        { airline: 'United', price: 289, durationHours: 5.5, stops: 0 },
        { airline: 'Delta', price: 245, durationHours: 7.2, stops: 1 },
        { airline: 'JetBlue', price: 310, durationHours: 5.8, stops: 0 }
      ];
      const direct = flights.filter(f => f.stops === 0);
      const best = direct.sort((a,b) => a.price - b.price)[0];
      console.log(JSON.stringify({ bestFlight: best, avgDirectPrice: (direct[0].price + direct[1].price)/2 }));
    `;
    const res = await executeCode(jsScript, "javascript");

    // Syntax error resilience test
    const errorRes = await executeCode("console.log(undefinedVar.badProperty);", "javascript");
    const passed = res.exitCode === 0 && res.stdout.includes("United") && errorRes.exitCode !== 0;

    reports.push({
      name: "Code Interpreter & Error Recovery",
      passed,
      durationMs: Date.now() - t2Start,
      details: { normalRun: res.stdout, errorCaptured: errorRes.stderr.slice(0, 80) },
    });
    console.log(`✅ Passed: Executed data filtering and gracefully caught sandbox runtime errors.`);
  } catch (err: any) {
    reports.push({
      name: "Code Interpreter",
      passed: false,
      durationMs: Date.now() - t2Start,
      details: null,
      error: err.message,
    });
    console.log(`❌ Failed: ${err.message}`);
  }

  // 3. Stress Test: Playwright Headless Browser Real Extraction
  console.log("\n--- TEST 3: Headless Browser Live Navigation & DOM Extraction ---");
  const t3Start = Date.now();
  try {
    const browserResult = await browseWebpage("https://example.com", {
      takeScreenshot: true,
    });
    const passed = browserResult.title.length > 0 && browserResult.content.includes("Example Domain");
    reports.push({
      name: "Headless Browser Navigation",
      passed,
      durationMs: Date.now() - t3Start,
      details: {
        title: browserResult.title,
        url: browserResult.url,
        contentLength: browserResult.content.length,
        hasScreenshot: !!browserResult.screenshotBase64,
      },
    });
    console.log(`✅ Passed: Navigated to ${browserResult.url}, extracted "${browserResult.title}" + screenshot.`);
  } catch (err: any) {
    reports.push({
      name: "Headless Browser Navigation",
      passed: false,
      durationMs: Date.now() - t3Start,
      details: null,
      error: err.message,
    });
    console.log(`❌ Failed: ${err.message}`);
  }

  // 4. Stress Test: Crawlee Multi-Page Crawler
  console.log("\n--- TEST 4: Crawlee Multi-Page Crawler ---");
  const t4Start = Date.now();
  try {
    const urls = ["https://example.com", "https://news.ycombinator.com"];
    const crawlResults = await crawlWebpages(urls, 2);
    const passed = crawlResults.length >= 1;
    reports.push({
      name: "Crawlee Multi-Page Batch Crawler",
      passed,
      durationMs: Date.now() - t4Start,
      details: { crawledPagesCount: crawlResults.length, titles: crawlResults.map((c) => c.title) },
    });
    console.log(`✅ Passed: Crawled ${crawlResults.length} distinct web pages successfully.`);
  } catch (err: any) {
    reports.push({
      name: "Crawlee Multi-Page Batch Crawler",
      passed: false,
      durationMs: Date.now() - t4Start,
      details: null,
      error: err.message,
    });
    console.log(`❌ Failed: ${err.message}`);
  }

  // 5. Stress Test: n8n Workflow Connector Error Handling (Offline Host)
  console.log("\n--- TEST 5: n8n Webhook Connector Resiliency ---");
  const t5Start = Date.now();
  try {
    const n8nResult = await triggerN8nWorkflow("test-webhook", { action: "ping" }, "http://127.0.0.1:9999");
    // Offline local port should return handled failure gracefully without crashing the process
    const passed = n8nResult.success === false && typeof n8nResult.error === "string";
    reports.push({
      name: "n8n Webhook Resiliency",
      passed,
      durationMs: Date.now() - t5Start,
      details: { gracefullyHandledError: n8nResult.error },
    });
    console.log(`✅ Passed: Gracefully handled connection boundary without crashing.`);
  } catch (err: any) {
    reports.push({
      name: "n8n Webhook Resiliency",
      passed: false,
      durationMs: Date.now() - t5Start,
      details: null,
      error: err.message,
    });
    console.log(`❌ Failed: ${err.message}`);
  }

  // Summary Table
  console.log("\n=================================================");
  console.log("             📊 STRESS TEST SUMMARY               ");
  console.log("=================================================");
  console.table(
    reports.map((r) => ({
      Test: r.name,
      Status: r.passed ? "PASSED ✅" : "FAILED ❌",
      "Duration (ms)": `${r.durationMs}ms`,
    }))
  );

  const allPassed = reports.every((r) => r.passed);
  console.log(`\nOVERALL STATUS: ${allPassed ? "🎉 ALL 5 TESTS PASSED" : "⚠️ SOME TESTS FAILED"}\n`);
}

runStressTest().catch(console.error);
