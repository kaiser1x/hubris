import { beforeEach, describe, expect, it } from 'vitest'
import {
  addItem,
  createCart,
  createOrder,
  createUser,
  getOrder,
  resetState,
  shipOrder,
} from '../src/index'

beforeEach(() => {
  resetState()
})

describe('orders', () => {
  it('creates an order from a cart', () => {
    const user = createUser({ email: 'bob@example.com', name: 'Bob', password: 'x' })
    const cart = createCart(user.id)
    addItem(cart.id, 'prod-latte', 2)
    const order = createOrder(user.id, cart.id)
    expect(order.status).toBe('paid')
    expect(getOrder(order.id)?.id).toBe(order.id)
  })

  it('applies a discount code to the order total', () => {
    const user = createUser({ email: 'bob@example.com', name: 'Bob', password: 'x' })
    const cart = createCart(user.id)
    addItem(cart.id, 'prod-latte', 2)
    const order = createOrder(user.id, cart.id, 'SAVE10')
    expect(order.total).toBe(180)
  })

  it('rejects orders from empty carts', () => {
    const user = createUser({ email: 'bob@example.com', name: 'Bob', password: 'x' })
    const cart = createCart(user.id)
    expect(() => createOrder(user.id, cart.id)).toThrow(/empty cart/)
  })

  it('ships a paid order exactly once', () => {
    const user = createUser({ email: 'bob@example.com', name: 'Bob', password: 'x' })
    const cart = createCart(user.id)
    addItem(cart.id, 'prod-latte', 1)
    const order = createOrder(user.id, cart.id)
    expect(shipOrder(order.id).status).toBe('shipped')
    expect(() => shipOrder(order.id)).toThrow(/Only paid orders/)
  })

  it('charges the full price without a discount', () => {
    const user = createUser({ email: 'bob@example.com', name: 'Bob', password: 'x' })
    const cart = createCart(user.id)
    addItem(cart.id, 'prod-latte', 2)
    const order = createOrder(user.id, cart.id)
    expect(order.total).toBe(200)
  })
})