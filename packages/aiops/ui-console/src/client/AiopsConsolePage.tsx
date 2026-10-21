/**
 * 智能运维控制台页面：智能体管理 / RAG 管理 / skills 管理 / 日志管理 / 记忆管理 / MCP 接口管理
 * 六个模块页签。RAG / skills / MCP 以市场式卡片网格展示管理对象，清单分页展示；
 * 每个功能卡片标注功能属性（管理功能 / 运行时能力），原型数据，样式随 dsh 主题变量。
 * 控制台按登录账户权限过滤可见资源：普通账户仅见所对接系统的智能体与资源，管理员可见全部。
 * 会话管理直接复用 dsh 既有会话功能，不在控制台重复建设。
 */
import { useState } from 'react'
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
  text: 'var(--dsw-alias-label-primary)',
  text2: 'var(--dsw-alias-label-secondary)',
  text3: 'var(--dsw-alias-label-tertiary)',
  bg: 'var(--dsw-alias-bg-module-platform)',
  border: 'var(--dsw-alias-border-l)',
  brand: 'var(--dsw-alias-brand-primary)',
  success: 'var(--dsw-alias-state-success-primary)',
  warn: 'var(--dsw-alias-state-warn-label)',
  error: 'var(--dsw-alias-state-error-primary)',
  radius: 'var(--dsw-radius-md)',
  mono: 'var(--dsw-font-mono)',
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

function Tag({ color, children }: { color: string; children: unknown }) {
  return (
    <span style={{
      fontSize: 12, color, border: `1px solid ${color}`, borderRadius: 4,
      padding: '0 6px', lineHeight: '18px', whiteSpace: 'nowrap',
    }}>{children as never}</span>
  )
}

function Btn({ primary, onClick, children }: { primary?: boolean; onClick?: () => void; children: unknown }) {
  return (
    <button onClick={onClick} style={{
      fontSize: 12, cursor: 'pointer', borderRadius: 6, padding: '3px 10px', whiteSpace: 'nowrap',
      border: primary ? 'none' : `1px solid ${V.border}`,
      background: primary ? V.brand : 'transparent',
      color: primary ? '#ffffff' : V.text2,
    }}>{children as never}</button>
  )
}

/** 运行时能力开关：非管理功能，以开关形式呈现启用状态。 */
function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <span
      onClick={() => onChange(!on)}
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

function Table({ head, rows }: { head: string[]; rows: (unknown)[][] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr>{head.map(h => (
          <th key={h} style={{ textAlign: 'left', padding: '8px 10px', color: V.text3, fontWeight: 400, borderBottom: `1px solid ${V.border}` }}>{h}</th>
        ))}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>{r.map((c, j) => (
            <td key={j} style={{ padding: '9px 10px', color: V.text, borderBottom: `1px solid ${V.border}`, verticalAlign: 'top' }}>{c as never}</td>
          ))}</tr>
        ))}
      </tbody>
    </table>
  )
}

/** 分页条：清单统一分页展示。 */
function Pager({ total, unit }: { total: number; unit: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12, color: V.text3 }}>
      <span>共 {total} {unit}</span>
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
        <Btn>‹ 上一页</Btn><span>1 / 1 页</span><Btn>下一页 ›</Btn>
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
  icon: string; iconColor: string; name: string; meta?: string; desc: string;
  tags?: { color: string; text: string }[]; source: string; actions: unknown; highlight?: boolean
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
      <div style={{
        fontSize: 12.5, color: V.text2, lineHeight: 1.7, flex: 1,
        display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
      }}>{props.desc}</div>
      {props.tags && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{props.tags.map((tg, i) => <Tag key={i} color={tg.color}>{tg.text}</Tag>)}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderTop: `1px solid ${V.border}`, paddingTop: 8 }}>
        <span style={{ fontSize: 11.5, color: V.text3, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{props.source}</span>
        {props.actions as never}
      </div>
    </div>
  )
}

