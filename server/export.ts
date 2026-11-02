export function csvCell(value: unknown) {
  const text = String(value ?? "");
  const safe =
    typeof value === "string" && /^\s*[=+@-]/.test(text) ? "'" + text : text;
  return '"' + safe.replace(/"/g, '""') + '"';
}
