import { errorResponse, json } from '../_lib/http';
import { getSessionUser, toPublicUserOrNull } from '../_lib/auth';
import type { PagesContext } from '../_lib/env';

/**
 * GET /api/auth/me → 200 { user }，未登录时 user 为 null。
 *
 * 刻意不返回 401：前端启动时就会调它，用 200 + null 表达"未登录"可以少一次
 * 控制台报错，页面也好写。
 */
export const onRequestGet = async (context: PagesContext): Promise<Response> => {
  try {
    const user = await getSessionUser(context.request, context.env);
    return json({ user: toPublicUserOrNull(user) }, { status: 200 });
  } catch (error) {
    return errorResponse(error);
  }
};
