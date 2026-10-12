import { assertSameOrigin, errorResponse, json, readJson } from '../_lib/http';
import { requireUser } from '../_lib/auth';
import { completeWork } from '../_lib/beads';
import type { PagesContext } from '../_lib/env';
import type { BeadCompletePayload } from '../../../src/types/bead';

/** POST /api/beads/complete → 201 { inventory, created }（完成 1 次：按作品用量扣库存） */
export const onRequestPost = async (context: PagesContext): Promise<Response> => {
  try {
    assertSameOrigin(context.request);
    const user = await requireUser(context.request, context.env);
    const payload = await readJson<BeadCompletePayload>(context.request);
    const result = await completeWork(context.env, user.id, payload);
    return json(result, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
};
