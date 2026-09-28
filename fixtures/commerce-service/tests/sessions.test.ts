import { beforeEach, describe, expect, it } from 'vitest'
import {
  authenticate,
  createSession,
  createUser,
  getSession,
  refreshSession,
  resetState,
  setSessionsNow,
} from '../src/index'

beforeEach(() => {
  resetState()
})

describe('sessions', () => {
  it('creates a session for an existing user', () => {
    const user = createUser({ email: 'bob@example.com', name: 'Bob', password: 'x' })
    const session = createSession(user.id)
    expect(session.expiresAt).toBeGreaterThan(session.createdAt)
    expect(getSession(session.token)?.userId).toBe(user.id)
  })

  it('rejects sessions for unknown users', () => {
    expect(() => createSession('no-such-user')).toThrow(/Unknown user/)
  })

  it('expires sessions after their TTL', () => {
    const user = createUser({ email: 'bob@example.com', name: 'Bob', password: 'x' })
    const fixed = 1_700_000_000_000
    setSessionsNow(() => fixed)
    const session = createSession(user.id)
    setSessionsNow(() => fixed + 61 * 60 * 1000)
    expect(getSession(session.token)).toBeNull()
  })

  it('does not refresh an expired session', () => {
    const user = createUser({ email: 'bob@example.com', name: 'Bob', password: 'x' })
    const fixed = 1_700_000_000_000
    setSessionsNow(() => fixed)
    const session = createSession(user.id)
    setSessionsNow(() => fixed + 61 * 60 * 1000)
    expect(() => refreshSession(session.token)).toThrow(/expired/)
  })

  it('authenticates a live token', () => {
    const user = createUser({ email: 'bob@example.com', name: 'Bob', password: 'x' })
    const session = createSession(user.id)
    expect(authenticate(session.token)).toBe(user.id)
  })
})