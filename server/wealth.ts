import type { PoolClient } from "pg";
import { z } from "zod";
import { audit, date, minor } from "./ledger.js";
import { InputError } from "./domain.js";
import {
  balanceSheet,
  history,
  validateWealth,
  quantity,
  type WealthData,
} from "../src/wealth.js";
const name = z.string().trim().min(1).max(100);
const id = z.string().uuid();
const dated = {
  date: date.refine(
    (v) => v >= "1900-01-01" && v <= "2200-12-31",
    "Date must be between 1900 and 2200",
  ),
  amount: minor.nonnegative(),
};
const schemas = {
  assets: z
    .object({
      name,
      kind: z.enum([
        "property",
        "vehicle",
        "other_asset",
        "loan",
        "mortgage",
        "other_liability",
      ]),
    })
    .strict(),
  valuations: z.object({ asset_id: id, ...dated }).strict(),
  portfolios: z
    .object({
      name,
      opening_date: dated.date,
      opening_cash: minor.nonnegative(),
    })
    .strict(),
  instruments: z.object({ name }).strict(),
  prices: z.object({ instrument_id: id, ...dated }).strict(),
  events: z
    .object({
      portfolio_id: id,
      instrument_id: id.nullable().default(null),
      kind: z.enum(["buy", "sell", "deposit", "withdrawal", "dividend", "fee"]),
      date: dated.date,
      amount: minor.positive(),
      units: z.string().default("0"),
      fees: minor.nonnegative().default(0),
    })
    .strict()
    .superRefine((v, c) => {
      let n = 0n;
      try {
        n = quantity(v.units);
      } catch (e) {
        c.addIssue({ code: "custom", message: (e as Error).message });
      }
      if (["buy", "sell"].includes(v.kind)) {
        if (!v.instrument_id || n <= 0n)
          c.addIssue({
            code: "custom",
            message: "Trades require a security and positive units",
          });
        if (v.kind === "sell" && v.fees > v.amount)
          c.addIssue({
            code: "custom",
            message: "Sale fees cannot exceed proceeds",
          });
      } else if (v.instrument_id || n !== 0n || v.fees !== 0)
        c.addIssue({
          code: "custom",
          message: "Cash activity must have no security, units or trade fees",
        });
    }),
};
export type WealthResource = keyof typeof schemas;
export async function loadWealth(
  c: PoolClient,
  h: string,
): Promise<WealthData> {
  const data: WealthData = {
    accounts: [],
    entries: [],
    assets: [],
    valuations: [],
    portfolios: [],
    instruments: [],
    events: [],
    prices: [],
  };
  data.accounts = (
    await c.query(
      "SELECT * FROM accounts WHERE household_id=$1 ORDER BY name",
      [h],
    )
  ).rows;
  data.entries = (
    await c.query(
      "SELECT e.account_id,e.amount,t.date,t.voided FROM entries e JOIN transactions t ON t.id=e.transaction_id AND t.household_id=e.household_id WHERE e.household_id=$1",
      [h],
    )
  ).rows;
  for (const key of [
    "assets",
    "valuations",
    "portfolios",
    "instruments",
    "events",
    "prices",
  ] as const) {
    const order =
      key === "events"
        ? "date,sequence"
        : key === "valuations" || key === "prices"
          ? "date,id"
          : "name,id";
    data[key] = (
      await c.query(
        `SELECT * FROM wealth_${key} WHERE household_id=$1 ORDER BY ${order}`,
        [h],
      )
    ).rows;
  }
  return data;
}
export async function wealthState(c: PoolClient, h: string, asOf: unknown) {
  const day = dated.date.parse(asOf);
  const data = await loadWealth(c, h);
  try {
    return {
      data,
      snapshot: balanceSheet(data, day),
      history: history(data, day),
    };
  } catch (e) {
    throw new InputError((e as Error).message);
  }
}
export async function createWealth(
  c: PoolClient,
  h: string,
  actor: string,
  resource: WealthResource,
  input: unknown,
) {
  const b = schemas[resource].parse(input);
  for (const [field, table] of [
    ["asset_id", "assets"],
    ["portfolio_id", "portfolios"],
    ["instrument_id", "instruments"],
  ] as const) {
    if (field in b && b[field as keyof typeof b]) {
      const found = await c.query(
        `SELECT id FROM wealth_${table} WHERE household_id=$1 AND id=$2`,
        [h, (b as Record<string, unknown>)[field]],
      );
      if (!found.rowCount)
        throw new InputError(`${table} record missing from this household`);
    }
  }
  const fields = Object.keys(b);
  const values = Object.values(b);
  const r = await c.query(
    `INSERT INTO wealth_${resource}(household_id,${fields.join(",")}) VALUES($1,${fields.map((_, i) => "$" + (i + 2)).join(",")}) RETURNING *`,
    [h, ...values],
  );
  // Replay the entire timeline, including later activity, before committing a backdated event.
  try {
    const d = await loadWealth(c, h);
    validateWealth(d);
  } catch (e) {
    throw new InputError((e as Error).message);
  }
  await audit(
    c,
    h,
    actor,
    "create",
    "wealth_" + resource + ":" + r.rows[0].id,
    b,
  );
  return r.rows[0] as { id: string };
}
export const wealthResources = Object.keys(schemas) as WealthResource[];
