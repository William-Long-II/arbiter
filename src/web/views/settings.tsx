import type { FC } from 'hono/jsx';
import type { User } from '../../db/users.ts';
import { Layout } from './layout.tsx';

type Props = {
  user: User;
  config: ServerConfigSnapshot;
  dbConnected: boolean;
};

/**
 * What gets shown on /settings. Server-side computed; no sensitive fields
 * (secrets are reported as set/unset only).
 */
export type ServerConfigSnapshot = {
  port: number;
  publicUrl: string;
  githubClientId: string;
  githubClientSecretSet: boolean;
  claudeDefaultMode: 'subscription' | 'api';
  claudeBin: string;
  claudeApiKeySet: boolean;
  pollIntervalSeconds: number;
  workerIntervalSeconds: number;
  workerConcurrency: number;
  reviewRetentionDays?: number;
};

export const SettingsPage: FC<Props> = ({ user, config, dbConnected }) => {
  return (
    <Layout title="Settings" user={user} active="settings">
      <header class="page-header">
        <h1>Settings</h1>
        <p class="page-subhead">
          Current server configuration. These values come from <code class="mono-sm">.env</code> and
          require a restart to change.
        </p>
      </header>

      <Section title="Health">
        <Row label="Database">
          <span class={dbConnected ? 'badge-pill status-done' : 'badge-pill status-failed'}>
            {dbConnected ? 'connected' : 'error'}
          </span>
        </Row>
      </Section>

      <Section title="Server">
        <Row label="Public URL">
          <span class="mono-sm">{config.publicUrl}</span>
        </Row>
        <Row label="Port">
          <span class="mono-sm">{config.port}</span>
        </Row>
      </Section>

      <Section title="GitHub OAuth">
        <Row label="Client ID">
          <span class="mono-sm">{config.githubClientId || <Unset />}</span>
        </Row>
        <Row label="Client Secret">
          {config.githubClientSecretSet ? <Set /> : <Unset />}
        </Row>
      </Section>

      <Section title="Claude">
        <Row label="Default mode">
          <span class="mono-sm">{config.claudeDefaultMode}</span>
        </Row>
        <Row label="claude binary">
          <span class="mono-sm">{config.claudeBin}</span>
        </Row>
        <Row label="ANTHROPIC_API_KEY">
          {config.claudeApiKeySet ? <Set /> : <Unset />}
        </Row>
      </Section>

      <Section title="Schedules">
        <Row label="Poll interval">
          <span class="mono-sm">{config.pollIntervalSeconds}s</span>
        </Row>
        <Row label="Worker interval">
          <span class="mono-sm">{config.workerIntervalSeconds}s</span>
        </Row>
        <Row label="Worker concurrency">
          <span class="mono-sm">
            {config.workerConcurrency} review{config.workerConcurrency === 1 ? '' : 's'} in parallel
          </span>
        </Row>
        {config.reviewRetentionDays !== undefined ? (
          <Row label="Review retention">
            <span class="mono-sm">
              {config.reviewRetentionDays === 0
                ? 'forever (no pruning)'
                : `${config.reviewRetentionDays} days`}
            </span>
          </Row>
        ) : null}
      </Section>
    </Layout>
  );
};

const Section: FC<{ title: string; children: unknown }> = ({ title, children }) => {
  return (
    <section class="settings-section">
      <h2 class="settings-section-title">{title}</h2>
      <div class="card settings-card">{children}</div>
    </section>
  );
};

const Row: FC<{ label: string; children: unknown }> = ({ label, children }) => {
  return (
    <div class="settings-row">
      <span class="settings-label">{label}</span>
      <span class="settings-value">{children}</span>
    </div>
  );
};

const Set: FC = () => (
  <span class="badge-pill status-done" title="Configured">set</span>
);

const Unset: FC = () => (
  <span class="badge-pill badge-pill-muted" title="Not configured">unset</span>
);
