---
description: "广汽二期智能运维控制台 Web 插件，提供智能体、RAG、skills、日志、记忆和 MCP 管理页签。"
kind: "package-reference"
---

# @gac2/dsh-client-ui-aiops

[English](README.md) | 中文

## 概述

在 DSH Web 侧边栏和主面板中加入智能运维控制台。控制台包含智能体、RAG、skills、日志、记忆和 MCP 六个管理页签，跟随当前主题，并通过既有账号与会话入口进入诊断会话。

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

通过 `aiops.patch.yml` 挂载 `@gac2/dsh-client-ui-aiops`。插件提供侧边栏入口、控制台面板、本地化文案和按账号过滤的视图。智能体管理页为真实数据：经 `@gac2/dsh-aiops-agent-controller` 提供的 `aiopsAgents` Remote 命名空间读取与变更智能体清单，"打开会话"经工作区导航创建绑定所选预设的会话。

## 模型体验

控制台不增加模型可见内容。运维智能体身份和工具组合由 `aiops.patch.yml` 或 `aiops-headless.patch.yml` 提供；本包不贡献提示词或工具行为。

#### KV Cache 影响

不改变模型请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- RAG、skills、日志、记忆、MCP 页签在对应服务提供前仍使用原型数据；当前仅智能体管理页接入真实服务。
- 当前联调的账号过滤仅发生在浏览器本地，不构成服务端授权边界。

<a id="dev-note"></a>
### 开发说明

本包为广汽二期部署专用，由仓库内的 `aiops.patch.yml` 挂载。
