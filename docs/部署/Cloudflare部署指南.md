# Cloudflare Pages 部署指南

本文是 `perler-beads-ai` 的推荐部署方式，**从零注册 Cloudflare 开始**，覆盖命令行部署、GitHub 自动部署、Preview Deployment（预览部署）、环境变量与自定义域名。

> 只需要部署到自己的服务器（Nginx / Docker / PM2）时，请看 [自建服务器部署](自建服务器部署.md)；那种方式没有 AI 优化接口。

## 1. 部署形态

| 部分 | 位置 | 说明 |
|------|------|------|
| 前端页面 | Cloudflare Pages（静态资源 + CDN） | `npm run build` 由 `output: "export"` 导出到 `out/`，纯 HTML/CSS/JS |
| AI 优化接口 | Cloudflare Pages Function | `functions/api/ai-optimize.ts`，对外路径 `POST /api/ai-optimize` |

也就是说：像素化、颜色映射、导出图纸等重计算全部在浏览器里完成；服务端只有一个用来代理火山引擎即梦 API 的轻量 Function，密钥只存放在 Cloudflare 的环境变量里，不会进入前端产物。

## 2. 从零开始：注册账号与准备环境

### 2.1 注册 Cloudflare 账号

1. 打开 <https://dash.cloudflare.com/sign-up>，填写邮箱和密码，点击 **Create Account**。
2. 到邮箱里点开验证邮件完成验证。
3. 登录后即为 **Free 计划**。本项目用的 Pages、Pages Functions、环境变量都在免费额度内，不需要开通任何付费功能。

### 2.2 准备本地环境

