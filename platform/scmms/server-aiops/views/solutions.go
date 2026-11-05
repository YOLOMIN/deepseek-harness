// GAC2：诊断方案闭环——接收 DSH 推送的处置方案，人工审批后经 SSH 下发到目标节点执行并回收结果。
//
// 【整体数据流】
//
//	运维 Copilot（DSH）诊断完成
//	  → 中继解析方案末尾的 ```json exec_actions 动作块（只有只读取证命令）
//	  → POST /api/aiops/solutions 推送到本服务（Bearer Token 认证）
//	  → 方案与动作条目分别落库 tbl_aiops_solution / tbl_aiops_execution（同事务）
//	  → 审批人在 /aiops/solutions 页面确认（平台会话保护）
//	  → approve 后后台 goroutine 逐条经 SSH 私钥通道在目标节点执行
//	  → 每条命令的输出与 [exit=N] 回写 tbl_aiops_execution，方案终态 done/failed
//
// 【安全模型】
//   - JSON API（/api/aiops/solutions*）：Bearer Token 认证，口令与 MCP 端点共用
//     /usr/local/scmms/mcp-tokens.json；会话中间件已将该路径列入白名单，令牌由本包自校验。
//   - 审批页面（/aiops/solutions）：平台会话保护，未登录被会话中间件拦截。
//   - 执行通道：/usr/local/scmms/cert/aiops-exec-key 私钥，公钥需预先分发到各节点
//     root 的 authorized_keys；节点地址映射在 /usr/local/scmms/aiops-exec-nodes.json。
//   - 命令级容错：探针缺失（如 PSI、mpstat 未安装）是取证常态，退出码记入输出
//     尾部 [exit=N] 但不中断批次；仅 SSH 不可达/超时等执行级失败才 failed 并跳过后续。
//
// 端点（均挂载在根引擎，JSON API 走 Bearer Token 认证，审批页面走平台会话）：
//   POST /api/aiops/solutions            接收方案（DSH 中继在 Copilot 答复完成时推送）
//   GET  /api/aiops/solutions            方案列表（?status=&limit=）
//   GET  /api/aiops/solutions/:id        方案详情（含执行条目）
//   POST /api/aiops/solutions/:id/approve  人工批准 → 后台逐条下发执行
//   POST /api/aiops/solutions/:id/reject   人工驳回
//   GET  /api/aiops/solutions/:id/executions  执行结果列表
//   GET  /aiops/solutions                人工审批页面（平台会话保护）
package views

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	log "github.com/sirupsen/logrus"
	"golang.org/x/crypto/ssh"
	"gitlab.kylinsec.net/kylin-devdept1/ks-scmms/ks-scmms-2.x/ks-scmms-server.git/pkg/db"
)

// 方案状态机：pending-approval → approved → executing → done / failed；旁路 rejected。
const (
	solPending   = "pending-approval"
	solApproved  = "approved"
	solRejected  = "rejected"
	solExecuting = "executing"
	solDone      = "done"
	solFailed    = "failed"
)

// execCommandTimeout 单条命令的执行超时；诊断取证命令均为只读短命令。
const execCommandTimeout = 120 * time.Second

// execNodesPath 节点执行通道配置（node → ssh 目标），缺省时 node 名即主机名。
const execNodesPath = "/usr/local/scmms/aiops-exec-nodes.json"

// execKeyPath 执行通道私钥；公钥需事先分发到各节点 root 的 authorized_keys。
const execKeyPath = "/usr/local/scmms/cert/aiops-exec-key"

// solutionTool 方案中一条待下发动作。
type solutionTool struct {
	Node   string `json:"node"`
	Cmd    string `json:"cmd"`
	Reason string `json:"reason"`
}

// solutionReq 接收方案的请求体。
type solutionReq struct {
	Title     string         `json:"title"`
	Question  string         `json:"question"`
	Plan      string         `json:"plan"`
	Tools     []solutionTool `json:"tools"`
	Source    string         `json:"source"`
	SessionID string         `json:"sessionId"`
}

// execNode 节点执行通道条目。
type execNode struct {
	Host string `json:"host"`
	Port int    `json:"port"`
	User string `json:"user"`
}

var tablesOnce sync.Once

