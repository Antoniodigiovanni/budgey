import test from "node:test";
import assert from "node:assert/strict";
import {
  money,
  hash,
  envelope,
  identity,
  validateConfig,
} from "../server/domain.js";
import { calculate } from "../src/budget.js";
test("exact minor units: negatives, decimal locales and invalid precision", () => {
  assert.equal(money("1,234.56"), 123456);
  assert.equal(money("-0.01"), -1);
  assert.equal(money("1.234,56", ",", "."), 123456);
  for (const v of ["1.001", "NaN", "1e3", "", "1,2,3.45"])
    assert.throws(() => money(v));
  assert.equal(money("0.29"), 29);
});
test("canonical payload hashes ignore key order and preserve array order", () => {
  assert.equal(hash({ b: 2, a: 1 }), hash({ a: 1, b: 2 }));
  assert.notEqual(hash([1, 2]), hash([2, 1]));
  assert.notEqual(hash({ amount: 100 }), hash({ amount: 101 }));
});
test("envelopes preserve deficits and apply rollover", () => {
  assert.equal(envelope(100, 200, 350, true), -50);
  assert.equal(envelope(100, 200, 350, false), -150);
});
const base = {
  APP_ENV: "production",
  DATABASE_URL: "postgresql://localhost/test",
  PUBLIC_ORIGIN: "https://budget.example.com",
  ALLOWED_EMAIL: "owner@example.com",
  TRUSTED_IDENTITY_HEADER: "x-hermes-verified-email",
};
test("trusted identity fails closed and development identity cannot enable production", () => {
  assert.equal(identity(base, undefined), null);
  assert.equal(identity(base, "intruder@example.com"), null);
  assert.equal(identity(base, ["owner@example.com"]), null);
  assert.equal(identity(base, "OWNER@example.com"), "owner@example.com");
  assert.equal(
    identity(
      { ...base, APP_ENV: "development", DEV_IDENTITY: "dev@example.com" },
      undefined,
    ),
    "dev@example.com",
  );
  assert.throws(() =>
    validateConfig({ ...base, DEV_IDENTITY: "dev@example.com" }),
  );
  assert.throws(() => validateConfig({ ...base, TRUSTED_IDENTITY_HEADER: "" }));
  assert.throws(() => validateConfig({ ...base, APP_ENV: "" }));
  assert.doesNotThrow(() => validateConfig(base));
});
const state = () => ({
  household: { starting_funds: 100000 },
  categories: [
    { id: "food", rollover: true },
    { id: "fun", rollover: false },
  ],
  targets: [{ category_id: "food", year: 2026, amount: 1000 }],
  allocations: [
    { category_id: "food", month: "2025-12-01", amount: 10000 },
    { category_id: "food", month: "2026-01-01", amount: 20000 },
    { category_id: "fun", month: "2026-01-01", amount: 5000 },
  ],
  transactions: [
    { kind: "income", date: "2026-01-02", amount: 10000, splits: [] },
    {
      kind: "expense",
      date: "2026-01-03",
      amount: 12000,
      splits: [
        { category_id: "food", amount: 10000 },
        { category_id: "fun", amount: 2000 },
      ],
    },
    {
      kind: "refund",
      date: "2026-01-04",
      amount: 1000,
      splits: [{ category_id: "food", amount: 1000 }],
    },
    { kind: "transfer", date: "2026-01-05", amount: 12000, splits: [] },
  ],
});
test("income, splits, refunds and card payment count correctly; advisory target permits overruns", () => {
  const b = calculate(state(), "2026-01");
  assert.equal(b.spent, 11000);
  assert.equal(b.assigned, 25000);
  assert.equal(b.categories[0].start, 10000);
  assert.equal(b.categories[0].available, 21000);
  assert.equal(b.unassigned, 75000);
  assert.ok(b.categories[0].warnings.includes("Spending above target"));
  assert.ok(b.categories[0].warnings.includes("Plan above target"));
});
test("rollover across years and monthly reset release unspent funds without rewriting history", () => {
  const s = state();
  const jan = calculate(s, "2026-01");
  const mar = calculate(s, "2026-03");
  assert.equal(mar.categories[0].available, 21000);
  assert.equal(mar.categories[1].available, 0);
  assert.equal(mar.unassigned, jan.unassigned + 3000);
  assert.equal(calculate(s, "2026-01").categories[1].available, 3000);
});
test("negative reset envelope releases a deficit, future activity and voids do not affect current funds", () => {
  const s = state();
  s.transactions.push({
    kind: "expense",
    date: "2026-01-07",
    amount: 4000,
    splits: [{ category_id: "fun", amount: 4000 }],
  });
  const jan = calculate(s, "2026-01");
  assert.equal(jan.categories[1].available, -1000);
  assert.equal(calculate(s, "2026-02").unassigned, jan.unassigned - 1000);
  s.transactions.push({
    kind: "income",
    date: "2027-01-01",
    amount: 900000,
    splits: [],
  });
  assert.equal(calculate(s, "2026-01").unassigned, jan.unassigned);
});

test("CSV export neutralizes spreadsheet formulas and preserves actual numeric minor units", async () => {
  const { csvCell } = await import("../server/export.js");
  assert.equal(csvCell("=1+1"), '"\'=1+1"');
  assert.equal(csvCell("\t=1+1"), '"\'\t=1+1"');
  assert.equal(csvCell(-1250), '"-1250"');
  assert.equal(csvCell('Café, "corner"'), '"Café, ""corner"""');
});
