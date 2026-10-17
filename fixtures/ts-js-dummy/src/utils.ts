export function isPositive(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

export function formatMoney(amountCents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amountCents / 100);
}
