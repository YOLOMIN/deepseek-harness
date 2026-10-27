---
description: "用于广汽二期控制台入口、免登票据透传、平台健康检查和 Headless Copilot 的 Cordis 路由。"
kind: "package-reference"
---

# @gac2/dsh-aiops-auth-relay

[English](README.md) | 中文

## 概述

在隔离的 DSH `webServer` 上挂载广汽二期运维集成。插件提供控制台跳转（注入 dsh 访问 token、透传平台签发的免登票据）、平台健康检查和 Headless Copilot 转发，无需独立中继进程。

平台账户体系对接不经过本插件：运维平台以标准接口形式对外提供认证适配协议（`POST /api/aiops/login` 账号口令认证、`POST /api/aiops/ticket` 免登票据签发、`POST /api/aiops/ticket-login` 票据核销、`GET /api/aiops/health` 健康检查），控制端"平台对接"设置直接指向平台接口；控制端替换为其他实现时对接协议保持不变。

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

在隔离 `webServer` 的 Cordis group 中，将 `@gac2/dsh-aiops-auth-relay` 与 `@deepseek-ai/dsh-host-webserver` 一起挂载。`aiops.patch.yml` 使用 `127.0.0.1:3081`，主 Web 应用继续使用 `3080`。

配置项包括 `platformOrigin`、`dshRoot`、`sessionCwd`、`consoleLogPath` 和 `requestTimeoutMs`，默认指向当前广汽平台和代码检出。模型凭据通过 `ctx.credentials` 读取；平台口令、Cookie 和 MCP Token 不进入普通设置。

## 模型体验

Copilot 将用户消息转发给使用 `aiops-headless.patch.yml` 的普通 `headless` Profile，并把 NDJSON 的 `session`、正文、思考、工具、状态、完成和错误事件转换为 SSE 事件。每个请求启动一个子进程，插件卸载或客户端断开都会终止该进程。

#### KV Cache 影响

插件不增加模型可见前缀。模型上下文由普通 Headless Profile 及其 persona 管理。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 控制台跳转从配置的 DSH 启动日志读取当前 token。日志轮换后需要重启 DSH，控制台入口才能继续工作。
- 智能体预设中的 MCP 工具注册与这些集成路由分开配置。

<a id="dev-note"></a>
### 开发说明

`aiops.patch.yml` 管理隔离监听地址和部署路径。原有的外部 `relay/aiops-auth-relay.js` 脚本由本包替代；早期由本包承担的平台认证适配（SM3/SM4 登录、票据签发与核销）已下沉为运维平台标准接口，由平台侧直接提供。
