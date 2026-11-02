import Wealth from "./Wealth";
import React, { useEffect, useState, useRef } from "react";
import { calculate } from "./budget";
type Row = Record<string, any>;
const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const toMinor = (v: FormDataEntryValue | null) => {
  const s = String(v || "0");
  if (!/^-?\d+(\.\d{1,2})?$/.test(s))
    throw Error("Use at most two decimal places");
  const neg = s[0] === "-";
  const [a, b = ""] = s.replace("-", "").split(".");
  const n = Number(a) * 100 + Number(b.padEnd(2, "0"));
  if (!Number.isSafeInteger(n)) throw Error("Amount too large");
  return neg ? -n : n;
};
const pending = new Map<string, { body: string; key: string }>();
async function api(path: string, body?: unknown) {
  const serialized = JSON.stringify(body);
  let attempt = pending.get(path);
  if (body !== undefined && attempt?.body !== serialized) {
    attempt = { body: serialized, key: crypto.randomUUID() };
    pending.set(path, attempt);
  }
  const r = await fetch("/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined
        ? {}
        : {
            "Content-Type": "application/json",
            "Idempotency-Key": attempt!.key,
          },
    body: body === undefined ? undefined : serialized,
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error || "Request failed");
  if (body !== undefined) pending.delete(path);
  return d;
}
export default function App({
  initialData = null,
}: {
  initialData?: Row | null;
}) {
  const [data, setData] = useState<Row | null>(initialData),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState("Overview"),
    [month, setMonth] = useState(today.slice(0, 7)),
    [annual, setAnnual] = useState(false),
    [modal, setModal] = useState(""),
    [selected, setSelected] = useState<Row | null>(null),
    [kind, setKind] = useState("expense"),
    [online, setOnline] = useState(navigator.onLine ?? true),
    [review, setReview] = useState<Row | null>(null),
    [decisions, setDecisions] = useState<Record<number, string>>({}),
    [csv, setCsv] = useState(""),
    [filename, setFilename] = useState(""),
    [headers, setHeaders] = useState<string[]>([]),
    [auditRows, setAuditRows] = useState<Row[]>([]);
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]',
        ) || [],
      );
    (
      dialog?.querySelector<HTMLElement>("input,select") || focusable()[0]
    )?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModal("");
      if (e.key === "Tab") {
        const all = focusable();
        const first = all[0],
          last = all[all.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [modal]);
  const refresh = async () => {
    const next = await api("/state");
    setData(next);
    if (!data && next.today) setMonth(next.today.slice(0, 7));
  };
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    const on = () => setOnline(navigator.onLine);
    window.addEventListener("online", on);
    window.addEventListener("offline", on);
    if ("serviceWorker" in navigator)
      navigator.serviceWorker.register("/sw.js");
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", on);
    };
  }, []);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      if (!online) throw Error("Reconnect before making financial changes");
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };
  const save = (path: string, body: unknown) =>
    run(async () => {
      await api(path, body);
      setModal("");
      setNotice("Saved. Your budget is up to date.");
      await refresh();
    });
  const open = (name: string, row: Row | null = null) => {
    setSelected(row);
    setModal(name);
    setError("");
  };
  const currentDate = data?.today || today;
  const currency = data?.household?.currency || "EUR";
  const fmt = (n: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
      n / 100,
    );
  const opts = (rows: Row[]) =>
    rows
      .filter((r) => !r.archived)
      .map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}
        </option>
      ));
  const accountSelect = (name = "account_id") => (
    <label>
      {name === "destination_id" ? "Destination account" : "Account"}
      <select name={name} required>
        {opts(data?.accounts || [])}
      </select>
    </label>
  );
  const categorySelect = (name = "category_id") => (
    <label>
      Category
      <select name={name} required>
        {opts(data?.categories || [])}
      </select>
    </label>
  );
  const field = (
    label: string,
    name: string,
    type = "text",
    value?: string | number,
    required = true,
  ) => (
    <label>
      {label}
      <input
        name={name}
        type={type}
        defaultValue={value}
        required={required}
        step={type === "number" ? "0.01" : undefined}
      />
    </label>
  );
  const submit =
    (fn: (f: FormData) => void) => (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      try {
        fn(new FormData(e.currentTarget));
      } catch (e) {
        setError((e as Error).message);
      }
    };
  const viewBatch = (id: string) =>
    run(async () => {
      const r = await api("/imports/" + id);
      setReview(r);
      setDecisions(
        Object.fromEntries(
          r.rows
            .filter((r: Row) => r.decision)
            .map((r: Row) => [r.row_number, r.decision]),
        ),
      );
    });
  if (!data)
    return (
      <main className="loading">
        <div className="brand">
          b<span>budgey</span>
        </div>
        <h1>{error ? "Your budget is unavailable" : "Opening your budget…"}</h1>
        <p>{error || "A little clarity is on its way."}</p>
        <button onClick={() => run(refresh)}>Try again</button>
      </main>
    );
  if (!data.household)
    return (
      <main className="welcome">
        <div className="brand">
          b<span>budgey</span>
        </div>
        <small>A LITTLE INTENTION. A LOT MORE CLARITY.</small>
        <h1>
          Make room for
          <br />
          what matters.
        </h1>
        <p>
          Give your money a purpose. Start your private household budget, one
          envelope at a time.
        </p>
        <form
          onSubmit={submit((f) =>
            save("/setup", {
              name: f.get("name"),
              currency: f.get("currency"),
              timezone: f.get("timezone"),
              starting_funds: toMinor(f.get("starting_funds")),
            }),
          )}
        >
          {field("Household name", "name", "text", "Our household")}
          <label>
            Base currency
            <select name="currency">
              {["EUR", "USD", "GBP", "CHF", "CAD", "AUD"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          {field(
            "Timezone",
            "timezone",
            "text",
            Intl.DateTimeFormat().resolvedOptions().timeZone,
          )}
          {field(
            "Starting budget funds (separate from account balances)",
            "starting_funds",
            "number",
            "0",
          )}
          <p className="hint">
            This is the money you want available to assign today. Account
            opening balances are recorded separately.
          </p>
          <button disabled={busy || !online}>Create my budget →</button>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </form>
      </main>
    );
  const b = calculate(data as any, month);
  const year = Number(month.slice(0, 4));
  const tx = data.transactions as Row[];
  const monthLabel = new Date(month + "-15T12:00:00").toLocaleDateString(
    undefined,
    { month: "long", year: "numeric" },
  );
  return (
    <div className="app">
      <aside inert={!!modal}>
        <a className="brand" href="/">
          b<span>budgey</span>
          <i>HOUSEHOLD BUDGET</i>
        </a>
        <nav>
          {[
            ["Overview", "◫"],
            ["Envelopes", "▤"],
            ["Activity", "⇄"],
            ["Accounts", "▣"],
            ["Balance sheet", "◇"],
            ["Investments", "◈"],
            ["Imports", "↥"],
            ["Reports", "◴"],
          ].map(([name, icon]) => (
            <button
              aria-current={tab === name ? "page" : undefined}
              className={tab === name ? "active" : ""}
              key={name}
              onClick={() => {
                setTab(name);
                setNotice("");
              }}
            >
              <span aria-hidden="true">{icon}</span>
              {name}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="status-dot" /> Private by design
          <p>
            Your money. Your home.
            <br />A calmer way to budget.
          </p>
        </div>
        <div className="household">
          <b>{data.household.name.slice(0, 1).toUpperCase()}</b>
          <div>
            {data.household.name}
            <small>{currency} · Personal workspace</small>
          </div>
        </div>
      </aside>
      <main inert={!!modal}>
        <header>
          <div className="breadcrumb">
            Your household <span>/</span> {tab}
          </div>
          <div className="top-actions">
            <span className="privacy">● Self-hosted & private</span>
            <button
              className="avatar"
              aria-label="Household details"
              onClick={() =>
                setNotice(
                  `Currency: ${currency} · Timezone: ${data.household.timezone}`,
                )
              }
            >
              {data.household.name.slice(0, 1)}
            </button>
          </div>
        </header>
        <div className="content">
          {data.household.demo && (
            <div className="banner">
              DEVELOPMENT DEMO · These are fictional financial records.
            </div>
          )}
          {!online && (
            <div className="banner" role="status">
              You’re offline. Reconnect to view current balances and make
              changes.
            </div>
          )}
          {error && (
            <div className="error" role="alert">
              {error}
              <button className="text-button" onClick={() => setError("")}>
                Dismiss
              </button>
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              {notice}
              <button className="text-button" onClick={() => setNotice("")}>
                Dismiss
              </button>
            </div>
          )}
          {["Balance sheet", "Investments"].includes(tab) && (
            <Wealth
              tab={tab}
              today={currentDate}
              currency={currency}
              api={api}
              online={online}
            />
          )}
          {!["Balance sheet", "Investments"].includes(tab) && (
            <div className="page-title">
              <div>
                <small className="eyebrow">A PLACE FOR EVERY PENNY</small>
                <h1>
                  {tab === "Overview"
                    ? "A little more peace of mind."
                    : tab === "Envelopes"
                      ? "Plan for what matters."
                      : tab === "Activity"
                        ? "Life, in transactions."
                        : tab === "Accounts"
                          ? "Your money, together."
                          : tab === "Imports"
                            ? "Bring your activity home."
                            : "See the bigger picture."}
                </h1>
                <p>
                  {tab === "Overview"
                    ? "Know where you stand. Choose where you’re going."
                    : tab === "Imports"
                      ? "Map once. Review every row. Import with confidence."
                      : "Small decisions today. More possibilities tomorrow."}
                </p>
              </div>
              <button
                disabled={busy || !online}
                onClick={() => open("transaction")}
              >
                ＋ Add transaction
              </button>
            </div>
          )}
          {["Overview", "Envelopes", "Reports"].includes(tab) && (
            <div className="period">
              <div className="segmented">
                <button
                  className={!annual ? "chosen" : ""}
                  onClick={() => setAnnual(false)}
                >
                  Monthly
                </button>
                <button
                  className={annual ? "chosen" : ""}
                  onClick={() => setAnnual(true)}
                >
                  Annual
                </button>
              </div>
              <label className="month-picker">
                <span>{annual ? "Budget year" : "Budget month"}</span>
                <input
                  aria-label="Budget month"
                  type="month"
                  min="2000-01"
                  max="2200-12"
                  value={month}
                  onChange={(e) =>
                    setMonth(e.target.value || today.slice(0, 7))
                  }
                />
              </label>
              <span className="period-note">
                {annual
                  ? `${year} · Targets guide, never limit.`
                  : monthLabel + " · Make it intentional."}
              </span>
            </div>
          )}
          {["Overview", "Envelopes"].includes(tab) && (
            <>
              <section className="stats">
                <article className="hero-stat">
                  <small>
                    AVAILABLE TO ASSIGN <span>↗</span>
                  </small>
                  <h2>{fmt(b.unassigned)}</h2>
                  <p>
                    {b.unassigned < 0
                      ? "Assigned beyond your available funds"
                      : "Ready for a little direction"}
                  </p>
                  <button
                    onClick={() => open("allocation")}
                    disabled={!data.categories.length}
                  >
                    Assign money <span>→</span>
                  </button>
                </article>
                <article>
                  <small>
                    {annual ? "PLANNED THIS YEAR" : "ASSIGNED THIS MONTH"}
                  </small>
                  <h2>
                    {fmt(
                      annual
                        ? b.categories.reduce((n, c) => n + c.planned, 0)
                        : b.assigned,
                    )}
                  </h2>
                  <p>Every envelope has a purpose</p>
                  <div className="stat-foot">
                    <span className="dot green" />
                    {b.categories.length} envelopes, each with a purpose
                  </div>
                </article>
                <article>
                  <small>
                    {annual ? "SPENT THIS YEAR" : "SPENT THIS MONTH"}
                  </small>
                  <h2>
                    {fmt(
                      annual
                        ? b.categories.reduce((n, c) => n + c.actual, 0)
                        : b.spent,
                    )}
                  </h2>
                  <p>Expenses, less your refunds</p>
                  <div className="stat-foot">
                    <span className="dot peach" /> Transfers excluded
                  </div>
                </article>
                <article>
                  <small>IN YOUR ENVELOPES</small>
                  <h2 className={b.available < 0 ? "negative" : ""}>
                    {fmt(b.available)}
                  </h2>
                  <p>Available through {monthLabel}</p>
                  <div className="stat-foot">
                    <span className="dot green" /> Balances carry where enabled
                  </div>
                </article>
              </section>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>
                      Your envelopes{" "}
                      <span className="count">{b.categories.length}</span>
                    </h2>
                    <p>A little structure for the life you want to live.</p>
                  </div>
                  <button
                    className="secondary"
                    onClick={() => open("category")}
                  >
                    ＋ New category
                  </button>
                </div>
                {!b.categories.length ? (
                  <div className="empty">
                    <span>▤</span>
                    <h3>What are you making room for?</h3>
                    <p>
                      Add your first category, then give it a target and some
                      funds.
                    </p>
                    <button
                      className="secondary"
                      onClick={() => open("category")}
                    >
                      Create an envelope
                    </button>
                  </div>
                ) : (
                  <div className="table-scroll">
                    <table className="envelope-table">
                      <thead>
                        <tr>
                          <th>ENVELOPE</th>
                          <th>{annual ? "ANNUAL TARGET" : "STARTING"}</th>
                          <th>{annual ? "PLANNED" : "ASSIGNED"}</th>
                          <th>{annual ? "ACTUAL SPENDING" : "SPENT"}</th>
                          <th>AVAILABLE</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {b.categories.map((c, i) => (
                          <tr key={c.id}>
                            <td>
                              <div className="category-cell">
                                <span
                                  className={"category-icon color-" + (i % 5)}
                                >
                                  {["⌂", "◒", "✦", "↗", "♡"][i % 5]}
                                </span>
                                <div>
                                  <b>{c.name}</b>
                                  <small>
                                    {c.rollover
                                      ? "Rolls forward"
                                      : "Resets each month"}{" "}
                                    · {fmt(c.target)} annual target
                                  </small>
                                  {c.warnings.length > 0 && (
                                    <small className="warning">
                                      {c.warnings.join(" · ")}
                                    </small>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td>{fmt(annual ? c.target : c.start)}</td>
                            <td>
                              <button
                                className="amount-button"
                                onClick={() =>
                                  open(annual ? "target" : "allocation", c)
                                }
                              >
                                {fmt(annual ? c.planned : c.assigned)}{" "}
                                <span>＋</span>
                              </button>
                            </td>
                            <td>
                              {fmt(annual ? c.actual : c.spent)}
                              <div className="progress">
                                <i
                                  style={{
                                    width:
                                      Math.min(
                                        100,
                                        c.target
                                          ? Math.max(
                                              0,
                                              (c.actual / c.target) * 100,
                                            )
                                          : 0,
                                      ) + "%",
                                  }}
                                />
                              </div>
                            </td>
                            <td>
                              <span
                                className={
                                  "balance-pill " +
                                  (c.available < 0 ? "over" : "")
                                }
                              >
                                {fmt(c.available)}
                              </span>
                            </td>
                            <td>
                              <button
                                aria-label={"Set annual target for " + c.name}
                                className="text-button"
                                onClick={() => open("target", c)}
                              >
                                •••
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="panel-footer">
                  <span>◉ Targets are a compass, never a constraint.</span>
                  <span>
                    {b.categories.filter((c) => c.available < 0).length}{" "}
                    overspent envelopes
                  </span>
                </div>
              </section>
            </>
          )}
          {tab === "Overview" && (
            <div className="bottom-grid">
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>Recent activity</h2>
                    <p>The little things add up.</p>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => setTab("Activity")}
                  >
                    View all →
                  </button>
                </div>
                <Activity
                  rows={tx.filter((t) => !t.voided).slice(0, 4)}
                  fmt={fmt}
                  onVoid={(r) => open("void", r)}
                />
              </section>
              <section className="insight">
                <span className="insight-icon">✳</span>
                <small>YOUR BUDGET, YOUR PACE</small>
                <h2>
                  Progress looks different
                  <br />
                  every month.
                </h2>
                <p>
                  Plans change. Life happens. Move money between envelopes
                  whenever you need to.
                </p>
                <button
                  className="text-button"
                  onClick={() => open("allocation")}
                >
                  Make a little adjustment →
                </button>
              </section>
            </div>
          )}
          {tab === "Activity" && (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>All activity</h2>
                  <p>
                    Credit purchases count once. Card payments are transfers.
                  </p>
                </div>
                <a className="secondary" href="/api/export/transactions">
                  Export CSV ↗
                </a>
              </div>
              <Activity rows={tx} fmt={fmt} onVoid={(r) => open("void", r)} />
            </section>
          )}
          {tab === "Accounts" && (
            <>
              <div className="section-actions">
                <p>
                  Positive balances are assets; negative card balances are debt.
                  <br />
                  Opening balances do not automatically fund envelopes.
                </p>
                <button className="secondary" onClick={() => open("account")}>
                  ＋ Add account
                </button>
              </div>
              <div className="account-grid">
                {data.accounts.map((a: Row) => (
                  <article className="panel account-card" key={a.id}>
                    <span className="category-icon">▣</span>
                    <small>
                      {a.archived ? "ARCHIVED · " : ""}
                      {a.type.toUpperCase()}
                    </small>
                    <h2>{a.name}</h2>
                    <h3 className={a.balance < 0 ? "negative" : ""}>
                      {fmt(a.balance)}
                    </h3>
                    <p>
                      Opened {a.opening_date} · {fmt(a.opening_balance)}
                    </p>
                    <button
                      className="secondary"
                      onClick={() => open("reconcile", a)}
                    >
                      Reconcile account
                    </button>
                    <button
                      className="text-button"
                      onClick={() =>
                        open("settings", { ...a, entity: "accounts" })
                      }
                    >
                      Edit / archive
                    </button>
                  </article>
                ))}
              </div>
              {!data.accounts.length && (
                <div className="panel empty">
                  <h2>A home for every account.</h2>
                  <p>
                    Add checking, savings, cash or credit cards to start
                    tracking.
                  </p>
                  <button onClick={() => open("account")}>
                    Add your first account
                  </button>
                </div>
              )}
              <section className="panel">
                <div className="panel-heading">
                  <h2>Statement comparisons</h2>
                </div>
                {data.reconciliations.length ? (
                  data.reconciliations.map((r: Row) => (
                    <div className="reconciliation" key={r.id}>
                      <b>
                        {
                          data.accounts.find((a: Row) => a.id === r.account_id)
                            ?.name
                        }
                      </b>
                      <span>{r.date}</span>
                      <span>Statement {fmt(r.statement)}</span>
                      <span className={r.difference ? "warning" : "positive"}>
                        {r.difference
                          ? fmt(r.difference) + " difference"
                          : "Balanced ✓"}
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="empty">
                    No statements compared yet. Reconciliation never creates an
                    adjustment.
                  </p>
                )}
              </section>
            </>
          )}
          {tab === "Imports" && (
            <>
              <div className="import-grid">
                <section className="panel padded">
                  <small className="eyebrow">01 / MAP & PREVIEW</small>
                  <h2>Import a CSV</h2>
                  <p className="hint">
                    UTF-8 files, up to 1.5 MB / 5,000 rows. Raw files are
                    discarded after parsing.
                  </p>
                  <form
                    onSubmit={submit((f) =>
                      run(async () => {
                        const r = await api("/imports/preview", {
                          account_id: f.get("account_id"),
                          profile_id: f.get("profile_id"),
                          filename,
                          csv,
                        });
                        await refresh();
                        const v = await api("/imports/" + r.id);
                        setReview(v);
                        setDecisions(
                          Object.fromEntries(
                            v.rows
                              .filter((r: Row) => r.decision)
                              .map((r: Row) => [r.row_number, r.decision]),
                          ),
                        );
                        if (r.repeated)
                          setNotice(
                            "This exact file and mapping already have a batch. Showing the original result.",
                          );
                      }),
                    )}
                  >
                    {accountSelect()}
                    <label>
                      Saved mapping
                      <select name="profile_id" required>
                        <option value="">Choose a profile</option>
                        {opts(data.profiles)}
                      </select>
                    </label>
                    <label>
                      CSV file
                      <input
                        type="file"
                        accept=".csv,text/csv"
                        required
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) {
                            if (file.size > 1500000) {
                              setError("File exceeds 1.5 MB");
                              return;
                            }
                            file
                              .arrayBuffer()
                              .then((buffer) =>
                                new TextDecoder("utf-8", {
                                  fatal: true,
                                  ignoreBOM: true,
                                }).decode(buffer),
                              )
                              .then((s) => {
                                setCsv(s);
                                setFilename(file.name);
                                setHeaders(
                                  s
                                    .replace(/^\uFEFF/, "")
                                    .split(/\r?\n/)[0]
                                    .split(/[,;\t]/)
                                    .map((x) => x.replace(/^"|"$/g, "")),
                                );
                              })
                              .catch(() => {
                                setCsv("");
                                setError(
                                  "The file must be valid UTF-8. Convert its encoding before importing.",
                                );
                              });
                          }
                        }}
                      />
                    </label>
                    {headers.length > 0 && (
                      <p className="hint">
                        Detected headers: {headers.join(" · ")}
                      </p>
                    )}
                    <button disabled={busy || !online || !csv}>
                      Preview & review →
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => open("profile")}
                    >
                      ＋ Create mapping profile
                    </button>
                  </form>
                </section>
                <section className="panel padded">
                  <small className="eyebrow">YOUR IMPORT LIBRARY</small>
                  <h2>Saved mappings</h2>
                  {data.profiles.length ? (
                    data.profiles.map((p: Row) => (
                      <div className="profile" key={p.id}>
                        <b>{p.name}</b>
                        <small>
                          {p.config.source} · Version {p.version}
                        </small>
                        <p>
                          {p.config.dateFormat} · {p.config.sign}
                        </p>
                      </div>
                    ))
                  ) : (
                    <p className="empty">
                      Create a mapping to tell Budgey how your bank exports its
                      data.
                    </p>
                  )}
                  <p className="hint">
                    Mappings are immutable versions. Save a new profile when
                    settings change.
                  </p>
                </section>
              </div>
              {review && (
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <small className="eyebrow">02 / REVIEW EVERY ROW</small>
                      <h2>{review.batch.filename}</h2>
                      <p>
                        {review.batch.status === "complete"
                          ? "Completed batch · decisions preserved"
                          : "Choose a decision for every row. Nothing has been posted yet."}
                      </p>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => setReview(null)}
                    >
                      Close
                    </button>
                  </div>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>ROW / DATE</th>
                          <th>PAYEE</th>
                          <th>AMOUNT</th>
                          <th>REVIEW</th>
                          <th>DECISION</th>
                        </tr>
                      </thead>
                      <tbody>
                        {review.rows.map((r: Row) => (
                          <tr key={r.row_number}>
                            <td>
                              {r.row_number}
                              <small>{r.parsed.date}</small>
                            </td>
                            <td>
                              {r.parsed.payee || "Unparsed row"}
                              <small>
                                {r.parsed.external_id || "No stable source ID"}
                              </small>
                            </td>
                            <td>
                              {r.parsed.kind === "expense" ? "−" : "＋"}
                              {fmt(r.parsed.amount || 0)}
                            </td>
                            <td
                              className={
                                r.error || r.duplicate ? "warning" : ""
                              }
                            >
                              {r.error ||
                                (r.duplicate === "exact"
                                  ? "Exact source ID duplicate"
                                  : r.duplicate === "probable"
                                    ? "Probable duplicate"
                                    : "Ready")}
                            </td>
                            <td>
                              <select
                                aria-label={"Decision for row " + r.row_number}
                                disabled={review.batch.status === "complete"}
                                value={decisions[r.row_number] || ""}
                                onChange={(e) =>
                                  setDecisions({
                                    ...decisions,
                                    [r.row_number]: e.target.value,
                                  })
                                }
                              >
                                <option value="">Review…</option>
                                {!r.error && r.duplicate !== "exact" && (
                                  <option
                                    value={
                                      r.duplicate === "probable"
                                        ? "not_duplicate"
                                        : "accept"
                                    }
                                  >
                                    {r.duplicate === "probable"
                                      ? "Keep as distinct"
                                      : "Accept"}
                                  </option>
                                )}
                                <option value="skip">Skip explicitly</option>
                              </select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {review.batch.status !== "complete" && (
                    <div className="panel-footer">
                      <span>All accepted rows post atomically.</span>
                      <button
                        disabled={
                          busy ||
                          !online ||
                          review.rows.some((r: Row) => !decisions[r.row_number])
                        }
                        onClick={() =>
                          run(async () => {
                            await api(
                              "/imports/" + review.batch.id + "/commit",
                              {
                                decisions: review.rows.map((r: Row) => ({
                                  row_number: r.row_number,
                                  decision: decisions[r.row_number],
                                })),
                              },
                            );
                            await refresh();
                            setReview(await api("/imports/" + review.batch.id));
                            setNotice(
                              "Import committed. Decisions and provenance saved.",
                            );
                          })
                        }
                      >
                        Confirm import
                      </button>
                    </div>
                  )}
                </section>
              )}
              <section className="panel">
                <div className="panel-heading">
                  <h2>Import history</h2>
                </div>
                {data.batches.length ? (
                  data.batches.map((r: Row) => (
                    <button
                      className="history-row"
                      key={r.id}
                      onClick={() => viewBatch(r.id)}
                    >
                      <b>
                        {r.filename}
                        <small>
                          {r.row_count} rows · {r.accepted_count} posted
                        </small>
                      </b>
                      <span>{new Date(r.created_at).toLocaleString()}</span>
                      <span className="balance-pill">{r.status}</span>
                      <span>Review →</span>
                    </button>
                  ))
                ) : (
                  <div className="empty">
                    Your import history will appear here.
                  </div>
                )}
              </section>
            </>
          )}
          {tab === "Reports" && (
            <>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>{year} · Category spending</h2>
                    <p>
                      Net expenses after refunds; income and transfers excluded.
                    </p>
                  </div>
                  <a className="secondary" href="/api/export/budget">
                    Export budget ↗
                  </a>
                </div>
                {b.categories.map((c) => (
                  <div className="report-row" key={c.id}>
                    <b>{c.name}</b>
                    <div className="progress">
                      <i
                        style={{
                          width:
                            Math.max(
                              0,
                              Math.min(
                                100,
                                c.target ? (c.actual / c.target) * 100 : 100,
                              ),
                            ) + "%",
                        }}
                      />
                    </div>
                    <span>
                      {fmt(c.actual)} / {fmt(c.target)}
                    </span>
                  </div>
                ))}
                {!b.categories.length && (
                  <div className="empty">
                    Add categories to start seeing your spending.
                  </div>
                )}
              </section>
              <section className="panel padded">
                <h2>Audit trail</h2>
                <p>Material changes include actor, timestamp and provenance.</p>
                <button
                  className="secondary"
                  onClick={() =>
                    run(async () => setAuditRows(await api("/audit")))
                  }
                >
                  Load recent audit events
                </button>
                {auditRows.map((r) => (
                  <div className="audit-row" key={r.id}>
                    <b>{r.action}</b>
                    <span>{r.entity}</span>
                    <small>
                      {new Date(r.created_at).toLocaleString()} · {r.actor}
                    </small>
                  </div>
                ))}
              </section>
            </>
          )}
          <footer>
            Made for a little more clarity.{" "}
            <span>
              Budgey · {currency} · No analytics. No bank connections.
            </span>
          </footer>
        </div>
      </main>
      {modal && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setModal("");
          }}
        >
          <section
            className="modal"
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
          >
            <button
              className="close"
              aria-label="Close dialog"
              onClick={() => setModal("")}
            >
              ×
            </button>
            <small className="eyebrow">MAKE IT INTENTIONAL</small>
            <h2 id="dialog-title">
              {
                {
                  transaction: "Add a transaction",
                  account: "Add an account",
                  category: "Create an envelope",
                  target: "Set annual target",
                  allocation: "Assign to an envelope",
                  reconcile: "Compare a statement",
                  profile: "Create a mapping profile",
                  void: "Void transaction",
                  settings: "Edit settings",
                }[modal]
              }
            </h2>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {modal === "settings" && (
              <form
                onSubmit={submit((f) =>
                  save(
                    "/" + selected!.entity + "/" + selected!.id + "/settings",
                    {
                      name: f.get("name"),
                      archived: f.get("archived") === "on",
                    },
                  ),
                )}
              >
                {field("Name", "name", "text", selected!.name)}
                <label className="checkbox">
                  <input
                    type="checkbox"
                    name="archived"
                    defaultChecked={selected!.archived}
                  />
                  Archived (history remains intact)
                </label>
                <button disabled={busy || !online}>Save settings</button>
              </form>
            )}
            {modal === "account" && (
              <form
                onSubmit={submit((f) =>
                  save("/accounts", {
                    name: f.get("name"),
                    type: f.get("type"),
                    opening_date: f.get("opening_date"),
                    opening_balance: toMinor(f.get("opening_balance")),
                  }),
                )}
              >
                {field("Account name", "name")}
                <label>
                  Type
                  <select name="type">
                    <option value="checking">Checking</option>
                    <option value="savings">Savings</option>
                    <option value="cash">Cash</option>
                    <option value="credit">Credit card</option>
                  </select>
                </label>
                {field("Opening date", "opening_date", "date", currentDate)}
                {field("Opening balance", "opening_balance", "number", "0")}
                <p className="hint">
                  Use a negative balance for existing credit-card debt. This
                  does not change your starting budget funds.
                </p>
                <button disabled={busy || !online}>Add account</button>
              </form>
            )}
            {modal === "category" && (
              <form
                onSubmit={submit((f) =>
                  save("/categories", {
                    name: f.get("name"),
                    rollover: f.get("rollover") === "on",
                  }),
                )}
              >
                {field("Envelope name", "name")}
                <label className="checkbox">
                  <input type="checkbox" name="rollover" defaultChecked />
                  Carry remaining balance into the next month
                </label>
                <p className="hint">
                  This rule is fixed for this category to preserve history.
                  Reset categories release both surplus and deficit back to
                  unassigned funds.
                </p>
                <button disabled={busy || !online}>Create envelope</button>
              </form>
            )}
            {modal === "target" && (
              <form
                onSubmit={submit((f) =>
                  save("/targets", {
                    category_id: selected?.id || f.get("category_id"),
                    year,
                    amount: toMinor(f.get("amount")),
                  }),
                )}
              >
                {selected ? (
                  <p>
                    {selected.name} · {year}
                  </p>
                ) : (
                  categorySelect()
                )}
                {field(
                  "Annual target",
                  "amount",
                  "number",
                  ((selected?.target || 0) / 100).toFixed(2),
                )}
                <p className="hint">
                  Targets guide your planning. Exceeding them will warn, never
                  block.
                </p>
                <button disabled={busy || !online}>Save target</button>
                {selected && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      open("settings", { ...selected, entity: "categories" })
                    }
                  >
                    Edit / archive category
                  </button>
                )}
              </form>
            )}
            {modal === "allocation" && (
              <form
                onSubmit={submit((f) =>
                  save("/allocations", {
                    category_id: selected?.id || f.get("category_id"),
                    month: f.get("month") + "-01",
                    amount: toMinor(f.get("amount")),
                  }),
                )}
              >
                {selected ? <p>{selected.name}</p> : categorySelect()}
                {field("Month", "month", "month", month)}
                {field("Add funds (negative to release)", "amount", "number")}
                <p className="hint">
                  {fmt(b.unassigned)} available to assign. This adds an
                  auditable adjustment; it does not replace the existing
                  allocation.
                </p>
                <button disabled={busy || !online}>Assign funds</button>
              </form>
            )}
            {modal === "transaction" && (
              <form
                onSubmit={submit((f) => {
                  const amount = toMinor(f.get("amount"));
                  const splits = ["expense", "refund"].includes(kind)
                    ? [
                        {
                          category_id: f.get("category_id"),
                          amount:
                            amount -
                            (f.get("split_category")
                              ? toMinor(f.get("split_amount"))
                              : 0),
                        },
                        ...(f.get("split_category")
                          ? [
                              {
                                category_id: f.get("split_category"),
                                amount: toMinor(f.get("split_amount")),
                              },
                            ]
                          : []),
                      ]
                    : [];
                  save("/transactions", {
                    kind,
                    date: f.get("date"),
                    payee: f.get("payee"),
                    memo: f.get("memo") || "",
                    amount,
                    account_id: f.get("account_id"),
                    ...(kind === "transfer"
                      ? { destination_id: f.get("destination_id") }
                      : {}),
                    ...(kind === "refund" && f.get("original_id")
                      ? { original_id: f.get("original_id") }
                      : {}),
                    splits,
                  });
                })}
              >
                <label>
                  Transaction type
                  <select
                    value={kind}
                    onChange={(e) => setKind(e.target.value)}
                  >
                    <option value="expense">Expense / card purchase</option>
                    <option value="income">Income</option>
                    <option value="refund">Refund</option>
                    <option value="transfer">Transfer / card payment</option>
                  </select>
                </label>
                <div className="form-grid">
                  {field("Date", "date", "date", currentDate)}
                  {field("Amount (positive)", "amount", "number")}
                </div>
                {field("Payee / description", "payee")}
                {accountSelect()}
                {kind === "transfer" && accountSelect("destination_id")}
                {["expense", "refund"].includes(kind) && (
                  <>
                    {categorySelect()}
                    <details>
                      <summary>Split across another envelope</summary>
                      <label>
                        Second category
                        <select name="split_category">
                          <option value="">No split</option>
                          {opts(data.categories)}
                        </select>
                      </label>
                      {field(
                        "Amount for second category",
                        "split_amount",
                        "number",
                        "0",
                        false,
                      )}
                      <p className="hint">
                        The first category receives the remainder.
                      </p>
                    </details>
                  </>
                )}
                {kind === "refund" && (
                  <label>
                    Original expense (optional)
                    <select name="original_id">
                      <option value="">Not linked</option>
                      {tx
                        .filter((t) => t.kind === "expense" && !t.voided)
                        .map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.date} · {t.payee} · {fmt(t.amount)}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                {field("Memo (optional)", "memo", "text", "", false)}
                <p className="hint">
                  {kind === "transfer"
                    ? "Transfers change account balances without counting as spending or income."
                    : kind === "income"
                      ? "Income becomes available to assign."
                      : "Envelope balances may go negative. Budgey will show a warning."}
                </p>
                <button disabled={busy || !online || !data.accounts.length}>
                  Save transaction
                </button>
              </form>
            )}
            {modal === "reconcile" && (
              <form
                onSubmit={submit((f) =>
                  save("/reconciliations", {
                    account_id: selected!.id,
                    date: f.get("date"),
                    statement: toMinor(f.get("statement")),
                  }),
                )}
              >
                <p>{selected!.name}</p>
                {field("Statement ending date", "date", "date", currentDate)}
                {field("Statement balance", "statement", "number")}
                <p className="hint">
                  Compares all posted activity through this date. A difference
                  is reported, never adjusted automatically. A zero difference
                  locks those transactions against voiding.
                </p>
                <button disabled={busy || !online}>Compare statement</button>
              </form>
            )}
            {modal === "void" && (
              <form
                onSubmit={submit((f) =>
                  save("/transactions/" + selected!.id + "/void", {
                    reason: f.get("reason"),
                  }),
                )}
              >
                <p>
                  {selected!.payee} · {fmt(selected!.amount)}
                </p>
                {field("Reason (kept in audit history)", "reason")}
                <p className="hint">
                  Voided entries remain visible in history. Reconciled activity
                  requires a reversing transaction instead.
                </p>
                <button disabled={busy || !online}>Void transaction</button>
              </form>
            )}
            {modal === "profile" && (
              <form
                onSubmit={submit((f) => {
                  const get = (k: string) => String(f.get(k) || "");
                  save("/profiles", {
                    name: get("name"),
                    config: {
                      date: get("date"),
                      payee: get("payee"),
                      amount: get("amount"),
                      debit: get("debit"),
                      credit: get("credit"),
                      external: get("external"),
                      memo: get("memo"),
                      currency: get("currency"),
                      source: get("source"),
                      dateFormat: get("dateFormat"),
                      decimal: get("decimal"),
                      thousands: get("thousands"),
                      delimiter: get("delimiter"),
                      sign: get("sign"),
                      ...(get("category") ? { category: get("category") } : {}),
                    },
                  });
                })}
              >
                {field("Profile name", "name")}
                {field("Stable source namespace (e.g. bank-current)", "source")}
                <p className="hint">
                  Use exact CSV header names. The source namespace must remain
                  consistent across exports from the same provider.
                </p>
                <div className="form-grid">
                  {field("Date column", "date", "text", headers[0])}
                  {field("Payee column", "payee", "text", headers[1])}
                  {field(
                    "Signed amount column",
                    "amount",
                    "text",
                    undefined,
                    false,
                  )}
                  {field(
                    "Debit column (alternative)",
                    "debit",
                    "text",
                    "",
                    false,
                  )}
                  {field(
                    "Credit column (alternative)",
                    "credit",
                    "text",
                    "",
                    false,
                  )}
                  {field("Stable ID column", "external", "text", "", false)}
                  {field("Memo column", "memo", "text", "", false)}
                  {field("Currency column", "currency", "text", "", false)}
                </div>
                <label>
                  Expense envelope
                  <select name="category">
                    <option value="">Choose for expenses</option>
                    {opts(data.categories)}
                  </select>
                </label>
                <div className="form-grid">
                  <label>
                    Date format
                    <select name="dateFormat">
                      {["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY"].map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Amount sign
                    <select name="sign">
                      <option value="negative-expense">
                        Negative = expense
                      </option>
                      <option value="positive-expense">
                        Positive = expense
                      </option>
                    </select>
                  </label>
                  <label>
                    Decimal separator
                    <select name="decimal">
                      <option>.</option>
                      <option>,</option>
                    </select>
                  </label>
                  <label>
                    Thousands separator
                    <select name="thousands">
                      <option>,</option>
                      <option>.</option>
                      <option value=" ">Space</option>
                      <option value="">None</option>
                    </select>
                  </label>
                  <label>
                    CSV delimiter
                    <select name="delimiter">
                      <option value=",">Comma</option>
                      <option value=";">Semicolon</option>
                      <option value={"\t"}>Tab</option>
                    </select>
                  </label>
                </div>
                <p className="hint">
                  Positive inflows import as income. Refunds and transfers
                  should be skipped and recorded manually to preserve their
                  semantics.
                </p>
                <button disabled={busy || !online}>Save mapping</button>
              </form>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
function Activity({
  rows,
  fmt,
  onVoid,
}: {
  rows: Row[];
  fmt: (n: number) => string;
  onVoid: (r: Row) => void;
}) {
  return rows.length ? (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>PAYEE / ACCOUNT</th>
            <th>DATE</th>
            <th>CATEGORY / TYPE</th>
            <th>AMOUNT</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} className={t.voided ? "voided" : ""}>
              <td>
                <div className="activity-payee">
                  <span className={"transaction-icon " + t.kind}>
                    {t.kind === "income"
                      ? "↙"
                      : t.kind === "transfer"
                        ? "⇄"
                        : "↗"}
                  </span>
                  <div>
                    <b>{t.payee}</b>
                    <small>
                      {t.account_name} · {t.source}
                    </small>
                  </div>
                </div>
              </td>
              <td>{t.date}</td>
              <td>
                <span className="type-label">
                  {t.splits.length
                    ? t.splits.map((s: Row) => s.name).join(" + ")
                    : t.kind}
                </span>
                {t.voided && <small>Voided</small>}
              </td>
              <td
                className={
                  ["income", "refund"].includes(t.kind) ? "positive" : ""
                }
              >
                {t.kind === "expense" ? "−" : t.kind === "transfer" ? "" : "＋"}
                {fmt(t.amount)}
              </td>
              <td>
                {!t.voided && (
                  <button className="text-button" onClick={() => onVoid(t)}>
                    Void
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <div className="empty">
      <h3>A fresh page.</h3>
      <p>Add a transaction or import a CSV to start your story.</p>
    </div>
  );
}