// ensureTables 首次使用时建表（幂等），避免独立迁移流程。
func ensureTables() {
	tablesOnce.Do(func() {
		statements := []string{
			`CREATE TABLE IF NOT EXISTS tbl_aiops_solution (
				id VARCHAR(36) PRIMARY KEY,
				title VARCHAR(255) NOT NULL,
				question MEDIUMTEXT,
				plan MEDIUMTEXT,
				tools_json MEDIUMTEXT,
				source VARCHAR(64) DEFAULT '',
				session_id VARCHAR(64) DEFAULT '',
				status VARCHAR(24) NOT NULL,
				approver VARCHAR(64) DEFAULT '',
				reject_reason VARCHAR(255) DEFAULT '',
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
				updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
			)`,
			`CREATE TABLE IF NOT EXISTS tbl_aiops_execution (
				id BIGINT AUTO_INCREMENT PRIMARY KEY,
				solution_id VARCHAR(36) NOT NULL,
				seq INT NOT NULL,
				node VARCHAR(128) NOT NULL,
				cmd TEXT,
				reason VARCHAR(255) DEFAULT '',
				status VARCHAR(16) NOT NULL,
				output MEDIUMTEXT,
				started_at DATETIME NULL,
				finished_at DATETIME NULL,
				KEY idx_sol (solution_id)
			)`,
		}
		for _, stmt := range statements {
			if _, err := db.DB.Exec(stmt); err != nil {
				log.Errorf("aiops solutions: create table failed: %s", err.Error())
			}
		}
	})
}

// tokenStorePath 对接 Token 持久化文件（user -> token），与 MCP 端点共用。
const tokenStorePath = "/usr/local/scmms/mcp-tokens.json"

var (
	solTokenMu sync.Mutex
	solTokens  map[string]string
)

// bearerOK 校验 Bearer Token（每次读取口令文件，平台侧轮换口令即时生效）。
func bearerOK(c *gin.Context) bool {
	auth := c.GetHeader("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return false
	}
	token := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
	solTokenMu.Lock()
	defer solTokenMu.Unlock()
	raw, err := os.ReadFile(tokenStorePath)
	if err != nil {
		return false
	}
	solTokens = map[string]string{}
	if json.Unmarshal(raw, &solTokens) != nil {
		return false
	}
	for _, v := range solTokens {
		if v == token {
			return true
		}
	}
	return false
}

// BearerAuth JSON API 的 Bearer Token 认证中间件。
func BearerAuth(c *gin.Context) {
	if !bearerOK(c) {
		c.JSON(http.StatusUnauthorized, gin.H{"status": 1, "msg": "对接 Token 无效或缺失"})
		c.Abort()
		return
	}
	c.Next()
}

func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// CreateSolution 接收 DSH 推送的方案：方案与执行条目同事务落库，状态 pending-approval。
func CreateSolution(c *gin.Context) {
	ensureTables()
	var req solutionReq
	if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Title) == "" || strings.TrimSpace(req.Plan) == "" {
		c.JSON(200, gin.H{"status": 1, "msg": "缺少 title 或 plan"})
		return
	}
	if len(req.Tools) > 50 {
		c.JSON(200, gin.H{"status": 1, "msg": "tools 超出上限（50）"})
		return
	}
	id := newID()
	toolsJSON, _ := json.Marshal(req.Tools)
	tx, err := db.DB.Begin()
	if err != nil {
		c.JSON(200, gin.H{"status": 1, "msg": "开启事务失败：" + err.Error()})
		return
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.Exec(
		"INSERT INTO tbl_aiops_solution (id,title,question,plan,tools_json,source,session_id,status) VALUES (?,?,?,?,?,?,?,?)",
		id, req.Title, req.Question, req.Plan, string(toolsJSON), req.Source, req.SessionID, solPending,
	); err != nil {
		c.JSON(200, gin.H{"status": 1, "msg": "方案落库失败：" + err.Error()})
		return
	}
	for i, tool := range req.Tools {
		if strings.TrimSpace(tool.Node) == "" || strings.TrimSpace(tool.Cmd) == "" {
			c.JSON(200, gin.H{"status": 1, "msg": fmt.Sprintf("第 %d 条动作缺少 node 或 cmd", i+1)})
			return
		}
		if _, err = tx.Exec(
			"INSERT INTO tbl_aiops_execution (solution_id,seq,node,cmd,reason,status) VALUES (?,?,?,?,?,?)",
			id, i, tool.Node, tool.Cmd, tool.Reason, "pending",
		); err != nil {
			c.JSON(200, gin.H{"status": 1, "msg": "执行条目落库失败：" + err.Error()})
			return
		}
	}
	if err = tx.Commit(); err != nil {
		c.JSON(200, gin.H{"status": 1, "msg": "提交事务失败：" + err.Error()})
		return
	}
	log.Infof("aiops solutions: received %q (%d actions) from %s", req.Title, len(req.Tools), req.Source)
	c.JSON(200, gin.H{"status": 0, "msg": "success", "data": gin.H{"id": id, "status": solPending, "page": "/aiops/solutions?id=" + id}})
}

