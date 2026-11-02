import { parse } from "csv-parse/sync";
import { z } from "zod";
import { money, hash, InputError } from "./domain.js";
import { date } from "./ledger.js";
export const mappingSchema = z
  .object({
    date: z.string().min(1),
    payee: z.string().min(1),
    amount: z.string().default(""),
    debit: z.string().default(""),
    credit: z.string().default(""),
    external: z.string().default(""),
    memo: z.string().default(""),
    currency: z.string().default(""),
    category: z.string().uuid().optional(),
    source: z
      .string()
      .trim()
      .toLowerCase()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9._-]+$/),
    dateFormat: z
      .enum(["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY"])
      .default("YYYY-MM-DD"),
    decimal: z.enum([".", ","]).default("."),
    thousands: z.enum([",", ".", " ", ""]).default(","),
    delimiter: z.enum([",", ";", "\t"]).default(","),
    sign: z
      .enum(["negative-expense", "positive-expense"])
      .default("negative-expense"),
  })
  .refine(
    (m) => (m.amount ? !m.debit && !m.credit : Boolean(m.debit && m.credit)),
    "Map either a signed amount or a debit/credit pair",
  )
  .refine(
    (m) => m.decimal !== m.thousands,
    "Decimal and thousands separators must differ",
  );
export function parseImport(csv: string, config: unknown, currency: string) {
  const m = mappingSchema.parse(config);
  let records: Record<string, string>[];
  try {
    records = parse(csv, {
      columns: (headers: string[]) => {
        if (
          new Set(headers).size !== headers.length ||
          headers.some((h) => !h.trim())
        )
          throw new InputError("CSV headers must be nonempty and unique");
        const required = [
          m.date,
          m.payee,
          m.amount,
          m.debit,
          m.credit,
          m.external,
          m.memo,
          m.currency,
        ].filter(Boolean);
        if (required.some((h) => !headers.includes(h)))
          throw new InputError(
            "Mapped column not found; check the profile header names",
          );
        return headers;
      },
      bom: true,
      skip_empty_lines: true,
      delimiter: m.delimiter,
      relax_column_count: false,
      max_record_size: 20000,
    });
  } catch (e) {
    if (e instanceof InputError) throw e;
    throw new InputError(
      "CSV could not be parsed; check delimiter, quoting and column counts",
    );
  }
  if (records.length > 5000)
    throw new InputError("Maximum 5,000 rows per import");
  return records.map((r, i) => {
    let parsed: any = {};
    let error: string | null = null;
    try {
      let d = r[m.date]?.trim();
      if (m.dateFormat !== "YYYY-MM-DD") {
        const p = d?.split("/");
        if (!p || p.length !== 3)
          throw new InputError("Date does not match mapping");
        d =
          m.dateFormat === "DD/MM/YYYY"
            ? `${p[2]}-${p[1].padStart(2, "0")}-${p[0].padStart(2, "0")}`
            : `${p[2]}-${p[0].padStart(2, "0")}-${p[1].padStart(2, "0")}`;
      }
      date.parse(d);
      if (m.currency && r[m.currency]?.trim() !== currency)
        throw new InputError("Currency does not match household");
      let n: number;
      if (m.amount) n = money(r[m.amount] || "", m.decimal, m.thousands);
      else {
        const credit = money(r[m.credit] || "0", m.decimal, m.thousands);
        const debit = money(r[m.debit] || "0", m.decimal, m.thousands);
        if (credit < 0 || debit < 0 || (credit > 0 && debit > 0))
          throw new InputError(
            "Debit/credit columns must be nonnegative with only one populated",
          );
        n = credit - debit;
      }
      if (m.amount && m.sign === "positive-expense") n = -n;
      if (!Number.isSafeInteger(n)) throw new InputError("Amount out of range");
      if (n === 0) throw new InputError("Zero amount");
      const kind = n < 0 ? "expense" : "income";
      parsed = {
        date: d,
        payee: r[m.payee]?.trim(),
        memo: m.memo ? r[m.memo] || "" : "",
        amount: Math.abs(n),
        kind,
        external_id: m.external ? r[m.external]?.trim() || null : null,
        splits:
          kind === "expense" && m.category
            ? [{ category_id: m.category, amount: Math.abs(n) }]
            : [],
      };
      if (!parsed.payee || parsed.payee.length > 200)
        throw new InputError("Payee required (maximum 200 characters)");
      if (parsed.memo.length > 2000)
        throw new InputError("Memo exceeds 2,000 characters");
      if (parsed.external_id?.length > 500)
        throw new InputError("Source ID exceeds 500 characters");
      if (kind === "expense" && !m.category)
        throw new InputError("Choose an expense category");
    } catch (e) {
      error = e instanceof Error ? e.message : "Invalid row";
    }
    return { row_number: i + 2, parsed, error, fingerprint: hash(parsed) };
  });
}
