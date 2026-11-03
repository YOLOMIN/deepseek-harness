/**
 * 智能运维控制台页面：智能体管理 / RAG 管理 / skills 管理 / 日志管理 / 记忆管理 / MCP 接口管理
 * 六个模块页签。RAG / skills / MCP 以市场式卡片网格展示管理对象，清单分页展示；
 * 每个功能卡片标注功能属性（管理功能 / 运行时能力），原型数据，样式随 dsh 主题变量。
 * 控制台按登录账户权限过滤可见资源：普通账户仅见所对接系统的智能体与资源，管理员可见全部。
 * 会话管理直接复用 dsh 既有会话功能，不在控制台重复建设。
 */
import { useCallback, useEffect, useState } from 'react'
import css from './AiopsConsolePage.module.css'
import { consumeInitialTab } from './initial-tab.ts'
import type { AiopsAgentsFace } from './agents-face.ts'
import type { AiopsLogsFace } from './logs-face.ts'
import type { AiopsMemoryFace } from './memory-face.ts'
import type { AiopsSkillsFace } from './skills-face.ts'
import type { AiopsMcpFace } from './mcp-face.ts'
import type { AiopsAgentRow } from '@gac2/dsh-aiops-agent-controller/types'
import type { AiopsLogKind, AiopsLogLevel, AiopsLogPage, AiopsLogRow } from '@gac2/dsh-aiops-log-controller/types'
import type { AiopsMemoryDetail, AiopsMemoryKind, AiopsMemoryPage, AiopsMemoryRow, AiopsRecallConfig } from '@gac2/dsh-aiops-memory-controller/types'
import type {
  AiopsSkillDetail, AiopsSkillPage, AiopsSkillRegistryConfig, AiopsSkillRow, AiopsSkillSettings, AiopsSkillStatus,
} from '@gac2/dsh-aiops-skill-controller/types'
import type {
  AiopsMcpRegisterInput, AiopsMcpServerDetail, AiopsMcpServerPage, AiopsMcpServerRow, AiopsMcpSettings,
} from '@gac2/dsh-aiops-mcp-controller/types'
import type { AiopsLocaleKey } from './locales.ts'
import {
  IconDatabaseOutlineRegular,
  IconSkillOutlineRegular,
  IconChecklistOutlineRegular,
  IconThinkOutlineRegular,
  IconApiOutlineRegular,
  IconAgentPresetOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'

/* ---------- 主题变量 ---------- */
const V = {
  text: 'var(--dsw-alias-label-primary,#1f2328)',
  text2: 'var(--dsw-alias-label-secondary,#4a5568)',
  text3: 'var(--dsw-alias-label-tertiary,#8a94a6)',
  bg: 'var(--dsw-alias-bg-module-platform,#ffffff)',
  border: 'var(--dsw-alias-border-l,#e3e6ea)',
  brand: 'var(--dsw-alias-brand-primary,#5b6ee1)',
  onBrand: 'var(--dsw-alias-bg-module-platform,#ffffff)',
  success: 'var(--dsw-alias-state-success-primary,#2ea44f)',
  warn: 'var(--dsw-alias-state-warn-label,#b25e09)',
  error: 'var(--dsw-alias-state-error-primary,#d73a49)',
  radius: 'var(--dsw-radius-md,8px)',
  mono: 'var(--dsw-font-mono,monospace)',
} as const

type Role = 'admin' | 'hpc' | 'os'
type Scope = 'hpc' | 'os' | 'shared'

/** 资源可见性：管理员可见全部；普通账户可见共享资源与所对接系统的资源。 */
const vis = (scope: Scope, role: Role) => role === 'admin' || scope === 'shared' || scope === role

const card: Record<string, string | number> = {
  background: V.bg, border: `1px solid ${V.border}`, borderRadius: V.radius, padding: '12px 16px',
}

const grid: Record<string, string | number> = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(270px, 1fr))', gap: 12,
}

/** 原生 option 在深色主题下需显式配色，否则弹出层白底白字。 */
const optionStyle: Record<string, string> = { background: V.bg, color: V.text }

function Tag({ color, children }: { color: string; children: unknown }) {
  return (
    <span style={{
      fontSize: 12, color, border: `1px solid ${color}`, borderRadius: 4,
      padding: '0 6px', lineHeight: '18px', whiteSpace: 'nowrap',
    }}>{children as never}</span>
  )
}

function Btn(props: { primary?: boolean; danger?: boolean; disabled?: boolean; onClick?: (() => void) | undefined; children: unknown }) {
  const { primary, danger, disabled, onClick, children } = props
  return (
    <button disabled={disabled} onClick={onClick} style={{
      fontSize: 12, cursor: disabled === true ? 'default' : 'pointer', borderRadius: 6, padding: '3px 10px', whiteSpace: 'nowrap',
      opacity: disabled === true ? 0.45 : 1,
      border: primary ? 'none' : `1px solid ${danger ? V.error : V.border}`,
      background: primary ? V.brand : 'transparent',
      color: primary ? V.onBrand : danger ? V.error : V.text2,
    }}>{children as never}</button>
  )
}

/** 运行时能力开关：非管理功能，以开关形式呈现启用状态。 */
function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <span
      onClick={() => { onChange(!on) }}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: V.text2, cursor: 'pointer', userSelect: 'none' }}
    >
      {label}
      <span style={{ width: 32, height: 18, borderRadius: 9, background: on ? V.brand : V.border, position: 'relative', transition: 'background .15s', flexShrink: 0 }}>
        <span style={{ position: 'absolute', top: 2, left: on ? 16 : 2, width: 14, height: 14, borderRadius: 7, background: '#fff', transition: 'left .15s' }} />
      </span>
      <span style={{ fontSize: 12, color: on ? V.success : V.text3 }}>{on ? '已开启' : '已关闭'}</span>
    </span>
  )
}

/** 清单表格：widths 提供固定列宽（固定布局），未给宽度的列吸收剩余空间。 */
function Table({ head, rows, widths }: { head: string[]; rows: (unknown)[][]; widths?: (number | undefined)[] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, tableLayout: widths === undefined ? 'auto' : 'fixed' }}>
      <thead>
        <tr>{head.map((h, i) => (
          <th key={h} style={{ textAlign: 'left', padding: '8px 10px', color: V.text3, fontWeight: 400, borderBottom: `1px solid ${V.border}`, width: widths?.[i] }}>{h}</th>
        ))}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>{r.map((c, j) => (
            <td key={j} style={{ padding: '9px 10px', color: V.text, borderBottom: `1px solid ${V.border}`, verticalAlign: 'top', wordBreak: 'break-word' }}>{c as never}</td>
          ))}</tr>
        ))}
      </tbody>
    </table>
  )
}

/** 分页条：清单统一分页展示；传入 onPage 即为真实翻页，否则展示单页占位；busy 时禁用翻页防连点。 */
function Pager(props: {
  total: number
  unit: string
  page?: number
  pages?: number
  busy?: boolean
  onPage?: ((page: number) => void) | undefined
}) {
  const current = props.page ?? 1
  const totalPages = props.pages ?? 1
  const busy = props.busy ?? false
  const onPage = props.onPage
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12, color: V.text3 }}>
      <span>共 {props.total} {props.unit}</span>
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
        <Btn disabled={busy || current <= 1} onClick={() => { onPage?.(current - 1) }}>‹ 上一页</Btn>
        <span>{current} / {totalPages} 页</span>
        <Btn disabled={busy || current >= totalPages} onClick={() => { onPage?.(current + 1) }}>下一页 ›</Btn>
      </span>
    </div>
  )
}

/** 功能卡片：每个功能一张卡片，卡片头标注功能属性（管理功能 / 运行时能力）。 */
function FuncCard({ name, kind, children }: { name: string; kind: 'manage' | 'runtime'; children: unknown }) {
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: V.text }}>{name}</span>
        <Tag color={kind === 'manage' ? V.brand : V.text3}>{kind === 'manage' ? '管理功能' : '运行时能力'}</Tag>
      </div>
      {children as never}
    </div>
  )
}

