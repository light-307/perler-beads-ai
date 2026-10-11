import { assertSameOrigin, errorResponse, json, readJson } from '../_lib/http';
import { requireUser } from '../_lib/auth';
import { flushR2Ops } from '../_lib/quota';
import { createProject, fileUrl, listProjects } from '../_lib/projects';
import type { PagesContext } from '../_lib/env';
import type { ProjectWritePayload } from '../../../src/types/project';

/** GET /api/projects → 200 { projects }（按更新时间倒序，不含网格与图片二进制） */
export const onRequestGet = async (context: PagesContext): Promise<Response> => {
  try {
    const user = await requireUser(context.request, context.env);
    const projects = await listProjects(context.env, user.id);
    return json(
      {
        projects: projects.map((project) => ({
          ...project,
          thumbnail_url: fileUrl(project.files.thumbnail),
          original_url: fileUrl(project.files.original),
          blueprint_url: fileUrl(project.files.blueprint),
        })),
      },
      { status: 200 }
    );
  } catch (error) {
    return errorResponse(error);
  }
};

/** POST /api/projects → 201 { project } */
export const onRequestPost = async (context: PagesContext): Promise<Response> => {
  try {
    assertSameOrigin(context.request);
    const user = await requireUser(context.request, context.env);
    const payload = await readJson<ProjectWritePayload>(context.request);
    const project = await createProject(context.env, user.id, payload);
    return json(
      {
        project: {
          ...project,
          grid_data: typeof payload.grid === 'string' ? payload.grid : null,
          original_url: fileUrl(project.files.original),
          ai_url: fileUrl(project.files.ai),
          thumbnail_url: fileUrl(project.files.thumbnail),
          blueprint_url: fileUrl(project.files.blueprint),
        },
      },
      { status: 201 }
    );
  } catch (error) {
    return errorResponse(error);
  } finally {
    // 把本次请求的 R2 操作次数落盘（自身不抛错）
    await flushR2Ops(context.env);
  }
};
