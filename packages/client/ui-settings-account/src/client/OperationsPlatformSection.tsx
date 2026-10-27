/** Operations platform list editor mounted as a settings section. */
import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { DEFAULT_OPERATIONS_PLATFORMS, operationsPlatformsFromJson, type OperationsPlatformConfig, type OperationsPlatformsConfig } from '../operations-platform.ts'
import { operationsHealth } from './operations-platform.ts'
import type { AccountSectionInjected } from './AccountSection.tsx'
import css from './OperationsPlatformSection.module.css'

/** Composed settings section props. */
export type OperationsPlatformSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'settings.account'> & InjectFace<AccountSectionInjected>

function validPlatforms(value: OperationsPlatformsConfig): boolean {
  const ids = value.operationsPlatforms.map(item => item.id)
  return ids.length > 0 && new Set(ids).size === ids.length && ids.includes(value.defaultPlatformId)
    && value.operationsPlatforms.every(item => item.id.trim() && item.name.trim() && /^https?:\/\//.test(item.loginUrl))
}

/** @param props - localized labels, live platform configuration, and persistence operations. @returns platform settings editor. */
export function OperationsPlatformSection({ usePlatforms, savePlatforms, t }: OperationsPlatformSectionProps) {
  const snapshot = usePlatforms(state => state)
  const stored = snapshot.value
    ? operationsPlatformsFromJson(snapshot.value.operationsPlatformsJson, snapshot.value.defaultPlatformId)
    : DEFAULT_OPERATIONS_PLATFORMS
  const [draft, setDraft] = useState<OperationsPlatformsConfig>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<'saved' | 'failed' | 'invalid'>()
  const [checking, setChecking] = useState<string>()
  const [health, setHealth] = useState<Record<string, boolean>>({})
  const value = draft ?? stored
  const writable = snapshot.writable && !busy
  const update = (id: string, patch: Partial<OperationsPlatformConfig>) => {
    setNotice(undefined)
    setDraft({
      defaultPlatformId: value.defaultPlatformId,
      operationsPlatforms: value.operationsPlatforms.map(item => item.id === id ? { ...item, ...patch } : item),
    })
  }
  const remove = (id: string) => {
    const operationsPlatforms = value.operationsPlatforms.filter(item => item.id !== id)
    setNotice(undefined)
    setDraft({ operationsPlatforms, defaultPlatformId: operationsPlatforms[0]?.id ?? '' })
  }
  const add = () => {
    const id = `platform-${Date.now()}`
    setNotice(undefined)
    setDraft({ defaultPlatformId: value.defaultPlatformId, operationsPlatforms: [...value.operationsPlatforms, {
      id, name: '', loginUrl: '', ticketLoginUrl: '', healthUrl: '',
    }] })
  }
  const save = async () => {
    if (!validPlatforms(value)) { setNotice('invalid'); return }
    setBusy(true)
    setNotice(undefined)
    try {
      const accepted = await savePlatforms(value)
      if (accepted) { setDraft(undefined); setNotice('saved') }
      else setNotice('failed')
    } catch { setNotice('failed') } finally { setBusy(false) }
  }
  const check = async (platform: OperationsPlatformConfig) => {
    setChecking(platform.id)
    try { setHealth({ ...health, [platform.id]: await operationsHealth(platform) }) }
    catch { setHealth({ ...health, [platform.id]: false }) }
    finally { setChecking(undefined) }
  }
  return <section className={css.section} aria-label={t('operationsNav')}>
    <div className={css.intro}>
      <h2 className={css.title}>{t('operationsNav')}</h2>
      <p className={css.description}>{t('operationsDescription')}</p>
    </div>
    {value.operationsPlatforms.map((platform, index) => <div className={css.card} key={platform.id}>
      <div className={css.cardHeader}>
        <label className={css.defaultChoice}>
          <input type="radio" name="default-platform" checked={value.defaultPlatformId === platform.id}
            onChange={() => {
              setNotice(undefined)
              setDraft({ defaultPlatformId: platform.id, operationsPlatforms: value.operationsPlatforms })
            }} />
          {t('operationsDefault')}
        </label>
        <Button variant="outline" disabled={busy} onClick={() => { remove(platform.id) }}>{t('operationsDelete')}</Button>
      </div>
      <div className={css.fields}>
        <label className={css.field}>{t('operationsId')}<input value={platform.id} readOnly /></label>
        <label className={css.field}>{t('operationsName')}<input value={platform.name} onChange={(e) => { update(platform.id, { name: e.target.value }) }} /></label>
        <label className={css.field}>{t('operationsLoginUrl')}<input value={platform.loginUrl} placeholder="https://adapter.example/api/login" onChange={(e) => { update(platform.id, { loginUrl: e.target.value }) }} /></label>
        <label className={css.field}>{t('operationsTicketUrl')}<input value={platform.ticketLoginUrl} placeholder="https://adapter.example/api/ticket" onChange={(e) => { update(platform.id, { ticketLoginUrl: e.target.value }) }} /></label>
        <label className={css.field}>{t('operationsHealthUrl')}<input value={platform.healthUrl} placeholder="https://adapter.example/health" onChange={(e) => { update(platform.id, { healthUrl: e.target.value }) }} /></label>
      </div>
      <div className={css.healthRow}>
        <Button variant="outline" disabled={!platform.healthUrl || checking !== undefined} onClick={() => { void check(platform) }}>
          {checking === platform.id ? t('operationsChecking') : t('operationsCheck')}
        </Button>
        {health[platform.id] !== undefined && <span className={health[platform.id] ? css.success : css.error} role="status">
          {t(health[platform.id] ? 'operationsCheckOk' : 'operationsCheckFailed')}
        </span>}
        <span className={css.index}>{index + 1} / {value.operationsPlatforms.length}</span>
      </div>
    </div>)}
    <div className={css.actions}>
      <Button variant="outline" disabled={busy} onClick={add}>{t('operationsAdd')}</Button>
      <Button variant="primary" disabled={!writable} onClick={() => { void save() }}>{t('operationsSave')}</Button>
    </div>
    {notice && <p className={notice === 'saved' ? css.success : css.error} role="alert">{t(notice === 'saved' ? 'operationsSaved' : notice === 'invalid' ? 'operationsInvalid' : 'operationsSaveFailed')}</p>}
  </section>
}