function Note({ children }: { children: unknown }) {
  return <div style={{ fontSize: 12.5, color: V.text2, lineHeight: 1.8 }}>{children as never}</div>
}

/* ---------- 智能体管理（生命周期 + 会话关联 + 智能体间协作；按账户权限过滤） ---------- */
/** 智能体实例卡片：头像 + 职责 + 模型 + 上次活跃 + 最近会话摘要 + 打开会话入口。 */
function AgentCard(props: {
  icon: string; iconColor: string; name: string; role: string; model: string;
  lastActive: string; lastSession: string; sessions: number; running: boolean; source: string; highlight?: boolean;
  onOpen?: () => void
}) {
  return (
    <div style={{
      ...card, display: 'flex', flexDirection: 'column', gap: 8,
      border: props.highlight ? `1px solid ${V.brand}` : `1px solid ${V.border}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{
          width: 38, height: 38, borderRadius: 19, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: props.iconColor, color: '#fff', fontSize: 16, fontWeight: 600,
        }}>{props.icon}</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: V.text }}>{props.name}</div>
          <div style={{ fontSize: 11.5, color: V.text3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{props.role}</div>
        </div>
        <span style={{ marginLeft: 'auto' }}>{props.running ? <Tag color={V.success}>运行中</Tag> : <Tag color={V.warn}>已停止</Tag>}</span>
      </div>
      <div style={{ fontSize: 11.5, color: V.text3, fontFamily: V.mono }}>{props.model}</div>
      <div style={{ fontSize: 12, color: V.text3 }}>上次活跃：{props.lastActive} · 会话 {props.sessions} 个</div>
      <div style={{
        fontSize: 12.5, color: V.text2, lineHeight: 1.7, flex: 1,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>最近会话：{props.lastSession}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderTop: `1px solid ${V.border}`, paddingTop: 8 }}>
        <Btn primary onClick={props.onOpen}>打开会话</Btn>
        <Btn>配置</Btn>
        <Btn>{props.running ? '停止' : '启动'}</Btn>
        <span style={{ marginLeft: 'auto', fontSize: 11.5, color: V.text3 }}>{props.source}</span>
      </div>
    </div>
  )
}

/* ---------- 打开会话：跳转 dsh 既有会话界面并标识所属智能体实例 ---------- */
/** 点击"打开会话"：跳转 dsh 既有会话界面（新建会话入口），展开侧边栏会话列表，并在会话界面顶部注入所属智能体标识徽标。 */
function openAgentSession(agent: { name: string; icon: string; color: string }) {
  const byLabel = (l: string) =>
    Array.from(document.querySelectorAll('button')).find(x => x.getAttribute('aria-label') === l) as HTMLButtonElement | undefined
  const newChat =
    byLabel('新建会话') ??
    (Array.from(document.querySelectorAll('button')).find(x => (x.textContent || '').trim() === '新建会话') as HTMLButtonElement | undefined)
  if (newChat) newChat.click()
  else {
    byLabel('打开侧边栏')?.click()
    setTimeout(() => byLabel('新建会话')?.click(), 120)
  }
  setTimeout(() => {
    const toggle = byLabel('打开侧边栏')
    if (toggle) toggle.click()
    document.getElementById('aiops-agent-badge')?.remove()
    const badge = document.createElement('div')
    badge.id = 'aiops-agent-badge'
    badge.style.cssText = [
      'position:fixed', 'top:12px', 'left:50%', 'transform:translateX(-50%)', 'z-index:9999',
      'display:flex', 'align-items:center', 'gap:8px', 'padding:5px 14px', 'border-radius:16px',
      'background:var(--dsw-alias-bg-module-platform,#fff)',
      'border:1px solid var(--dsw-alias-brand-primary,#5b6ee1)',
      'box-shadow:0 2px 10px rgba(0,0,0,.10)', 'font-size:12.5px',
      'color:var(--dsw-alias-label-primary,#222)',
    ].join(';')
    badge.innerHTML =
      `<span style="width:18px;height:18px;border-radius:9px;background:${agent.color};color:#fff;` +
      `display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:600">${agent.icon}</span>` +
      `<span>当前会话智能体：<b>${agent.name}</b></span>` +
      `<span style="color:var(--dsw-alias-label-tertiary,#999)">会话归属该实例 · 按登录账户隔离</span>`
    document.body.appendChild(badge)
  }, 80)
}

function AgentsTab({ role }: { role: Role }) {
  const [collab, setCollab] = useState(true)
  const agents = [
    { key: 'hpc' as const, scope: 'hpc' as Scope, card: (
      <AgentCard
        icon="H" iconColor="#5b6ee1" name="HPC 智能体" role="调度诊断 · 对接 HPC 调度器"
        model="deepseek-chat（私有化）" lastActive="10 分钟前" sessions={12}
        lastSession="job-88213 作业排队超时：队列 gpu-normal 资源占满，建议…"
        running source="对接：HPC 调度器（SLURM / PBS）" highlight
        onOpen={() => openAgentSession({ name: 'HPC 智能体', icon: 'H', color: '#5b6ee1' })}
      />
    ) },
    { key: 'os' as const, scope: 'os' as Scope, card: (
      <AgentCard
        icon="O" iconColor="#2ea44f" name="OS 智能体" role="系统/硬件诊断 · 对接运维平台"
        model="deepseek-chat（私有化）" lastActive="2 小时前" sessions={28}
        lastSession="node-032 掉线根因：ToR 端口误码率 6.2%，建议切换备用链路…"
        running source="对接：运维平台（资源性能监控平台）"
        onOpen={() => openAgentSession({ name: 'OS 智能体', icon: 'O', color: '#2ea44f' })}
      />
    ) },
  ].filter(a => vis(a.scope, role))
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <FuncCard name="智能体生命周期管理" kind="manage">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
          <Btn primary>创建智能体</Btn>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: V.text3 }}>
            智能体实例 {agents.length} 个 · 运行中 {agents.length} 个{role !== 'admin' ? '（按账户权限过滤）' : ''}
          </span>
        </div>
        <div style={grid}>{agents.map((a, i) => <span key={i} style={{ display: 'contents' }}>{a.card}</span>)}</div>
        <div style={{ fontSize: 12, color: V.text3, marginTop: 10 }}>
          智能体以独立实例创建与运行，按实例绑定技能、工具与知识范围并相互隔离；支持创建、配置、启停与销毁等全生命周期管理；每个实例的会话独立归属，经"打开会话"跳转 dsh 会话界面并标识所属智能体实例，进入诊断交互。普通账户仅展示所对接系统的智能体，管理员账户可见全部实例。
        </div>
        <Pager total={agents.length} unit="个实例" />
      </FuncCard>
      <FuncCard name="智能体间协作转派" kind="runtime">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Note>HPC 智能体诊断过程中识别问题属于 OS 层面时，经实例间协作通道通知 OS 智能体接手完成故障定位与处置，处置过程与结果回传发起方并纳入统一审计；反向转派同理。</Note>
          <Switch on={collab} onChange={setCollab} label="智能体间协作转派" />
        </div>
      </FuncCard>
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

