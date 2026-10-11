# Cloudflare 云保存配置指南

面向「把作品保存到云端」这个功能的部署手册。代码已经写好，本文只讲**在 Cloudflare 上要做什么**，以及每一步怎么验证。

功能本身包括：账号注册/登录、把当前作品（参数 + 索引压缩后的像素网格 + 原图 + 缩略图）存到云端、`/works` 作品管理页（列表 / 打开 / 更新 / 删除）。

> 数据流：浏览器 → 同源 `/api/*`（Cloudflare Worker）→ **KV**（用户与作品元数据）+ **R2**（网格二进制、原图、缩略图）。
> 网格用自定义的 `pbgrid-v1` 索引压缩格式，300×200 的图纸约 60KB（未压缩的 JSON 是 1.8MB 量级）。

---

## 0. 前置条件

- 已经能按 [Cloudflare 部署指南](./Cloudflare部署指南.md) 把本项目部署成一个 Worker（`wrangler deploy` 能成功）。
- 本地已 `npm install`。
- 能在本机跑 `npx wrangler login`（或准备好 `CLOUDFLARE_API_TOKEN`）。
- 选一个你要用的域名（自定义域或 `*.workers.dev` 都可以）。后文用 `<你的域名>` 代指。

下面 4 步（KV、R2、Secret、部署）做完功能才可用。**只做部署不做前 3 步，接口会返回 `SERVER_NOT_CONFIGURED`**，页面上的表现是中文报错提示，而不是白屏。

---

## 1. 创建 KV 命名空间（存元数据）

### 方式 A：命令行

```bash
npx wrangler kv namespace create PB_KV
```

输出里会有一行形如：

```
[[kv_namespaces]]
binding = "PB_KV"
id = "a1b2c3d4e5f60718293a4b5c6d7e8f90"
```

记下这个 **32 位十六进制 id**。

### 方式 B：控制台

Cloudflare Dashboard → **Storage & Databases** → **KV** → **Create instance**，名字随便填（例如 `perler-beads-ai-kv`），创建后在列表里复制 **Namespace ID**。

### 回填 id

打开仓库根目录的 `wrangler.jsonc`，把占位的 32 个 0 换成上面拿到的 id：

```jsonc
"kv_namespaces": [
  {
    "binding": "PB_KV",
    "id": "a1b2c3d4e5f60718293a4b5c6d7e8f90"
  }
]
```

> `id` 保持 `00000000000000000000000000000000` 只能本地跑 `npm run preview`（Wrangler 用本地模拟的 KV，不校验这个值）。真部署必须换掉，否则读写的是不存在的命名空间。

---

## 2. 创建 R2 存储桶（存网格与图片）

### 方式 A：命令行

```bash
npx wrangler r2 bucket create perler-beads-works
```

### 方式 B：控制台

Dashboard → **R2** → **Create bucket**，名字填 `perler-beads-works`，位置按需选（离你近的即可）。

桶名必须和 `wrangler.jsonc` 里的一致，否则 `wrangler deploy` 会直接报错：

```jsonc
"r2_buckets": [
  {
    "binding": "PB_R2",
    "bucket_name": "perler-beads-works"
  }
]
```

> R2 需要先在控制台开通一次（首次开通会要求绑支付方式，免费额度内不产生费用）。

---

## 3. 配置 AUTH_SECRET（会话签名密钥）

登录态用的是自签的 HS256 JWT，签名密钥就是 `AUTH_SECRET`。它必须是**随机且足够长**的字符串，长度建议 ≥ 32 字节。

先生成一个：

```bash
# 任选一条
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
openssl rand -base64 32
```

### 方式 A：命令行

```bash
npx wrangler secret put AUTH_SECRET
# 粘贴上面的随机串并回车
```

### 方式 B：控制台

Dashboard → **Workers & Pages** → `perler-beads-ai` → **Settings** → **Variables and Secrets** → **Add**：

| 字段 | 值 |
| --- | --- |
| 名称 | `AUTH_SECRET` |
| 类型 | **Secret** |
| 值 | 上面生成的随机串 |

**Production 和 Preview 都勾上**，保存后点一次 **Retry deployment**（或按第 4 步重新部署），否则当前版本读不到新变量。

> 换掉 `AUTH_SECRET` 会让所有已登录用户的会话立即失效，需要重新登录。作品数据不受影响。

