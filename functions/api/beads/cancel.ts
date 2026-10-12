import { assertSameOrigin, errorResponse, json, readJson } from '../_lib/http';
import { requireUser } from '../_lib/auth';
import { cancelWork } from '../_lib/beads';
import type { PagesContext } from '../_lib/env';

/** POST /api/beads/cancel → 200 { inventory, removed }（取消 1 次：撤销该作品最近一次完成） */
export const onRequestPost = async (context: PagesContext): Promise<Response> => {
  try {
    assertSameOrigin(context.request);
    const user = await requireUser(context.request, context.env);
    const payload = await readJson<{ project_id?: string }>(context.request);
    const result = await cancelWork(context.env, user.id, payload?.project_id);
    return json(result, { status: 200 });
  } catch (error) {
    return errorResponse(error);
  }
};