/* ---------- skills 管理（卡片内安装/卸载，分页；按账户权限过滤） ---------- */
function SkillsTab({ role }: { role: Role }) {
  const [discover, setDiscover] = useState(true)
  const [invoke, setInvoke] = useState(true)
  const skills = [
    { scope: 'os' as Scope, card: (
      <ItemCard
        icon="诊" iconColor="#5b6ee1" name="节点掉线诊断" meta="skill-node-down · v1.4"
        desc="节点 down / 失联告警触发：依次执行状态查询、误码指标采集与链路检查，输出根因与处置建议。"
        tags={[{ color: V.success, text: '已加载' }]}
        source="来自 技能库"
        actions={<Btn>卸载</Btn>}
        highlight
      />
    ) },
    { scope: 'hpc' as Scope, card: (
      <ItemCard
        icon="链" iconColor="#2ea44f" name="IB 链路诊断" meta="skill-ib-diag · v1.2"
        desc="IB 计数器异常触发：采集端口误码与链路抖动指标，定位端口 / 线缆 / 交换机侧根因。"
        tags={[{ color: V.success, text: '已加载' }]}
        source="来自 技能库"
        actions={<Btn>卸载</Btn>}
      />
    ) },
    { scope: 'shared' as Scope, card: (
      <ItemCard
        icon="温" iconColor="#b26a00" name="GPU 温度排查" meta="skill-gpu-temp · v1.1"
        desc="温度超阈值告警触发：检查风扇转速、防尘网与功耗曲线，输出散热处置建议。"
        tags={[{ color: V.success, text: '已加载' }]}
        source="来自 技能库"
        actions={<Btn>卸载</Btn>}
      />
    ) },
    { scope: 'os' as Scope, card: (
      <ItemCard
        icon="储" iconColor="#7a52c9" name="存储挂载只读恢复" meta="skill-mount-ro · v1.0"
        desc="挂载点只读告警触发：检查存储端连接数与挂载参数，执行重挂载恢复流程。"
        tags={[{ color: V.warn, text: '未加载' }]}
        source="来自 技能库"
        actions={<Btn primary>安装</Btn>}
      />
    ) },
  ].filter(s => vis(s.scope, role))
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <FuncCard name="skill 安装卸载" kind="manage">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
          <span style={{ ...card, padding: '4px 10px', fontSize: 12, color: V.text3, minWidth: 180 }}>查询：skill 名称 / 标识 / 能力标签</span>
          <Btn>查询</Btn>
          <span style={{ fontSize: 12, color: V.text3 }}>技能库：nacos 注册中心 · 当前可见 {skills.length} 个</span>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: V.text3 }}>安装 / 卸载即时生效，无需重启</span>
        </div>
        <div style={grid}>{skills.map((s, i) => <span key={i} style={{ display: 'contents' }}>{s.card}</span>)}</div>
        <Pager total={skills.length} unit="个 skill" />
      </FuncCard>
      <FuncCard name="skill 发现" kind="runtime">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Note>监听技能库（nacos）注册信息，自动扫描发现可用 skill 并按需读取 skill 定义；清单支持按标识、能力标签查询。</Note>
          <Switch on={discover} onChange={setDiscover} label="自动发现（监听技能库）" />
        </div>
      </FuncCard>
      <FuncCard name="skill 调用" kind="runtime">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Note>根据任务意图匹配命中 skill，解析定义文件并按步骤时序编排执行（含参数校验与分支判断），执行结果回传推理决策。</Note>
          <Switch on={invoke} onChange={setInvoke} label="按任务意图自动调用 skill" />
        </div>
      </FuncCard>
    </div>
  )
}

