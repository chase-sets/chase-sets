import { describe, expect, it } from "vitest";
import { policy, validateTcgplayerHostCredentialPolicy } from "./tcgplayer-host-credential-guard.mjs";

const root = process.cwd();

function scan(entries) {
  return validateTcgplayerHostCredentialPolicy({
    repoRoot: root,
    files: Object.keys(entries),
    contents: entries,
  });
}

describe("TCGplayer host and credential boundary", () => {
  it("passes the post-A tracked baseline and repeats with the same digest", async () => {
    const { scanTcgplayerHostCredentialPolicy } = await import("./tcgplayer-host-credential-guard.mjs");
    const first = await scanTcgplayerHostCredentialPolicy({ repoRoot: root });
    const second = await scanTcgplayerHostCredentialPolicy({ repoRoot: root });
    expect(first.violations).toEqual([]);
    expect(second).toEqual(first);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails an unexcepted credential token mutant without exposing a value", () => {
    const result = scan({ "bounded-contexts/example/runtime.ts": "const value = TCGAuthTicket=planted-secret;" });
    expect(result.violations).toEqual(["bounded-contexts/example/runtime.ts:1 credential token TCGAuthTicket"]);
    expect(result.violations.join("\n")).not.toContain("planted-secret");
  });

  it("fails every banned token spelling outside its exact path exception", () => {
    for (const token of policy.credentialTokens) {
      const file =
        token === "chrome.cookies"
          ? "deployables/tcgplayer-connector-extension/src/host.ts"
          : "bounded-contexts/example/runtime.ts";
      const result = scan({ [file]: `const value = ${token};` });
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toContain(`credential token ${token}`);
    }
  });

  it("fails a non-test runtime host and accepts only the explicit symbol exception", () => {
    const denied = scan({ "bounded-contexts/example/runtime.ts": 'const url = "https://api.tcgplayer.com";' });
    expect(denied.violations).toEqual(["bounded-contexts/example/runtime.ts:1 TCGplayer host"]);
    const allowed = scan({
      "bounded-contexts/catalog/features/source-observations/api/providers/tcgplayer/adapter.ts":
        'const sourceUrl: "https://api.tcgplayer.com";',
    });
    expect(allowed.violations).toEqual([]);
  });

  it("does not scan tests, fixtures, extension packages, or docs as server runtime", () => {
    const result = scan({
      "bounded-contexts/example/tests/host.test.ts": 'const url = "https://api.tcgplayer.com";',
      "bounded-contexts/example/fixtures/host.ts": 'const url = "https://api.tcgplayer.com";',
      "deployables/tcgplayer-connector-extension/src/host.ts": 'const url = "https://api.tcgplayer.com";',
      "bounded-contexts/example/docs/host.ts": 'const url = "https://api.tcgplayer.com";',
    });
    expect(result.violations).toEqual([]);
  });

  it("does not grant generated-artifact or unlisted extension-directory bypasses", () => {
    const result = scan({
      "artifacts/generated/platform.js": "const value = TCGAuthTicket;",
      "bounded-contexts/channels/features/connector-client/integrations/other/worker.js":
        'const url = "https://api.tcgplayer.com";',
    });
    expect(result.violations).toEqual([
      "artifacts/generated/platform.js:1 credential token TCGAuthTicket",
      "bounded-contexts/channels/features/connector-client/integrations/other/worker.js:1 TCGplayer host",
    ]);
  });

  it("requires exact path and symbol policy entries, never wildcard exceptions", () => {
    expect(Object.keys(policy.credentialExceptions).some((path) => /[*?\[\]]/.test(path))).toBe(false);
    expect(Object.keys(policy.hostExceptions).some((path) => /[*?\[\]]/.test(path))).toBe(false);
    expect(policy.excludedHostPrefixes.every((prefix) => prefix.endsWith("/"))).toBe(true);
    expect(
      policy.hostExceptions["bounded-contexts/catalog/features/source-observations/api/providers/tcgplayer/adapter.ts"],
    ).toEqual(["sourceUrl"]);
  });
});
