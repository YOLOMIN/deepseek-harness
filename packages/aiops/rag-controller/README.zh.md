---
description: "广汽二期智能运维控制台的 RAG 管理：KBMatrix data-infra 代理为 aiopsRag 命名空间——知识库、文档、分块、上传与检索测试。"
kind: "package-reference"
---

# @gac2/dsh-aiops-rag-controller

[English](README.md) | 中文

## 概述

为广汽二期智能运维控制台挂载 RAG 知识库管理能力。控制器把部署的 KBMatrix data-infra API（FastAPI）代理到 `aiopsRag` Remote 命名空间之后：知识库清单/创建/删除、文档分页查询、文档上传（base64 过 wire，宿主侧还原为 multipart）与批量删除、分块浏览、嵌入模型选项与检索测试。平台令牌经 web 前门 `login-local` 获取，内存缓存，认证失效自动重登一次。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Web 组合中挂载 `@gac2/dsh-aiops-rag-controller`（见 `aiops.patch.yml`）。配置字段：`apiOrigin`（必填，data-infra API 端口，如 `http://192.168.32.14:6061`）、`authOrigin`（必填，签发令牌的 web 前门，如 `http://192.168.32.14:6060`）、`username` / `password`（必填，login-local 所用平台账号）、`requestTimeoutMs`（默认 15000）、`uploadTimeoutMs`（默认 120000；大文档解析更慢）。控制台经 `ctx.remote.aiopsRag.listBases` 读知识库清单、`createBase` / `deleteBase` 创建与删除、`pageDocuments` 分页读文档、`uploadDocument` 上传、`deleteDocuments` 删除、`pageChunks` 浏览分块、`listEmbeddingModels` 读嵌入模型选项、`searchKb` 发起检索测试。检索先走 `hybrid`，向量侧无命中时以 `keyword` 重试一次，保证嵌入集合未预热前控制台也能演示召回。

## 模型体验

无直接影响：本包只服务控制台浏览器页面，不构造模型输入。页面上的召回注入开关展示的是诊断链路的行为，归 ops-agent persona 与 memory controller 所有。

#### KV 缓存影响

无；不读写会话内容。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- 平台令牌保存在内存：宿主重启后首个调用重新登录；无持久化与多用户隔离（配置的平台账号服务所有控制台用户）。
- 上传经 wire 以 base64 传输，页面限制 20MB；超大文档应在 KBMatrix web 前门上传。
- 平台分页信封按容忍缺失字段读取，平台 schema 演进时表现为展示字段降级而不是整页失败。

<a id="dev-note"></a>
### 开发说明

`kb-base/create` 的应答把新库 id 作为裸 `data` 字符串返回（非对象），控制器两种形态都接受。`kb-search/search` 的命中是不定型负载，`mapHit` 容忍地读取候选键。wire 方法名避开 RemoteNamespaceService 保留的 `remove`/`install`/`has`。
