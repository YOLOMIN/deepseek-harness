<!--
  运维 Copilot（广汽二期智能运维扩展）
  平台右上角悬浮入口 + 抽屉式诊断对话界面，对接智能运维控制台（dsh）：
  平台前端 -> 集成中继(SSE) -> dsh ACP 推理会话，正文/思考逐增量实时渲染。
  浅色阅读风格：思考与工具调用默认折叠为摘要行，正文 Markdown 排版。
-->
<template>
  <div class="copilot-root">
    <div class="copilot-entry" @click="drawer = true">
      <i class="el-icon-magic-stick"></i>
      <span>运维 Copilot</span>
    </div>
    <el-drawer
      :visible.sync="drawer"
      direction="rtl"
      size="560px"
      custom-class="copilot-drawer"
      :with-header="false"
    >
      <div class="copilot-panel">
        <div class="copilot-head">
          <span class="copilot-title">
            <i class="el-icon-magic-stick"></i> 运维 Copilot
          </span>
          <span class="copilot-sub">系统环境层 / 硬件层故障智能诊断</span>
          <el-button
            class="copilot-new"
            type="text"
            icon="el-icon-refresh-left"
            @click="reset"
          >新对话</el-button>
        </div>
        <div ref="msgList" class="copilot-msgs">
          <div v-if="!messages.length" class="copilot-empty">
            <p>描述故障现象或运维问题，例如：</p>
            <p class="copilot-sample" @click="fill('计算节点 node-032 掉线，sinfo 显示 down，仿真作业中断，请诊断')">“计算节点 node-032 掉线，请诊断”</p>
            <p class="copilot-sample" @click="fill('登录节点系统负载持续偏高，帮忙分析原因')">“登录节点系统负载持续偏高，帮忙分析原因”</p>
          </div>
          <div
            v-for="(m, i) in messages"
            :key="i"
            class="copilot-msg"
            :class="m.who"
          >
            <div v-if="m.who === 'user'" class="copilot-bubble user-bubble">{{ m.text }}</div>
            <template v-else>
              <div v-if="m.thinking" class="copilot-row" @click="m.thinkingOpen = !m.thinkingOpen">
                <i :class="m.streaming && !m.text ? 'el-icon-loading' : 'el-icon-timer'"></i>
                <span>思考过程</span>
                <span v-if="durationOf(m.thinkingStart, m.thinkingEnd)" class="copilot-dur">· {{ durationOf(m.thinkingStart, m.thinkingEnd) }}</span>
                <i class="el-icon-arrow-right copilot-caret" :class="{ open: m.thinkingOpen }"></i>
              </div>
              <div v-show="m.thinkingOpen" class="copilot-detail">{{ m.thinking }}</div>
              <div v-if="m.tools.length" class="copilot-row" @click="m.toolsOpen = !m.toolsOpen">
                <i class="el-icon-set-up"></i>
                <span>调用了 {{ m.tools.length }} 个工具</span>
                <span v-if="durationOf(m.toolStart, m.toolEnd)" class="copilot-dur">· {{ durationOf(m.toolStart, m.toolEnd) }}</span>
                <i class="el-icon-arrow-right copilot-caret" :class="{ open: m.toolsOpen }"></i>
              </div>
              <div v-show="m.toolsOpen" class="copilot-detail">
                <div v-for="(t, j) in m.tools" :key="j" class="copilot-tool-line">
                  <i :class="t.done ? 'el-icon-check' : 'el-icon-loading'"></i>
                  <span>{{ t.name }}</span>
                </div>
              </div>
              <div v-for="p in m.permissions" :key="p.requestId" class="copilot-permission">
                <div class="copilot-solution-title">
                  <i class="el-icon-lock"></i> 权限申请：{{ p.tool }}<span v-if="p.kind" class="copilot-dur"> · {{ p.kind }}</span>
                </div>
                <div v-if="p.input" class="copilot-permission-input mono-pre">{{ p.input }}</div>
                <div class="copilot-permission-actions">
                  <el-button size="mini" type="primary" :loading="p.answering" @click="answerPermission(m, p, true)">允许一次</el-button>
                  <el-button size="mini" type="danger" plain :loading="p.answering" @click="answerPermission(m, p, false)">拒绝</el-button>
                </div>
              </div>
              <div class="copilot-text copilot-markdown" v-html="renderMarkdown(m.text)"></div>
              <div v-if="m.solution && m.solution.pushed" class="copilot-solution">
                <div class="copilot-solution-title">
                  <i class="el-icon-document-checked"></i>
                  处置方案已推送平台待审批<span v-if="m.solution.actions > 0"> · 含 {{ m.solution.actions }} 条待下发动作</span>
                </div>
                <div class="copilot-solution-desc">人工确认后将经平台下发到对应节点执行并回收结果。</div>
                <el-button size="mini" type="primary" icon="el-icon-s-check" @click="openSolution(m.solution)">去审批并下发</el-button>
              </div>
              <div v-else-if="m.solution && m.solution.pushed === false" class="copilot-solution warn">
                <i class="el-icon-warning-outline"></i> 方案推送平台失败：{{ m.solution.reason || '未知原因' }}（可联系管理员检查中继配置）
              </div>
              <span v-if="m.streaming" class="copilot-status">
                <span v-if="!m.text && !m.thinking">正在诊断…</span><span class="copilot-cursor">▍</span>
              </span>
            </template>
          </div>
        </div>
        <div class="copilot-input">
          <el-input
            v-model="input"
            type="textarea"
            :rows="2"
            resize="none"
            placeholder="描述故障现象或运维问题，Enter 发送"
            @keydown.enter.native.prevent="send"
          />
          <el-button
            type="primary"
            icon="el-icon-position"
            :loading="running"
            @click="send"
          >发送</el-button>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<script>
