import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  usePathname: () => "/history",
  useRouter: () => ({ replace: vi.fn() }),
}));

import AppShell from "../app/components/AppShell";

describe("AppShell system navigation", () => {
  it("renders History and Settings as real routes", () => {
    const html = renderToStaticMarkup(
      <AppShell>
        <div />
      </AppShell>
    );
    expect(html).toContain('href="/history"');
    expect(html).toContain("History");
    expect(html).toContain('href="/settings"');
    expect(html).toContain("Settings");
  });
});
