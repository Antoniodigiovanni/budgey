import test from "node:test";
import assert from "node:assert/strict";
import { portfolio, balanceSheet, quantity, money } from "../src/wealth.js";
const p = {
  id: "p",
  name: "Broker",
  opening_date: "2026-01-01",
  opening_cash: 10000,
};
const event = (
  kind: string,
  date: string,
  amount: number,
  units = "0",
  instrument_id: string | null = null,
  fees = 0,
) => ({
  id: date + kind,
  portfolio_id: "p",
  kind,
  date,
  amount,
  units,
  instrument_id,
  fees,
});
test("fractional buys, sales, fees and external flows use exact cents", () => {
  const events = [
    event("buy", "2026-01-02", 2500, "1.250000", "i", 25),
    event("sell", "2026-01-03", 1100, "0.5", "i", 10),
    event("dividend", "2026-01-04", 100),
    event("fee", "2026-01-05", 20),
    event("deposit", "2026-01-06", 500),
    event("withdrawal", "2026-01-07", 200),
  ];
  const r = portfolio(
    p,
    events,
    [{ id: "x", instrument_id: "i", date: "2026-01-02", amount: 2101 }],
    "2026-01-31",
  );
  assert.equal(r.cash, 8945);
  assert.equal(r.holdings[0].units, "0.75");
  assert.equal(r.holdings[0].value, 1576);
  assert.equal(r.value, 10521);
  assert.equal(portfolio(p, events, [], "2026-01-31").value, null);
  assert.equal(
    portfolio(
      p,
      events,
      [{ id: "x", instrument_id: "i", date: "2026-01-02", amount: 0 }],
      "2026-01-31",
    ).holdings[0].value,
    0,
  );
});
test("reject impossible and backdated histories, unsafe quantities and totals", () => {
  assert.throws(
    () =>
      portfolio(
        p,
        [event("sell", "2026-01-02", 100, "1", "i")],
        [],
        "2026-12-31",
      ),
    /sell/i,
  );
  assert.throws(
    () =>
      portfolio(
        p,
        [event("withdrawal", "2026-01-02", 10001)],
        [],
        "2026-12-31",
      ),
    /cash/i,
  );
  assert.throws(
    () => portfolio(p, [event("fee", "2025-12-01", 1)], [], "2026-12-31"),
    /opening/i,
  );
  assert.throws(() => quantity("-1"));
  assert.throws(() => quantity("1.0000001"));
  assert.throws(() => money(9007199254740992n));
});
test("dated balance sheet: zero, unknown, signs, archived accounts and void exclusion", () => {
  const data = {
    accounts: [
      {
        id: "a",
        name: "Archived bank",
        opening_date: "2026-01-01",
        opening_balance: 10000,
        archived: true,
      },
      {
        id: "c",
        name: "Card",
        opening_date: "2026-01-01",
        opening_balance: -1000,
      },
    ],
    entries: [
      { account_id: "a", date: "2026-02-01", amount: 500, voided: false },
      { account_id: "a", date: "2026-01-02", amount: -200, voided: true },
    ],
    assets: [
      { id: "h", name: "Home", kind: "property" },
      { id: "m", name: "Mortgage", kind: "mortgage" },
      { id: "z", name: "Car", kind: "vehicle" },
    ],
    valuations: [
      { id: "1", asset_id: "h", date: "2026-01-01", amount: 200000 },
      { id: "2", asset_id: "m", date: "2026-01-01", amount: 50000 },
      { id: "3", asset_id: "z", date: "2026-02-01", amount: 0 },
    ],
    portfolios: [],
    events: [],
    prices: [],
    instruments: [],
  };
  const r = balanceSheet(data, "2026-01-31");
  assert.equal(r.knownNetWorth, 159000);
  assert.equal(r.complete, false);
  assert.equal(r.rows[4].value, null);
  assert.equal(balanceSheet(data, "2026-02-01").rows[4].value, 0);
});

test("backdated sale rejects a later oversell and exact half-cent rounds up", () => {
  const buy = event("buy", "2026-01-02", 100, "1", "i");
  const sell = event("sell", "2026-01-04", 100, "1", "i");
  assert.throws(
    () =>
      portfolio(
        p,
        [buy, sell, event("sell", "2026-01-03", 10, "0.1", "i")],
        [],
        "2026-12-31",
      ),
    /sell/,
  );
  const r = portfolio(
    p,
    [event("buy", "2026-01-02", 1, "0.5", "i")],
    [{ id: "x", instrument_id: "i", date: "2026-01-01", amount: 1 }],
    "2026-01-03",
  );
  assert.equal(r.holdings[0].value, 1);
  assert.equal(r.value, 10000);
});

test("net worth counts brokerage once and history only carries recorded values", async () => {
  const { history } = await import("../src/wealth.js");
  const data = {
    accounts: [],
    entries: [],
    assets: [{ id: "a", name: "Asset", kind: "other_asset" }],
    valuations: [{ id: "v", asset_id: "a", date: "2026-02-10", amount: 1000 }],
    portfolios: [p],
    events: [event("buy", "2026-01-02", 2500, "1.25", "i", 25)],
    prices: [
      { id: "price", instrument_id: "i", date: "2026-02-01", amount: 2101 },
    ],
    instruments: [{ id: "i", name: "Fund" }],
  };
  const h = history(data, "2026-03-15");
  assert.deepEqual(
    h.map((x) => x.date),
    ["2026-01-31", "2026-02-28", "2026-03-15"],
  );
  assert.equal(h[0].complete, false);
  assert.equal(h[0].knownNetWorth, 0);
  assert.equal(h[1].knownNetWorth, 11101);
  assert.equal(h[2].knownNetWorth, 11101);
  assert.equal(h[2].portfolios[0].holdings[0].price_date, "2026-02-01");
  assert.equal(balanceSheet(data, "2025-12-31").portfolios.length, 0);
});

test("a safe current total cannot hide an unsafe historical snapshot", async () => {
  const { validateWealth } = await import("../src/wealth.js");
  const data = {
    accounts: [],
    entries: [],
    assets: [
      { id: "a", name: "A", kind: "property" },
      { id: "b", name: "B", kind: "property" },
    ],
    valuations: [
      {
        id: "1",
        asset_id: "a",
        date: "2026-01-01",
        amount: Number.MAX_SAFE_INTEGER,
      },
      { id: "2", asset_id: "b", date: "2026-01-01", amount: 1 },
      { id: "3", asset_id: "a", date: "2026-02-01", amount: 0 },
    ],
    portfolios: [],
    events: [],
    prices: [],
    instruments: [],
  };
  assert.equal(balanceSheet(data, "2026-02-01").knownNetWorth, 1);
  assert.throws(() => validateWealth(data), /safe range/);
});

test("currency display preserves cents even at safe integer limits", async () => {
  const { formatWealthMoney } = await import("../src/wealth.js");
  assert.equal(
    formatWealthMoney(Number.MAX_SAFE_INTEGER, "GBP", "en-GB"),
    "£90,071,992,547,409.91",
  );
  assert.equal(formatWealthMoney(-1, "GBP", "en-GB"), "-£0.01");
});
