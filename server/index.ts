import { createWealth, wealthState, wealthResources } from "./wealth.js";
import { csvCell } from "./export.js";
import "dotenv/config";
import express from "express";
import { z } from "zod";
import { randomUUID, createHash } from "node:crypto";
import { pool } from "./db.js";
import { identity, validateConfig, hash, InputError } from "./domain.js";
import { post, audit, minor, date } from "./ledger.js";
import { mappingSchema, parseImport } from "./imports.js";
import type { PoolClient } from "pg";
validateConfig(process.env);
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", false);
app.use((_req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'",
  });
  next();
});
app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
app.get("/readyz", async (_req, res) => {
  try {
    const r = await pool.query(
      "SELECT name FROM schema_migrations WHERE name='003_wealth.sql'",
    );
    if (!r.rowCount) throw Error("Migration pending");
    res.json({ status: "ready" });
  } catch {
    res.status(503).json({ status: "unavailable" });
  }
});
app.use((req, res, next) => {
  if (req.path === "/sw.js") res.set("Cache-Control", "no-cache");
  else res.set("Cache-Control", "no-store");
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    req.headers.origin !== process.env.PUBLIC_ORIGIN
  ) {
    res.status(403).json({ error: "Origin rejected" });
    return;
  }
  const email = identity(
    process.env,
    req.headers[
      process.env.TRUSTED_IDENTITY_HEADER?.toLowerCase() ||
        "x-hermes-verified-email"
    ],
  );
  if (!email) {
    res.status(401).json({ error: "Trusted identity required" });
    return;
  }
  res.locals.actor = email;
  next();
});
const rate = new Map<string, { count: number; until: number }>();
app.use("/api", (req, res, next) => {
  const actor = res.locals.actor as string;
  const now = Date.now();
  let bucket = rate.get(actor);
  if (!bucket || bucket.until < now) {
    bucket = { count: 0, until: now + 60000 };
    rate.set(actor, bucket);
  }
  if (++bucket.count > 180) {
    res
      .set("Retry-After", "60")
      .status(429)
      .json({ error: "Too many requests; try again in a minute" });
    return;
  }
  next();
});
app.use(express.json({ limit: "2mb" }));
app.use("/api", async (_req, res, next) => {
  try {
    const h = await pool.query("SELECT * FROM households WHERE owner=$1", [
      res.locals.actor,
    ]);
    if (process.env.APP_ENV === "production" && h.rows[0]?.demo) {
      res.status(503).json({
        error:
          "Demo households cannot run in production. Use a clean production database.",
      });
      return;
    }
    res.locals.household = h.rows[0];
    next();
  } catch (e) {
    next(e);
  }
});
const requireHousehold: express.RequestHandler = (_req, res, next) => {
  if (!res.locals.household) {
    res.status(409).json({ error: "Create your household first" });
    return;
  }
  next();
};
async function write(
  req: express.Request,
  res: express.Response,
  fn: (c: PoolClient, h: string) => Promise<unknown>,
  setup = false,
) {
  const key = z.string().min(8).max(200).parse(req.headers["idempotency-key"]);
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body))
    throw new InputError("JSON object body required");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      res.locals.actor,
    ]);
    let h = res.locals.household?.id;
    if (setup && !h) {
      const b = z
        .object({
          name: z.string().trim().min(1).max(100),
          currency: z.enum(["EUR", "USD", "GBP", "CHF", "CAD", "AUD"]),
          timezone: z.string().refine((v) => {
            try {
              new Intl.DateTimeFormat("en", { timeZone: v });
              return true;
            } catch {
              return false;
            }
          }),
          starting_funds: minor.default(0),
        })
        .parse(req.body);
      const r = await c.query(
        "INSERT INTO households(owner,name,currency,timezone,starting_funds) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner) DO NOTHING RETURNING *",
        [res.locals.actor, b.name, b.currency, b.timezone, b.starting_funds],
      );
      h =
        r.rows[0]?.id ||
        (
          await c.query("SELECT id FROM households WHERE owner=$1", [
            res.locals.actor,
          ])
        ).rows[0].id;
    }
    if (!h) throw new InputError("Household missing");
    const operation = req.method + ":" + req.path;
    const payload = hash(req.body);
    await c.query(
      "INSERT INTO idempotency(household_id,operation,key,hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [h, operation, key, payload],
    );
    const {
      rows: [record],
    } = await c.query(
      "SELECT * FROM idempotency WHERE household_id=$1 AND operation=$2 AND key=$3 FOR UPDATE",
      [h, operation, key],
    );
    if (record.hash !== payload) {
      await c.query("ROLLBACK");
      res
        .status(409)
        .json({ error: "Idempotency key reused with different payload" });
      return;
    }
    if (record.response) {
      await c.query("COMMIT");
      res.set("Idempotency-Replayed", "true").json(record.response);
      return;
    }
    const result = await fn(c, h);
    await c.query(
      "UPDATE idempotency SET response=$4 WHERE household_id=$1 AND operation=$2 AND key=$3",
      [h, operation, key, JSON.stringify(result)],
    );
    await c.query("COMMIT");
    res.json(result);
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
app.post("/api/setup", async (req, res) =>
  write(
    req,
    res,
    async (c, h) => {
      await audit(c, h, res.locals.actor, "setup", "household", {});
      return { id: h };
    },
    true,
  ),
);
app.get("/api/state", async (_req, res) => {
  const h = res.locals.household;
  if (!h) {
    res.json({ household: null });
    return;
  }
  const queries = [
    [
      "accounts",
      `SELECT a.*, (a.opening_balance+COALESCE((SELECT sum(e.amount) FROM entries e JOIN transactions t ON t.id=e.transaction_id WHERE e.account_id=a.id AND e.household_id=$1 AND NOT t.voided),0))::bigint AS balance FROM accounts a WHERE a.household_id=$1 ORDER BY a.archived,a.name`,
    ],
    [
      "categories",
      "SELECT * FROM categories WHERE household_id=$1 ORDER BY name",
    ],
    ["targets", "SELECT * FROM targets WHERE household_id=$1"],
    ["allocations", "SELECT * FROM allocations WHERE household_id=$1"],
    [
      "transactions",
      `SELECT t.*,a.name AS account_name,COALESCE((SELECT jsonb_agg(jsonb_build_object('category_id',s.category_id,'amount',s.amount,'name',c.name)) FROM splits s JOIN categories c ON c.id=s.category_id WHERE s.transaction_id=t.id),'[]') AS splits FROM transactions t JOIN accounts a ON a.id=t.source_account WHERE t.household_id=$1 ORDER BY date DESC,created_at DESC`,
    ],
    ["profiles", "SELECT * FROM profiles WHERE household_id=$1 ORDER BY name"],
    [
      "batches",
      "SELECT b.id,b.filename,b.status,b.created_at,b.completed_at,b.account_id,(SELECT count(*)::int FROM import_rows r WHERE r.batch_id=b.id) AS row_count,(SELECT count(*)::int FROM import_rows r WHERE r.batch_id=b.id AND r.transaction_id IS NOT NULL) AS accepted_count FROM batches b WHERE b.household_id=$1 ORDER BY b.created_at DESC",
    ],
    [
      "reconciliations",
      "SELECT * FROM reconciliations WHERE household_id=$1 ORDER BY created_at DESC",
    ],
  ];
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: h.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (key: string) => parts.find((p) => p.type === key)!.value;
  const result: any = {
    household: h,
    today: `${part("year")}-${part("month")}-${part("day")}`,
  };
  const c = await pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    for (const [key, query] of queries)
      result[key] = (await c.query(query, [h.id])).rows;
    await c.query("COMMIT");
    res.json(result);
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
});
app.use("/api", requireHousehold);
app.get("/api/wealth", async (req, res) => {
  const c = await pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await wealthState(
      c,
      res.locals.household.id,
      req.query.date,
    );
    await c.query("COMMIT");
    res.json(result);
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
});
for (const resource of wealthResources)
  app.post("/api/wealth/" + resource, async (req, res) =>
    write(req, res, (c, h) =>
      createWealth(c, h, res.locals.actor, resource, req.body),
    ),
  );
