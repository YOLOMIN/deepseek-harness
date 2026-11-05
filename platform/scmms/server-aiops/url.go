// GAC2：智能运维标准对接接口（认证适配协议）。
// 平台作为被对接方，对外提供账号口令认证、免登票据签发/核销与健康检查四类标准接口，
// 智能体控制平台（dsh）或其他第三方平台经该组接口完成平台账户体系对接；
// 接口路径固定为 /api/aiops/*，与控制端实现无关，控制端替换时对接协议保持不变。
package aiops

import (
	"github.com/gin-gonic/gin"
	"gitlab.kylinsec.net/kylin-devdept1/ks-scmms/ks-scmms-2.x/ks-scmms-server.git/router/aiops/views"
)

// Routers 注册智能运维标准对接接口，直接挂载在根引擎上（不属于 /api/v1 业务接口组）。
// login、ticket-login、health 为匿名接口（已加入认证中间件白名单，跨域调用不携带平台会话）；
// ticket 为免登票据签发接口，必须经平台会话认证，由认证中间件保障调用方已登录。
// solutions 闭环接口（方案接收/审批/执行回收）走 Bearer Token 认证（与 MCP 端点同一口令文件）；
// /aiops/solutions 审批页面经平台会话保护。
func Routers(r *gin.Engine) {
	r.POST("/api/aiops/login", views.CORS, views.Login)
	r.POST("/api/aiops/ticket", views.IssueTicket)
	r.POST("/api/aiops/ticket-login", views.CORS, views.TicketLogin)
	r.GET("/api/aiops/health", views.CORS, views.Health)
	// 跨域预检：匿名接口允许来自智能体控制平台页面的浏览器跨域调用
	r.OPTIONS("/api/aiops/login", views.CORS, views.Preflight)
	r.OPTIONS("/api/aiops/ticket-login", views.CORS, views.Preflight)
	r.OPTIONS("/api/aiops/health", views.CORS, views.Preflight)
	// GAC2：诊断方案闭环（DSH 方案推送 → 人工审批 → SSH 下发执行 → 结果回收）
	r.POST("/api/aiops/solutions", views.BearerAuth, views.CreateSolution)
	r.GET("/api/aiops/solutions", views.BearerAuth, views.ListSolutions)
	r.GET("/api/aiops/solutions/:id", views.BearerAuth, views.GetSolution)
	r.POST("/api/aiops/solutions/:id/approve", views.BearerAuth, views.ApproveSolution)
	r.POST("/api/aiops/solutions/:id/reject", views.BearerAuth, views.RejectSolution)
	r.GET("/api/aiops/solutions/:id/executions", views.BearerAuth, views.GetExecutions)
	r.GET("/aiops/solutions", views.SolutionsPage)
}
