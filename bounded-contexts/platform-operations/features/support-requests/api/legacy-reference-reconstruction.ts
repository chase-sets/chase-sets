import { createHash } from "node:crypto";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import {
  parseGlobalPosition,
  ZERO_GLOBAL_POSITION,
  type EventStoreContext,
  type AppendToStreamInput,
  type StoredEvent,
} from "@chase-sets/event-core/storage";
import type { JsonObject } from "@chase-sets/primitives/json";
import { canonicalJson } from "../domain/attachment-operation";
import { parseSupportEvidenceAttachmentReference } from "../domain/attachment-reference";
import { attachmentStorageKey } from "./attachments";
import {
  LEGACY_RECONSTRUCTION_STREAM,
  LEGACY_RECONSTRUCTED,
  LEGACY_DELETION_CLAIMED,
  LEGACY_DELETION_RECORDED,
  parseLegacyEvidenceKey,
  type LegacyReferenceAuthority,
} from "../domain/legacy-evidence";

const casePrefix = "support.support-request-";
const operationPrefix = "support.attachment-operation-";
const context: EventStoreContext = {
  tenantId: "tnt_support_legacy_inventory" as EventStoreContext["tenantId"],
  audit: {
    performedByUserId: "usr_support_legacy_inventory" as EventStoreContext["audit"]["performedByUserId"],
    forAccountId: "acc_support_legacy_inventory" as EventStoreContext["audit"]["forAccountId"],
  },
};
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

function referenceKeys(history: readonly StoredEvent[]): string[] {
  const keys = new Set<string>();
  for (const event of history) {
    if (event.eventType !== "support.support-request.evidence-submitted") continue;
    const evidence = event.payload.evidence;
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error("unknown");
    const attachments = (evidence as JsonObject).attachments;
    if (!Array.isArray(attachments)) throw new Error("unknown");
    for (const reference of attachments) {
      if (typeof reference !== "string") throw new Error("unknown");
      if (reference.startsWith("seed://support/")) continue;
      const parsed = parseSupportEvidenceAttachmentReference(reference);
      if (!parsed) throw new Error("unknown");
      keys.add(attachmentStorageKey(event.streamId.slice(casePrefix.length), parsed.attachmentId, parsed.sha256, parsed.contentType));
    }
  }
  return [...keys].sort();
}

function operationKeys(history: readonly StoredEvent[]): string[] {
  const keys = new Set<string>();
  for (const event of history) {
    if (event.eventType !== "support.attachment-operation.staged") continue;
    const manifest = event.payload;
    const owner = manifest.owner;
    if (!owner || typeof owner !== "object" || Array.isArray(owner) || typeof (owner as JsonObject).supportRequestId !== "string" || !Array.isArray(manifest.items))
      throw new Error("unknown");
    for (const item of manifest.items) {
      if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.attachmentId !== "string" || typeof item.canonicalSha256 !== "string" ||
        (item.contentType !== "image/jpeg" && item.contentType !== "image/png" && item.contentType !== "image/webp")) throw new Error("unknown");
      keys.add(attachmentStorageKey((owner as JsonObject).supportRequestId as string, item.attachmentId, item.canonicalSha256, item.contentType));
    }
  }
  return [...keys].sort();
}

