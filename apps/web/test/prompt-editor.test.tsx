import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import PromptEditor, {
  isPromptSubmitShortcut,
  PROMPT_EDITOR_MAX_HEIGHT,
  PROMPT_EDITOR_MIN_HEIGHT,
} from "../app/components/PromptEditor";

describe("PromptEditor", () => {
  it("renders wrapped multiline prose with an accessible label and count", () => {
    const text = "Customers can be charged more than once\nwhen they retry.";
    const html = renderToStaticMarkup(
      <PromptEditor
        id="prompt"
        label="Describe what seems wrong"
        value={text}
        onChange={vi.fn()}
        placeholder="Describe the issue"
        maxLength={500}
      />
    );

    expect(html).toContain("<textarea");
    expect(html).toContain("aria-label=\"Describe what seems wrong\"");
    expect(html).toContain(`${text.length} / 500`);
    expect(html).toContain("Clear describe what seems wrong");
    expect(PROMPT_EDITOR_MIN_HEIGHT).toBeGreaterThanOrEqual(120);
    expect(PROMPT_EDITOR_MAX_HEIGHT).toBeGreaterThan(PROMPT_EDITOR_MIN_HEIGHT);
  });

  it("does not render a clear action for empty text", () => {
    const html = renderToStaticMarkup(
      <PromptEditor
        id="prompt"
        label="Repair description"
        value=""
        onChange={vi.fn()}
        placeholder="Describe the repair"
        maxLength={500}
      />
    );
    expect(html).not.toContain("Clear repair description");
    expect(html).toContain("0 / 500");
  });

  it("uses only modifier-plus-Enter for submit, preserving ordinary Enter", () => {
    expect(isPromptSubmitShortcut({ key: "Enter", ctrlKey: true })).toBe(true);
    expect(isPromptSubmitShortcut({ key: "Enter", metaKey: true })).toBe(true);
    expect(isPromptSubmitShortcut({ key: "Enter" })).toBe(false);
    expect(isPromptSubmitShortcut({ key: "a", ctrlKey: true })).toBe(false);
  });
});
