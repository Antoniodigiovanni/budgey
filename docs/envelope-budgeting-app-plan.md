# Budgey — Product and Delivery Plan

**Product name:** Budgey (working name; spelling/capitalization as proposed).

**Status:** MVP implementation underway; React/Vite + Express/TypeScript + PostgreSQL 18 selected. Rootless systemd deployment supersedes container assumptions on this host. See architecture.md and verification.md for implemented scope and actual verification.

**Goal:** Build a private, self-hostable envelope budgeting application for one household initially, with a credible path to packaging it for other self-hosters later.

**Current deployment:** One app user behind Cloudflare Access; multiple financial accounts; PostgreSQL; single household and one base currency.

**Product principle:** Financial records must be auditable, imports and retried writes must be idempotent, and the app must never silently discard or reinterpret a transaction.

---

## 1. Decisions already made

- PostgreSQL is the database.
- The first installation has one app user and one household budget.
- The household may have multiple checking, savings, and credit-card accounts.
- Cloudflare Access is the initial login gate. Authentication must not be coupled to Cloudflare in the core domain or data model.
- Budgets have annual category targets and monthly envelope allocations.
- Annual targets are advisory: show warnings when planned or actual spending exceeds them; never block a transaction or allocation solely for exceeding a target.
- Users can import transaction CSVs with configurable, saved mappings.
- Idempotency is a design requirement, especially for imports, retries, and duplicate detection.

## 2. Product boundary

### In scope for the first usable release

1. One user/household, one budget currency, multiple financial accounts.
2. Calendar-year budgets, categories, annual targets, monthly allocations, and monthly envelope balances.
3. Income, expenses, refunds, transfers, split transactions, and credit-card purchase/payment handling.
4. Manual transaction entry and CSV import with saved mappings and review before posting.
5. Duplicate detection, import provenance, account reconciliation, and audit history for material financial changes.
6. Basic reports, CSV export, self-hosted deployment, and verified backup/restore instructions.
7. Cloudflare Access authentication for the first installation, with a provider-neutral identity boundary for future deployments.

### Explicitly out of scope for v1

- Automatic bank connections or collection of bank credentials.
- Multiple currencies, exchange-rate conversion, investment tracking, and net-worth valuation.
- Multiple users, invitations, per-user roles, or simultaneous household collaboration.
- Mobile native apps, receipt images/OCR, bill reminders, forecasting, and complex merchant automation.
- SaaS tenancy or centralized hosting. The architecture should not prevent future distribution, but v1 is a single-household self-hosted install.

## 3. Core user workflows

### A. Start a budget

1. The user signs in through Cloudflare Access.
2. On first run, create the household budget, select the base currency and local timezone, and create a calendar-year budget.
3. Add financial accounts with type (checking, savings, cash, credit card), opening date, opening balance, and optional display name.
4. Add/edit categories and set annual target amounts and rollover behavior per category.
5. Enter opening balances and starting budget funds. The UI must distinguish account cash/debt from money assigned to envelopes.

### B. Plan and fund envelopes

1. Set an annual target for each category.
2. Allocate planned funds to months; allow uneven seasonal allocations.
3. Record income and make it available to assign. Let the user move available-to-assign funds into one or more envelopes.
4. Show, for each month/category, planned allocation, actual spending, starting balance, available balance, and annual-to-date figures.
5. Warn when monthly available balance goes below zero, annual planned allocations exceed the annual target, or actual annual spending exceeds the target. Warnings are informational, not blocking.
6. At month end, roll balances forward or reset them according to that category's setting. Preserve history; changing a rollover setting must not rewrite closed historical months silently.

### C. Record and classify activity

