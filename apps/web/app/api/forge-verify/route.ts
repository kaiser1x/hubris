import { NextResponse } from "next/server";
import { apiAuthHeaders } from "../../../lib/api-auth";

const HUBRIS_API_BASE =
  process.env.HUBRIS_API_BASE || "http://localhost:3001";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const response = await fetch(`${HUBRIS_API_BASE}/api/forge-verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "HUBRIS/0.1.0",
        ...apiAuthHeaders(),
      },
      body: JSON.stringify(body),
    });

    // Read as text first: an upstream error page (e.g. a stale API without
    // this route) is not JSON, and must be forwarded honestly — never
    // misreported as "Failed to connect".
    const text = await response.text();
    let data: unknown;
    try {
      data = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      data = { error: "Analysis service error", details: text.slice(0, 200) };
    }
    return NextResponse.json(data, { status: response.status });
  } catch (error: unknown) {
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
