import { createHash } from "node:crypto";
import {
  buildScrydexCoordinatePreviewReceipt,
  scrydexCoordinatePreviewUnits,
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
  requests?: Partial<ScrydexCoordinatePreviewReceipt["requests"]>;
  usageRead?: { count: number; allowed: true };
  phases?: readonly ScrydexCoordinatePreviewReceipt["phases"][number][];
}>;

export type ScrydexCoordinatePreviewRunnerInput = Readonly<{
  runner: ScrydexCoordinatePreviewReceipt["runner"];
  credentialsPresent: boolean;
  selectDeployment: () => Promise<Readonly<{ generation: Generation | null; stop?: string | null }>>;
  signIn: () => Promise<void>;
  /** The producer must call the real planner/adapter chain; tests inject a denied transport producer. */
  produce?: () => Promise<Producer>;
  /** Alias retained for callers that name the operation preview. */
  preview?: () => Promise<Producer>;
  now: () => string;
}>;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

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
      producer = await (input.produce ?? input.preview ?? (() => Promise.reject(new Error("producer-missing"))))();
      phases.push("preview", "coverage", "cache", "pre-confirm");
    }
  } catch {
    reasons.add("producer-failed");
  }
  try {
    const selection = await input.selectDeployment();
    after = selection.generation;
    if (!after) reasons.add(`deployment-after:${selection.stop ?? "unavailable"}`);
  } catch {
    reasons.add("deployment-after:unavailable");
  }
  if (before && after && before.deployedHead !== after.deployedHead) reasons.add("deployment-mismatch");
  if (producer) {
    for (const reason of producer.forbiddenCalls ?? []) forbiddenCalls.push(reason.slice(0, 300));
    Object.assign(requests, producer.requests ?? {});
    requests.forbidden = forbiddenCalls.length;
    if ((producer.usageRead?.count ?? 1) !== 1 || producer.usageRead?.allowed !== true)
      reasons.add("usage-read-invalid");
    if (producer.preview.confirmAllowed === false || producer.preview.status !== "ready")
      reasons.add("preview-blocked");
    if (
      producer.preview.blockers.some(
        (blocker) => blocker.code === "scope-planning-blocked" && blocker.providerKey === "scrydex",
      )
    )
      reasons.add("scrydex-scope-planning-blocked");
    if (producer.rows.length !== scrydexCoordinatePreviewUnits.length) reasons.add("rows-not-exactly-five");
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
            mappingVersions: sample.mappingVersions,
            profileVersions: sample.profileVersions,
          })),
        }
      : null,
    rows: producer?.rows ?? [],
    phases,
    requests,
    forbiddenCalls,
    usageRead: producer?.usageRead ?? { count: 1, allowed: true },
  });
  return receipt;
}

/** Builds the five joined rows from planner samples and cache/mapping evidence. */
export function buildScrydexCoordinatePreviewRows(
  input: Readonly<{
    preview: Readonly<{ planFingerprint: string; resolvedAt: string; previewVersion?: string }>;
    rows: readonly Omit<ScrydexCoordinatePreviewRow, "previewFingerprint" | "resolvedAt" | "previewRevision">[];
  }>,
): readonly ScrydexCoordinatePreviewRow[] {
  return input.rows.map((row) => ({
    ...row,
    previewFingerprint: input.preview.planFingerprint,
    resolvedAt: input.preview.resolvedAt,
    previewRevision: input.preview.previewVersion ?? "scope-sync-batch-preview-v1",
  }));
}

/** A compact executable-mapper coordinate helper shared by fixtures and the hosted producer. */
export function scrydexCoordinateFromMapping(
  mapping: Readonly<{ setId?: string | null; setName?: string | null }>,
): string | null {
  return mapping.setId?.trim() || mapping.setName?.trim() || null;
}

export function scrydexCoordinatePreviewInputFingerprint(input: unknown): string {
  return digest(input);
}
