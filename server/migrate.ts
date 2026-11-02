import { pool } from "./db.js";
import { readdir, readFile } from "node:fs/promises";
const c = await pool.connect();
try {
  await c.query("BEGIN");
  await c.query("SELECT pg_advisory_xact_lock(712991)");
  await c.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz DEFAULT now())",
  );
  for (const f of (await readdir("migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    if (
      !(await c.query("SELECT 1 FROM schema_migrations WHERE name=$1", [f]))
        .rowCount
    ) {
      await c.query(await readFile("migrations/" + f, "utf8"));
      await c.query("INSERT INTO schema_migrations(name) VALUES($1)", [f]);
      console.log("Applied", f);
    }
  }
  await c.query("COMMIT");
} catch (e) {
  await c.query("ROLLBACK");
  throw e;
} finally {
  c.release();
  await pool.end();
}