import { marked } from "marked";

// 集成中继（本机联调组件）：SSE 流式转发 dsh ACP 诊断会话事件
const CHAT_URL = "http://127.0.0.1:3081/api/aiops/chat";
// 权限应答地址：permission 事件的“允许/拒绝”点选经该接口回填给挂起的智能体
const PERMISSION_URL = "http://127.0.0.1:3081/api/aiops/permission";

marked.setOptions({ breaks: true, gfm: true });

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function newAgentMessage() {
  return {
    who: "agent",
    text: "",
    thinking: "",
    thinkingOpen: false,
    thinkingStart: 0,
    thinkingEnd: 0,
    tools: [],
    toolsOpen: false,
    toolStart: 0,
    toolEnd: 0,
    // 诊断方案推送结果（中继 solution 事件）：{ pushed, id, page, actions, reason }
    // pushed=true 时渲染“去审批并下发”操作卡，解决“方案要求授权但用户没有操作入口”的问题。
    solution: null,
    // 待人工确认的权限申请列表：[{ requestId, tool, kind, input, answering }]
    // 中继 permission 事件追加，点选后移除；超时（中继 120s 兜底）自动视为拒绝。
    permissions: [],
    streaming: true,
  };
}

export default {
  name: "Copilot",
  data() {
    return {
      drawer: false,
      input: "",
      messages: [],
      sessionId: "",
      running: false,
    };
  },
  methods: {
    fill(text) {
      this.input = text;
    },
    // 应答权限申请：POST 给中继回填；无论成败都把卡片撤下（失败时该请求通常已被中继取消）
    async answerPermission(message, perm, allow) {
      perm.answering = true;
      try {
        await fetch(PERMISSION_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId: perm.requestId, allow }),
        });
      } catch (e) {
        // 网络抖动时中继侧 120s 超时兜底取消，无需前端重试
      }
      const idx = message.permissions.findIndex((x) => x.requestId === perm.requestId);
      if (idx >= 0) {
        message.permissions.splice(idx, 1);
      }
    },
    // 打开方案审批页（平台会话内），在那里完成人工确认与下发
    openSolution(solution) {
      if (solution && solution.page) {
        window.open(solution.page, "_blank");
      }
    },
    reset() {
      this.messages = [];
      this.sessionId = "";
      this.input = "";
    },
    durationOf(start, end) {
      if (!start || !end || end <= start) {
        return "";
      }
      const total = Math.round((end - start) / 1000);
      if (total < 1) {
        return "";
      }
      if (total < 60) {
        return total + "s";
      }
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      return seconds ? minutes + "m" + seconds + "s" : minutes + "m";
    },
    renderMarkdown(text) {
      if (!text) {
        return "";
      }
      // 先转义原始 HTML，再由 marked 生成排版标签，模型输出中的 HTML 仅按文本展示
      return marked.parse(escapeHtml(text));
    },
    scrollBottom() {
      this.$nextTick(() => {
        const el = this.$refs.msgList;
        if (el) {
          el.scrollTop = el.scrollHeight;
        }
      });
    },
    async send() {
      const text = this.input.trim();
      if (!text || this.running) {
        return;
      }
      this.messages.push({ who: "user", text });
      this.input = "";
      const agent = newAgentMessage();
      this.messages.push(agent);
      this.running = true;
      this.scrollBottom();
      try {
        const resp = await fetch(CHAT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            sessionId: this.sessionId || undefined,
          }),
        });
        if (!resp.ok || !resp.body) {
          throw new Error("HTTP " + resp.status);
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buf = "";
        const pump = () => reader.read().then(({ done, value }) => {
          if (done) {
            return;
          }
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            this.handleEvent(block, agent);
          }
          return pump();
        });
        await pump();
      } catch (e) {
        agent.text = agent.text || "诊断服务暂不可用：" + e.message;
      } finally {
        agent.streaming = false;
        agent.thinkingOpen = false;
        this.running = false;
        this.scrollBottom();
      }
    },
    handleEvent(block, agent) {
      let event = "";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          data += line.slice(5).trim();
        }
      }
      if (!data) {
        return;
      }
      let payload;
      try {
        payload = JSON.parse(data);
      } catch (e) {
        return;
      }
      if (event === "session" && payload.sessionId) {
        this.sessionId = payload.sessionId;
      } else if (event === "delta") {
        const now = Date.now();
        if (payload.kind === "thinking") {
          if (!agent.thinkingStart) {
            agent.thinkingStart = now;
            agent.thinkingOpen = true;
          }
          agent.thinking += payload.text;
          agent.thinkingEnd = now;
        } else {
          agent.text += payload.text;
          agent.thinkingOpen = false;
        }
        this.scrollBottom();
      } else if (event === "tool" && payload.name) {
        const now = Date.now();
        if (payload.phase === "call") {
          agent.tools.push({ name: payload.name, done: false });
          if (!agent.toolStart) {
            agent.toolStart = now;
          }
          agent.toolEnd = now;
        } else if (payload.phase === "result") {
          const pending = agent.tools.find((t) => !t.done);
          if (pending) {
            pending.done = true;
          }
          agent.toolEnd = now;
        }
        this.scrollBottom();
      } else if (event === "solution") {
        // 方案闭环：中继把最终方案推送到平台 /api/aiops/solutions 后回传的受理结果。
        // pushed=true 时 page 是审批页地址（含方案 id 与动作数），渲染操作卡引导人工确认下发。
        agent.solution = payload;
        this.scrollBottom();
      } else if (event === "permission" && payload.requestId) {
        // 人工确认卡入列；输入过长时截断展示，完整文本在控制台 network 可见
        agent.permissions.push({
          requestId: payload.requestId,
          tool: payload.tool || "工具调用",
          kind: payload.kind || "",
          input: payload.input || "",
          answering: false,
        });
        this.scrollBottom();
      } else if (event === "final") {
        if (!agent.text && payload.text) {
          agent.text = payload.text;
        }
        agent.thinkingOpen = false;
      } else if (event === "error") {
        agent.text += (agent.text ? "\n" : "") + "⚠ " + payload.message;
      }
    },
  },
};
</script>

