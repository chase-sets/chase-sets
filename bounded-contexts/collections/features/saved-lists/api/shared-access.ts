import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { SavedListId, SavedListOwnerSnapshot, SavedListViewerSnapshot } from "../domain/contracts";
import type {
  SavedListCapabilityService,
  SavedListSharingDisclosure,
  SavedListUnlistedSecret,
} from "../domain/sharing-contracts";
import { savedListCapabilityVerifierMatches } from "../domain/unlisted-capability";
import type { SavedListSharedPageRecord } from "../read-model/shared-page-queries";
import type { SavedListOwnerSnapshotReader } from "./sharing-runtime";

export const savedListSharingRateLimitRules = {
  "shared-view": { windowMs: 60_000, max: 120 },
  "unlisted-exchange": { windowMs: 60_000, max: 20 },
  "abuse-report": { windowMs: 60 * 60_000, max: 5 },
} as const;

export type SavedListAccessSubject =
  | Readonly<{ kind: "anonymous" }>
  | Readonly<{ kind: "account"; accountId: AccountId; copyCapability: "allowed" | "denied" }>;

export type SavedListAccessMode = "owner" | "public" | "unlisted";
export type SavedListAccessDecision = Readonly<{
  allowed: boolean;
  mode: SavedListAccessMode | null;
  canCopy: boolean;
}>;

export type SavedListSharedResponsePolicy = Readonly<{
  cacheControl: "private, no-store";
  robots: "index,follow" | "noindex,nofollow,noarchive";
  referrerPolicy: "strict-origin-when-cross-origin" | "no-referrer";
  vary: "Cookie, Authorization";
}>;

export type SavedListAuthorizedView =
  | Readonly<{
      source: "owner-snapshot";
      mode: "owner";
      canCopy: boolean;
      savedList: SavedListOwnerSnapshot;
      disclosure: SavedListSharingDisclosure;
      responsePolicy: SavedListSharedResponsePolicy;
    }>
  | Readonly<{
      source: "shared-projection";
      mode: "public" | "unlisted";
      canCopy: boolean;
      savedList: SavedListViewerSnapshot;
      disclosure: SavedListSharingDisclosure;
      responsePolicy: SavedListSharedResponsePolicy;
    }>;

export type SavedListSharedAccessResult =
  | Readonly<{ status: "found"; view: SavedListAuthorizedView }>
  | Readonly<{ status: "not-found" }>
  | Readonly<{ status: "rate-limited"; retryAfterSeconds: number }>;

export type SavedListSharingRateLimitPort = Readonly<{
  check: (
    input: Readonly<{
      surface: keyof typeof savedListSharingRateLimitRules;
      requestKey: string;
      rule: Readonly<{ windowMs: number; max: number }>;
    }>,
  ) => Promise<Readonly<{ limited: boolean; retryAfterSeconds: number }>>;
}>;

export type SavedListSharingAuditFact = Readonly<{
  type: "collections.saved-list-sharing.access-evaluated";
  listId: SavedListId;
  viewerAccountId: AccountId | null;
  accessMode: SavedListAccessMode | null;
  outcome: "allowed" | "not-found" | "rate-limited";
  evaluatedAt: string;
}>;
export type SavedListSharingAuditSink = Readonly<{
  record: (fact: SavedListSharingAuditFact) => Promise<void>;
}>;

export type SavedListAbuseReportReason = "spam" | "prohibited-content" | "harassment" | "other";
export type SavedListAbuseReportAdapter = Readonly<{
  submit: (
    input: Readonly<{
      targetType: "saved-list";
      targetId: SavedListId;
      targetOwnerAccountId: AccountId;
      reporterAccountId: AccountId | null;
      reason: SavedListAbuseReportReason;
    }>,
  ) => Promise<Readonly<{ reportReference: string }>>;
}>;

