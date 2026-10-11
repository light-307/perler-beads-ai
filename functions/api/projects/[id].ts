import { ApiError, assertSameOrigin, errorResponse, json, readJson } from '../_lib/http';
import { requireUser } from '../_lib/auth';
import { flushR2Ops } from '../_lib/quota';
import { assertProjectId, deleteProject, fileUrl, readGridBase64, requireProject, updateProject } from '../_lib/projects';
import type { PagesContext } from '../_lib/env';
import type { ProjectWritePayload } from '../../../src/types/project';

function projectIdFrom(context: PagesContext): string {
  const raw = context.params?.id;
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (!id) {
    throw new ApiError(400, 'INVALID_PROJECT_ID', '缺少作品 ID');
  }
  return assertProjectId(id);
}

/** GET /api/projects/:id → 200 { project }（含索引压缩网格的 base64） */
export const onRequestGet = async (context: PagesContext): Promise<Response> => {
  try {
    const user = await requireUser(context.request, context.env);
    const project = await requireProject(context.env, user.id, projectIdFrom(context));
    return json(
      {
        project: {
          ...project,
          // 300×200 网格约 60KB，列表接口不含它，详情接口才带
          grid_data: await readGridBase64(context.env, project.files.grid),
          original_url: fileUrl(project.files.original),
          ai_url: fileUrl(project.files.ai),
          thumbnail_url: fileUrl(project.files.thumbnail),
          blueprint_url: fileUrl(project.files.blueprint),
        },
      },
      { status: 200 }
    );
  } catch (error) {
    return errorResponse(error);
  } finally {
    // 把本次请求的 R2 操作次数落盘（自身不抛错）
    await flushR2Ops(context.env);
  }
};

/** PUT /api/projects/:id → 200 { project } */
export const onRequestPut = async (context: PagesContext): Promise<Response> => {
  try {
    assertSameOrigin(context.request);
    const user = await requireUser(context.request, context.env);
    const payload = await readJson<ProjectWritePayload>(context.request);
    const project = await updateProject(context.env, user.id, projectIdFrom(context), payload);
    return json(
      {
        project: {
          ...project,
          grid_data: typeof payload.grid === 'string' ? payload.grid : await readGridBase64(context.env, project.files.grid),
          original_url: fileUrl(project.files.original),
          ai_url: fileUrl(project.files.ai),
          thumbnail_url: fileUrl(project.files.thumbnail),
          blueprint_url: fileUrl(project.files.blueprint),
        },
      },
      { status: 200 }
    );
  } catch (error) {
    return errorResponse(error);
  } finally {
    // 把本次请求的 R2 操作次数落盘（自身不抛错）
    await flushR2Ops(context.env);
  }
};

/** DELETE /api/projects/:id → 200 { ok: true }（元数据与 R2 对象一起删除） */
export const onRequestDelete = async (context: PagesContext): Promise<Response> => {
  try {
    assertSameOrigin(context.request);
    const user = await requireUser(context.request, context.env);
    await deleteProject(context.env, user.id, projectIdFrom(context));
    return json({ ok: true }, { status: 200 });
  } catch (error) {
    return errorResponse(error);
  } finally {
    // 把本次请求的 R2 操作次数落盘（自身不抛错）
    await flushR2Ops(context.env);
  }
};
