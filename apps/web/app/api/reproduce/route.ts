import { NextResponse } from "next/server";
import { apiAuthHeaders } from "../../../lib/api-auth";

const HUBRIS_API_BASE =
  process.env.HUBRIS_API_BASE || "http://localhost:3001";

// Sandbox/model work can run for minutes. Stop waiting before the platform
// kills this function (a bare non-JSON 504) and answer explicitly instead.
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
    const response = await fetch(`${HUBRIS_API_BASE}/api/reproduce`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "HUBRIS/0.1.0",
        ...apiAuthHeaders(request),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    // Read as text first: an upstream error page is not JSON and must keep
    // its status, never be misreported as "Failed to connect".
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
          error: `The reproduction did not finish within ${UPSTREAM_TIMEOUT_MS / 1000}s. It may still complete on the server — reload to check before retrying.`,
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
