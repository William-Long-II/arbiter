import type { Store } from "../../state/db.ts";
import type { Config } from "../../config.ts";
import { resolveTone } from "../../review/tone.ts";
import { parseSlug, sluggedPath } from "../../github/slug.ts";
import { currentActor, recordAudit } from "../../audit.ts";
import { html, htmlResponse, redirect } from "../html.ts";
import { layout, type SessionUser } from "../layout.ts";

export function repoEditRoute(args: {
  store: Store;
  cfg: Config;
  slug: string;
  user?: SessionUser | null;
}): Response {
  const repo = args.store.getRepo(args.slug);
  if (!repo) {
    return new Response(`Unknown repo: ${args.slug}`, { status: 404 });
  }
  const parsed = parseSlug(args.slug);
  if (!parsed) {
    return new Response(`Malformed repo slug: ${args.slug}`, { status: 400 });
  }
  const { owner, name } = parsed;
  const org = args.store.getOrg(owner);

  // Show the tone that WOULD be resolved right now as a preview. This is what
  // Claude will see on the next review unless edits happen in between.
  const previewTone = resolveTone({ cfg: args.cfg, owner, name });

  const body = html`
    <section class="card">
      <h2>Edit repo: ${args.slug}</h2>
      <p class="muted">
        Repo-level tone sits on top of the org tone (if any), which sits on top of the default.
        Append adds to what's inherited; replace wipes everything above it and uses only this text.
      </p>
      <form method="post" action="/config/repos/${sluggedPath(args.slug)}">
        <label>Tone mode</label>
        <select name="tone_mode">
          <option value="append" ${repo.tone_mode === "append" ? "selected" : ""}>append (add to inherited)</option>
          <option value="replace" ${repo.tone_mode === "replace" ? "selected" : ""}>replace (use only this tone)</option>
        </select>

        <label>Default tone (read-only, from General)</label>
        <textarea readonly style="opacity:.65">${args.cfg.review.tone}</textarea>

        ${org
          ? html`
            <label>Org tone for <code>${owner}</code> (read-only)</label>
            <textarea readonly style="opacity:.65">${org.tone_override === null
              ? "(inherits default)"
              : `[${org.tone_mode}] ${org.tone_override}`}</textarea>
          `
          : ""}

        <label>Repo tone override (leave empty to inherit)</label>
        <textarea name="tone_override" placeholder="e.g. This service is on the hot path for checkout. Flag any added allocation or IO in request handlers.">${repo.tone_override ?? ""}</textarea>

        <label>Resolved tone preview (what Claude will see next tick)</label>
        <textarea readonly style="opacity:.65">${previewTone}</textarea>

        <div class="space flex">
          <button type="submit">Save</button>
          <a href="/config" class="muted">cancel</a>
        </div>
      </form>
    </section>
  `;

  return htmlResponse(layout({ title: `Edit ${args.slug}`, active: "config", body, sessionUser: args.user }));
}

export function handleRepoEditPost(
  store: Store,
  slug: string,
  form: FormData,
): Response {
  const existing = store.getRepo(slug);
  if (!existing) {
    return new Response(`Unknown repo: ${slug}`, { status: 404 });
  }
  const toneMode = String(form.get("tone_mode") ?? "append");
  if (toneMode !== "append" && toneMode !== "replace") {
    return new Response("invalid tone_mode", { status: 400 });
  }
  const toneRaw = String(form.get("tone_override") ?? "");
  const toneOverride = toneRaw.trim().length === 0 ? null : toneRaw;

  const changes = [];
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

  store.setRepoTone(slug, toneOverride, toneMode);
  recordAudit(store, {
    actor: currentActor(),
    action: "config.repo.edit",
    target: slug,
    changes,
  });
  return redirect("/config");
}
