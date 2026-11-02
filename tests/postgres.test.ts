import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
// Opt in only against a database on which creating an isolated test schema is permitted.
test(
  "PostgreSQL constraints, atomic rollback, stable IDs and retry concurrency",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    const c = await pool.connect();
    const schema = "test_" + randomUUID().replaceAll("-", "");
    try {
      await c.query(`CREATE SCHEMA ${schema}`);
      await c.query(`SET search_path TO ${schema}, public`);
      for (const f of (await readdir("migrations")).sort())
        await c.query(await readFile("migrations/" + f, "utf8"));
      const h = (
        await c.query(
          "INSERT INTO households(owner,name,currency,timezone) VALUES('test@example.com','Test','EUR','UTC') RETURNING id",
        )
      ).rows[0].id;
      const h2 = (
        await c.query(
          "INSERT INTO households(owner,name,currency,timezone) VALUES('other@example.com','Other','EUR','UTC') RETURNING id",
        )
      ).rows[0].id;
      const a = (
        await c.query(
          "INSERT INTO accounts(household_id,name,type,opening_date,opening_balance) VALUES($1,'Cash','checking','2026-01-01',0),($1,'Card','credit','2026-01-01',0) RETURNING id",
          [h],
        )
      ).rows;
      const cat = (
        await c.query(
          "INSERT INTO categories(household_id,name) VALUES($1,'Food') RETURNING id",
          [h],
        )
      ).rows[0].id;
      const transaction = async (
        kind: string,
        amount: number,
        external: string | null,
        split = amount,
        destination?: string,
      ) => {
        await c.query("BEGIN");
        try {
          const t = (
            await c.query(
              "INSERT INTO transactions(household_id,kind,date,payee,amount,source,external_id,source_account) VALUES($1,$2,'2026-01-03','Shop',$3,'bank',$4,$5) RETURNING id",
              [h, kind, amount, external, a[0].id],
            )
          ).rows[0].id;
          await c.query("INSERT INTO entries VALUES($1,$2,$3,$4)", [
            h,
            t,
            a[0].id,
            kind === "expense" || kind === "transfer" ? -amount : amount,
          ]);
          if (destination)
            await c.query("INSERT INTO entries VALUES($1,$2,$3,$4)", [
              h,
              t,
              destination,
              amount,
            ]);
          if (["expense", "refund"].includes(kind))
            await c.query("INSERT INTO splits VALUES($1,$2,$3,$4)", [
              h,
              t,
              cat,
              split,
            ]);
          await c.query("COMMIT");
          return t;
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        }
      };
      await transaction("expense", 100, "stable-1");
      await assert.rejects(() => transaction("expense", 100, "stable-1"), {
        code: "23505",
      });
      await assert.rejects(
        () => transaction("expense", 100, "invalid-split", 99),
        { code: "23514" },
      );
      assert.equal(
        (await c.query("SELECT count(*) FROM transactions")).rows[0].count,
        "1",
      );
      await transaction("transfer", 100, null, 0, a[1].id);
      assert.equal(
        (
          await c.query(
            "SELECT sum(e.amount) AS sum FROM entries e JOIN transactions t ON t.id=e.transaction_id WHERE t.kind='transfer'",
          )
        ).rows[0].sum,
        "0",
      );
      await assert.rejects(() => transaction("transfer", 100, null), {
        code: "23514",
      });
      await assert.rejects(
        () =>
          c.query(
            "INSERT INTO allocations(household_id,category_id,month,amount) VALUES($1,$2,'2026-01-01',1)",
            [h2, cat],
          ),
        { code: "23503" },
      );
      await transaction("expense", 100, null);
      await transaction("expense", 100, null);
      assert.equal(
        (await c.query("SELECT count(*) FROM transactions")).rows[0].count,
        "4",
        "heuristic duplicates are permitted",
      );
      await assert.rejects(() => c.query("UPDATE entries SET amount=1"), {
        code: "23514",
      });
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO ${schema}, public`);
        await c.query("BEGIN");
        await c.query(
          "INSERT INTO idempotency VALUES($1,'test','retry-key','hash',NULL,now())",
          [h],
        );
        const concurrent = client.query(
          "INSERT INTO idempotency VALUES($1,'test','retry-key','hash',NULL,now()) ON CONFLICT DO NOTHING",
          [h],
        );
        await c.query(
          "UPDATE idempotency SET response='{\"id\":1}' WHERE household_id=$1",
          [h],
        );
        await c.query("COMMIT");
        await concurrent;
        assert.equal(
          (await client.query("SELECT count(*) FROM idempotency")).rows[0]
            .count,
          "1",
        );
        assert.deepEqual(
          (await client.query("SELECT response FROM idempotency")).rows[0]
            .response,
          { id: 1 },
        );
      } finally {
        client.release();
      }
    } finally {
      await c.query("ROLLBACK");
      await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      c.release();
      await pool.end();
    }
  },
);