// ListSolutions 方案列表（按创建时间倒序，可选状态过滤）。
func ListSolutions(c *gin.Context) {
	ensureTables()
	status := c.Query("status")
	limit := 50
	if v, err := strconv.Atoi(c.Query("limit")); err == nil && v > 0 && v <= 200 {
		limit = v
	}
	query := "SELECT id,title,status,approver,created_at,updated_at FROM tbl_aiops_solution"
	args := []interface{}{}
	if status != "" {
		query += " WHERE status=?"
		args = append(args, status)
	}
	query += " ORDER BY created_at DESC LIMIT ?"
	args = append(args, limit)
	rows, err := db.DB.Query(query, args...)
	if err != nil {
		c.JSON(200, gin.H{"status": 1, "msg": "查询失败：" + err.Error()})
		return
	}
	defer rows.Close()
	list := []gin.H{}
	for rows.Next() {
		var id, title, st, approver string
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&id, &title, &st, &approver, &createdAt, &updatedAt); err == nil {
			list = append(list, gin.H{
				"id": id, "title": title, "status": st, "approver": approver,
				"createdAt": createdAt.Format(time.DateTime), "updatedAt": updatedAt.Format(time.DateTime),
			})
		}
	}
	c.JSON(200, gin.H{"status": 0, "msg": "success", "data": list})
}

// GetSolution 方案详情（含执行条目）。
func GetSolution(c *gin.Context) {
	ensureTables()
	var title, question, plan, toolsJSON, source, sessionID, status, approver, rejectReason string
	var createdAt, updatedAt time.Time
	err := db.DB.QueryRow(
		"SELECT title,question,plan,tools_json,source,session_id,status,approver,reject_reason,created_at,updated_at FROM tbl_aiops_solution WHERE id=?",
		c.Param("id"),
	).Scan(&title, &question, &plan, &toolsJSON, &source, &sessionID, &status, &approver, &rejectReason, &createdAt, &updatedAt)
	if err != nil {
		c.JSON(200, gin.H{"status": 1, "msg": "方案不存在"})
		return
	}
	var tools []solutionTool
	_ = json.Unmarshal([]byte(toolsJSON), &tools)
	c.JSON(200, gin.H{"status": 0, "msg": "success", "data": gin.H{
		"id": c.Param("id"), "title": title, "question": question, "plan": plan, "tools": tools,
		"source": source, "sessionId": sessionID, "status": status, "approver": approver,
		"rejectReason": rejectReason, "createdAt": createdAt.Format(time.DateTime), "updatedAt": updatedAt.Format(time.DateTime),
	}})
}

// GetExecutions 执行结果列表。
func GetExecutions(c *gin.Context) {
	ensureTables()
	rows, err := db.DB.Query(
		"SELECT seq,node,cmd,reason,status,output,started_at,finished_at FROM tbl_aiops_execution WHERE solution_id=? ORDER BY seq",
		c.Param("id"),
	)
	if err != nil {
		c.JSON(200, gin.H{"status": 1, "msg": "查询失败：" + err.Error()})
		return
	}
	defer rows.Close()
	list := []gin.H{}
	for rows.Next() {
		var seq int
		var node, cmd, reason, status string
		var output sql.NullString
		var startedAt, finishedAt sql.NullTime
		if err := rows.Scan(&seq, &node, &cmd, &reason, &status, &output, &startedAt, &finishedAt); err == nil {
			list = append(list, gin.H{
				"seq": seq, "node": node, "cmd": cmd, "reason": reason, "status": status,
				"output": output.String,
				"startedAt":  nullTime(startedAt),
				"finishedAt": nullTime(finishedAt),
			})
		}
	}
	c.JSON(200, gin.H{"status": 0, "msg": "success", "data": list})
}

