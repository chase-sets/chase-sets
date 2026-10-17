import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repositoryRoot } from "./stripe-appearance-support";

const root = repositoryRoot();
const base = "be97a105ae14a39571d5231c52b3883dcaeffb92";
const names = ["stripe-appearance-acceptance-receipt.schema.json", "stripe-connect-discovery.schema.json"];
const read = (path: string) => readFileSync(join(root, path), "utf8");

function identityFailures(schema: Record<string, unknown>, name: string) {
  const id = name.startsWith("stripe-connect")
    ? "stripe-connect-discovery/v1"
    : "stripe-appearance-acceptance-receipt/v1";
  const problems: string[] = [];
  if (schema.$id !== `https://chase-sets.com/schemas/${id}.json`) problems.push("identity");
  const defs = schema.$defs as Record<string, Record<string, unknown>> | undefined;
  const version = (defs?.schemaVersion ?? (schema.properties as Record<string, unknown> | undefined)?.schemaVersion) as
    | Record<string, unknown>
    | undefined;
  if (version?.const !== id) problems.push("version");
  if (
    !defs ||
    !(
      schema.additionalProperties === false || Object.values(defs).some((entry) => entry.additionalProperties === false)
    )
  )
    problems.push("closure");
  return problems;
}

function safetyFailures(schema: Record<string, unknown>) {
  const defs = schema.$defs as Record<string, Record<string, unknown>>;
  const problems: string[] = [];
  if (
    Object.values(defs).some((definition) => definition.type === "object" && definition.additionalProperties !== false)
  )
    problems.push("nested unknown");
  const timestamp = new RegExp(defs.timestamp.pattern as string);
  if (timestamp.test("2026-09-26") || !timestamp.test("2026-09-26T15:00:00Z")) problems.push("date only");
  const retention = defs.retentionScan.properties as Record<string, Record<string, number>>;
  if (retention.textualArtifacts.maximum !== 2147483647 || retention.textualArtifacts.minimum !== 1)
    problems.push("out of range");
  return problems;
}

describe("moved v1 evidence identity remains pending", () => {
  it.each(names)("preserves the exact predecessor schema bytes for %s", (name) => {
    const oldPath = `packages/design-system/src/theme/__fixtures__/${name}`;
    const old = execFileSync("git", ["show", `${base}:${oldPath}`], { cwd: root, encoding: "utf8" });
    const current = read(`infrastructure/stripe-appearance/${name}`);
    expect(current).toBe(old);
    const schema = JSON.parse(current) as Record<string, unknown>;
    expect(identityFailures(schema, name)).toEqual([]);
    expect(identityFailures({ ...schema, $id: String(schema.$id).replace("/v1", "/v2") }, name)).toContain("identity");
    expect(identityFailures({ ...schema, $id: "https://example.test/forged.json" }, name)).toContain("identity");
    expect(safetyFailures(schema)).toEqual([]);
    const defs = schema.$defs as Record<string, Record<string, unknown>>;
    expect(
      safetyFailures({
        ...schema,
        $defs: { ...defs, retentionScan: { ...defs.retentionScan, additionalProperties: true } },
      }),
    ).toContain("nested unknown");
    expect(
      safetyFailures({
        ...schema,
        $defs: { ...defs, timestamp: { ...defs.timestamp, pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" } },
      }),
    ).toContain("date only");
    const retention = defs.retentionScan.properties as Record<string, Record<string, number>>;
    expect(
      safetyFailures({
        ...schema,
        $defs: {
          ...defs,
          retentionScan: {
            ...defs.retentionScan,
            properties: {
              ...retention,
              textualArtifacts: { ...retention.textualArtifacts, maximum: Number.MAX_SAFE_INTEGER },
            },
          },
        },
      }),
    ).toContain("out of range");
  });

  it("never treats a schema-only or partial artifact as qualified", () => {
    const readme = read("infrastructure/stripe-appearance/README.md");
    expect(readme).toContain("qualification-pending");
    const receipt = JSON.parse(read(`infrastructure/stripe-appearance/${names[0]}`));
    expect(receipt.$defs.elementsReceipt.required).toContain("moments");
    expect(receipt.$defs.elementsReceipt.required).toContain("sourceDigests");
    expect(receipt.$defs.connectReceipt.required).toContain("discoveryArtifact");
    expect(receipt.$defs.timestamp.pattern).toContain("T");
    expect(receipt.$defs.connectRunSummary.properties.skipped.const).toBe(0);
    expect(receipt.$defs.connectRunSummary.properties.failed.const).toBe(0);
  });
});
