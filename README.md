# Budgey

A private, self-hosted household envelope budget. React + Vite, an Express TypeScript API, PostgreSQL 18, one loopback-only Node 22 process. No Docker, password database, analytics, fonts/CDNs, bank connections or runtime outbound services.

The complete product plan is [docs/envelope-budgeting-app-plan.md](docs/envelope-budgeting-app-plan.md). Implementation decisions and MVP boundaries are in [docs/architecture.md](docs/architecture.md). Current verification evidence is in [docs/verification.md](docs/verification.md).

## Prerequisites

Node 22 (22.12+), npm 9+, PostgreSQL 18 client/server, a dedicated database role and database. Python 3.11 is needed only for the optional socket-free PostgreSQL test. Caddy/cloudflared are managed separately by the host administrator.

## 1. Administrator database bootstrap

**Administrator only. These commands have not been run against the host.** They deliberately create a dedicated `budgey` role; the app does not need a PostgreSQL `hermes` role or superuser access.

```sh
sudo -u postgres createuser --login --pwprompt --no-superuser --no-createdb --no-createrole budgey
sudo -u postgres createdb --owner=budgey budgey
sudo -u postgres psql --dbname=budgey --set=ON_ERROR_STOP=1 --command='REVOKE ALL ON DATABASE budgey FROM PUBLIC; REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE, CREATE ON SCHEMA public TO budgey;'
```

Choose a strong password at the interactive prompt. PostgreSQL must accept this role using SCRAM authentication over **127.0.0.1:5432**. If host policy rejects it, the administrator must provision the appropriate loopback-only `pg_hba.conf` rule; Budgey never edits database/server configuration. Do not expose PostgreSQL publicly.

## 2. Install and configure

```sh
cd /home/hermes/workspace/budgey
npm install
cp .env.example .env
chmod 600 .env
```

Edit `.env`; replace the database password, owner email, and origin. Percent-encode special characters in the password in `DATABASE_URL`. Keep the file private and out of source control.

Development settings:

```dotenv
APP_ENV=development
PORT=3100
DATABASE_URL=postgresql://budgey:REPLACE_ME@127.0.0.1:5432/budgey
PUBLIC_ORIGIN=http://localhost:3100
TRUSTED_IDENTITY_HEADER=x-hermes-verified-email
ALLOWED_EMAIL=you@example.com
DEV_IDENTITY=you@example.com
```

`DEV_IDENTITY` bypasses upstream authentication **only in explicit development mode**. Any nonempty value outside that mode prevents startup. Do not point development or demo mode at a production database.

```sh
npm run migrate
npm run dev
```

Visit **http://localhost:3100**. Use exactly the configured `PUBLIC_ORIGIN`; writes from a different origin, including `http://127.0.0.1:3100`, are rejected. The process always binds **127.0.0.1**, irrespective of host environment variables. Vite runs inside the API process during development. HMR is disabled to avoid a second WebSocket listener; reload the browser after UI changes.

Create your household, currency and timezone. Enter starting budget funds explicitly, then add accounts, categories, annual targets and monthly allocations. Account opening balances and starting budget funds are distinct. All supported MVP currencies have two decimal minor units.

Optional fictional development data, **instead of** onboarding, on a separate empty development database:

```sh
SEED_DEMO=yes npm run seed
```

This requires `APP_ENV=development` and `DEV_IDENTITY`. It fails if that identity already has a household, labels the household as a demo, and production refuses to serve its API. A production database must be created fresh; never remove the demo flag to promote sample data.

## 3. Production build and local service

Production environment:

```dotenv
APP_ENV=production
PORT=3100
DATABASE_URL=postgresql://budgey:REPLACE_ME@127.0.0.1:5432/budgey
PUBLIC_ORIGIN=https://YOUR-BUDGET-HOSTNAME
TRUSTED_IDENTITY_HEADER=x-hermes-verified-email
ALLOWED_EMAIL=you@example.com
```

**Remove `DEV_IDENTITY` entirely.** The configured header must be set by the trusted local Caddy auth gate only after identity verification. `ALLOWED_EMAIL` must match the one admitted owner. UI assets and every financial API route require identity. Liveness and readiness contain no financial information.

