import "dotenv/config";
import { pool } from "../server/db.js";
import { createWealth } from "../server/wealth.js";
if (
  process.env.APP_ENV === "production" ||
  process.env.WEALTH_DEMO_SEED !== "yes" ||
  !process.env.DEMO_OWNER
)
  throw Error(
    "Require nonproduction APP_ENV, WEALTH_DEMO_SEED=yes and DEMO_OWNER",
  );
const c = await pool.connect();
try {
  await c.query("BEGIN");
  const h = (
    await c.query("SELECT id FROM households WHERE owner=$1 AND demo=true", [
      process.env.DEMO_OWNER,
    ])
  ).rows[0]?.id;
  if (!h) throw Error("An existing fictional demo household is required");
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    process.env.DEMO_OWNER,
  ]);
  const operation = "seed-wealth-demo-v1";
  const prior = await c.query(
    "SELECT 1 FROM idempotency WHERE household_id=$1 AND operation=$2 AND key=$2",
    [h, operation],
  );
  if (prior.rowCount) {
    await c.query("COMMIT");
    console.log("Fictional wealth seed already applied");
  } else {
    const actor = process.env.DEMO_OWNER;
    const day = (offset: number) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + offset);
      return d.toISOString().slice(0, 10);
    };
    const asset = await createWealth(c, h, actor, "assets", {
      name: "Fictional home",
      kind: "property",
    });
    const debt = await createWealth(c, h, actor, "assets", {
      name: "Fictional mortgage",
      kind: "mortgage",
    });
    for (const [asset_id, amount] of [
      [asset.id, 28500000],
      [debt.id, 14500000],
    ] as const) {
      await createWealth(c, h, actor, "valuations", {
        asset_id,
        date: day(-120),
        amount,
      });
      await createWealth(c, h, actor, "valuations", {
        asset_id,
        date: day(-2),
        amount: amount + (asset_id === asset.id ? 500000 : -100000),
      });
    }
    const p = await createWealth(c, h, actor, "portfolios", {
      name: "Fictional investments",
      opening_date: day(-120),
      opening_cash: 100000,
    });
    const i = await createWealth(c, h, actor, "instruments", {
      name: "Fictional broad market fund",
    });
    for (const [offset, amount] of [
      [-110, 10000],
      [-60, 11000],
      [-2, 12000],
    ])
      await createWealth(c, h, actor, "prices", {
        instrument_id: i.id,
        date: day(offset),
        amount,
      });
    const events = [
      { kind: "deposit", date: day(-115), amount: 50000 },
      {
        kind: "buy",
        date: day(-110),
        amount: 25000,
        units: "2.5",
        instrument_id: i.id,
        fees: 100,
      },
      {
        kind: "sell",
        date: day(-60),
        amount: 5500,
        units: "0.5",
        instrument_id: i.id,
        fees: 50,
      },
      { kind: "dividend", date: day(-30), amount: 300 },
      { kind: "fee", date: day(-20), amount: 100 },
      { kind: "withdrawal", date: day(-10), amount: 10000 },
    ];
    for (const e of events)
      await createWealth(c, h, actor, "events", { portfolio_id: p.id, ...e });
    await c.query(
      "INSERT INTO idempotency(household_id,operation,key,hash,response) VALUES($1,$2,$2,$2,$3)",
      [h, operation, JSON.stringify({ ok: true })],
    );
    await c.query("COMMIT");
    console.log("Fictional wealth seed applied");
  }
} catch (e) {
  await c.query("ROLLBACK");
  throw e;
} finally {
  c.release();
  await pool.end();
}
