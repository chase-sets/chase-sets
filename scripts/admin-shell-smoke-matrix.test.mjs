import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADMIN_PARTIAL_ACTORS,
  ADMIN_SHELL_SECTIONS,
  ADMIN_SHELL_SMOKE_MATRIX,
  ADMIN_TOPOLOGY_MODES,
  ADMIN_WEB_API_DEPENDENCIES,
} from "./admin-shell-smoke-matrix.mjs";

const runbook = readFileSync(resolve("docs/runbooks/admin-shell-smoke-matrix.md"), "utf8");
const docsIndex = readFileSync(resolve("docs/README.md"), "utf8");

function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) {
    if (seen.has(value)) {
      repeated.add(value);
    }
    seen.add(value);
  }
  return [...repeated].sort();
}

describe("admin shell smoke matrix", () => {
  it("keeps stable coverage ids unique and documented", () => {
    const coverageIds = ADMIN_SHELL_SMOKE_MATRIX.map((row) => row.id);
    expect(duplicates(coverageIds)).toEqual([]);

    const undocumentedIds = coverageIds.filter((id) => !runbook.includes(id));
    expect(undocumentedIds).toEqual([]);

    expect(docsIndex).toContain("[Admin Shell Smoke Matrix](./runbooks/admin-shell-smoke-matrix.md)");
    expect(runbook).toContain("#1023");
    expect(runbook).toContain("#1025");
    expect(runbook).toContain("PR #1028");
  });

  it("covers every admin section and partial actor required by milestone 13", () => {
    const sectionRows = ADMIN_SHELL_SMOKE_MATRIX.filter((row) => row.kind === "section-shell");
    expect(sectionRows.map((row) => row.section).sort()).toEqual([...ADMIN_SHELL_SECTIONS].sort());

    const actorRows = ADMIN_SHELL_SMOKE_MATRIX.filter((row) => row.kind === "partial-actor");
    expect(actorRows.map((row) => row.id).sort()).toEqual(ADMIN_PARTIAL_ACTORS.map((actor) => actor.id).sort());

    for (const actor of ADMIN_PARTIAL_ACTORS) {
      expect(runbook).toContain(actor.id);
      expect(runbook).toContain(actor.permission);
      for (const path of actor.expectedEntryPaths) {
        expect(runbook).toContain(path);
      }
    }
  });

  it("ties every API dependency to topology modes and a smoke coverage row", () => {
    const smokeCoverageIds = new Set(ADMIN_SHELL_SMOKE_MATRIX.map((row) => row.id));

    const missingSmokeRows = ADMIN_WEB_API_DEPENDENCIES.filter(
      (dependency) => !smokeCoverageIds.has(dependency.smokeCoverageId),
    ).map((dependency) => dependency.id);
    expect(missingSmokeRows).toEqual([]);

    const undocumentedApiIds = ADMIN_WEB_API_DEPENDENCIES.flatMap((dependency) =>
      [dependency.id, dependency.smokeCoverageId, dependency.apiPath].filter((value) => !runbook.includes(value)),
    );
    expect(undocumentedApiIds).toEqual([]);

    const missingTopologyModes = ADMIN_WEB_API_DEPENDENCIES.filter((dependency) =>
      ADMIN_TOPOLOGY_MODES.some((mode) => !dependency.topologyExpectations?.[mode]),
    ).map((dependency) => dependency.id);
    expect(missingTopologyModes).toEqual([]);
  });

  it("keeps the matrix explicit about link, download, SSE, and durable-job evidence", () => {
    expect(ADMIN_SHELL_SMOKE_MATRIX.map((row) => row.kind)).toEqual(
      expect.arrayContaining(["content-managed-link", "cross-section-link", "api-topology"]),
    );
    expect(ADMIN_WEB_API_DEPENDENCIES.map((dependency) => dependency.callerType)).toEqual(
      expect.arrayContaining(["direct-download", "event-source", "durable-job-event-source"]),
    );

    for (const requiredTerm of [
      "direct-download",
      "EventSource",
      "durable-job",
      "controlled-unavailable",
      "explicit deferral",
    ]) {
      expect(runbook).toContain(requiredTerm);
    }
  });
});