/* ---------- 日志管理（多条件检索 + 详情查看 / 导出，分页） ---------- */
function LogsTab() {
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <FuncCard name="日志查询检索" kind="manage">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
          <span style={{ ...card, padding: '4px 10px', fontSize: 12, color: V.text3 }}>时间范围：2026-10-20 全天</span>
          <span style={{ ...card, padding: '4px 10px', fontSize: 12, color: V.text, fontFamily: V.mono }}>关键字：node-032</span>
          <Btn primary>查询</Btn>
          <Btn>导出</Btn>
        </div>
        <Table
          head={['时间', '级别', '类型', '内容摘要', '操作']}
          rows={[
            ['14:22:01', <Tag key="l1" color={V.brand}>INFO</Tag>, '运行', '诊断会话创建，载入故障上下文（node-032 down）', <span key="a1" style={{ display: 'flex', gap: 6 }}><Btn>详情</Btn><Btn>导出</Btn></span>],
            ['14:22:04', <Tag key="l2" color={V.brand}>INFO</Tag>, '知识检索', 'RAG 双路召回：语义 Top-5 + BM25 Top-5，Rerank 后注入 3 条', <span key="a2" style={{ display: 'flex', gap: 6 }}><Btn>详情</Btn><Btn>导出</Btn></span>],
            ['14:22:06', <Tag key="l3" color={V.brand}>INFO</Tag>, '模型调用', 'deepseek-chat 推理第 1 轮：决策调用 metric-query', <span key="a3" style={{ display: 'flex', gap: 6 }}><Btn>详情</Btn><Btn>导出</Btn></span>],
            ['14:22:09', <Tag key="l4" color={V.brand}>INFO</Tag>, '工具调用', 'metric-query(node-032, ib_errors) 成功，耗时 2.1s', <span key="a4" style={{ display: 'flex', gap: 6 }}><Btn>详情</Btn><Btn>导出</Btn></span>],
            ['14:22:15', <Tag key="l5" color={V.warn}>WARN</Tag>, '决策', '高危工具 node-cmd-exec 触发人工审批，等待确认', <span key="a5" style={{ display: 'flex', gap: 6 }}><Btn>详情</Btn><Btn>导出</Btn></span>],
            ['14:24:40', <Tag key="l6" color={V.brand}>INFO</Tag>, '决策', '输出根因结论：ToR 端口误码率 6.2%，附处置建议', <span key="a6" style={{ display: 'flex', gap: 6 }}><Btn>详情</Btn><Btn>导出</Btn></span>],
          ]}
        />
        <div style={{ fontSize: 12, color: V.text3, marginTop: 8 }}>支持按时间、关键字、会话维度检索与决策回溯，支持查看日志详情与导出。</div>
        <Pager total={328} unit="条日志" />
      </FuncCard>
    </div>
  )
}