1. 安装 [Node.js](https://nodejs.org/) 18 或更高版本（推荐 20 LTS），确认：

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

### 第 1 步：构建

```bash
npm run build
```

构建完成后项目根目录会出现 `out/`（纯静态文件）。

### 第 2 步：登录 Cloudflare

```bash
npx wrangler login
```

浏览器会自动打开 Cloudflare 授权页面，点击 **Allow**。终端出现 `Successfully logged in` 即完成。

### 第 3 步：创建 Pages 项目并部署

```bash
npx wrangler pages project create perler-beads --production-branch main
npx wrangler pages deploy out --project-name perler-beads
```

- 第一条命令只需执行一次；项目名 `perler-beads` 与 `wrangler.toml` 里的 `name` 一致。
- `npm run pages:deploy` 就是第二条命令的封装（在 `package.json` 里）。
- 部署成功后终端会输出访问地址，形如 `https://perler-beads.pages.dev`。
- `wrangler` 会自动把仓库根目录的 `functions/` 一起打包为 Pages Function。

### 第 4 步：配置环境变量（AI 优化需要）

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → 选择 `perler-beads`。
2. **Settings** → **Variables and Secrets** → **Add**。
3. 添加下面两个变量，类型都选 **Secret**，并在 **Production** 和 **Preview** 上都勾选：

   | 变量名 | 值 |
   |--------|-----|
   | `VOLC_ACCESS_KEY_ID` | 火山引擎 Access Key ID |
   | `VOLC_SECRET_ACCESS_KEY` | 火山引擎 Secret Access Key |

4. 保存后**重新部署一次**（**Deployments** → 最新一次部署右侧 `…` → **Retry deployment**），变量才会生效。

> 不使用 AI 优化功能的话可以跳过这一步，其余功能完全不受影响。

### 第 5 步：绑定自定义域名（可选）

1. **Settings** → **Custom domains** → **Set up a custom domain**。
2. 输入域名并按其提示完成 DNS 接入（域名需要托管在 Cloudflare）。
3. 若希望所有非官方域名自动跳转到官方域名，再额外添加**构建时**变量 `NEXT_PUBLIC_OFFICIAL_DOMAIN`（见第 5 节），然后重新构建部署。

## 4. 方式二：连接 GitHub 自动部署（推荐）

适合持续开发：推送到 `main` 自动上线，推送到其他分支/开 PR 自动生成预览。

1. Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**。
2. 授权 GitHub，选择仓库 `light-307/perler-beads-ai`。
3. 填写构建设置：

   | 设置项 | 值 |
   |--------|-----|
   | Production branch | `main` |
   | Framework preset | `Next.js (Static HTML Export)`，没有该选项时选 `None` |
   | Build command | `npm run build` |
   | Build output directory | `out` |
   | 构建时环境变量 | `NODE_VERSION` = `20`（可选，但建议设置） |

4. 点击 **Save and Deploy**，等待第一次构建完成。
5. 再到 **Settings** → **Variables and Secrets** 按第 3 节第 4 步添加 `VOLC_*` 两个密钥。

> 仓库里没有 `wrangler.toml` 的 `pages_build_output_dir` 也没关系：上面填的 **Build output directory** 就是 Pages 读取的目录。

## 5. Preview Deployment（预览部署）

Cloudflare Pages 默认开启预览部署，规则是：

- 满足 **Production branch**（这里是 `main`）的提交 → 部署到正式环境（`https://perler-beads.pages.dev` 及自定义域名）。
- **其他所有分支和 PR** → 各自生成一个独立的预览地址，形如 `https://<分支名>.perler-beads.pages.dev` 或 `https://<提交短哈希>.perler-beads.pages.dev`。

用法与要点：

1. 开关位置：**Settings** → **Builds & deployments** → **Preview deployments**（默认 `All non-Production branches`，也可改成只对指定分支生效）。
2. 每个 PR 的检查列表里会出现一个 **Preview URL**，评审 UI 改动时直接点开即可，不用先合并。
3. 环境变量按环境区分：**Production** 的值只用于 `main`，**Preview** 的值用于所有预览分支。建议两边都填上同样的 `VOLC_*`，否则预览环境里 AI 优化会失败。
4. `NEXT_PUBLIC_OFFICIAL_DOMAIN` 建议**只在 Production 设置**：预览域名（`*.pages.dev`）本身就在代码的跳转白名单里，不受影响；但如果给 Preview 也设了官方域名，预览站点会立刻跳走，反而没法评审。
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
git checkout main
git pull
# 开发在 dev 分支完成，通过 PR 合并到 main
git push origin main          # 自动构建并上线
```

**命令行部署**

```bash
npm run build
npm run pages:deploy
```

## 8. 本地模拟 Pages 环境

`npm run dev`（Next.js 开发服务器）**不含** Pages Function，访问 AI 优化会 404，这是预期行为。要本地联调 AI，请用 wrangler：

```bash
echo "VOLC_ACCESS_KEY_ID=你的key" > .dev.vars
echo "VOLC_SECRET_ACCESS_KEY=你的secret" >> .dev.vars
npm run build
npm run pages:dev
```

然后打开 <http://127.0.0.1:8788>。`.dev.vars` 已被 `.gitignore` 忽略，不要提交。

## 9. 常见问题

**Q1：页面上点 AI 优化提示失败或 404。**
按顺序检查：① 本地是不是用的 `npm run dev`（换成 `npm run pages:dev`）；② Cloudflare 项目里有没有配 `VOLC_ACCESS_KEY_ID` / `VOLC_SECRET_ACCESS_KEY`；③ 配完是否重新部署过一次（环境变量改动不会自动应用）；④ 火山引擎侧的密钥是否有即梦（`jimeng_t2i_v40`）权限。

**Q2：`wrangler pages deploy` 提示项目不存在。**
先执行一次 `npx wrangler pages project create perler-beads --production-branch main`。

**Q3：部署成功但 AI 接口 404，其他都正常。**
确认 `functions/api/ai-optimize.ts` 在仓库根目录（与 `out/` 同级）且已提交——`wrangler` 只会打包仓库根目录下的 `functions/`。

**Q4：修改了环境变量但页面行为没变。**
Pages 的环境变量只在部署时注入。到 **Deployments** 页面把最新一次部署 **Retry** 一遍，或重新推送一次代码。

**Q5：`NEXT_PUBLIC_OFFICIAL_DOMAIN` 改了没反应。**
它是构建时变量，必须重新构建（Retry deployment / 重新 push），只改环境变量不够。

**Q6：预览分支上打开站点立刻跳走了。**
把 `NEXT_PUBLIC_OFFICIAL_DOMAIN` 从 **Preview** 环境移除，只保留 **Production**。

## 10. 相关文档

- [自建服务器部署](自建服务器部署.md) —— 部署到 Nginx / Docker / PM2（无 AI 优化接口）
- [双端云保存待办](../规划/双端云保存待办.md) —— 云端持久化方案（尚未实现）
- [参考：即梦 4.0 接口文档](../参考/即梦4.0接口文档.md) —— AI 优化依赖的火山引擎接口
