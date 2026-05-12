import type { FC, PropsWithChildren } from 'hono/jsx';
import type { User } from '../../db/users.ts';

type Props = {
  title: string;
  user: User | null;
  active?: 'queue' | 'scopes' | 'repos' | 'settings';
};

export const Layout: FC<PropsWithChildren<Props>> = ({
  title,
  user,
  active,
  children,
}) => {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title} · reviewme</title>
        <link rel="stylesheet" href="/static/app.css" />
      </head>
      <body>
        <div class="app-shell">
          <nav class="top-nav">
            <a class="brand" href="/">
              <span class="brand-mark" aria-hidden="true">◆</span>
              <span class="brand-name">reviewme</span>
            </a>
            <div class="top-nav-spacer" />
            {user ? (
              <span
                id="next-poll-indicator"
                class="next-poll"
                title="Time until the next poller sweep across your scoped repos."
                aria-live="polite"
              >
                next poll …
              </span>
            ) : null}
            {user ? (
              <div class="top-nav-user">
                {user.avatarUrl ? (
                  <img class="avatar" src={user.avatarUrl} alt="" width={24} height={24} />
                ) : null}
                <span class="user-login">{user.githubLogin}</span>
                <form method="post" action="/auth/logout" class="logout-form">
                  <button class="cta-tertiary" type="submit">Sign out</button>
                </form>
              </div>
            ) : (
              <a class="cta-secondary" href="/auth/github">Sign in</a>
            )}
          </nav>

          {user?.tokenRevokedAt ? (
            <div class="auth-banner">
              <span class="auth-banner-icon" aria-hidden="true">⚠</span>
              <span class="auth-banner-text">
                Your GitHub access has been revoked. Reviews can't run until you{' '}
                <a class="auth-banner-link" href="/auth/github">re-authenticate</a>.
              </span>
            </div>
          ) : null}

          <div class="app-body">
            <aside class="side-nav">
              <SideNavItem href="/queue" label="Queue" active={active === 'queue'} />
              <SideNavItem href="/scopes" label="Scopes" active={active === 'scopes'} />
              <SideNavItem href="/repos" label="Repos" active={active === 'repos'} />
              <SideNavItem href="/settings" label="Settings" active={active === 'settings'} />
            </aside>
            <main class="page">{children}</main>
          </div>
        </div>
        {user ? (
          <script
            dangerouslySetInnerHTML={{
              __html: `
                (function() {
                  var el = document.getElementById('next-poll-indicator');
                  if (!el) return;
                  var nextAt = 0;
                  var inFlight = false;
                  var intervalSec = 0;

                  function fmt(seconds) {
                    if (seconds < 60) return seconds + 's';
                    var m = Math.floor(seconds / 60);
                    var s = seconds % 60;
                    return m + 'm ' + s + 's';
                  }

                  function load() {
                    fetch('/api/poller/status', { credentials: 'same-origin' })
                      .then(function(r) { return r.ok ? r.json() : null; })
                      .then(function(s) {
                        if (!s) { el.textContent = 'poller off'; return; }
                        intervalSec = s.intervalSeconds || 0;
                        nextAt = s.nextPollAt ? Date.parse(s.nextPollAt) : 0;
                        inFlight = !!s.inFlight;
                      })
                      .catch(function() { el.textContent = 'poller ?'; });
                  }

                  function tick() {
                    if (inFlight) {
                      el.textContent = 'polling…';
                    } else if (!nextAt) {
                      el.textContent = 'poller idle';
                    } else {
                      var remainMs = nextAt - Date.now();
                      if (remainMs <= 0) {
                        // The setInterval on the server has fired (or is about
                        // to). Refetch so the indicator picks up the new tick
                        // start + the (now updated) nextPollAt.
                        el.textContent = 'polling…';
                        load();
                      } else {
                        el.textContent = 'next poll in ' + fmt(Math.ceil(remainMs / 1000));
                      }
                    }
                  }

                  load();
                  setInterval(tick, 1000);
                  tick();
                })();
              `,
            }}
          />
        ) : null}
      </body>
    </html>
  );
};

const SideNavItem: FC<{ href: string; label: string; active: boolean }> = ({
  href,
  label,
  active,
}) => {
  return (
    <a class={active ? 'side-nav-item active' : 'side-nav-item'} href={href}>
      {label}
    </a>
  );
};
