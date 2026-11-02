// This workflow creates and drops only its own schema in the disposable wealth database.
import pg from "pg";
import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
const database =
  "postgresql:///budgey_wealth_test?host=/home/hermes/workspace/budgey-demo/socket&port=55432&user=hermes";
const pool = new pg.Pool({ connectionString: database });
const schema = "acceptance_wealth_" + Date.now();
const url = new URL(database);
url.searchParams.set("options", "-csearch_path=" + schema);
const env = {
  ...process.env,
  DATABASE_URL: url.toString(),
  TEST_DATABASE_URL: database,
  TEST_API_URL: "http://127.0.0.1:3102",
  APP_ENV: "test",
  PUBLIC_ORIGIN: "http://127.0.0.1:3102",
  PORT: "3102",
  ALLOWED_EMAIL: "test@example.com",
  TRUSTED_IDENTITY_HEADER: "x-hermes-verified-email",
};
delete env.DEV_IDENTITY;
await mkdir("docs/evidence", { recursive: true });
async function run(command, args, name, extra = {}) {
  const log = await open("docs/evidence/" + name + ".log", "w");
  try {
    await new Promise((resolve, reject) => {
      const p = spawn(command, args, {
        env: { ...env, ...extra },
        stdio: ["ignore", log.fd, log.fd],
      });
      p.on("error", reject);
      p.on("exit", (code) =>
        code === 0 ? resolve() : reject(Error(name + " failed: " + code)),
      );
    });
    console.log("PASS " + name);
  } finally {
    await log.close();
  }
}
let server;
let serverLog;
try {
  await pool.query(`CREATE SCHEMA ${schema}`);
  await run("npm", ["run", "migrate"], "wealth-host-migrate");
  let occupied = false;
  try {
    await fetch(env.PUBLIC_ORIGIN + "/healthz", {
      signal: AbortSignal.timeout(1000),
    });
    occupied = true;
  } catch {}
  if (occupied)
    throw Error(
      "Port 3102 is already serving HTTP; refusing to run tests against it",
    );
  serverLog = await open("docs/evidence/wealth-host-server.log", "w");
  server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    env,
    stdio: ["ignore", serverLog.fd, serverLog.fd],
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw Error("Test server exited");
    try {
      const r = await fetch(env.PUBLIC_ORIGIN + "/readyz");
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) throw Error("Test server did not become ready");
  await run("npm", ["test"], "wealth-host-all-tests");
  await run("npm", ["run", "test:wealth:api"], "wealth-host-api");
  const c = await pool.connect();
  try {
    await c.query(`SET search_path TO ${schema}`);
    await c.query(
      "UPDATE households SET demo=true WHERE owner='test@example.com'",
    );
  } finally {
    c.release();
  }
  await run("npm", ["run", "seed:wealth"], "wealth-host-seed", {
    WEALTH_DEMO_SEED: "yes",
    DEMO_OWNER: "test@example.com",
  });
  const seededResponse = await fetch(
    env.PUBLIC_ORIGIN +
      "/api/wealth?date=" +
      new Date().toISOString().slice(0, 10),
    { headers: { "X-Hermes-Verified-Email": "test@example.com" } },
  );
  if (!seededResponse.ok) throw Error("Seed readback failed");
  const seeded = await seededResponse.json();
  const fictional = seeded.snapshot.portfolios.find(
    (p) => p.name === "Fictional investments",
  );
  if (fictional?.cash !== 120550 || fictional?.value !== 144550)
    throw Error("Seed exact portfolio values differ");
  const counts = async () => {
    const c = await pool.connect();
    try {
      await c.query(`SET search_path TO ${schema}`);
      return (
        await c.query(
          "SELECT (SELECT count(*) FROM wealth_assets) AS assets,(SELECT count(*) FROM wealth_events) AS events,(SELECT count(*) FROM audit) AS audit",
        )
      ).rows[0];
    } finally {
      c.release();
    }
  };
  const before = await counts();
  await run("npm", ["run", "seed:wealth"], "wealth-host-seed-replay", {
    WEALTH_DEMO_SEED: "yes",
    DEMO_OWNER: "test@example.com",
  });
  if (JSON.stringify(await counts()) !== JSON.stringify(before))
    throw Error("Seed replay added records");
  await run("npm", ["run", "test:wealth:browser"], "wealth-host-browser");
  console.log(
    "All host acceptance checks passed; screenshots and logs are in docs/evidence.",
  );
} finally {
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once("exit", r));
    server.kill("SIGTERM");
    await exited;
  }
  await serverLog?.close();
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.end();
}
