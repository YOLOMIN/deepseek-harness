/** Third-party operations platform connection settings shared by Host and Client. */
import z from '@deepseek-ai/schemastery'

/** One operations platform exposed through the common authentication adapter protocol. */
export interface OperationsPlatformConfig {
  /** Stable identifier used by account records and the default-platform selection. */
  id: string
  /** User-facing platform name. */
  name: string
  /** Username/password authentication endpoint. */
  loginUrl: string
  /** Optional one-time ticket exchange endpoint. */
  ticketLoginUrl: string
  /** Optional adapter health endpoint. */
  healthUrl: string
}

/** Operations platform list and the provider selected for new login and ticket flows. */
export interface OperationsPlatformsConfig {
  /** Configured adapters, in display order. */
  operationsPlatforms: OperationsPlatformConfig[]
  /** Id of the provider selected by default. */
  defaultPlatformId: string
}

/** Serialized platform fields stored by the settings service. */
export interface OperationsPlatformsFormValue {
  /** JSON-encoded platform list; Volatile currently accepts scalar fields only. */
  operationsPlatformsJson: string
  /** Id of the provider selected by default. */
  defaultPlatformId: string
}

const currentPlatform: OperationsPlatformConfig = {
  id: 'scmms',
  name: '基础运维平台',
  loginUrl: 'http://192.168.10.95:9091/api/aiops/login',
  ticketLoginUrl: 'http://192.168.10.95:9091/api/aiops/ticket-login',
  healthUrl: 'http://192.168.10.95:9091/api/aiops/health',
}

/** Default adapter preserved for existing GAC2 deployments. */
export const DEFAULT_OPERATIONS_PLATFORMS: OperationsPlatformsConfig = {
  operationsPlatforms: [currentPlatform],
  defaultPlatformId: currentPlatform.id,
}

/** Scalar settings fields used instead of unsupported Volatile arrays. */
export const OperationsPlatformsFormFields = {
  operationsPlatformsJson: z.string().default(JSON.stringify([currentPlatform])),
  defaultPlatformId: z.string().min(1).default(currentPlatform.id),
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`)
  return value
}

function optionalEndpoint(value: unknown, field: string): string {
  if (value === undefined || value === '') return ''
  if (typeof value !== 'string' || !/^https?:\/\//.test(value)) throw new Error(`${field} must be an HTTP(S) endpoint`)
  return value
}

function platformOf(value: unknown): OperationsPlatformConfig {
  const item = recordOf(value)
  if (!item) throw new Error('Operations platform entries must be objects')
  return {
    id: requiredText(item.id, 'id'),
    name: requiredText(item.name, 'name'),
    loginUrl: optionalEndpoint(requiredText(item.loginUrl, 'loginUrl'), 'loginUrl'),
    ticketLoginUrl: optionalEndpoint(item.ticketLoginUrl, 'ticketLoginUrl'),
    healthUrl: optionalEndpoint(item.healthUrl, 'healthUrl'),
  }
}

/** Validate the default-platform reference across the complete configuration. */
export function validateOperationsPlatforms(value: OperationsPlatformsConfig): OperationsPlatformsConfig {
  if (value.operationsPlatforms.length === 0) throw new Error('At least one operations platform is required')
  if (new Set(value.operationsPlatforms.map(item => item.id)).size !== value.operationsPlatforms.length) {
    throw new Error('Operations platform ids must be unique')
  }
  if (!value.operationsPlatforms.some(item => item.id === value.defaultPlatformId)) {
    throw new Error('The default operations platform must exist')
  }
  return value
}

/** Validate a structured platform configuration and apply the current defaults. */
export function OperationsPlatformsConfig(value: unknown = {}): OperationsPlatformsConfig {
  const body = recordOf(value) ?? {}
  const operationsPlatforms = body.operationsPlatforms === undefined
    ? [currentPlatform]
    : Array.isArray(body.operationsPlatforms)
      ? body.operationsPlatforms.map(platformOf)
      : (() => { throw new Error('Operations platforms must be an array') })()
  const defaultPlatformId = body.defaultPlatformId === undefined ? currentPlatform.id : requiredText(body.defaultPlatformId, 'defaultPlatformId')
  return validateOperationsPlatforms({ operationsPlatforms, defaultPlatformId })
}

/** Parse and validate one settings document into the structured editor model. */
export function operationsPlatformsFromJson(value: string, defaultPlatformId = 'scmms'): OperationsPlatformsConfig {
  const operationsPlatforms: unknown = JSON.parse(value)
  return OperationsPlatformsConfig({ operationsPlatforms, defaultPlatformId })
}
