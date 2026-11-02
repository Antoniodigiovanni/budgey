import test from "node:test";
import assert from "node:assert/strict";
import { parseImport, mappingSchema } from "../server/imports.js";
const cat = "10000000-0000-4000-8000-000000000001";
const config = {
  date: "Date",
  payee: "Payee",
  amount: "Amount",
  source: "bank",
  category: cat,
};
test("CSV quoting, BOM, blank IDs, row numbers, UTF-8 and exact cents", () => {
  const rows = parseImport(
    '\uFEFFDate,Payee,Amount\r\n2026-01-01,"Café, corner",-0.29\r\n2026-01-02,Salary,1200.50',
    config,
    "EUR",
  );
  assert.equal(rows[0].parsed.amount, 29);
  assert.equal(rows[0].parsed.payee, "Café, corner");
  assert.equal(rows[0].row_number, 2);
  assert.equal(rows[0].error, null);
  assert.equal(rows[1].parsed.kind, "income");
  assert.equal(rows[1].parsed.amount, 120050);
});
test("localized dates, debit-credit and currency mismatch", () => {
  const cfg = {
    date: "date",
    payee: "name",
    debit: "debit",
    credit: "credit",
    source: "bank",
    category: cat,
    dateFormat: "DD/MM/YYYY",
    delimiter: ";",
    decimal: ",",
    thousands: ".",
    currency: "ccy",
  };
  const rows = parseImport(
    "date;name;debit;credit;ccy\n31/01/2026;Shop;1.234,56;;EUR\n31/02/2026;Bad;1;;EUR\n01/02/2026;Foreign;1;;USD",
    cfg,
    "EUR",
  );
  assert.equal(rows[0].parsed.amount, 123456);
  assert.equal(rows[0].parsed.date, "2026-01-31");
  assert.ok(rows[1].error);
  assert.match(rows[2].error!, /Currency/);
});
test("malformed amounts remain review errors and duplicate fingerprints do not discard rows", () => {
  const rows = parseImport(
    "Date,Payee,Amount\n2026-01-01,Shop,-1\n2026-01-01,Shop,-1\n2026-01-01,Bad,0.001",
    config,
    "EUR",
  );
  assert.equal(rows.length, 3);
  assert.equal(rows[0].fingerprint, rows[1].fingerprint);
  assert.ok(rows[2].error);
  assert.throws(() =>
    mappingSchema.parse({ ...config, decimal: ".", thousands: "." }),
  );
});