```sh
npm run migrate
npm run build
npm start
# In another terminal:
curl --fail http://127.0.0.1:3100/healthz
curl --fail http://127.0.0.1:3100/readyz
# Without a trusted identity this must return 401:
curl -i http://127.0.0.1:3100/api/state
```

A successful health response is `{"status":"ok"}`; readiness is `{"status":"ready"}` only after the database responds and the final migration is present, otherwise HTTP 503. Production does not fall back to fake finance data when PostgreSQL is unavailable.

Install the user service (no privileged operations):

```sh
mkdir -p ~/.config/systemd/user
cp ops/budgey.service ~/.config/systemd/user/budgey.service
systemctl --user daemon-reload
systemctl --user enable --now budgey.service
systemctl --user status budgey.service
journalctl --user -u budgey.service -n 50 --no-pager
```

The template assumes `/usr/bin/node` and `%h/workspace/budgey`; adjust the copied unit for another installation location. Linger is already enabled on the intended host, so enabling `default.target` starts the service after reboot without an interactive login. The unit restarts on failure, uses private temporary files, and reads `.env`. It does not run migrations automatically at boot.

## 4. Caddy, Access and Tunnel routing

**Examples for an administrator to review. No live Caddy or cloudflared configuration was changed.** `budget.antovanni.com` below is an **example hostname**, not a deployed site.

1. Create a Cloudflare Access self-hosted application for the selected hostname. Set an allow policy limited to the intended email. Configure the existing `cloudflare_access_gate` to verify the appropriate Access audience/issuer. Do not authorize based solely on a browser-supplied email header.
2. Add a site block to the existing Caddy configuration using its existing authenticated snippet:

```caddyfile
# EXAMPLE ONLY: replace this hostname.
budget.antovanni.com {
    import cloudflare_access_gate
    reverse_proxy 127.0.0.1:3100
}
```

The existing gate is responsible for **overwriting/removing incoming `X-Hermes-Verified-Email` and injecting a verified value after successful authentication**. Confirm that behavior in the existing snippet before enabling the hostname. Never copy an unverified `Cf-Access-Authenticated-User-Email` into the trusted header. Preserve the incoming browser `Origin`. Caddy must proxy from local loopback; never route the tunnel directly to port 3100.

3. For a dashboard-managed tunnel, add a public hostname to the existing tunnel with this hostname, service `https://localhost:443`, TLS origin server name and HTTP Host header both set to the hostname. Keep certificate verification enabled and ensure Caddy has a trusted certificate for it. For a locally managed tunnel the equivalent additional ingress, **before the existing catch-all**, is:

```yaml
# EXAMPLE ONLY; merge with the administrator's existing ingress, do not replace it.
- hostname: budget.antovanni.com
  service: https://localhost:443
  originRequest:
    originServerName: budget.antovanni.com
    httpHostHeader: budget.antovanni.com
```

4. Add a proxied CNAME from the selected hostname to `<TUNNEL-UUID>.cfargotunnel.com` (the dashboard public-hostname flow usually creates this). With a locally managed tunnel the administrator can use `cloudflared tunnel route dns <TUNNEL-NAME-OR-UUID> <HOSTNAME>`.
5. Validate/reload Caddy and reload the existing tunnel through the host's established administrative process. Set `PUBLIC_ORIGIN=https://<HOSTNAME>` and restart the user service. Install the PWA from the browser's install menu once HTTPS works.

Verify logged-out traffic is challenged/denied; a disallowed identity is denied; an admitted owner can load and write; a client-supplied trusted header is discarded by the gate; the only listener for Budgey is `127.0.0.1:3100` (`ss -ltn`). A request directly to the loopback app **without** the header is 401. A local process that supplies the admitted header **is inside the trusted host boundary and can impersonate the user**. This adapter does not cryptographically authenticate local processes; isolate OS users and never expose, port-forward, or add an unguarded proxy to the origin. Caddy's actual spoof-header handling cannot be verified from this repository.

## Daily use and financial rules

