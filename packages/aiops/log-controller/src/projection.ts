/**
 * Project committed session events into agent-activity log rows.
 *
 * Only decision-relevant events project: turn boundaries, committed model
 * output, interrupted attempts, and tool results (paired with their calls for
 * the tool name and an argument excerpt). Everything else stays in the session
 * trace, not the log list.
 *
 * @module @gac2/dsh-aiops-log-controller/projection
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { AiopsLogRowDraft } from './types.ts'

/** One projected row with its full-text search body, stripped before the wire. */
export interface LogRowProjection {
  readonly row: AiopsLogRowDraft
  /** Full untruncated text the keyword filter matches against. */
  readonly search: string
}

/** Paired tool-call facts carried from tool/call to its tool/result. */
export interface ToolCallFacts {
  readonly names: Map<string, string>
  readonly args: Map<string, string>
}

/** Create the empty pairing context for one session scan. */
export function toolCallFacts(): ToolCallFacts {
  return { names: new Map(), args: new Map() }
}

function excerpt(text: string, limit = 60): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > limit ? `${compact.slice(0, limit)}…` : compact
}

const TURN_END_LABELS: Record<string, string> = {
  completed: '正常完成',
  aborted: '已中止',
  blocked: '阻塞',
  error: '失败',
}

/**
 * Project one committed event into a log row, or undefined for non-log events.
 * @param sessionId - owning session identity.
 * @param event - the committed event.
 * @param tools - pairing context accumulated from earlier tool/call events.
 * @returns the projected row, or undefined when the event produces none.
 */
export function eventToLogRow(sessionId: string, event: SessionEvent, tools: ToolCallFacts): LogRowProjection | undefined {
  const base = { id: `${sessionId}:${event.seq}`, time: event.time, sessionId }
  switch (event.type) {
    case 'turn/start':
      return { row: { ...base, level: 'info', kind: 'run', summary: `开始第 ${event.data.turn} 轮诊断` }, search: `开始第 ${event.data.turn} 轮诊断` }
    case 'assistant/message': {
      if (event.data.interrupted === true) {
        const summary = '模型输出中断，已保留部分内容'
        return { row: { ...base, level: 'warn', kind: 'model', summary }, search: summary }
      }
      const text = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
        .trim()
      const tokens = event.data.usage === undefined ? '' : `（输出 ${event.data.usage.outputTokens} tok）`
      return {
        row: {
          ...base, level: 'info', kind: 'model',
          summary: text === '' ? `模型完成一次输出${tokens}` : `模型输出：${excerpt(text)}${tokens}`,
        },
        // 关键字匹配完整正文，而非截断后的摘要
        search: text === '' ? `模型完成一次输出${tokens}` : text,
      }
    }
    case 'assistant/attempt': {
      const summary = '模型调用未完成（失败、重试或取消）'
      return { row: { ...base, level: 'warn', kind: 'model', summary }, search: summary }
    }
    case 'tool/result': {
      const failed = event.data.message.isError === true
      const callId = event.data.message.toolCallId
      const name = event.data.error?.name ?? tools.names.get(callId) ?? callId
      const args = tools.args.get(callId)
      const argText = args === undefined || args === '' ? '' : `：${args}`
      if (failed) {
        const reason = event.data.error?.reason
        const summary = `工具 ${name} 调用失败${reason === undefined ? argText : `：${excerpt(reason)}`}`
        return { row: { ...base, level: 'warn', kind: 'tool', summary }, search: `${name} ${args ?? ''} ${reason ?? ''}` }
      }
      const summary = `工具 ${name} 调用完成${argText}`
      return { row: { ...base, level: 'info', kind: 'tool', summary }, search: `${name} ${args ?? ''}` }
    }
    case 'turn/end': {
      const label = TURN_END_LABELS[event.data.reason.kind] ?? event.data.reason.kind
      const summary = `第 ${event.data.turn} 轮诊断结束（${label}）`
      return { row: { ...base, level: 'info', kind: 'decision', summary }, search: summary }
    }
    default:
      return undefined
  }
}

/** Pair one tool/call into the pairing context. */
export function pairToolCall(tools: ToolCallFacts, event: SessionEvent<'tool/call'>): void {
  tools.names.set(event.data.callId, event.data.name)
  const args = excerpt(event.data.arguments, 50)
  tools.args.set(event.data.callId, args === '{}' || args === '[]' ? '' : args)
}

/**
 * The preset a session actually runs: header creation fact advanced by
 * agent-preset/selected events (blank sessions adopt a preset after creation).
 * @param headerPreset - creation-time header value, if any.
 * @param events - committed events in log order.
 * @returns the effective preset id, or undefined when the session never got one.
 */
export function effectiveAgentPreset(headerPreset: string | undefined, events: readonly SessionEvent[]): string | undefined {
  let preset = headerPreset
  for (const event of events) {
    if (event.type === 'agent-preset/selected') preset = event.data.agentPreset
  }
  return preset
}

/**
 * Project one session's event log into log rows, oldest first.
 * @param sessionId - owning session identity.
 * @param events - committed events in log order.
 * @returns projected rows in event order.
 */
export function sessionToLogRows(sessionId: string, events: readonly SessionEvent[]): LogRowProjection[] {
  const tools = toolCallFacts()
  const rows: LogRowProjection[] = []
  for (const event of events) {
    // Tool names and argument excerpts live on the call; results pair by toolCallId.
    if (event.type === 'tool/call') {
      pairToolCall(tools, event)
      continue
    }
    const row = eventToLogRow(sessionId, event, tools)
    if (row !== undefined) rows.push(row)
  }
  return rows
}
