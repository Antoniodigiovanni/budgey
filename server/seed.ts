import { pool } from "./db.js";
import { post } from "./ledger.js";
// Never seeds an existing household, never allowed in production, and requires explicit opt-in.
if (
  process.env.APP_ENV !== "development" ||
  process.env.SEED_DEMO !== "yes" ||
  !process.env.DEV_IDENTITY
)
  throw Error("Requires APP_ENV=development, DEV_IDENTITY and SEED_DEMO=yes");
const c = await pool.connect();
try {
  await c.query("BEGIN");
  const actor = process.env.DEV_IDENTITY.toLowerCase();
  const h = (
    await c.query(
      "INSERT INTO households(owner,name,currency,timezone,starting_funds,demo) VALUES($1,'Demo household','EUR','Europe/Rome',320000,true) RETURNING id",
      [actor],
    )
  ).rows[0].id;
  const year = new Date().getFullYear();
  const month = `${year}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
  const account = (
    await c.query(
      "INSERT INTO accounts(household_id,name,type,opening_date,opening_balance) VALUES($1,'Everyday account','checking',$2,320000) RETURNING id",
      [h, `${year}-01-01`],
    )
  ).rows[0].id;
  await c.query(
    "INSERT INTO accounts(household_id,name,type,opening_date,opening_balance) VALUES($1,'Rainy day fund','savings',$2,150000),($1,'Everyday card','credit',$2,-24500)",
    [h, `${year}-01-01`],
  );
  for (const [name, target, allocation, expense] of [
    ["Home & bills", 1800000, 150000, 82500],
    ["Groceries", 480000, 40000, 15280],
    ["Little joys", 180000, 15000, 4250],
    ["Travel & adventures", 240000, 20000, 0],
    ["Health & wellbeing", 120000, 10000, 3280],
  ] as const) {
    const cat = (
      await c.query(
        "INSERT INTO categories(household_id,name,rollover) VALUES($1,$2,true) RETURNING id",
        [h, name],
      )
    ).rows[0].id;
    await c.query(
      "INSERT INTO targets(household_id,category_id,year,amount) VALUES($1,$2,$3,$4)",
      [h, cat, year, target],
    );
    await c.query(
      "INSERT INTO allocations(household_id,category_id,month,amount) VALUES($1,$2,$3,$4)",
      [h, cat, month + "-01", allocation],
    );
    if (expense)
      await post(
        c,
        h,
        actor,
        {
          kind: "expense",
          date: month + "-02",
          payee:
            name === "Groceries"
              ? "The corner market"
              : name === "Little joys"
                ? "Sunday coffee"
                : name === "Home & bills"
                  ? "Home, sweet home"
                  : "Pharmacy",
          account_id: account,
          amount: expense,
          splits: [{ category_id: cat, amount: expense }],
        },
        "demo",
      );
  }
  await c.query("COMMIT");
  console.log(
    "Created explicitly labeled DEMO household. Never use this database for production.",
  );
} catch (e) {
  await c.query("ROLLBACK");
  throw e;
} finally {
  c.release();
  await pool.end();
}
