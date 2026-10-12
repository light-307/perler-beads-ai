import { assertSameOrigin, errorResponse, json, readJson } from '../_lib/http';
import { requireUser } from '../_lib/auth';
import { addManualRecord } from '../_lib/beads';
import type { PagesContext } from '../_lib/env';
import type { BeadManualRecordPayload } from '../../../src/types/bead';

/** POST /api/beads/records → 201 { inventory }（手动增减某个色号的库存） */
export const onRequestPost = async (context: PagesContext): Promise<Response> => {
  try {
    assertSameOrigin(context.request);
    const user = await requireUser(context.request, context.env);
    const payload = await readJson<BeadManualRecordPayload>(context.request);
    const inventory = await addManualRecord(context.env, user.id, payload);
    return json({ inventory }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
};
