import { InputError } from "./domain.js";
import type { PoolClient } from "pg";
import { z } from "zod";
export const minor = z.number().int().safe();
export const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      !isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v,
    "Invalid date",
  );
export const transactionSchema = z
  .object({
    kind: z.enum(["income", "expense", "refund", "transfer"]),
    date,
    payee: z.string().trim().min(1).max(200),
    memo: z.string().max(2000).default(""),
    amount: minor.positive(),
    account_id: z.string().uuid(),
    destination_id: z.string().uuid().optional(),
    original_id: z.string().uuid().optional(),
    splits: z
      .array(
        z.object({ category_id: z.string().uuid(), amount: minor.positive() }),
      )
      .max(100)
      .default([]),
  })
  .superRefine((t, c) => {
    if (["expense", "refund"].includes(t.kind)) {
      if (t.splits.reduce((s, x) => s + x.amount, 0) !== t.amount)
        c.addIssue({
          code: "custom",
          message: "Splits must equal transaction amount",
        });
    } else if (t.splits.length)
      c.addIssue({
        code: "custom",
        message: "Income and transfers cannot have categories",
      });
    if (
      t.kind === "transfer" &&
      (!t.destination_id || t.destination_id === t.account_id)
    )
      c.addIssue({
        code: "custom",
        message: "Choose a different destination account",
      });
  });
export type TransactionInput = z.infer<typeof transactionSchema>;
export async function audit(
  c: PoolClient,
  h: string,
  actor: string,
  action: string,
  entity: string,
  detail: unknown,
) {
  await c.query(
    "INSERT INTO audit(household_id,actor,action,entity,detail) VALUES($1,$2,$3,$4,$5)",
    [h, actor, action, entity, JSON.stringify(detail)],
  );
}
export async function post(
  c: PoolClient,
  h: string,
  actor: string,
  input: unknown,
  source = "manual",
  external: string | null = null,
) {
  const t = transactionSchema.parse(input);
  const currency = (input as { currency?: unknown })?.currency;
  if (currency !== undefined) {
    const household = await c.query(
      "SELECT currency FROM households WHERE id=$1",
      [h],
    );
    if (currency !== household.rows[0]?.currency)
      throw new InputError("Currency does not match household");
  }
  const ids = [
    t.account_id,
    ...(t.kind === "transfer" ? [t.destination_id!] : []),
  ];
  const a = await c.query(
    "SELECT id,opening_date FROM accounts WHERE household_id=$1 AND id=ANY($2::uuid[]) AND NOT archived",
    [h, ids],
  );
  if (a.rowCount !== ids.length || a.rows.some((a) => a.opening_date > t.date))
    throw new InputError(
      "Account missing, archived, or transaction predates opening",
    );
  if (t.splits.length) {
    const cats = await c.query(
      "SELECT id FROM categories WHERE household_id=$1 AND id=ANY($2::uuid[]) AND NOT archived",
      [h, t.splits.map((s) => s.category_id)],
    );
    if (cats.rowCount !== t.splits.length)
      throw new InputError("Invalid or repeated category");
  }
  const {
    rows: [r],
  } = await c.query(
    "INSERT INTO transactions(household_id,kind,date,payee,memo,amount,source,external_id,source_account,original_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
    [
      h,
      t.kind,
      t.date,
      t.payee,
      t.memo,
      t.amount,
      source,
      external,
      t.account_id,
      t.original_id || null,
    ],
  );
  await c.query(
    "INSERT INTO entries(household_id,transaction_id,account_id,amount) VALUES($1,$2,$3,$4)",
    [
      h,
      r.id,
      t.account_id,
      t.kind === "expense" || t.kind === "transfer" ? -t.amount : t.amount,
    ],
  );
  if (t.kind === "transfer")
    await c.query(
      "INSERT INTO entries(household_id,transaction_id,account_id,amount) VALUES($1,$2,$3,$4)",
      [h, r.id, t.destination_id, t.amount],
    );
  for (const s of t.splits)
    await c.query(
      "INSERT INTO splits(household_id,transaction_id,category_id,amount) VALUES($1,$2,$3,$4)",
      [h, r.id, s.category_id, s.amount],
    );
  await audit(c, h, actor, "create", "transaction:" + r.id, {
    ...t,
    source,
    external,
  });
  return r;
}
