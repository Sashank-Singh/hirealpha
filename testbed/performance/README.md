# App startup regression check

Run `npm run test:app-load` from the project root. Requires the project's Bun,
Playwright dependency, and an installed Google Chrome. The command builds the
app, serves it on an ephemeral loopback port, and opens five fresh mobile-sized
browser contexts: login, authenticated settings, Home, Later, and Nutrition.

No real account or network service is used. A fake local session is accepted
only by the local test server. Other API calls return 503 and external requests
are blocked, exercising initial rendering and offline/error handling. This
checks startup code and graceful rendering, not authenticated data correctness.

The test records requested JavaScript files, raw and gzip bytes, visible text,
and screenshots in `testbed/load-results/app-speed/`. It fails on browser errors,
a blank/stuck page, an unexpected sign-in gate, oversized startup code, or
unrelated Landing/alternate-home/work screen chunks. The byte budgets are in
`app-load.ts`; review any increase rather than simply raising them.

Gzip sizes are computed per downloaded file. They are not a measurement of
production transfer encoding. The local server does not replicate production
preload hints, caching, CDN/network conditions, or API latency. No real-device
speed claim should be inferred from these byte measurements.

## September 7 optimization results

A separate build with the prior eager screen imports was compared against the
on-demand version using the same browser checks and local source snapshot.

| Screen | Before JS | After JS | Reduction | Gzip before → after |
|---|---:|---:|---:|---:|
| Home | 595,375 B | 326,237 B | 45% | 175,180 → 105,071 B |
| Later | 595,375 B | 301,903 B | 49% | 175,180 → 97,506 B |
| Nutrition | 595,375 B | 348,512 B | 41% | 175,180 → 109,081 B |

Mini-app screens now load on demand behind a local Suspense boundary, keeping
navigation visible. Production HTML preloads the selected main screen alongside
the route shell. Settings code begins loading alongside its authentication gate;
server-side session checks remain required. External font stylesheets are
nonblocking so system fallbacks can paint immediately. No personalized data was
added to static caches. Changes have not been deployed by this task.
