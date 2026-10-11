// GET /api/files/u/{userId}/{projectId}/{filename}
//
// R2 对象不对外公开，一律经这里转发，靠会话 Cookie 鉴权：
// 请求路径必须以 `u/{当前登录用户 id}/` 开头，因此别人的对象 key 猜也取不到。

import { ApiError, errorResponse } from '../_lib/http';
import { requireUser } from '../_lib/auth';
import { flushR2Ops, r2GetObject } from '../_lib/quota';
import type { PagesContext } from '../_lib/env';

const PREFIX = '/api/files/';

function objectKeyFrom(request: Request): string {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith(PREFIX)) {
    throw new ApiError(400, 'INVALID_PATH', '文件路径不合法');
  }
  let key: string;
  try {
    key = pathname
      .slice(PREFIX.length)
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
  } catch {
    throw new ApiError(400, 'INVALID_PATH', '文件路径不合法');
  }
  if (!key || key.includes('..')) {
    throw new ApiError(400, 'INVALID_PATH', '文件路径不合法');
  }
  return key;
}

export const onRequestGet = async (context: PagesContext): Promise<Response> => {
  try {
    const user = await requireUser(context.request, context.env);
    const key = objectKeyFrom(context.request);

    if (!key.startsWith(`u/${user.id}/`)) {
      throw new ApiError(403, 'FORBIDDEN', '无权访问这个文件');
    }

    const object = await r2GetObject(context.env, key);
    if (!object) {
      throw new ApiError(404, 'FILE_NOT_FOUND', '文件不存在');
    }

    const headers = new Headers();
    headers.set('content-type', object.httpMetadata?.contentType ?? 'application/octet-stream');
    // 必须 private：内容是登录用户私有的，不能进任何共享缓存
    headers.set('cache-control', object.httpMetadata?.cacheControl ?? 'private, max-age=31536000, immutable');
    headers.set('content-length', String(object.size));
    if (object.httpEtag) headers.set('etag', object.httpEtag);
    headers.set('vary', 'Cookie');

    return new Response(object.body, { status: 200, headers });
  } catch (error) {
    return errorResponse(error);
  } finally {
    // 把本次请求的 R2 操作次数落盘（自身不抛错）
    await flushR2Ops(context.env);
  }
};
