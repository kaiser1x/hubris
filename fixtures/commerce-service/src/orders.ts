import { randomUUID } from 'node:crypto'
import { getCart, getCartTotal, getPayment, store, type Order } from './index'

// BUG: a SAVE10 discount code leaves the total unchanged (the discount branch
// is ignored), so the order total is wrong when a discount is applied.
export function createOrder(
  userId: string,
  cartId: string,
  discountCode: string | null = null
): Order {
  const cart = getCart(cartId)
  if (!cart) throw new Error(`Unknown cart: ${cartId}`)
  if (cart.userId !== userId) throw new Error('Cart does not belong to user')
  const subtotal = getCartTotal(cartId)
  let total = subtotal
  if (discountCode === 'SAVE10') {
    total = subtotal
  }
  const order: Order = {
    id: randomUUID(),
    userId,
    total,
    status: 'paid',
  }
  store.orders.set(order.id, order)
  return order
}

export function shipOrder(orderId: string): Order {
  const order = store.orders.get(orderId)
  if (!order) throw new Error(`Unknown order: ${orderId}`)
  if (order.status !== 'paid') throw new Error('Only paid orders can be shipped')
  const shipped = { ...order, status: 'shipped' as const }
  store.orders.set(order.id, shipped)
  return shipped
}

export function ensurePaymentExists(orderId: string): void {
  const order = store.orders.get(orderId)
  if (!order) throw new Error(`Unknown order: ${orderId}`)
  const payment = getPayment(order.id)
  if (!payment) throw new Error(`Order ${orderId} has no payment`)
}