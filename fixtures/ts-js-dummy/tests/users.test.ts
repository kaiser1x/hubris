import { describe, expect, it } from "vitest";
import { findUser, getUser } from "../src/users.js";

describe("users", () => {
  it("finds a seeded user", () => {
    expect(findUser("u-1")?.name).toBe("Ada Lovelace");
  });

  it("returns undefined for unknown ids", () => {
    expect(findUser("nope")).toBeUndefined();
  });

  it("getUser throws for unknown ids", () => {
    expect(() => getUser("nope")).toThrow("unknown user: nope");
  });
});