/* ---------- 记忆管理（记忆清单 + 召回配置，分页） ---------- */
function MemoryTab() {
  const [recall, setRecall] = useState(true)
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <FuncCard name="记忆管理" kind="manage">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
          <span style={{ ...card, padding: '4px 10px', fontSize: 12, color: V.text2 }}>短期记忆 <b style={{ color: V.text }}>36</b> 条</span>
          <span style={{ ...card, padding: '4px 10px', fontSize: 12, color: V.text2 }}>长期记忆 <b style={{ color: V.text }}>128</b> 条</span>
          <span style={{ ...card, padding: '4px 10px', fontSize: 12, color: V.text3, minWidth: 160 }}>查询：记忆摘要 / 关键字</span>
          <Btn>查询</Btn>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: V.text3 }}>短期记忆经评分阈值评估后晋升为长期记忆</span>
        </div>
        <Table
          head={['记忆摘要', '类型', '来源会话', '写入时间', '操作']}
          rows={[
            ['node-032 掉线根因：ToR 端口误码，切换备用链路恢复', <Tag key="m1" color={V.success}>长期</Tag>, 'sess-1042', '10-19 14:40', <span key="mo1" style={{ display: 'flex', gap: 6 }}><Btn>查看</Btn><Btn>遗忘</Btn></span>],
            ['GPU 温度超 95℃ 优先检查风扇转速与防尘网', <Tag key="m2" color={V.success}>长期</Tag>, 'sess-1038', '10-18 11:52', <span key="mo2" style={{ display: 'flex', gap: 6 }}><Btn>查看</Btn><Btn>遗忘</Btn></span>],
            ['NFS 挂载超时与存储端连接数耗尽相关', <Tag key="m3" color={V.success}>长期</Tag>, 'sess-1035', '10-18 09:30', <span key="mo3" style={{ display: 'flex', gap: 6 }}><Btn>查看</Btn><Btn>遗忘</Btn></span>],
            ['login-01 负载异常：异常进程 python 占满 CPU', <Tag key="m4" color={V.warn}>短期</Tag>, 'sess-1045', '10-20 16:05', <span key="mo4" style={{ display: 'flex', gap: 6 }}><Btn>查看</Btn><Btn>遗忘</Btn></span>],
          ]}
        />
        <Pager total={164} unit="条记忆" />
      </FuncCard>
      <FuncCard name="记忆召回配置" kind="manage">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ ...card, padding: '4px 10px', fontSize: 12, color: V.text2 }}>召回条数 Top-<b style={{ color: V.text }}>3</b></span>
          <span style={{ ...card, padding: '4px 10px', fontSize: 12, color: V.text2 }}>相似度阈值 <b style={{ color: V.text }}>0.72</b></span>
          <span style={{ ...card, padding: '4px 10px', fontSize: 12, color: V.text2 }}>长期记忆优先</span>
          <Btn>保存配置</Btn>
          <span style={{ marginLeft: 'auto' }}>
            <Switch on={recall} onChange={setRecall} label="记忆召回注入推理上下文" />
          </span>
        </div>
        <div style={{ fontSize: 12, color: V.text3, marginTop: 8 }}>记忆召回随诊断链路自动执行：语义召回相关历史记忆，经去重合并后按上述配置注入推理上下文，支撑经验复用与决策。</div>
      </FuncCard>
    </div>
  )
}

