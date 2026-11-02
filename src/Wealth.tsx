import { formatWealthMoney } from "./wealth";
import React, { useEffect, useId, useRef, useState } from "react";
import type { WealthData, balanceSheet } from "./wealth";
type Snapshot = ReturnType<typeof balanceSheet>;
type State = { data: WealthData; snapshot: Snapshot; history: Snapshot[] };
type Api = (path: string, body?: unknown) => Promise<State>;
function cents(value: FormDataEntryValue | null) {
  const s = String(value ?? "");
  if (!/^\d+(\.\d{1,2})?$/.test(s))
    throw Error(
      "Amount requires a nonnegative number with at most two decimals",
    );
  const [a, b = ""] = s.split(".");
  const n = BigInt(a) * 100n + BigInt(b.padEnd(2, "0"));
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("Amount too large");
  return Number(n);
}
export default function Wealth({
  tab,
  today,
  currency,
  api,
  online,
}: {
  tab: string;
  today: string;
  currency: string;
  api: Api;
  online: boolean;
}) {
  const [date, setDate] = useState(today),
    [state, setState] = useState<State | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [eventKind, setEventKind] = useState("buy");
  const instanceId = useId();
  const fieldId = (form: string, name: string) =>
    `${instanceId}-${form}-${name}`;
  const guard = useRef(false);
  const request = useRef(0);
  async function refresh() {
    const version = ++request.current;
    setError("");
    setLoading(true);
    try {
      const s = await api("/wealth?date=" + date);
      if (version === request.current) setState(s);
    } catch (e) {
      if (version === request.current) setError((e as Error).message);
    } finally {
      if (version === request.current) setLoading(false);
    }
  }
  useEffect(() => {
    setError("");
    void refresh();
    return () => {
      request.current++;
    };
  }, [date]);
  const fmt = (n: number | null) =>
    n === null ? "Missing value" : formatWealthMoney(n, currency);
  const input = (
    scope: string,
    label: string,
    name: string,
    type = "text",
    value?: string,
  ) => (
    <>
      <label htmlFor={fieldId(scope, name)}>{label}</label>
      <input
        id={fieldId(scope, name)}
        name={name}
        type={type}
        defaultValue={value}
        required
        step={type === "number" ? "0.01" : undefined}
      />
    </>
  );
  const select = (
    scope: string,
    label: string,
    name: string,
    rows: { id: string; name: string }[],
  ) => (
    <>
      <label htmlFor={fieldId(scope, name)}>{label}</label>
      <select required name={name} id={fieldId(scope, name)}>
        <option value="">Choose…</option>
        {rows.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
      </select>
    </>
  );
  function form(
    title: string,
    path: string,
    fields: React.ReactNode,
    body: (f: FormData) => unknown,
  ) {
    return (
      <details className="wealth-form">
        <summary>{title}</summary>
        <form
          aria-label={title}
          onSubmit={async (e) => {
            e.preventDefault();
            if (guard.current) return;
            guard.current = true;
            setBusy(true);
            setError("");
            setNotice("");
            const form = e.currentTarget;
            try {
              if (!online) throw Error("Reconnect before saving");
              await api("/wealth/" + path, body(new FormData(form)));
              form.reset();
              setNotice(title + " saved.");
              await refresh();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              guard.current = false;
              setBusy(false);
            }
          }}
        >
          {fields}
          <button disabled={busy || !online}>Save {title.toLowerCase()}</button>
        </form>
      </details>
    );
  }
  const table = (headers: string[], rows: React.ReactNode[][]) => (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((v, j) => (
                <td key={j}>{v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p className="empty">No records yet.</p>}
    </div>
  );
  const d = state?.data;
  return (
    <section className="wealth" aria-label={tab}>
      <h1>{tab}</h1>
      <div className="wealth-date">
        <label htmlFor={fieldId("snapshot", "date")}>As of date</label>
        <input
          id={fieldId("snapshot", "date")}
          type="date"
          value={date}
          min="1900-01-01"
          max="2200-12-31"
          onChange={(e) => {
            if (e.target.value) setDate(e.target.value);
          }}
        />
      </div>
      <p>
        Manual deposits and withdrawals do not change budget accounts or
        envelope funds.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
          <button
            type="button"
            className="text-button"
            onClick={() => void refresh()}
          >
            Reload records
          </button>
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {loading && <p role="status">Loading wealth records…</p>}
      {state && !loading && (
        <>
          {tab === "Balance sheet" ? (
            <>
              <div className="wealth-totals">
                <p>
                  Known assets <b>{fmt(state.snapshot.assets)}</b>
                </p>
                <p>
                  Known liabilities <b>{fmt(state.snapshot.liabilities)}</b>
                </p>
                <p>
                  Known net worth <b>{fmt(state.snapshot.knownNetWorth)}</b>
                </p>
              </div>
              {!state.snapshot.complete && (
                <p className="banner" role="status">
                  Incomplete valuation: known values only. Missing is not zero.
                </p>
              )}
              {table(
                ["Record", "Source", "Signed value", "Valuation date"],
                state.snapshot.rows.map((r) => [
                  r.name,
                  r.source,
                  fmt(r.value),
                  r.valuation_date
                    ? r.valuation_date < date
                      ? r.valuation_date + " · carried forward"
                      : r.valuation_date
                    : r.source.startsWith("Brokerage")
                      ? "See holding price dates"
                      : "Missing",
                ]),
              )}
              {form(
                "Add asset or debt",
                "assets",
                <>
                  {input("assets", "Record name", "name")}
                  <label htmlFor={fieldId("assets", "kind")}>Record type</label>
                  <select name="kind" id={fieldId("assets", "kind")}>
                    {[
                      "property",
                      "vehicle",
                      "other_asset",
                      "loan",
                      "mortgage",
                      "other_liability",
                    ].map((k) => (
                      <option key={k} value={k}>
                        {k.replaceAll("_", " ")}
                      </option>
                    ))}
                  </select>
                </>,
                (f) => ({ name: f.get("name"), kind: f.get("kind") }),
              )}
              {form(
                "Record valuation",
                "valuations",
                <>
                  {select("valuations", "Asset or debt", "asset_id", d!.assets)}
                  {input("valuations", "Valuation date", "date", "date", date)}
                  {input(
                    "valuations",
                    "Value owed or owned (positive, zero allowed)",
                    "amount",
                    "number",
                  )}
                  <p>
                    One value per record per date. Saved values cannot be
                    changed.
                  </p>
                </>,
                (f) => ({
                  asset_id: f.get("asset_id"),
                  date: f.get("date"),
                  amount: cents(f.get("amount")),
                }),
              )}
              <h2>Valuation records</h2>
              {table(
                ["Record", "Date", "Value"],
                d!.valuations.map((v) => [
                  d!.assets.find((a) => a.id === v.asset_id)?.name,
                  v.date,
                  fmt(v.amount),
                ]),
              )}
              <h2>Monthly net worth history</h2>
              {table(
                ["Date", "Known net worth", "Completeness", "Carried values"],
                state.history.map((h) => [
                  h.date,
                  fmt(h.knownNetWorth),
                  h.complete ? "Complete" : "Incomplete",
                  h.rows.filter(
                    (r) => r.valuation_date && r.valuation_date < h.date,
                  ).length +
                    h.portfolios
                      .flatMap((p) => p.holdings)
                      .filter(
                        (holding) =>
                          holding.price_date && holding.price_date < h.date,
                      ).length,
                ]),
              )}
            </>
          ) : (
            <>
              <p>
                Units: up to six decimals. Values round to cents, half up. Trade
                amounts exclude fees.
              </p>
              {form(
                "Create portfolio",
                "portfolios",
                <>
                  {input("portfolios", "Portfolio name", "name")}
                  {input(
                    "portfolios",
                    "Opening date",
                    "opening_date",
                    "date",
                    date,
                  )}
                  {input(
                    "portfolios",
                    "Opening cash",
                    "opening_cash",
                    "number",
                    "0",
                  )}
                  <p>Opening cash counts once in net worth.</p>
                </>,
                (f) => ({
                  name: f.get("name"),
                  opening_date: f.get("opening_date"),
                  opening_cash: cents(f.get("opening_cash")),
                }),
              )}
              {form(
                "Create security",
                "instruments",
                input("instruments", "Security name", "name"),
                (f) => ({ name: f.get("name") }),
              )}
              {form(
                "Record price",
                "prices",
                <>
                  {select(
                    "prices",
                    "Security",
                    "instrument_id",
                    d!.instruments,
                  )}
                  {input("prices", "Price date", "date", "date", date)}
                  {input(
                    "prices",
                    "Price per unit (zero allowed)",
                    "amount",
                    "number",
                  )}
                </>,
                (f) => ({
                  instrument_id: f.get("instrument_id"),
                  date: f.get("date"),
                  amount: cents(f.get("amount")),
                }),
              )}
              {form(
                "Record investment activity",
                "events",
                <>
                  {select("events", "Portfolio", "portfolio_id", d!.portfolios)}
                  <label htmlFor={fieldId("events", "kind")}>
                    Activity type
                  </label>
                  <select
                    name="kind"
                    id={fieldId("events", "kind")}
                    value={eventKind}
                    onChange={(e) => setEventKind(e.target.value)}
                  >
                    {[
                      "buy",
                      "sell",
                      "dividend",
                      "fee",
                      "deposit",
                      "withdrawal",
                    ].map((k) => (
                      <option key={k}>{k}</option>
                    ))}
                  </select>
                  {input("events", "Activity date", "date", "date", date)}
                  {input(
                    "events",
                    "Total consideration or cash amount",
                    "amount",
                    "number",
                  )}
                  {["buy", "sell"].includes(eventKind) && (
                    <>
                      {select(
                        "events",
                        "Trade security",
                        "instrument_id",
                        d!.instruments,
                      )}
                      {input("events", "Units (up to six decimals)", "units")}
                      {input("events", "Trade fees", "fees", "number", "0")}
                    </>
                  )}
                </>,
                (f) => ({
                  portfolio_id: f.get("portfolio_id"),
                  kind: eventKind,
                  date: f.get("date"),
                  amount: cents(f.get("amount")),
                  instrument_id: ["buy", "sell"].includes(eventKind)
                    ? f.get("instrument_id")
                    : null,
                  units: ["buy", "sell"].includes(eventKind)
                    ? f.get("units")
                    : "0",
                  fees: ["buy", "sell"].includes(eventKind)
                    ? cents(f.get("fees"))
                    : 0,
                }),
              )}
              {!state.snapshot.portfolios.length && (
                <p className="empty">No portfolios opened by this date.</p>
              )}
              {state.snapshot.portfolios.map((p) => (
                <section className="wealth-portfolio" key={p.id}>
                  <h2>{p.name}</h2>
                  <p>
                    Opened{" "}
                    {d!.portfolios.find((x) => x.id === p.id)?.opening_date} ·
                    Opening cash{" "}
                    {fmt(
                      d!.portfolios.find((x) => x.id === p.id)!.opening_cash,
                    )}
                  </p>
                  <p>
                    Cash {fmt(p.cash)} · Total {fmt(p.value)}
                  </p>
                  {p.value === null && (
                    <p className="banner">
                      Missing price: total value is unknown.
                    </p>
                  )}
                  {table(
                    ["Security", "Units", "Value", "Price date"],
                    p.holdings.map((h) => [
                      d!.instruments.find((i) => i.id === h.instrument_id)
                        ?.name,
                      h.units,
                      fmt(h.value),
                      h.price_date
                        ? h.price_date < date
                          ? h.price_date + " · carried forward"
                          : h.price_date
                        : "Missing",
                    ]),
                  )}
                </section>
              ))}
              <h2>Investment activity</h2>
              {table(
                [
                  "Date",
                  "Portfolio",
                  "Activity",
                  "Security",
                  "Units",
                  "Amount",
                  "Fees",
                ],
                d!.events
                  .filter((e) => e.date <= date)
                  .map((e) => [
                    e.date,
                    d!.portfolios.find((p) => p.id === e.portfolio_id)?.name,
                    e.kind,
                    d!.instruments.find((i) => i.id === e.instrument_id)
                      ?.name || "N/A",
                    e.units,
                    fmt(e.amount),
                    fmt(e.fees),
                  ]),
              )}
              <h2>Manual prices</h2>
              {table(
                ["Security", "Date", "Price"],
                d!.prices.map((p) => [
                  d!.instruments.find((i) => i.id === p.instrument_id)?.name,
                  p.date,
                  fmt(p.amount),
                ]),
              )}
              <h2>Portfolio value history</h2>
              {table(
                ["Date", "Portfolio", "Cash", "Total", "Price dates"],
                state.history.flatMap((h) =>
                  h.portfolios.map((p) => [
                    h.date,
                    p.name,
                    fmt(p.cash),
                    fmt(p.value),
                    p.holdings
                      .map((holding) =>
                        holding.price_date
                          ? holding.price_date +
                            (holding.price_date < h.date
                              ? " · carried forward"
                              : "")
                          : "Missing",
                      )
                      .join(", ") || "No holdings",
                  ]),
                ),
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
