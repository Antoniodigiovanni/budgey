# Wealth verification

Implementation directory: `/home/hermes/workspace/budgey-implementation`. No promotion, service changes, public routing changes or live database mutation performed.

## Implemented

- Additive migration `003_wealth.sql`: household composite foreign keys, safe amount checks, append-only records, indexes, and deferred full cash/unit timeline checks for direct event inserts. Existing migrations and ledger tests are unchanged.
- Pure typed integer calculations for dated bank/card balances, manual assets and debts, portfolio cash/holdings and monthly recorded history. Fractional units are millionths; holding value rounds half up to cents. Latest prior observations carry forward with visible dates. Unknown values and explicit zero remain distinct.
- Authenticated household-scoped wealth reads and six write resources under `/api/wealth`. Existing Origin enforcement, serialized idempotent writes and audit transaction apply. Schema/ownership checks precede insertion; provisional history is validated inside the same transaction before commit. Validation errors return 400 with useful messages. Readiness requires the new migration.
- Functional Balance sheet and Investments navigation, dated forms, loading/errors/empty states, retained failed drafts, duplicate-submit guards, and stored histories. Household currency is used throughout. External flows never write to budget accounts or envelope funds. No gain, basis or performance claims.
- Explicit opt-in fictional demo seed, one atomic application per demo household, with guarded replay. Includes property/mortgage, two dated observations, opening cash, deposit, fractional buy, partial sale, dividend, fee, withdrawal and three prices.

## Local evidence

- `npm test` before implementation: failed because the new calculation module did not exist. Original RED retained in `evidence/wealth-red.log`.
- A later historical-overflow regression: five tests passed and one failed before the validation helper existed. RED retained in `evidence/wealth-history-red.log`. A separate exact-currency-display RED is retained in `evidence/wealth-display-red.log`; the formatter preserves cents even at the safe integer limit.
- `node --import tsx tests/wealth.test.ts`: all seven final pure arithmetic/display tests pass; full assertions and counts in `evidence/wealth-pure-tests.log`. Explicit expectations include cash 8,945 cents, remaining units 0.75, holding value 1,576 cents, portfolio total 10,521 cents; half-cent rounds up; property less mortgage and bank/card equals 159,000 cents; brokerage counts once; recorded history carries forward without fabricated growth.
- `npm test`: passes locally, but connected tests are opt-in. The file-level reporter does not expose nested skips; it is **not** evidence of connected acceptance. `evidence/wealth-individual-tests.log` and `evidence/wealth-db-opt-in.log` explicitly show skipped database/API tests when the required test environment is absent. Final direct runs total 20 passed and four skipped: 13 existing nonconnected tests, seven new pure tests, and four opt-in connected tests.
- `npm run typecheck`: passes. `npm run build`: passes with the config runner; client and server output remain in this directory. The first build failure is preserved in `evidence/wealth-build.log`: the default config bundler tried to create a temporary file beside the shared dependency symlink. The build script now uses `vite build --configLoader runner`, avoiding writes to that shared directory. Successful build output is in `evidence/wealth-build-green.log`.
- Changed code and documentation checked with the installed formatter; browser and host scripts checked with `node --check`.

### Connection limitation

One migration attempt against the supplied disposable database failed with `connect EPERM /home/hermes/workspace/budgey-demo/socket/.s.PGSQL.55432`. See `evidence/wealth-migrate.log`. No connection retries or sandbox bypasses were attempted. No database migrations or connected assertions succeeded locally. A browser run depends on a migrated disposable database, so screenshots and browser assertions are pending host execution, not fabricated.

## Host acceptance

Run from this isolated source tree:

```sh
cd /home/hermes/workspace/budgey-implementation
npm run build
node scripts/verify-wealth-host.mjs
```

The workflow hardcodes only the authorized disposable database:

```text
postgresql:///budgey_wealth_test?host=/home/hermes/workspace/budgey-demo/socket&port=55432&user=hermes
```

It creates a fresh `acceptance_wealth_<timestamp>` schema, sets the server connection search path to that schema only, migrates it, refuses an already-serving port 3102, and starts an authenticated test server on `127.0.0.1:3102`. It runs existing tests first with `TEST_DATABASE_URL` and `TEST_API_URL` set, then dedicated wealth API assertions. Original API seed/count expectations remain isolated from wealth/browser additions. All six original test files were compared byte-for-byte with the source snapshot and are unchanged. PostgreSQL tests also use their own disposable schemas. Afterward it marks only that test household as fictional, runs the wealth seed twice, verifies exact seeded cash 120,550 cents and value 144,550 cents, checks unchanged row/audit counts on replay, and drives the actual UI forms with persisted readback. It stops its own server and drops its own schema in `finally`.

Host output is recorded in `docs/evidence/wealth-host-*.log`. Browser acceptance writes `wealth-browser-assertions.json` and two mobile screenshots. The script checks asset creation, dated valuation, reload, historical missing value, portfolio/security creation, fractional trade, missing price warning, exact priced value, rejected oversell retaining input, and both tabs at 390px. These files exist only after real execution. No physical-device or public-login acceptance is claimed.

The browser runner defaults to the supplied installed browser package path. If needed, set `PLAYWRIGHT_MODULE` to another installed module entrypoint; no shared dependency installation is required.

## Seed after promotion

Only after backup, independently verified source promotion and the additive migration, in the parent's correctly configured nonproduction demo environment:

```sh
WEALTH_DEMO_SEED=yes DEMO_OWNER=demo@example.com npm run seed:wealth
```

This command intentionally uses that environment's `DATABASE_URL`; do not run it against real financial data. The implementation has not run this command against the live demo. The host acceptance workflow runs the same command only against its disposable test schema, with `DEMO_OWNER=test@example.com`.

## Limits

No automatic prices, FX, tax basis, gains, investment performance calculations, executions or bank-to-portfolio synchronization. One immutable valuation/price per record per date; additional observations use another date. Activity is ordered by date then entry sequence, with invalid negative cash or units rejected across the whole timeline. There is no destructive edit/delete/void UI. Host database, API, browser and seed checks remain required before promotion. The initial repository has no commits; no commits or pushes were made.

## Repair verification (2026-11-02)

- Converted every wealth control to an explicit `htmlFor`/`id` association. IDs include a React component instance ID, form resource and field name, so repeated names across forms remain unique. Existing accessible field labels and browser assertions are unchanged.
- Removed tutorial, history and gains/tax/performance filler. Kept terse missing-value, incomplete-valuation and missing-price warnings; opening cash counted once; one manual external-flow warning; decimal units, rounding, fee and immutable valuation constraints. Shortened wealth documentation headings.
- `npm test`: PASS (8 file-level tests; connected tests remain opt-in and were not exercised). Changed-file Prettier check: PASS.
- `npm run typecheck`: PASS. `npm run build`: PASS.
- `node scripts/verify-wealth-host.mjs`: blocked by sandbox denial of the authorized disposable PostgreSQL socket (`connect EPERM /home/hermes/workspace/budgey-demo/socket/.s.PGSQL.55432`). No acceptance step completed in this repair run. Existing evidence logs were not edited and do not establish acceptance of this repair. All six PASS results and browser acceptance still require execution where this socket is accessible.
- No source promotion, service/routing changes, live database changes, commits or pushes.