---

## 4. 部署

```bash
npm run build      # next build + 编译 functions/ 为 Worker + 生成 out/.assetsignore
npm run deploy     # wrangler deploy
```

保持 `wrangler.jsonc` 里的 `"keep_vars": true`，否则每次部署都会把面板上添加的**明文**变量删掉（AI 优化会因此报 `HMAC key length (0)`）。

如果你用 GitHub 自动部署，Build command 与 Deploy command 不变（`npm run build` / `npx wrangler deploy`），只需确认 KV、R2 绑定和 `AUTH_SECRET` 已经配置好。

---

## 5. 验证

打开 `https://<你的域名>/`，右上角应该出现 **我的作品 / 登录 / 注册**。

```bash
# 1) 健康检查：未登录时应当返回 {"user":null} 且 HTTP 200
curl -i https://<你的域名>/api/auth/me

# 2) 注册（应返回 201 与 user 对象，并下发 pb_session Cookie）
curl -i -X POST https://<你的域名>/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"username":"smoketest","password":"secret123"}'
```

若第 1 步返回 `SERVER_NOT_CONFIGURED`，说明 `AUTH_SECRET` 或 KV 绑定没生效，回第 1、3 步检查（提示文案里会列出缺哪个）。

页面侧走一遍：

1. `/register` 注册一个账号 → 自动跳到 `/works`；
2. 回 `/` 上传一张图，生成图纸后点 **保存到云端** → 填名称 → 保存；
3. 顶部 **我的作品** → 能看到刚保存的作品和缩略图；
4. 点 **打开** → 回到 `/` 并且图纸被完整还原（含手动编辑过的格子）；
5. 改点东西再点 **更新云端作品**；
6. 在 `/works` 里 **删除**（删两次确认）。

---

## 6. 本地开发与联调

本地用 Wrangler 的模拟 KV / R2，**不需要**真的建命名空间。

1. 在仓库根目录建 `.dev.vars`（已在 `.gitignore` 中）：

   ```ini
   AUTH_SECRET=随便一串足够长的随机字符
   VOLC_ACCESS_KEY_ID=...        # AI 优化才需要
   VOLC_SECRET_ACCESS_KEY=...    # AI 优化才需要
   ```

2. 启动完整环境：

   ```bash
   npm run preview     # http://127.0.0.1:8787
   ```

   `npm run dev`（`next dev`）下 `/api/*` 全部 404，这是 `output: "export"` 的预期行为，联调请用 `npm run preview`。

3. 本地 Cookie 不带 `Secure`（请求是 http），线上自动带 `Secure`（https），代码里按请求协议判断，无需手动切换。

> 若 Wrangler 因 `~/.config` 只读而启动失败，把配置目录指到可写位置：
> `XDG_CONFIG_HOME=/tmp/wrangler-config npx wrangler dev`。

---

## 7. 接口一览

