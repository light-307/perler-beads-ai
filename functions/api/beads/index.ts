import { assertSameOrigin, errorResponse, json, readJson } from '../_lib/http';
import { requireUser } from '../_lib/auth';
import { initializeInventory, readInventory } from '../_lib/beads';
import type { PagesContext } from '../_lib/env';
import type { BeadInitPayload } from '../../../src/types/bead';

/** GET /api/beads → 200 { inventory }（未初始化时 inventory 为 null） */
export const onRequestGet = async (context: PagesContext): Promise<Response> => {
  try {
    const user = await requireUser(context.request, context.env);
    const inventory = await readInventory(context.env, user.id);
    return json({ inventory }, { status: 200 });
  } catch (error) {
    return errorResponse(error);
  }
};

/** POST /api/beads → 201 { inventory }（首次初始化豆仓，只能调用一次） */
export const onRequestPost = async (context: PagesContext): Promise<Response> => {
  try {
    assertSameOrigin(context.request);
    const user = await requireUser(context.request, context.env);
    const payload = await readJson<BeadInitPayload>(context.request);
    const inventory = await initializeInventory(context.env, user.id, payload);
    return json({ inventory }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
};
