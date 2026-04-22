/**
 * Minimal HTML tagged-template helper.
 *
 * - Auto-escapes ${...} interpolations by default.
 * - Pass `raw(s)` to opt out of escaping (for nested html`` results or
 *   pre-built markup).
 * - Arrays of strings/RawHtml are joined with no separator, which makes
 *   mapping rows trivial: ${items.map(row => html`<tr>...</tr>`)}
 */

const RAW = Symbol("raw-html");

export type RawHtml = { [RAW]: true; value: string };

export function raw(s: string | RawHtml): RawHtml {
  if (typeof s === "object" && s && RAW in s) return s;
  return { [RAW]: true, value: s };
}

export type Interpolation =
  | string
  | number
  | boolean
  | null
  | undefined
  | RawHtml
  | Interpolation[];

export function html(strings: TemplateStringsArray, ...values: Interpolation[]): RawHtml {
  let out = "";
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) out += renderValue(values[i]);
  }
  return { [RAW]: true, value: out };
}

function renderValue(v: Interpolation): string {
  if (v === null || v === undefined || v === false) return "";
  if (v === true) return "";
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map(renderValue).join("");
  if (typeof v === "object" && RAW in v) return v.value;
  return escapeHtml(String(v));
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function htmlResponse(body: RawHtml, status = 200): Response {
  return new Response(body.value, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export function redirect(location: string, status = 303): Response {
  return new Response(null, { status, headers: { location } });
}
