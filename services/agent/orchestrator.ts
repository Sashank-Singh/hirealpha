import { generateText, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { searchWeb } from "../tools/search";
import { browseWebpage, crawlWebpages } from "../tools/browser";
import { executeCode } from "../tools/interpreter";
import { triggerN8nWorkflow } from "../tools/n8n";

/**
 * Tool definitions exposed to the Orchestrator / Subagents
 */
export const agentTools = {
  // 1. Live Web Search (DuckDuckGo, 100% free)
  web_search: tool({
    description: "Search the live web for real-time information, movie showtimes, flight prices, articles, and documentation.",
    parameters: z.object({
      query: z.string().describe("The search query keywords"),
      limit: z.number().optional().default(5).describe("Max number of search results to return"),
    }),
    execute: async ({ query, limit }) => {
      console.log(`[Search Subagent] Querying: "${query}"`);
      const results = await searchWeb(query, limit);
      return { results };
    },
  }),

  // 2. Autonomous Browser Navigation & Scraping (Playwright / Crawlee)
  browse_webpage: tool({
    description: "Open a headless browser, navigate to a specific URL, optionally click buttons or fill forms, and extract text and page state.",
    parameters: z.object({
      url: z.string().describe("The full web URL to navigate to"),
      clickSelector: z.string().optional().describe("CSS selector of an element to click on the page"),
      fillSelector: z.string().optional().describe("CSS selector of an input field to fill"),
      fillValue: z.string().optional().describe("Value to fill into the input field"),
      takeScreenshot: z.boolean().optional().default(false).describe("Whether to capture a base64 screenshot"),
    }),
    execute: async ({ url, clickSelector, fillSelector, fillValue, takeScreenshot }) => {
      console.log(`[Browser Subagent] Navigating to: ${url}`);
      const pageData = await browseWebpage(url, {
        clickSelector,
        fillSelector,
        fillValue,
        takeScreenshot,
      });
      return pageData;
    },
  }),

  // 3. Batch Web Crawler (Crawlee)
  crawl_urls: tool({
    description: "Batch crawl multiple web pages and extract cleaned text content.",
    parameters: z.object({
      urls: z.array(z.string()).describe("List of URLs to crawl"),
      maxRequests: z.number().optional().default(3),
    }),
    execute: async ({ urls, maxRequests }) => {
      console.log(`[Crawler Subagent] Crawling ${urls.length} URLs`);
      const results = await crawlWebpages(urls, maxRequests);
      return { crawledPages: results };
    },
  }),

  // 4. Code & Script Interpreter
  execute_code: tool({
    description: "Execute Javascript or Python code in a safe sandbox to perform calculations, data transforms, or text processing.",
    parameters: z.object({
      code: z.string().describe("The code script to evaluate"),
      language: z.enum(["javascript", "python"]).default("javascript"),
    }),
    execute: async ({ code, language }) => {
      console.log(`[Code Interpreter Subagent] Running ${language} snippet`);
      const execution = await executeCode(code, language);
      return execution;
    },
  }),

  // 5. Self-Hosted n8n Automation Connector
  trigger_n8n_automation: tool({
    description: "Trigger a self-hosted n8n workflow webhook to automate SaaS actions (Slack, Gmail, Notion, CRM, etc.).",
    parameters: z.object({
      webhookPath: z.string().describe("The webhook path configured in n8n (e.g. 'send-slack-alert' or 'book-calendar')"),
      payload: z.record(z.any()).describe("JSON payload to pass to the n8n workflow"),
    }),
    execute: async ({ webhookPath, payload }) => {
      console.log(`[n8n Connector] Triggering webhook /${webhookPath}`);
      const result = await triggerN8nWorkflow(webhookPath, payload);
      return result;
    },
  }),
};

/**
 * Launches an autonomous subagent with access to the full tool suite using Vercel AI SDK.
 * Handles messy, casual human prompts by autonomously resolving context, defaults, and multi-step tool execution.
 */
export async function launchSubagent(
  userPrompt: string,
  options: {
    modelName?: string;
    userLocation?: string;
    timezone?: string;
    userId?: string;
  } = {}
) {
  const modelName = options.modelName || "gpt-4o-mini";
  const userLocation = options.userLocation || "San Francisco, CA";
  const currentDate = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const currentTime = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

  console.log(`[Orchestrator] Launching subagent for: "${userPrompt}" (Location: ${userLocation})`);

  const result = await generateText({
    model: openai(modelName),
    tools: agentTools,
    maxSteps: 10,
    system: `You are an intuitive, action-oriented autonomous personal assistant with full computer, web, and automation capabilities.

CONTEXT:
- Current Date: ${currentDate}
- Current Time: ${currentTime}
- Default User Location: ${userLocation}

BEHAVIOR RULES:
1. Handle Casual Human Prompts: Users speak naturally and briefly (e.g. "get 2 tickets for avatar tonight", "find cheap flights to NYC this weekend").
2. Autonomous Slot-Filling & Defaults:
   - Resolve "tonight", "tomorrow", or "next Friday" using the current date above.
   - Use default location (${userLocation}) when no location is explicitly stated.
   - Assume standard sensible preferences (e.g. evening showtimes for "tonight", reasonable seating, non-stop or shortest flights).
3. Tool Execution Strategy:
   - Use 'web_search' to find live showtimes, flight prices, menus, or event schedules.
   - Use 'browse_webpage' or 'crawl_urls' to inspect actual ticketing pages, seat availability, and total checkout prices.
   - Use 'execute_code' to calculate totals with taxes/fees, split payments, or parse messy structured data.
   - Use 'trigger_n8n_automation' when external notifications (Slack, Email, Calendar) are needed.
4. Output Format:
   - Do NOT dump raw tool execution steps or debugging logs.
   - Present a concise, elegant, human-ready response with top 2-3 options, total price, and direct booking links.
   - Offer the clear next action (e.g. "Would you like me to hold these seats?").`,
    prompt: userPrompt,
  });

  return {
    text: result.text,
    steps: result.steps,
    toolCalls: result.toolCalls,
    toolResults: result.toolResults,
  };
}
