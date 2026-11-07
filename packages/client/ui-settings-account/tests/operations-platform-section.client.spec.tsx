// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi, type Mock } from 'vitest'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { DEFAULT_OPERATIONS_PLATFORMS, type OperationsPlatformsConfig } from '../src/operations-platform.ts'
import type { AccountSectionInjected } from '../src/client/AccountSection.tsx'
import { OperationsPlatformSection } from '../src/client/OperationsPlatformSection.tsx'
import { en, type AccountKey } from '../src/client/locales.ts'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const themeSnapshot = {
  preference: 'light', fontSizes: { text: 14, code: 11, terminal: 13 }, fontFamilies: { text: '', code: '', terminal: '' },
  active: { id: 'light', colorScheme: 'light', tokens: {} }, themes: [], revision: 0,
} as ThemeSnapshot

function mount(
  value: OperationsPlatformsConfig,
  savePlatforms: Mock<(value: OperationsPlatformsConfig) => Promise<boolean>> = vi.fn(async () => true),
) {
  const operations = {
    savePlatforms,
    hooks: {
      account: {
        getSnapshot: () => ({ view: undefined, details: undefined, avatar: undefined, failed: false }),
        subscribe: () => () => {},
      },
      theme: { getSnapshot: () => themeSnapshot, subscribe: () => () => {} },
      platforms: {
        getSnapshot: () => ({
          status: 'ready' as const, base: undefined, user: undefined, revision: 1, writable: true,
          value: { operationsPlatformsJson: JSON.stringify(value.operationsPlatforms), defaultPlatformId: value.defaultPlatformId },
        }),
        subscribe: () => () => {},
      },
    },
    refreshAccount: vi.fn(async () => {}),
    contactUs: vi.fn(), showLogin: vi.fn(), setOnboarding: vi.fn(),
    bonusNoticeShown: vi.fn(), bonusNoticeDismissed: vi.fn(),
    avatarFailed: vi.fn(), hasRunningAccountTasks: vi.fn(async () => false),
    start: vi.fn(async () => {}), cancel: vi.fn(async () => {}), signOut: vi.fn(async () => {}),
  } as AccountSectionInjected
  render(<OperationsPlatformSection {...({} as GlobalStandardProps)} {...operations}
    useAccount={selector => selector(operations.hooks.account.getSnapshot())}
    useTheme={selector => selector(operations.hooks.theme.getSnapshot())}
    usePlatforms={selector => selector(operations.hooks.platforms.getSnapshot())} t={key => en[key as AccountKey]} close={() => {}} />)
  return { savePlatforms }
}

it('adds a platform, selects it as default, and saves the complete list', async () => {
  const { savePlatforms } = mount(DEFAULT_OPERATIONS_PLATFORMS)
  fireEvent.click(screen.getByRole('button', { name: en.operationsAdd }))
  const inputs = screen.getAllByRole('textbox')
  fireEvent.change(inputs[6]!, { target: { value: 'Second Platform' } })
  fireEvent.change(inputs[7]!, { target: { value: 'https://second.example/login' } })
  fireEvent.click(screen.getAllByRole('radio', { name: en.operationsDefault })[1]!)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.operationsSave })) })
  expect(savePlatforms).toHaveBeenCalledOnce()
  const saved = savePlatforms.mock.calls[0]![0]
  expect(saved.operationsPlatforms).toHaveLength(2)
  expect(saved.operationsPlatforms[1]).toMatchObject({ name: 'Second Platform', loginUrl: 'https://second.example/login' })
  expect(saved.defaultPlatformId).toBe(saved.operationsPlatforms[1]!.id)
  expect(screen.getByRole('alert').textContent).toBe(en.operationsSaved)
})

it('checks adapter health and reports a refused save', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
  const { savePlatforms } = mount(DEFAULT_OPERATIONS_PLATFORMS, vi.fn(async () => false))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.operationsCheck })) })
  expect(screen.getByRole('status').textContent).toBe(en.operationsCheckOk)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.operationsSave })) })
  expect(savePlatforms).toHaveBeenCalledOnce()
  expect(screen.getByRole('alert').textContent).toBe(en.operationsSaveFailed)
})
