# CLAUDE.md

本文件为在此仓库中工作的 AI 代理提供指引。项目说明与功能介绍见 [README.md](README.md)，文档索引见 README 的「文档导航」章节。

## 项目概览

拼豆底稿生成器：纯浏览器端完成「上传图片 → 像素化 → 颜色映射到拼豆色号 → 导出图纸/统计图/CSV」，服务端只有一个用于 AI 优化的轻量接口。

- **框架**：Next.js 15.3.6（App Router）+ React 19 + TypeScript
- **样式**：Tailwind CSS 4（`@tailwindcss/postcss`）
- **部署形态**：`next.config.ts` 中 `output: "export"`（静态导出到 `out/`）+ Cloudflare Pages
- **服务端代码**：仅 `functions/api/ai-optimize.ts`（Cloudflare **Pages Function**，非 Next.js API Route）

## 常用命令

```bash
npm install
npm run dev          # Next.js 开发服务器（http://localhost:3000）
npm run build        # 静态导出到 out/
npm run lint         # ESLint
npm run pages:dev    # 本地模拟 Cloudflare Pages 环境（含 Pages Function，需先 build）
npm run pages:deploy # 部署到 Cloudflare Pages（需先 build）
```

## 架构要点

### 前端

- `src/app/page.tsx`（约 2800 行）是核心：承载上传、裁剪、像素化管线、预览、手动编辑、导出等绝大多数逻辑。改动前先通读相关函数。
- `src/components/` 为模块化 UI 组件（`PixelatedPreviewCanvas`、`ColorPalette`、`ColorPanel`、`FloatingColorPalette`、`FloatingToolbar`、`MagnifierTool`、`ImageCropperModal`、`AIOptimizeModal`、`SettingsPanel`、`DownloadSettingsModal`、`FocusCanvas`、`InstallPWA`、`DonationModal` 等）。
- `src/utils/`：`pixelation.ts`、`colorSystemUtils.ts`、`floodFillUtils.ts`、`canvasUtils.ts`、`imageDownloader.ts`、`pixelEditingUtils.ts`、`localStorageUtils.ts`、`aiOptimize.ts`。
- `src/hooks/`：`useManualEditingState.ts`、`usePixelEditingOperations.ts`。

### 核心算法（`src/app/page.tsx`）

1. 按粒度把原图划分为 `N x M` 网格，取每格的**主导色**（卡通模式）或**平均色**（真实模式）；
2. 用**欧氏距离**把该颜色映射到当前有效调色板的最近色，得到 `initialMappedData`；
3. 用 **BFS** 合并颜色相似度低于 `similarityThreshold` 的连通区域，得到 `mergedData`；
4. 从边界出发用**洪水填充**标记外部背景（`BACKGROUND_COLOR_KEYS`，如 T1、H1）；
5. 颜色排除/恢复时按需重映射或整体重算；
6. 渲染预览图、带 Key 图纸、统计图。

调色板数据在 `src/app/colorSystemMapping.json`（291 种颜色的 HEX → MARD/COCO/漫漫/盼盼/咪小窝 映射）。用户可用色板由 `localStorage` 中的 `customPaletteSelections` 决定，默认选择逻辑见 `src/app/page.tsx` 的 `getDefaultPaletteSelections()`（默认排除 P/Q/R/T/Y/ZG 系列，291 色中选中 221 色）。

### AI 优化

- 前端始终调用同源接口：`src/utils/aiOptimize.ts` 中 `fetch('/api/ai-optimize')`。
- 该路径由 `functions/api/ai-optimize.ts` 在 Cloudflare Pages 上实现，调用火山引擎即梦（`req_key: jimeng_t2i_v40`，`CVSync2AsyncSubmitTask` / `CVSync2AsyncGetResult`，HMAC-SHA256 签名，轮询最长约 3 分钟），需要环境变量 `VOLC_ACCESS_KEY_ID` / `VOLC_SECRET_ACCESS_KEY`。
- **已知现象**：`output: "export"` 下 `npm run dev` 没有 Pages Function，AI 优化会 404，这是预期行为；本地联调请用 `npm run pages:dev`。
- `no-backend` 分支走的是另一套实现：浏览器用 Web Crypto 直接调用火山引擎（其客户端文件 `src/lib/volcEngineClient.ts` 不属于本分支，已从本分支移除）。

## 注意事项

- 不要在仓库中提交任何密钥。根目录曾有一个 `env` 文件（上游 fork 遗留的火山引擎密钥），已删除；线上密钥只应放在 Cloudflare 环境变量中，本地开发放在 `.dev.vars`（已在 `.gitignore` 中）。
- `public/` 中只有图标与 `manifest.json`；项目**没有** next-pwa / sharp / @vercel/analytics 依赖，文档或注释中若出现这些请视为过时内容。
- 构建产物 `out/` 已被 `.gitignore` 忽略。

## 文档

仓库文档集中在 `docs/`，文件名以中文为主：

- `docs/部署/自建服务器部署.md` — 非 Cloudflare 环境部署
- `docs/部署/静态部署-no-backend分支.md` — 仅适用于 `no-backend` 分支
- `docs/功能/一键去背景.md` — 一键去背景功能实现
- `docs/参考/即梦4.0接口文档.md` — 火山引擎即梦接口原始文档
- `docs/规划/双端云保存待办.md` — 云端保存待办方案
- `docs/images/` — README 展示图
