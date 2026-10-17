import { NextResponse } from "next/server";
import { apiAuthHeaders } from "../../../lib/api-auth";

const HUBRIS_API_BASE =
  process.env.HUBRIS_API_BASE || "http://localhost:3001";

// A Forge run (model draft + sandbox install/verify) can take minutes. The
// platform kills this function at maxDuration with a bare non-JSON 504, so we
// stop waiting on the API a little earlier and answer with an explicit timeout
// instead. 300s is the Vercel Hobby maximum; the API's own budget
// (HUBRIS_FUNCTION_MAX_DURATION_S) must be set below UPSTREAM_TIMEOUT_MS so it
// normally answers first.
export const maxDuration = 300;
// Not exported: Next.js only accepts route-segment config names here.
const UPSTREAM_TIMEOUT_MS = (maxDuration - 10) * 1000;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const response = await fetch(`${HUBRIS_API_BASE}/api/forge-structured`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "HUBRIS/0.1.0",
        ...apiAuthHeaders(request),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    // Read as text first: an upstream error page is not JSON and must be
    // forwarded with its status, never misreported as "Failed to connect".
    const text = await response.text();
    let data: unknown;
    try {
      data = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      data = { error: `Analysis service error (HTTP ${response.status})`, details: text.slice(0, 200) };
    }
    return NextResponse.json(data, { status: response.status });
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return NextResponse.json(
        {
          error: `Forge did not finish within ${UPSTREAM_TIMEOUT_MS / 1000}s. The run may still complete on the server — reload this page to check before retrying.`,
          code: "UPSTREAM_TIMEOUT",
        },
        { status: 504 }
      );
    }
    console.error("Proxy error:", error);
    return NextResponse.json(
      {
        error: "Failed to connect to analysis service",
        hint: `Is the API running at ${HUBRIS_API_BASE}?`,
      },
      { status: 502 }
    );
  }
}
