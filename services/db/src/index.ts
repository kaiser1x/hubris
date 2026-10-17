import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

let sql: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (!process.env.DATABASE_URL) return null;
  if (!client) {
    // Serverless instances multiply: let deployments cap the per-instance pool
    // (HUBRIS_DB_POOL_MAX) and point DATABASE_URL at a pooled endpoint.
    const max = Number(process.env.HUBRIS_DB_POOL_MAX);
    sql = postgres(process.env.DATABASE_URL, Number.isInteger(max) && max > 0 ? { max } : {});
    client = drizzle(sql, { schema });
  }
  return client;
}

// Release the pool so short-lived processes (diagnostics, scripts) exit
// cleanly instead of lingering on open sockets. Production servers never
// call this; they own their pool for life.
export async function closeDb(): Promise<void> {
  const s = sql;
  sql = null;
  client = null;
  if (s) await s.end();
}

export { schema };
