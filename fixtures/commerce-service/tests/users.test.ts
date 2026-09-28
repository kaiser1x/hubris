import { beforeEach, describe, expect, it } from 'vitest'
import {
  createUser,
  getUserByEmail,
  requestPasswordReset,
  resetPassword,
  resetState,
  setUsersNow,
} from '../src/index'

beforeEach(() => {
  resetState()
})

describe('users', () => {
  it('creates a user and looks them up by email', () => {
    const created = createUser({ email: 'bob@example.com', name: 'Bob', password: 's3cret' })
    expect(getUserByEmail('bob@example.com')?.id).toBe(created.id)
  })

  it('rejects a request for an unknown email', () => {
    expect(() => requestPasswordReset('ghost@example.com')).toThrow(/No user found/)
  })

  it('rejects an expired reset token', () => {
    const user = createUser({ email: 'bob@example.com', name: 'Bob', password: 'old' })
    const fixed = 1_700_000_000_000
    setUsersNow(() => fixed)
    const token = requestPasswordReset(user.email)
    setUsersNow(() => fixed + 16 * 60 * 1000)
    expect(() => resetPassword(token, 'new')).toThrow(/expired/)
  })

  it('rejects a used or unknown reset token', () => {
    const user = createUser({ email: 'bob@example.com', name: 'Bob', password: 'old' })
    const token = requestPasswordReset(user.email)
    resetPassword(token, 'new')
    expect(() => resetPassword(token, 'again')).toThrow(/invalid/)
  })

  it('resets a password within its validity window', () => {
    const user = createUser({ email: 'bob@example.com', name: 'Bob', password: 'old' })
    const token = requestPasswordReset(user.email)
    expect(() => resetPassword(token, 'new')).not.toThrow()
  })
})