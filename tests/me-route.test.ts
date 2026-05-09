import { describe, expect, test } from 'bun:test';
import { buildApp } from '../src/web/server.tsx';

describe('GET /me', () => {
  test('returns 200 with {user: null} when signed out', async () => {
    const app = buildApp();
    const res = await app.request('/me');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ user: null });
  });
});
