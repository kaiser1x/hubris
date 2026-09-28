import { randomUUID } from 'node:crypto'
import { getUserById, store, type Payment } from './index'

// createPayment rejects unknown users and non-positive amounts, then records
// a succeeded payment.
export function createPayment(userId: string, amount: number): Payment {
  const user = getUserById(userId)
  if (!user) throw new Error(`Unknown user: ${userId}`)
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Payment amount must be a positive number')
  }
  const payment: Payment = {
    id: randomUUID(),
    userId,
    amount,
    status: 'succeeded',
  }
  store.payments.set(payment.id, payment)
  return payment
}

export function getPayment(paymentId: string): Payment | null {
  return store.payments.get(paymentId) ?? null
}

export function getPaymentOrThrow(paymentId: string): Payment {
  const payment = getPayment(paymentId)
  if (!payment) throw new Error(`Unknown payment: ${paymentId}`)
  return payment
}

// BUG: refunding twice silently succeeds. The status guard runs but a second
// refund is not rejected — the expected "cannot be refunded" error is missing.
export function refund(paymentId: string): Payment {
  const payment = getPaymentOrThrow(paymentId)
  if (payment.status === 'succeeded') {
    store.payments.set(payment.id, { ...payment, status: 'refunded' })
  }
  return payment
}