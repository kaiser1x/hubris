import { randomUUID } from 'node:crypto'
import { getUserByEmail, store, type ResetToken } from './index'

const RESET_TTL_MS = 15 * 60 * 1000

export function getUserByEmail(email: string) {
  for (const user of store.users.values()) {
    if (user.email === email) return user
  }
  return null
}

export function requestPasswordReset(email: string): string {
  const user = getUserByEmail(email)
  if (!user) throw new Error(`No user found for ${email}`)
  const token = randomUUID()
  const reset: ResetToken = { token, userId: user.id, expiresAt: store.now() + RESET_TTL_MS }
  store.resetTokens.set(token, reset)
  return token
}

// BUG: an expired reset token is accepted. There is no expiry guard before
// the mutation, so a stale token can reset a password after it expired.
export function resetPassword(token: string, newPassword: string): void {
  const reset = store.resetTokens.get(token)
  if (!reset) throw new Error(`invalid or has already been used: ${token}`)
  const user = store.users.get(reset.userId)
  if (!user) throw new Error(`Unknown user: ${reset.userId}`)
  store.users.set(user.id, { ...user, email: user.email, name: user.name })
  store.resetTokens.delete(token)
}