export type SavedListSharedAccessDeps = Readonly<{
  sharedPages: Readonly<{ load: (listId: SavedListId) => Promise<SavedListSharedPageRecord | null> }>;
  ownerSnapshots: SavedListOwnerSnapshotReader;
  capabilities: SavedListCapabilityService;
  rateLimits: SavedListSharingRateLimitPort;
  audit: SavedListSharingAuditSink;
  abuseReports: SavedListAbuseReportAdapter;
  clock?: () => string;
}>;

export function authorizeSavedListAccess(
  page: SavedListSharedPageRecord,
  subject: SavedListAccessSubject,
  candidateVerifier: string | null,
): SavedListAccessDecision {
  if (page.lifecycle !== "active") return { allowed: false, mode: null, canCopy: false };
  const isOwner = subject.kind === "account" && subject.accountId === page.ownerAccountId;
  if (isOwner) {
    return { allowed: true, mode: "owner", canCopy: subject.copyCapability === "allowed" };
  }
  if (page.visibility === "private") return { allowed: false, mode: null, canCopy: false };
  const canCopy = subject.kind === "account" && subject.copyCapability === "allowed";
  if (page.visibility === "public") return { allowed: true, mode: "public", canCopy };
  const allowed = savedListCapabilityVerifierMatches(candidateVerifier, page.unlistedVerifier);
  return { allowed, mode: allowed ? "unlisted" : null, canCopy: allowed && canCopy };
}

export function createSavedListSharedAccess(deps: SavedListSharedAccessDeps) {
  const now = deps.clock ?? (() => new Date().toISOString());

  async function record(
    listId: SavedListId,
    subject: SavedListAccessSubject,
    decision: Pick<SavedListSharingAuditFact, "accessMode" | "outcome">,
  ) {
    await deps.audit.record({
      type: "collections.saved-list-sharing.access-evaluated",
      listId,
      viewerAccountId: subject.kind === "account" ? subject.accountId : null,
      ...decision,
      evaluatedAt: now(),
    });
  }

  async function read(
    input: Readonly<{
      listId: SavedListId;
      subject: SavedListAccessSubject;
      requestKey: string;
      unlistedSecret?: SavedListUnlistedSecret | null;
      ownerContext?: EventStoreContext;
    }>,
  ): Promise<SavedListSharedAccessResult> {
    const viewLimit = await deps.rateLimits.check({
      surface: "shared-view",
      requestKey: input.requestKey,
      rule: savedListSharingRateLimitRules["shared-view"],
    });
    if (viewLimit.limited) {
      await record(input.listId, input.subject, { accessMode: null, outcome: "rate-limited" });
      return { status: "rate-limited", retryAfterSeconds: viewLimit.retryAfterSeconds };
    }
    if (input.unlistedSecret) {
      const exchangeLimit = await deps.rateLimits.check({
        surface: "unlisted-exchange",
        requestKey: input.requestKey,
        rule: savedListSharingRateLimitRules["unlisted-exchange"],
      });
      if (exchangeLimit.limited) {
        await record(input.listId, input.subject, { accessMode: null, outcome: "rate-limited" });
        return { status: "rate-limited", retryAfterSeconds: exchangeLimit.retryAfterSeconds };
      }
    }
    const page = await deps.sharedPages.load(input.listId);
    if (!page) {
      await record(input.listId, input.subject, { accessMode: null, outcome: "not-found" });
      return { status: "not-found" };
    }
    const verifier = input.unlistedSecret ? deps.capabilities.verifierFor(input.unlistedSecret) : null;
    const decision = authorizeSavedListAccess(page, input.subject, verifier);
    if (!decision.allowed || !decision.mode) {
      await record(input.listId, input.subject, { accessMode: null, outcome: "not-found" });
      return { status: "not-found" };
    }
    const disclosure: SavedListSharingDisclosure = {
      showTrackedQuantities: page.showTrackedQuantities,
      showCurrentEstimatedValue: page.showCurrentEstimatedValue,
    };
    if (decision.mode === "owner") {
      if (input.subject.kind !== "account" || !input.ownerContext) {
        await record(input.listId, input.subject, { accessMode: null, outcome: "not-found" });
        return { status: "not-found" };
      }
      const savedList = await deps.ownerSnapshots.getOwnerSnapshot(
        { listId: input.listId, ownerAccountId: input.subject.accountId },
        input.ownerContext,
      );
      if (!savedList || savedList.lifecycle !== "active") {
        await record(input.listId, input.subject, { accessMode: null, outcome: "not-found" });
        return { status: "not-found" };
      }
      await record(input.listId, input.subject, { accessMode: "owner", outcome: "allowed" });
      return {
        status: "found",
        view: {
          source: "owner-snapshot",
          mode: "owner",
          canCopy: decision.canCopy,
          savedList,
          disclosure,
          responsePolicy: responsePolicy("owner"),
        },
      };
    }
    const savedList = toViewerSnapshot(page);
    await record(input.listId, input.subject, { accessMode: decision.mode, outcome: "allowed" });
    return {
      status: "found",
      view: {
        source: "shared-projection",
        mode: decision.mode,
        canCopy: decision.canCopy,
        savedList,
        disclosure,
        responsePolicy: responsePolicy(decision.mode),
      },
    };
  }

  async function report(
    input: Readonly<{
      listId: SavedListId;
      subject: SavedListAccessSubject;
      requestKey: string;
      reason: SavedListAbuseReportReason;
      unlistedSecret?: SavedListUnlistedSecret | null;
    }>,
  ): Promise<Readonly<{ status: "accepted"; reportReference: string }> | SavedListSharedAccessResult> {
    const limit = await deps.rateLimits.check({
      surface: "abuse-report",
      requestKey: input.requestKey,
      rule: savedListSharingRateLimitRules["abuse-report"],
    });
    if (limit.limited) return { status: "rate-limited", retryAfterSeconds: limit.retryAfterSeconds };
    const page = await deps.sharedPages.load(input.listId);
    const verifier = input.unlistedSecret ? deps.capabilities.verifierFor(input.unlistedSecret) : null;
    if (!page || !authorizeSavedListAccess(page, input.subject, verifier).allowed) return { status: "not-found" };
    const accepted = await deps.abuseReports.submit({
      targetType: "saved-list",
      targetId: input.listId,
      targetOwnerAccountId: page.ownerAccountId,
      reporterAccountId: input.subject.kind === "account" ? input.subject.accountId : null,
      reason: input.reason,
    });
    return { status: "accepted", reportReference: accepted.reportReference };
  }

  return { read, report };
}

