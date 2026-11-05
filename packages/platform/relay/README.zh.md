---
description: "任意平台对接 DSH 的通用集成中继：控制台跳转、免登票据透传、Copilot 流式诊断、操作级人工确认与方案推送闭环。"
kind: "package-reference"
---

# @gac2/dsh-platform-relay

[English](README.md) | 中文

## 概述

任意平台对接 DSH 的**通用集成插件**（自 aiops 控制台代码拆出并通用化），平台侧按标准契约实现健康/认证/方案接口即可接入，与具体平台实现解耦。在隔离的 DSH `webServer`（默认 `127.0.0.1:3081`）上挂载四类能力：

- 控制台跳转（注入 dsh 访问令牌、透传平台免登票据与目标页签）；
- 平台健康检查（`/health` 透传 `/api/aiops/health`）；
- Copilot SSE 流式诊断通道（常驻 ACP 子进程 `dsh --profile acp`，浏览器会话即标准 ACP 会话）；
- 操作级人工确认（`permission: ask` 时权限请求挂起转 SSE 事件，`POST /api/aiops/permission` 回填）与方案推送闭环（答复完成时把方案与 `exec_actions` 动作块推送到平台 `/api/aiops/solutions`）。

平台账户体系对接使用平台侧按标准契约提供的 `/api/aiops/*` 接口（路径可配置）；首个参考实现随高性能集群监控平台仓库维护，本仓库只保留 DSH 侧通用插件。

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

以根目录 `platform.patch.yml` 挂载（独立取用）；与控制台同部署时叠加 `aiops.patch.yml`：`pnpm dsh --profile web --patch platform.patch.yml [--patch aiops.patch.yml]`。

配置项：`platformOrigin`（必填，如 `http://192.168.10.95:9091`）、`dshRoot`、`sessionCwd`、`consoleTarget`、`acpPatchPath`、`permission`（`allow`/`reject`/`ask`，ask 转成人工确认事件）、`sandboxMode`（注入子进程 `DSH_PERMISSION_MODE`，`read-only` 时写操作需人工确认）、`platformBearerToken`（方案推送 Bearer，空则关闭推送）、`solutionPushTimeoutMs`、`requestTimeoutMs`。跳转令牌取自同进程 `connection` 服务，模型凭据经 `ctx.credentials` 读取；平台口令不进普通设置。

## 模型体验

间接地，通过常驻 `acp` Profile 子进程承载 Copilot 会话：标准 ACP 的消息、思考和工具生命周期更新转换为 SSE 事件，模型上下文由 acp Profile 及其 persona patch 管理。

#### KV 缓存影响

插件不增加模型可见前缀。模型上下文由 acp Profile 及其 persona patch 管理。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 权限事件目前携带工具名与申请理由（不含完整入参）；ACP 桥接的 `rawInput` 透传留待上游补充。
- 沙箱升级为整会话粒度：同一会话内首次批准后同类写操作不再重复询问（DSH 沙箱既有语义）。

<a id="dev-note"></a>
### 开发说明

`platform.patch.yml` 管理隔离监听地址与部署路径；原外部 `relay/aiops-auth-relay.js` 脚本由本包替代，平台认证适配（SM3/SM4 登录、票据签发与核销）已下沉为平台标准接口。
