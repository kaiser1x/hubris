import { randomUUID } from "node:crypto";
import { auditLog } from "./audit.js";
import { sendNotification } from "./notifications.js";
import { getUser } from "./users.js";
import { formatMoney, isPositive } from "./utils.js";

export interface Payment {
  id: string;
  userId: string;
  amountCents: number;
  status: "completed";
}

const LEDGER: Payment[] = [];
const seenIdempotencyKeys = new Set<string>();

export function validatePayment(amountCents: number): void {
  if (!isPositive(amountCents)) {
    throw new Error(`invalid amount: ${amountCents}`);
  }
}

export function savePayment(userId: string, amountCents: number): Payment {
  const payment: Payment = {
    id: randomUUID(),
    userId,
    amountCents,
    status: "completed",
  };
  LEDGER.push(payment);
  return payment;
}

export function ledger(): Payment[] {
  return LEDGER;
}

// Controlled bug fixture (hubris/buggy-idempotency): the idempotency guard
// was dropped — keys are recorded but never checked, so duplicate requests
// create a second payment.
export function createPayment(
  userId: string,
  amountCents: number,
  idempotencyKey?: string
): { payment: Payment; notice: string } {
  const user = getUser(userId);
  validatePayment(amountCents);
  if (idempotencyKey !== undefined) {
    seenIdempotencyKeys.add(idempotencyKey);
  }
  const payment = savePayment(user.id, amountCents);
  const notice = sendNotification(user, `charged ${formatMoney(amountCents)}`);
  auditLog("payment.created", payment.id);
  return { payment, notice };
}
