# Testbed — local iMessage stand-in

Test Alpha's real brain without deploying or texting the prod thread.

```
npm run testbed          # → http://localhost:5178
```

Needs `GMI_API_KEY` in `.env` (already there). That's it.

## What's real vs faked

| Real | Faked (fixtures) |
|---|---|
| `runHireTurn` — the exact prod turn engine | profile (hired? name? tz?) |
| GMI model calls | connected tools list |
| Thread memory (`testbed/data/`, same format as bots) | Gmail / Calendar / Drive reads |
| Web search (real DuckDuckGo) | nutrition/sleep/workout/budget writes |
| Maps (fixture picks, deterministic) | card minting (opens local placeholder) |
| Outbound sanitize / bubble split / stop-limits | iMessage delivery (bubbles stream to UI) |

## The loop

1. Type in the chat → runs the REAL engine against YOUR fixtures.
2. Gray dashed chips = writes the bot made (drafts, reminders, logs) — inspectable.
3. 📎 chip = mini-app card; opens a local placeholder (flow is what's tested).
4. **⚙︎ Fixtures** — toggle connected tools, name, tz, memories mid-conversation.
5. **Reset** — wipes `testbed/data/` → next text is a genuine first text. This is
   the piece prod can't give you: disposable memory, so testing onboarding or a
   regression never pollutes the real thread.

## Rules of the road

- Fix a bug → **testbed first**, `npm test`, then push. Prod texting is the last
  mile, not the dev loop.
- The shim answers `/api/internal/*` only; GMI + DDG hit the real internet.
- `testbed/data/` and `testbed/fixtures.json` are gitignored — never commit them.
- Nothing here can text a real phone. By design.

## Bugs it caught on night one (proof it works)

1. `parseActionJson` — DeepSeek echoes the action JSON twice; strict parse died,
   lookups never ran, model answered from memory ("no live tools connected").
2. `<think>` tags from DeepSeek reasoning leaked into outbound texts.
3. Degenerate repetition (one phrase ×∞) had no guard — would have texted garbage.
4. Loop prompt didn't force lookups for news/price asks.
