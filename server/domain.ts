export class InputError extends Error {}
import { createHash } from "node:crypto";
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object")
    return (
      "{" +
      Object.entries(v)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => JSON.stringify(k) + ":" + canonical(x))
        .join(",") +
      "}"
    );
  return JSON.stringify(v);
}
export const hash = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
export function money(s: string, decimal = ".", thousands = ",") {
  if (decimal === thousands) throw new InputError("Separators must differ");
  const input = s.trim();
  if (thousands && input.includes(thousands)) {
    const escaped = thousands.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const dec = decimal === "." ? "\\." : ",";
    if (
      !new RegExp(
        "^-?\\d{1,3}(?:" + escaped + "\\d{3})+(?:" + dec + "\\d{1,2})?$",
      ).test(input)
    )
      throw new InputError("Invalid thousands grouping");
  }
  const v = input.split(thousands).join("").replace(decimal, ".");
  if (!/^-?\d+(\.\d{1,2})?$/.test(v))
    throw new InputError("Invalid money: maximum two decimals");
  const neg = v.startsWith("-");
  const [a, b = ""] = v.replace("-", "").split(".");
  const n = Number(a) * 100 + Number(b.padEnd(2, "0"));
  if (!Number.isSafeInteger(n)) throw new InputError("Amount out of range");
  return neg ? -n : n;
}
export function envelope(
  start: number,
  assigned: number,
  spent: number,
  rollover: boolean,
) {
  return (rollover ? start : 0) + assigned - spent;
}
export function identity(env: NodeJS.ProcessEnv, header: unknown) {
  if (env.APP_ENV === "development" && env.DEV_IDENTITY)
    return env.DEV_IDENTITY.toLowerCase();
  if (
    typeof header !== "string" ||
    !header.includes("@") ||
    header.toLowerCase() !== env.ALLOWED_EMAIL?.toLowerCase()
  )
    return null;
  return header.toLowerCase();
}
export function validateConfig(env: NodeJS.ProcessEnv) {
  if (!["development", "production", "test"].includes(env.APP_ENV || ""))
    throw Error("APP_ENV must be explicit");
  if (!env.DATABASE_URL) throw Error("DATABASE_URL required");
  if (!env.PUBLIC_ORIGIN) throw Error("PUBLIC_ORIGIN required");
  const origin = new URL(env.PUBLIC_ORIGIN);
  if (
    origin.origin !== env.PUBLIC_ORIGIN ||
    !["http:", "https:"].includes(origin.protocol)
  )
    throw Error("PUBLIC_ORIGIN must be an exact HTTP origin");
  if (env.APP_ENV === "production" && origin.protocol !== "https:")
    throw Error("Production requires an HTTPS origin");
  if (
    env.TRUSTED_IDENTITY_HEADER &&
    !/^[a-z][a-z0-9-]*$/.test(env.TRUSTED_IDENTITY_HEADER)
  )
    throw Error("Identity header must be a lowercase HTTP header name");
  for (const key of ["ALLOWED_EMAIL", "DEV_IDENTITY"])
    if (env[key] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env[key]!))
      throw Error("Identity must be an email address");
  const port = Number(env.PORT || 3100);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw Error("PORT must be between 1024 and 65535");
  if (env.APP_ENV !== "development" && env.DEV_IDENTITY)
    throw Error("DEV_IDENTITY forbidden outside development");
  if (
    env.APP_ENV === "production" &&
    (!env.ALLOWED_EMAIL || !env.TRUSTED_IDENTITY_HEADER)
  )
    throw Error("Production identity configuration required");
}