/* ---------- MCP 接口管理（MCP Server 卡片网格，分页；按账户权限过滤） ---------- */
function McpTab({ role }: { role: Role }) {
  const [invoke, setInvoke] = useState(true)
  const servers = [
    { scope: 'shared' as Scope, card: (
      <ItemCard
        icon="监" iconColor="#5b6ee1" name="监控查询服务" meta="mcp-monitor · 工具 6"
        desc="集群监控指标与告警查询：节点状态、误码率、温度、负载等指标查询与告警列表获取。"
        tags={[{ color: V.text3, text: 'SSE' }, { color: V.success, text: '已连接' }]}
        source="来自 技能库 nacos"
        actions={<Btn>断开</Btn>}
        highlight
      />
    ) },
    { scope: 'hpc' as Scope, card: (
      <ItemCard
        icon="调" iconColor="#2ea44f" name="调度器查询服务" meta="mcp-scheduler · 工具 5"
        desc="HPC 调度器作业与队列查询：作业状态、队列资源占用、节点分配等信息获取。"
        tags={[{ color: V.text3, text: 'Streamable HTTP' }, { color: V.success, text: '已连接' }]}
        source="来自 技能库 nacos"
        actions={<Btn>断开</Btn>}
      />
    ) },
    { scope: 'os' as Scope, card: (
      <ItemCard
        icon="业" iconColor="#b26a00" name="平台业务服务" meta="mcp-platform · 工具 8"
        desc="运维平台业务能力封装：资产信息、工单、巡检任务等平台业务接口调用。"
        tags={[{ color: V.text3, text: 'Streamable HTTP' }, { color: V.success, text: '已连接' }]}
        source="来自 技能库 nacos"
        actions={<Btn>断开</Btn>}
      />
    ) },
    { scope: 'shared' as Scope, card: (
      <ItemCard
        icon="执" iconColor="#7a52c9" name="节点命令执行服务" meta="mcp-node-exec · 工具 3"
        desc="集群节点命令执行：经 QUIC 隧道下发执行终端并回收结果，高危命令调用前强制人工审批。"
        tags={[{ color: V.text3, text: 'stdio' }, { color: V.success, text: '已连接' }]}
        source="来自 技能库 nacos"
        actions={<Btn>断开</Btn>}
      />
    ) },
    { scope: 'shared' as Scope, card: (
      <ItemCard
        icon="知" iconColor="#0e8a8a" name="知识库检索服务" meta="mcp-kbmatrix · 工具 4"
        desc="KBMatrix 知识检索与维护接口封装：双路召回、条目维护与索引状态查询。"
        tags={[{ color: V.text3, text: 'SSE' }, { color: V.warn, text: '重连中' }]}
        source="来自 技能库 nacos"
        actions={<Btn>查看</Btn>}
      />
    ) },
  ].filter(s => vis(s.scope, role))
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <FuncCard name="服务连接" kind="manage">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
          <span style={{ ...card, padding: '4px 10px', fontSize: 12, color: V.text3, minWidth: 180 }}>查询：服务名称 / 标识</span>
          <Btn>查询</Btn>
          <Btn primary>添加 MCP Server</Btn>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: V.text3 }}>MCP Server 经 nacos 注册发现 · 断线重连</span>
        </div>
        <div style={grid}>{servers.map((s, i) => <span key={i} style={{ display: 'contents' }}>{s.card}</span>)}</div>
        <Pager total={servers.length} unit="个 MCP Server" />
      </FuncCard>
      <FuncCard name="工具调用" kind="runtime">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Note>执行引擎按推理决策自动调用 MCP 暴露的工具与资源，调用时按 JSON Schema 校验参数；节点命令执行类高危工具调用前经权限审批策略强制人工确认，全程审计留痕。</Note>
          <Switch on={invoke} onChange={setInvoke} label="按推理决策自动调用工具" />
        </div>
      </FuncCard>
    </div>
  )
}

