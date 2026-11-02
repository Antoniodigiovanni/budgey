export interface Account {
  id: string;
  name: string;
  opening_date: string;
  opening_balance: number;
}
export interface Asset {
  id: string;
  name: string;
  kind: string;
}
export interface Valuation {
  id: string;
  asset_id: string;
  date: string;
  amount: number;
}
export interface Price {
  id: string;
  instrument_id: string;
  date: string;
  amount: number;
}
export interface Portfolio {
  id: string;
  name: string;
  opening_date: string;
  opening_cash: number;
}
export interface Event {
  id: string;
  portfolio_id: string;
  instrument_id: string | null;
  kind: string;
  date: string;
  amount: number;
  units: string;
  fees: number;
}
export interface WealthData {
  accounts: Account[];
  entries: {
    account_id: string;
    date: string;
    amount: number;
    voided: boolean;
  }[];
  assets: Asset[];
  valuations: Valuation[];
  portfolios: Portfolio[];
  instruments: { id: string; name: string }[];
  events: Event[];
  prices: Price[];
}
export function money(n: bigint): number {
  if (
    n > BigInt(Number.MAX_SAFE_INTEGER) ||
    n < -BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw Error("Amount exceeds safe range");
  return Number(n);
}
export function quantity(s: string): bigint {
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(s))
    throw Error("Units require a nonnegative decimal with at most six places");
  const [a, b = ""] = s.split(".");
  return BigInt(a) * 1000000n + BigInt(b.padEnd(6, "0"));
}
function units(n: bigint) {
  return `${n / 1000000n}.${String(n % 1000000n).padStart(6, "0")}`.replace(
    /\.?0+$/,
    "",
  );
}
const latest = <T extends { date: string }>(rows: T[], date: string) =>
  rows
    .filter((x) => x.date <= date)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
export function portfolio(
  p: Portfolio,
  events: Event[],
  prices: Price[],
  date: string,
) {
  let cash = BigInt(p.opening_cash);
  const held = new Map<string, bigint>();
  for (const e of events
    .filter((e) => e.portfolio_id === p.id && e.date <= date)
    .sort((a, b) => a.date.localeCompare(b.date))) {
    if (e.date < p.opening_date)
      throw Error("Activity predates portfolio opening");
    const n = quantity(e.units),
      amount = BigInt(e.amount),
      fees = BigInt(e.fees);
    const id = e.instrument_id || "";
    if (e.kind === "buy") {
      held.set(id, (held.get(id) || 0n) + n);
      cash -= amount + fees;
    } else if (e.kind === "sell") {
      if ((held.get(id) || 0n) < n)
        throw Error("Cannot sell more units than held");
      held.set(id, held.get(id)! - n);
      cash += amount - fees;
    } else cash += ["deposit", "dividend"].includes(e.kind) ? amount : -amount;
    if (cash < 0n) throw Error("Insufficient portfolio cash");
    money(cash);
  }
  const holdings = [...held]
    .filter(([, n]) => n > 0n)
    .map(([id, n]) => {
      const price = latest(
        prices.filter((x) => x.instrument_id === id),
        date,
      );
      return {
        instrument_id: id,
        units: units(n),
        price_date: price?.date || null,
        value: price
          ? money((n * BigInt(price.amount) + 500000n) / 1000000n)
          : null,
      };
    });
  const value = holdings.some((x) => x.value === null)
    ? null
    : money(cash + holdings.reduce((s, x) => s + BigInt(x.value!), 0n));
  return { id: p.id, name: p.name, cash: money(cash), holdings, value };
}
export function balanceSheet(d: WealthData, date: string) {
  const rows: {
    id: string;
    name: string;
    value: number | null;
    valuation_date: string | null;
    source: string;
  }[] = d.accounts
    .filter((a) => a.opening_date <= date)
    .map((a) => ({
      id: a.id,
      name: a.name,
      value: money(
        BigInt(a.opening_balance) +
          d.entries
            .filter((e) => e.account_id === a.id && !e.voided && e.date <= date)
            .reduce((s, e) => s + BigInt(e.amount), 0n),
      ),
      valuation_date: date,
      source: "Budget ledger",
    }));
  for (const a of d.assets) {
    const v = latest(
      d.valuations.filter((v) => v.asset_id === a.id),
      date,
    );
    rows.push({
      id: a.id,
      name: a.name,
      value: v
        ? ["loan", "mortgage", "other_liability"].includes(a.kind)
          ? -v.amount
          : v.amount
        : null,
      valuation_date: v?.date || null,
      source: a.kind,
    });
  }
  const portfolios = d.portfolios
    .filter((p) => p.opening_date <= date)
    .map((p) => portfolio(p, d.events, d.prices, date));
  for (const p of portfolios)
    rows.push({
      id: p.id,
      name: p.name,
      value: p.value,
      valuation_date: null,
      source: "Brokerage cash + holdings",
    });
  const sum = (positive: boolean) =>
    money(
      rows.reduce(
        (s, r) =>
          r.value !== null && (positive ? r.value > 0 : r.value < 0)
            ? s + BigInt(r.value)
            : s,
        0n,
      ),
    );
  const assets = sum(true),
    liabilities = -sum(false);
  return {
    date,
    rows,
    portfolios,
    assets,
    liabilities,
    knownNetWorth: money(BigInt(assets) - BigInt(liabilities)),
    complete: rows.every((r) => r.value !== null),
  };
}
export function history(d: WealthData, asOf: string) {
  const dates = [
    ...d.accounts.map((x) => x.opening_date),
    ...d.valuations.map((x) => x.date),
    ...d.portfolios.map((x) => x.opening_date),
    ...d.events.map((x) => x.date),
    ...d.entries.filter((x) => !x.voided).map((x) => x.date),
    ...d.prices.map((x) => x.date),
  ]
    .filter((x) => x <= asOf)
    .sort();
  if (!dates.length) return [];
  const result = [];
  let month = dates[0].slice(0, 7);
  while (month <= asOf.slice(0, 7)) {
    const [y, m] = month.split("-").map(Number);
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    result.push(balanceSheet(d, end < asOf ? end : asOf));
    month = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
  }
  return result;
}

/** Validate every observed boundary, so later zeros or sales cannot mask overflow. */
export function validateWealth(d: WealthData) {
  const dates = new Set([
    ...d.accounts.map((x) => x.opening_date),
    ...d.entries.map((x) => x.date),
    ...d.valuations.map((x) => x.date),
    ...d.portfolios.map((x) => x.opening_date),
    ...d.events.map((x) => x.date),
    ...d.prices.map((x) => x.date),
  ]);
  for (const date of [...dates].sort()) balanceSheet(d, date);
}

export function formatWealthMoney(
  amount: number,
  currency: string,
  locale?: string,
) {
  const n = BigInt(amount),
    whole = n / 100n,
    absolute = n < 0n ? -n : n;
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return formatter
    .formatToParts(n < 0n && whole === 0n ? -0 : whole)
    .map((part) =>
      part.type === "fraction"
        ? String(absolute % 100n).padStart(2, "0")
        : part.value,
    )
    .join("");
}
