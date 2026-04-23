import type { Store, UserRole } from "../../state/db.ts";
import { currentActor, recordAudit } from "../../audit.ts";
import { html, htmlResponse, redirect } from "../html.ts";
import { layout } from "../layout.ts";

/**
 * /config/users — admin-only listing + promote/demote/delete. Admins can
 * manage every role except their own; self-demotion is blocked so an
 * admin can't accidentally lock themselves out of the admin UI.
 */
export function usersRoute(args: {
  store: Store;
  currentLogin: string;
  currentRole: UserRole;
}): Response {
  const users = args.store.listUsers();
  const body = html`
    <section class="card">
      <h2>Users</h2>
      <p class="muted">
        Everyone in this list has signed in at least once. The first ever
        login is auto-promoted to admin; subsequent logins come in as
        viewer and need an admin to promote them.
      </p>
      <table>
        <thead><tr><th>Login</th><th>Email</th><th>Role</th><th>Last updated</th><th></th></tr></thead>
        <tbody>
          ${users.length === 0
            ? html`<tr><td colspan="5" class="muted">No users yet — the first GitHub login becomes admin.</td></tr>`
            : users.map((u) => {
                const isSelf = u.login === args.currentLogin;
                return html`
                  <tr>
                    <td class="mono">${u.login}${isSelf ? html` <span class="muted">(you)</span>` : ""}</td>
                    <td class="muted">${u.email ?? "—"}</td>
                    <td><span class="tag ${u.role}">${u.role}</span></td>
                    <td class="muted">${u.updated_at}</td>
                    <td>
                      <div class="actions">
                        ${isSelf
                          ? html`<span class="muted" title="admins can't change their own role or delete themselves — avoids the 'locked myself out' trap">self</span>`
                          : html`
                              <form method="post" action="/config/users/${encodeURIComponent(u.login)}/role" class="inline">
                                <input type="hidden" name="role" value="${u.role === "admin" ? "viewer" : "admin"}">
                                <button type="submit">${u.role === "admin" ? "demote to viewer" : "promote to admin"}</button>
                              </form>
                              <form method="post" action="/config/users/${encodeURIComponent(u.login)}/delete" class="inline">
                                <button type="submit" class="danger">delete</button>
                              </form>
                            `}
                      </div>
                    </td>
                  </tr>
                `;
              })}
        </tbody>
      </table>
    </section>
  `;
  return htmlResponse(
    layout({
      title: "Users",
      active: "config",
      body,
      sessionUser: { login: args.currentLogin, role: args.currentRole },
    }),
  );
}

export function handleUserRolePost(args: {
  store: Store;
  login: string;
  currentLogin: string;
  form: FormData;
}): Response {
  const { store, login, currentLogin, form } = args;
  if (login === currentLogin) {
    return new Response("admins cannot change their own role", { status: 400 });
  }
  const target = store.getUser(login);
  if (!target) return new Response(`Unknown user: ${login}`, { status: 404 });

  const nextRaw = String(form.get("role") ?? "");
  if (nextRaw !== "admin" && nextRaw !== "viewer") {
    return new Response("invalid role", { status: 400 });
  }
  const next: UserRole = nextRaw;
  if (next === target.role) return redirect("/config/users");

  store.setUserRole(login, next);
  // If demoting, also kill their sessions so they don't keep posting
  // config changes until the cookie expires.
  if (next === "viewer") store.deleteSessionsForUser(login);

  recordAudit(store, {
    actor: currentActor({ sessionLogin: currentLogin }),
    action: "auth.role_change",
    target: login,
    changes: [{ path: "role", from: target.role, to: next }],
  });
  return redirect("/config/users");
}

export function handleUserDeletePost(args: {
  store: Store;
  login: string;
  currentLogin: string;
}): Response {
  const { store, login, currentLogin } = args;
  if (login === currentLogin) {
    return new Response("admins cannot delete themselves", { status: 400 });
  }
  const target = store.getUser(login);
  if (!target) return new Response(`Unknown user: ${login}`, { status: 404 });

  store.deleteUser(login);
  recordAudit(store, {
    actor: currentActor({ sessionLogin: currentLogin }),
    action: "auth.user_delete",
    target: login,
  });
  return redirect("/config/users");
}
