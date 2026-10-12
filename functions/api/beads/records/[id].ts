import { ApiError, assertSameOrigin, errorResponse, json } from '../../_lib/http';
import { requireUser } from '../../_lib/auth';
import { deleteRecord } from '../../_lib/beads';
import type { PagesContext } from '../../_lib/env';

/** DELETE /api/beads/records/:id → 200 { inventory }（删除一条记录，库存随之回落） */
export const onRequestDelete = async (context: PagesContext): Promise<Response> => {
  try {
    assertSameOrigin(context.request);
    const user = await requireUser(context.request, context.env);
    const raw = context.params?.id;
    const recordId = Array.isArray(raw) ? raw[0] : raw;
    if (!recordId) {
      throw new ApiError(400, 'INVALID_RECORD_ID', '缺少记录 ID');
    }
    const inventory = await deleteRecord(context.env, user.id, recordId);
    return json({ inventory }, { status: 200 });
  } catch (error) {
    return errorResponse(error);
  }
};
