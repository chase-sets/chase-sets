import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import contract from "../../../tests/worker-graph.contract.json";

const eventType = "identity.account-profile.report-submitted";
const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const sourceRoots = ["bounded-contexts", "contracts", "infrastructure", "deployables"];
// Installed and generated output is not source: it can neither produce nor consume events.
const ignoredDirectories = new Set(["node_modules", "build", "dist", "coverage"]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (ignoredDirectories.has(entry.name) || entry.name.startsWith(".")) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx|mts|mjs|js|json)$/.test(entry.name) && !/\.test\.(?:ts|tsx|mjs)$/.test(entry.name)
      ? [path]
      : [];
  });
}

describe("account-profile-report-no-producer", () => {
  it("names the Account Profile Report only in its contract, its one consumer and the declared graph", () => {
    const mentions = sourceRoots
      .flatMap((root) => sourceFiles(join(repoRoot, root)))
      .filter((path) => readFileSync(path, "utf8").includes(eventType))
      .map((path) => relative(repoRoot, path).split(sep).join("/"))
      .sort();
    expect(mentions).toEqual([
      "bounded-contexts/platform-operations/context.json",
      "bounded-contexts/platform-operations/features/reported-content/read-model/projection.ts",
      "bounded-contexts/platform-operations/tests/worker-graph.contract.json",
      "contracts/event-core/public-event-payloads/identity.ts",
    ]);
  });

  it("has no append site: the contract module only declares and parses it", () => {
    const contractSource = readFileSync(
      join(repoRoot, "contracts/event-core/public-event-payloads/identity.ts"),
      "utf8",
    );
    const projectionSource = readFileSync(
      join(repoRoot, "bounded-contexts/platform-operations/features/reported-content/read-model/projection.ts"),
      "utf8",
    );
    for (const source of [contractSource, projectionSource]) {
      expect(source).not.toMatch(
        /appendToStream|eventType:\s*"identity\.account-profile|type:\s*"identity\.account-profile/,
      );
    }
  });

  it("has exactly one consumer in the worker-graph contract", () => {
    const consumers = [...contract.runners, ...contract.subscriptions]
      .filter((member) => Array.isArray(member.eventTypes) && member.eventTypes.includes(eventType))
      .map((member) => `${member.projectionName}:${member.sourceContextName}:v${member.subscriptionVersion}`);
    expect(new Set(consumers)).toEqual(new Set(["reported-content-queue-projection:identity:v1"]));
  });
});
