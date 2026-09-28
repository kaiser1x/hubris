import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import SettingsPage from "../app/(workspace)/settings/page";
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  readAppearance,
  writeAppearance,
} from "../app/lib/settings";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } as unknown as Storage;
}

describe("Settings page", () => {
  it("renders the real settings groups and enforced boundaries", () => {
    const html = renderToStaticMarkup(<SettingsPage />);
    expect(html).toContain("Settings");
    expect(html).toContain("Workspace");
    expect(html).toContain("Forge");
    expect(html).toContain("Verification");
    expect(html).toContain("Sandbox");
    expect(html).toContain("Analysis");
    expect(html).toContain("Appearance");
    expect(html).toContain("Integrations");
    expect(html).toContain("Secrets passed to sandbox");
  });

  it("persists only appearance preferences locally", () => {
    const store = storage();
    expect(readAppearance(store)).toEqual(DEFAULT_APPEARANCE);
    writeAppearance(store, { theme: "dark", density: "compact", motion: "reduced" });
    expect(store.getItem(APPEARANCE_STORAGE_KEY)).toContain("dark");
    expect(readAppearance(store)).toEqual({ theme: "dark", density: "compact", motion: "reduced" });
  });
});
