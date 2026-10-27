import { expect, it } from 'vitest'
import { DEFAULT_OPERATIONS_PLATFORMS, OperationsPlatformsConfig } from '../src/operations-platform.ts'

it('keeps the current adapter as the default multi-platform configuration', () => {
  expect(OperationsPlatformsConfig({})).toEqual(DEFAULT_OPERATIONS_PLATFORMS)
})

it('accepts additional platforms and a different default provider', () => {
  const value = OperationsPlatformsConfig({
    operationsPlatforms: [
      ...DEFAULT_OPERATIONS_PLATFORMS.operationsPlatforms,
      { id: 'other', name: 'Other', loginUrl: 'https://other.example/login', ticketLoginUrl: '', healthUrl: '' },
    ],
    defaultPlatformId: 'other',
  })
  expect(value.defaultPlatformId).toBe('other')
  expect(value.operationsPlatforms).toHaveLength(2)
})

it('rejects duplicate ids, invalid endpoints, and a missing default provider', () => {
  const other = { id: 'other', name: 'Other', loginUrl: 'https://other.example/login', ticketLoginUrl: '', healthUrl: '' }
  expect(() => OperationsPlatformsConfig({ operationsPlatforms: [other, other], defaultPlatformId: 'other' })).toThrow(/unique/)
  expect(() => OperationsPlatformsConfig({ operationsPlatforms: [{ ...other, loginUrl: 'javascript:alert(1)' }], defaultPlatformId: 'other' })).toThrow()
  expect(() => OperationsPlatformsConfig({ operationsPlatforms: [other], defaultPlatformId: 'missing' })).toThrow(/must exist/)
})
