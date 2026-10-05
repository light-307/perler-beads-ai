// `wrangler pages functions build` 会把 functions/ 编译到 out/_worker.js/。
// Wrangler 检测到静态资源目录里存在 _worker.js 时会拒绝部署（怕把服务端代码当静态文件公开），
// 要求在同目录放一个 .assetsignore 明确排除它。该文件在 out/ 里，不能提交到仓库，
// 所以每次构建后由这个脚本生成。
import { writeFileSync } from "node:fs";

writeFileSync("out/.assetsignore", "_worker.js\n");
