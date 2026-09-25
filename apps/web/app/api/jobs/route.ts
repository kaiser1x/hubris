import { NextResponse } from "next/server";

const HUBRIS_API_BASE =
  process.env.HUBRIS_API_BASE || "http://localhost:3001";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const forward = new URLSearchParams();
  for (const key of ["limit", "repoUrl"]) {
    const value = searchParams.get(key);
    if (value) forward.set(key, value);
  }

  try {
    const response = await fetch(
      `${HUBRIS_API_BASE}/api/jobs${forward.size ? `?${forward}` : ""}`,
      {
        headers: {
          "User-Agent": "HUBRIS/0.1.0",
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json(
        { error: `API error: ${response.status}`, details: errorText },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
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
