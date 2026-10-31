---
description: "持久化的控制台智能体注册表：动态预设生命周期与面向浏览器的 aiopsAgents 命名空间。"
kind: "package-reference"
---

# @gac2/dsh-aiops-agent-controller

[English](README.md) | 中文

## 概述

为广汽二期智能运维控制台挂载智能体注册表。本包将智能体定义持久化到 JSON 注册表文件，并以隐藏的部署模板为模板将每个定义注册为动态 Agent 预设。首次启动时播种默认的运维智能体（统一诊断入口，内部协同 HPC 智能体与系统智能体）；此后注册表文件是唯一真源，控制台的编辑与销毁跨重启保留。`aiopsAgents` Remote 命名空间提供清单（含按预设聚合的会话统计）与创建、更新、销毁。模板预设本身不出现在清单中。

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在 Web 组合中挂载 `@gac2/dsh-aiops-agent-controller`（见 `aiops.patch.yml`），与预设注册表、会话持久化并列。配置项包括 `storePath`（注册表 JSON 路径，默认 `~/.dsh/storages/aiops-agents.json`）、`templatePresetId`（注册智能体时克隆的模板预设，默认 `os-agent`）、`modelLabel`（卡片模型标注；不支持按智能体覆盖模型）、`templateWaitMs`（模板预设就绪的启动等待上限）和 `seedAgentsJson`（注册表文件尚不存在时播种的定义，JSON 编码）。浏览器控制台经 `ctx.remote.aiopsAgents` 读取与变更清单；`ClientSessions.create({ agentPreset })` 将新会话绑定到任一列出的预设。

## 模型体验

间接地，通过它注册的动态 Agent 预设影响模型：每个创建的智能体的 persona 前缀替换模板 persona，定义文本仅在有会话真正以该预设运行时才进入模型提示词。

#### KV Cache 影响

本包自身不增加模型可见前缀。组合预设的 persona 拥有提示词前缀，形态与部署中的静态预设一致。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 不支持按智能体覆盖模型；所有智能体跟随部署默认模型。
- 会话统计来自持久化会话头（数量与最新创建时间）；标题与轮次级活跃信息后续提供。
- 销毁智能体后其历史会话仍可查看，但恢复一个预设已删除的会话会按设计响亮失败。
- 按账户的范围过滤是浏览器侧展示过滤，不是服务端授权边界。

<a id="dev-note"></a>
### 开发说明

注册表文件是动态智能体唯一的写方真源，写盘原子化（先写同目录临时文件再改名）。预设注册是宿主侧职责：命名空间先持久化，再向 `agentPresets` 注册或注销预设，因此注册失败不会留下没有可见诊断的持久化定义。
