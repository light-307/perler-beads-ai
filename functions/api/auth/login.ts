import { assertSameOrigin, errorResponse, json, readJson, sessionCookieHeader } from '../_lib/http';
import { authenticateUser, toPublicUser } from '../_lib/users';
import { createSessionToken } from '../_lib/auth';
import type { PagesContext } from '../_lib/env';

interface LoginBody {
  username?: string;
  password?: string;
}

/** POST /api/auth/login → 200 { user } + 会话 Cookie */
export const onRequestPost = async (context: PagesContext): Promise<Response> => {
  try {
    assertSameOrigin(context.request);
    const body = await readJson<LoginBody>(context.request);
    const user = await authenticateUser(context.env, String(body.username ?? ''), String(body.password ?? ''));
    const token = await createSessionToken(context.env, user);
    return json(
      { user: toPublicUser(user) },
      { status: 200, headers: { 'set-cookie': sessionCookieHeader(token, context.request) } }
    );
  } catch (error) {
    return errorResponse(error);
  }
};
