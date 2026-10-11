import { assertSameOrigin, errorResponse, json, readJson, sessionCookieHeader } from '../_lib/http';
import { registerUser, toPublicUser } from '../_lib/users';
import { createSessionToken } from '../_lib/auth';
import type { PagesContext } from '../_lib/env';

interface RegisterBody {
  username?: string;
  password?: string;
  nickname?: string;
}

/** POST /api/auth/register → 201 { user } + 会话 Cookie */
export const onRequestPost = async (context: PagesContext): Promise<Response> => {
  try {
    assertSameOrigin(context.request);
    const body = await readJson<RegisterBody>(context.request);
    const user = await registerUser(context.env, {
      username: String(body.username ?? ''),
      password: String(body.password ?? ''),
      nickname: body.nickname,
    });
    const token = await createSessionToken(context.env, user);
    return json(
      { user: toPublicUser(user) },
      { status: 201, headers: { 'set-cookie': sessionCookieHeader(token, context.request) } }
    );
  } catch (error) {
    return errorResponse(error);
  }
};
