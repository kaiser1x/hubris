import type { User } from "./users.js";

export function sendNotification(user: User, message: string): string {
  const line = `[notify] ${user.email}: ${message}`;
  console.log(line);
  return line;
}
