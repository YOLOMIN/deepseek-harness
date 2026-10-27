/** Browser client for the common operations authentication adapter protocol. */
import type { OperationsPlatformConfig } from '../operations-platform.ts'

/** Locally displayed operations account and its owning provider. */
export interface OperationsAccount {
  name: string
  role: number
  providerId?: string
}

/** Safe fields accepted from an adapter response. */
export interface OperationsReply {
  status: number | undefined
  msg: string | undefined
  username: string | undefined
  role: number | undefined
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

async function readReply(response: Response): Promise<OperationsReply> {
  const body = recordOf(await response.json())
  const data = recordOf(body?.data)
  return {
    status: typeof body?.status === 'number' ? body.status : undefined,
    msg: typeof body?.msg === 'string' ? body.msg : undefined,
    username: typeof data?.username === 'string' ? data.username : undefined,
    role: typeof data?.role === 'number' ? data.role : undefined,
  }
}

/**
 * Authenticate with username and password through one configured adapter.
 * @param platform - adapter connection settings.
 * @param username - platform username.
 * @param password - platform password sent only to the configured adapter.
 * @returns parsed adapter result without the password.
 */
export async function operationsLogin(platform: OperationsPlatformConfig, username: string, password: string): Promise<OperationsReply> {
  const response = await fetch(platform.loginUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  return readReply(response)
}

/**
 * Redeem a one-time sign-in ticket through the same adapter protocol.
 * @param platform - adapter connection settings.
 * @param ticket - single-use ticket issued by the operations platform.
 * @returns parsed ticket result.
 */
export async function operationsTicketLogin(platform: OperationsPlatformConfig, ticket: string): Promise<OperationsReply> {
  const response = await fetch(platform.ticketLoginUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket }),
  })
  return readReply(response)
}

/**
 * Check an adapter's configured health endpoint.
 * @param platform - adapter connection settings.
 * @returns whether the health endpoint responds with a successful HTTP status.
 */
export async function operationsHealth(platform: OperationsPlatformConfig): Promise<boolean> {
  if (!platform.healthUrl) return false
  const response = await fetch(platform.healthUrl)
  return response.ok
}
