# Wealth implementation plan

## Scope

Implement the requested future scope in `docs/demo-and-future-scope.md`, not merely edit that document. Preserve the envelope budget and existing ledger. Add manual, single-household-currency wealth tracking, usable in the fictional demo. No bank/broker APIs, live quotes, FX, tax accounting, IRR/TWR or order execution. Use ordinary concise UI copy matching current palette, not new slogans. Build and test in this isolated implementation directory, not the running service directory.

## Architecture

Add an additive `003_wealth.sql` migration, a shared pure typed calculation module, a household-scoped server module and real React screens/forms. Reuse existing identity, exact Origin checks, serialized/idempotent writes and append-only audit. Budget accounts remain authoritative for bank/card balances. Other assets/debts have explicit dated manual values, never budget allocations. Brokerage values are calculated from cash plus priced holdings and counted once in net worth; do not add a duplicate manual brokerage total. All records belong to household and composite FKs reject cross-household relationships.

## Task 1: Dated personal balance sheet

Files: new `src/wealth.ts`, `server/wealth.ts`, migration; API wiring in `server/index.ts`; new tests.

RED: as-of bank/card balance excludes future and voided entries; dated manual values choose latest <= date (including explicit zero); future-only or absent values marked missing, not silently zero; signed assets/debts and totals; property and mortgage combine correctly; wealth entries do not change `calculate()` budget outputs.

GREEN: asset/debt register (property/vehicle/other asset/loan/mortgage/other liability), named records and immutable dated valuations. Current/selected-date assets, liabilities, net worth, data-completeness and valuation dates. Net-worth monthly history from real recorded history, not fabricated interpolation; distinguish carried-forward/stale values and incomplete history. Current budget account balances derived as of date, including archived accounts with remaining balances (no loss of wealth merely from hiding).

## Task 2: Investment model

Files: same pure/server modules and migration; focused tests.

RED/GREEN in vertical slices: named brokerage portfolios with dated opening cash; named securities; buy/sell units, cash, fees; dividend/fee/deposit/withdrawal activity; dated manual prices and value history; fractional quantities and exact rounding; negative quantities/prices, overselling, insufficient cash, backdated history invalidating a later sale/cash flow, missing price, before opening date and huge numbers rejected or visibly incomplete as appropriate. Use decimal quantity strings with up to six places and integer cents money; integer/BigInt calculation with safe serialized values, not binary floats for money. Weighted-average basis if realized/unrealized gains are shown; label convention and cover partial-sale math; never call it tax basis or total-return percentage. Zero prices allowed explicitly, absent prices unknown.

Keep external portfolio deposits/withdrawals distinct from income/spending and market gains. For this manual first version portfolio cash flows do NOT automatically edit budget bank accounts; make that explicit at entry and summary. Do not invent bank transfers or mutate envelope spendable funds. Cross-module automatic bank-to-broker transfers are deferred; a user must not be led to believe they synchronize. Net-worth totals aggregate brokerage cash+holdings only once.

## Task 3: Authenticated APIs and persistence

Existing `write()` owns idempotency, advisory lock and audit transaction; reuse/refactor narrowly to expose to new routes rather than standalone unaudited routes. Mutation validation before inserts; strict dates/IDs/safe money/quantity; normal 400 validation responses, not opaque DB-unavailable for bad inputs. Household ownership for every GET/POST. Append-only events/corrections with clear safe void behaviour if provided (no in-place trade rewriting); do not provide a destructive delete that breaks historical snapshots. Audit even valuations and opening records. Duplicate request replay must not duplicate events. `/readyz` checks latest migration. Dedicated `TEST_API_URL` wealth workflow on fresh database, plus PostgreSQL invariants. Tests should opt in clearly, no accidental live demo mutation.

## Task 4: UI

New `src/Wealth.tsx` (or modest components), wire navigation in `src/App.tsx`, styles in `src/style.css`. Functional Balance sheet and Investments tabs; date picker, asset/debt creation and dated valuation, portfolio/security creation, price entry, all trade/cash-flow entry, holdings/cash/history and net-worth history views. Visible real loading/error/empty states; do not report save success until API completes; retains draft on error, prevents duplicate submission and reuses idempotency keys as current app. Accessible form labels and dialogs, keyboard focus, mobile bounds at 390px and desktop. Currency from household, no USD/EUR hardcoding. Avoid investments counted in budget categories. Do not remove existing onboarding/CSV/reconciliation features.

## Task 5: Demo and acceptance

New opt-in idempotent `scripts/seed-wealth-demo.ts`: only an existing demo=true household in nonproduction, no real data; uses module validation/writes where possible, preserves existing fictional records. Explicitly fictional property/mortgage and at least one portfolio with deposits, fractional buys, sale, dividend, fee, withdrawal and multiple valuations. Use past/current dates relative to actual date, not future records presented as current. Seed never runs automatically at startup. It may be run only on the specified disposable test DB by implementer; parent seeds running demo after backup/promotion.

Browser acceptance via host Playwright installed in `/home/hermes/workspace/papertrail/node_modules/playwright`: dedicated disposable migrated and seeded database, loopback API. Drive actual forms on both new tabs, persisted reload/readback, as-of history, incomplete valuation warning, field error and mobile no-overflow; read back exact created target. Record screenshot and raw assertions, no production records. Include original 15 connected tests unchanged against fresh dedicated schema/household. Run typecheck, formatting for changed code, all tests, production build. Record real RED/GREEN logs and limitations. Update future-scope doc to implemented vs deferred accurately and add arithmetic conventions.

## Promotion (parent only)

Existing service is `budgey-demo.service`, DB service `budgey-demo-db.service`, source `/home/hermes/workspace/budgey`, owner-only separate PG at sibling budgey-demo (Unix socket55432). No public Caddy/Cloudflare changes allowed. Parent backed up source, served dist and demo dump under budgey-demo/backups before edits. After verified tests, copy only explicit source/asset changes back, migrate demo once with additive migration, build to separate directory/promote assets first entry last, restart only demo service, seed wealth fictional examples, verify auth401/origin403/readiness and stored readback. Never claim physical iPad or Access login tested unless actually done. No external push requested.
