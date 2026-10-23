import {
  buildScrydexCoordinatePreviewReceipt,
  type ScrydexCoordinatePreviewReceipt,
  type ScrydexCoordinatePreviewRow,
} from "../domain/scrydex-coordinate-preview";

type Generation = NonNullable<ScrydexCoordinatePreviewReceipt["deployment"]["before"]>;
type Producer = Readonly<{
  preview: Readonly<{
    planFingerprint: string;
    resolvedAt: string;
    previewVersion?: string;
    status: "ready" | "blocked" | "empty";
    confirmAllowed: boolean;
    blockers: readonly Readonly<{ code: string; scopeRecordId: string | null; providerKey: string | null }>[];
    samples: readonly Readonly<{
      scopeRecordId: string;
      mappingVersions: readonly Readonly<{ mappingId: string; version: string; reviewStatus: string }>[];
      profileVersions: readonly Readonly<{
        providerKey: string;
        unitKey: string;
        profileKey: string;
        profileVersion: string;
      }>[];
    }>[];
  }>;
  rows: readonly ScrydexCoordinatePreviewRow[];
  forbiddenCalls?: readonly string[];
  observedRequests?: Partial<ScrydexCoordinatePreviewReceipt["requests"]>;
  observedUsageRead?: { count: number; allowed: boolean };
  phases?: readonly ScrydexCoordinatePreviewReceipt["phases"][number][];
}>;

export type ScrydexCoordinatePreviewRunnerInput = Readonly<{
  runner: ScrydexCoordinatePreviewReceipt["runner"];
  credentialsPresent: boolean;
  selectDeployment: () => Promise<Readonly<{ generation: Generation | null; stop?: string | null }>>;
  signIn: () => Promise<void>;
  /** The producer must call the real planner/adapter chain; tests inject a denied transport producer. */
  produce?: () => Promise<Producer>;
  now: () => string;
}>;

const emptyRequests = () => ({
  signIn: 0,
  profileReads: 0,
  scopeInventoryReads: 0,
  coverageReads: 0,
  cacheOptionReads: 0,
  usageReads: 0,
  previewPosts: 0,
  forbidden: 0,
});

/** Runs one immutable, no-confirm coordinate preview and emits one support-safe receipt. */
export async function runScrydexCoordinatePreview(
  input: ScrydexCoordinatePreviewRunnerInput,
): Promise<ScrydexCoordinatePreviewReceipt> {
  const startedAt = input.now();
  const reasons = new Set<string>();
  const requests = emptyRequests();
  const forbiddenCalls: string[] = [];
  let before: Generation | null = null;
  let after: Generation | null = null;
  let producer: Producer | null = null;
  const phases: ScrydexCoordinatePreviewReceipt["phases"] = ["deployment-before"];
  if (!input.credentialsPresent) reasons.add("credentials-missing");
  try {
    const selection = await input.selectDeployment();
    before = selection.generation;
    if (!before) reasons.add(`deployment-before:${selection.stop ?? "unavailable"}`);
    if (before && input.credentialsPresent) {
      await input.signIn();
      requests.signIn = 1;
      phases.push("sign-in", "readiness");
      producer = await (input.produce ?? (() => Promise.reject(new Error("producer-missing"))))();
      phases.push(...(producer.phases ?? ["preview", "coverage", "cache", "pre-confirm"]));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const refused = /^scrydex-coordinate-preview-refused:([A-Za-z0-9._:-]{1,200})$/.exec(message);
    reasons.add(refused ? `producer-failed:${refused[1]}` : "producer-failed");
  }
  try {
    const selection = await input.selectDeployment();
    after = selection.generation;
    if (!after) reasons.add(`deployment-after:${selection.stop ?? "unavailable"}`);
  } catch {
    reasons.add("deployment-after:unavailable");
  }
  if ((before && before.deployedHead !== input.runner.sha) || (after && after.deployedHead !== input.runner.sha))
    reasons.add("deployment-head-mismatch");
  if (before && after && JSON.stringify(before) !== JSON.stringify(after)) reasons.add("deployment-generation-changed");
  if (producer) {
    for (const reason of producer.forbiddenCalls ?? []) {
      if (forbiddenCalls.length < 100) forbiddenCalls.push(reason.slice(0, 300));
    }
    Object.assign(requests, producer.observedRequests ?? {});
    requests.forbidden = Math.min(1000, Math.max(forbiddenCalls.length, requests.forbidden ?? 0));
  } else {
    reasons.add("preview-missing");
  }
  const finishedAt = input.now();
  const fallbackPreview = producer?.preview ?? null;
  const receipt = buildScrydexCoordinatePreviewReceipt({
    schemaVersion: "scrydex-coordinate-preview/v1",
    outcome: "governed-unknown",
    reasons: [...reasons],
    runner: input.runner,
    deployment: { before, after },
    startedAt,
    finishedAt,
    preview: fallbackPreview
      ? {
          fingerprint: fallbackPreview.planFingerprint,
          resolvedAt: fallbackPreview.resolvedAt,
          revision: fallbackPreview.previewVersion ?? "scope-sync-batch-preview-v1",
          status: fallbackPreview.status,
          confirmAllowed: fallbackPreview.confirmAllowed,
          blockers: fallbackPreview.blockers.map((blocker) => ({
            code: blocker.code,
            scopeRecordId: blocker.scopeRecordId,
            providerKey: blocker.providerKey,
          })),
          samples: fallbackPreview.samples.map((sample) => ({
            scopeRecordId: sample.scopeRecordId,
            mappingVersions: [...sample.mappingVersions],
            profileVersions: [...sample.profileVersions],
          })),
        }
      : null,
    rows: [...(producer?.rows ?? [])],
    phases,
    requests,
    forbiddenCalls,
    usageRead: producer?.observedUsageRead ?? { count: 0, allowed: false },
  });
  return receipt;
}