export function createLegacyReferenceReconstruction(deps: Readonly<{
  eventStore: EventStore;
  readHorizon: () => Promise<string>;
}>) {
  const { eventStore } = deps;

  async function reconstruct(input: Readonly<{ horizon?: string }> = {}): Promise<LegacyReferenceAuthority> {
    let horizon = input.horizon ?? "0";
    try {
      horizon = parseGlobalPosition(input.horizon ?? await deps.readHorizon());
      let cursor = ZERO_GLOBAL_POSITION;
      const discovered = new Map<string, StoredEvent[]>();
      for (;;) {
        const page = await eventStore.readAll({ afterGlobalPosition: cursor, atOrBeforeGlobalPosition: parseGlobalPosition(horizon), limit: 500 });
        if (page.length > 500) throw new Error("unknown");
        for (const event of page) {
          if (BigInt(event.globalPosition) <= BigInt(cursor) || BigInt(event.globalPosition) > BigInt(horizon)) throw new Error("unknown");
          cursor = event.globalPosition;
          if (event.streamId.startsWith(casePrefix) || event.streamId.startsWith(operationPrefix)) {
            const history = discovered.get(event.streamId) ?? [];
            if (event.streamVersion !== history.length + 1) throw new Error("unknown");
            history.push(event);
            discovered.set(event.streamId, history);
          }
        }
        if (page.length < 500) break;
      }
      const references = new Set<string>();
      const operations = new Set<string>();
      for (const [streamId, expected] of discovered) {
        const complete = (await readCompleteStream(eventStore, { streamId }))
          .filter((event) => BigInt(event.globalPosition) <= BigInt(horizon));
        if (complete.length !== expected.length || complete.some((event, index) => event.eventId !== expected[index]!.eventId)) throw new Error("unknown");
        const keys = streamId.startsWith(casePrefix) ? referenceKeys(complete) : operationKeys(complete);
        for (const key of keys) (streamId.startsWith(casePrefix) ? references : operations).add(key);
      }
      const sortedReferences = [...references].sort();
      const sortedOperations = [...operations].sort();
      const authority = { horizon, count: sortedReferences.length, digest: digest({ references: sortedReferences, operationKeys: sortedOperations }) };
      const receipts = await readCompleteStream(eventStore, { streamId: LEGACY_RECONSTRUCTION_STREAM });
      const prior = receipts.find((event) => event.eventType === LEGACY_RECONSTRUCTED && event.payload.horizon === horizon);
      if (prior && canonicalJson(prior.payload) !== canonicalJson(authority)) throw new Error("unknown");
      if (!prior) await eventStore.appendToStream({
        streamId: LEGACY_RECONSTRUCTION_STREAM, expectedVersion: receipts.at(-1)?.streamVersion ?? 0, context,
        events: [{ eventType: LEGACY_RECONSTRUCTED, payload: authority }],
      });
      return { status: "complete", ...authority, references: sortedReferences, operationKeys: sortedOperations };
    } catch {
      return { status: "unknown", horizon, count: 0, digest: digest(null), references: [], operationKeys: [] };
    }
  }

  async function claim(input: Readonly<{ manifestDigest: string; horizon: string; keys: readonly string[]; referenceDigest: string }>): Promise<boolean> {
    try {
      if (!eventStore.appendToStreams || !/^[a-f0-9]{64}$/.test(input.manifestDigest) || input.keys.length < 1 || input.keys.length > 100 || new Set(input.keys).size !== input.keys.length) return false;
      const current = await reconstruct();
      if (current.status !== "complete" || current.digest !== input.referenceDigest) return false;
      const guards: AppendToStreamInput[] = [];
      for (const key of input.keys) {
        const parsed = parseLegacyEvidenceKey(key);
        if (!parsed || current.references.includes(key) || current.operationKeys.includes(key)) return false;
        const streamId = `${casePrefix}${parsed.supportRequestId}`;
        const history = await readCompleteStream(eventStore, { streamId });
        if (referenceKeys(history).includes(key)) return false;
        if (!guards.some((guard) => guard.streamId === streamId)) guards.push({ streamId, expectedVersion: history.at(-1)?.streamVersion ?? 0, events: [], context });
      }
      const streamId = `support.evidence-legacy-deletion-${input.manifestDigest}`;
      const history = await readCompleteStream(eventStore, { streamId });
      await eventStore.appendToStreams([
        ...guards,
        { streamId, expectedVersion: history.at(-1)?.streamVersion ?? 0, context,
          events: [{ eventType: LEGACY_DELETION_CLAIMED, payload: { horizon: input.horizon, manifestDigest: input.manifestDigest, keys: [...input.keys] } }] },
      ]);
      return true;
    } catch { return false; }
  }

  async function recordOutcomes(input: Readonly<{ manifestDigest: string; outcomes: readonly Readonly<{ key: string; status: "deleted" | "absent" | "failed" }>[] }>): Promise<void> {
    const streamId = `support.evidence-legacy-deletion-${input.manifestDigest}`;
    const history = await readCompleteStream(eventStore, { streamId });
    await eventStore.appendToStream({ streamId, expectedVersion: history.at(-1)?.streamVersion ?? 0, context,
      events: [{ eventType: LEGACY_DELETION_RECORDED, payload: { manifestDigest: input.manifestDigest, outcomes: input.outcomes.map((outcome) => ({ ...outcome })) } }] });
  }

  return { reconstruct, claim, recordOutcomes };
}
