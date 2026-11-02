import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createWealth, wealthState } from "../server/wealth.js";
import { calculate } from "../src/budget.js";
test(
  "wealth persistence, ownership, immutable records, audit and rollback",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const { default: pg } = await import("pg");
    pg.types.setTypeParser(20, (v) => Number(v));
    pg.types.setTypeParser(1082, (v) => v);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    const c = await pool.connect();
    const schema = "wealth_" + randomUUID().replaceAll("-", "");
    try {
      await c.query(`CREATE SCHEMA ${schema}`);
      await c.query(`SET search_path TO ${schema},public`);
      for (const f of (await readdir("migrations"))
        .filter((f) => f.endsWith(".sql"))
        .sort())
        await c.query(await readFile("migrations/" + f, "utf8"));
      const h = (
        await c.query(
          "INSERT INTO households(owner,name,currency,timezone) VALUES('wealth@example.com','Test','GBP','UTC'),('other@example.com','Other','GBP','UTC') RETURNING id",
        )
      ).rows;
      const write = async (
        resource: Parameters<typeof createWealth>[3],
        body: unknown,
      ) => {
        await c.query("BEGIN");
        try {
          const r = await createWealth(
            c,
            h[0].id,
            "wealth@example.com",
            resource,
            body,
          );
          await c.query("COMMIT");
          return r;
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        }
      };
      const budget = {
        household: { starting_funds: 4000 },
        categories: [],
        targets: [],
        allocations: [],
        transactions: [],
      };
      const before = calculate(budget, "2026-01");
      const a = await write("assets", { name: "House", kind: "property" });
      await write("valuations", {
        asset_id: a.id,
        date: "2026-01-01",
        amount: 200000,
      });
      const p = await write("portfolios", {
        name: "Broker",
        opening_date: "2026-01-01",
        opening_cash: 10000,
      });
      const i = await write("instruments", { name: "Fund" });
      await write("events", {
        portfolio_id: p.id,
        instrument_id: i.id,
        kind: "buy",
        date: "2026-01-03",
        amount: 2500,
        units: "1.25",
        fees: 25,
      });
      await write("prices", {
        instrument_id: i.id,
        date: "2026-01-04",
        amount: 2101,
      });
      const state = await wealthState(c, h[0].id, "2026-01-31");
      assert.equal(state.snapshot.knownNetWorth, 210101);
      assert.deepEqual(calculate(budget, "2026-01"), before);
      await assert.rejects(
        () =>
          write("events", {
            portfolio_id: p.id,
            kind: "withdrawal",
            date: "2026-01-02",
            amount: 8000,
          }),
        /cash/,
      );
      assert.equal(
        (await c.query("SELECT count(*)::int AS n FROM wealth_events")).rows[0]
          .n,
        1,
      );
      await assert.rejects(
        () =>
          createWealth(c, h[1].id, "other@example.com", "valuations", {
            asset_id: a.id,
            date: "2026-01-02",
            amount: 1,
          }),
        /household/,
      );
      assert.equal(
        (await wealthState(c, h[1].id, "2026-01-31")).snapshot.rows.length,
        0,
      );
      await assert.rejects(
        () => c.query("UPDATE wealth_valuations SET amount=1"),
        /Immutable/,
      );
      await assert.rejects(
        () => c.query("DELETE FROM wealth_events"),
        /Immutable/,
      );
      await assert.rejects(
        () =>
          c.query(
            "INSERT INTO wealth_prices(household_id,instrument_id,date,amount) VALUES($1,$2,'2026-01-01',1)",
            [h[1].id, i.id],
          ),
        /foreign key/,
      );
      await assert.rejects(
        () =>
          c.query(
            "INSERT INTO wealth_events(household_id,portfolio_id,kind,date,amount) VALUES($1,$2,'deposit','2026-01-01',-1)",
            [h[0].id, p.id],
          ),
        /check constraint/,
      );
      assert.equal(
        (await c.query("SELECT count(*)::int AS n FROM audit")).rows[0].n,
        6,
      );
    } finally {
      await c.query("ROLLBACK");
      await c.query("SET search_path TO public");
      await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      c.release();
      await pool.end();
    }
  },
);

test(
  "direct database event inserts enforce full cash and unit timelines",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    const c = await pool.connect();
    const schema = "wealth_guards_" + randomUUID().replaceAll("-", "");
    try {
      await c.query(`CREATE SCHEMA ${schema}`);
      await c.query(`SET search_path TO ${schema},public`);
      for (const f of (await readdir("migrations"))
        .filter((x) => x.endsWith(".sql"))
        .sort())
        await c.query(await readFile("migrations/" + f, "utf8"));
      const h = (
        await c.query(
          "INSERT INTO households(owner,name,currency,timezone) VALUES('guards@example.com','Guards','EUR','UTC') RETURNING id",
        )
      ).rows[0].id;
      const p = (
        await c.query(
          "INSERT INTO wealth_portfolios(household_id,name,opening_date,opening_cash) VALUES($1,'Broker','2026-01-01',100) RETURNING id",
          [h],
        )
      ).rows[0].id;
      const i = (
        await c.query(
          "INSERT INTO wealth_instruments(household_id,name) VALUES($1,'Fund') RETURNING id",
          [h],
        )
      ).rows[0].id;
      await assert.rejects(
        () =>
          c.query(
            "INSERT INTO wealth_events(household_id,portfolio_id,kind,date,amount) VALUES($1,$2,'withdrawal','2026-01-02',101)",
            [h, p],
          ),
        /cash timeline/,
      );
      await assert.rejects(
        () =>
          c.query(
            "INSERT INTO wealth_events(household_id,portfolio_id,kind,date,amount) VALUES($1,$2,'deposit','2025-12-31',1)",
            [h, p],
          ),
        /opening/,
      );
      await assert.rejects(
        () =>
          c.query(
            "INSERT INTO wealth_events(household_id,portfolio_id,instrument_id,kind,date,amount,units) VALUES($1,$2,$3,'sell','2026-01-02',10,'1')",
            [h, p, i],
          ),
        /units timeline/,
      );
      assert.equal(
        (await c.query("SELECT count(*)::int AS n FROM wealth_events")).rows[0]
          .n,
        0,
      );
    } finally {
      await c.query("ROLLBACK");
      await c.query("SET search_path TO public");
      await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      c.release();
      await pool.end();
    }
  },
);
