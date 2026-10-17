import { demoHeaders } from "./demo";

// Server-side only: headers the Next.js proxy routes attach when calling the
// HUBRIS API. HUBRIS_API_KEY is a server secret — it is deliberately NOT a
// NEXT_PUBLIC variable and must never reach the browser. Unset (local
// development) adds nothing, matching an API that has no key configured.
// In public demo mode the visitor's demo session is attached as well, so the
// API holds the call to the demo policy (see lib/demo.ts).
export function apiAuthHeaders(request?: Request): Record<string, string> {
  const key = process.env.HUBRIS_API_KEY;
  return { ...(key ? { "x-hubris-api-key": key } : {}), ...demoHeaders(request) };
}
