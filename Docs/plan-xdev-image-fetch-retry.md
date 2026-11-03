# 计划：xdev 头部配图 fetch 的传输层重试

## 现场

2026-11-02T04:41Z 的一次 xdev 运行在 Stage 5（`asset-generation`）失败：

```
💥 xdev Pipeline failed at [asset-generation]: fetch failed
[cause]: SocketError: other side closed   code: 'UND_ERR_SOCKET'
socket: { localAddress: '198.18.0.1', remoteAddress: '198.18.0.111', remotePort: 443,
          bytesWritten: 596, bytesRead: 0, timeout: undefined }
```

`bytesRead: 0` + `timeout: undefined` = 请求已发出、对端一个字节都没回就关闭连接。既不是 4xx/5xx（那样会打印网关原文），也不是超时，更不是模型不可用。

## 已排除

- 同一 `.env`、同一端点、同一模型 `sensenova-u1.5-lite`、同一 payload，手工 curl：**HTTP 200 / 20.2s / 1.55MB b64**，正常出图。
- 同一份代码 2026-11-01T12:30Z 成功生成过 `header-image-2026-11-01T12-30-14-596Z.png`（1.29MB）。
- 同一进程随后还有 `[sendToPi] Warning: Failed to send to Pi: fetch failed`：那一刻本机出网（mihomo TUN，`198.18.0.0/16` fake-IP）整体抖动。

结论：**传输层瞬时故障**，配置无误。

## 代码缺陷（要修的）

`src/pipelines/xdev/image-generator.ts`：

1. 零重试 —— 一次 socket reset 终止整条 7 阶段流水线，前面搜索 / Grok / 长文抓取（30+ 分钟）全部作废。
2. 零超时 —— 没有 `AbortSignal.timeout`，网关半死要等 undici 默认 300s。
3. 错误信息丢失 —— 只剩 `fetch failed`，`other side closed` 埋在 cause 里，告警不可定位。

## 改动

### `src/pipelines/xdev/image-generator.ts`

- 新增 `GatewayRejection`（HTTP 层拒绝）：**永不重试**，保留原有 `FATAL: Gateway image generation failed ...` 日志与消息。
- 新增 `TRANSIENT_CODES`（`UND_ERR_SOCKET` / `UND_ERR_CONNECT_TIMEOUT` / `UND_ERR_HEADERS_TIMEOUT` / `UND_ERR_BODY_TIMEOUT` / `ECONNRESET` / `ECONNREFUSED` / `EPIPE` / `ETIMEDOUT` / `EAI_AGAIN`）与 `TimeoutError` 判定。
- 新增 `withTransportRetry(label, run)`：仅对上述传输层错误重试，默认 3 次尝试、退避 2s / 6s；最终失败抛
  `[image-generator] <label> failed after 3 transport attempt(s): UND_ERR_SOCKET: other side closed`（带 `cause`）。
- POST `/images/generations` 与（若返回 url 的）图片下载都走该包装，并加 `AbortSignal.timeout(180_000)`。
- 成功日志补耗时：`✔ Real header image successfully generated: <path> (20.2s)`。
- 退避时长可用 `IMAGE_RETRY_BACKOFF_MS`（逗号分隔，默认 `2000,6000`）覆盖，仅供测试缩短等待；不影响生产默认值。

**不做**：不改换模型、不降级成占位图、不吞掉最终失败——重试耗尽仍抛错并触发原有告警。

### `tests/xdev-image-retry.test.ts`（新增）

本地桩服务器 + `process.env.BASE_URL/API_KEY/IMAGE_MODEL` 覆盖（`getEnvConfig` 里 `process.env` 优先于 `.env`）：

1. 前两次直接 `socket.destroy()`（模拟 `other side closed`），第三次返回 b64 → 断言**恰好 3 次请求**、文件按 base64 写入、内容正确。
2. 网关返回 400 → 断言**恰好 1 次请求**、错误信息包含网关原文（不重试）。
3. 三次全部断连 → 断言 3 次请求，错误信息含 `failed after 3 transport attempt(s)` 与 `other side closed`。

## 验证

1. `npx tsc --noEmit`（或 `npm run build`）通过。
2. `npx tsx --test tests/xdev-image-retry.test.ts` 通过。
3. `npm test` 全量不回归。
4. 真实重跑一次 xdev（tmux 具名会话），确认 Stage 5 出图并走完 Stage 6/7，产物补齐到 `artifacts/xdev/`。