func nullTime(t sql.NullTime) string {
	if !t.Valid {
		return ""
	}
	return t.Time.Format(time.DateTime)
}

type decisionReq struct {
	Approver string `json:"approver"`
	Reason   string `json:"reason"`
}

// ApproveSolution 人工批准：状态机校验后置 approved 并启动后台执行。
func ApproveSolution(c *gin.Context) {
	ensureTables()
	var req decisionReq
	_ = c.ShouldBindJSON(&req)
	approver := strings.TrimSpace(req.Approver)
	if approver == "" {
		approver = "sysadm"
	}
	res, err := db.DB.Exec(
		"UPDATE tbl_aiops_solution SET status=?, approver=? WHERE id=? AND status=?",
		solApproved, approver, c.Param("id"), solPending,
	)
	if err != nil {
		c.JSON(200, gin.H{"status": 1, "msg": "批准失败：" + err.Error()})
		return
	}
	affected, _ := res.RowsAffected()
	if affected == 0 {
		c.JSON(200, gin.H{"status": 1, "msg": "方案不存在或已处理"})
		return
	}
	go runSolution(c.Param("id"))
	c.JSON(200, gin.H{"status": 0, "msg": "success", "data": gin.H{"status": solApproved}})
}

// RejectSolution 人工驳回。
func RejectSolution(c *gin.Context) {
	ensureTables()
	var req decisionReq
	_ = c.ShouldBindJSON(&req)
	approver := strings.TrimSpace(req.Approver)
	if approver == "" {
		approver = "sysadm"
	}
	res, err := db.DB.Exec(
		"UPDATE tbl_aiops_solution SET status=?, approver=?, reject_reason=? WHERE id=? AND status=?",
		solRejected, approver, req.Reason, c.Param("id"), solPending,
	)
	if err != nil {
		c.JSON(200, gin.H{"status": 1, "msg": "驳回失败：" + err.Error()})
		return
	}
	affected, _ := res.RowsAffected()
	if affected == 0 {
		c.JSON(200, gin.H{"status": 1, "msg": "方案不存在或已处理"})
		return
	}
	c.JSON(200, gin.H{"status": 0, "msg": "success", "data": gin.H{"status": solRejected}})
}

// runSolution 后台逐条下发执行：全部成功 done，任一失败 failed（后续条目标记 skipped）。
//
// 【执行语义】approve 返回后由 goroutine 异步执行，调用方不被长命令阻塞；
// 动作按 seq 顺序串行（处置命令有先后依赖，禁止并发）；
// 每条命令的三个落点：running（started_at）→ done/failed（output + finished_at）；
// 命令级非零退出不算失败（探针缺失是常态，[exit=N] 已在输出中体现），
// 只有 sshRun 返回 error（SSH 不通/超时）才视为执行级失败——此时熔断，
// 后续条目置 skipped，方案终态 failed，避免在半坏链路上继续执行产生误导。
func runSolution(id string) {
	if _, err := db.DB.Exec("UPDATE tbl_aiops_solution SET status=? WHERE id=?", solExecuting, id); err != nil {
		log.Errorf("aiops solutions: mark executing %s: %s", id, err.Error())
		return
	}
	rows, err := db.DB.Query("SELECT seq,node,cmd FROM tbl_aiops_execution WHERE solution_id=? AND status=? ORDER BY seq", id, "pending")
	if err != nil {
		markSolution(id, solFailed)
		return
	}
	type item struct {
		seq  int
		node string
		cmd  string
	}
	items := []item{}
	for rows.Next() {
		var it item
		if err := rows.Scan(&it.seq, &it.node, &it.cmd); err == nil {
			items = append(items, it)
		}
	}
	rows.Close()
	nodes := loadExecNodes()
	failed := false
	for i, it := range items {
		if failed {
			_, _ = db.DB.Exec("UPDATE tbl_aiops_execution SET status=? WHERE solution_id=? AND seq=?", "skipped", id, it.seq)
			continue
		}
		_, _ = db.DB.Exec("UPDATE tbl_aiops_execution SET status=?, started_at=NOW() WHERE solution_id=? AND seq=?", "running", id, it.seq)
		output, runErr := sshRun(nodes, it.node, it.cmd)
		status := "done"
		if runErr != nil {
			status = "failed"
			output = output + "\n[error] " + runErr.Error()
			failed = true
		}
		if len(output) > 60000 {
			output = output[:60000] + "\n...[截断]"
		}
		_, _ = db.DB.Exec("UPDATE tbl_aiops_execution SET status=?, output=?, finished_at=NOW() WHERE solution_id=? AND seq=?",
			status, output, id, it.seq)
		log.Infof("aiops solutions: %s action %d/%d on %s -> %s", id, i+1, len(items), it.node, status)
	}
	if failed {
		markSolution(id, solFailed)
	} else {
		markSolution(id, solDone)
	}
}

