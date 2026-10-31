/**
 * Memory tools for console-managed agents: `memory_record` captures a
 * diagnosis conclusion deliberately (short-term tier, reviewed in the
 * console); `memory_recall` pulls long-term memories on demand — recall is
 * pull-based, so unrelated questions carry zero memory overhead.
 * Named exports preserve loader injection metadata.
 *
 * @module @gac2/dsh-aiops-memory-controller/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Type-only: the `agentPreset` session-projection key declaration.
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
// Type-only: the `ctx.sessionProjections` service declaration.
import type {} from '@deepseek-ai/dsh-session-projection'
// Type-only: the `ctx.aiopsMemoryController` service declaration.
import type {} from './index.ts'

export const name = 'aiops-memory-record'

export const inject = ['tools', 'aiopsMemoryController', 'sessionProjections']

const RECORD_DESCRIPTION =
  '完成一次故障诊断、形成明确结论后，必须先调用本工具沉淀结论，再输出最终答复（沉淀是诊断流程的收尾步骤）：'
  + '短期记忆在控制台记忆管理中可评估晋升为长期记忆，供后续同类故障诊断复用。'
  + '日常问答、寒暄或链路测试不要调用。'

const RECALL_DESCRIPTION =
  '开始诊断类问题时调用，按需召回历史诊断经验（长期记忆）作为参考。'
  + '日常问答、寒暄或链路测试不要调用。'

/** Cap one recalled detail so a single memory cannot flood the request. */
function excerptDetail(text: string, limit = 1500): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * Register the `memory_record` and `memory_recall` tools on `ctx.tools` for the lifetime of `ctx`.
 * @param ctx - preset-scope plugin context.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'memory_record',
    description: RECORD_DESCRIPTION,
    parameters: {
      summary: { type: 'string', required: true, description: '一句话结论摘要：根因 + 处置方向。' },
      detail: { type: 'string', required: true, description: '完整结论：根因分析、证据链与处置建议。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已沉淀为短期记忆（${value.id}），可在控制台记忆管理中评估晋升。`,
      }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('memory_record 需要一个会话上下文（仅智能体可调用）')
      const summary = args.summary.trim()
      const detail = args.detail.trim()
      if (summary === '' || detail === '') throw new Error('summary 与 detail 不能为空')
      const preset = ctx.sessionProjections.stateOf(exec.agent.session, 'agentPreset')
      return ctx.aiopsMemoryController.record({
        summary,
        text: detail,
        sessionId: exec.agent.session.id,
        agentId: preset ?? 'unknown',
      })
    },
    presentCall: args => ({ card: 'generic', title: '沉淀经验记忆', kind: 'other', rawInput: args.summary }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_recall',
    description: RECALL_DESCRIPTION,
    parameters: {
      query: { type: 'string', description: '可选关键字（如节点名、故障现象、组件名），用于过滤相关经验。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args) {
      const result = await ctx.aiopsMemoryController.recall(args.query)
      if (!result.enabled) return { count: 0, report: '记忆召回已停用（可在控制台记忆管理中开启）。' }
      if (result.memories.length === 0) return { count: 0, report: '暂无匹配的历史诊断经验（长期记忆）。' }
      const lines = result.memories.map((entry, index) => `${index + 1}. 【${entry.agentName}】${entry.summary}\n${excerptDetail(entry.text)}`)
      return { count: result.memories.length, report: `召回 ${result.memories.length} 条历史诊断经验：\n\n${lines.join('\n\n')}` }
    },
    presentCall: args => ({ card: 'generic', title: '召回历史经验', kind: 'other', rawInput: args.query ?? '' }),
  }))
}
