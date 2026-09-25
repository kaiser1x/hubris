import express, { Request, Response } from "express";

const app = express();

app.get("/api/transactions", (req: Request, res: Response) => {
  res.json({ status: "ok" });
});

app.post("/api/transactions", (req: Request, res: Response) => {
  res.json({ status: "created" });
});

export function calculateTotal(items: number[]): number {
  return items.reduce((sum, item) => sum + item, 0);
}

export class TransactionService {
  private transactions: any[] = [];

  addTransaction(tx: any) {
    this.transactions.push(tx);
  }

  getTransactions() {
    return this.transactions;
  }
}

export function processTransaction(tx: any) {
  const service = new TransactionService();
  service.addTransaction(tx);
  return calculateTotal([1, 2, 3]);
}
