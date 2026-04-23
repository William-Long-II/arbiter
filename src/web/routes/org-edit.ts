import type { Store } from "../../state/db.ts";
import type { Config } from "../../config.ts";
import { currentActor, recordAudit } from "../../audit.ts";
import { html, htmlResponse, redirect } from "../html.ts";
import { layout } from "../layout.ts";

export function orgEditRoute(args: {
  store: Store;
  cfg: Config;
  name: string;
}): Response {
  const org = args.store.getOrg(args.name);
  if (!org) {
    return new Response(`Unknown org: ${args.name}`, { status: 404 });
  }
  const include = parseArr(org.include_json);
  const exclude = parseArr(org.exclude_json);

  const body = html`
    <section class="card">
      <h2>Edit org: ${args.name}</h2>
      <p class="muted">
        Repos matched by this org inherit the review tone defined here.
        Individual repos can override it further (repo &gt; org &gt; default).
      </p>
      <form method="post" action="/config/orgs/${encodeURIComponent(args.name)}">
        <div class="grid">
          <div>
            <label>Mode</label>
            <select name="mode">
              <option value="all" ${org.mode === "all" ? "selected" : ""}>all (every repo)</option>
              <option value="include" ${org.mode === "include" ? "selected" : ""}>include (only listed)</option>
            </select>
          </div>
          <div>
            <label>Include (comma-separated, used when mode=include)</label>
            <input type="text" name="include" value="${include.join(", ")}">
          </div>
          <div>
            <label>Exclude (comma-separated, used when mode=all)</label>
            <input type="text" name="exclude" value="${exclude.join(", ")}">
          </div>
          <div>
            <label>Tone mode</label>
            <select name="tone_mode">
              <option value="append" ${org.tone_mode === "append" ? "selected" : ""}>append (add to default)</option>
              <option value="replace" ${org.tone_mode === "replace" ? "selected" : ""}>replace (use only this tone)</option>
            </select>
          </div>
        </div>

        <label>Default tone (read-only, from General)</label>
        <textarea readonly style="opacity:.65">${args.cfg.review.tone}</textarea>

        <label>Org tone override (leave empty to inherit default)</label>
        <textarea name="tone_override" placeholder="e.g. This is a security-critical service. Flag any change that touches auth, crypto, or PII handling.">${org.tone_override ?? ""}</textarea>

        <div class="space flex">
          <button type="submit">Save</button>
          <a href="/config" class="muted">cancel</a>
        </div>
      </form>
    </section>
  `;

  return htmlResponse(layout({ title: `Edit ${args.name}`, active: "config", body }));
}

export function handleOrgEditPost(
  store: Store,
  name: string,
  form: FormData,
): Response {
  const existing = store.getOrg(name);
  if (!existing) {
    return new Response(`Unknown org: ${name}`, { status: 404 });
  }
  const mode = String(form.get("mode") ?? "all");
  if (mode !== "all" && mode !== "include") {
    return new Response("invalid mode", { status: 400 });
  }
  const include = splitCsv(form.get("include"));
  const exclude = splitCsv(form.get("exclude"));
  if (mode === "include" && include.length === 0) {
    return new Response("include list required when mode=include", { status: 400 });
  }
  const toneMode = String(form.get("tone_mode") ?? "append");
  if (toneMode !== "append" && toneMode !== "replace") {
    return new Response("invalid tone_mode", { status: 400 });
  }
  const toneRaw = String(form.get("tone_override") ?? "");
  const toneOverride = toneRaw.trim().length === 0 ? null : toneRaw;

  const changes = [];
  if (existing.mode !== mode) {
    changes.push({ path: "mode", from: existing.mode, to: mode });
  }
  if (existing.tone_override !== toneOverride) {
    changes.push({
      path: "tone_override",
      from: existing.tone_override === null ? "null" : `(${existing.tone_override.length} chars)`,
      to: toneOverride === null ? "null" : `(${toneOverride.length} chars)`,
    });
  }
  if (existing.tone_mode !== toneMode) {
    changes.push({ path: "tone_mode", from: existing.tone_mode, to: toneMode });
  }

  store.upsertOrg({
    name,
    mode,
    include_json: JSON.stringify(include),
    exclude_json: JSON.stringify(exclude),
    tone_override: toneOverride,
    tone_mode: toneMode,
  });
  recordAudit(store, {
    actor: currentActor(),
    action: "config.org.edit",
    target: name,
    changes,
  });
  return redirect("/config");
}

function parseArr(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function splitCsv(v: FormDataEntryValue | null): string[] {
  return String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