export function buildSavedListUnlistedLink(
  publicBaseUrl: string,
  listId: SavedListId,
  secret: SavedListUnlistedSecret,
) {
  const url = new URL(`/shared/lists/${encodeURIComponent(listId)}`, publicBaseUrl);
  url.hash = `access=${encodeURIComponent(secret)}`;
  return url.toString();
}

function toViewerSnapshot(page: SavedListSharedPageRecord): SavedListViewerSnapshot {
  if (page.visibility === "private") throw new Error("Private Saved Lists have no viewer snapshot.");
  return {
    contractVersion: 1,
    listId: page.listId,
    title: page.title,
    description: page.description,
    visibility: page.visibility,
    cover: page.coverLineId ? { lineId: page.coverLineId } : null,
    lineCount: page.lineCount,
    lines: page.lines.map((line) => ({
      lineId: line.lineId,
      product: line.product,
      trackedQuantity: page.showTrackedQuantities ? line.trackedQuantity : null,
      position: line.position,
    })),
    changedAt: page.sourceChangedAt,
    version: page.sourceVersion,
  };
}

function responsePolicy(mode: SavedListAccessMode): SavedListSharedResponsePolicy {
  return {
    cacheControl: "private, no-store",
    robots: mode === "public" ? "index,follow" : "noindex,nofollow,noarchive",
    referrerPolicy: mode === "public" ? "strict-origin-when-cross-origin" : "no-referrer",
    vary: "Cookie, Authorization",
  };
}
