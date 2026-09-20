# 验证记录

验证环境：Windows，Node.js 24.18.0，Pi 0.86.0。

## 自动化与打包检查

- `npm test`：76 项通过，0 失败；包含 3 种压缩触发原因、拆分摘要逐响应校验、连续压缩文件记录、取消、配置损坏和多进程配置写入，以及真实 Responses/Codex provider 的本地协议回归。
- `npm run typecheck`：通过。
- Pi 原生包发现和 TypeScript 加载：通过。
- `npm pack` 后解包至不含 node_modules 的临时目录，使用本机 Pi 加载扩展：通过。
- `npm pack --dry-run`：仅源代码、package.json、README、LICENSE 和设计/验证说明，无凭据、配置或会话。
- 本机没有可用的相关默认 LSP 服务，静态验证使用 TypeScript 编译器完成。
- Node 最低版本为 22.19.0，与 Pi 0.86.0 一致；Windows/Linux Node 22 检查交由 CI。

## 实际宿主加载与订阅调用

使用本机安装的 Pi `loadExtensions()` 加载仓库的 `src/index.ts`，在临时 Pi 配置目录中调用 `/summary-model set` 和 `status`：

- 扩展加载成功，无加载错误。
- `summary-model` 命令已注册。
- `session_before_compact` 钩子已注册。
- 选择的 `openai-codex/gpt-5.6-sol` 使用现有 OAuth 登录。

随后调用实际钩子，仅发送一段虚构计算器开发进度，验证订阅链路：

```json
{
  "live": "passed",
  "calls": ["openai-codex/gpt-5.6-sol"],
  "summaryCharacters": 737,
  "preservedBoundary": true,
  "mainModelUnchanged": true,
  "usagePresent": true
}
```

没有读取或重发历史拒绝会话。临时测试配置已删除；认证由 Pi 模型运行时处理。上述实测验证的是扩展钩子到服务的链路，不等同于在真实超长会话中触发自动压缩的端到端测试。

实际订阅检查在 SSE/结构化拒绝修复后再次执行，结果如上。新增 30 项协议测试覆盖增量和最终拒绝事件、流末尾、分片 UTF-8/CRLF、取消与读取失败、单帧上限，以及 Codex 连接错误和 HTTP 429 不重发。拒绝数据来自本地合成服务，未使用用户历史。
