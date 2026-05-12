import type { FC, PropsWithChildren } from 'hono/jsx';
import type { User } from '../../db/users.ts';
import { getPollerStatus } from '../../github/poller.ts';

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
  // Embed the poller's current state directly into the markup so the
  // indicator renders the right text on first paint. Without this the
  // client script would fetch /api/poller/status after the DOM was already
  // showing a placeholder, causing a brief "poller idle" flash on every
  // page navigation.
  const pollerStatus = user ? getPollerStatus() : null;
  const initialIndicator = pollerStatus?.inFlight
    ? 'polling…'
    : pollerStatus?.nextPollAt
      ? formatRemaining(pollerStatus.nextPollAt)
      : 'poller idle';

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title} · arbiter</title>
        <link rel="stylesheet" href="/static/app.css" />
      </head>
      <body>
        <div class="app-shell">
          <nav class="top-nav">
            <a class="brand" href="/">
              <span class="brand-mark" aria-hidden="true">◆</span>
              <span class="brand-name">arbiter</span>
            </a>
            <div class="top-nav-spacer" />
            {user ? (
              <span
                id="next-poll-indicator"
                class="next-poll"
                title="Time until the next poller sweep across your scoped repos."
                aria-live="polite"
                data-next-poll-at={pollerStatus?.nextPollAt ?? ''}
                data-interval-seconds={String(pollerStatus?.intervalSeconds ?? 0)}
                data-in-flight={pollerStatus?.inFlight ? '1' : '0'}
              >
                {initialIndicator}
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
        {/* Easter-egg toast: hidden by default; the egg script flips .show. */}
        {user ? <div id="egg-toast" class="egg-toast" role="status" aria-live="polite" /> : null}
        {user ? (
          <script
            dangerouslySetInnerHTML={{
              __html: `
                (function() {
                  // Console banner — anyone who opens DevTools sees this.
                  console.log(
                    '%c◆ ARBITER\\n%c\\u201CArbiter unit reporting.\\u201D\\n\\nhttps://github.com/William-Long-II/arbiter',
                    'color:#cc785c;font-size:18px;font-weight:bold;font-family:monospace',
                    'color:#8a8f98;font-size:12px;font-family:monospace'
                  );

                  var toast = document.getElementById('egg-toast');
                  function flash(msg) {
                    if (!toast) return;
                    toast.textContent = msg;
                    toast.classList.add('show');
                    clearTimeout(flash._t);
                    flash._t = setTimeout(function() {
                      toast.classList.remove('show');
                    }, 2400);
                  }

                  // Brand-mark click counter: 5 clicks within 3s on the diamond
                  // (not the wordmark) shows a quote. Click handler swallows
                  // the event so the diamond doesn't navigate — wordmark still does.
                  var mark = document.querySelector('.brand-mark');
                  if (mark) {
                    var clicks = [];
                    mark.style.cursor = 'pointer';
                    mark.addEventListener('click', function(e) {
                      e.preventDefault();
                      e.stopPropagation();
                      var now = Date.now();
                      clicks = clicks.filter(function(t) { return now - t < 3000; });
                      clicks.push(now);
                      if (clicks.length >= 5) {
                        clicks = [];
                        flash('Arbiter unit reporting.');
                      }
                    });
                  }

                  // Konami code: ↑↑↓↓←→←→ B A
                  var KONAMI = ['ArrowUp','ArrowUp','ArrowDown','ArrowDown',
                                'ArrowLeft','ArrowRight','ArrowLeft','ArrowRight','b','a'];
                  var idx = 0;
                  document.addEventListener('keydown', function(e) {
                    var key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
                    if (key === KONAMI[idx]) {
                      idx++;
                      if (idx === KONAMI.length) {
                        idx = 0;
                        flash('Time wields the sharpest blade.');
                        if (mark) {
                          mark.style.transition = 'transform 600ms ease';
                          mark.style.transform = 'rotate(720deg)';
                          setTimeout(function() {
                            mark.style.transform = '';
                          }, 700);
                        }
                      }
                    } else {
                      idx = key === KONAMI[0] ? 1 : 0;
                    }
                  });
                })();
              `,
            }}
          />
        ) : null}
        {user ? (
          <script
            dangerouslySetInnerHTML={{
              __html: `
                (function() {
                  var el = document.getElementById('next-poll-indicator');
                  if (!el) return;
                  // Seed from server-rendered data attributes so the first
                  // paint already shows the right value — no fetch flash.
                  var nextAt = Date.parse(el.dataset.nextPollAt || '') || 0;
                  var inFlight = el.dataset.inFlight === '1';
                  var intervalSec = parseInt(el.dataset.intervalSeconds || '0', 10);

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
                        tick();
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

                  setInterval(tick, 1000);
                })();
              `,
            }}
          />
        ) : null}
      </body>
    </html>
  );
};

function formatRemaining(nextPollAtIso: string): string {
  const remainMs = Date.parse(nextPollAtIso) - Date.now();
  if (remainMs <= 0) return 'polling…';
  const seconds = Math.ceil(remainMs / 1000);
  if (seconds < 60) return `next poll in ${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `next poll in ${m}m ${s}s`;
}

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
