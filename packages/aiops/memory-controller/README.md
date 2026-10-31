---
description: "Experience memory for the GAC2 operations console: diagnosis-conclusion projection, short/long-term promotion, recall configuration, and pre-step recall injection over the aiopsMemory namespace."
kind: "package-reference"
---

# @gac2/dsh-aiops-memory-controller

English | [中文](README.zh.md)

## Summary

Mount the experience-memory capability for the GAC2 operations console. Managed agents record diagnosis conclusions deliberately through the `memory_record` tool (short-term tier); the console promotes them into the durable long-term tier or forgets them. Agents pull long-term memories on demand through the `memory_recall` tool (Top-N, optional keyword) — recall is pull-based, so unrelated turns carry no memory overhead. The console talks to the `aiopsMemory` Remote namespace: `list`, `detail`, `promote`, `forget`, `getRecallConfig`, `saveRecallConfig`.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `@gac2/dsh-aiops-memory-controller` in the Web composition (see `aiops.patch.yml`) beside `@gac2/dsh-aiops-agent-controller`. Configuration fields: `storePath` (durable memory JSON, default `~/.dsh/storages/aiops-memories.json`) and `shortTermTtlMs` (short-term retention window, default 7 days; entries past the window are purged lazily on the next read, long-term entries never expire). Mount the `./tool` subpath export into each managed preset to give agents `memory_record` and `memory_recall`; the patch already declares it for the ops/sys/hpc presets, and console-created agents inherit it from the template preset.

## Model Experience

### memory_record / memory_recall tools

#### What the model sees

Managed agents (the deployment's ops/sys/hpc presets and console-created clones) carry two tool schemas. Record captures a conclusion into the short-term tier; recall pulls long-term memories on demand with an optional keyword. A `memory_recall` result renders the matched memories as a numbered list of agent-attributed summaries with their conclusion texts (each capped at 1500 characters); when recall is disabled or nothing matches, the report says so in one line. The descriptions are verbatim:

##### Tool descriptions

```markdown
memory_record: 完成一次故障诊断、形成明确结论后，必须先调用本工具沉淀结论，再输出最终答复（沉淀是诊断流程的收尾步骤）：短期记忆在控制台记忆管理中可评估晋升为长期记忆，供后续同类故障诊断复用。日常问答、寒暄或链路测试不要调用。

memory_recall: 开始诊断类问题时调用，按需召回历史诊断经验（长期记忆）作为参考。日常问答、寒暄或链路测试不要调用。
```

#### Token effect

Fixed: two tool schemas while mounted. Conditional: recall report only in turns where the agent calls `memory_recall`, at most `topK` entries per call; zero otherwise — unrelated questions carry no memory tokens.

#### KV Cache effect

The tool schemas are a stable prefix; recall reports append inside the turns that call the tool and never rewrite earlier content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Recall is keyword-plus-recency Top-N over long-term memories, not semantic similarity; a retrieval-ranked recall is deferred until an embedding pipeline exists.
- Promotion is a deliberate console action; automatic score-threshold promotion is deferred.

<a id="dev-note"></a>
### Dev Note

Remote inputs are validated with zod at the namespace boundary; promotion captures the full conclusion text into the store so long-term entries survive session pruning; forgetting a long-term entry also suppresses its projection id so the short-term row cannot resurface.
