/** Sidebar account launcher and locally authoritative sign-out action. */
import { useEffect, useRef, useState } from 'react'
import {
  Toast, Menu, IconEllipsisOutlineMedium, IconPaperPlaneOutlineMedium, IconSettingsOutlineMedium, IconUserOutlineMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AccountSectionInjected } from './AccountSection.tsx'
import { SignOutDialog } from './SignOutDialog.tsx'
import { SignInDialog } from './SignInDialog.tsx'
import { LogoutIcon } from './LogoutIcon.tsx'
import { AccountAvatar } from './AccountAvatar.tsx'
import { AccountNoticeStack } from './AccountNotice.tsx'
import css from './AccountMenu.module.css'

/* ---------- GAC2 平台统一账户（左下角唯一账户入口） ---------- */
/** 平台账户共享状态：localStorage 键 + 窗口事件，控制台插件页与本组件共用。 */
const PLATFORM_KEY = 'aiops.account'
const PLATFORM_EVENT = 'aiops-account'

interface PlatformAccount { name: string; role: number }

function readPlatformAccount(): PlatformAccount | null {
  try {
    const raw = localStorage.getItem(PLATFORM_KEY)
    return raw ? JSON.parse(raw) as PlatformAccount : null
  } catch { return null }
}

function writePlatformAccount(account: PlatformAccount | null): void {
  if (account) localStorage.setItem(PLATFORM_KEY, JSON.stringify(account))
  else localStorage.removeItem(PLATFORM_KEY)
  window.dispatchEvent(new Event(PLATFORM_EVENT))
}

/** 平台账号认证中继地址（联调环境）。 */
const RELAY_LOGIN_URL = 'http://127.0.0.1:3081/api/aiops/login'
/** 免登票据核销地址：运维平台入口页跳转控制台时携带的一次性票据。 */
const RELAY_TICKET_URL = 'http://127.0.0.1:3081/api/aiops/ticket-login'

const overlayStyle: Record<string, string | number> = {
  position: 'fixed', inset: 0, background: 'rgba(15,18,24,.45)', zIndex: 9999,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
}
const dialogStyle: Record<string, string | number> = {
  width: 320, borderRadius: 10, padding: '20px 22px',
  background: 'var(--dsw-alias-bg-module-platform,#ffffff)', color: 'var(--dsw-alias-label-primary,#1f2328)',
  boxShadow: '0 12px 32px rgba(0,0,0,.25)', fontSize: 13,
}
const dlgInputStyle: Record<string, string | number> = {
  width: '100%', boxSizing: 'border-box', fontSize: 13, borderRadius: 6, padding: '7px 10px', marginTop: 6,
  border: '1px solid var(--dsw-alias-border-l,#e3e6ea)', background: 'transparent',
  color: 'var(--dsw-alias-label-primary,#1f2328)', outline: 'none',
}
const dlgBtnStyle: Record<string, string | number> = {
  width: '100%', marginTop: 14, fontSize: 13, borderRadius: 6, padding: '8px 0', cursor: 'pointer',
  border: 'none', background: 'var(--dsw-alias-brand-primary,#5b6ee1)',
  color: 'var(--dsw-alias-bg-module-platform,#ffffff)',
}

/** Account launcher composed by the settings shell. */
export type AccountMenuProps = PropsRuntime<'settings.launcher'> & PropsLocale<'settings.account'> & InjectFace<AccountSectionInjected>

/** The signed-in label stays empty while the profile loads.
 * @param props - sidebar geometry, settings navigation and account operations.
 * @returns account menu launcher.
 */
