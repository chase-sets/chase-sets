import { readdirSync, readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const oauthPath = "bounded-contexts/auth/support/ucp-support/oauth.ts";
const ownerPath = "bounded-contexts/identity/features/agent-grants/api/revocation.ts";
const allowed = new Set([
  oauthPath,
  ownerPath,
  "bounded-contexts/auth/features/agent-grants/api/revocation.ts",
  "deployables/platform-worker/src/agent-webhook-runners.ts",
]);
function callers(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return callers(path);
    return /\.(ts|tsx|mjs|cjs|js)$/.test(entry.name) &&
      !/\.(test|spec)\./.test(entry.name) &&
      !path.includes("__tests__")
      ? [path]
      : [];
  });
}
function assertPartition(sources: ReadonlyMap<string, string>) {
  const unclassified = [...sources]
    .filter(
      ([path, source]) =>
        /resumeAgentGrantRevocation\(|effects\.(cleanup|advance)\(|UPDATE identity_linked_platform_authorizations[\s\S]{0,150}SET status = 'revoked'|\.revoke(Token|Authorization)\(/.test(
          source,
        ) && !allowed.has(path),
    )
    .map(([path]) => path);
  expect(unclassified).toEqual([]);
  expect(sources.get(oauthPath)?.match(/await resumeAgentGrantRevocation\(/g)).toHaveLength(2);
  expect(sources.get("deployables/platform-api/src/app.ts")).toContain(
    "agentGrantRevocations: identityServices.identity.agentGrantRevocations",
  );
  expect(sources.get("bounded-contexts/identity/support/ucp-support/linked-platform-authorizations.ts")).not.toContain(
    "Promise<boolean>",
  );
  expect(
    [...sources]
      .filter(([, source]) => /\.revokeSavedCheckoutInstrumentsForAgentGrant\s*\(/.test(source))
      .map(([path]) => path),
  ).toEqual([]);
}

describe("agent-grant-revocation-caller-partition", () => {
  const sources = new Map(
    ["bounded-contexts", "deployables", "infrastructure", "contracts", "packages", "scripts"]
      .flatMap((path) => callers(resolve(root, path)))
      .map((path) => [relative(root, path).replaceAll("\\", "/"), readFileSync(path, "utf8")]),
  );
  it("classifies token, Account, coordinator, owner and recovery; CLI/seed/bootstrap/reconciliation revoke writers are zero", () =>
    assertPartition(sources));
  it("rejects an unclassified sibling rather than accepting a one-route census", () => {
    const sibling = new Map(sources).set(
      "bounded-contexts/auth/features/unclassified.ts",
      "await resumeAgentGrantRevocation(effects, state, context)",
    );
    expect(() => assertPartition(sibling)).toThrow();
  });
  it("rejects omitted token caller and omitted production composition with all other inputs fixed", () => {
    const omittedToken = new Map(sources).set(
      oauthPath,
      sources.get(oauthPath)!.replace("await resumeAgentGrantRevocation(", "await omittedTokenRevokeCaller("),
    );
    expect(() => assertPartition(omittedToken)).toThrow();
    const omittedComposition = new Map(sources).set("deployables/platform-api/src/app.ts", "no owner binding");
    expect(() => assertPartition(omittedComposition)).toThrow();
  });
});
