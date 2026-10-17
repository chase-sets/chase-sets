import type { DomainEventCodec } from "@chase-sets/event-core/codec";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import {
  channelSyncRunMemberKinds,
  channelSyncRunStates,
  tcgplayerLocalRefusalReasons,
  type ChannelSyncRun,
  type ChannelSyncRunEvent,
  type ChannelSyncRunMember,
  type ChannelSyncRunMemberKind,
  type ChannelSyncRunState,
  type TcgplayerLocalRefusalReason,
} from "./contracts";
import {
  assertBoundedText,
  assertClosedRecord,
  assertManualClaimLeasePolicySnapshot,
  assertSafeInteger,
  assertTcgplayerImportSummary,
  assertTimezoneInstant,
} from "./validation";
import { decideChannelSyncRunTransition } from "./lifecycle";

export const channelSyncRunEventCodec: DomainEventCodec<ChannelSyncRunEvent> = {
  encode: (event) => ({ eventType: event.type, payload: event.data }),
  decode: (stored) => decodeChannelSyncRunEvent(stored),
};

function decodeChannelSyncRunEvent(stored: Pick<StoredEvent, "eventType" | "payload">): ChannelSyncRunEvent {
  if (stored.eventType === "channels.tcgplayer-sync-run.composed") {
    assertClosedRecord(stored.payload, ["run", "csvHeader"], "run composed event");
    assertChannelSyncRun(stored.payload.run);
    if (
      !Array.isArray(stored.payload.csvHeader) ||
      !stored.payload.csvHeader.every((value) => typeof value === "string")
    ) {
      throw new Error("Run composed event csvHeader is invalid.");
    }
    if (stored.payload.run.state !== "composed" || stored.payload.run.revision !== 0) {
      throw new Error("Run composed event must contain the initial run state.");
    }
    return { type: stored.eventType, data: { run: stored.payload.run, csvHeader: stored.payload.csvHeader } };
  }
  if (stored.eventType === "channels.tcgplayer-sync-run.transitioned") {
    assertClosedRecord(
      stored.payload,
      [
        "runId",
        "reservationId",
        "expectedRevision",
        "fromState",
        "toState",
        "verificationSnapshotId",
        "verificationSnapshotGeneration",
        "uploadAttemptedAt",
        "uploadFileName",
        "importSummary",
      ],
      "run transitioned event",
    );
    assertBoundedText(stored.payload.runId, "runId");
    assertBoundedText(stored.payload.reservationId, "reservationId");
    assertSafeInteger(stored.payload.expectedRevision, 0, Number.MAX_SAFE_INTEGER, "expectedRevision");
    if (!isChannelSyncRunState(stored.payload.fromState) || !isChannelSyncRunState(stored.payload.toState)) {
      throw new Error("Run transition event state is invalid.");
    }
    const trigger = transitionTrigger(stored.payload);
    const decided = decideChannelSyncRunTransition(stored.payload.fromState, trigger, {
      verificationMatched: stored.payload.toState === "applied",
    });
    if (decided !== stored.payload.toState) throw new Error("Run transition event does not match the lifecycle.");
    if (stored.payload.verificationSnapshotId !== null)
      assertBoundedText(stored.payload.verificationSnapshotId, "verificationSnapshotId");
    if (stored.payload.verificationSnapshotGeneration !== null)
      assertSafeInteger(
        stored.payload.verificationSnapshotGeneration,
        1,
        Number.MAX_SAFE_INTEGER,
        "verificationSnapshotGeneration",
      );
    if ((stored.payload.verificationSnapshotId === null) !== (stored.payload.verificationSnapshotGeneration === null)) {
      throw new Error("Run transition verification fence is incomplete.");
    }
    if (stored.payload.uploadAttemptedAt !== null)
      assertTimezoneInstant(stored.payload.uploadAttemptedAt, "uploadAttemptedAt");
    if (stored.payload.uploadFileName !== null) assertBoundedText(stored.payload.uploadFileName, "uploadFileName", 256);
    if ((stored.payload.uploadAttemptedAt === null) !== (stored.payload.uploadFileName === null)) {
      throw new Error("Run transition upload evidence is incomplete.");
    }
    if (stored.payload.importSummary !== null) assertTcgplayerImportSummary(stored.payload.importSummary);
    if (trigger === "report-upload-attempted") {
      if (
        stored.payload.uploadAttemptedAt === null ||
        stored.payload.verificationSnapshotId !== null ||
        stored.payload.importSummary !== null
      ) {
        throw new Error("Upload transition evidence is invalid.");
      }
    } else if (trigger === "verify") {
      if (
        stored.payload.verificationSnapshotId === null ||
        stored.payload.importSummary === null ||
        stored.payload.uploadAttemptedAt !== null
      ) {
        throw new Error("Verification transition evidence is invalid.");
      }
    } else if (
      stored.payload.verificationSnapshotId !== null ||
      stored.payload.uploadAttemptedAt !== null ||
      stored.payload.importSummary !== null
    ) {
      throw new Error("Run transition carries unrelated evidence.");
    }
    return {
      type: stored.eventType,
      data: {
        runId: stored.payload.runId,
        reservationId: stored.payload.reservationId,
        expectedRevision: stored.payload.expectedRevision,
        fromState: stored.payload.fromState,
        toState: stored.payload.toState,
        verificationSnapshotId: stored.payload.verificationSnapshotId,
        verificationSnapshotGeneration: stored.payload.verificationSnapshotGeneration,
        uploadAttemptedAt: stored.payload.uploadAttemptedAt,
        uploadFileName: stored.payload.uploadFileName,
        importSummary: stored.payload.importSummary,
      },
    };
  }
  throw new Error("Unsupported Channel Sync Run event type.");
}

