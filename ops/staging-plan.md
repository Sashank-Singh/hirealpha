# Staging deployment plan (Phase 9 — execution requires explicit go)

## Why it exists

Certification suites (`bun run scripts/certify.ts`), the Playwright nav specs
(`e2e/`), and the load protocol all need an isolated environment that is NOT
production (hirealpha.chat) and NOT a developer laptop.

## Target topology (Coolify, same VPS or second small VPS)

| Component | Prod today | Staging |
|---|---|---|
| Web API + /app | `hirealpha.chat` (app `ampdaixdebfrlv7pqcmojhb5`) | new app `hirealpha-staging-web`, domain `staging.hirealpha.chat`, own Postgres database `hirealpha_staging` |
| Browser worker | worker container (shared Chromium) | new worker container with staging `DATABASE_URL`, `E2B_API_KEY`, `HIREALPHA_ALLOW_LOCAL_BROWSER=1` only if local fallback wanted |
| Friend bot | Photon container | none — bot flows tested on prod with the founder test phone; staging covers web/worker/trust only |
| Postgres | prod DB | separate DB; staging cert DB `hirealpha_cert` created from it for migration suites |

## Deploy sequence (once approved)

1. Create staging Postgres DB: `CREATE DATABASE hirealpha_staging;`
2. Coolify → new app from this repo's `Dockerfile.web`, branch `main`, domain
   `staging.hirealpha.chat`, env from deploy/env-contract.md staging column.
3. First boot runs `bun run migrate.ts` (Dockerfile.web) → blank-DB migration
   run = certification evidence for suite `postgres-migrations-and-isolation`
   step 1 (record revision + date).
4. Deploy worker app from `Dockerfile.worker` with staging envs.
5. Set `E2E_BASE_URL=https://staging.hirealpha.chat` + `E2E_EMAIL`/`E2E_PASSWORD`
   (test account created in staging) → `npx playwright test`.
6. Run `bun run scripts/certify.ts` with staging envs exported → evidence commit.
7. Canary: seed 3 synthetic accounts, exercise signup→checkout(test mode)→intro→
   wizard→brief; no real purchases anywhere in staging.
8. Load suite (20 browser jobs / 5 users) — only after E2B envs live.

## Rollback

Coolify → Deployments → redeploy previous build (prod path already proven).
Staging has no data worth keeping; teardown = delete apps + drop DBs.

## Gates before ANY prod deploy of the trust stack

- Postgres + OpenBao + E2B suites PASS in staging evidence.
- Stripe Link test-mode lifecycle operator-run recorded.
- No critical/high findings open (see launch-readiness.md item 14).
- Explicit user go (standing rule: never push/deploy without asking).
