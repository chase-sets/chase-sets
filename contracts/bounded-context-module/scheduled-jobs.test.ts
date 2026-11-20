import { describe, expect, it } from "vitest";
import { normalizeScheduledJobs, type ScheduledJobManifestDeclaration, type WorkerRunner } from "./index";
import type { ProjectionRunContext, ProjectorRunResult } from "@chase-sets/event-core/projector";

const job: ScheduledJobManifestDeclaration = {
  id: "example.job",
  runnerExport: "createJob",
  group: "scheduled",
  order: 1,
  runtimeProfiles: ["proof"],
  schedule: { kind: "interval", intervalMs: 1000 },
  lockScope: "job:example.job",
};
describe("scheduled job declarations", () => {
  it("retains explicit configuration/profile/lock metadata without activating defaults", () => {
    expect(normalizeScheduledJobs("example", [job])).toEqual([job]);
    expect(
      normalizeScheduledJobs("example", [
        { ...job, schedule: { kind: "configured-interval", configKey: "intervalMs" } },
      ])[0]!.schedule,
    ).toEqual({ kind: "configured-interval", configKey: "intervalMs" });
  });
  it("names the context and job on invalid declarations", () => {
    for (const invalid of [
      { ...job, runnerExport: "" },
      { ...job, group: "unknown" },
      { ...job, runtimeProfiles: [] },
      { ...job, schedule: { kind: "interval", intervalMs: 0 } },
      { ...job, lockScope: "" },
    ])
      expect(() => normalizeScheduledJobs("example", [invalid])).toThrow(/example\/example.job/);
  });
  it("uses the event-core runner contract and optional specialized projection status", async () => {
    const runOnce = async (_context?: ProjectionRunContext): Promise<ProjectorRunResult> => ({
      processed: 0,
      lastGlobalPosition: "0" as never,
    });
    const jobRunner: WorkerRunner = { name: "example.job", kind: "job", runOnce };
    const projection: WorkerRunner<{ pending: number }> = {
      ...jobRunner,
      kind: "projection-group",
      projectionStatusSnapshot: () => ({ pending: 3 }),
    };
    expect(await jobRunner.runOnce()).toMatchObject({ processed: 0 });
    expect(projection.projectionStatusSnapshot!()).toEqual({ pending: 3 });
  });
});
