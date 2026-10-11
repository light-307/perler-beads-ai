import { assertSameOrigin, clearSessionCookieHeader, errorResponse, json } from '../_lib/http';
import type { PagesContext } from '../_lib/env';

/** POST /api/auth/logout → 200 { ok: true }，并清掉会话 Cookie */
export const onRequestPost = async (context: PagesContext): Promise<Response> => {
  try {
    assertSameOrigin(context.request);
    return json(
      { ok: true },
      { status: 200, headers: { 'set-cookie': clearSessionCookieHeader(context.request) } }
    );
  } catch (error) {
    return errorResponse(error);
  }
};
