import { beforeEach, describe, expect, it } from 'vitest'
import {
  createPayment,
  createUser,
  getPayment,
  getUserById,
  refund,
  resetState,
} from '../src/index'

beforeEach(() => {
  resetState()
})

describe('payments', () => {
  it('charges a user successfully', () => {
    const user = createUser({ email: 'bob@example.com', name: 'Bob', password: 'x' })
    const payment = createPayment(user.id, 1350)
    expect(payment.status).toBe('succeeded')
    expect(getPayment(payment.id)?.id).toBe(payment.id)
  })

  it('rejects unknown users and non-positive amounts', () => {
    expect(() => createPayment('no-such-user', 100)).toThrow(/Unknown user/)
    const user = createUser({ email: 'bob@example.com', name: 'Bob', password: 'x' })
    expect(() => createPayment(user.id, 0)).toThrow(/positive number/)
    expect(() => createPayment(user.id, -5)).toThrow(/positive number/)
  })

  it('rejects refunding a payment twice', () => {
    const user = createUser({ email: 'bob@example.com', name: 'Bob', password: 'x' })
    const payment = createPayment(user.id, 800)
    refund(payment.id)
    expect(getUserById(user.id)?.id).toBe(user.id)
    expect(() => refund(payment.id)).toThrow(/cannot be refunded/)
  })

  it('keeps payment history available', () => {
    const user = createUser({ email: 'bob@example.com', name: 'Bob', password: 'x' })
    const payment = createPayment(user.id, 100)
    expect(getPayment(payment.id)?.amount).toBe(100)
  })
})