# 运维平台（ks-scmms）对接适配层

本目录是**平台侧**适配代码的归拢与交付点，与 DSH 侧插件 [`packages/platform/scmms-relay`](../../packages/platform/scmms-relay/README.md) 配套使用。其他团队对接本平台时，取本目录 + scmms-relay 插件 + 根目录 `platform.patch.yml` 即可，无需 aiops 控制台代码。

## 组成

| 位置 | 内容 | 部署方式 |
| --- | --- | --- |
| `server-aiops/views/solutions.go` | 诊断方案闭环：方案接收/审批/SSH 下发执行/结果回收 | 编入 `ks-scmms-server`（`router/aiops/views/`），替换二进制重启 |
| `server-aiops/views/solutions_page.go` | 人工审批页面（服务器端渲染） | 同上 |
| `server-aiops/url.go` | 路由注册（含 Bearer/会话认证边界说明） | 编入 `router/aiops/url.go` |
| `ui/Copilot-index.vue` | 运维 Copilot 面板组件（方案审批卡 + 权限申请卡） | 编入 `ks-scmms-ui` 构建后同步 `/var/www/` |

## 部署要点

1. **Go 服务**：三个 Go 文件放入 fork 的 `router/aiops/`（views 两个、url.go 一个），另需在 `pkg/middleware/auth.go` 的 `RequestWhiteUrl` 白名单加入 `"/api/aiops/solutions"`（JSON API 由处理器自校验 Bearer，审批页面保持平台会话保护）。
2. **构建**：`go build -o build/kscmms-agent-server cmd/kscmms-server.go`（需 Go ≥ 1.22；仓库内无 Go 工具链时可用 `go.dev` 官方包解压到 `/usr/local/go`）。
3. **执行通道**：`/usr/local/scmms/cert/aiops-exec-key`（ed25519 私钥，公钥分发到各节点 root 的 authorized_keys）；节点地址映射 `/usr/local/scmms/aiops-exec-nodes.json`（`{"节点名":{"host":"IP","port":22,"user":"root"}}`）。
4. **口令**：JSON API 的 Bearer 口令与 MCP 端点共用 `/usr/local/scmms/mcp-tokens.json`（`{"账号":"口令"}`）。
5. **UI 构建**：老 webpack 需 `NODE_OPTIONS=--openssl-legacy-provider npm run build`；产物同步 `/var/www/`（先备份）。
6. **回滚**：替换前备份旧二进制（`kscmms-agent-server.bak.<date>`）与 `/var/www/bak.<date>/`，回滚即换回重启。

## 接口一览（平台侧新增）

| 端点 | 认证 | 说明 |
| --- | --- | --- |
| `POST /api/aiops/solutions` | Bearer | 接收 DSH 推送的诊断方案（title/question/plan/tools） |
| `GET /api/aiops/solutions[?status=&limit=]` | Bearer | 方案列表 |
| `GET /api/aiops/solutions/:id` | Bearer | 方案详情（含动作条目） |
| `POST /api/aiops/solutions/:id/approve` | Bearer | 人工批准 → 后台逐条 SSH 下发执行 |
| `POST /api/aiops/solutions/:id/reject` | Bearer | 人工驳回 |
| `GET /api/aiops/solutions/:id/executions` | Bearer | 执行结果（输出 + `[exit=N]`） |
| `GET /aiops/solutions` | 平台会话 | 人工审批页面 |

命令级容错：探针缺失/指标不存在只记 `[exit=N]` 不中断批次；仅 SSH 不可达/超时熔断后续条目。
