import test from "node:test";
import assert from "node:assert/strict";
// Runs against an already started dedicated test instance, never the production URL.
const base = process.env.TEST_API_URL;
const headers = {
  "Content-Type": "application/json",
  Origin: base || "",
  "X-Hermes-Verified-Email": "test@example.com",
};
test(
  "HTTP identity, setup, retry conflict, transaction and atomic import flow",
  { skip: !base },
  async () => {
    assert.equal((await fetch(base + "/api/state")).status, 401);
    assert.equal(
      (
        await fetch(base + "/api/state", {
          headers: { "X-Hermes-Verified-Email": "spoof@example.com" },
        })
      ).status,
      401,
    );
    const create = async (path: string, body: unknown, key = randomKey()) => {
      const r = await fetch(base + "/api" + path, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": key },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    };
    const setup = await create("/setup", {
      name: "Integration",
      currency: "EUR",
      timezone: "UTC",
      starting_funds: 100000,
    });
    assert.equal(setup.status, 200);
    const a = await create("/accounts", {
      name: "Bank",
      type: "checking",
      opening_date: "2026-01-01",
      opening_balance: 100000,
    });
    assert.equal(a.status, 200);
    const cat = await create("/categories", { name: "Food", rollover: true });
    const payload = {
      kind: "expense",
      date: "2026-01-05",
      payee: "Shop",
      amount: 1250,
      account_id: a.body.id,
      splits: [{ category_id: cat.body.id, amount: 1250 }],
    };
    const key = randomKey();
    const first = await create("/transactions", payload, key);
    assert.equal(first.status, 200);
    assert.deepEqual(await create("/transactions", payload, key), first);
    const race = await Promise.all(
      Array.from({ length: 4 }, () => create("/transactions", payload, key)),
    );
    for (const replay of race) assert.deepEqual(replay, first);

    assert.equal(
      (await create("/transactions", { ...payload, payee: "Changed" }, key))
        .status,
      409,
    );
    const profile = await create("/profiles", {
      name: "Bank",
      config: {
        date: "Date",
        payee: "Payee",
        amount: "Amount",
        external: "ID",
        source: "bank",
        category: cat.body.id,
      },
    });
    const file = {
      account_id: a.body.id,
      profile_id: profile.body.id,
      filename: "bank.csv",
      csv: "Date,Payee,Amount,ID\n2026-01-06,Other,-10,stable-1\n2026-01-05,Shop,-12.50,",
    };
    const preview = await create("/imports/preview", file);
    const detail = await (
      await fetch(base + "/api/imports/" + preview.body.id, { headers })
    ).json();
    assert.equal(detail.rows[1].duplicate, "probable");
    const decisions = detail.rows.map((r: any) => ({
      row_number: r.row_number,
      decision: "accept",
    }));
    assert.equal(
      (await create("/imports/" + preview.body.id + "/commit", { decisions }))
        .status,
      400,
    );
    const stateAfterFailure = await (
      await fetch(base + "/api/state", { headers })
    ).json();
    assert.equal(
      stateAfterFailure.transactions.length,
      1,
      "failed commit leaves zero partial rows",
    );
    decisions[1].decision = "not_duplicate";
    assert.equal(
      (await create("/imports/" + preview.body.id + "/commit", { decisions }))
        .status,
      200,
    );
    const repeated = await create("/imports/preview", file);
    assert.equal(repeated.body.id, preview.body.id);
    assert.equal(repeated.body.repeated, true);
    const state = await (await fetch(base + "/api/state", { headers })).json();
    assert.equal(state.transactions.length, 3);
    assert.equal(
      (
        await create("/transactions", {
          ...payload,
          splits: [{ category_id: cat.body.id, amount: 1249 }],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(base + "/api/accounts", {
          method: "POST",
          headers: {
            ...headers,
            Origin: "https://evil.example",
            "Idempotency-Key": randomKey(),
          },
          body: "{}",
        })
      ).status,
      403,
    );
  },
);
function randomKey() {
  return crypto.randomUUID();
}
