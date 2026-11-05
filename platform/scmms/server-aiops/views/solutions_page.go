package views

// solutionsPageHTML 人工审批页：列表 + 详情（方案全文、动作清单、批准/驳回、执行结果）。
// 服务器端直出，内联脚本经 fetch 调 /api/aiops/solutions JSON 接口（同源平台会话）。
const solutionsPageHTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>诊断方案审批 · 智能运维</title>
<style>
body{font-family:"PingFang SC","Microsoft YaHei",sans-serif;margin:0;background:#f5f7fa;color:#1f2328}
header{background:#1f2d3d;color:#fff;padding:12px 20px;font-size:15px}
main{display:flex;gap:16px;padding:16px 20px;align-items:flex-start}
#list{width:340px;flex-shrink:0}
.card{background:#fff;border:1px solid #e3e6ea;border-radius:8px;padding:12px 14px;margin-bottom:10px;cursor:pointer}
.card.active{border-color:#5b6ee1;box-shadow:0 0 0 1px #5b6ee1}
.title{font-size:13.5px;font-weight:600;margin-bottom:6px}
.meta{font-size:12px;color:#8a94a6}
.badge{display:inline-block;font-size:11px;padding:2px 8px;border-radius:8px;margin-left:6px}
.b-pending{background:#fff3d6;color:#b26a00}.b-approved{background:#dbeafe;color:#1d4ed8}
.b-executing{background:#dbeafe;color:#1d4ed8}.b-done{background:#d9f2e3;color:#2ea44f}
.b-failed,.b-rejected{background:#fde2e1;color:#d03038}
#detail{flex:1;min-width:0}
.panel{background:#fff;border:1px solid #e3e6ea;border-radius:8px;padding:16px 18px}
pre{white-space:pre-wrap;word-break:break-word;background:#f6f8fa;border-radius:6px;padding:12px;font-size:12.5px;line-height:1.7;max-height:420px;overflow:auto}
table{width:100%;border-collapse:collapse;font-size:12.5px}
td,th{border-bottom:1px solid #e3e6ea;padding:6px 8px;text-align:left;vertical-align:top}
.btn{padding:6px 14px;border-radius:6px;border:1px solid #e3e6ea;background:#fff;cursor:pointer;font-size:12.5px}
.btn.primary{background:#5b6ee1;color:#fff;border-color:#5b6ee1}
.btn.danger{background:#d03038;color:#fff;border-color:#d03038}
.btn:disabled{opacity:.5;cursor:not-allowed}
.mono{font-family:Consolas,monospace;font-size:12px}
.out{background:#1f2328;color:#d5dbe3;border-radius:6px;padding:10px;font-size:12px;max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-word}
h3{font-size:13.5px;margin:16px 0 8px}
</style>
</head>
<body>
<header>诊断方案审批 · 智能运维（DSH 推送 → 人工确认 → 下发执行）</header>
<main>
  <div id="list"></div>
  <div id="detail"><div class="panel meta">选择左侧方案查看详情。</div></div>
</main>
<script>
let current = null
async function api(path, opts){
  const r = await fetch(path, opts)
  const j = await r.json().catch(() => ({status:1,msg:'响应解析失败'}))
  if (j.status !== 0) throw new Error(j.msg || '请求失败')
  return j.data
}
function badge(s){ return '<span class="badge b-' + s + '">' + s + '</span>' }
async function loadList(){
  const list = await api('/api/aiops/solutions?limit=50')
  const el = document.getElementById('list')
  if (!list.length){ el.innerHTML = '<div class="card meta">暂无方案</div>'; return }
  el.innerHTML = ''
  for (const s of list){
    const d = document.createElement('div')
    d.className = 'card' + (current === s.id ? ' active' : '')
    d.innerHTML = '<div class="title">' + esc(s.title) + badge(s.status) + '</div>' +
      '<div class="meta">' + esc(s.createdAt) + (s.approver ? ' · ' + esc(s.approver) : '') + '</div>'
    d.onclick = () => { current = s.id; loadDetail(s.id); loadList() }
    el.appendChild(d)
  }
}
async function loadDetail(id){
  const [sol, execs] = await Promise.all([
    api('/api/aiops/solutions/' + id),
    api('/api/aiops/solutions/' + id + '/executions'),
  ])
  const el = document.getElementById('detail')
  let html = '<div class="panel">'
  html += '<div class="title" style="font-size:15px">' + esc(sol.title) + badge(sol.status) + '</div>'
  html += '<div class="meta">来源 ' + esc(sol.source || '-') + ' · ' + esc(sol.createdAt) +
    (sol.approver ? ' · 处理人 ' + esc(sol.approver) : '') +
    (sol.rejectReason ? ' · 驳回原因：' + esc(sol.rejectReason) : '') + '</div>'
  if (sol.question){ html += '<h3>诊断问题</h3><div>' + esc(sol.question) + '</div>' }
  html += '<h3>处置方案</h3><pre>' + esc(sol.plan) + '</pre>'
  if (sol.tools && sol.tools.length){
    html += '<h3>待下发动作（' + sol.tools.length + '）</h3><table><tr><th>#</th><th>节点</th><th>命令</th><th>目的</th></tr>'
    sol.tools.forEach((t,i) => {
      html += '<tr><td>' + (i+1) + '</td><td class="mono">' + esc(t.node) + '</td><td class="mono">' + esc(t.cmd) + '</td><td>' + esc(t.reason || '') + '</td></tr>'
    })
    html += '</table>'
  }
  if (sol.status === 'pending-approval'){
    html += '<h3>人工确认</h3><div style="display:flex;gap:8px">' +
      '<button class="btn primary" onclick="decide(\'' + id + '\',\'approve\')">批准并下发执行</button>' +
      '<button class="btn danger" onclick="decide(\'' + id + '\',\'reject\')">驳回</button></div>'
  }
  if (execs && execs.length){
    html += '<h3>执行结果</h3>'
    for (const e of execs){
      html += '<div style="margin-bottom:10px"><div class="mono">[' + e.status + '] ' + esc(e.node) + ' $ ' + esc(e.cmd) + '</div>' +
        (e.output ? '<div class="out">' + esc(e.output) + '</div>' : '') + '</div>'
    }
  }
  html += '</div>'
  el.innerHTML = html
}
async function decide(id, action){
  const approver = document.cookie.replace(/(?:(?:^|.*;\s*)scmms_user\s*\=\s*([^;]*).*$)|^.*$/, '$1') || 'sysadm'
  const body = action === 'reject' ? { approver, reason: prompt('驳回原因（可空）') || '' } : { approver }
  try {
    await api('/api/aiops/solutions/' + id + '/' + action, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    await loadDetail(id); await loadList()
    if (action === 'approve') setTimeout(() => { loadDetail(id); loadList() }, 4000)
  } catch (e) { alert(e.message) }
}
function esc(s){ return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])) }
loadList()
setInterval(() => { if (current) loadDetail(current); loadList() }, 15000)
const qid = new URLSearchParams(location.search).get('id')
if (qid){ current = qid; loadDetail(qid) }
</script>
</body>
</html>
`
