# Cloudflare 部署指南

本文是 `perler-beads-ai` 的推荐部署方式，**从零注册 Cloudflare 开始**，覆盖命令行部署、连接 GitHub 自动部署、Preview Deployment（预览部署）、环境变量与自定义域名。

> 只需要部署到自己的服务器（Nginx / Docker / PM2）时，请看 [自建服务器部署](自建服务器部署.md)；那种方式没有 AI 优化接口。

## 1. 部署形态

| 部分 | 位置 | 说明 |
|------|------|------|
| 前端页面 | Cloudflare 静态资源（Assets + CDN） | `next.config.ts` 里 `output: "export"`，`npm run build` 把它导出到 `out/`，纯 HTML/CSS/JS |
| AI 优化接口 | Worker（由 Pages Functions 编译而来） | 源码是 `functions/api/ai-optimize.ts`，对外路径 `POST /api/ai-optimize` |

也就是说：像素化、颜色映射、导出图纸等重计算全部在浏览器里完成；服务端只有一个用来代理火山引擎即梦 API 的轻量接口，密钥只存放在 Cloudflare 的环境变量里，不会进入前端产物。

### 1.1 注意：新版 Cloudflare 面板没有「Build output directory」

Cloudflare 正在把 Pages 统一到 Workers 上。新面板不再提供 **Build output directory** 这一项，而是让构建流程变成两步：

1. **Build command**：先执行 `npm run build`（框架构建）；
2. **Deploy command**：再执行 `npx wrangler deploy`，由 Wrangler 读取仓库根目录的配置文件，决定「上传哪个目录当静态资源、哪个文件当 Worker 入口」。

所以静态目录不再填在面板上，而是写在仓库的 [`wrangler.jsonc`](../../wrangler.jsonc) 里：

```jsonc
{
  "name": "perler-beads-ai",                                 // 必须与面板上的项目名一致
  "compatibility_date": "2024-12-01",
  "assets": { "directory": "./out", "binding": "ASSETS" },  // 静态资源目录
  "main": "./out/_worker.js/index.js"                        // Pages Functions 编译产物
}
```

> **`name` 必须与面板上的项目名完全一致**。`wrangler deploy` 是按这个名字找项目的：名字不一致时它不会报错，而是**悄悄新建一个同名 Worker**，你的域名和预览地址仍然指向旧项目，表现为「构建成功但网站没更新」。

> 如果 Deploy command 还停留在 `wrangler pages deploy`，请改成 `npx wrangler deploy`。旧命令属于已废弃的 Pages 上传链路，在新面板上会缺少配置来源。

### 1.2 `npm run build` 到底做了什么

`package.json` 里的 build 脚本由三步组成，缺一不可：

```json
"build": "next build && wrangler pages functions build --outdir=./out/_worker.js/ && node scripts/postbuild-assets.mjs"
```

1. `next build` —— 静态导出到 `out/`；
2. `wrangler pages functions build` —— 把 `functions/` 目录编译成 Worker，产物为 `out/_worker.js/index.js`（这正是 `wrangler.jsonc` 里 `main` 指向的文件）；
3. `node scripts/postbuild-assets.mjs` —— 在 `out/` 里生成 `.assetsignore`。

第 3 步不能省：Wrangler 发现静态资源目录里存在 `_worker.js` 时会**直接报错拒绝部署**（`Uploading a Pages _worker.js directory as an asset`），必须用 `.assetsignore` 明确把服务端代码排除掉。该文件在 `out/` 内，而 `out/` 已被 `.gitignore` 忽略，所以每次构建后重新生成。

## 2. 从零开始：注册账号与准备环境

### 2.1 注册 Cloudflare 账号

1. 打开 <https://dash.cloudflare.com/sign-up>，填写邮箱和密码，点击 **Create Account**。
2. 到邮箱里点开验证邮件完成验证。
3. 登录后即为 **Free 计划**。本项目用到的静态资源、Worker 请求、环境变量都在免费额度内，不需要开通任何付费功能。

### 2.2 准备本地环境