function isChannelSyncRunState(value: unknown): value is ChannelSyncRunState {
  return typeof value === "string" && channelSyncRunStates.some((state) => state === value);
}

function transitionTrigger(payload: Record<string, unknown>) {
  const from = payload.fromState;
  const to = payload.toState;
  if (from === "composed" && to === "claimed") return "claim" as const;
  if (from === "claimed" && to === "awaiting-verification") return "report-upload-attempted" as const;
  if (from === "claimed" && to === "validation-rejected") return "report-validation-cancelled" as const;
  if (from === "claimed" && to === "abandoned") return "release" as const;
  if ((from === "composed" || from === "claimed") && to === "stale-basis") return "observe-newer-basis" as const;
  if (from === "composed" && to === "superseded") return "supersede" as const;
  if (from === "awaiting-verification" && (to === "applied" || to === "application-unknown")) return "verify" as const;
  if ((from === "composed" || from === "claimed") && to === "abandoned") return "reservation-lease-expired" as const;
  if (from === "awaiting-verification" && to === "application-unknown") return "reservation-lease-expired" as const;
  throw new Error("Run transition event is illegal.");
}

function assertChannelSyncRun(value: unknown): asserts value is ChannelSyncRun {
  assertClosedRecord(
    value,
    [
      "runId",
      "revision",
      "sequence",
      "connectionId",
      "providerKey",
      "reservationId",
      "claimant",
      "leaseExpiresAt",
      "manualClaimLeasePolicySnapshot",
      "state",
      "basisSnapshotId",
      "basisSnapshotGeneration",
      "verificationSnapshotId",
      "verificationSnapshotGeneration",
      "uploadAttemptedAt",
      "uploadFileName",
      "importSummary",
      "createdAt",
      "updatedAt",
      "membershipCompleteness",
      "members",
    ],
    "channel sync run",
  );
  for (const key of ["runId", "connectionId", "reservationId", "basisSnapshotId"] as const)
    assertBoundedText(value[key], key);
  assertSafeInteger(value.revision, 0, Number.MAX_SAFE_INTEGER, "revision");
  assertSafeInteger(value.sequence, 1, Number.MAX_SAFE_INTEGER, "sequence");
  assertSafeInteger(value.basisSnapshotGeneration, 1, Number.MAX_SAFE_INTEGER, "basisSnapshotGeneration");
  if (value.providerKey !== "tcgplayer" || !isChannelSyncRunState(value.state))
    throw new Error("Channel Sync Run identity or state is invalid.");
  assertClosedRecord(value.claimant, ["claimantKind", "claimantId"], "run claimant");
  if (value.claimant.claimantKind !== "manual" && value.claimant.claimantKind !== "connector")
    throw new Error("Run claimant is invalid.");
  assertBoundedText(value.claimant.claimantId, "claimantId");
  assertTimezoneInstant(value.leaseExpiresAt, "leaseExpiresAt");
  assertTimezoneInstant(value.createdAt, "createdAt");
  assertTimezoneInstant(value.updatedAt, "updatedAt");
  if (value.claimant.claimantKind === "manual")
    assertManualClaimLeasePolicySnapshot(value.manualClaimLeasePolicySnapshot);
  else if (value.manualClaimLeasePolicySnapshot !== null)
    throw new Error("Connector run cannot carry a manual policy snapshot.");
  if (
    value.verificationSnapshotId !== null ||
    value.verificationSnapshotGeneration !== null ||
    value.uploadAttemptedAt !== null ||
    value.uploadFileName !== null ||
    value.importSummary !== null
  ) {
    throw new Error("Initial Channel Sync Run cannot contain later evidence.");
  }
  assertClosedRecord(value.membershipCompleteness, ["kind", "total"], "run membership completeness");
  if (value.membershipCompleteness.kind !== "complete")
    throw new Error("Run composed event membership must be complete.");
  assertSafeInteger(value.membershipCompleteness.total, 1, 1_000_000, "member total");
  if (!Array.isArray(value.members) || value.members.length !== value.membershipCompleteness.total)
    throw new Error("Run member total is invalid.");
  value.members.forEach(assertChannelSyncRunMember);
  if (
    new Set(value.members.map((member) => member.operationId)).size !== value.members.length ||
    value.members.some(
      (member) =>
        member.reservationId !== value.reservationId ||
        (member.memberKind !== "refused" &&
          (member.basisSnapshotId !== value.basisSnapshotId ||
            member.basisSnapshotGeneration !== value.basisSnapshotGeneration)),
    )
  ) {
    throw new Error("Run composed event membership fences are invalid.");
  }
}

