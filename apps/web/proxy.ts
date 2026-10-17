import { NextResponse, type NextRequest } from "next/server";
import { DEMO_COOKIE, isDemoMode, isDemoSessionId } from "./lib/demo";

// Public demo: give every visitor a private demo session (httpOnly cookie)
// before any API route runs, so the API can scope their jobs to it. The id is
// also injected into THIS request, so the very first call is already scoped.
export function proxy(request: NextRequest) {
  if (!isDemoMode()) return NextResponse.next();
  if (isDemoSessionId(request.cookies.get(DEMO_COOKIE)?.value)) return NextResponse.next();

  const session = crypto.randomUUID();
  request.cookies.set(DEMO_COOKIE, session);
  const response = NextResponse.next({ request: { headers: request.headers } });
  response.cookies.set(DEMO_COOKIE, session, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24,
  });
  return response;
}

export const config = {
  matcher: ["/api/:path*"],
};
