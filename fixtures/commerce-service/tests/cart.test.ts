import { beforeEach, describe, expect, it } from 'vitest'
import {
  addItem,
  addItemAsNewLine,
  clearCart,
  createCart,
  createUser,
  getCart,
  getCartItems,
  isCartEmpty,
  removeItem,
  resetState,
} from '../src/index'

beforeEach(() => {
  resetState()
})

describe('carts', () => {
  it('creates an empty cart for a user', () => {
    const user = createUser({ email: 'bob@example.com', name: 'Bob', password: 'x' })
    const cart = createCart(user.id)
    expect(getCart(cart.id)?.userId).toBe(user.id)
  })

  it('adds items and sums their quantity', () => {
    const user = createUser({ email: 'bob@example.com', name: 'Bob', password: 'x' })
    const cart = createCart(user.id)
    addItem(cart.id, 'prod-latte', 2)
    addItem(cart.id, 'prod-latte', 1)
    expect(getCartItems(cart.id)[0]?.quantity).toBe(3)
  })

  it('removes only the requested line when a product appears more than once', () => {
    const user = createUser({ email: 'bob@example.com', name: 'Bob', password: 'x' })
    const cart = createCart(user.id)
    addItem(cart.id, 'prod-latte', 1)
    addItemAsNewLine(cart.id, 'prod-latte', 2)
    removeItem(cart.id, 'prod-latte')
    const latteLines = getCartItems(cart.id).filter((item) => item.productId === 'prod-latte')
    expect(latteLines).toHaveLength(1)
    expect(latteLines[0]?.quantity).toBe(2)
  })

  it('rejects unknown products and invalid quantities', () => {
    const user = createUser({ email: 'bob@example.com', name: 'Bob', password: 'x' })
    const cart = createCart(user.id)
    expect(() => addItem(cart.id, 'prod-latte', 0)).toThrow(/positive integer/)
  })

  it('clears a cart', () => {
    const user = createUser({ email: 'bob@example.com', name: 'Bob', password: 'x' })
    const cart = createCart(user.id)
    addItem(cart.id, 'prod-latte', 2)
    clearCart(cart.id)
    expect(isCartEmpty(cart.id)).toBe(true)
  })
})