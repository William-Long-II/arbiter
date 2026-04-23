import type { Store } from "../../state/db.ts";
import { currentActor, recordAudit, type AuditChange } from "../../audit.ts";
import { html, htmlResponse, redirect } from "../html.ts";
import { layout, type SessionUser } from "../layout.ts";

/**
 * Per-template edit page. Used for both "create new" (id = "new") and
 * "edit existing" (id = row id). Kept on its own route because the
 * tone_addendum field wants a full-width textarea and doesn't fit the
 * Config page's inline grid.
 */
export function toneTemplateEditRoute(args: {
  store: Store;
  id: "new" | number;
  user?: SessionUser | null;
}): Response {
  const isNew = args.id === "new";
  const row = isNew ? null : args.store.getToneTemplate(args.id as number);
  if (!isNew && !row) {
    return new Response(`Unknown tone template: ${String(args.id)}`, { status: 404 });
  }

  const action = isNew
    ? "/config/tone-templates"
    : `/config/tone-templates/${row!.id}`;
  const title = isNew ? "New file-type tone template" : `Edit template: ${row!.pattern}`;

  const body = html`
    <section class="card">
      <h2>${title}</h2>
      <p class="muted">
        When a PR's diff contains any file matching the glob, the addendum below
        is appended to the tone sent to Claude. Lower-priority templates come
        first; higher-priority (more specific) guidance appears closer to the
        review task instruction.
      </p>
      <form method="post" action="${action}">
        <label>Glob pattern</label>
        <input type="text" name="pattern" value="${row?.pattern ?? ""}" required placeholder="**/*.tf">

        <label>Priority (integer; higher = applied later, so more specific wins)</label>
        <input type="number" name="priority" value="${row?.priority ?? 0}" min="-1000" max="1000">

        <label>Tone addendum</label>
        <textarea name="tone_addendum" required placeholder="Review Terraform files with IaC security in mind: state locks, plan review, hardcoded secrets, IAM blast radius.">${row?.tone_addendum ?? ""}</textarea>

        <div class="space flex">
          <button type="submit">${isNew ? "Create" : "Save"}</button>
          ${!isNew ? html`
            <button type="submit" name="_action" value="delete" class="danger">Delete</button>
          ` : ""}
          <a href="/config" class="muted">cancel</a>
        </div>
      </form>
    </section>
  `;

  return htmlResponse(layout({ title, active: "config", body, sessionUser: args.user }));
}

/**
 * POST /config/tone-templates — create new row.
 * POST /config/tone-templates/:id — update or delete (based on _action).
 * Both land here; id === null means "create".
 */
export function handleToneTemplatePost(args: {
  store: Store;
  id: number | null;
  form: FormData;
}): Response {
  const { store, id, form } = args;
  const action = String(form.get("_action") ?? "");
  if (action === "delete" && id !== null) {
    const existing = store.getToneTemplate(id);
    if (!existing) return redirect("/config");
    store.deleteToneTemplate(id);
    recordAudit(store, {
      actor: currentActor(),
      action: "config.general.save",
      target: `tone-template#${id}`,
      detail: `deleted tone template for pattern=${existing.pattern}`,
    });
    return redirect("/config");
  }

  const pattern = String(form.get("pattern") ?? "").trim();
  const addendum = String(form.get("tone_addendum") ?? "");
  const priority = clampInt(form.get("priority"), -1000, 1000, 0);
  if (!pattern) return new Response("pattern is required", { status: 400 });
  if (pattern.length > 500) return new Response("pattern too long (max 500 chars)", { status: 400 });
  if (!addendum.trim()) return new Response("tone_addendum is required", { status: 400 });
  if (addendum.length > 10_000) return new Response("tone_addendum too long (max 10000 chars)", { status: 400 });

  if (id === null) {
    const newId = store.insertToneTemplate({
      pattern,
      tone_addendum: addendum,
      priority,
    });
    recordAudit(store, {
      actor: currentActor(),
      action: "config.general.save",
      target: `tone-template#${newId}`,
      detail: `created tone template for pattern=${pattern} (priority=${priority})`,
    });
    return redirect("/config");
  }

  const existing = store.getToneTemplate(id);
  if (!existing) {
    return new Response(`Unknown tone template: ${id}`, { status: 404 });
  }
  const changes: AuditChange[] = [];
  if (existing.pattern !== pattern) {
    changes.push({ path: "pattern", from: existing.pattern, to: pattern });
  }
  if (existing.priority !== priority) {
    changes.push({ path: "priority", from: String(existing.priority), to: String(priority) });
  }
  if (existing.tone_addendum !== addendum) {
    changes.push({
      path: "tone_addendum",
      from: `(${existing.tone_addendum.length} chars)`,
      to: `(${addendum.length} chars)`,
    });
  }
  store.updateToneTemplate({
    id,
    pattern,
    tone_addendum: addendum,
    priority,
  });
  recordAudit(store, {
    actor: currentActor(),
    action: "config.general.save",
    target: `tone-template#${id}`,
    changes,
  });
  return redirect("/config");
}

function clampInt(v: FormDataEntryValue | null, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
