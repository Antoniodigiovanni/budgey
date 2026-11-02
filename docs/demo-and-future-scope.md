# Fictional demo and future scope

## Demo

The isolated demo uses `budgey-demo.service` and `budgey-demo-db.service` (user services). PostgreSQL data is outside the repository under the owner-only sibling `budgey-demo/`, with Unix socket access only and no TCP listener. It does not use or change the host PostgreSQL database. Web UI binds only `127.0.0.1:3100`, with explicit development demo identity. Do not proxy this development bypass to the internet or load personal financial records into it.

Demo seed: three fictional accounts (checking, savings, credit), five budget categories, annual targets, current-month allocations, four expenses. The UI visibly labels the data as fictional. Starting budget funds are separate from account balances.

Verified: typecheck and production build; all 15 tests including connected PostgreSQL and HTTP API tests against a separate `budgey_test` database (zero skipped). Browser loaded Overview and Accounts with demo records, and Accounts fit a 390px viewport without horizontal overflow. This is a smoke check, not full device acceptance.

Prepared hostname: `https://budget.antovanni.com`. The demo service now uses `APP_ENV=test` to serve the built UI, has no development identity bypass, requires the trusted identity header, and accepts writes only from this exact HTTPS origin. The intended Caddy snippet is `ops/demo-budget.caddy`: run the existing Access verification gate first, then map admitted visitors to `demo@example.com` for this fictional shared household. This does not identify individual visitors in demo audit events. Never reuse this mapping for real financial data. Caddy and Cloudflare changes are left to the user; public reachability is not yet verified. Local probes verified ready=200, missing identity=401, mapped identity=200 and foreign-origin write=403. User services are enabled for reboot.

## Wealth implementation

Balance sheet and Investments screens now support manual household-currency wealth records. This describes source implementation, not deployment or connected acceptance. See [wealth-verification.md](wealth-verification.md) for actual checks and pending host commands.

Balance sheet combines bank/card ledger balances as of a selected date (including archived accounts), dated property/vehicle/other asset values, loans/mortgages/other liabilities, and brokerage cash plus priced holdings once. Positive debt valuations are subtracted. Unknown values stay missing; an explicitly recorded zero is valid. Monthly history starts with recorded activity, carries prior observations forward, shows valuation dates and incomplete periods, and never interpolates prices.

Investments support named portfolios with dated opening cash, named securities, buys, sells, dividends, fees, external deposits/withdrawals, fractional units and dated manual prices. Forms and append-only activity/valuation/price history are available. Full dated event replay rejects insufficient cash, overselling and backdated activity that invalidates later events. Records are household-scoped, audited and idempotent through the existing write transaction. The additive migration preserves existing ledger constraints.

### Arithmetic and recording conventions

- All amounts use integer household-currency cents, validated within the safe JSON integer range. Calculations use integer arithmetic, including intermediate sums and products.
- Units are decimal strings with up to six decimal places and twelve integer digits. Trade consideration is the manually supplied total before fees; it is not recomputed from a quote. Buy fees reduce cash; sell fees reduce proceeds.
- Holding value is units multiplied by the latest manual per-unit price on or before the selected date, rounded independently to the nearest cent, half up. No price means unknown value; a zero price means zero value.
- Activity on the same day runs in entry order. Opening cash exists on the opening date. Activity before opening is rejected. Dates are calendar dates; wealth API dates range from 1900 through 2200.
- One immutable valuation or price per record per date. New dated observations preserve earlier snapshots. Events are never edited or deleted. Valid offsetting activity can record a correction; there is no destructive void or rewrite flow.
- External portfolio deposits/withdrawals and opening cash never update budget accounts, allocations or spendable funds. Automatic bank-to-broker synchronization is deferred; users must separately record actual budget bank activity. Reconcile both sides to avoid counting the same cash twice.

### Demo seed

The opt-in `npm run seed:wealth` command requires an existing `demo=true` household, nonproduction environment, `WEALTH_DEMO_SEED=yes` and `DEMO_OWNER`. It adds explicitly fictional property, mortgage and portfolio examples with past dated observations, fractional trades and all supported cash activity. It runs atomically and is safely rerunnable without duplicate additions. It never runs at startup. Live demo seeding remains a separate parent action after backup and verified promotion.

### Deferred

Bank/broker connections, automatic prices, FX/multicurrency, trade execution, tax accounting, realized/unrealized gains, cost basis and performance percentages (including IRR/TWR) remain deferred. No projected history or inferred transfers are generated. Connected database/API/browser acceptance and promotion remain pending where the sandbox cannot access the disposable database.