- Credit-card balances use the same signed asset convention as cash: a purchase makes the balance more negative; a bank-to-card payment is a transfer and reduces debt. Purchases count as spending once.
- Income is unassigned until allocated. Allocations are auditable additive adjustments (negative amounts release funds). Targets and negative envelope warnings never block financial entry.
- Rollover crosses calendar years. Reset categories release both surplus and deficit to unassigned funds at the next month. Rollover rules are immutable to prevent historical rewriting; use a replacement category for a different rule.
- Expenses/refunds support two split lines in the UI and up to 100 through the API, with exact parent totals. Refunds may reference the original expense. Transactions are immutable; unreconciled transactions may be voided with a reason. Use explicit current-date refunds/expenses/transfers to reverse reconciled activity.
- Reconciliation compares all posted activity through a statement date with its ending balance. A zero difference locks that account's period against backdated entries and voids. Differences never generate adjustments. Per-line statement clearing is a future enhancement.
- Annual views distinguish target, assigned plan and actual spending. Available balances are through the selected month. No automatic account opening-balance allocation occurs.

## CSV imports

Use UTF-8 (including BOM), comma/semicolon/tab separators, ISO / day-first / month-first dates, configurable decimal/thousands separators, signed amount or separate debit/credit columns. Column names are case-sensitive. The file chooser displays detected header hints; the actual server parser handles quoted fields/newlines. Create an immutable saved mapping with a stable provider/source namespace and expense category. Use the same namespace for overlapping exports so stable-ID uniqueness remains meaningful. Mapping changes require a new profile/version.

Preview persists only normalized row fields, fingerprints and errors, not raw file bytes. Every row requires a decision: accept, explicitly skip, or explicitly keep a probable match as distinct. Exact source-ID duplicates and invalid rows can only be explicitly skipped. A row without a stable ID is never silently dropped for a heuristic match. Change the mapping and re-preview to fix malformed rows. Positive inflows import as income: **skip refunds/transfers in mixed bank files and enter them manually with the correct type**. This avoids guessing financial semantics.

The server hashes uploaded UTF-8 text, scopes file identity to household/account/mapping settings, returns a prior batch for repeats, and commits every accepted row, decision and audit event in one PostgreSQL transaction. Exact stable IDs remain reserved after voiding. New duplicates created after preview cause commit to fail atomically; re-preview/review a changed mapping/file as needed. There is no automatic reinterpretation of saved decisions.

Every POST requires an `Idempotency-Key` of 8–200 characters. Scope is household + method/route + key. Canonical payload hashing, transaction-scoped PostgreSQL locking and a unique key enforce replay of the same JSON response, with HTTP 409 for a changed payload. Same-owner writes serialize, including concurrent imports and reconciliation. An in-flight retry waits for the first write (or receives a safe timeout and can retry); rolled-back attempts have no committed key/side effects. The UI retains a key while retrying an unresolved request in the same page session; after a reload inspect activity/import history before resubmitting an ambiguous manual write.

## Tests and checks

```sh
npm run format:check
npm run typecheck
npm test
npm run build
# Real PostgreSQL migration/invariant tests without a daemon (disposable /tmp cluster):
npm run test:pg-standalone
```

Normal `npm test` runs domain and CSV tests. PostgreSQL/API tests are explicitly skipped until configured; that is not evidence they passed. For connected database/concurrency checks, have an administrator create a **separate disposable test database** owned by the test role, then:

```sh
TEST_DATABASE_URL=postgresql://budgey:REPLACE_ME@127.0.0.1:5432/budgey_test npm test
```

This test creates and removes a uniquely named schema inside that database; it never resets public tables. Do not use a production URL. To run the API workflow test, migrate a **fresh dedicated test database**, start a second app on port 3101 with `APP_ENV=test`, `PUBLIC_ORIGIN=http://127.0.0.1:3101`, `ALLOWED_EMAIL=test@example.com`, the trusted header configured, and no `DEV_IDENTITY`. Then in another terminal:

```sh
TEST_API_URL=http://127.0.0.1:3101 npm test
```

The API test creates household data; use a new test database each run. It covers missing/wrong identity, origin rejection, setup, same-result retry, changed-payload conflict, split validation, probable-duplicate review, failed batch rollback and exact-file replay. Test-mode listener remains loopback. Actual Caddy/Access bypass tests and a reboot/restore drill are operator release checks, not claimed by unit tests.

