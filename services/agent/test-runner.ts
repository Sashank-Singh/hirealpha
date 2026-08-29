import { searchWeb } from "../tools/search";
import { executeCode } from "../tools/interpreter";

async function runTests() {
  console.log("=== 1. Testing DuckDuckGo Zero-Key Web Search ===");
  const searchResults = await searchWeb("latest avatar movie showtimes", 2);
  console.log("Search Results:", JSON.stringify(searchResults, null, 2));

  console.log("\n=== 2. Testing Code Interpreter Subagent ===");
  const mathCode = "const prices = [21.5, 21.5, 18.0]; const total = prices.reduce((a,b)=>a+b,0) * 1.0875; console.log(`Total with tax: $${total.toFixed(2)}`);";
  const codeResult = await executeCode(mathCode, "javascript");
  console.log("Interpreter Output:", codeResult);

  console.log("\n=== Subagent Tool Tests Finished Successfully ===");
}

runTests().catch(console.error);
