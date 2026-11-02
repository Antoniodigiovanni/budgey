import assert from "node:assert/strict";
const base = process.env.TEST_API_URL;
if (base !== "http://127.0.0.1:3102")
  throw Error(
    "Use the dedicated disposable test server at TEST_API_URL=http://127.0.0.1:3102",
  );
const headers = {
  "Content-Type": "application/json",
  Origin: base,
  "X-Hermes-Verified-Email": "test@example.com",
};
async function write(
  path: string,
  body: unknown,
  key = crypto.randomUUID(),
  status = 200,
) {
  const r = await fetch(base + "/api" + path, {
    method: "POST",
    headers: { ...headers, "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  assert.equal(r.status, status, JSON.stringify(data));
  return data;
}
const read = async () => {
  const r = await fetch(base + "/api/wealth?date=2026-01-31", { headers });
  assert.equal(r.status, 200);
  return r.json();
};
await write("/setup", {
  name: "Integration",
  currency: "EUR",
  timezone: "UTC",
  starting_funds: 100000,
});
const before = await (await fetch(base + "/api/state", { headers })).json();
const asset = await write("/wealth/assets", {
  name: "API home " + crypto.randomUUID(),
  kind: "property",
});
const body = { asset_id: asset.id, date: "2026-01-01", amount: 25000000 };
const key = crypto.randomUUID();
const v = await write("/wealth/valuations", body, key);
assert.deepEqual(await write("/wealth/valuations", body, key), v);
await write("/wealth/valuations", { ...body, amount: 1 }, key, 409);
await write(
  "/wealth/valuations",
  { ...body, date: "2026-02-30" },
  crypto.randomUUID(),
  400,
);
await write(
  "/wealth/valuations",
  { ...body, asset_id: crypto.randomUUID() },
  crypto.randomUUID(),
  400,
);
const p = await write("/wealth/portfolios", {
  name: "API broker",
  opening_date: "2026-01-01",
  opening_cash: 10000,
});
const i = await write("/wealth/instruments", { name: "API fund" });
const trade = {
  portfolio_id: p.id,
  instrument_id: i.id,
  kind: "buy",
  date: "2026-01-03",
  amount: 2500,
  units: "1.25",
  fees: 25,
};
const tradeKey = crypto.randomUUID();
await write("/wealth/events", trade, tradeKey);
await write("/wealth/events", trade, tradeKey);
await write(
  "/wealth/events",
  { portfolio_id: p.id, kind: "withdrawal", date: "2026-01-02", amount: 8000 },
  crypto.randomUUID(),
  400,
);
await write(
  "/wealth/events",
  { ...trade, kind: "sell", units: "2" },
  crypto.randomUUID(),
  400,
);
await write(
  "/wealth/events",
  { ...trade, units: "-1" },
  crypto.randomUUID(),
  400,
);
await write(
  "/wealth/events",
  { ...trade, date: "2025-12-31" },
  crypto.randomUUID(),
  400,
);
let s = await read();
assert.equal(
  s.snapshot.portfolios.find((x: { id: string }) => x.id === p.id).value,
  null,
);
await write("/wealth/prices", {
  instrument_id: i.id,
  date: "2026-01-04",
  amount: 2101,
});
s = await read();
const result = s.snapshot.portfolios.find((x: { id: string }) => x.id === p.id);
assert.equal(result.cash, 7475);
assert.equal(result.value, 10101);
assert.equal(
  s.data.events.filter((e: { portfolio_id: string }) => e.portfolio_id === p.id)
    .length,
  1,
);
await Promise.all(
  Array.from({ length: 4 }, () => write("/wealth/events", trade, tradeKey)),
);
await write("/wealth/events", {
  ...trade,
  kind: "sell",
  date: "2026-01-05",
  amount: 1100,
  units: "0.5",
  fees: 10,
});
for (const [kind, amount] of [
  ["dividend", 100],
  ["fee", 20],
  ["deposit", 500],
  ["withdrawal", 200],
] as const)
  await write("/wealth/events", {
    portfolio_id: p.id,
    kind,
    date: "2026-01-06",
    amount,
  });
s = await read();
const final = s.snapshot.portfolios.find((x: { id: string }) => x.id === p.id);
assert.equal(final.cash, 8945);
assert.equal(final.holdings[0].units, "0.75");
assert.equal(final.value, 10521);
assert.equal(
  s.data.events.filter((e: { portfolio_id: string }) => e.portfolio_id === p.id)
    .length,
  6,
);
for (const units of ["1.0000001", "1000000000000"])
  await write("/wealth/events", { ...trade, units }, crypto.randomUUID(), 400);
await write(
  "/wealth/prices",
  { instrument_id: i.id, date: "2026-02-01", amount: -1 },
  crypto.randomUUID(),
  400,
);
await write("/wealth/prices", {
  instrument_id: i.id,
  date: "2026-02-01",
  amount: 0,
});
const zero = await (
  await fetch(base + "/api/wealth?date=2026-02-01", { headers })
).json();
assert.equal(
  zero.snapshot.portfolios.find((x: { id: string }) => x.id === p.id).value,
  8945,
);
const invalid = await write(
  "/wealth/valuations",
  { ...body, amount: 9007199254740992 },
  crypto.randomUUID(),
  400,
);
assert.match(invalid.error, /amount/);
const after = await (await fetch(base + "/api/state", { headers })).json();
assert.deepEqual(after.accounts, before.accounts);
assert.deepEqual(after.transactions, before.transactions);
assert.deepEqual(after.allocations, before.allocations);
assert.equal((await fetch(base + "/api/wealth?date=2026-01-31")).status, 401);
console.log(
  "PASS wealth API: ownership validation, exact values, idempotency, missing prices, backdated rollback, budget isolation",
);