<style scoped lang="scss">
.copilot-solution {
  margin-top: 10px;
  border: 1px solid #c6d0f5;
  background: #f4f7ff;
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 12.5px;
}
.copilot-solution.warn {
  border-color: #f2d2b0;
  background: #fff8f0;
  color: #b26a00;
}
.copilot-solution-title {
  font-weight: 600;
  color: #1f2328;
  margin-bottom: 4px;
}
.copilot-solution-desc {
  color: #8a94a6;
  margin-bottom: 8px;
}
.copilot-permission {
  margin: 10px 0;
  border: 1px solid #f2d2b0;
  background: #fff8f0;
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 12.5px;
}
.copilot-permission-input {
  background: #fff;
  border: 1px solid #eee;
  border-radius: 6px;
  padding: 6px 8px;
  margin: 6px 0;
  font-size: 12px;
  max-height: 120px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
.mono-pre { font-family: Consolas, monospace; }
.copilot-permission-actions { display: flex; gap: 8px; }
.copilot-entry {
  position: fixed;
  top: 64px;
  right: 20px;
  z-index: 2000;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border-radius: 16px;
  background: linear-gradient(135deg, #4d6bfe, #7a5af8);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(77, 107, 254, .35);

  &:hover { opacity: .92; }
}

.copilot-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #f7f8fa;
}

.copilot-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px;
  background: #fff;
  border-bottom: 1px solid #ebeef5;

  .copilot-title { font-size: 15px; font-weight: 600; color: #303133; }
  .copilot-sub { font-size: 12px; color: #909399; }
  .copilot-new {
    margin-left: auto;
    font-size: 12px;
    color: #909399;

    &:hover { color: #4d6bfe; }
  }
}

.copilot-msgs {
  flex: 1;
  overflow-y: auto;
  padding: 16px 18px;

  &::-webkit-scrollbar { width: 6px; }
  &::-webkit-scrollbar-thumb { background: #dcdfe6; border-radius: 3px; }

  .copilot-empty {
    font-size: 13px;
    color: #909399;
    line-height: 1.9;

    .copilot-sample {
      color: #4d6bfe;
      cursor: pointer;
      background: #eef1fe;
      border: 1px solid #e0e6ff;
      border-radius: 6px;
      padding: 5px 11px;
      margin: 6px 0;

      &:hover { border-color: #4d6bfe; }
    }
  }

  .copilot-msg {
    margin-bottom: 16px;
    display: flex;
    flex-direction: column;
    text-align: left;

    &.user { align-items: flex-end; }
    &.agent { align-items: stretch; }

    .user-bubble {
      max-width: 88%;
      padding: 10px 14px;
      border-radius: 12px;
      border-bottom-right-radius: 3px;
      background: #3f5efb;
      color: #fff;
      font-size: 13.5px;
      line-height: 1.7;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .copilot-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 2px;
      margin-bottom: 4px;
      font-size: 12.5px;
      color: #909399;
      cursor: pointer;
      user-select: none;
      border-radius: 4px;

      &:hover { color: #606266; }

      i:first-child { font-size: 13px; }
      .copilot-dur { color: #b1b4bb; }
    }

    .copilot-caret {
      margin-left: auto;
      font-size: 12px;
      transition: transform .15s ease;

      &.open { transform: rotate(90deg); }
    }

    .copilot-detail {
      margin: 0 2px 8px 21px;
      font-size: 12.5px;
      color: #909399;
      line-height: 1.75;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 240px;
      overflow-y: auto;

      &::-webkit-scrollbar { width: 4px; }
      &::-webkit-scrollbar-thumb { background: #dcdfe6; border-radius: 2px; }
    }

    .copilot-tool-line {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 2px 0;

      .el-icon-check { color: #67c23a; }
      .el-icon-loading { color: #4d6bfe; }
    }

    .copilot-text {
      font-size: 13.5px;
      line-height: 1.8;
      color: #303133;
      word-break: break-word;
    }

    .copilot-markdown {
      ::v-deep p { margin: 0 0 10px; }
      ::v-deep p:last-child { margin-bottom: 0; }
      ::v-deep h1, ::v-deep h2, ::v-deep h3, ::v-deep h4 {
        margin: 14px 0 8px;
        font-size: 14.5px;
        font-weight: 600;
        color: #1f2d3d;
      }
      ::v-deep h1:first-child, ::v-deep h2:first-child,
      ::v-deep h3:first-child, ::v-deep h4:first-child { margin-top: 0; }
      ::v-deep ul, ::v-deep ol { margin: 4px 0 10px; padding-left: 22px; }
      ::v-deep li { margin: 3px 0; }
      ::v-deep li::marker { color: #b1b4bb; }
      ::v-deep code {
        font-family: Consolas, Monaco, monospace;
        font-size: 12px;
        background: #f0f2f5;
        border-radius: 4px;
        padding: 1.5px 6px;
        color: #c7254e;
      }
      ::v-deep pre {
        background: #f6f8fa;
        border: 1px solid #e4e7ed;
        border-radius: 8px;
        padding: 10px 12px;
        margin: 8px 0 12px;
        overflow-x: auto;

        code {
          background: transparent;
          color: #303133;
          padding: 0;
          font-size: 12.5px;
          line-height: 1.6;
        }
      }
      ::v-deep blockquote {
        margin: 8px 0;
        padding: 4px 12px;
        border-left: 3px solid #4d6bfe;
        color: #909399;
        background: #f7f8ff;
        border-radius: 0 6px 6px 0;
      }
      ::v-deep table {
        border-collapse: collapse;
        margin: 8px 0 12px;
        font-size: 12.5px;

        th, td { border: 1px solid #e4e7ed; padding: 5px 11px; }
        th { background: #f5f7fa; color: #606266; }
      }
      ::v-deep a { color: #4d6bfe; }
      ::v-deep strong { color: #1f2d3d; font-weight: 600; }
      ::v-deep hr { border: none; border-top: 1px solid #e4e7ed; margin: 12px 0; }
    }

    .copilot-status {
      margin-top: 4px;
      font-size: 12px;
      color: #909399;
    }

    .copilot-cursor { color: #4d6bfe; animation: copilot-blink 1s steps(1) infinite; }
  }
}

@keyframes copilot-blink {
  50% { opacity: 0; }
}

.copilot-input {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  background: #fff;
  border-top: 1px solid #ebeef5;
  align-items: flex-end;

  ::v-deep .el-textarea__inner {
    background: #fff;
    border-color: #dcdfe6;
    color: #303133;
    font-size: 13px;

    &::placeholder { color: #b1b4bb; }
    &:focus { border-color: #4d6bfe; }
  }
}
</style>