## Backup and restore

Back up PostgreSQL plus the private `.env`, the user service unit, and the administrator's Access/Tunnel/Caddy configuration using the host's encrypted backup procedure. The app itself stores all business data in PostgreSQL and has no uploaded-file storage. Never put secrets in a public backup location. For password entry use a mode-0600 `.pgpass` or the interactive prompt, not passwords in command history.

```sh
mkdir -p ~/backups/budgey
chmod 700 ~/backups/budgey
pg_dump --host=127.0.0.1 --username=budgey --dbname=budgey --format=custom --no-owner --no-acl --file="$HOME/backups/budgey/budgey.dump"
pg_restore --list "$HOME/backups/budgey/budgey.dump"
```

Check exit status, encrypt off-host copies, and take backups before upgrades. Use a dated filename in recurring backup jobs; avoid overwriting the only known-good backup.

Restore drill, **to a separate fresh database** (administrator creates it first):

```sh
# Administrator only:
sudo -u postgres createdb --owner=budgey budgey_restorecheck
# App operator:
pg_restore --host=127.0.0.1 --username=budgey --dbname=budgey_restorecheck --exit-on-error --single-transaction --no-owner --no-acl "$HOME/backups/budgey/budgey.dump"
psql --host=127.0.0.1 --username=budgey --dbname=budgey_restorecheck --file=ops/verify-restore.sql
psql --host=127.0.0.1 --username=budgey --dbname=budgey --file=ops/verify-restore.sql
```

Compare row counts and derived account/budget totals from both outputs, then run a separate loopback instance against the restored DB and inspect target/allocation/transaction/import history and readiness. Do not run a second instance on the production origin/port. Only switch the production database after a successful drill and an operator-controlled maintenance window. Do not assume a backup is good merely because `pg_dump` exited successfully. This repository's execution environment cannot perform a connected backup/restore drill; record your drill date and result locally.

CSV exports in Activity and Reports are portable inspection exports in integer minor units, with spreadsheet-formula prefixes neutralized. Split transactions produce multiple export rows. CSV is **not** a full backup or guaranteed round-trip format; it lacks transfer destination/reconciliation/audit/import/identity context. Use `pg_dump` / `pg_restore` for full recovery. Full application-level portable import/export is a later distribution feature.

## Upgrades, credentials and retention

1. Take and test a backup. Read migration SQL and architecture notes.
2. Stop the user service; install the reviewed source/dependencies (`npm ci` once a reviewed lockfile exists, otherwise `npm install`). Run tests, `npm run migrate`, `npm run build`, then restart.
3. Check readiness, logs, totals, a non-mutating export, and the browser. Migrations use one transaction and an advisory lock; filenames are recorded and never rerun. Do not edit an already applied migration; add the next numbered SQL file.
4. Revert code only if compatible with the migrated schema. Otherwise restore the pre-upgrade backup into a fresh database and explicitly point the old release at it. There are no destructive automatic down migrations.

The sandbox could not download all dependencies, so no lockfile is fabricated. Generate and review `package-lock.json` with `npm install` in the deployment environment before treating this as a pinned release; retain it for subsequent `npm ci` installs.

Rotate DB credentials through administrator-run `\password budgey`, update the private `.env`, restart, and verify readiness. Change admitted identity deliberately: back up, update `households.owner` in an administrator-reviewed migration and `ALLOWED_EMAIL` together, with an audit event. The adapter uses the existing gate's normalized verified email as its identity key; an upstream immutable subject is preferable for a future adapter. Rotate Access audience/issuer/policy and Tunnel credentials through existing host procedures, then repeat spoof/unauthenticated checks. Budgey has no application login/session secret or password to rotate.

Financial provenance, normalized import rows, idempotency results and audit events are retained indefinitely for replay/audit. Raw CSV files are not retained. Do not prune idempotency/source identities casually, because doing so removes retry/duplicate guarantees. Logs contain only operation failures' random request IDs, safe error codes/status and startup port; they contain no raw transactions, imported rows, tokens or email. Set system journal retention through existing host administration (for example 14 days); Budgey writes no separate log files. No external update checks occur.
