import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { serializeCookie } from "./cookies";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("serializeCookie", () => {
  it("writes the exact first-party Set-Cookie value", () => {
    const https = new Request("https://marketplace.example.test/");
    const http = new Request("http://localhost/");

    expect(serializeCookie("chase_sets_example", "a b;c", { maxAgeSeconds: 60, request: https })).toBe(
      "chase_sets_example=a%20b%3Bc; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure",
    );
    expect(serializeCookie("chase_sets_example", "a b;c", { maxAgeSeconds: 60, request: http })).toBe(
      "chase_sets_example=a%20b%3Bc; Path=/; HttpOnly; SameSite=Lax; Max-Age=60",
    );
    expect(serializeCookie("chase_sets_example", "", { maxAgeSeconds: 0 })).toBe(
      "chase_sets_example=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
    );
    expect(serializeCookie("chase_sets_example", "value", { request: https })).toBe(
      "chase_sets_example=value; Path=/; HttpOnly; SameSite=Lax; Secure",
    );
    expect(serializeCookie("chase_sets_example", "value")).toBe(
      "chase_sets_example=value; Path=/; HttpOnly; SameSite=Lax",
    );
  });

  it("is the only serializeCookie definition", () => {
    const result = spawnSync(
      "git",
      ["grep", "--no-color", "-E", "function serializeCookie\\b", "--", "bounded-contexts", "contracts", ":!*.test.*"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.split("\n").filter(Boolean)).toEqual([
      "contracts/http/cookies.ts:export function serializeCookie(name: string, value: string, options: CookieOptions = {}) {",
    ]);
  });
});