/* ---------- 页面骨架 ---------- */
const TABS = [
  { key: 'agents', label: '智能体管理', Icon: IconAgentPresetOutlineRegular, View: AgentsTab },
  { key: 'rag', label: 'RAG 管理', Icon: IconDatabaseOutlineRegular, View: RagTab },
  { key: 'skills', label: 'skills 管理', Icon: IconSkillOutlineRegular, View: SkillsTab },
  { key: 'logs', label: '日志管理', Icon: IconChecklistOutlineRegular, View: LogsTab },
  { key: 'memory', label: '记忆管理', Icon: IconThinkOutlineRegular, View: MemoryTab },
  { key: 'mcp', label: 'MCP 接口管理', Icon: IconApiOutlineRegular, View: McpTab },
] as const

type TabKey = (typeof TABS)[number]['key']

const ROLES: { key: Role; label: string }[] = [
  { key: 'admin', label: '管理员' },
  { key: 'hpc', label: 'HPC 运维账户' },
  { key: 'os', label: 'OS 运维账户' },
]

/** 控制台主页：账户角色切换 + 六模块页签 + 卡片式内容区。 */
export function AiopsConsolePage(props: { t?: (key: string) => string }) {
  const { t } = props
  const [tab, setTab] = useState<TabKey>('agents')
  const [role, setRole] = useState<Role>('admin')
  const Active = TABS.find(x => x.key === tab)!.View
  return (
    <div style={{ padding: '20px 24px', maxWidth: 980, margin: '0 auto', color: V.text }}>
      <div style={{ marginBottom: 14, display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{t?.('title') ?? '智能运维控制台'}</div>
          <div style={{ fontSize: 12.5, color: V.text3, marginTop: 4 }}>{t?.('subtitle') ?? ''}</div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: V.text3 }}>
          当前账户：
          {ROLES.map(r => (
            <button
              key={r.key}
              onClick={() => setRole(r.key)}
              style={{
                fontSize: 12, cursor: 'pointer', borderRadius: 6, padding: '3px 10px', whiteSpace: 'nowrap',
                border: `1px solid ${role === r.key ? V.brand : V.border}`,
                background: role === r.key ? V.brand : 'transparent',
                color: role === r.key ? '#ffffff' : V.text2,
              }}
            >{r.label}</button>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${V.border}`, marginBottom: 16 }}>
        {TABS.map(({ key, label, Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer',
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
      <Active role={role} />
    </div>
  )
}