1. 安装 [Node.js](https://nodejs.org/) 20 或更高版本，确认：

   ```bash
   node -v
   ```

2. 克隆代码并安装依赖：

   ```bash
   git clone https://github.com/light-307/perler-beads-ai.git
   cd perler-beads-ai
   npm install
   ```

## 3. 方式一：用 Wrangler 命令行部署

适合不打算长期自动部署、只想先把站点跑起来的情况。

### 第 1 步：登录 Cloudflare

```bash
npx wrangler login
```

浏览器会自动打开 Cloudflare 授权页面，点击 **Allow**。终端出现 `Successfully logged in` 即完成。

### 第 2 步：构建并部署

```bash
npm run build     # 产出 out/、out/_worker.js/ 与 out/.assetsignore
npm run deploy    # 等价于 npx wrangler deploy
```

- 部署成功后终端会输出访问地址，形如 `https://perler-beads-ai.<你的账户子域>.workers.dev`。
- Worker 名字取自 `wrangler.jsonc` 的 `name`（本仓库为 `perler-beads-ai`）。
- 先自检配置是否正确，可以只做一次演练（不会真的上传）：

  ```bash
  npx wrangler deploy --dry-run
  ```

  期望输出里能看到 `Read N files from the assets directory .../out`、`env.ASSETS  Assets`，并且没有 ERROR。

### 第 3 步：配置环境变量（AI 优化需要）

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → 选择 `perler-beads-ai`。
2. **Settings** → **Variables and Secrets** → **Add**。
3. 添加下面两个变量，类型都选 **Secret**，并在 **Production** 和 **Preview** 上都勾选：

   | 变量名 | 值 |
   |--------|-----|
   | `VOLC_ACCESS_KEY_ID` | 火山引擎 Access Key ID |
   | `VOLC_SECRET_ACCESS_KEY` | 火山引擎 Secret Access Key |

4. 保存后**重新部署一次**（**Deployments** → 最新一次部署右侧 `…` → **Retry deployment**），变量才会生效。

> 不使用 AI 优化功能的话可以跳过这一步，其余功能完全不受影响。

### 第 4 步：绑定自定义域名（可选）

1. **Settings** → **Domains & Routes**（旧面板叫 **Custom domains**）→ 添加自定义域名。
2. 输入域名并按其提示完成 DNS 接入（域名需要托管在 Cloudflare）。
3. 若希望所有非官方域名自动跳转到官方域名，再额外添加**构建时**变量 `NEXT_PUBLIC_OFFICIAL_DOMAIN`（见第 6 节），然后重新构建部署。

## 4. 方式二：连接 GitHub 自动部署（推荐）

适合持续开发：推送到 `main` 自动上线，推送到其他分支/开 PR 自动生成预览。

1. Dashboard → **Workers & Pages** → **Create** → 导入 Git 仓库（**Connect to Git**）→ 选择仓库 `light-307/perler-beads-ai`。
2. 填写构建设置：

   | 设置项 | 值 |
   |--------|-----|
   | Production branch | `main` |
   | Build command | `npm run build` |
   | Deploy command | `npx wrangler deploy` |
   | 构建时环境变量 | `NODE_VERSION` = `20`（可选，但建议设置） |

   > 新版面板上**不会有**「Build output directory」输入框，静态目录由仓库里的 `wrangler.jsonc` 决定，这是正常的。

3. 保存并触发第一次构建。构建日志里应该依次出现：

   ```text
   Executing user build command: npm run build
   ✓ Exporting (3/3)
   Success: Build command completed
   Executing user deploy command: npx wrangler deploy
   ✨ Read 64 files from the assets directory .../out
   Deployed perler-beads-ai triggers ...
   ```

4. 再到 **Settings** → **Variables and Secrets** 按第 3 节第 3 步添加 `VOLC_*` 两个密钥。

## 5. Preview Deployment（预览部署）

Cloudflare 默认开启预览部署，规则是：

- 满足 **Production branch**（这里是 `main`）的提交 → 部署到正式环境。
- **其他所有分支和 PR** → 各自生成一个独立的预览地址。

用法与要点：

1. 开关位置：**Settings** → **Builds & deployments** → **Preview deployments**（默认 `All non-Production branches`，也可改成只对指定分支生效）。
2. 每个 PR 的检查列表里会出现一个 **Preview URL**，评审 UI 改动时直接点开即可，不用先合并。
3. 环境变量按环境区分：**Production** 的值只用于 `main`，**Preview** 的值用于所有预览分支。建议两边都填上同样的 `VOLC_*`，否则预览环境里 AI 优化会失败。
4. `NEXT_PUBLIC_OFFICIAL_DOMAIN` 建议**只在 Production 设置**：预览域名本身就在代码的跳转白名单里，不受影响；但如果给 Preview 也设了官方域名，预览站点会立刻跳走，反而没法评审。
5. 预览部署同样会跑 `functions/`，因此预览环境也能测 AI 优化。

## 6. 环境变量参考

| 变量名 | 作用范围 | 是否必须 | 说明 |
|--------|----------|----------|------|
| `VOLC_ACCESS_KEY_ID` | 运行时（Production + Preview） | 使用 AI 优化时必须 | 火山引擎 Access Key ID |
| `VOLC_SECRET_ACCESS_KEY` | 运行时（Production + Preview） | 使用 AI 优化时必须 | 火山引擎 Secret Access Key |
| `NODE_VERSION` | 构建时 | 可选 | 建议 `20`，避免默认 Node 版本过旧 |
| `NEXT_PUBLIC_OFFICIAL_DOMAIN` | **构建时**（仅 Production） | 可选 | 形如 `https://pindou.348349.xyz/`；设置后访问其他域名会自动跳转到该域名 |

> `NEXT_PUBLIC_*` 变量会被编译进前端代码（`src/app/page.tsx` 中的跳转逻辑读取 `process.env.NEXT_PUBLIC_OFFICIAL_DOMAIN`），**修改后必须重新构建部署**才会生效。

> 兼容性标志：**不需要**开启 `nodejs_compat`。`functions/api/ai-optimize.ts` 只使用 Web Crypto（`crypto.subtle`）和 `fetch`，没有引入任何 Node 内置模块。

## 7. 日常部署流程

**GitHub 自动部署（推荐）**

```bash
git checkout dev
# 在 dev 上开发、提交
git push origin dev           # 自动生成预览环境
# 在 GitHub 上开 PR 合并到 main
# 合并后 main 自动构建并上线
```

**命令行部署**

```bash
npm run build
npm run deploy
```

## 8. 本地预览

`npm run dev`（Next.js 开发服务器）**不含** AI 优化接口，点 AI 优化会 404，这是预期行为。要本地联调，用 Wrangler 起一个和线上一致的运行时：

```bash
echo "VOLC_ACCESS_KEY_ID=你的key" > .dev.vars
echo "VOLC_SECRET_ACCESS_KEY=你的secret" >> .dev.vars
npm run preview
```

`npm run preview` = `npm run build && wrangler dev`，然后打开 <http://127.0.0.1:8787>。此时 `/api/ai-optimize` 可用。`.dev.vars` 已被 `.gitignore` 忽略，不要提交。

## 9. 常见问题

**Q1：面板上没有 Build output directory，构建成功但部署步骤报 `✘ [ERROR] Missing entry-point to Worker script or to assets directory`。**
说明 Wrangler 在仓库里找不到静态资源目录声明。确认仓库根目录存在 `wrangler.jsonc`，且里面有 `assets.directory` 与 `main` 两项；同时确认 Deploy command 是 `npx wrangler deploy`（不是 `wrangler pages deploy`）。

**Q2：报 `Uploading a Pages _worker.js directory as an asset`。**
`out/.assetsignore` 没生成。检查 `npm run build` 是否完整跑了三步（尤其是 `node scripts/postbuild-assets.mjs`）。

**Q3：页面上点 AI 优化提示失败或 404。**
按顺序检查：① 本地是不是用的 `npm run dev`（换成 `npm run preview`）；② Cloudflare 项目里有没有配 `VOLC_ACCESS_KEY_ID` / `VOLC_SECRET_ACCESS_KEY`；③ 配完是否重新部署过一次（环境变量改动不会自动应用）；④ 火山引擎侧的密钥是否有即梦（`jimeng_t2i_v40`）权限。

**Q4：部署成功但 AI 接口 404，其他都正常。**
确认 `functions/api/ai-optimize.ts` 在仓库根目录（与 `out/` 同级）且已提交，并且 `wrangler.jsonc` 的 `main` 指向 `./out/_worker.js/index.js`。

**Q5：修改了环境变量但页面行为没变。**
环境变量只在部署时注入。到 **Deployments** 页面把最新一次部署 **Retry** 一遍，或重新推送一次代码。

**Q6：`NEXT_PUBLIC_OFFICIAL_DOMAIN` 改了没反应。**
它是构建时变量，必须重新构建（Retry deployment / 重新 push），只改环境变量不够。

**Q7：预览分支上打开站点立刻跳走了。**
`NEXT_PUBLIC_OFFICIAL_DOMAIN` 只应设在 **Production** 环境，预览环境留空（它只在生产域名不是目标域名时才跳转）。代码里对 `localhost`、局域网 IP、`*.pages.dev`、`*.workers.dev` 已做豁免，所以 CF 自动生成的预览地址不会被跳转；但如果你给预览绑了自定义域名，仍需把该变量从 Preview 环境移除。

**Q8：从旧 Pages 项目迁移过来的话要改什么？**
一句话：`wrangler.toml` 换成 `wrangler.jsonc` 并补上 `assets` / `main`；面板的 Deploy command 换成 `npx wrangler deploy`；`npm run pages:deploy` 更名为 `npm run deploy`、`npm run pages:dev` 更名为 `npm run preview`。功能与地址不变。

**Q9：构建和部署都成功了，但访问网站还是旧内容。**
九成是 `wrangler.jsonc` 的 `name` 和面板上的项目名不一致。`wrangler deploy` 按 `name` 找项目，找不到就**静默新建一个同名 Worker**，于是这次部署根本没有落到你域名指向的那个项目上。到 **Workers & Pages** 列表里看是不是多了一个项目，把 `name` 改成与面板项目名完全一致（本仓库为 `perler-beads-ai`）后重新部署。

## 10. 相关文档

- [自建服务器部署](自建服务器部署.md) —— 部署到 Nginx / Docker / PM2（无 AI 优化接口）
- [双端云保存待办](../规划/双端云保存待办.md) —— 云端持久化方案（尚未实现）
- [参考：即梦 4.0 接口文档](../参考/即梦4.0接口文档.md) —— AI 优化依赖的火山引擎接口
- [Cloudflare 官方：Pages 迁移到 Workers 指南](https://developers.cloudflare.com/workers/prompts/pages-to-workers.txt)
