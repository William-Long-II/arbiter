import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { SESSION_COOKIE, verify } from './cookies.ts';
import { getSessionUser, type User } from '../db/users.ts';

declare module 'hono' {
  interface ContextVariableMap {
    user: User;
  }
}

export async function currentUser(c: Context): Promise<User | null> {
  const signed = getCookie(c, SESSION_COOKIE);
  if (!signed) return null;
  const sessionId = await verify(signed);
  if (!sessionId) return null;
  return getSessionUser(sessionId);
}

export const requireUser: MiddlewareHandler = async (c, next) => {
  const user = await currentUser(c);
  if (!user) return c.redirect('/auth/github');
  c.set('user', user);
  await next();
};
