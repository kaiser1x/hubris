import { randomUUID } from 'node:crypto'

export interface User {
  id: string
  email: string
  name: string
}

export interface CartItem {
  productId: string
  quantity: number
}

export interface Cart {
  id: string
  userId: string
  items: Map<string, CartItem>
}

export interface Payment {
  id: string
  userId: string
  amount: number
  status: 'succeeded' | 'refunded'
}

export interface Session {
  token: string
  userId: string
  createdAt: number
  expiresAt: number
}

export interface Order {
  id: string
  userId: string
  total: number
  status: 'paid' | 'shipped' | 'cancelled'
}

export interface ResetToken {
  token: string
  userId: string
  expiresAt: number
}

export interface Store {
  users: Map<string, User>
  carts: Map<string, Cart>
  payments: Map<string, Payment>
  sessions: Map<string, Session>
  orders: Map<string, Order>
  resetTokens: Map<string, ResetToken>
  now: () => number
}

const SESSION_TTL_MS = 60 * 60 * 1000
const RESET_TTL_MS = 15 * 60 * 1000

export const store: Store = {
  users: new Map(),
  carts: new Map(),
  payments: new Map(),
  sessions: new Map(),
  orders: new Map(),
  resetTokens: new Map(),
  now: () => Date.now(),
}

export function resetState(): void {
  store.users.clear()
  store.carts.clear()
  store.payments.clear()
  store.sessions.clear()
  store.orders.clear()
  store.resetTokens.clear()
  store.now = () => Date.now()
}

export function createUser(input: { email: string; name: string; password: string }): User {
  const id = randomUUID()
  const user = { id, email: input.email, name: input.name }
  store.users.set(id, user)
  return user
}

export function getUserById(id: string): User | null {
  return store.users.get(id) ?? null
}

export function getPayment(paymentId: string): Payment | null {
  return store.payments.get(paymentId) ?? null
}

export function getCart(cartId: string): Cart | null {
  return store.carts.get(cartId) ?? null
}

export function getOrder(orderId: string): Order | null {
  return store.orders.get(orderId) ?? null
}

export function getCartTotal(cartId: string): number {
  const cart = getCart(cartId)
  if (!cart) return 0
  let total = 0
  for (const item of cart.items.values()) total += item.quantity * 100
  return total
}

export function setSessionsNow(fn: () => number): void {
  store.now = fn
}

export function setUsersNow(fn: () => number): void {
  store.now = fn
}

export function isCartEmpty(cartId: string): boolean {
  return (getCart(cartId)?.items.size ?? 0) === 0
}

export function clearCart(cartId: string): void {
  const cart = getCart(cartId)
  if (cart) cart.items.clear()
}

export { createPayment, getPaymentOrThrow, refund } from './payments'
export { createCart, addItem, addItemAsNewLine, removeItem, getCartItems } from './cart'
export { createSession, refreshSession, getSession, authenticate } from './sessions'
export { createOrder, shipOrder } from './orders'
export { requestPasswordReset, resetPassword } from './users'