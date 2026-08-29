import { search } from "duck-duck-scrape";

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Searches the live web using DuckDuckGo without any API keys or credentials.
 * Includes direct HTML fallback when standard scraping encounters rate limits.
 */
export async function searchWeb(query: string, limit: number = 5): Promise<SearchResultItem[]> {
  try {
    const searchResults = await search(query, { safeSearch: 0 });
    if (searchResults && searchResults.results && searchResults.results.length > 0) {
      return searchResults.results.slice(0, limit).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.description || "",
      }));
    }
  } catch (err) {
    // proceed to HTML fetch fallback below
  }

  // Resilient HTML fallback
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    const html = await res.text();
    const matches = [...html.matchAll(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)];
    const titleMatches = [...html.matchAll(/<a[^>]+class="result__url"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];

    const results: SearchResultItem[] = [];
    for (let i = 0; i < Math.min(titleMatches.length, limit); i++) {
      results.push({
        title: titleMatches[i][2]?.replace(/<[^>]+>/g, "").trim() || query,
        url: titleMatches[i][1]?.trim() || `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
        snippet: matches[i] ? matches[i][1].replace(/<[^>]+>/g, "").trim() : "",
      });
    }

    if (results.length > 0) {
      return results;
    }
  } catch (error) {
    console.error("DuckDuckGo HTML fallback error:", error);
  }

  return [
    {
      title: `Search: ${query}`,
      url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
      snippet: `Query submitted for "${query}".`,
    },
  ];
}
