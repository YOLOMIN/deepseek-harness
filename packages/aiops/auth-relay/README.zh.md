---
description: "用于广汽二期控制台入口、免登票据透传、平台健康检查和 ACP Copilot 通道的 Cordis 路由。"
kind: "package-reference"
---

# @gac2/dsh-aiops-auth-relay

[English](README.md) | 中文

## 概述

在隔离的 DSH `webServer` 上挂载广汽二期运维集成：控制台跳转（注入 dsh 访问 token、透传平台免登票据）、平台健康检查和 Copilot SSE 通道，无需独立中继进程。Copilot 提示词运行在一个常驻 ACP 子进程（`dsh --profile acp`）上：每个浏览器会话是一个标准 ACP 会话，后续消息无需冷启动，客户端断开转为 `session/cancel`，子进程崩溃后下一条消息自动重建。平台账户体系对接直接使用运维平台的标准 `/api/aiops/*` 接口，不经过本插件；控制端替换为其他实现时对接协议保持不变。

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

在隔离 `webServer` 的 Cordis group 中，将 `@gac2/dsh-aiops-auth-relay` 与 `@deepseek-ai/dsh-host-webserver` 一起挂载。`aiops.patch.yml` 使用 `127.0.0.1:3081`，主 Web 应用继续使用 `3080`。

配置项包括 `platformOrigin`（每次部署必填）、`dshRoot`、`sessionCwd`、`consoleTarget`、`acpPatchPath`、`permission`（智能体工具权限提示的自动应答策略）和 `requestTimeoutMs`，均由挂载它的 patch（如 `aiops.patch.yml`）设置。跳转令牌取自同进程 `connection` 服务，模型凭据通过 `ctx.credentials` 读取；平台口令、Cookie 和 MCP Token 不进入普通设置。

## 模型体验

间接地，通过常驻 `acp` Profile 子进程承载 Copilot 会话：标准 ACP 的消息、思考和工具生命周期更新转换为 SSE 事件，模型上下文由 acp Profile 及其 persona patch 管理。

#### KV Cache 影响

插件不增加模型可见前缀。模型上下文由 acp Profile 及其 persona patch 管理。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 智能体预设中的 MCP 工具注册与这些集成路由分开配置。

<a id="dev-note"></a>
### 开发说明

`aiops.patch.yml` 管理隔离监听地址和部署路径。原有的外部 `relay/aiops-auth-relay.js` 脚本由本包替代；早期由本包承担的平台认证适配（SM3/SM4 登录、票据签发与核销）已下沉为运维平台标准接口，由平台侧直接提供。
