import { pgTable, uuid, text, jsonb, timestamp } from "drizzle-orm/pg-core";

export type JobStatus = "pending" | "complete" | "failed";

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey(),
  repoUrl: text("repo_url").notNull(),
  status: text("status").notNull().$type<JobStatus>().default("pending"),
  result: jsonb("result"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
