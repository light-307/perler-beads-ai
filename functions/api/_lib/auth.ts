// 会话：签发 / 校验 / 从请求里解析当前用户。

import type { Env } from './env';
import { ApiError, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, parseCookies } from './http';
import { signSessionToken, verifySessionToken } from './crypto';
import { getUserById, toPublicUser, type PublicUser, type UserRecord } from './users';

/** 先看 Cookie（网站），再退到 Authorization: Bearer（为小程序预留）。 */
function extractToken(request: Request): string | null {
  const fromCookie = parseCookies(request)[SESSION_COOKIE];
  if (fromCookie) return fromCookie;

  const authorization = request.headers.get('authorization');
  if (authorization && /^bearer /i.test(authorization)) {
    return authorization.slice(7).trim() || null;
  }
  return null;
}

export async function createSessionToken(env: Env, user: UserRecord): Promise<string> {
  if (!env.AUTH_SECRET) {
    throw new ApiError(500, 'SERVER_NOT_CONFIGURED', '缺少 AUTH_SECRET，无法签发登录状态。');
  }
  const now = Math.floor(Date.now() / 1000);
  return signSessionToken(
    { sub: user.id, name: user.username, iat: now, exp: now + SESSION_MAX_AGE_SECONDS },
    env.AUTH_SECRET
  );
}

/** 未登录返回 null，token 无效也返回 null（不区分，避免探测）。 */
export async function getSessionUser(request: Request, env: Env): Promise<UserRecord | null> {
  const token = extractToken(request);
  if (!token || !env.AUTH_SECRET) return null;

  const claims = await verifySessionToken(token, env.AUTH_SECRET);
  if (!claims) return null;

  const user = await getUserById(env, claims.sub);
  // 用户被删掉后旧 token 立即失效
  if (!user || user.username_lower !== claims.name.toLowerCase()) return null;
  return user;
}

export async function requireUser(request: Request, env: Env): Promise<UserRecord> {
  const user = await getSessionUser(request, env);
  if (!user) {
    throw new ApiError(401, 'UNAUTHORIZED', '请先登录');
  }
  return user;
}

/** 未登录时返回 null，供 `GET /api/auth/me` 使用。 */
export function toPublicUserOrNull(user: UserRecord | null): PublicUser | null {
  return user ? toPublicUser(user) : null;
}
