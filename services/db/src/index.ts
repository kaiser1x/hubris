import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

let sql: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (!process.env.DATABASE_URL) return null;
  if (!client) {
    sql = postgres(process.env.DATABASE_URL);
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