function assertChannelSyncRunMember(value: unknown, ordinal: number): asserts value is ChannelSyncRunMember {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Run member must be a record.");
  const member = value as Record<string, unknown>;
  if (!isChannelSyncRunMemberKind(member.memberKind)) throw new Error("Run member kind is invalid.");
  for (const key of [
    "operationId",
    "attemptId",
    "reservationId",
    "channelListingId",
    "listingId",
    "payloadDigest",
  ] as const)
    assertBoundedText(member[key], key);
  for (const key of ["claimGeneration", "desiredStateSequence", "listingRevision"] as const)
    assertSafeInteger(member[key], key === "claimGeneration" ? 1 : 0, Number.MAX_SAFE_INTEGER, key);
  assertSafeInteger(member.ordinal, 0, 999_999, "ordinal");
  if (member.ordinal !== ordinal || !/^[0-9a-f]{64}$/.test(String(member.payloadDigest)))
    throw new Error("Run member fence is invalid.");
  const common = [
    "operationId",
    "attemptId",
    "claimGeneration",
    "reservationId",
    "channelListingId",
    "listingId",
    "desiredStateSequence",
    "listingRevision",
    "payloadDigest",
    "ordinal",
    "memberKind",
    "externalKey",
    "conditionText",
    "basisSnapshotId",
    "basisSnapshotGeneration",
    "basisTotalQuantity",
    "basisPriceAmountMinor",
    "targetQuantity",
    "targetPriceAmountMinor",
    "csvRow",
    "refusalReason",
    "mappingDimension",
    "mappingSourceKey",
  ];
  const keys = member.memberKind === "already-satisfied" ? [...common, "providerAction"] : common;
  if (Object.keys(member).length !== keys.length || Object.keys(member).some((key) => !keys.includes(key)))
    throw new Error("Run member is not closed.");
  if (member.memberKind === "refused") {
    if (
      !isTcgplayerLocalRefusalReason(member.refusalReason) ||
      member.csvRow !== null ||
      (member.mappingDimension === null) !== (member.mappingSourceKey === null) ||
      (member.mappingDimension !== null &&
        !["category", "condition", "attribute"].includes(String(member.mappingDimension)))
    )
      throw new Error("Refused run member is invalid.");
  } else {
    for (const key of ["externalKey", "basisSnapshotId"] as const) assertBoundedText(member[key], key);
    for (const key of [
      "basisSnapshotGeneration",
      "basisTotalQuantity",
      "basisPriceAmountMinor",
      "targetQuantity",
      "targetPriceAmountMinor",
    ] as const)
      assertSafeInteger(member[key], key === "basisSnapshotGeneration" ? 1 : 0, Number.MAX_SAFE_INTEGER, key);
    if (member.refusalReason !== null || member.mappingDimension !== null || member.mappingSourceKey !== null)
      throw new Error("Accepted run member carries refusal evidence.");
    if (member.memberKind === "composed") {
      if (!isStringRecord(member.csvRow)) throw new Error("Composed run member CSV row is invalid.");
    } else if (
      member.csvRow !== null ||
      member.providerAction !== "not-attempted-already-satisfied" ||
      member.basisTotalQuantity !== member.targetQuantity ||
      member.basisPriceAmountMinor !== member.targetPriceAmountMinor
    ) {
      throw new Error("Already-satisfied run member proof is invalid.");
    }
  }
}

function isChannelSyncRunMemberKind(value: unknown): value is ChannelSyncRunMemberKind {
  return typeof value === "string" && channelSyncRunMemberKinds.some((kind) => kind === value);
}

function isTcgplayerLocalRefusalReason(value: unknown): value is TcgplayerLocalRefusalReason {
  return typeof value === "string" && tcgplayerLocalRefusalReasons.some((reason) => reason === value);
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((member) => typeof member === "string")
  );
}
