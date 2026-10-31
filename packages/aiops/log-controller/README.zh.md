---
description: "广汽二期智能运维控制台的智能体活动日志：会话日志投影、筛选分页与 aiopsLogs 命名空间。"
kind: "package-reference"
---

# @gac2/dsh-aiops-log-controller

[English](README.md) | 中文

## 概述

为广汽二期智能运维控制台挂载智能体活动日志查询。本包把控制台管理的智能体（及 A2A 内部委托目标）的已提交会话事件投影为日志行——轮次边界、已提交模型输出、中断尝试、与调用配对后的工具结果——并经 `aiopsLogs` Remote 命名空间提供可筛选的分页查询。每次查询都从持久化会话日志现算，不产生会漂移的影子存储；控制台的"详情"打开所属会话的轨迹页查看。

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在 Web 组合中挂载 `@gac2/dsh-aiops-log-controller`（见 `aiops.patch.yml`），与 `@gac2/dsh-aiops-agent-controller` 及会话查询服务并列。配置项包括 `maxSessions`（每次查询检查的最近会话数，默认 30）和 `innerPresetIds`（同样纳入日志视图的委托目标预设，默认 `sys-agent`/`hpc-agent`）。控制台经 `ctx.remote.aiopsLogs.query({ keyword, kind, fromMs, page, pageSize })` 查询，详情打开所属会话的轨迹页。

## 模型体验

本包只读取已提交的会话日志，不构造任何模型输入，故无模型体验变化。

#### KV Cache 影响

不改变模型请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 每次查询重读最近 `maxSessions` 个会话日志；规模上来后再引入生成的投影存储。
- 知识检索（RAG）日志行在召回链路提交自己的会话事件后出现。
- 日志详情停留在所属会话的轨迹视图；本模块不重复建设完整日志浏览器。

<a id="dev-note"></a>
### 开发说明

查询输入在 Remote 边界经 zod 校验；投影只做"已提交事件 → 日志行"的纯函数映射，工具名经 tool/call 与 tool/result 的 toolCallId 配对恢复。
