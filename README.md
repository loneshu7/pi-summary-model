# pi-summary-model

给 [Pi](https://pi.dev) 单独指定压缩摘要模型。日常对话继续使用当前模型，自动压缩和 `/compact` 从一开始就交给固定的摘要模型。

例如：主会话使用你配置的服务，摘要固定使用通过 `/login` 登录的 OpenAI Codex 订阅。扩展不会切换主会话模型，也不会在某个服务拒绝请求后改用另一个账号重试。

## 要求

- Pi **0.86.0**（本版本验证基线；后续版本需检查 API 兼容性）。
- Node.js **22.19.0 或更新版本**（与 Pi 0.86.0 的要求一致）。
- 摘要模型已出现在 Pi 模型目录中，并已配置可用认证。OpenAI 订阅使用 Pi 内置的 `openai-codex` provider。

## 安装与设置

```sh
pi install git:github.com/loneshu7/pi-summary-model
```


```sh
pi install /absolute/path/to/pi-summary-model
```

在已经运行的 Pi 会话中执行：

```text
/reload
/login
/summary-model select
/summary-model status
```

`/login` 中选择对应订阅服务；已经登录时可跳过。模型选择器会列出可用模型，优先展示 `openai-codex`。首次安装未配置模型时，扩展会停止压缩并提示设置，避免意外使用当前对话模型生成摘要。

也可以指定精确的 provider 和 model ID：

```text
/summary-model set openai-codex gpt-5.5
```

模型是否可用取决于你的账户和本机模型目录。以上 ID 只是示例，以选择器中的实际模型为准。设置成功后可用 `/compact` 验证一段普通开发对话。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/summary-model status` | 查看摘要路由和配置状态 |
| `/summary-model select` | 从可用模型中选择并保存摘要模型 |
| `/summary-model set <provider> <modelId>` | 用精确 ID 设置并启用摘要模型，适用于无交互调用 |
| `/summary-model off` | 明确停用扩展路由，恢复 Pi 默认压缩 |
| `/summary-model on` | 重新启用已保存且有效的摘要模型 |

模型选择保存在 Pi 的全局配置目录 `summary-model.json` 中，通常为 `~/.pi/agent/summary-model.json`，遵循 `PI_CODING_AGENT_DIR`。配置不保存在当前项目或仓库里。

```json
{
  "enabled": true,
  "provider": "openai-codex",
  "model": "gpt-5.5"
}
```

配置仅保存开关和模型标识。认证由 Pi 处理，包括 OAuth 更新。扩展不会复制 token、修改 `auth.json` 或把凭据写进仓库。变更会在下次压缩时读取，正在进行的压缩继续使用开始时的模型。

## 工作方式

```text
日常对话与工具执行 ── 当前会话模型
自动压缩 / 手动 compact ── 固定摘要模型 ── Pi 保存摘要和近期消息
继续原任务 ── 当前会话模型
```

扩展通过 `session_before_compact` 接管摘要请求，并复用 Pi 的原生 `compact()`。它保留原生摘要格式、历史摘要合并、长轮次拆分、近期消息边界、文件操作记录、用量统计和 `/compact` 的自定义关注点。

- 自动压缩成功后的任务续跑由 Pi 管理；扩展不注入额外用户消息，也不重复执行工具。
- 模型不存在、未登录、网络请求失败、服务返回可识别的错误或结构化拒绝、输出为空或被截断时，取消本次压缩并提示原因。失败不会保存成摘要，也不会自动回落到主会话模型。
- OpenAI Responses / Codex 摘要请求使用 SSE，并在协议解析前检查结构化拒绝；不会仅凭摘要正文里出现“policy”或“refusal”等词判断失败。
- 按 Esc 可以取消请求。扩展关闭自身重试和 Codex SSE 请求重试；自定义 provider 若忽略传输参数，其内部行为由该 provider 决定。
- 错误提示使用受限分类，不打印原始服务响应或认证字段。

**摘要会将需要压缩的历史内容发送到你选定的摘要服务，并计入该服务的额度。** 选择不同服务时，请确认这符合你的项目数据要求。

## 范围与限制

- 仅接管自动压缩和 `/compact`，不接管 `/tree` 的分支摘要。
- 压缩触发阈值和近期保留量仍由 Pi 当前会话的压缩设置决定。
- 摘要模型必须有足够的上下文容量处理待压缩历史。选用明显小于主会话上下文的模型可能导致请求失败；扩展不会为适配小模型而静默丢弃历史。
- 请停用其他同样返回自定义摘要的 `session_before_compact` 扩展。Pi 对多个成功结果采用后者覆盖前者的规则。
- 扩展不会消除服务端安全限制或保证任何内容都能被摘要。服务明确拒绝时，本次压缩停止。
- 如果服务把拒绝完全包装成普通成功文本、没有结构化拒绝标记，扩展无法可靠区分它与真实摘要；其他 API 的私有拒绝格式也未做通用适配。
- 协议观察器对单个 SSE 事件设置 1 Mi 字符上限；超限时取消压缩，避免无限缓存。Azure Responses 使用相同观察器，但未单独完成 provider 集成回归。
- 当全局 JSON 配置损坏时，先修正文件；扩展不会静默覆盖损坏配置。

## 开发

```sh
npm ci
npm run typecheck
npm test
```

测试使用真实的 Pi 压缩函数和可控的本地假模型流，覆盖路由、摘要完整性、错误取消、配置和命令，不发送真实会话或消耗模型额度。GitHub Actions 在 Windows / Linux 的 Node 22 环境运行相同检查。

验证记录见 [docs/validation.md](docs/validation.md)。设计见 [docs/design.md](docs/design.md)。

## 许可证

MIT，见 [LICENSE](LICENSE)。