export function AccountMenu({
  subscribeSessionExpired, subscribeModelSignInRequired, wide, settingsShortcut, openSettings, openOnboarding, settingsOpen,
  useAccount, useTheme, signOut, hasRunningAccountTasks, refreshAccount, bonusNoticeShown, bonusNoticeDismissed,
  contactUs, showLogin, start, cancel, avatarFailed, t,
}: AccountMenuProps) {
  const anchor = useRef<HTMLDivElement>(null)
  // The launcher outlives the panel, so a false-to-true edge is one Settings entry:
  // re-renders, section switches and tab switches inside one open must not read again.
  const settingsWasOpen = useRef(false)
  useEffect(() => {
    if (settingsOpen && !settingsWasOpen.current) void refreshAccount()
    settingsWasOpen.current = settingsOpen
  }, [refreshAccount, settingsOpen])
  const account = useAccount(state => state)
  const colorScheme = useTheme(snapshot => snapshot.active.colorScheme)
  const signedIn = account.view?.status === 'credential-stored'
  const [signInNotice, setSignInNotice] = useState(0)
  useEffect(() => subscribeModelSignInRequired?.(() => { setSignInNotice(value => value + 1) }), [subscribeModelSignInRequired])
  const [expiryNotice, setExpiryNotice] = useState(false)
  useEffect(() => subscribeSessionExpired?.(() => { setExpiryNotice(true) }), [subscribeSessionExpired])
  const profile = account.details?.profile
  const label = profile === undefined ? null : profile.status === 'ready'
    ? profile.value.name ?? profile.value.contact ?? t('signedIn') : t('signedIn')
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const [signOutImpact, setSignOutImpact] = useState<boolean | 'unknown'>()

  /* ---------- GAC2 平台统一账户模式：左下角为唯一账户入口 ---------- */
  const [platformAccount, setPlatformAccount] = useState<PlatformAccount | null>(readPlatformAccount)
  const [pfMenuOpen, setPfMenuOpen] = useState(false)
  const [pfLoginOpen, setPfLoginOpen] = useState(false)
  const [pfName, setPfName] = useState('')
  const [pfPassword, setPfPassword] = useState('')
  const [pfBusy, setPfBusy] = useState(false)
  const [pfErr, setPfErr] = useState('')
  useEffect(() => {
    const sync = () => setPlatformAccount(readPlatformAccount())
    window.addEventListener(PLATFORM_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(PLATFORM_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])
  // 免登票据：运维平台入口页跳转时经 Cookie 携带 pf_ticket（dsh 认证重定向会剥离 URL 参数），
  // 核销后自动完成平台账户登录；未命中认证缓存时预填账号并弹出登录窗，仅需补输口令
  useEffect(() => {
    const m = document.cookie.match(/(?:^|;\s*)pf_ticket=([^;]+)/)
    if (!m) return
    const ticket = m[1]
    document.cookie = 'pf_ticket=; Path=/; Max-Age=0'
    void (async () => {
      try {
        const r = await fetch(RELAY_TICKET_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticket }),
        })
        const j = await r.json()
        if (j.status === 0 && j.data?.username) {
          writePlatformAccount({ name: j.data.username, role: j.data.role })
        } else if (j.status === 2 && j.data?.username) {
          setPfName(j.data.username)
          setPfLoginOpen(true)
        }
      } catch { /* 中继不可达时保持未登录态，用户可手动登录 */ }
    })()
  }, [])
  const doPlatformLogin = async () => {
    if (!pfName || !pfPassword) { setPfErr('请输入账号与口令'); return }
    setPfBusy(true); setPfErr('')
    try {
      const r = await fetch(RELAY_LOGIN_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: pfName, password: pfPassword }),
      })
      const j = await r.json()
      if (j.status === 0) {
        writePlatformAccount({ name: pfName, role: j.data.role })
        setPfLoginOpen(false); setPfPassword('')
      } else {
        setPfErr(j.msg || '登录失败')
      }
    } catch { setPfErr('无法连接账号认证服务') } finally { setPfBusy(false) }
  }
  // 平台账户模式：替代原 DeepSeek 在线账户启动器，保持控制台单套账户体系
  return <div ref={anchor} className={css.root} style={{ position: 'relative' }}>
    <button ref={trigger} type="button" className={css.trigger} data-collapsed={!wide} aria-label="平台账户"
      onClick={() => { platformAccount ? setPfMenuOpen(v => !v) : setPfLoginOpen(true) }}>
      <span className={css.avatar} style={{
        background: platformAccount ? 'var(--dsw-alias-brand-primary,#5b6ee1)' : 'var(--dsw-alias-border-l,#e3e6ea)',
        color: platformAccount ? 'var(--dsw-alias-bg-module-platform,#ffffff)' : 'var(--dsw-alias-label-secondary,#4a5568)',
        fontSize: 12, fontWeight: 600,
      }}>
        {platformAccount ? platformAccount.name.charAt(0).toUpperCase() : <IconUserOutlineMedium size={14} />}
      </span>
      {wide && <span className={css.label}>{platformAccount ? platformAccount.name : '平台账户登录'}</span>}
    </button>
    {pfMenuOpen && platformAccount && (
      <div style={{
        position: 'absolute', bottom: 46, left: 6, zIndex: 9999, minWidth: 180, borderRadius: 8, padding: 6,
        background: 'var(--dsw-alias-bg-module-platform,#ffffff)', color: 'var(--dsw-alias-label-primary,#1f2328)',
        boxShadow: '0 8px 24px rgba(0,0,0,.22)', fontSize: 13,
      }}>
        <div style={{ padding: '6px 10px', color: 'var(--dsw-alias-label-tertiary,#8a94a6)', fontSize: 12 }}>
          {platformAccount.name} · {platformAccount.role === 1 ? '系统管理员' : '运维账户'}
        </div>
        <button type="button" style={{ display: 'block', width: '100%', textAlign: 'left', border: 0, background: 'transparent', padding: '7px 10px', borderRadius: 6, cursor: 'pointer', color: 'inherit', fontSize: 13 }}
          onClick={() => { setPfMenuOpen(false); openSettings() }}>设置</button>
        <button type="button" style={{ display: 'block', width: '100%', textAlign: 'left', border: 0, background: 'transparent', padding: '7px 10px', borderRadius: 6, cursor: 'pointer', color: 'var(--dsw-alias-state-error-primary,#d73a49)', fontSize: 13 }}
          onClick={() => { setPfMenuOpen(false); writePlatformAccount(null) }}>退出平台登录</button>
      </div>
    )}
    {pfLoginOpen && !platformAccount && (
      <div style={overlayStyle} onClick={() => { setPfLoginOpen(false) }}>
        <div style={dialogStyle} onClick={e => e.stopPropagation()}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>平台账户登录</div>
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#8a94a6)' }}>
            复用基础运维平台（资源性能监控平台）账号体系统一认证
          </div>
          <input style={dlgInputStyle} placeholder="账号" value={pfName}
            onChange={e => setPfName((e.target as HTMLInputElement).value)} />
          <input style={dlgInputStyle} type="password" placeholder="口令" value={pfPassword}
            onChange={e => setPfPassword((e.target as HTMLInputElement).value)}
            onKeyDown={e => { if (e.key === 'Enter') void doPlatformLogin() }} />
          {pfErr && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-state-error-primary,#d73a49)' }}>{pfErr}</div>}
          <button type="button" style={dlgBtnStyle} disabled={pfBusy} onClick={() => void doPlatformLogin()}>
            {pfBusy ? '登录中…' : '登录'}
          </button>
        </div>
      </div>
    )}
  </div>
}
