import { NextResponse } from "next/server";
import { DEMO_COOKIE, isDemoMode } from "../../../lib/demo";

// GET /api/demo — whether this deployment runs the public demo (no secrets).
export async function GET() {
  return NextResponse.json({ demo: isDemoMode() });
}

// POST /api/demo — start again: a fresh demo session. Earlier jobs stay owned
// by the old session and are no longer listed for this browser.
export async function POST() {
  if (!isDemoMode()) {
    return NextResponse.json({ error: "Not running in demo mode." }, { status: 404 });
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(DEMO_COOKIE, crypto.randomUUID(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24,
  });
  return response;
}
