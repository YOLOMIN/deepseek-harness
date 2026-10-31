---
description: "广汽二期智能运维控制台的经验记忆：memory_record 主动沉淀、短期/长期晋升、memory_recall 按需召回，经 aiopsMemory 命名空间服务。"
kind: "package-reference"
---

# @gac2/dsh-aiops-memory-controller

[English](README.md) | 中文

## 概述

为广汽二期智能运维控制台挂载经验记忆能力。受管智能体形成诊断结论后经 `memory_record` 工具主动沉淀（短期记忆）；控制台把它晋升为持久的长期记忆或遗忘。智能体经 `memory_recall` 工具按需召回长期记忆（Top-N、可选关键字）——召回是拉取式的，无关问答不携带任何记忆开销。控制台经 `aiopsMemory` Remote 命名空间交互：`list`、`detail`、`promote`、`forget`、`getRecallConfig`、`saveRecallConfig`。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Web 组合中挂载 `@gac2/dsh-aiops-memory-controller`（见 `aiops.patch.yml`），与 `@gac2/dsh-aiops-agent-controller` 并列。配置字段：`storePath`（持久记忆 JSON，默认 `~/.dsh/storages/aiops-memories.json`）与 `shortTermTtlMs`（短期记忆保留期，默认 7 天；超过保留期的条目在下一次读取时惰性清理，长期记忆从不过期）。把 `./tool` 子路径导出挂进每个受管预设即可让智能体获得 `memory_record` 与 `memory_recall`；patch 已为运维/系统/HPC 预设声明，控制台创建的智能体经模板预设继承。

## 模型体验

### memory_record / memory_recall 工具

#### 模型可见内容

受管智能体（部署的运维/系统/HPC 预设及控制台创建的克隆）携带两个工具 schema：record 把结论沉淀为短期记忆，recall 按可选关键字按需召回长期记忆。工具描述逐字固定：

##### 工具描述

```markdown
memory_record: 完成一次故障诊断、形成明确结论后，必须先调用本工具沉淀结论，再输出最终答复（沉淀是诊断流程的收尾步骤）：短期记忆在控制台记忆管理中可评估晋升为长期记忆，供后续同类故障诊断复用。日常问答、寒暄或链路测试不要调用。

memory_recall: 开始诊断类问题时调用，按需召回历史诊断经验（长期记忆）作为参考。日常问答、寒暄或链路测试不要调用。
```

`memory_recall` 的结果把命中的记忆渲染为带来源智能体标注的编号摘要与结论文本（每条结论文本截断至 1500 字符）；召回停用或无命中时，报告一句话说明。

#### Token 影响

固定部分为两个工具 schema；召回报告只出现在智能体调用 `memory_recall` 的轮次，每次至多 `topK` 条；其余轮次为零——无关问答不携带记忆 token。

#### KV 缓存影响

工具 schema 是稳定前缀；召回报告只追加在发起调用的轮次内，不回写更早的内容。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- 召回是长期记忆的关键字加最近晋升 Top-N，而非语义相似度；检索排序的召回待嵌入管线就绪后再做。
- 晋升是控制台的显式操作；按评分阈值自动晋升暂缓。

<a id="dev-note"></a>
### 开发说明

Remote 输入在命名空间边界经 zod 校验；晋升把完整结论文本捕获进存储，长期条目在会话清理后仍存活；遗忘从所在层级直接删除条目。
