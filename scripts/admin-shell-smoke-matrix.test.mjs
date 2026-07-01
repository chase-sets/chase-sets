import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADMIN_PARTIAL_ACTORS,
  ADMIN_PARTIAL_ACTOR_EVIDENCE_ROWS,
  ADMIN_DEPLOYED_API_SMOKE_PROBES,
  ADMIN_DEPLOYED_PAGE_SMOKE_ROWS,
  ADMIN_FULFILLMENT_POSTAGE_SMOKE_COVERAGE_ID,
  ADMIN_SHELL_SECTIONS,
  ADMIN_SHELL_SMOKE_MATRIX,
  ADMIN_TOPOLOGY_MODES,
  ADMIN_WEB_API_DEPENDENCIES,
  selectAdminDeployedApiSmokeProbes,
  selectAdminDeployedPageSmokeRows,
} from "./admin-shell-smoke-matrix.mjs";

const runbook = readFileSync(resolve("docs/runbooks/admin-shell-smoke-matrix.md"), "utf8");
const docsIndex = readFileSync(resolve("docs/README.md"), "utf8");
const platformSmoke = readFileSync(resolve("scripts/platform-smoke.mjs"), "utf8");
const adminSectionLoaderTest = readFileSync(
  resolve("deployables/admin-web/app/admin-section-loader.server.test.ts"),
  "utf8",
);
const adminHostTest = readFileSync(resolve("deployables/admin-web/app/host.test.ts"), "utf8");

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

  it("maps partial actor rows to stable local regression evidence", () => {
    expect(ADMIN_PARTIAL_ACTOR_EVIDENCE_ROWS.map((row) => row.actorId).sort()).toEqual(
      ADMIN_PARTIAL_ACTORS.map((actor) => actor.id).sort(),
    );

    for (const row of ADMIN_PARTIAL_ACTOR_EVIDENCE_ROWS) {
      expect(runbook).toContain(row.id);
      expect(runbook).toContain(row.actorId);
      expect(runbook).toContain(row.command);

      for (const evidenceFile of row.evidenceFiles) {
        expect(runbook).toContain(evidenceFile);
      }

      expect(adminSectionLoaderTest).toContain(row.permission);
      expect(adminHostTest).toContain(row.permission);

      for (const path of row.expectedEntryPaths) {
        const source = path === "/platform" ? `${adminSectionLoaderTest}\n${adminHostTest}` : adminSectionLoaderTest;
        expect(source).toContain(path);
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

  it("documents deployed admin page smoke rows and their linked coverage ids", () => {
    const matrixCoverageIds = new Set(ADMIN_SHELL_SMOKE_MATRIX.map((row) => row.id));
    const apiCoverageIds = new Set(ADMIN_WEB_API_DEPENDENCIES.map((dependency) => dependency.smokeCoverageId));

    const undocumentedPageRows = ADMIN_DEPLOYED_PAGE_SMOKE_ROWS.flatMap((row) =>
      [row.id, row.path].filter((value) => !runbook.includes(value)),
    );
    expect(undocumentedPageRows).toEqual([]);

    const missingLinkedCoverage = ADMIN_DEPLOYED_PAGE_SMOKE_ROWS.flatMap((row) =>
      row.coverageIds.filter((coverageId) => !matrixCoverageIds.has(coverageId) && !apiCoverageIds.has(coverageId)),
    );
    expect(missingLinkedCoverage).toEqual([]);

    const missingSections = ADMIN_SHELL_SECTIONS.filter(
      (section) => !ADMIN_DEPLOYED_PAGE_SMOKE_ROWS.some((row) => row.section === section),
    );
    expect(missingSections).toEqual([]);

    for (const row of ADMIN_DEPLOYED_PAGE_SMOKE_ROWS) {
      for (const coverageId of row.coverageIds) {
        expect(runbook).toContain(coverageId);
      }
    }
  });

  it("wires the deployed page matrix into platform smoke", () => {
    expect(platformSmoke).toContain("selectAdminDeployedPageSmokeRows");
    expect(platformSmoke).toContain("expectAdminDeployedPageMatrix");
  });

  it("keeps fulfillment postage smoke rows gated by launch approval", () => {
    expect(selectAdminDeployedPageSmokeRows()).toEqual(ADMIN_DEPLOYED_PAGE_SMOKE_ROWS);
    expect(selectAdminDeployedApiSmokeProbes()).toEqual(ADMIN_DEPLOYED_API_SMOKE_PROBES);

    const deferredPageRows = selectAdminDeployedPageSmokeRows({ requireFulfillmentPostage: false });
    const deferredApiProbes = selectAdminDeployedApiSmokeProbes({ requireFulfillmentPostage: false });

    expect(deferredPageRows).not.toContainEqual(
      expect.objectContaining({ id: "SMOKE-PAGE-COMMERCE-POSTAGE-POLICIES" }),
    );
    expect(deferredApiProbes).not.toContainEqual(
      expect.objectContaining({ id: "SMOKE-PROBE-MARKETPLACE-POSTAGE-POLICIES" }),
    );
    expect(
      deferredPageRows.every((row) => !row.coverageIds.includes(ADMIN_FULFILLMENT_POSTAGE_SMOKE_COVERAGE_ID)),
    ).toBe(true);
    expect(
      deferredApiProbes.every((probe) => !probe.coverageIds.includes(ADMIN_FULFILLMENT_POSTAGE_SMOKE_COVERAGE_ID)),
    ).toBe(true);
  });

  it("documents deployed API probes and their linked coverage ids", () => {
    const matrixCoverageIds = new Set(ADMIN_SHELL_SMOKE_MATRIX.map((row) => row.id));
    const apiCoverageIds = new Set(ADMIN_WEB_API_DEPENDENCIES.map((dependency) => dependency.smokeCoverageId));
    const deployedProbeCoverageIds = new Set(ADMIN_DEPLOYED_API_SMOKE_PROBES.flatMap((probe) => probe.coverageIds));

    const undocumentedProbeRows = ADMIN_DEPLOYED_API_SMOKE_PROBES.flatMap((probe) =>
      [probe.id, probe.path].filter((value) => !runbook.includes(value)),
    );
    expect(undocumentedProbeRows).toEqual([]);

    const missingLinkedCoverage = ADMIN_DEPLOYED_API_SMOKE_PROBES.flatMap((probe) =>
      probe.coverageIds.filter((coverageId) => !matrixCoverageIds.has(coverageId) && !apiCoverageIds.has(coverageId)),
    );
    expect(missingLinkedCoverage).toEqual([]);

    const missingDeployedProbeCoverage = ADMIN_WEB_API_DEPENDENCIES.map(
      (dependency) => dependency.smokeCoverageId,
    ).filter((coverageId) => !deployedProbeCoverageIds.has(coverageId));
    expect(missingDeployedProbeCoverage).toEqual([]);

    for (const probe of ADMIN_DEPLOYED_API_SMOKE_PROBES) {
      expect(probe.expectedStatuses.length).toBeGreaterThan(0);
      expect(probe.expectedContentTypes.length).toBeGreaterThan(0);
      for (const coverageId of probe.coverageIds) {
        expect(runbook).toContain(coverageId);
      }
    }
  });

  it("wires deployed API probes into platform smoke", () => {
    expect(platformSmoke).toContain("selectAdminDeployedApiSmokeProbes");
    expect(platformSmoke).toContain("expectAdminDeployedApiProbes");
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