func markSolution(id string, status string) {
	if _, err := db.DB.Exec("UPDATE tbl_aiops_solution SET status=? WHERE id=?", status, id); err != nil {
		log.Errorf("aiops solutions: mark %s %s: %s", id, status, err.Error())
	}
}

// loadExecNodes 读取节点执行通道配置；缺省时 node 名即主机名、root、22 端口。
func loadExecNodes() map[string]execNode {
	nodes := map[string]execNode{}
	raw, err := os.ReadFile(execNodesPath)
	if err == nil {
		_ = json.Unmarshal(raw, &nodes)
	}
	return nodes
}

// sshRun 经 SSH 在目标节点执行一条命令并回收合并输出。
//
// 【三层超时】ssh.Dial 15s（建连）→ timeout 110（远端命令自身上限）
// → select 120s（本地兜底并对会话发 SIGKILL）。任一超时即执行级失败。
// 【退出码语义】命令尾部追加 `; rc=$?; echo "[exit=$rc]"; exit 0`，
// 使取证命令的非零退出（探针缺失）体现在输出而不是触发批次熔断；
// 命令文本单引号包裹并做 Posix 转义，避免远端外层 shell 先行展开 $?。
func sshRun(nodes map[string]execNode, node string, cmd string) (string, error) {
	target := execNode{Host: node, Port: 22, User: "root"}
	if n, ok := nodes[node]; ok {
		if n.Host != "" {
			target.Host = n.Host
		}
		if n.Port > 0 {
			target.Port = n.Port
		}
		if n.User != "" {
			target.User = n.User
		}
	}
	key, err := os.ReadFile(execKeyPath)
	if err != nil {
		return "", fmt.Errorf("执行私钥缺失（%s）：%w", execKeyPath, err)
	}
	signer, err := ssh.ParsePrivateKey(key)
	if err != nil {
		return "", fmt.Errorf("执行私钥解析失败：%w", err)
	}
	client, err := ssh.Dial("tcp", fmt.Sprintf("%s:%d", target.Host, target.Port), &ssh.ClientConfig{
		User:            target.User,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), // 集群内网固定节点；CA 化在正式部署时补齐
		Timeout:         15 * time.Second,
	})
	if err != nil {
		return "", fmt.Errorf("SSH 连接失败：%w", err)
	}
	defer client.Close()
	session, err := client.NewSession()
	if err != nil {
		return "", fmt.Errorf("SSH 会话失败：%w", err)
	}
	defer session.Close()
	type result struct {
		out []byte
		err error
	}
	ch := make(chan result, 1)
	go func() {
		// 非登录 shell：登录 profile 在高负载机器上可能挂起（conda/venv 初始化等）
		probe := cmd + `; rc=$?; echo "[exit=$rc]"; exit 0`
		// 单引号包裹防止远端外层 shell 展开 $?；命令内单引号按 Posix 方式转义
		quoted := "'" + strings.ReplaceAll(probe, "'", `'\''`) + "'"
		out, err := session.CombinedOutput("timeout 110 bash -c " + quoted)
		ch <- result{out, err}
	}()
	select {
	case r := <-ch:
		return string(r.out), r.err
	case <-time.After(execCommandTimeout):
		_ = session.Signal(ssh.SIGKILL)
		return "", fmt.Errorf("命令执行超时（%ds）", int(execCommandTimeout.Seconds()))
	}
}

// SolutionsPage 人工审批页面（平台会话保护，服务器端渲染，内联脚本调 JSON API）。
func SolutionsPage(c *gin.Context) {
	c.Header("Content-Type", "text/html; charset=utf-8")
	c.String(http.StatusOK, solutionsPageHTML)
}
