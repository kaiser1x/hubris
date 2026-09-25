import { describe, it, expect } from "vitest";
import {
  buildRepoCheckoutCommand,
  isSafeGitRef,
  toSafeCloneUrl as toSafeSandboxCloneUrl,
} from "../src/repo";

describe("toSafeSandboxCloneUrl", () => {
  it("normalizes owner/repo URLs", () => {
    expect(toSafeSandboxCloneUrl("https://github.com/kaiser1x/ts-js-dummy")).toBe(
      "https://github.com/kaiser1x/ts-js-dummy.git"
    );
  });

  it.each([
    "http://github.com/kaiser1x/ts-js-dummy",
    "https://gitlab.com/kaiser1x/ts-js-dummy",
    "https://github.com/onlyowner",
    "not a url",
  ])("rejects %s", (raw) => {
    expect(toSafeSandboxCloneUrl(raw)).toBeNull();
  });
});

describe("isSafeGitRef", () => {
  it.each(["main", "v1.2.0", "feature/x", "release-2026_09"])("accepts %s", (ref) => {
    expect(isSafeGitRef(ref)).toBe(true);
  });

  it.each([
    "",
    "-evil",
    "/abs",
    ".hidden",
    "a..b",
    "trailing/",
    "x.lock",
    "bad;rm -rf",
    "with space",
    "$(whoami)",
    "a".repeat(101),
  ])("rejects %s", (ref) => {
    expect(isSafeGitRef(ref)).toBe(false);
  });
});

describe("buildRepoCheckoutCommand", () => {
  it("wraps the script with a shallow clone and cd", () => {
    const cmd = buildRepoCheckoutCommand(
      "https://github.com/kaiser1x/ts-js-dummy",
      "node --version"
    );
    expect(cmd).toBe(
      "set -e; rm -rf '/tmp/hubris-repo'; " +
        "git clone --depth 1 'https://github.com/kaiser1x/ts-js-dummy.git' '/tmp/hubris-repo'; " +
        "cd '/tmp/hubris-repo'; node --version"
    );
  });

  it("adds --branch for a ref", () => {
    const cmd = buildRepoCheckoutCommand(
      "https://github.com/kaiser1x/ts-js-dummy.git",
      "pnpm test",
      "main"
    );
    expect(cmd).toContain("--branch 'main'");
    expect(cmd.endsWith("pnpm test")).toBe(true);
  });

  it("quote-escapes hostile URLs instead of breaking out", () => {
    // toSafeCloneUrl allow-list rejects these; the throw is the contract.
    expect(() =>
      buildRepoCheckoutCommand("https://evil.example.com/x/y", "echo hi")
    ).toThrow("Only public");
    expect(() =>
      buildRepoCheckoutCommand(
        "https://github.com/kaiser1x/ts-js-dummy",
        "echo hi",
        "bad;rm"
      )
    ).toThrow("Unsafe git ref");
  });
});
