import { randomUUID } from 'node:crypto'
import { getUserById, store, type Session } from './index'

const SESSION_TTL_MS = 60 * 60 * 1000

export function createSession(userId: string): Session {
  const user = getUserById(userId)
  if (!user) throw new Error(`Unknown user: ${userId}`)
  const session: Session = {
    token: randomUUID(),
    userId,
    createdAt: store.now(),
    expiresAt: store.now() + SESSION_TTL_MS,
  }
  store.sessions.set(session.token, session)
  return session
}

export function getSession(token: string): Session | null {
  const session = store.sessions.get(token)
  if (!session) return null
  if (store.now() > session.expiresAt) return null
  return session
}

// BUG: an expired session is silently refreshed. There is no expiry guard
// before the mutation, so a stale token keeps working.
export function refreshSession(token: string): Session {
  const session = store.sessions.get(token)
  if (!session) throw new Error(`Unknown session: ${token}`)
  const refreshed = { ...session, expiresAt: store.now() + SESSION_TTL_MS }
  store.sessions.set(token, refreshed)
  return refreshed
}

export function authenticate(token: string): string | null {
  const session = store.sessions.get(token)
  if (!session) return null
  if (store.now() > session.expiresAt) return null
  return session.userId
}