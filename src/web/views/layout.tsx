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
