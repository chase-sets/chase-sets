import {
  deriveScrydexCoordinatePreviewReasons,
  scrydexCoordinatePreviewMaxForbiddenCalls,
  scrydexCoordinatePreviewMaxTally,
  type ScrydexCoordinatePreviewEvidence,
  type ScrydexCoordinatePreviewReceipt,
} from "../domain/scrydex-coordinate-preview";

type ReceiptRunner = ScrydexCoordinatePreviewReceipt["runner"];
type DeploymentGeneration = ScrydexCoordinatePreviewReceipt["deployment"]["before"];
type ObservedRequests = ScrydexCoordinatePreviewEvidence["requests"];
type ObservedUsageRead = ScrydexCoordinatePreviewEvidence["usageRead"];
type ObservedRows = ScrydexCoordinatePreviewEvidence["rows"];
type ObservedPreview = ScrydexCoordinatePreviewEvidence["preview"];

export type ScrydexCoordinatePreviewObserved = Readonly<{
  phases?: readonly string[];
  requests?: Partial<ObservedRequests>;
  usageRead?: Partial<ObservedUsageRead>;
  forbiddenCalls?: readonly string[];
  preview?: ObservedPreview;
  rows?: readonly ObservedRows[number][];
}>;

export type ScrydexCoordinatePreviewDeploymentSelection = Readonly<{
  generation: DeploymentGeneration;
  stop: string | null;
}>;

export type ScrydexCoordinatePreviewRunnerInput = Readonly<{
  runner: ReceiptRunner;
  credentialsPresent: boolean;
  selectDeployment: () => Promise<ScrydexCoordinatePreviewDeploymentSelection>;
  signIn: () => Promise<void>;
  produce: () => Promise<ScrydexCoordinatePreviewObserved>;
  now: () => string;
}>;

const runnerReason =
  /^(?:credentials-missing|producer-failed(?::[a-z0-9-]{1,64})?|deployment-(?:before|after):[a-z0-9-]{1,64})$/;

export function mergeObservedCoordinatePreviewReceipt(
  base: Readonly<{
    runner: ReceiptRunner;
    deployment: ScrydexCoordinatePreviewEvidence["deployment"];
    startedAt: string;
    finishedAt: string;
    runnerReasons?: readonly string[];
  }>,
  observed: ScrydexCoordinatePreviewObserved,
): ScrydexCoordinatePreviewReceipt {
  const forbiddenCalls = [...(observed.forbiddenCalls ?? [])].slice(0, scrydexCoordinatePreviewMaxForbiddenCalls);
  const requests = clampRequests(observed.requests, forbiddenCalls.length);
  const usageRead: ObservedUsageRead = {
    count: clampTally(observed.usageRead?.count),
    allowed: observed.usageRead?.allowed === true,
  };
  const evidence: ScrydexCoordinatePreviewEvidence = {
    runner: base.runner,
    deployment: base.deployment,
    startedAt: base.startedAt,
    finishedAt: base.finishedAt,
    phases: normalizePhases(observed.phases),
    requests,
    usageRead,
    forbiddenCalls,
    preview: observed.preview ?? null,
    rows: [...(observed.rows ?? [])],
  };
  const derived = deriveScrydexCoordinatePreviewReasons(evidence);
  const keptRunnerReasons = (base.runnerReasons ?? []).filter((reason) => runnerReason.test(reason));
  const reasons = [...new Set([...keptRunnerReasons, ...derived])].sort();
  return {
    schemaVersion: "scrydex-coordinate-preview/v1",
    outcome: reasons.length === 0 ? "complete" : "governed-unknown",
    reasons,
    ...evidence,
  };
}

export async function runScrydexCoordinatePreview(
  input: ScrydexCoordinatePreviewRunnerInput,
): Promise<ScrydexCoordinatePreviewReceipt> {
  const startedAt = input.now();
  const runnerReasons = new Set<string>();
  let observed: ScrydexCoordinatePreviewObserved = {};
  let before: ScrydexCoordinatePreviewDeploymentSelection = { generation: null, stop: "not-attempted" };
  let after: ScrydexCoordinatePreviewDeploymentSelection = { generation: null, stop: "not-attempted" };

  if (!input.credentialsPresent) {
    runnerReasons.add("credentials-missing");
  } else {
    before = await selectDeployment(input.selectDeployment);
    if (!before.generation) {
      runnerReasons.add(`deployment-before:${before.stop ?? "selection-failed"}`);
    } else {
      let signedIn = false;
      try {
        await input.signIn();
        signedIn = true;
      } catch {
        runnerReasons.add("producer-failed:sign-in");
      }
      if (signedIn) {
        try {
          observed = (await input.produce()) ?? {};
        } catch (error) {
          runnerReasons.add(producerFailureReason(error));
        }
      }
      after = await selectDeployment(input.selectDeployment);
      if (!after.generation) runnerReasons.add(`deployment-after:${after.stop ?? "selection-failed"}`);
    }
  }

  const finishedAt = input.now();
  return mergeObservedCoordinatePreviewReceipt(
    {
      runner: input.runner,
      deployment: { before: before.generation, after: after.generation },
      startedAt,
      finishedAt,
      runnerReasons: [...runnerReasons],
    },
    observed,
  );
}

async function selectDeployment(
  select: () => Promise<ScrydexCoordinatePreviewDeploymentSelection>,
): Promise<ScrydexCoordinatePreviewDeploymentSelection> {
  try {
    const selection = await select();
    if (selection.generation) return { generation: selection.generation, stop: null };
    return { generation: null, stop: validStop(selection.stop) ? selection.stop : "selection-failed" };
  } catch {
    return { generation: null, stop: "selection-failed" };
  }
}

function validStop(value: string | null): value is string {
  return typeof value === "string" && /^[a-z0-9-]{1,64}$/.test(value);
}

function producerFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[a-z0-9-]{1,64}$/.test(message) ? `producer-failed:${message}` : "producer-failed";
}

function clampRequests(input: Partial<ObservedRequests> | undefined, forbiddenCallsLength: number): ObservedRequests {
  return {
    signIn: clampTally(input?.signIn),
    profileReads: clampTally(input?.profileReads),
    scopeInventoryReads: clampTally(input?.scopeInventoryReads),
    coverageReads: clampTally(input?.coverageReads),
    cacheOptionReads: clampTally(input?.cacheOptionReads),
    previewPosts: clampTally(input?.previewPosts),
    usageReads: clampTally(input?.usageReads),
    forbidden: Math.max(clampTally(input?.forbidden), clampTally(forbiddenCallsLength)),
  };
}

function clampTally(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(scrydexCoordinatePreviewMaxTally, Math.max(0, Math.trunc(value!)));
}

function normalizePhases(phases: readonly string[] | undefined): ScrydexCoordinatePreviewEvidence["phases"] {
  const known = new Set(["sign-in", "readiness", "preview", "pre-confirm"]);
  if (!phases || phases.some((phase) => !known.has(phase))) return [];
  return [...phases] as ScrydexCoordinatePreviewEvidence["phases"];
}