- Transaction fields: date, payee/description, type, amount, account, category or split lines, optional memo, external reference when available, and provenance (manual or import batch/row).
- Splits must sum exactly to the transaction amount in the currency's minor units.
- Transfers link both account sides and do not appear as income or category spending.
- Expenses reduce the selected envelope. Refunds reverse or reduce spending in the appropriate category and preserve their link to the original transaction when known.
- Credit-card purchases are categorized as spending once. Paying the card is a transfer between the payment account and card account, not another expense.
- Permit edits and deletion only with a clear audit trail for posted financial records. Prefer void/reversal for records already reconciled or included in a closed period.

### D. Import a CSV safely

1. Select the destination account and an existing or new mapping profile.
2. Upload/parse the file without changing posted transactions.
3. Map source columns to internal fields: date, payee, amount, currency (if present), external transaction ID/reference, memo, and optional category.
4. Configure date parsing, locale/decimal and thousands separators, encoding, amount sign convention, and any debit/credit split columns.
5. Preview parsed rows and validation errors. Let the user fix mappings or skip malformed rows deliberately.
6. Show exact duplicates and probable duplicates separately. Do not auto-drop a transaction based only on equal date, amount, and description; distinct legitimate purchases can share those values.
7. Let the user confirm the batch, then persist accepted transactions and import provenance atomically. A failed commit must leave no partially posted batch.
8. Re-uploading identical data through the same account/profile should recognize a prior completed batch and avoid creating transactions again, while offering a clear way to inspect that prior result.

### E. Reconcile an account

- Enter the statement's ending balance and statement date.
- Show the calculated balance and unreconciled activity through that date.
- Allow transaction matching/clearing; report the remaining difference.
- Never silently alter transactions to force a reconciliation. Any adjustment is an explicit, categorized transaction with a reason.

## 4. Budget and ledger semantics

- Use exact integer minor units for money (for example cents); never use binary floating point for persisted or calculated amounts.
- Store a currency code for the household even though v1 supports only one currency. Reject transactions in another currency rather than silently converting them.
- Store timestamps in UTC and apply the household timezone for date boundaries, month/year views, and import date interpretation.
- A calendar year is the v1 budget year. Keep year boundaries explicit in the domain so configurable fiscal years can be added later without changing historical calculations.
- Annual target, monthly planned allocation, actual spending, and current available envelope balance are distinct values. The target is not a balance and does not constrain transactions.
- Model income as available-to-assign until allocated. Envelope allocation is a movement within the budget, not spending. Track any unassigned balance explicitly.
- Budget balance calculation for a category/month is: starting envelope balance + funds assigned in month - categorized expenses + categorized refunds, with rollover applied according to that category's rule.
- Allow overspending and negative envelope balances; surface them prominently. Do not hide deficits by clamping balances to zero.
- Transfers affect accounts but not category spending or income. Credit-card payments must not double count the original purchase.
- Account balances are derived from opening balance plus posted account movements. Preserve the transaction/event record as the source of truth; never maintain an independently editable cached balance without reconciliation against the ledger.

## 5. Idempotency, duplicate handling, and auditability

Idempotency is required at three separate levels. These mechanisms solve different problems and should not be conflated.

### 5.1 API write retries

- For retriable create/import/confirm operations, accept a caller-supplied idempotency key scoped to the authenticated household and operation.
- Persist the key, a canonical request-payload hash, operation status, and resulting resource/response reference in PostgreSQL.
- Enforce uniqueness in the database, not only in application memory.
- Repeating a key with the same payload returns the original result without repeating side effects.
- Repeating a key with a different payload returns a conflict; it must not mutate the original operation.
- Claim the key and commit all operation side effects in one database transaction. Define behavior for concurrent requests and in-progress operations.

### 5.2 Import batch and row identity

- Record import batch ID, household/account, mapping-profile version, original filename, content SHA-256, import time, parser settings, and counts/status. Do not retain raw CSV contents by default after parsing unless a later retention setting is explicitly introduced.
- Keep row number and normalized source-row fingerprint for audit/review. Enforce uniqueness for the same row within the same batch.
- Recognize an exact repeat of a completed file for the same account and mapping settings as a prior batch; show its status instead of posting again.
- A changed mapping profile or changed CSV is a new import attempt and must still pass duplicate review.

