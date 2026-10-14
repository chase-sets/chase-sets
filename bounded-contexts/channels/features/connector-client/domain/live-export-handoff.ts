import type { ClaimedLiveExportOutcome, LiveExportPayload } from "../../outbound-sync/domain/live-export-codec";
import { record, refuse } from "./operation-codec";
import { utcInstant } from "./extension-records";

export const liveExportPostStates = ["planned", "dispatched", "captured202"] as const;
export type LiveExportPostState = (typeof liveExportPostStates)[number];
/**
 * Journaled before parse so a restart resumes the same raw record, digest and reference without refetching.
 * The parsed row count joins the post when it is dispatched, so a captured202 report survives raw removal.
 */
export type LiveExportHandoff = Readonly<{
  rawExportId: string;
  fileSha256: string;
  downloadedAt: string;
  byteLength: number;
  post:
    | Readonly<{ externalReference: string; state: "planned" }>
    | Readonly<{ externalReference: string; state: "dispatched" | "captured202"; parsedRowCount: number }>;
}>;

const referenceProfile = "tcgplayer-live-export/v1";
const referencePattern = /^tcgx\.v1:[a-f0-9]{64}$/;

export async function liveExportExternalReference(
  connectionId: string,
  exportId: string,
  fileSha256: string,
  crypto: Crypto = globalThis.crypto,
): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode([connectionId, exportId, fileSha256, referenceProfile].join("\0")),
  );
  return `tcgx.v1:${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function parseLiveExportHandoff(value: unknown, payload: LiveExportPayload): LiveExportHandoff {
  const row = record(value, ["rawExportId", "fileSha256", "downloadedAt", "byteLength", "post"]);
  const post = record(row.post, ["externalReference", "state"], ["parsedRowCount"]);
  if (
    (post.state === "planned") === Object.hasOwn(post, "parsedRowCount") ||
    (Object.hasOwn(post, "parsedRowCount") &&
      (!Number.isSafeInteger(post.parsedRowCount) ||
        (post.parsedRowCount as number) < 1 ||
        (post.parsedRowCount as number) > payload.limits.maxRecords))
  )
    refuse();
  if (
    row.rawExportId !== payload.exportId ||
    typeof row.fileSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.fileSha256) ||
    !utcInstant(row.downloadedAt) ||
    !Number.isSafeInteger(row.byteLength) ||
    (row.byteLength as number) < 1 ||
    (row.byteLength as number) > payload.limits.maxBytes ||
    typeof post.externalReference !== "string" ||
    !referencePattern.test(post.externalReference) ||
    !liveExportPostStates.includes(post.state as LiveExportPostState)
  )
    refuse();
  return structuredClone(row) as LiveExportHandoff;
}

/** Identity is immutable and the post state only advances; a dropped or rewound handoff is refused. */
export function assertLiveExportHandoffTransition(previous: LiveExportHandoff, next: LiveExportHandoff): void {
  if (
    previous.rawExportId !== next.rawExportId ||
    previous.fileSha256 !== next.fileSha256 ||
    previous.downloadedAt !== next.downloadedAt ||
    previous.byteLength !== next.byteLength ||
    previous.post.externalReference !== next.post.externalReference ||
    (previous.post.state !== "planned" &&
      (next.post.state === "planned" || previous.post.parsedRowCount !== next.post.parsedRowCount)) ||
    liveExportPostStates.indexOf(next.post.state) < liveExportPostStates.indexOf(previous.post.state)
  )
    refuse();
}

/** A complete outcome is admissible only as the exact projection of a captured202 handoff. */
export function assertLiveExportHandoffOutcome(
  outcome: ClaimedLiveExportOutcome,
  payload: LiveExportPayload,
  handoff?: LiveExportHandoff,
): void {
  if (outcome.exportId !== payload.exportId) refuse();
  if (outcome.outcome.kind !== "live-export-complete") return;
  if (
    !handoff ||
    handoff.post.state !== "captured202" ||
    outcome.outcome.fileSha256 !== handoff.fileSha256 ||
    outcome.outcome.capturedAt !== handoff.downloadedAt ||
    outcome.outcome.parsedRowCount !== handoff.post.parsedRowCount ||
    outcome.outcome.externalReference !== handoff.post.externalReference
  )
    refuse();
}
