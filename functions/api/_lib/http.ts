// HTTP 层小工具：JSON 响应、错误、Cookie、请求体解析。

import type { Env } from './env';

export const SESSION_COOKIE = 'pb_session';
/** 会话有效期 30 天 */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  // 接口永远返回实时数据，且需要带上 Cookie，禁止任何中间缓存
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return json({ error: error.code, message: error.message }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : '未知错误';
  console.error('[api] 未处理异常:', error);
  return json({ error: 'INTERNAL_ERROR', message }, { status: 500 });
}

/** 服务端配置缺失时统一返回这条，前端可据此提示用户去配置环境变量。 */
export function serverNotConfigured(missing: string[]): ApiError {
  return new ApiError(
    500,
    'SERVER_NOT_CONFIGURED',
    `服务端没有读到环境变量 ${missing.join('、')}。请在 Cloudflare 控制台 → Workers & Pages → 本项目 → Settings → Variables and Secrets 添加` +
      `（类型选 Secret，Production 与 Preview 都要填），保存后重新部署一次；本地联调请写入仓库根目录的 .dev.vars 后执行 npm run preview。`
  );
}

export function requireEnv(env: Env, keys: Array<keyof Env>): void {
  const missing = keys.filter((key) => !String(env[key] ?? '').trim());
  if (missing.length > 0) {
    throw serverNotConfigured(missing as string[]);
  }
}

export function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get('cookie');
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) result[name] = decodeURIComponent(value);
  }
  return result;
}

export function serializeCookie(
  name: string,
  value: string,
  options: { maxAge?: number; secure?: boolean; httpOnly?: boolean; sameSite?: 'Lax' | 'Strict' | 'None'; path?: string } = {}
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? '/'}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  // 本地 wrangler dev 走 http，带 Secure 的 Cookie 会被浏览器丢弃，所以按请求协议动态决定
  if (options.secure) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  return parts.join('; ');
}

export function isSecureRequest(request: Request): boolean {
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return true;
  }
}

export function sessionCookieHeader(token: string, request: Request): string {
  return serializeCookie(SESSION_COOKIE, token, {
    maxAge: SESSION_MAX_AGE_SECONDS,
    secure: isSecureRequest(request),
    httpOnly: true,
    sameSite: 'Lax',
  });
}

export function clearSessionCookieHeader(request: Request): string {
  return serializeCookie(SESSION_COOKIE, '', {
    maxAge: 0,
    secure: isSecureRequest(request),
    httpOnly: true,
    sameSite: 'Lax',
  });
}

export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  const text = await request.text();
  if (!text) {
    throw new ApiError(400, 'EMPTY_BODY', '请求体为空');
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(400, 'INVALID_JSON', '请求体不是合法的 JSON');
  }
}

/**
 * 校验来源，防 CSRF。
 *
 * 会话走 SameSite=Lax 的 HttpOnly Cookie，跨站表单提交本来就不会带上 Cookie；
 * 这里再校验一次 Origin，避免出现"未来某天改成 SameSite=None"时的静默退化。
 * 同源请求（包含本地 wrangler dev 的 http://127.0.0.1:8787）Origin 与 Host 一致。
 */
export function assertSameOrigin(request: Request): void {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;

  const origin = request.headers.get('origin');
  if (!origin) return; // 非浏览器客户端（例如后续小程序直连）不带 Origin，交给 token 校验

  const host = request.headers.get('host');
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ApiError(403, 'BAD_ORIGIN', '请求来源不合法');
  }
  if (host && originHost !== host) {
    throw new ApiError(403, 'BAD_ORIGIN', '请求来源与站点不一致，已拒绝');
  }
}