### 5.3 Transaction duplicate detection

- If the source provides a stable transaction ID, enforce uniqueness on `(account_id, source, external_transaction_id)` where populated. Define source namespace consistently per mapping/provider.
- If no stable ID exists, compute a normalized fingerprint for candidate matching, but do not enforce global uniqueness on that fingerprint. Surface candidates in the review UI for user decision.
- Keep a link from each imported transaction to its import batch and source row, including the source external ID/fingerprint where available.
- Record user decisions such as accepted, skipped, or marked-not-duplicate for reviewable rows. Reprocessing a previously decided batch must honor those decisions or explicitly request a new review; it must not silently reinterpret them.

### 5.4 Financial changes

- Use database transactions and constraints for split totals, transfer pairing, transaction/account linkage, and allocation invariants.
- Preserve immutable provenance and an audit event for edits, voids, reversals, reconciliations, and import decisions. Audit entries need actor, timestamp, entity, action, and before/after values or a safe structured diff.
- Make account deletion, category deletion, and historical budget changes non-destructive by default: archive, reassign, or require an explicit migration action.

## 6. Authentication, authorization, and distribution boundary

- Cloudflare Access authenticates the user at the edge. The application maps a trusted, stable identity claim (prefer the provider's immutable subject; email is a display/contact attribute) to the single local user/household.
- Trust identity headers only when requests demonstrably came through the trusted Access path. The origin must not be directly reachable in a way that bypasses Access, and spoofed client headers must not grant identity.
- Document the required Cloudflare Access application/policy and origin networking setup. Provide a local health endpoint that reveals no financial data.
- Keep authentication behind an adapter/interface so a future distribution can support another OIDC provider or a carefully scoped local authentication mode without rewriting budgeting logic.
- Authorize every financial-data read and write against the household context, even with only one household in v1. Avoid ambient global queries that could leak data if a second household is introduced later.
- Add CSRF protection for cookie-authenticated browser writes, secure cookie flags, input validation, request size limits, and rate limiting for sensitive endpoints as appropriate to the chosen framework.
- Do not log credentials, identity tokens, full imported rows, or financial transaction payloads. Redact operational logs.

## 7. Data model sketch

Names are illustrative; final schema follows the selected framework and migration conventions.

- `users`: local app identity, external issuer/subject, normalized email/display name, created/last-seen timestamps.
- `households`: owner/context, name, base currency, timezone, creation metadata. One row in v1.
- `accounts`: household, name, account type, opening date/balance, archived status.
- `categories`: household, name, optional parent, archived status, rollover rule.
- `budget_years`: household, calendar year, status/close metadata.
- `annual_category_targets`: budget year, category, target amount in minor units.
- `monthly_allocations`: budget year, category, month, amount, and auditable adjustment metadata.
- `transactions`: household, type, effective date, payee, memo, provenance, optional external ID, void/reversal linkage, created/updated metadata.
- `transaction_splits`: transaction, category, amount in minor units; required for categorized expenses/refunds and must reconcile to the transaction's categorized amount.
- `account_entries`: transaction, account, signed minor-unit change to that account's displayed balance. Transfers link balanced source/destination entries; define and test normal-balance/display conventions for credit-card liabilities.
- `import_profiles`: household, name, mapping/config JSON with schema version and created/updated metadata.
- `import_batches`: household, account, profile version, content hash, status, timestamps, counts, idempotency reference.
- `import_rows`: batch, row number, normalized fingerprint/source ID, parse result, review decision, resulting transaction reference, error details safe for the UI.
- `reconciliations`: account, statement date/balance, calculated difference, status, completion metadata.
- `idempotency_records`: household, operation, key, payload hash, state, response/resource reference, created/expiry metadata.
- `audit_events`: household, actor, entity/action, timestamp, structured before/after diff.

Use foreign keys, unique constraints, check constraints, and appropriate indexes for invariants wherever PostgreSQL can enforce them. Monetary columns must use integer minor units (or a rigorously specified fixed-precision alternative); no `float`/`double precision` for money.

## 8. Operational and deployment requirements

- Ship as a documented rootless systemd user service with PostgreSQL on the current host (Docker daemon access is unavailable); pin supported versions and provide configuration through environment variables/secrets, not committed credentials. Container packaging is a future distribution option.
- Provide a schema migration path and upgrade notes. A fresh install and an upgrade from the previous supported version must be testable.
- Provide separate liveness/readiness checks; readiness verifies database connectivity without exposing sensitive state.
- Provide backup instructions for both database and required application configuration. Include a restore drill in release verification, not just a backup command.
- Support export of transactions and budget plans to portable CSV (and document what cannot be round-tripped). Document an application-level full export/import path if practical before public distribution.
- Minimize outbound network dependencies. No telemetry/analytics or bank-data transmission by default; disclose any update checks or optional external integrations.
- Define retention for logs and import metadata. Default to not storing uploaded file bytes after processing.
- Document how to rotate database credentials, Cloudflare Access configuration, and application secrets.

## 9. MVP acceptance criteria

A release candidate is acceptable only when all of the following are demonstrated with automated tests or a reproducible manual verification record:

1. One authenticated user can create a household with multiple checking, savings, and credit-card accounts.
2. The user can create an annual category target, assign different amounts across months, and see target, planned allocation, actual spending, and available balance separately.
3. Target overages warn but never block entry, allocation, or import.
4. Rollover and reset behavior produce the expected balances across a month boundary; changing settings does not rewrite prior closed periods silently.
5. Income enters available-to-assign, allocations move that amount into envelopes, and expenses/refunds change the correct envelope by exact minor units.
6. Split transactions sum exactly; transfers affect two accounts but not spending; a credit-card purchase plus payment counts as one expense.
7. A CSV can be mapped, previewed, corrected, and imported. Repeating the same completed import does not create duplicate transactions.
8. Stable source IDs are uniqueness-checked per account/source. Rows without IDs are only flagged as probable duplicates and require an explicit decision.
9. Repeating an API write with the same idempotency key and payload returns the prior result. Reusing the key with a different payload produces a conflict and no extra financial side effect.
10. Concurrent retries cannot create duplicate import batches, transactions, transfer pairs, or allocations.
11. Account reconciliation detects a difference and never silently manufactures an adjustment.
12. The app can be restored from a documented backup into a clean installation and the restored records/aggregates match the backup.
13. Financial routes reject requests without the trusted authenticated identity; direct-origin and spoofed-header tests do not bypass authentication.
14. Logs and error responses do not expose secrets or raw financial payloads.

## 10. Delivery phases

### Phase 0 — Resolve design decisions and deployment contract

- Choose application framework, UI approach, rootless service layout, and supported PostgreSQL version based on the intended homelab and maintainer preference.
- Verify how the homelab routes Cloudflare Access traffic to the app; document trusted identity headers/claims and origin isolation.
- Finalize the credit-card balance convention, statement-date handling, household timezone, and month-close behavior.
- Write schema/domain decision records before committing to migrations.

**Exit:** Decisions are documented, testable, and do not assume Access headers are safe without origin protection.

### Phase 1 — Foundation and identity

- Establish the app shell, PostgreSQL migrations, configuration validation, health/readiness checks, and rootless systemd local deployment.
- Implement Cloudflare identity adapter and household-scoped authorization context.
- Add security tests for missing, malformed, and spoofed identity claims and direct-origin assumptions.

**Exit:** A single user can log in through the intended Access route, and unauthenticated or untrusted requests cannot reach financial operations.

### Phase 2 — Ledger and accounts

- Implement accounts, transaction types, account entries, income, expenses, refunds, transfers, splits, and audit history.
- Implement exact minor-unit arithmetic and enforce account/transaction constraints.
- Add manual transaction entry and account balance views.

**Exit:** Ledger invariants and card/transfer cases pass automated integration tests against PostgreSQL.

### Phase 3 — Envelope budgets

- Implement categories, annual targets, monthly allocations, available-to-assign, rollover/reset, and overspending warnings.
- Add year/month views and category/account reports.

**Exit:** Budget calculations match reference fixtures over month/year boundaries, including refunds, negative envelopes, and target overages.

### Phase 4 — CSV imports and idempotency

- Implement mapping profiles, parsing, validation, preview/review, batch provenance, source-ID uniqueness, probable duplicate review, and atomic commit.
- Implement idempotency records for write operations and replay/conflict/concurrency behavior.
- Add safe re-upload behavior and import history.

**Exit:** Tests cover exact-file re-upload, overlapping exports, same-date/same-amount legitimate purchases, stable IDs, mapping changes, failed imports, and concurrent retries.

### Phase 5 — Reconciliation, exports, and operations

- Implement statement reconciliation, safe export, backup/restore, upgrade checks, and operational docs.
- Perform a restore drill and Access bypass/security verification.

**Exit:** A fresh homelab deployment can be installed, backed up, restored, upgraded, and verified without depending on a developer workstation.

### Phase 6 — Distribution hardening (before public release)

- Define supported installation profiles and upgrade/support policy.
- Add a generic OIDC option or documented provider adapter contract beyond Cloudflare Access.
- Add household export/import, migration tooling, accessibility/usability review, threat model, dependency/license audit, and security reporting channel.
- Do not add multi-user collaboration until a concrete product need justifies the authorization and conflict model.

**Exit:** Another operator can deploy the app independently, use a supported authentication route, export their records, and upgrade without losing data.

## 11. Release verification and testing strategy

- Unit tests: money conversion/rounding, envelope arithmetic, rollover, warning rules, CSV parsing/normalization, fingerprint generation.
- PostgreSQL integration tests: foreign keys, uniqueness, constraints, transactions, idempotency races, import rollback, and migrations. Do not rely solely on SQLite substitutes for PostgreSQL behavior.
- End-to-end tests: login boundary, create accounts, allocate budget, enter/split expense, import CSV, review duplicate, reconcile, export.
- Property/invariant tests: split totals equal parent amount; transfers net to zero across the household's account ledger; retries produce one effect; envelope balances equal the event-derived result; no negative amount is rounded or dropped.
- Fixtures: different date formats, timezones, decimal separators, sign conventions, blank IDs, duplicated source IDs, same-value legitimate transactions, refunds, card payment, and malformed rows.
- Operational test: clean deployment, migration/upgrade, backup, restore, and post-restore reconciliation of row counts and calculated balances.

## 12. Risks and decisions to revisit

- **Cloudflare trust boundary:** Access headers are only trustworthy if the app origin cannot be reached through an untrusted path. Verify actual network topology before relying on headers.
- **Duplicate ambiguity:** CSVs often lack stable IDs. Heuristic matching must produce review candidates, not silent data loss.
- **Credit-card semantics:** Choose one sign/normal-balance convention and test every purchase/payment/refund scenario before exposing balances.
- **Historical edits:** Allowing edits to reconciled or closed data can make reports change retroactively. Use reversals/audit records and make historical changes explicit.
- **PostgreSQL is not multi-tenancy by itself:** Household-scoped authorization must be present from the first query and mutation, even with one household.
- **Feature creep:** Do not add bank connections, multi-currency, or collaboration before the core ledger/import/budget invariants are reliable.

## 13. Immediate next step

Before implementation, choose the application framework and deployment shape, then produce a short architecture decision record for: trusted Cloudflare identity claims/origin isolation, credit-card balance convention, and the transaction/budget event model. After those decisions, implement in the phase order above, with PostgreSQL-backed tests for financial and idempotency invariants from the start.
