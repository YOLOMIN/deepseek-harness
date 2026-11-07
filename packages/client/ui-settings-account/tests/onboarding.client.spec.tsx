// @vitest-environment jsdom
/** The credential onboarding step owns login until dismissal or completion. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { DEFAULT_OPERATIONS_PLATFORMS, type OperationsPlatformsFormValue } from '../src/operations-platform.ts'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { AccountOnboarding } from '../src/client/AccountOnboarding.tsx'
import type { AccountSnapshot } from '../src/client/AccountSection.tsx'
import { allowAllAccess, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const theme: ThemeSnapshot = {
  preference: 'light', fontSizes: { text: 14, code: 11, terminal: 13 }, fontFamilies: { text: '', code: '', terminal: '' },
  active: { id: 'light', colorScheme: 'light', tokens: {} }, themes: [], revision: 0,
}

it('claims onboarding while loading, offers API key fallback, and completes after login', () => {
  let account: AccountSnapshot = { view: undefined, details: undefined, avatar: undefined, failed: false }
  const unused = (): never => { throw new Error('AccountOnboarding does not consume global hooks') }
  const globals: GlobalStandardProps = {
    usePanelInfo: unused, useSessions: unused, useSessionStatus: unused,
    useSessionRetainInfo: unused, useResource: unused, useWorkspaces: unused,
    ...allowAllAccess,
  }
  const platformsSnapshot: ConfigFormSnapshot<OperationsPlatformsFormValue> = {
    status: 'ready', base: undefined, user: undefined, revision: 1, writable: true,
    value: { operationsPlatformsJson: JSON.stringify(DEFAULT_OPERATIONS_PLATFORMS), defaultPlatformId: 'scmms' },
  }
  const props = {
    ...globals,
    hasRunningAccountTasks: vi.fn(async () => false),
    complete: vi.fn(), useApiKey: vi.fn(), setOnboarding: vi.fn(), showLogin: vi.fn(),
    useAccount: <T,>(select: (snapshot: AccountSnapshot) => T) => select(account),
    useTheme: <T,>(select: (snapshot: ThemeSnapshot) => T) => select(theme),
    usePlatforms: <T,>(select: (value: ConfigFormSnapshot<OperationsPlatformsFormValue>) => T) => select(platformsSnapshot),
    start: vi.fn(async () => {}), cancel: vi.fn(async () => {}), signOut: vi.fn(async () => {}),
    contactUs: vi.fn(), t: makeTranslate(en),
    refreshAccount: vi.fn(async () => {}), bonusNoticeShown: vi.fn(), bonusNoticeDismissed: vi.fn(),
    avatarFailed: vi.fn(),
    savePlatforms: vi.fn(async () => true),
  }
  const view = render(<AccountOnboarding {...props} />)
  expect(props.setOnboarding).toHaveBeenCalledExactlyOnceWith(true)
  expect(screen.queryByRole('dialog')).toBeNull()
  account = { ...account, view: { status: 'signed-out', attempt: null, links: { usageUrl: '', topUpUrl: '' } } }
  view.rerender(<AccountOnboarding {...props} />)
  fireEvent.click(screen.getByRole('button', { name: en.addApiKey }))
  expect(props.showLogin).toHaveBeenLastCalledWith(false)
  expect(props.useApiKey).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  expect(props.complete).toHaveBeenCalledOnce()
  account = { ...account, view: { ...account.view!, status: 'credential-stored' } }
  view.rerender(<AccountOnboarding {...props} />)
  expect(props.complete).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('dialog')).toBeNull()
  view.unmount()
  expect(props.setOnboarding).toHaveBeenLastCalledWith(false)
})
