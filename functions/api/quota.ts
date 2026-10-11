// GET /api/quota
//
// 返回当前 R2 用量与自设上限，供「我的作品」页展示，也让"为什么保存被拒绝"
// 一眼可见。用量是应用自己记的账（见 _lib/quota.ts 顶部的说明），
// 与 Cloudflare 控制台的计费口径可能有极小偏差。

import { errorResponse, json } from './_lib/http';
import { requireUser } from './_lib/auth';
import { flushR2Ops, getQuotaStatus } from './_lib/quota';
import type { PagesContext } from './_lib/env';

export const onRequestGet = async (context: PagesContext): Promise<Response> => {
  try {
    await requireUser(context.request, context.env);
    return json({ quota: await getQuotaStatus(context.env) }, { status: 200 });
  } catch (error) {
    return errorResponse(error);
  } finally {
    await flushR2Ops(context.env);
  }
};