/** 市场式条目卡片：图标 + 名称 + 描述 + 标签 + 来源 + 操作按钮。 */
function ItemCard(props: {
  icon: string
  iconColor: string
  name: string
  meta?: string
  desc: string
  tags?: { color: string; text: string }[]
  source?: string
  actions: unknown
  highlight?: boolean
}) {
  return (
    <div style={{
      ...card, display: 'flex', flexDirection: 'column', gap: 8,
      border: props.highlight ? `1px solid ${V.brand}` : `1px solid ${V.border}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{
          width: 34, height: 34, borderRadius: 8, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: props.iconColor, color: '#fff', fontSize: 15, fontWeight: 600,
        }}>{props.icon}</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: V.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{props.name}</div>
          {props.meta && <div style={{ fontSize: 11.5, color: V.text3, fontFamily: V.mono }}>{props.meta}</div>}
        </div>
      </div>
      <div style={{ fontSize: 12.5, color: V.text2, lineHeight: 1.7, flex: 1 }} className={css.clamp3}>{props.desc}</div>
      {props.tags && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{props.tags.map((tg, i) => <Tag key={i} color={tg.color}>{tg.text}</Tag>)}</div>}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, borderTop: `1px solid ${V.border}`, paddingTop: 8,
        ...(props.source === undefined ? { justifyContent: 'flex-end' } : {}),
      }}>
        {props.source !== undefined && (
          <span style={{ fontSize: 11.5, color: V.text3, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{props.source}</span>
        )}
        {props.actions as never}
      </div>
    </div>
  )
}

function Note({ children }: { children: unknown }) {
  return <div style={{ fontSize: 12.5, color: V.text2, lineHeight: 1.8 }}>{children as never}</div>
}

/* ---------- 智能体管理（生命周期 + 会话关联；按账户权限过滤） ---------- */
/** 相对时间：最近会话列的友好显示。 */
function formatRelative(ts: number): string {
  const minutes = Math.floor((Date.now() - ts) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

const DEFAULT_PERSONA = '你是操作系统智能运维平台的诊断智能体，'
  + '你的职责是面向仿真计算集群开展智能诊断，按"感知—认知—推理—决策—行动—观察"的循环定位故障根因并给出处置建议。'
  + '处理诊断类问题时，先调用 memory_recall 召回历史诊断经验（长期记忆）作参考；'
  + '形成明确的故障诊断结论后，必须先调用 memory_record 工具沉淀经验（summary 为一句话结论，detail 为完整结论与处置建议），再输出最终答复；'
  + '日常问答、寒暄或链路测试不要调用这两个工具。'

/** 智能体实例卡片：头像 + 职责 + 模型 + 会话统计 + 生命周期操作。 */
function AgentCard(props: {
  row: AiopsAgentRow
  onOpen: () => void
  onConfigure: () => void
  onRemove: () => void
}) {
  const { row } = props
  const healthy = row.broken === undefined
  return (
    <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{
          width: 38, height: 38, borderRadius: 19, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: '#5b6ee1', color: '#fff', fontSize: 16, fontWeight: 600,
        }}>{row.name.slice(0, 1)}</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: V.text }}>{row.name}</div>
          <div style={{ fontSize: 11.5, color: V.text3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.role || '—'}</div>
        </div>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {healthy ? <Tag color={V.success}>运行中</Tag> : <Tag color={V.error}>异常</Tag>}
        </span>
      </div>
      <div style={{ fontSize: 12, color: V.text3 }}>
        会话 {row.sessions} 个{row.lastActiveAt === undefined ? ' · 暂无会话' : ` · 最近会话：${formatRelative(row.lastActiveAt)}`}
      </div>
      {row.broken !== undefined && (
        <div style={{ fontSize: 12, color: V.error, lineHeight: 1.6 }} title={row.broken}>
          {row.broken.length > 80 ? `${row.broken.slice(0, 80)}…` : row.broken}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderTop: `1px solid ${V.border}`, paddingTop: 8 }}>
        <Btn primary onClick={props.onOpen}>打开会话</Btn>
        <Btn onClick={props.onConfigure}>配置</Btn>
        {row.builtin === true ? null : <Btn danger onClick={props.onRemove}>销毁</Btn>}
        <span style={{ marginLeft: 'auto', fontSize: 11.5, color: V.text3 }}>{row.id}</span>
      </div>
    </div>
  )
}

/** 智能体卡片网格每页容量。 */
const AGENTS_PAGE_SIZE = 6

/** 创建/配置表单状态：create 为空表单，edit 回填已有定义。 */
interface AgentEditorState {
  mode: 'create' | 'edit'
  id?: string
  name: string
  role: string
  personaPrefix: string
}

function AgentsTab({ face }: { face: AiopsAgentsFace }) {
  const [rows, setRows] = useState<AiopsAgentRow[] | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [editor, setEditor] = useState<AgentEditorState | null>(null)
  const [removing, setRemoving] = useState<AiopsAgentRow | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setRows(await face.listAgents())
      setError(null)
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [face])

  useEffect(() => { void refresh() }, [refresh])

  const agents = rows ?? []
  const [page, setPage] = useState(1)
  const totalPages = Math.max(1, Math.ceil(agents.length / AGENTS_PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pageAgents = agents.slice((safePage - 1) * AGENTS_PAGE_SIZE, safePage * AGENTS_PAGE_SIZE)

  const submitEditor = async () => {
    if (editor === null || busy) return
    setBusy(true)
    try {
      const persona = editor.personaPrefix.trim()
      if (editor.mode === 'create') {
        await face.createAgent({ name: editor.name.trim(), role: editor.role.trim(), personaPrefix: persona })
      } else if (editor.id !== undefined) {
        await face.updateAgent({
          id: editor.id,
          name: editor.name.trim(),
          role: editor.role.trim(),
          ...(persona === '' ? {} : { personaPrefix: persona }),
        })
      }
      setEditor(null)
      await refresh()
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const confirmRemove = async () => {
    if (removing === null || busy) return
    setBusy(true)
    try {
      await face.removeAgent(removing.id)
      setRemoving(null)
      await refresh()
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={card}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
          <Btn primary onClick={() => { setEditor({ mode: 'create', name: '', role: '', personaPrefix: DEFAULT_PERSONA }) }}>创建智能体</Btn>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: V.text3 }}>
            智能体实例 {agents.length} 个 · 异常 {agents.filter(a => a.broken !== undefined).length} 个
          </span>
        </div>
        {error !== null && <div style={{ fontSize: 12.5, color: V.error, marginBottom: 10 }}>{error}</div>}
        {rows === undefined && error === null && <div style={{ fontSize: 12.5, color: V.text3 }}>加载中…</div>}
        <div style={grid}>
          {pageAgents.map(row => (
            <AgentCard
              key={row.id}
              row={row}
              onOpen={() => { face.openAgentSession(row.id) }}
              onConfigure={() => { setEditor({ mode: 'edit', id: row.id, name: row.name, role: row.role, personaPrefix: row.personaPrefix ?? '' }) }}
              onRemove={() => { setRemoving(row) }}
            />
          ))}
        </div>
        <Pager total={agents.length} unit="个实例" page={safePage} pages={totalPages} onPage={setPage} />
      </div>

      {editor !== null && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,17,21,.45)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3000 }}>
          <div style={{ ...card, width: 420, padding: '16px 18px', display: 'grid', gap: 12, boxShadow: '0 12px 40px rgba(0,0,0,.28)' }}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: V.text }}>{editor.mode === 'create' ? '创建智能体' : '配置智能体'}</span>
              <button
                onClick={() => { setEditor(null) }}
                style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: V.text3, cursor: 'pointer', fontSize: 14, padding: '0 2px' }}
              >✕</button>
            </div>
            <label style={{ fontSize: 12, color: V.text3, display: 'grid', gap: 3 }}>
              名称
              <input
                value={editor.name}
                onChange={(e) => { setEditor({ ...editor, name: e.target.value }) }}
                placeholder="例如：存储诊断智能体"
                style={{ padding: '7px 10px', borderRadius: 6, border: `1px solid ${V.border}`, fontSize: 13, background: 'transparent', color: V.text }}
              />
            </label>
            <label style={{ fontSize: 12, color: V.text3, display: 'grid', gap: 3 }}>
              职责描述
              <input
                value={editor.role}
                onChange={(e) => { setEditor({ ...editor, role: e.target.value }) }}
                placeholder="例如：存储挂载与文件系统故障诊断"
                style={{ padding: '7px 10px', borderRadius: 6, border: `1px solid ${V.border}`, fontSize: 13, background: 'transparent', color: V.text }}
              />
            </label>
            <label style={{ fontSize: 12, color: V.text3, display: 'grid', gap: 3 }}>
              身份设定（persona，必填）
              <textarea
                value={editor.personaPrefix}
                onChange={(e) => { setEditor({ ...editor, personaPrefix: e.target.value }) }}
                rows={6}
                style={{
                  padding: '8px 10px', borderRadius: 6, border: `1px solid ${V.border}`, fontSize: 12, lineHeight: 1.6,
                  fontFamily: V.mono, background: 'transparent', color: V.text2, resize: 'vertical',
                }}
              />
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn onClick={() => { setEditor(null) }}>取消</Btn>
              <Btn primary onClick={() => { void submitEditor() }}>
                {busy ? '提交中…' : editor.mode === 'create' ? '创建' : '保存'}
              </Btn>
            </div>
          </div>
        </div>
      )}

      {removing !== null && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,17,21,.45)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3000 }}>
          <div style={{ ...card, width: 380, padding: '16px 18px', display: 'grid', gap: 10, boxShadow: '0 12px 40px rgba(0,0,0,.28)' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: V.text }}>销毁智能体</div>
            <div style={{ fontSize: 13, color: V.text2, lineHeight: 1.7 }}>
              确认销毁「{removing.name}」？其预设将被注销；历史会话仍可查看，但无法再以该智能体运行。
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn onClick={() => { setRemoving(null) }}>取消</Btn>
              <Btn danger onClick={() => { void confirmRemove() }}>{busy ? '销毁中…' : '确认销毁'}</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ---------- RAG 管理（知识库查询 / 创建 / 编辑 / 删除，分页；按账户权限过滤） ---------- */
function RagTab({ role }: { role: Role }) {
  const [inject, setInject] = useState(true)
  const kbs = [
    { scope: 'hpc' as Scope, card: (
      <ItemCard
        icon="运" iconColor="#5b6ee1" name="HPC 运维手册" meta="kb-hpc-manual"
        desc="集群运维标准手册：节点巡检、IB 链路、GPU 温度、存储挂载等标准处置流程与阈值规范。"
        tags={[{ color: V.text3, text: '条目 126' }, { color: V.success, text: '索引最新' }]}
        source="更新于 2026-10-12"
        actions={<span style={{ display: 'flex', gap: 6 }}><Btn>编辑</Btn><Btn>删除</Btn></span>}
        highlight
      />
    ) },
    { scope: 'shared' as Scope, card: (
      <ItemCard
        icon="经" iconColor="#2ea44f" name="运维经验沉淀" meta="kb-ops-exp"
        desc="历史诊断结论与处置经验沉淀：由记忆管理模块经评估晋升写入，支撑同类故障的经验复用。"
        tags={[{ color: V.text3, text: '条目 58' }, { color: V.success, text: '索引最新' }]}
        source="更新于 2026-10-08"
        actions={<span style={{ display: 'flex', gap: 6 }}><Btn>编辑</Btn><Btn>删除</Btn></span>}
      />
    ) },
    { scope: 'os' as Scope, card: (
      <ItemCard
        icon="规" iconColor="#b26a00" name="硬件运维规范" meta="kb-hw-spec"
        desc="硬件层运维规范：GPU / IB 卡 / 存储控制器的温度、误码率等阈值标准与更换处置建议。"
        tags={[{ color: V.text3, text: '条目 84' }, { color: V.warn, text: '索引更新中' }]}
        source="更新于 2026-09-28"
        actions={<span style={{ display: 'flex', gap: 6 }}><Btn>编辑</Btn><Btn>删除</Btn></span>}
      />
    ) },
  ].filter(k => vis(k.scope, role))
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <FuncCard name="知识库管理" kind="manage">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
          <span style={{ ...card, padding: '4px 10px', fontSize: 12, color: V.text3, minWidth: 180 }}>查询：知识库名称 / 关键字</span>
          <Btn>查询</Btn>
          <Btn primary>创建知识库</Btn>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: V.text3 }}>已对接：KBMatrix（外部系统，备选开源 RAGFlow）</span>
        </div>
        <div style={grid}>{kbs.map((k, i) => <span key={i} style={{ display: 'contents' }}>{k.card}</span>)}</div>
        <div style={{ fontSize: 12, color: V.text3, marginTop: 10 }}>
          知识库支持查询、创建、编辑与删除等生命周期管理，库内知识条目支持新增、修改、查询、删除，变更后增量更新索引、即时生效。
        </div>
        <Pager total={kbs.length} unit="个知识库" />
      </FuncCard>
      <FuncCard name="知识召回" kind="runtime">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Note>语义 / 关键词双路召回、Rerank 融合重排、出处标注；召回知识经去重与冲突消解后自动注入推理上下文，随诊断链路执行，无需人工操作。</Note>
          <Switch on={inject} onChange={setInject} label="知识召回注入推理链路" />
        </div>
      </FuncCard>
    </div>
  )
}

/* ---------- skills 管理（Nacos 技能库清单 + 本地安装/卸载 + 发现/调用开关，真实分页） ---------- */
const SKILL_STATUS_LABELS: Record<AiopsSkillStatus, string> = { editing: '编辑中', reviewing: '审核中', online: '已发布', offline: '已下线' }
const SKILL_PAGE_SIZE = 8

function SkillsTab({ face }: { face: AiopsSkillsFace }) {
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<AiopsSkillPage | undefined>(undefined)
  const [querying, setQuerying] = useState(false)
  const [paging, setPaging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uninstalling, setUninstalling] = useState<AiopsSkillRow | null>(null)
  const [busyName, setBusyName] = useState<string | null>(null)
  const [detailBusyName, setDetailBusyName] = useState<string | null>(null)
  const [detail, setDetail] = useState<AiopsSkillDetail | null>(null)
  const [settings, setSettings] = useState<AiopsSkillSettings | undefined>(undefined)
  const [switchSaving, setSwitchSaving] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [configDraft, setConfigDraft] = useState<AiopsSkillRegistryConfig>({ registryOrigin: '', namespaceId: 'public' })
  const [configError, setConfigError] = useState<string | null>(null)
  const [configSaving, setConfigSaving] = useState(false)

  const runQuery = useCallback(async (targetPage: number, intent: 'query' | 'page' = 'query') => {
    const setBusyFlag = intent === 'page' ? setPaging : setQuerying
    setBusyFlag(true)
    try {
      const result = await face.listSkills({
        ...(keyword.trim() === '' ? {} : { keyword: keyword.trim() }),
        page: targetPage,
        pageSize: SKILL_PAGE_SIZE,
      })
      setData(result)
      setPage(result.page)
      setError(null)
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusyFlag(false)
    }
  }, [face, keyword])

  useEffect(() => {
    void runQuery(1, 'page') // 仅挂载时首查（静默）；筛选变化由“查询”按钮触发
    void face.getSettings().then(setSettings).catch(() => undefined)
  }, [])

  const openConfig = async () => {
    setConfigError(null)
    setConfigOpen(true)
    try {
      const current = await face.getSettings()
      setSettings(current)
      setConfigDraft({ registryOrigin: current.registryOrigin, namespaceId: current.namespaceId })
    } catch (reason: unknown) {
      setConfigError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const saveConfig = async () => {
    if (configSaving || settings === undefined) return
    setConfigSaving(true)
    setConfigError(null)
    try {
      const saved = await face.saveSettings({
        ...settings,
        registryOrigin: configDraft.registryOrigin.trim(),
        namespaceId: configDraft.namespaceId.trim(),
      })
      setSettings(saved)
      setConfigOpen(false)
      await runQuery(1)
    } catch (reason: unknown) {
      setConfigError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setConfigSaving(false)
    }
  }

  const flipSwitch = async (field: 'autoDiscover' | 'autoInvoke', value: boolean) => {
    if (settings === undefined || switchSaving) return
    const previous = settings
    const next = { ...settings, [field]: value }
    setSettings(next)
    setSwitchSaving(true)
    try {
      await face.saveSettings(next)
      await runQuery(1, 'page')
    } catch (reason: unknown) {
      setSettings(previous)
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSwitchSaving(false)
    }
  }

  const install = async (row: AiopsSkillRow) => {
    if (busyName !== null) return
    setBusyName(row.name)
    try {
      await face.installSkill(row.name)
      await runQuery(page, 'page')
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusyName(null)
    }
  }

  const openDetail = async (row: AiopsSkillRow) => {
    if (detailBusyName !== null || busyName !== null) return
    setDetailBusyName(row.name)
    try {
      setDetail(await face.getSkillDetail(row.name))
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setDetailBusyName(null)
    }
  }

  const confirmUninstall = async () => {
    if (uninstalling === null || busyName !== null) return
    setBusyName(uninstalling.name)
    try {
      await face.uninstallSkill(uninstalling.name)
      setUninstalling(null)
      await runQuery(page, 'page')
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusyName(null)
    }
  }

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / SKILL_PAGE_SIZE))

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={card}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
          <input
            value={keyword}
            onChange={(e) => { setKeyword(e.target.value) }}
            onKeyDown={(e) => { if (e.key === 'Enter') void runQuery(1) }}
            placeholder="查询：skill 名称 / 描述"
            style={{ padding: '5px 10px', borderRadius: 6, border: `1px solid ${V.border}`, fontSize: 12.5, minWidth: 200, background: 'transparent', color: V.text }}
          />
          <Btn primary disabled={querying} onClick={() => { void runQuery(1) }}>{querying ? '查询中…' : '查询'}</Btn>
          <span style={{ marginLeft: 'auto' }}>
            <Btn onClick={() => { void openConfig() }}>技能库配置</Btn>
          </span>
        </div>
        {error !== null && <div style={{ fontSize: 12.5, color: V.error, marginBottom: 10 }}>{error}</div>}
        {data === undefined && error === null && <div style={{ fontSize: 12.5, color: V.text3 }}>加载中…</div>}
        {data !== undefined && data.total === 0 && (
          <div style={{ fontSize: 12.5, color: V.text3 }}>
            {settings?.autoDiscover === false ? '自动发现已停用，仅显示本机已安装 skill；当前没有已安装 skill。' : '技能库暂无匹配 skill，调整关键字后重试。'}
          </div>
        )}
        {data !== undefined && data.total > 0 && (
          <div style={grid}>
            {data.rows.map(row => (
              <ItemCard
                key={row.name}
                icon={row.name.replace(/^skill-/, '').slice(0, 1)} iconColor={row.invocable ? '#5b6ee1' : '#8a94a6'}
                name={row.name} meta={`${row.name} · ${row.version}`}
                desc={row.description}
                tags={[
                  row.invocable
                    ? { color: V.success, text: '已加载' }
                    : row.installed
                      ? { color: V.warn, text: '已安装·调用停用' }
                      : { color: V.text3, text: '未安装' },
                  { color: V.text3, text: SKILL_STATUS_LABELS[row.status] },
                ]}
                highlight={row.invocable}
                actions={<span style={{ display: 'flex', gap: 6 }}>
                  <Btn disabled={busyName === row.name || detailBusyName === row.name} onClick={() => { void openDetail(row) }}>详情</Btn>
                  {row.installed
                    ? <Btn danger disabled={busyName === row.name} onClick={() => { setUninstalling(row) }}>卸载</Btn>
                    : <Btn primary disabled={busyName === row.name} onClick={() => { void install(row) }}>{busyName === row.name ? '安装中…' : '安装'}</Btn>}
                </span>}
              />
            ))}
          </div>
        )}
        <Pager
          total={data?.total ?? 0}
          unit="个 skill"
          page={page}
          pages={totalPages}
          busy={querying || paging}
          onPage={(next) => { void runQuery(next, 'page') }}
        />
      </div>

      <FuncCard name="skill 发现" kind="runtime">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Note>监听技能库（nacos）注册信息，自动扫描发现可用 skill 并按需读取 skill 定义；清单支持按名称与描述查询。关闭后清单仅显示本机已安装 skill，不再访问技能库。</Note>
          <Switch
            on={settings?.autoDiscover ?? true}
            onChange={(v) => { void flipSwitch('autoDiscover', v) }}
            label={settings?.autoDiscover === false ? '已停用' : '自动发现（监听技能库）'}
          />
        </div>
      </FuncCard>
      <FuncCard name="skill 调用" kind="runtime">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Note>已安装 skill 对智能体可见并按任务意图匹配调用，解析定义文件按步骤编排执行。关闭后已安装 skill 整体转入隔离区，智能体不再命中；开启即恢复。</Note>
          <Switch
            on={settings?.autoInvoke ?? true}
            onChange={(v) => { void flipSwitch('autoInvoke', v) }}
            label={settings?.autoInvoke === false ? '已停用' : '按任务意图自动调用 skill'}
          />
        </div>
      </FuncCard>

      {configOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,17,21,.45)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3000 }}>
          <div style={{ ...card, width: 420, padding: '16px 18px', display: 'grid', gap: 10, boxShadow: '0 12px 40px rgba(0,0,0,.28)' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: V.text }}>技能库配置</div>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: V.text3 }}>注册中心地址</span>
              <input
                value={configDraft.registryOrigin}
                onChange={(e) => { setConfigDraft({ ...configDraft, registryOrigin: e.target.value }) }}
                placeholder="http://192.168.10.95:9080"
                style={{ padding: '6px 10px', borderRadius: 6, border: `1px solid ${V.border}`, fontSize: 12.5, background: 'transparent', color: V.text, fontFamily: V.mono }}
              />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: V.text3 }}>命名空间</span>
              <input
                value={configDraft.namespaceId}
                onChange={(e) => { setConfigDraft({ ...configDraft, namespaceId: e.target.value }) }}
                placeholder="public"
                style={{ padding: '6px 10px', borderRadius: 6, border: `1px solid ${V.border}`, fontSize: 12.5, background: 'transparent', color: V.text, fontFamily: V.mono }}
              />
            </label>
            {configError !== null && <div style={{ fontSize: 12.5, color: V.error }}>{configError}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn onClick={() => { setConfigOpen(false) }}>取消</Btn>
              <Btn primary disabled={configSaving} onClick={() => { void saveConfig() }}>{configSaving ? '保存中…' : '保存'}</Btn>
            </div>
          </div>
        </div>
      )}

      {detail !== null && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,17,21,.45)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3000 }}>
          <div style={{ ...card, width: 460, padding: '16px 18px', display: 'grid', gap: 10, boxShadow: '0 12px 40px rgba(0,0,0,.28)' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: V.text }}>skill 详情</div>
            <div style={{ fontSize: 12.5, color: V.text2, lineHeight: 1.9 }}>
              <div>名称：<span style={{ fontFamily: V.mono }}>{detail.row.name}</span></div>
              <div>版本：{detail.row.version} · 状态：{SKILL_STATUS_LABELS[detail.row.status]}</div>
              <div>安装：{detail.row.installed ? (detail.row.invocable ? '已加载（对智能体可见）' : '已安装·调用停用（隔离区）') : '未安装'}</div>
              {detail.localPath !== undefined && <div>本地目录：<span style={{ fontFamily: V.mono }}>{detail.localPath}</span></div>}
              <div>声明文件：<span style={{ fontFamily: V.mono }}>{detail.files.join('、')}</span></div>
              <div style={{ marginTop: 6, borderTop: `1px solid ${V.border}`, paddingTop: 8 }}>{detail.row.description}</div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn onClick={() => { setDetail(null) }}>关闭</Btn>
            </div>
          </div>
        </div>
      )}

      {uninstalling !== null && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,17,21,.45)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3000 }}>
          <div style={{ ...card, width: 380, padding: '16px 18px', display: 'grid', gap: 10, boxShadow: '0 12px 40px rgba(0,0,0,.28)' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: V.text }}>卸载 skill</div>
            <div style={{ fontSize: 13, color: V.text2, lineHeight: 1.7 }}>
              确认卸载「{uninstalling.name}」？将从本机技能目录移除，智能体后续会话不再命中；技能库中的注册条目保留。
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn onClick={() => { setUninstalling(null) }}>取消</Btn>
              <Btn danger onClick={() => { void confirmUninstall() }}>{busyName === uninstalling.name ? '卸载中…' : '确认卸载'}</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ---------- 日志管理（智能体活动日志：关键字/类型/时间筛选 + 详情/导出，真实分页） ---------- */
const LOG_KIND_LABELS: Record<AiopsLogKind, string> = { run: '运行', model: '模型调用', tool: '工具调用', decision: '决策' }
const LOG_LEVEL_COLORS: Record<AiopsLogLevel, string> = { info: V.brand, warn: V.warn, error: V.error }
const LOG_PAGE_SIZE = 10

/** datetime-local 值（本地时区）转 epoch 毫秒；空值不约束，endOfMinute 把结束边界补到该分钟末。 */
function msOf(value: string, endOfMinute: boolean): number | undefined {
  if (value === '') return undefined
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? undefined : ms + (endOfMinute ? 59_999 : 0)
}

/** 表格时间统一格式：年/月/日 时:分:秒（24 小时制）。 */
function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function LogsTab({ face }: { face: AiopsLogsFace }) {
  const [keyword, setKeyword] = useState('')
  const [kind, setKind] = useState<'' | AiopsLogKind>('')
  const [fromInput, setFromInput] = useState('')
  const [toInput, setToInput] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<AiopsLogPage | undefined>(undefined)
  const [querying, setQuerying] = useState(false)
  const [paging, setPaging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const runQuery = useCallback(async (targetPage: number, intent: 'query' | 'page' = 'query') => {
    const fromMs = msOf(fromInput, false)
    const toMs = msOf(toInput, true)
    // 筛选只在点“查询”时生效；查询按钮与翻页分开反馈，翻页不让查询按钮显示“查询中”
    const setBusy = intent === 'page' ? setPaging : setQuerying
    setBusy(true)
    try {
      const result = await face.queryLogs({
        ...(keyword.trim() === '' ? {} : { keyword: keyword.trim() }),
        ...(kind === '' ? {} : { kind }),
        ...(fromMs === undefined ? {} : { fromMs }),
        ...(toMs === undefined ? {} : { toMs }),
        page: targetPage,
        pageSize: LOG_PAGE_SIZE,
      })
      setData(result)
      setPage(result.page)
      setError(null)
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }, [face, keyword, kind, fromInput, toInput])

  useEffect(() => { void runQuery(1, 'page') }, []) // 仅挂载时首查（静默，不亮查询按钮）；筛选变化由“查询”按钮触发

  const [detail, setDetail] = useState<{ row: AiopsLogRow; text: string } | null>(null)

  const downloadJson = (name: string, value: unknown): void => {
    const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = name
    link.click()
    URL.revokeObjectURL(link.href)
  }

  const openDetail = async (row: AiopsLogRow): Promise<void> => {
    try {
      const [, seq] = row.id.split(':')
      const result = await face.logDetail(row.sessionId, Number(seq))
      setDetail({ row: result.row, text: JSON.stringify({ event: result.eventType, data: result.data }, null, 2) })
      setError(null)
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const exportRow = async (row: AiopsLogRow): Promise<void> => {
    try {
      const [, seq] = row.id.split(':')
      const result = await face.logDetail(row.sessionId, Number(seq))
      downloadJson(`aiops-log-${row.sessionId}-${seq}.json`, { row: result.row, event: result.eventType, data: result.data })
      setError(null)
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / LOG_PAGE_SIZE))

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={card}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
          <input
            value={keyword}
            onChange={(e) => { setKeyword(e.target.value) }}
            onKeyDown={(e) => { if (e.key === 'Enter') void runQuery(1) }}
            placeholder="关键字：节点 / 工具 / 结论摘要"
            style={{ padding: '5px 10px', borderRadius: 6, border: `1px solid ${V.border}`, fontSize: 12.5, minWidth: 220, background: 'transparent', color: V.text }}
          />
          <select
            value={kind}
            onChange={(e) => { setKind(e.target.value as '' | AiopsLogKind) }}
            // 原生弹出层底色跟随 select 背景：透明会在深色主题下渲染成白底白字
            style={{ padding: '5px 10px', borderRadius: 6, border: `1px solid ${V.border}`, fontSize: 12.5, background: V.bg, color: V.text }}
          >
            <option value="" style={optionStyle}>全部类型</option>
            <option value="run" style={optionStyle}>运行</option>
            <option value="model" style={optionStyle}>模型调用</option>
            <option value="tool" style={optionStyle}>工具调用</option>
            <option value="decision" style={optionStyle}>决策</option>
          </select>
          <input
            type="datetime-local"
            value={fromInput}
            onChange={(e) => { setFromInput(e.target.value) }}
            title="开始时间"
            style={{ padding: '5px 8px', borderRadius: 6, border: `1px solid ${V.border}`, fontSize: 12.5, background: 'transparent', color: V.text }}
          />
          <span style={{ fontSize: 12, color: V.text3 }}>至</span>
          <input
            type="datetime-local"
            value={toInput}
            onChange={(e) => { setToInput(e.target.value) }}
            title="结束时间"
            style={{ padding: '5px 8px', borderRadius: 6, border: `1px solid ${V.border}`, fontSize: 12.5, background: 'transparent', color: V.text }}
          />
          <Btn primary disabled={querying} onClick={() => { void runQuery(1) }}>{querying ? '查询中…' : '查询'}</Btn>
        </div>
        {error !== null && <div style={{ fontSize: 12.5, color: V.error, marginBottom: 10 }}>{error}</div>}
        {data === undefined && error === null && <div style={{ fontSize: 12.5, color: V.text3 }}>加载中…</div>}
        {data !== undefined && data.total > 0 && (
          <Table
            head={['时间', '级别', '类型', '智能体', '内容摘要', '操作']}
            widths={[150, 56, 72, 88, undefined, 130]}
            rows={data.rows.map(row => [
              fmtTime(row.time),
              <Tag key="lv" color={LOG_LEVEL_COLORS[row.level]}>{row.level.toUpperCase()}</Tag>,
              LOG_KIND_LABELS[row.kind],
              row.agent,
              row.summary,
              <span key="op" style={{ display: 'flex', gap: 6 }}>
                <Btn onClick={() => { void openDetail(row) }}>详情</Btn>
                <Btn onClick={() => { void exportRow(row) }}>导出</Btn>
              </span>,
            ])}
          />
        )}
        {data !== undefined && data.total === 0 && (
          <div style={{ fontSize: 12.5, color: V.text3, marginTop: 8 }}>无匹配日志，调整筛选条件后重试。</div>
        )}
        <Pager
          total={data?.total ?? 0}
          unit="条日志"
          page={page}
          pages={totalPages}
          busy={querying || paging}
          onPage={(next) => { void runQuery(next, 'page') }}
        />
      </div>

      {detail !== null && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,17,21,.45)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3000 }}>
          <div style={{ ...card, width: 620, maxWidth: '92vw', padding: '16px 18px', display: 'grid', gap: 10, boxShadow: '0 12px 40px rgba(0,0,0,.28)' }}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: V.text }}>日志详情</span>
              <button
                onClick={() => { setDetail(null) }}
                style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: V.text3, cursor: 'pointer', fontSize: 14, padding: '0 2px' }}
              >✕</button>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: V.text3, flexWrap: 'wrap' }}>
              <span>{new Date(detail.row.time).toLocaleString('zh-CN', { hour12: false })}</span>
              <Tag color={LOG_LEVEL_COLORS[detail.row.level]}>{detail.row.level.toUpperCase()}</Tag>
              <Tag color={V.text3}>{LOG_KIND_LABELS[detail.row.kind]}</Tag>
              <span style={{ fontFamily: V.mono }}>{detail.row.sessionId}</span>
            </div>
            <div style={{ fontSize: 13, color: V.text, lineHeight: 1.7 }}>{detail.row.summary}</div>
            <pre style={{
              margin: 0, padding: '10px 12px', borderRadius: 8, border: `1px solid ${V.border}`,
              fontSize: 12, lineHeight: 1.6, fontFamily: V.mono, color: V.text2,
              maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            }}>{detail.text}</pre>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn onClick={() => { face.openLogSession(detail.row.sessionId) }}>打开会话轨迹</Btn>
              <Btn onClick={() => { void exportRow(detail.row) }}>导出本条</Btn>
              <Btn primary onClick={() => { setDetail(null) }}>关闭</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
/* ---------- 记忆管理（真实数据：短期投影自诊断结论，长期晋升持久化，召回配置实时生效） ---------- */
const MEMORY_KIND_LABELS: Record<AiopsMemoryKind, string> = { short: '短期', long: '长期' }
const MEMORY_PAGE_SIZE = 10
/** 短期记忆保留期的可选项（天）；持久值不在列时临时并入。 */
const TTL_DAY_OPTIONS = [1, 3, 7, 14, 30]

function MemoryTab({ face }: { face: AiopsMemoryFace }) {
  const [keyword, setKeyword] = useState('')
  const [kind, setKind] = useState<'' | AiopsMemoryKind>('')
  const [fromInput, setFromInput] = useState('')
  const [toInput, setToInput] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<AiopsMemoryPage | undefined>(undefined)
  const [querying, setQuerying] = useState(false)
  const [paging, setPaging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<AiopsMemoryDetail | null>(null)
  const [forgetting, setForgetting] = useState<AiopsMemoryRow | null>(null)
  const [busy, setBusy] = useState(false)
  const [recall, setRecall] = useState<AiopsRecallConfig | undefined>(undefined)
  const [recallNotice, setRecallNotice] = useState<string | null>(null)

  const runQuery = useCallback(async (targetPage: number, intent: 'query' | 'page' = 'query') => {
    // 筛选只在点“查询”时生效；查询按钮与翻页分开反馈
    const setBusyFlag = intent === 'page' ? setPaging : setQuerying
    setBusyFlag(true)
    try {
      const fromMs = msOf(fromInput, false)
      const toMs = msOf(toInput, true)
      const result = await face.listMemories({
        ...(keyword.trim() === '' ? {} : { keyword: keyword.trim() }),
        ...(kind === '' ? {} : { kind }),
        ...(fromMs === undefined ? {} : { fromMs }),
        ...(toMs === undefined ? {} : { toMs }),
        page: targetPage,
        pageSize: MEMORY_PAGE_SIZE,
      })
      setData(result)
      setPage(result.page)
      setError(null)
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusyFlag(false)
    }
  }, [face, keyword, kind, fromInput, toInput])

  useEffect(() => { void runQuery(1, 'page') }, []) // 仅挂载时首查（静默，不亮查询按钮）；筛选变化由“查询”按钮触发

  useEffect(() => {
    void (async () => {
      try {
        setRecall(await face.getRecallConfig())
      } catch (reason: unknown) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    })()
  }, [face])

  const openDetail = async (row: AiopsMemoryRow) => {
    try {
      setDetail(await face.memoryDetail(row.id))
      setError(null)
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const promote = async (row: AiopsMemoryRow) => {
    if (busy) return
    setBusy(true)
    try {
      await face.promoteMemory(row.id)
      await runQuery(1)
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const confirmForget = async () => {
    if (forgetting === null || busy) return
    setBusy(true)
    try {
      await face.forgetMemory(forgetting.id)
      setForgetting(null)
      setDetail(null)
      await runQuery(page)
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const saveRecall = async () => {
    if (recall === undefined || busy) return
    setBusy(true)
    try {
      const saved = await face.saveRecallConfig({ enabled: recall.enabled, topK: recall.topK, shortTermTtlDays: recall.shortTermTtlDays })
      setRecall(saved)
      setRecallNotice('已保存，下一轮诊断生效')
    } catch (reason: unknown) {
      setRecallNotice(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / MEMORY_PAGE_SIZE))

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={card}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
          <input
            value={keyword}
            onChange={(e) => { setKeyword(e.target.value) }}
            onKeyDown={(e) => { if (e.key === 'Enter') void runQuery(1) }}
            placeholder="关键字：记忆摘要 / 结论内容"
            style={{ padding: '5px 10px', borderRadius: 6, border: `1px solid ${V.border}`, fontSize: 12.5, minWidth: 200, background: 'transparent', color: V.text }}
          />
          <select
            value={kind}
            onChange={(e) => { setKind(e.target.value as '' | AiopsMemoryKind) }}
            style={{ padding: '5px 10px', borderRadius: 6, border: `1px solid ${V.border}`, fontSize: 12.5, background: V.bg, color: V.text }}
          >
            <option value="" style={optionStyle}>全部类型</option>
            <option value="short" style={optionStyle}>短期记忆</option>
            <option value="long" style={optionStyle}>长期记忆</option>
          </select>
          <input
            type="datetime-local"
            value={fromInput}
            onChange={(e) => { setFromInput(e.target.value) }}
            title="开始时间"
            style={{ padding: '5px 8px', borderRadius: 6, border: `1px solid ${V.border}`, fontSize: 12.5, background: 'transparent', color: V.text }}
          />
          <span style={{ fontSize: 12, color: V.text3 }}>至</span>
          <input
            type="datetime-local"
            value={toInput}
            onChange={(e) => { setToInput(e.target.value) }}
            title="结束时间"
            style={{ padding: '5px 8px', borderRadius: 6, border: `1px solid ${V.border}`, fontSize: 12.5, background: 'transparent', color: V.text }}
          />
          <Btn primary disabled={querying} onClick={() => { void runQuery(1) }}>{querying ? '查询中…' : '查询'}</Btn>
        </div>
        {error !== null && <div style={{ fontSize: 12.5, color: V.error, marginBottom: 10 }}>{error}</div>}
        {data === undefined && error === null && <div style={{ fontSize: 12.5, color: V.text3 }}>加载中…</div>}
        {data !== undefined && data.total > 0 && (
          <Table
            head={['智能体', '类型', '记忆摘要', '写入时间', '操作']}
            widths={[88, 56, undefined, 150, 170]}
            rows={data.rows.map(row => [
              row.agent,
              <Tag key="k" color={row.kind === 'long' ? V.success : V.warn}>{MEMORY_KIND_LABELS[row.kind]}</Tag>,
              row.summary,
              fmtTime(row.time),
              <span key="op" style={{ display: 'flex', gap: 6 }}>
                <Btn onClick={() => { void openDetail(row) }}>查看</Btn>
                {row.kind === 'short' && <Btn onClick={() => { void promote(row) }}>晋升</Btn>}
                <Btn onClick={() => { setForgetting(row) }}>遗忘</Btn>
              </span>,
            ])}
          />
        )}
        {data !== undefined && data.total === 0 && (
          <div style={{ fontSize: 12.5, color: V.text3, marginTop: 8 }}>暂无记忆：智能体形成诊断结论后会经 memory_record 主动沉淀为短期记忆。</div>
        )}
        <Pager
          total={data?.total ?? 0}
          unit={data === undefined ? '条记忆' : `条记忆（短期 ${data.shortCount} · 长期 ${data.longCount}）`}
          page={page}
          pages={totalPages}
          busy={querying || paging}
          onPage={(next) => { void runQuery(next, 'page') }}
        />
        <div style={{ fontSize: 12, color: V.text3, marginTop: 8 }}>
          短期记忆由智能体在形成诊断结论时经 memory_record 主动沉淀，晋升后持久保存为长期记忆；超过保留期未晋升的短期记忆自动遗忘。
        </div>
      </div>

      <div style={card}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: V.text, marginBottom: 10 }}>记忆召回配置</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: V.text2 }}>召回条数 Top-</span>
          <select
            value={recall?.topK ?? 3}
            onChange={(e) => { setRecall(previous => previous === undefined ? previous : { ...previous, topK: Number(e.target.value) }) }}
            style={{ padding: '5px 8px', borderRadius: 6, border: `1px solid ${V.border}`, fontSize: 12.5, background: V.bg, color: V.text }}
          >
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => <option key={n} value={n} style={optionStyle}>{n}</option>)}
          </select>
          <span style={{ fontSize: 12, color: V.text2 }}>短期记忆保留期</span>
          <select
            value={recall?.shortTermTtlDays ?? 7}
            onChange={(e) => {
              setRecall(previous => previous === undefined ? previous : { ...previous, shortTermTtlDays: Number(e.target.value) })
            }}
            style={{ padding: '5px 8px', borderRadius: 6, border: `1px solid ${V.border}`, fontSize: 12.5, background: V.bg, color: V.text }}
          >
            {(recall !== undefined && !TTL_DAY_OPTIONS.includes(recall.shortTermTtlDays)
              ? [recall.shortTermTtlDays, ...TTL_DAY_OPTIONS]
              : TTL_DAY_OPTIONS
            ).map(n => <option key={n} value={n} style={optionStyle}>{n} 天</option>)}
          </select>
          <Btn primary disabled={busy || recall === undefined} onClick={() => { void saveRecall() }}>保存配置</Btn>
          {recallNotice !== null && <span style={{ fontSize: 12, color: V.text3 }}>{recallNotice}</span>}
          <span style={{ marginLeft: 'auto' }}>
            <Switch
              on={recall?.enabled ?? false}
              onChange={(next) => { setRecall(previous => previous === undefined ? previous : { ...previous, enabled: next }) }}
              label="记忆召回（智能体按需调用）"
            />
          </span>
        </div>
        <div style={{ fontSize: 12, color: V.text3, marginTop: 8 }}>
          召回开启后，智能体在诊断时经 memory_recall 工具按 Top-N 主动召回长期记忆作为参考；无关问答不注入、不消耗 token。
        </div>
      </div>

      {detail !== null && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,17,21,.45)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3000 }}>
          <div style={{ ...card, width: 620, maxWidth: '92vw', padding: '16px 18px', display: 'grid', gap: 10, boxShadow: '0 12px 40px rgba(0,0,0,.28)' }}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: V.text }}>记忆详情</span>
              <button
                onClick={() => { setDetail(null) }}
                style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: V.text3, cursor: 'pointer', fontSize: 14, padding: '0 2px' }}
              >✕</button>
            </div>
            <div style={{ fontSize: 12, color: V.text3 }}>
              {MEMORY_KIND_LABELS[detail.row.kind]}记忆 · {detail.row.agent} · {new Date(detail.row.time).toLocaleString('zh-CN', { hour12: false })}
            </div>
            <pre style={{ margin: 0, padding: '10px 12px', borderRadius: 6, border: `1px solid ${V.border}`, fontSize: 12, lineHeight: 1.7, color: V.text2, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '46vh', overflow: 'auto', fontFamily: 'inherit' }}>{detail.text}</pre>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn onClick={() => { face.openMemorySession(detail.row.sessionId) }}>打开会话轨迹</Btn>
              <Btn onClick={() => { setDetail(null) }}>关闭</Btn>
            </div>
          </div>
        </div>
      )}

      {forgetting !== null && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,17,21,.45)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3000 }}>
          <div style={{ ...card, width: 380, padding: '16px 18px', display: 'grid', gap: 10, boxShadow: '0 12px 40px rgba(0,0,0,.28)' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: V.text }}>遗忘记忆</div>
            <div style={{ fontSize: 13, color: V.text2, lineHeight: 1.7 }}>
              确认遗忘「{forgetting.summary}」？{forgetting.kind === 'long' ? '长期记忆将被删除。' : '该短期记忆将不再出现在清单中。'}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn onClick={() => { setForgetting(null) }}>取消</Btn>
              <Btn danger onClick={() => { void confirmForget() }}>{busy ? '遗忘中…' : '确认遗忘'}</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ---------- MCP 接口管理（Nacos MCP 注册中心清单 + 连接/断开动态挂载，真实分页） ---------- */
const MCP_PAGE_SIZE = 8

function McpTab({ face }: { face: AiopsMcpFace }) {
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<AiopsMcpServerPage | undefined>(undefined)
  const [querying, setQuerying] = useState(false)
  const [paging, setPaging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyName, setBusyName] = useState<string | null>(null)
  const [detailBusyName, setDetailBusyName] = useState<string | null>(null)
  const [detail, setDetail] = useState<AiopsMcpServerDetail | null>(null)
  const [settings, setSettings] = useState<AiopsMcpSettings | undefined>(undefined)
  const [switchSaving, setSwitchSaving] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [configDraft, setConfigDraft] = useState<AiopsMcpSettings>({
    registryOrigin: '', namespaceId: 'public', authToken: '', consoleOrigin: '', consoleUsername: '', consolePassword: '', autoInvoke: true,
  })
  const [registerOpen, setRegisterOpen] = useState(false)
  const [registerDraft, setRegisterDraft] = useState<AiopsMcpRegisterInput>({ name: '', description: '', url: '', version: '1.0.0' })
  const [registerError, setRegisterError] = useState<string | null>(null)
  const [registerSaving, setRegisterSaving] = useState(false)
  const [unregistering, setUnregistering] = useState<AiopsMcpServerRow | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)
  const [configSaving, setConfigSaving] = useState(false)

  const runQuery = useCallback(async (targetPage: number, intent: 'query' | 'page' = 'query') => {
    const setBusyFlag = intent === 'page' ? setPaging : setQuerying
    setBusyFlag(true)
    try {
      const result = await face.listServers({
        ...(keyword.trim() === '' ? {} : { keyword: keyword.trim() }),
        page: targetPage,
        pageSize: MCP_PAGE_SIZE,
      })
      setData(result)
      setPage(result.page)
      setError(null)
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusyFlag(false)
    }
  }, [face, keyword])

  useEffect(() => {
    void runQuery(1, 'page') // 仅挂载时首查（静默）；筛选变化由“查询”按钮触发
    void face.getSettings().then(setSettings).catch(() => undefined)
  }, [])

  const openConfig = async () => {
    setConfigError(null)
    setConfigOpen(true)
    try {
      const current = await face.getSettings()
      setSettings(current)
      setConfigDraft(current)
    } catch (reason: unknown) {
      setConfigError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const saveConfig = async () => {
    if (configSaving) return
    setConfigSaving(true)
    setConfigError(null)
    try {
      const saved = await face.saveSettings({
        ...configDraft,
        registryOrigin: configDraft.registryOrigin.trim(),
        consoleOrigin: configDraft.consoleOrigin.trim(),
      })
      setSettings(saved)
      setConfigOpen(false)
      await runQuery(1)
    } catch (reason: unknown) {
      setConfigError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setConfigSaving(false)
    }
  }

  const submitRegister = async () => {
    if (registerSaving) return
    setRegisterSaving(true)
    setRegisterError(null)
    try {
      await face.registerServer({
        name: registerDraft.name.trim(),
        description: registerDraft.description.trim(),
        url: registerDraft.url.trim(),
        ...(registerDraft.version === undefined || registerDraft.version.trim() === '' ? {} : { version: registerDraft.version.trim() }),
      })
      setRegisterOpen(false)
      setRegisterDraft({ name: '', description: '', url: '', version: '1.0.0' })
      await runQuery(1)
    } catch (reason: unknown) {
      setRegisterError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setRegisterSaving(false)
    }
  }

  const confirmUnregister = async () => {
    if (unregistering === null || busyName !== null) return
    setBusyName(unregistering.name)
    try {
      await face.unregisterServer(unregistering.name)
      setUnregistering(null)
      setDetail(null)
      await runQuery(page, 'page')
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusyName(null)
    }
  }

  const flipInvoke = async (value: boolean) => {
    if (settings === undefined || switchSaving) return
    const previous = settings
    const next = { ...settings, autoInvoke: value }
    setSettings(next)
    setSwitchSaving(true)
    try {
      await face.saveSettings(next)
      await runQuery(page, 'page')
    } catch (reason: unknown) {
      setSettings(previous)
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSwitchSaving(false)
    }
  }

  const connect = async (row: AiopsMcpServerRow) => {
    if (busyName !== null) return
    setBusyName(row.name)
    try {
      await face.connectServer(row.name)
      await runQuery(page, 'page')
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusyName(null)
    }
  }

  const disconnect = async (row: AiopsMcpServerRow) => {
    if (busyName !== null) return
    setBusyName(row.name)
    try {
      await face.disconnectServer(row.name)
      await runQuery(page, 'page')
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusyName(null)
    }
  }

  const openDetail = async (row: AiopsMcpServerRow) => {
    if (detailBusyName !== null || busyName !== null) return
    setDetailBusyName(row.name)
    try {
      setDetail(await face.getServerDetail(row.name))
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setDetailBusyName(null)
    }
  }

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / MCP_PAGE_SIZE))
  const invokeOn = settings?.autoInvoke ?? true

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <FuncCard name="服务连接" kind="manage">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
          <input
            value={keyword}
            onChange={(e) => { setKeyword(e.target.value) }}
            onKeyDown={(e) => { if (e.key === 'Enter') void runQuery(1) }}
            placeholder="查询：服务名称 / 描述"
            style={{ padding: '5px 10px', borderRadius: 6, border: `1px solid ${V.border}`, fontSize: 12.5, minWidth: 200, background: 'transparent', color: V.text }}
          />
          <Btn primary disabled={querying} onClick={() => { void runQuery(1) }}>{querying ? '查询中…' : '查询'}</Btn>
          <Btn primary onClick={() => { setRegisterError(null); setRegisterOpen(true) }}>添加 MCP Server</Btn>
          <span style={{ marginLeft: 'auto' }}>
            <Btn onClick={() => { void openConfig() }}>注册中心配置</Btn>
          </span>
        </div>
        {error !== null && <div style={{ fontSize: 12.5, color: V.error, marginBottom: 10 }}>{error}</div>}
        {data === undefined && error === null && <div style={{ fontSize: 12.5, color: V.text3 }}>加载中…</div>}
        {data !== undefined && data.total === 0 && (
          <div style={{ fontSize: 12.5, color: V.text3 }}>注册中心暂无匹配 MCP Server，可点「添加 MCP Server」注册。</div>
        )}
        {data !== undefined && data.total > 0 && (
          <div style={grid}>
            {data.rows.map(row => (
              <ItemCard
                key={row.name}
                icon={row.name.replace(/^(mcp|ks)-/, '').slice(0, 1)} iconColor={row.connected ? '#2ea44f' : '#8a94a6'}
                name={row.name} meta={`${row.name} · v${row.version}${row.toolCount === undefined ? '' : ` · 工具 ${row.toolCount}`}`}
                desc={row.description}
                tags={[
                  { color: V.text3, text: row.transport },
                  row.connected
                    ? { color: V.success, text: '已连接' }
                    : { color: V.text3, text: '未连接' },
                ]}
                highlight={row.connected}
                actions={<span style={{ display: 'flex', gap: 6 }}>
                  <Btn disabled={busyName === row.name || detailBusyName === row.name} onClick={() => { void openDetail(row) }}>详情</Btn>
                  {row.connected
                    ? <Btn disabled={busyName === row.name} onClick={() => { void disconnect(row) }}>{busyName === row.name ? '断开中…' : '断开'}</Btn>
                    : <Btn primary disabled={busyName === row.name || !invokeOn} onClick={() => { void connect(row) }}>{busyName === row.name ? '连接中…' : '连接'}</Btn>}
                </span>}
              />
            ))}
          </div>
        )}
        <Pager
          total={data?.total ?? 0}
          unit="个 MCP Server"
          page={page}
          pages={totalPages}
          busy={querying || paging}
          onPage={(next) => { void runQuery(next, 'page') }}
        />
      </FuncCard>
      <FuncCard name="工具调用" kind="runtime">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Note>连接后 MCP Server 的工具即时挂载到本宿主，执行引擎按推理决策自动调用，调用时按 JSON Schema 校验参数；高危工具调用前经权限审批策略强制人工确认，全程审计留痕。关闭后断开全部连接且不再允许新连接。</Note>
          <Switch
            on={invokeOn}
            onChange={(v) => { void flipInvoke(v) }}
            label={invokeOn ? '按推理决策自动调用工具' : '已停用'}
          />
        </div>
      </FuncCard>

      {configOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,17,21,.45)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3000 }}>
          <div style={{ ...card, width: 420, padding: '16px 18px', display: 'grid', gap: 10, boxShadow: '0 12px 40px rgba(0,0,0,.28)' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: V.text }}>注册中心配置</div>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: V.text3 }}>注册中心地址</span>
              <input
                value={configDraft.registryOrigin}
                onChange={(e) => { setConfigDraft({ ...configDraft, registryOrigin: e.target.value }) }}
                placeholder="http://192.168.10.95:9080"
                style={{ padding: '6px 10px', borderRadius: 6, border: `1px solid ${V.border}`, fontSize: 12.5, background: 'transparent', color: V.text, fontFamily: V.mono }}
              />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: V.text3 }}>命名空间</span>
              <input
                value={configDraft.namespaceId}
                onChange={(e) => { setConfigDraft({ ...configDraft, namespaceId: e.target.value }) }}
                placeholder="public"
                style={{ padding: '6px 10px', borderRadius: 6, border: `1px solid ${V.border}`, fontSize: 12.5, background: 'transparent', color: V.text, fontFamily: V.mono }}
              />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: V.text3 }}>MCP 对接 Token（连接时以 Bearer 携带）</span>
              <input
                type="password"
                value={configDraft.authToken}
                onChange={(e) => { setConfigDraft({ ...configDraft, authToken: e.target.value }) }}
                placeholder="平台分配的对接口令"
                style={{ padding: '6px 10px', borderRadius: 6, border: `1px solid ${V.border}`, fontSize: 12.5, background: 'transparent', color: V.text, fontFamily: V.mono }}
              />
            </label>
            <div style={{ borderTop: `1px solid ${V.border}`, paddingTop: 8, fontSize: 12, color: V.text3 }}>注册/注销写入所用的 Nacos 控制台账号：</div>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: V.text3 }}>控制台地址</span>
              <input
                value={configDraft.consoleOrigin}
                onChange={(e) => { setConfigDraft({ ...configDraft, consoleOrigin: e.target.value }) }}
                placeholder="http://192.168.10.95:8080"
                style={{ padding: '6px 10px', borderRadius: 6, border: `1px solid ${V.border}`, fontSize: 12.5, background: 'transparent', color: V.text, fontFamily: V.mono }}
              />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: V.text3 }}>控制台账号 / 密码</span>
              <input
                value={configDraft.consoleUsername}
                onChange={(e) => { setConfigDraft({ ...configDraft, consoleUsername: e.target.value }) }}
                placeholder="nacos"
                style={{ padding: '6px 10px', borderRadius: 6, border: `1px solid ${V.border}`, fontSize: 12.5, background: 'transparent', color: V.text, fontFamily: V.mono }}
              />
              <input
                type="password"
                value={configDraft.consolePassword}
                onChange={(e) => { setConfigDraft({ ...configDraft, consolePassword: e.target.value }) }}
                placeholder="控制台密码"
                style={{ padding: '6px 10px', borderRadius: 6, border: `1px solid ${V.border}`, fontSize: 12.5, background: 'transparent', color: V.text, fontFamily: V.mono }}
              />
            </label>
            {configError !== null && <div style={{ fontSize: 12.5, color: V.error }}>{configError}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn onClick={() => { setConfigOpen(false) }}>取消</Btn>
              <Btn primary disabled={configSaving} onClick={() => { void saveConfig() }}>{configSaving ? '保存中…' : '保存'}</Btn>
            </div>
          </div>
        </div>
      )}

      {detail !== null && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,17,21,.45)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3000 }}>
          <div style={{ ...card, width: 480, padding: '16px 18px', display: 'grid', gap: 10, boxShadow: '0 12px 40px rgba(0,0,0,.28)' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: V.text }}>MCP Server 详情</div>
            <div style={{ fontSize: 12.5, color: V.text2, lineHeight: 1.9 }}>
              <div>名称：<span style={{ fontFamily: V.mono }}>{detail.row.name}</span></div>
              <div>版本：{detail.row.version} · 协议：{detail.row.transport}</div>
              <div>端点：<span style={{ fontFamily: V.mono }}>{detail.row.url || '—'}</span></div>
              <div>连接：{detail.row.connected ? '已连接（工具已挂载）' : '未连接'}</div>
              <div style={{ marginTop: 6, borderTop: `1px solid ${V.border}`, paddingTop: 8 }}>{detail.row.description}</div>
              {detail.tools.length > 0 && (
                <div style={{ marginTop: 6, borderTop: `1px solid ${V.border}`, paddingTop: 8 }}>
                  工具（{detail.tools.length}）：
                  {detail.tools.map(tool => (
                    <div key={tool.name} style={{ marginTop: 4 }}>
                      <span style={{ fontFamily: V.mono, color: V.brand }}>{tool.name}</span>
                      <span style={{ color: V.text3 }}> — {tool.description}</span>
                    </div>
                  ))}
                </div>
              )}
              {detail.tools.length === 0 && !detail.row.connected && (
                <div style={{ marginTop: 6, borderTop: `1px solid ${V.border}`, paddingTop: 8, color: V.text3 }}>连接后显示实际工具清单。</div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn danger onClick={() => { setUnregistering(detail.row) }}>注销</Btn>
              <Btn onClick={() => { setDetail(null) }}>关闭</Btn>
            </div>
          </div>
        </div>
      )}

      {registerOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,17,21,.45)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3000 }}>
          <div style={{ ...card, width: 440, padding: '16px 18px', display: 'grid', gap: 10, boxShadow: '0 12px 40px rgba(0,0,0,.28)' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: V.text }}>添加 MCP Server</div>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: V.text3 }}>名称（字母数字、-、_，≤32 字符）</span>
              <input
                value={registerDraft.name}
                onChange={(e) => { setRegisterDraft({ ...registerDraft, name: e.target.value }) }}
                placeholder="mcp-monitor"
                style={{ padding: '6px 10px', borderRadius: 6, border: `1px solid ${V.border}`, fontSize: 12.5, background: 'transparent', color: V.text, fontFamily: V.mono }}
              />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: V.text3 }}>端点 URL（streamable-http）</span>
              <input
                value={registerDraft.url}
                onChange={(e) => { setRegisterDraft({ ...registerDraft, url: e.target.value }) }}
                placeholder="http://192.168.10.95:9091/mcp"
                style={{ padding: '6px 10px', borderRadius: 6, border: `1px solid ${V.border}`, fontSize: 12.5, background: 'transparent', color: V.text, fontFamily: V.mono }}
              />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: V.text3 }}>描述</span>
              <input
                value={registerDraft.description}
                onChange={(e) => { setRegisterDraft({ ...registerDraft, description: e.target.value }) }}
                placeholder="该 MCP Server 提供的能力说明"
                style={{ padding: '6px 10px', borderRadius: 6, border: `1px solid ${V.border}`, fontSize: 12.5, background: 'transparent', color: V.text }}
              />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: V.text3 }}>版本</span>
              <input
                value={registerDraft.version ?? ''}
                onChange={(e) => { setRegisterDraft({ ...registerDraft, version: e.target.value }) }}
                placeholder="1.0.0"
                style={{ padding: '6px 10px', borderRadius: 6, border: `1px solid ${V.border}`, fontSize: 12.5, background: 'transparent', color: V.text, fontFamily: V.mono }}
              />
            </label>
            <div style={{ fontSize: 12, color: V.text3 }}>注册时将自动握手端点发现并登记工具清单；对接 Token 取「注册中心配置」中的值。</div>
            {registerError !== null && <div style={{ fontSize: 12.5, color: V.error }}>{registerError}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn onClick={() => { setRegisterOpen(false) }}>取消</Btn>
              <Btn primary disabled={registerSaving} onClick={() => { void submitRegister() }}>{registerSaving ? '注册中…' : '注册'}</Btn>
            </div>
          </div>
        </div>
      )}

      {unregistering !== null && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,17,21,.45)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3000 }}>
          <div style={{ ...card, width: 380, padding: '16px 18px', display: 'grid', gap: 10, boxShadow: '0 12px 40px rgba(0,0,0,.28)' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: V.text }}>注销 MCP Server</div>
            <div style={{ fontSize: 13, color: V.text2, lineHeight: 1.7 }}>
              确认从注册中心注销「{unregistering.name}」？本机的连接会先行断开，注册条目删除后不可恢复（可重新注册）。
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn onClick={() => { setUnregistering(null) }}>取消</Btn>
              <Btn danger onClick={() => { void confirmUnregister() }}>{busyName === unregistering.name ? '注销中…' : '确认注销'}</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ---------- 页面骨架 ---------- */
// 智能体/日志/记忆页签单独渲染：它们需要 apply 注入的数据面，View 仅承载纯展示页签。
const TABS = [
  { key: 'agents', label: '智能体管理', Icon: IconAgentPresetOutlineRegular, View: undefined },
  { key: 'rag', label: 'RAG 管理', Icon: IconDatabaseOutlineRegular, View: RagTab },
  { key: 'skills', label: 'skills 管理', Icon: IconSkillOutlineRegular, View: undefined },
  { key: 'logs', label: '日志管理', Icon: IconChecklistOutlineRegular, View: undefined },
  { key: 'memory', label: '记忆管理', Icon: IconThinkOutlineRegular, View: undefined },
  { key: 'mcp', label: 'MCP 接口管理', Icon: IconApiOutlineRegular, View: undefined },
] as const

type TabKey = (typeof TABS)[number]['key']

type Account = { name: string; role: number }

/** 平台角色 → 控制台视图：1（系统管理员）可见全部资源，其余角色按普通运维账户过滤 */
function toConsoleRole(role: number): Role {
  return role === 1 ? 'admin' : 'os'
}

/** 平台账户共享状态：localStorage 键 + 窗口事件，与左下角账户组件（ui-settings-account）共用。 */
const PLATFORM_KEY = 'aiops.account'
const PLATFORM_EVENT = 'aiops-account'

function readPlatformAccount(): Account | null {
  try {
    const raw = localStorage.getItem(PLATFORM_KEY)
    return raw ? JSON.parse(raw) as Account : null
  } catch { return null }
}

/** 控制台主页：六模块页签 + 卡片式内容区；账户体系统一在左下角（ui-settings-account 平台账户模式）。 */
export function AiopsConsolePage(props: {
  t?: (key: AiopsLocaleKey) => string
  agents: AiopsAgentsFace
  logs: AiopsLogsFace
  memory: AiopsMemoryFace
  skills: AiopsSkillsFace
  mcp: AiopsMcpFace
}) {
  const { t, agents: agentsFace, logs: logsFace, memory: memoryFace, skills: skillsFace, mcp: mcpFace } = props
  // 初始页签：平台入口页跳转指定（pf_tab Cookie → consumeInitialTab），默认智能体管理
  const [tab, setTab] = useState<TabKey>(() => {
    const v = consumeInitialTab()
    return TABS.some(x => x.key === v) ? v as TabKey : 'agents'
  })
  const [account, setAccount] = useState<Account | null>(readPlatformAccount)
  useEffect(() => {
    const sync = () => { setAccount(readPlatformAccount()) }
    window.addEventListener(PLATFORM_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(PLATFORM_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])
  const Active = TABS.find(x => x.key === tab && x.View !== undefined)?.View
  const role: Role = account ? toConsoleRole(account.role) : 'admin'

  return (
    <div style={{ padding: '20px 24px', maxWidth: 980, margin: '0 auto', color: V.text }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{t?.('title') ?? '智能运维控制台'}</div>
      </div>
      {!account ? (
        <FuncCard name="统一账号认证" kind="manage">
          <Note>
            智能运维控制台复用基础运维平台（资源性能监控平台）的账号体系统一认证，账户入口在左下角：
            点击左下角"平台账户登录"，输入平台账号与口令完成登录。
            管理员账号（如 sysadm）登录后可见全部智能体与 RAG / skills / 日志 / 记忆 / MCP 资源；
            普通运维账号（如 osadm）登录后仅可见其所对接系统的资源，资源按账户权限自动过滤。
          </Note>
        </FuncCard>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${V.border}`, marginBottom: 16 }}>
            {TABS.map(({ key, label, Icon }) => (
              <button
                key={key}
                onClick={() => { setTab(key) }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap',
                  padding: '8px 14px', border: 'none', background: 'transparent',
                  color: tab === key ? V.brand : V.text2,
                  borderBottom: tab === key ? `2px solid ${V.brand}` : '2px solid transparent',
                  fontWeight: tab === key ? 600 : 400,
                }}
              >
                <Icon size={15} />
                {label}
              </button>
            ))}
          </div>
          {tab === 'agents'
            ? <AgentsTab face={agentsFace} />
            : tab === 'logs'
              ? <LogsTab face={logsFace} />
              : tab === 'skills'
                ? <SkillsTab face={skillsFace} />
                : tab === 'mcp'
                  ? <McpTab face={mcpFace} />
                  : tab === 'memory' || Active === undefined
                    ? <MemoryTab face={memoryFace} />
                    : <Active role={role} />}
        </>
      )}
    </div>
  )
}
