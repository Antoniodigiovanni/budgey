import test from "node:test";
import assert from "node:assert/strict";
import { transactionSchema } from "../server/ledger.js";
const cat = "10000000-0000-4000-8000-000000000001";
test("transaction split validation and transfer pairing inputs", () => {
  const common = {
    date: "2026-01-01",
    payee: "Test",
    amount: 100,
    account_id: "20000000-0000-4000-8000-000000000001",
  };
  assert.throws(() =>
    transactionSchema.parse({
      ...common,
      kind: "expense",
      splits: [{ category_id: cat, amount: 99 }],
    }),
  );
  assert.throws(() =>
    transactionSchema.parse({
      ...common,
      kind: "transfer",
      destination_id: common.account_id,
    }),
  );
  assert.doesNotThrow(() =>
    transactionSchema.parse({
      ...common,
      kind: "refund",
      splits: [{ category_id: cat, amount: 100 }],
    }),
  );
});
