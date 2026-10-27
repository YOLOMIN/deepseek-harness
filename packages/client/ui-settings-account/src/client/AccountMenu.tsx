/** Sidebar account launcher and locally authoritative sign-out action. */
import { useEffect, useRef, useState } from 'react'
import {
  Toast, Menu, IconEllipsisOutlineMedium, IconPaperPlaneOutlineMedium, IconSettingsOutlineMedium, IconUserOutlineMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { DEFAULT_OPERATIONS_PLATFORMS, operationsPlatformsFromJson } from '../operations-platform.ts'
import type { AccountSectionInjected } from './AccountSection.tsx'
import { operationsLogin, operationsTicketLogin, type OperationsAccount } from './operations-platform.ts'
import { SignOutDialog } from './SignOutDialog.tsx'
import { SignInDialog } from './SignInDialog.tsx'
import { LogoutIcon } from './LogoutIcon.tsx'
import { AccountAvatar } from './AccountAvatar.tsx'
import { AccountNoticeStack } from './AccountNotice.tsx'
import css from './AccountMenu.module.css'

const PLATFORM_KEY = 'aiops.account'
const PLATFORM_EVENT = 'aiops-account'
const DEFAULT_PLATFORMS = DEFAULT_OPERATIONS_PLATFORMS

function readPlatformAccount(): OperationsAccount | null {
  try {
    const raw = localStorage.getItem(PLATFORM_KEY)
    if (!raw) return null
    const account = JSON.parse(raw) as OperationsAccount
    return { ...account, providerId: account.providerId ?? 'scmms' }
  } catch { return null }
}

function writePlatformAccount(account: OperationsAccount | null): void {
  if (account) localStorage.setItem(PLATFORM_KEY, JSON.stringify(account))
  else localStorage.removeItem(PLATFORM_KEY)
  window.dispatchEvent(new Event(PLATFORM_EVENT))
}

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
  useAccount, useTheme, usePlatforms, signOut, hasRunningAccountTasks, refreshAccount, bonusNoticeShown, bonusNoticeDismissed,
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
  const platformConfig = usePlatforms(state => state)
  const settings = platformConfig.value
    ? operationsPlatformsFromJson(platformConfig.value.operationsPlatformsJson, platformConfig.value.defaultPlatformId)
    : DEFAULT_PLATFORMS
  const providers = settings.operationsPlatforms
  const defaultProvider = providers.find(item => item.id === settings.defaultPlatformId) ?? providers[0]
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
  const [platformAccount, setPlatformAccount] = useState<OperationsAccount | null>(readPlatformAccount)
  const [pfLoginOpen, setPfLoginOpen] = useState(false)
  const [pfProviderId, setPfProviderId] = useState(DEFAULT_PLATFORMS.defaultPlatformId)
  const [pfName, setPfName] = useState('')
  const [pfPassword, setPfPassword] = useState('')
  const [pfBusy, setPfBusy] = useState(false)
  const [pfErr, setPfErr] = useState('')
  const provider = providers.find(item => item.id === pfProviderId) ?? defaultProvider
  const deepSeekWasSignedIn = useRef(signedIn)
  useEffect(() => {
    if (signedIn && !deepSeekWasSignedIn.current) writePlatformAccount(null)
    deepSeekWasSignedIn.current = signedIn
  }, [signedIn])
  useEffect(() => {
    const sync = () => { setPlatformAccount(readPlatformAccount()) }
    window.addEventListener(PLATFORM_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(PLATFORM_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])
  useEffect(() => {
    const m = document.cookie.match(/(?:^|;\s*)pf_ticket=([^;]+)/)
    const ticket = m?.[1]
    if (!ticket || !defaultProvider?.ticketLoginUrl) return
    const selected = defaultProvider
    document.cookie = 'pf_ticket=; Path=/; Max-Age=0'
    void (async () => {
      try {
        const reply = await operationsTicketLogin(selected, ticket)
        if (reply.status === 0 && reply.username && reply.role !== undefined) {
          writePlatformAccount({ name: reply.username, role: reply.role, providerId: selected.id })
        } else if (reply.status === 2 && reply.username) {
          setPfProviderId(selected.id)
          setPfName(reply.username)
          setPfLoginOpen(true)
        }
      } catch { /* Keep both sign-in entries available when the relay is offline. */ }
    })()
  }, [defaultProvider])
  const requestSignOut = async () => {
    setBusy(true)
    try { setSignOutImpact(await hasRunningAccountTasks()); setOpen(false) }
    catch (_error) { setSignOutImpact('unknown'); setOpen(false) }
    finally { setBusy(false) }
  }
  // The plugin's start publishes `loginFailed` before it rejects, so the dialog owns the report.
  const beginSignIn = (): void => { setOpen(false); void start().catch(() => undefined) }
  const openPlatformLogin = (): void => {
    setOpen(false)
    setPfProviderId(defaultProvider?.id ?? DEFAULT_PLATFORMS.defaultPlatformId)
    setPfErr('')
    setPfLoginOpen(true)
  }
  const doPlatformLogin = async () => {
    if (!pfName || !pfPassword) { setPfErr(t('platformCredentialsRequired')); return }
    if (!provider) { setPfErr(t('platformUnavailable')); return }
    setPfBusy(true); setPfErr('')
    try {
      const reply = await operationsLogin(provider, pfName, pfPassword)
      if (reply.status === 0 && reply.role !== undefined) {
        writePlatformAccount({ name: pfName, role: reply.role, providerId: provider.id })
        setPfLoginOpen(false); setPfPassword('')
      } else {
        setPfErr(reply.msg || t('platformLoginFailed'))
      }
    } catch { setPfErr(t('platformUnavailable')) } finally { setPfBusy(false) }
  }
  return <div ref={anchor} className={css.root}>
    {signInNotice > 0 && <Toast key={signInNotice} text={t('modelSignInRequired')} onDone={() => { setSignInNotice(0) }} />}
    {expiryNotice && <Toast text={t('sessionExpired')} onDone={() => { setExpiryNotice(false) }} />}
    {signedIn && !account.desktopOnboardingVisible && !account.onboarding && account.notices && <AccountNoticeStack
      notices={account.notices}
      anchor={anchor} title={t('bonusNoticeTitle')} closeLabel={t('close')}
      onShown={bonusNoticeShown} onDismiss={bonusNoticeDismissed} />}
    <Menu open={open} side="top" portal autoFocus className={css.anchor} listClassName={signedIn || platformAccount ? undefined : css.signedOutMenu}
      anchor={<button ref={trigger} type="button" className={css.trigger} data-collapsed={!wide} data-signed-out={!signedIn && !platformAccount} aria-label={t('menu')}
        aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
        {platformAccount
          ? <span className={css.avatar}>{platformAccount.name.charAt(0).toUpperCase()}</span>
          : signedIn
            ? <span className={css.avatar} data-avatar-status={account.avatar?.status}>
              <AccountAvatar avatar={account.avatar} avatarFailed={avatarFailed} />
            </span>
            : <IconEllipsisOutlineMedium size={14} />}
        {wide && <span className={css.label}>{platformAccount?.name ?? (signedIn ? label : t('more'))}</span>}
      </button>}
      items={[
        { id: 'settings', label: t('settings'), icon: <IconSettingsOutlineMedium size={16} />,
          ...(settingsShortcut === undefined ? {} : { shortcut: settingsShortcut }) },
        { id: 'contact', label: t('contactUs'), icon: <IconPaperPlaneOutlineMedium size={16} /> },
        ...(!platformAccount && !signedIn ? [{
          id: 'signin', label: t('signIn'), icon: <IconUserOutlineMedium size={16} />,
          submenu: [
            { id: 'platform-signin', label: t('platformSignIn'), icon: <IconUserOutlineMedium size={16} /> },
            { id: 'deepseek-signin', label: t('deepseekSignIn'), icon: <IconUserOutlineMedium size={16} /> },
          ],
        }] : []),
        ...(platformAccount ? [{ id: 'platform-signout', label: t('platformSignOut'), icon: <LogoutIcon /> }]
          : signedIn ? [{ id: 'signout', label: t('signOut'), icon: <LogoutIcon />, disabled: busy }] : []),
      ]}
      onClose={() => { setOpen(false) }}
      onSelect={(id) => {
        if (id === 'settings') { setOpen(false); trigger.current?.focus(); openSettings() }
        else if (id === 'contact') { setOpen(false); contactUs() }
        else if (id === 'platform-signin') openPlatformLogin()
        else if (id === 'platform-signout') { setOpen(false); writePlatformAccount(null) }
        else if (id === 'deepseek-signin') beginSignIn()
        else void requestSignOut()
      }} />
    {account.loginVisible && !account.onboarding && <SignInDialog account={account} colorScheme={colorScheme}
      start={start} cancel={cancel} t={t}
      close={() => { showLogin(false) }} useApiKey={() => { showLogin(false); openOnboarding('deepseek-official') }} />}
    {signedIn && signOutImpact !== undefined && <SignOutDialog running={signOutImpact} signOut={signOut}
      close={() => { setSignOutImpact(undefined) }} t={t} />}
    {pfLoginOpen && !platformAccount && (
      <div style={overlayStyle} onClick={() => { setPfLoginOpen(false) }}>
        <div style={dialogStyle} role="dialog" aria-label={t('platformSignIn')} onClick={(e) => { e.stopPropagation() }}>
          <div style={{ fontSize: 15, fontWeight: 500 }}>{t('platformSignIn')}</div>
          <div style={{ marginTop: 4, fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#8a94a6)' }}>
            {t('platformLoginDescription')}
          </div>
          {providers.length > 1 && <select style={dlgInputStyle} aria-label={t('platformProvider')} value={provider?.id ?? pfProviderId}
            onChange={(e) => { setPfProviderId(e.target.value) }}>
            {providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>}
          <input style={dlgInputStyle} placeholder={t('platformUsername')} aria-label={t('platformUsername')} value={pfName}
            onChange={(e) => { setPfName(e.target.value) }} />
          <input style={dlgInputStyle} type="password" placeholder={t('platformPassword')} aria-label={t('platformPassword')} value={pfPassword}
            onChange={(e) => { setPfPassword(e.target.value) }}
            onKeyDown={(e) => { if (e.key === 'Enter') void doPlatformLogin() }} />
          {pfErr && <div role="alert" style={{ marginTop: 8, fontSize: 12, color: 'var(--dsw-alias-state-error-primary,#d73a49)' }}>{pfErr}</div>}
          <button type="button" style={dlgBtnStyle} disabled={pfBusy} onClick={() => void doPlatformLogin()}>
            {pfBusy ? t('platformLoggingIn') : t('signIn')}
          </button>
        </div>
      </div>
    )}
  </div>
}