所有接口同源，路径以 `/api` 开头；除注册/登录外都要登录态。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/register` | 注册，成功 201，返回 `{user}` 并下发会话 Cookie |
| POST | `/api/auth/login` | 登录，成功 200，返回 `{user}` 并下发会话 Cookie |
| POST | `/api/auth/logout` | 退出，清除会话 Cookie，返回 `{ok:true}` |
| GET | `/api/auth/me` | 当前用户，**未登录时也是 200**，返回 `{"user":null}` |
| GET | `/api/projects` | 作品列表（不含网格正文），按更新时间倒序，含 `thumbnail_url` |
| POST | `/api/projects` | 新建作品，返回 201 与完整作品对象 |
| GET | `/api/projects/:id` | 作品详情，含 `grid_data`（base64 的索引压缩网格） |
| PUT | `/api/projects/:id` | 更新作品；只覆盖请求里出现的字段，`version` 自增 |
| DELETE | `/api/projects/:id` | 删除作品（先删 KV 记录，再删该作品目录下的所有 R2 对象） |
| GET | `/api/quota` | 当前 R2 用量与自设上限（存储字节数、Class A / Class B 次数、重置时间） |
| GET | `/api/files/:path` | 读取 R2 对象（原图 / 缩略图 / 网格），需登录且路径属于自己 |
| POST | `/api/ai-optimize` | 已有的 AI 优化接口，本次未改动 |

鉴权方式：浏览器用 HttpOnly Cookie（`pb_session`，SameSite=Lax，30 天）；同时接受 `Authorization: Bearer <token>`，为以后接小程序/第三方客户端预留。

错误响应统一为 `{"error": "<CODE>", "message": "<中文说明>"}`，`message` 可以直接展示给用户。

---

## 8. 数据存在哪

### KV

| Key | 内容 |
| --- | --- |
| `user:id:{userId}` | 用户记录（含 PBKDF2 派生的 `password_hash` / `password_salt`） |
| `user:name:{小写用户名}` | 用户名 → userId 的索引（用户名唯一且大小写不敏感） |
| `proj:{userId}:{projectId}` | 作品元数据（列表就是按这个前缀列举出来的；`bytes` / `file_bytes` 记录该作品占用的字节数） |
| `quota:r2:bytes` | R2 桶当前占用的总字节数（配额记账，见下一节） |
| `quota:r2:ops:YYYY-MM` | 本月 R2 操作次数，形如 `{"a":12,"b":34}`，跨月自动开新账 |

用户记录里预留了 `wechat_openid` / `wechat_unionid` 字段和 `user:wx:{openid}` 索引位，本期没有写入——以后要接微信登录时可以直接用，不需要迁移已有数据。

### R2

```
u/{userId}/{projectId}/grid.bin          索引压缩网格（pbgrid-v1）
u/{userId}/{projectId}/original.{ext}    原图
u/{userId}/{projectId}/ai.{ext}          AI 优化图（预留，本期未写入）
u/{userId}/{projectId}/thumb.png         列表缩略图
```

`/api/files/:path` 会先校验请求路径以 `u/{当前用户 id}/` 开头，不属于自己的对象一律 403，其他人即使猜到路径也拿不到。

### 网格格式 `pbgrid-v1`

紧凑二进制：`PBG1` 魔数(4B) + 版本(1B) + flags(1B) + N(4B LE) + M(4B LE) + 颜色数(4B LE) + 调色板表（每项：key 长度+key、hex 长度+hex、flags） + `N×M` 个色号下标。

颜色种类 ≤ 256 时每格 1 字节，超过则自动切到 2 字节。实测：

| 网格 | 未压缩 JSON | 压缩后 |
| --- | --- | --- |
| 300×200，41 种颜色 | 1.83 MB | **59.1 KB** |
| 300×200，291 种颜色 | 1.88 MB | 121.1 KB（2 字节下标） |

编解码器在 `src/utils/gridCodec.ts`，服务端（`functions/api/_lib/projects.ts`）复用了同一个文件做校验，不存在前后端两套实现走偏的问题。

### 用量上限与自设配额

R2 免费额度是 **10 GB 存储 + 100 万次 Class A 操作 + 1000 万次 Class B 操作**，
超出后按量计费。为了不出现"某天批量导入把用量顶进计费区间"这种事，
应用按免费额度的**十分之一**自我约束：

| 项目 | 默认上限 | Class A / B | 环境变量 |
| --- | --- | --- | --- |
| 存储总量 | **1 GiB**（1024³ 字节） | — | `R2_STORAGE_LIMIT_BYTES` |
| 写入 / 列举 / 删除 | — | **Class A**：100,000 次/月 | `R2_CLASS_A_LIMIT` |
| 读取 | — | **Class B**：1,000,000 次/月 | `R2_CLASS_B_LIMIT` |

超限时的行为：

- 存储写满 → 保存/上传返回 **HTTP 507 `STORAGE_QUOTA_EXCEEDED`**，消息里写明已用多少、本次还要写多少、上限多少，前端保存弹窗会原样显示。
- 操作次数用尽 → 返回 **HTTP 429 `R2_OPERATION_LIMIT_EXCEEDED`**，消息里写明重置时间。
- 读取超限同样会被拦（Class B 也计数），这样才不会出现"能读不能写"之外的账单盲区。
- 计数按 **UTC 自然月**滚动，下月 1 日 00:00 UTC 自动重置，**不需要手动清理**。

三个环境变量都是可选的，不配就用上表默认值；在 Cloudflare 控制台
Settings → Environment Variables 里加（Production / Preview 各配一次），
或在本地 `.dev.vars` 里加，然后重新部署。调试时可以把它调得很小来验证拦截行为：

```bash
# .dev.vars
R2_STORAGE_LIMIT_BYTES=1048576   # 1 MiB，随便存一张图就会超
R2_CLASS_A_LIMIT=3               # 第 4 次写入就拒绝
R2_CLASS_B_LIMIT=3
```

**为什么是应用自己记账**：R2 没有"查询当前用量"的接口，控制台面板也不能被程序读取。
所以每次经过 `functions/api/_lib/quota.ts` 里 `r2PutObject` / `r2GetObject` /
`r2DeleteObjects` / `r2ListObjects` 这四个包装函数的操作都会计数。
**新增 R2 访问时必须走这四个函数**，直接用 `getR2(env).put(...)` 会绕过计数，配额就形同虚设。

两个已知的精度限制（都只会**少记**，所以不会突破上限，只会略微放宽）：

1. KV 没有原子自增，同一时刻的并发请求可能丢掉个别计数——个人自用规模下可以忽略。
2. 存储总量按"读到的当前值 + 本次新增"判断，两个请求同时通过检查时最多超出几 MB。

要做到绝对精确需要引入 D1 或 Durable Object，对这个项目不值得。

用量面板在 `/works` 页面顶部（存储进度条 + 本月操作次数），接近上限时变红提示。
若计数键意外丢失，下次读取会遍历 `proj:` 前缀的所有作品元数据**自动重算并回填**，不需要人工干预。

想手动清零（比如把用量面板复位）：

```bash
npx wrangler kv key delete --binding=PB_KV "quota:r2:bytes"
npx wrangler kv key delete --binding=PB_KV "quota:r2:ops:$(date -u +%Y-%m)"
```

注意清掉 `quota:r2:bytes` 只会让计数器归零（下一次读会立刻按现有作品重算），
**不会删除任何作品数据**。

---

## 9. 常见问题

**Q：接口返回 `SERVER_NOT_CONFIGURED`。**
缺 `AUTH_SECRET`，或 KV 绑定没生效。`message` 里会列出缺哪一项。检查第 1、3 步，确认 Production/Preview 都配了，并重新部署一次。

**Q：部署报错说找不到 KV namespace / bucket。**
`wrangler.jsonc` 里的 `id` 还是占位的 32 个 0，或者 `bucket_name` 和实际桶名不一致。

**Q：注册时提示用户名已存在，但我是第一次用。**
用户名是大小写不敏感的（`SmokeTest` 与 `smoketest` 视为同一个）。

**Q：登录后在 `/works` 刷新就变回未登录。**
Cookie 没发出去。确认走的是同一个域名（不要 https 和 http 混用），并且没有把 `/api/*` 反向代理到别处、丢掉 `Set-Cookie`。

**Q：上传大图失败，提示原图过大。**
单张原图上限 8MB、缩略图 1MB、网格 4MB。先裁剪或者换小一点的图。

**Q：更新作品后原图不见了。**
正常情况下不会：更新时不传 `images.original` 就保持原样。只有换了图片格式（png → jpg）时才会删掉旧对象并写入新 key。

**Q：想换掉会话密钥。**
`npx wrangler secret put AUTH_SECRET` 重新设置即可，代价是所有人需要重新登录，作品数据不受影响。

**Q：保存时提示"超过自设上限"（HTTP 507 / 429）。**
碰到了应用自己的配额，不是 Cloudflare 的硬限制。先去 `/works` 删掉一些不再需要的作品；
确实需要更多空间，就调高 `R2_STORAGE_LIMIT_BYTES` / `R2_CLASS_A_LIMIT` / `R2_CLASS_B_LIMIT`
（见「用量上限与自设配额」）后重新部署。

**Q：`/works` 顶部的用量数字看着不准。**
这是应用自己记的账，与 Cloudflare 控制台的计费口径可能有微小偏差（并发少记、跨月边界）。
误差只可能让实际用量比面板显示的**更少**，不会出现"面板说没满、实际已被计费"的情况。

---

## 10. 相关文档

- [Cloudflare 部署指南](./Cloudflare部署指南.md) — 整体部署方式、环境变量、常见问题
- [双端云保存待办](../规划/双端云保存待办.md) — 立项时的方案与取舍（小程序端尚未接线）