app.post("/api/accounts", async (req, res) =>
  write(req, res, async (c, h) => {
    const b = z
      .object({
        name: z.string().trim().min(1).max(100),
        type: z.enum(["checking", "savings", "cash", "credit"]),
        opening_date: date,
        opening_balance: minor,
      })
      .parse(req.body);
    const r = await c.query(
      "INSERT INTO accounts(household_id,name,type,opening_date,opening_balance) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [h, b.name, b.type, b.opening_date, b.opening_balance],
    );
    await audit(c, h, res.locals.actor, "create", "account:" + r.rows[0].id, b);
    return r.rows[0];
  }),
);
app.post("/api/categories", async (req, res) =>
  write(req, res, async (c, h) => {
    const b = z
      .object({
        name: z.string().trim().min(1).max(100),
        rollover: z.boolean(),
      })
      .parse(req.body);
    const r = await c.query(
      "INSERT INTO categories(household_id,name,rollover) VALUES($1,$2,$3) RETURNING *",
      [h, b.name, b.rollover],
    );
    await audit(
      c,
      h,
      res.locals.actor,
      "create",
      "category:" + r.rows[0].id,
      b,
    );
    return r.rows[0];
  }),
);
for (const entity of ["accounts", "categories"] as const) {
  app.post("/api/" + entity + "/:id/settings", async (req, res) =>
    write(req, res, async (c, h) => {
      const id = z.string().uuid().parse(req.params.id);
      const b = z
        .object({
          name: z.string().trim().min(1).max(100),
          archived: z.boolean(),
        })
        .parse(req.body);
      const before = (
        await c.query(
          `SELECT * FROM ${entity} WHERE household_id=$1 AND id=$2 FOR UPDATE`,
          [h, id],
        )
      ).rows[0];
      if (!before) throw new InputError("Record missing");
      await c.query(
        `UPDATE ${entity} SET name=$3,archived=$4 WHERE household_id=$1 AND id=$2`,
        [h, id, b.name, b.archived],
      );
      await audit(
        c,
        h,
        res.locals.actor,
        "update-settings",
        entity + ":" + id,
        { before, after: b },
      );
      return { ok: true };
    }),
  );
}
app.post("/api/targets", async (req, res) =>
  write(req, res, async (c, h) => {
    const b = z
      .object({
        category_id: z.string().uuid(),
        year: z.number().int().min(2000).max(2200),
        amount: minor.nonnegative(),
      })
      .parse(req.body);
    const before = (
      await c.query(
        "SELECT * FROM targets WHERE household_id=$1 AND category_id=$2 AND year=$3",
        [h, b.category_id, b.year],
      )
    ).rows;
    await c.query(
      "INSERT INTO targets(household_id,category_id,year,amount) VALUES($1,$2,$3,$4) ON CONFLICT(household_id,category_id,year) DO UPDATE SET amount=EXCLUDED.amount",
      [h, b.category_id, b.year, b.amount],
    );
    await audit(c, h, res.locals.actor, "set-target", b.category_id, {
      before,
      after: b,
    });
    return { ok: true };
  }),
);
app.post("/api/allocations", async (req, res) =>
  write(req, res, async (c, h) => {
    const b = z
      .object({
        category_id: z.string().uuid(),
        month: date.refine((v) => v.endsWith("-01")),
        amount: minor,
      })
      .parse(req.body);
    await c.query(
      "INSERT INTO allocations(household_id,category_id,month,amount) VALUES($1,$2,$3,$4)",
      [h, b.category_id, b.month, b.amount],
    );
    await audit(c, h, res.locals.actor, "allocate", b.category_id, b);
    return { ok: true };
  }),
);
app.post("/api/transactions", async (req, res) =>
  write(req, res, (c, h) => post(c, h, res.locals.actor, req.body)),
);
app.post("/api/transactions/:id/void", async (req, res) =>
  write(req, res, async (c, h) => {
    const id = z.string().uuid().parse(req.params.id);
    const b = z
      .object({ reason: z.string().trim().min(3).max(500) })
      .parse(req.body);
    const t = await c.query(
      "SELECT * FROM transactions WHERE household_id=$1 AND id=$2 FOR UPDATE",
      [h, id],
    );
    if (!t.rowCount) throw new InputError("Transaction missing");
    const rec = await c.query(
      "SELECT 1 FROM reconciliations WHERE household_id=$1 AND account_id IN (SELECT account_id FROM entries WHERE transaction_id=$2) AND date >= $3 AND difference=0",
      [h, id, t.rows[0].date],
    );
    if (rec.rowCount)
      throw new InputError(
        "Reconciled records require an explicit reversing transaction",
      );
    await c.query(
      "UPDATE transactions SET voided=true WHERE household_id=$1 AND id=$2",
      [h, id],
    );
    await audit(c, h, res.locals.actor, "void", id, {
      before: t.rows[0],
      reason: b.reason,
    });
    return { ok: true };
  }),
);
app.post("/api/reconciliations", async (req, res) =>
  write(req, res, async (c, h) => {
    const b = z
      .object({ account_id: z.string().uuid(), date, statement: minor })
      .parse(req.body);
    const {
      rows: [a],
    } = await c.query(
      "SELECT * FROM accounts WHERE household_id=$1 AND id=$2 AND opening_date<=$3",
      [h, b.account_id, b.date],
    );
    if (!a) throw new InputError("Invalid account/date");
    const {
      rows: [sum],
    } = await c.query(
      "SELECT COALESCE(sum(e.amount),0)::bigint AS n FROM entries e JOIN transactions t ON t.id=e.transaction_id WHERE e.household_id=$1 AND e.account_id=$2 AND t.date<=$3 AND NOT t.voided",
      [h, b.account_id, b.date],
    );
    const calculated = a.opening_balance + sum.n;
    const {
      rows: [r],
    } = await c.query(
      "INSERT INTO reconciliations(household_id,account_id,date,statement,calculated,difference) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
      [
        h,
        b.account_id,
        b.date,
        b.statement,
        calculated,
        b.statement - calculated,
      ],
    );
    await audit(c, h, res.locals.actor, "reconcile", r.id, r);
    return r;
  }),
);
app.post("/api/profiles", async (req, res) =>
  write(req, res, async (c, h) => {
    const b = z
      .object({
        name: z.string().trim().min(1).max(100),
        config: mappingSchema,
      })
      .parse(req.body);
    const {
      rows: [r],
    } = await c.query(
      "INSERT INTO profiles(household_id,name,config) VALUES($1,$2,$3) RETURNING *",
      [h, b.name, JSON.stringify(b.config)],
    );
    await audit(c, h, res.locals.actor, "create-profile", r.id, b);
    return r;
  }),
);
app.post("/api/imports/preview", async (req, res) =>
  write(req, res, async (c, h) => {
    const b = z
      .object({
        account_id: z.string().uuid(),
        profile_id: z.string().uuid(),
        filename: z.string().min(1).max(200),
        csv: z.string().min(1).max(1500000),
      })
      .parse(req.body);
    const {
      rows: [p],
    } = await c.query(
      "SELECT * FROM profiles WHERE household_id=$1 AND id=$2",
      [h, b.profile_id],
    );
    if (!p) throw new InputError("Profile missing");
    const settings = { version: p.version, ...p.config };
    const sh = hash(settings);
    const ch = createHash("sha256").update(b.csv, "utf8").digest("hex");
    const prior = await c.query(
      "SELECT id,status FROM batches WHERE household_id=$1 AND account_id=$2 AND content_hash=$3 AND settings_hash=$4",
      [h, b.account_id, ch, sh],
    );
    if (prior.rowCount) return { ...prior.rows[0], repeated: true };
    const rows = parseImport(b.csv, p.config, res.locals.household.currency);
    const {
      rows: [batch],
    } = await c.query(
      "INSERT INTO batches(household_id,account_id,profile_id,settings,content_hash,settings_hash,filename) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
      [
        h,
        b.account_id,
        b.profile_id,
        JSON.stringify(settings),
        ch,
        sh,
        b.filename,
      ],
    );
    const seen = new Set<string>();
    for (const r of rows) {
      let duplicate: null | string = null;
      if (!r.error) {
        const p = r.parsed;
        if (p.external_id) {
          const hit = await c.query(
            "SELECT id FROM transactions WHERE household_id=$1 AND source_account=$2 AND source=$3 AND external_id=$4",
            [h, b.account_id, settings.source, p.external_id],
          );
          if (hit.rowCount || seen.has(p.external_id)) duplicate = "exact";
          seen.add(p.external_id);
        }
        if (!duplicate) {
          const hit = await c.query(
            "SELECT id FROM transactions WHERE household_id=$1 AND source_account=$2 AND date=$3 AND amount=$4 AND lower(trim(payee))=lower(trim($5)) AND kind=$6 AND NOT voided",
            [h, b.account_id, p.date, p.amount, p.payee, p.kind],
          );
          if (
            hit.rowCount ||
            rows
              .slice(0, r.row_number - 2)
              .some(
                (x) =>
                  !x.error &&
                  x.parsed.date === p.date &&
                  x.parsed.amount === p.amount &&
                  x.parsed.payee?.toLowerCase() === p.payee.toLowerCase() &&
                  x.parsed.kind === p.kind,
              )
          )
            duplicate = "probable";
        }
      }
      await c.query(
        "INSERT INTO import_rows(household_id,batch_id,row_number,fingerprint,parsed,error,duplicate) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          h,
          batch.id,
          r.row_number,
          r.fingerprint,
          JSON.stringify(r.parsed),
          r.error,
          duplicate,
        ],
      );
    }
    await audit(c, h, res.locals.actor, "preview-import", batch.id, {
      rows: rows.length,
      filename: b.filename,
    });
    return { id: batch.id, status: batch.status };
  }),
);
app.get("/api/imports/:id", async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const h = res.locals.household.id;
  const {
    rows: [batch],
  } = await pool.query(
    "SELECT * FROM batches WHERE household_id=$1 AND id=$2",
    [h, id],
  );
  if (!batch) {
    res.status(404).json({ error: "Batch missing" });
    return;
  }
  const rows = (
    await pool.query(
      "SELECT * FROM import_rows WHERE household_id=$1 AND batch_id=$2 ORDER BY row_number",
      [h, id],
    )
  ).rows;
  res.json({ batch, rows });
});
app.post("/api/imports/:id/commit", async (req, res) =>
  write(req, res, async (c, h) => {
    const id = z.string().uuid().parse(req.params.id);
    const b = z
      .object({
        decisions: z
          .array(
            z.object({
              row_number: z.number().int(),
              decision: z.enum(["accept", "skip", "not_duplicate"]),
            }),
          )
          .max(5000),
      })
      .parse(req.body);
    const {
      rows: [batch],
    } = await c.query(
      "SELECT * FROM batches WHERE household_id=$1 AND id=$2 FOR UPDATE",
      [h, id],
    );
    if (!batch) throw new InputError("Batch missing");
    if (batch.status === "complete") return { id, status: "complete" };
    const { rows } = await c.query(
      "SELECT * FROM import_rows WHERE household_id=$1 AND batch_id=$2 ORDER BY row_number",
      [h, id],
    );
    if (
      new Set(b.decisions.map((d) => d.row_number)).size !== rows.length ||
      b.decisions.length !== rows.length
    )
      throw new InputError("Explicit decision required for every row");
    let posted = 0;
    for (const r of rows) {
      const decision = b.decisions.find(
        (d) => d.row_number === r.row_number,
      )?.decision;
      if (!decision) throw new InputError("Missing decision");
      if (decision !== "skip" && (r.error || r.duplicate === "exact"))
        throw new InputError(
          "Invalid and exact duplicate rows must explicitly be skipped",
        );
      if (r.duplicate === "probable" && decision === "accept")
        throw new InputError(
          "Probable duplicate requires explicit not-duplicate decision",
        );
      let t = null;
      if (decision !== "skip") {
        t = await post(
          c,
          h,
          res.locals.actor,
          { ...r.parsed, account_id: batch.account_id },
          batch.settings.source,
          r.parsed.external_id,
        );
        posted++;
      }
      await c.query(
        "UPDATE import_rows SET decision=$3,transaction_id=$4 WHERE batch_id=$1 AND row_number=$2 AND household_id=$5",
        [id, r.row_number, decision, t?.id || null, h],
      );
    }
    await c.query(
      "UPDATE batches SET status='complete',completed_at=now() WHERE household_id=$1 AND id=$2",
      [h, id],
    );
    await audit(c, h, res.locals.actor, "commit-import", id, {
      posted,
      decisions: b.decisions,
    });
    return { id, status: "complete", posted };
  }),
);
app.get("/api/audit", async (_req, res) =>
  res.json(
    (
      await pool.query(
        "SELECT * FROM audit WHERE household_id=$1 ORDER BY id DESC LIMIT 200",
        [res.locals.household.id],
      )
    ).rows,
  ),
);
app.get("/api/export/:type", async (req, res) => {
  const h = res.locals.household.id;
  let rows;
  if (req.params.type === "transactions")
    rows = (
      await pool.query(
        "SELECT t.id,t.date,t.kind,t.payee,t.memo,t.amount,t.source,t.external_id,t.voided,a.name AS account,c.name AS category,s.amount AS split_amount FROM transactions t JOIN accounts a ON a.id=t.source_account LEFT JOIN splits s ON s.transaction_id=t.id LEFT JOIN categories c ON c.id=s.category_id WHERE t.household_id=$1 ORDER BY t.date,t.id",
        [h],
      )
    ).rows;
  else if (req.params.type === "budget")
    rows = (
      await pool.query(
        "SELECT c.name,c.rollover,t.year,t.amount AS annual_target,a.month,a.amount AS allocation FROM categories c LEFT JOIN targets t ON t.category_id=c.id LEFT JOIN allocations a ON a.category_id=c.id AND extract(year from a.month)=t.year WHERE c.household_id=$1 ORDER BY c.name,t.year,a.month",
        [h],
      )
    ).rows;
  else {
    res.status(404).end();
    return;
  }
  const keys = Object.keys(rows[0] || {});
  res
    .set({
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="budgey-${req.params.type}.csv"`,
    })
    .send(
      [
        keys.map(csvCell).join(","),
        ...rows.map((r) => keys.map((k) => csvCell(r[k])).join(",")),
      ].join("\r\n"),
    );
});
app.use("/api", (_req, res) =>
  res.status(404).json({ error: "Route not found" }),
);
if (process.env.APP_ENV === "development") {
  const { createServer } = await import("vite");
  const vite = await createServer({
    server: { middlewareMode: true, hmr: false, host: "127.0.0.1" },
    appType: "spa",
  });
  app.use(vite.middlewares);
} else {
  app.use(express.static("dist/public", { index: false }));
  app.get("/{*path}", (_req, res) =>
    res.sendFile("index.html", { root: "dist/public" }),
  );
}
app.use(
  (
    err: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const id = randomUUID();
    const code = err?.code;
    const status =
      err instanceof z.ZodError ||
      err instanceof InputError ||
      err instanceof SyntaxError ||
      err.type === "entity.too.large"
        ? 400
        : code === "23505"
          ? 409
          : code?.startsWith("23")
            ? 400
            : 503;
    console.error(
      JSON.stringify({
        event: "request-failed",
        id,
        code: code || "validation",
        status,
      }),
    );
    res.status(status).json({
      error:
        err instanceof z.ZodError
          ? err.issues
              .map((x) =>
                [x.path.join("."), x.message].filter(Boolean).join(": "),
              )
              .join("; ")
          : status === 409
            ? "Record already exists; review duplicates"
            : status === 503
              ? "Database unavailable"
              : code
                ? "Data violates a ledger constraint"
                : err instanceof InputError
                  ? err.message
                  : "Invalid request body",
      request_id: id,
    });
  },
);
const port = Number(process.env.PORT || 3100);
const server = app.listen(port, "127.0.0.1", () =>
  console.log(`Budgey listening on http://127.0.0.1:${port}`),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () =>
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    }),
  );
