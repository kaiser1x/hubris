import { randomUUID } from 'node:crypto'
import { store, type Cart, type CartItem } from './index'

export function createCart(userId: string): Cart {
  const cart: Cart = { id: randomUUID(), userId, items: new Map() }
  store.carts.set(cart.id, cart)
  return cart
}

export function addItem(cartId: string, productId: string, quantity: number): void {
  const cart = store.carts.get(cartId)
  if (!cart) throw new Error(`Unknown cart: ${cartId}`)
  const existing = cart.items.get(productId)
  if (existing) {
    cart.items.set(productId, { productId, quantity: existing.quantity + quantity })
  } else {
    cart.items.set(productId, { productId, quantity })
  }
}

// Adds a separate line even when the product is already in the cart.
export function addItemAsNewLine(cartId: string, productId: string, quantity: number): void {
  const cart = store.carts.get(cartId)
  if (!cart) throw new Error(`Unknown cart: ${cartId}`)
  cart.items.set(randomUUID(), { productId, quantity })
}

export function getCartItems(cartId: string): CartItem[] {
  const cart = store.carts.get(cartId)
  if (!cart) return []
  return [...cart.items.values()]
}

// BUG: removes the FIRST matching line instead of the requested one when a
// product appears on more than one line — the intended line survives.
export function removeItem(cartId: string, productId: string): void {
  const cart = store.carts.get(cartId)
  if (!cart) throw new Error(`Unknown cart: ${cartId}`)
  for (const lineId of cart.items.keys()) {
    const item = cart.items.get(lineId)
    if (item?.productId === productId) {
      cart.items.delete(lineId)
      break
    }
  }
}