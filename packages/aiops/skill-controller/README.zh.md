---
description: "广汽二期智能运维控制台的 skill 管理：Nacos 技能库清单合并本地安装状态，经 aiopsSkills 命名空间安装/卸载 ZIP 技能包。"
kind: "package-reference"
---

# @gac2/dsh-aiops-skill-controller

[English](README.md) | 中文

## 概述

为广汽二期智能运维控制台挂载 skill 管理能力。控制器从部署的 Nacos 技能库（`/nacos/v3/console/ai/skills/list`）拉取清单，与 DSH 用户技能根目录的本地安装状态合并，并经 `aiopsSkills` Remote 命名空间提供安装（逐文件下载）与卸载（移除目录）。skill-filesystem 提供者监听技能根目录，安装无需重启即时生效。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Web 组合中挂载 `@gac2/dsh-aiops-skill-controller`（见 `aiops.patch.yml`）。配置字段：`registryOrigin`（必填，如 `http://192.168.10.95:8848`）、`namespaceId`（默认 `public`）、`skillsDir`（默认 `~/.dsh/skills`）、`requestTimeoutMs`（默认 15000）。控制台经 `ctx.remote.aiopsSkills.list({ keyword, page, pageSize })` 查询，按名称安装/卸载。

## 模型体验

本包只服务控制台管理视图，不构造任何模型输入；安装后的 skill 经 skill-filesystem 提供者与 `tool-skill` 到达模型，模型可见效果由它们各自声明。

#### KV 缓存影响

无模型请求前缀变化。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- 技能库清单一次拉取至多 200 条后在本地分页；服务端分页待注册中心数据量需要时再接。
- 上传/发布生命周期（`/upload`、审核、发布）留在 Nacos 控制台；DSH 控制台只消费与安装。

<a id="dev-note"></a>
### 开发说明

注册中心响应在 Remote 边界解包 Nacos `Result` 信封并校验；安装从 well-known 面逐文件下载到干净目录，卸载只移除本地目录——注册条目从不在此路径删除。
