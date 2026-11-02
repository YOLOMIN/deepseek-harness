---
description: "广汽二期智能运维控制台的 MCP 接口管理：Nacos MCP 注册中心清单合并实时连接状态，经 aiopsMcp 命名空间动态挂载/卸载 mcp-client。"
kind: "package-reference"
---

# @gac2/dsh-aiops-mcp-controller

[English](README.md) | 中文

## 概述

为广汽二期智能运维控制台挂载 MCP 接口管理能力。控制器从部署的 Nacos MCP 注册中心读面（`/v0/servers`）拉取清单，与本机实时连接状态合并，并经 `aiopsMcp` Remote 命名空间提供连接/断开。连接先对端点握手（initialize + tools/list），再动态挂载 `dsh-mcp-client` 实例，工具即时对智能体可见、无需重启；断开即卸载挂载。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Web 组合中挂载 `@gac2/dsh-aiops-mcp-controller`（见 `aiops.patch.yml`）。配置字段：`registryOrigin`（必填，如 `http://192.168.10.95:9080`）、`namespaceId`（默认 `public`）、`authToken`（默认空；连接时以 Bearer 携带的对接口令）、`settingsPath`（默认 `~/.dsh/aiops-mcp-registry.json`）、`requestTimeoutMs`（默认 15000）。控制台经 `ctx.remote.aiopsMcp.list` 查询、`detail` 查看详情、按名称连接/断开。注册中心配置弹窗与调用开关经 `getSettings`/`saveSettings` 读写；覆盖值持久化在 DSH 用户根目录旁，保存即生效。关闭自动调用会断开全部已连接服务并拒绝新连接。类上声明 `inject: ['tools']`，因为动态挂载的 mcp-client 子插件只能经本上下文解析服务。

## 模型体验

间接：已连接服务向宿主工具注册表发布 `mcp__<serverName>__<tool>` 工具，模型可见工具列表随之变化；本包不直接构造模型输入。

#### KV 缓存影响

连接/断开改变后续轮次的可用工具列表；会话初始前缀不受影响。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- 连接状态保存在内存：宿主重启后全部视为未连接，需在控制台重新连接。
- 工具清单在连接握手时观测；从未连接的服务在详情弹窗中不显示工具。
- 服务注册/编辑留在 Nacos 控制台（`POST /v3/console/ai/mcp`）；本控制台只消费只读面。

<a id="dev-note"></a>
### 开发说明

注册表面拒绝 `limit > 100`（`server limit match`），控制器取一页 100 条后本地分页。fork 在端点协议缺失时发出 `null://` scheme，控制器归一化为 `http://`。wire 方法名避开 RemoteNamespaceService 保留的 `install`/`remove`。
