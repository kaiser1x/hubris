import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

let client: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (!process.env.DATABASE_URL) return null;
  if (!client) {
    client = drizzle(postgres(process.env.DATABASE_URL), { schema });
  }
  return client;
}

export { schema };
