import { NextResponse } from "next/server";

const HUBRIS_API_BASE =
  process.env.HUBRIS_API_BASE || "http://localhost:3001";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repo = searchParams.get("repo");

  if (!repo) {
    return NextResponse.json(
      { error: "repo parameter is required (format: owner/repo)" },
      { status: 400 }
    );
  }

  try {
    const response = await fetch(
      `${HUBRIS_API_BASE}/api/analyze?repo=${encodeURIComponent(repo)}`,
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

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const response = await fetch(`${HUBRIS_API_BASE}/api/analyze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "HUBRIS/0.1.0",
      },
      body: JSON.stringify(body),
    });
    const data = await response.json();
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
