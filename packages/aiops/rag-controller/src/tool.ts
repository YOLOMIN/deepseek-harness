/**
 * Knowledge-base recall tool for console-managed agents: `knowledge_search`
 * searches the connected RAG platform (KBMatrix) on demand and returns hits
 * with their source attribution (knowledge base + document), so the answer
 * can cite origins. Recall is pull-based and honors the console's recall
 * switch. Named exports preserve loader injection metadata.
 *
 * @module @gac2/dsh-aiops-rag-controller/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Type-only: the `ctx.aiopsRagController` service declaration.
import type {} from './index.ts'

export const name = 'aiops-rag-recall'

export const inject = ['tools', 'aiopsRagController']

const SEARCH_DESCRIPTION =
  '查询运维知识库，返回与问题相关的知识条目（每条标注出处：知识库 / 文档 / 相似度）。'
  + '回答运维知识类问题（处置流程、阈值规范、巡检标准等）前先调用本工具取证，并在最终答复中标注出处来源；'
  + '日常问答、寒暄或链路测试不要调用。'

/** Cap one hit's content so a single chunk cannot flood the request. */
function excerpt(text: string, limit = 800): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * Register the `knowledge_search` tool on `ctx.tools` for the lifetime of `ctx`.
 * @param ctx - preset-scope plugin context.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'knowledge_search',
    description: SEARCH_DESCRIPTION,
    parameters: {
      query: { type: 'string', required: true, description: '检索内容：故障现象、组件名或要查的规范条目。' },
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
      const query = args.query.trim()
      if (query === '') throw new Error('query 不能为空')
      const result = await ctx.aiopsRagController.recallKnowledge(query, 5)
      if (!result.enabled) return { count: 0, report: '知识召回已停用（可在控制台 RAG 管理中开启）。' }
      if (result.hits.length === 0) return { count: 0, report: '知识库暂无匹配内容，请按现有证据继续分析。' }
      const lines = result.hits.map((hit, index) => {
        const source = hit.documentName === undefined ? '知识库' : `知识库文档《${hit.documentName}》`
        const score = hit.score === undefined ? '' : `，相似度 ${hit.score.toFixed(3)}`
        return `${index + 1}. 出处：${source}${score}\n${excerpt(hit.content)}`
      })
      return { count: result.hits.length, report: `召回 ${result.hits.length} 条知识库内容：\n\n${lines.join('\n\n')}` }
    },
    presentCall: args => ({ card: 'generic', title: '查询运维知识库', kind: 'other', rawInput: args.query }),
  }))
}
