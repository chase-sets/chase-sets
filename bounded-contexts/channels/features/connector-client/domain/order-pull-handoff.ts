import { canonicalJson } from "../../listing-composition/domain/canonical-json";
import {
  assertOrderPullAuthority,
  assertOrderPullOutcomeMatchesPayload,
  resolveOrderPullBudget,
  sameSelector,
  type ClaimedOrderPullOutcome,
  type OrderPullAuthority,
  type OrderPullPayload,
} from "../../outbound-sync/domain/order-pull-codec";
import {
  advanceOrderPullTraversal,
  assertOrderPullProgress,
  orderPullChunkInputByteLimit,
  orderPullProgressByteLimit,
  orderPullProgressKind,
  type OrderPullProgress,
} from "../../outbound-sync/domain/order-pull-progress-codec";
import {
  assertTcgplayerOrderRecord,
  composeTcgplayerOrderInbound,
  tcgplayerOrderLimits,
} from "../../tcgplayer-orders/domain/contracts";
import {
  composeChannelOrderFulfillmentInbound,
  fulfillmentObservationDigest,
  translateOrderStatus,
  type ChannelOrderFulfillmentObservation,
} from "../../order-fulfillment-observations/domain/contracts";
import { identifier, record, refuse } from "./operation-codec";
import { utcInstant } from "./extension-records";

type AdmissionState = "planned" | "dispatched" | "captured202";
export type OrderPullPost = Readonly<{
  externalReference: string;
  state: AdmissionState;
}> &
  (
    | Readonly<{ kind: "sale"; bytes: string }>
    | Readonly<{
        kind: "fulfillment";
        digest: string;
        variant: "full" | "status-only";
        status: Readonly<{ surface: "list" | "detail"; value: string }>;
      }>
  );
export type OrderPullBundle = Readonly<{
  reference: string;
  source: "intake" | "follow-up";
  posts: readonly OrderPullPost[] | null;
}>;
export type OrderPullHandoff = Readonly<{
  authority: OrderPullAuthority;
  progress: OrderPullProgress;
  bundles: readonly OrderPullBundle[];
  summary: Extract<OrderPullPost, { kind: "sale" }> | null;
  usage: Readonly<{ providerCalls: number; posts: number; providerNotBefore: string }>;
}>;

export async function browserCheckpointDigest(payload: OrderPullPayload): Promise<string> {
  return sha256(canonicalJson(payload.checkpoint));
}
async function sha256(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

// A separate aggregate bound includes retained sale envelopes, pages, descriptors and the total report.
export function orderPullHandoffByteLimit(payload: OrderPullPayload): number {
  return (
    (payload.bounds.maxObservationPosts + 1) * (tcgplayerOrderLimits.bytes + 2048) +
    2 * orderPullChunkInputByteLimit +
    orderPullProgressByteLimit
  );
}

function parsePost(value: unknown): OrderPullPost {
  const kind = record(value, ["kind", "externalReference", "state"], ["bytes", "digest", "variant", "status"]).kind;
  const post = record(
    value,
    kind === "sale"
      ? ["kind", "externalReference", "state", "bytes"]
      : ["kind", "externalReference", "state", "digest", "variant", "status"],
  );
  if (!["planned", "dispatched", "captured202"].includes(String(post.state))) refuse();
  identifier(post.externalReference);
  if (kind === "sale") {
    if (!/^tcg[op]\.v1:[a-f0-9]{64}$/.test(String(post.externalReference))) refuse();
    if (
      typeof post.bytes !== "string" ||
      new TextEncoder().encode(post.bytes).length > tcgplayerOrderLimits.bytes + 2048
    )
      refuse();
    const body = record(JSON.parse(post.bytes), ["inboundKind", "externalReference", "payload"]);
    const payload = record(body.payload, ["version", "records"]);
    if (
      body.inboundKind !== "order" ||
      body.externalReference !== post.externalReference ||
      payload.version !== 1 ||
      !Array.isArray(payload.records) ||
      payload.records.length !== 1
    )
      refuse();
    assertTcgplayerOrderRecord(payload.records[0]);
    // A closed DTO is the custody boundary; raw detail and arbitrary payload properties never enter the journal.
  } else {
    if (
      kind !== "fulfillment" ||
      !/^tcf\.v1:[a-f0-9]{64}$/.test(String(post.externalReference)) ||
      typeof post.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(post.digest) ||
      !["full", "status-only"].includes(String(post.variant))
    )
      refuse();
    const status = record(post.status, ["surface", "value"]);
    if (
      (status.surface !== "list" && status.surface !== "detail") ||
      typeof status.value !== "string" ||
      status.value.length < 1 ||
      status.value.length > 128
    )
      refuse();
    translateOrderStatus({ surface: status.surface, value: status.value });
  }
  return structuredClone(post) as OrderPullPost;
}

export function parseOrderPullHandoff(value: unknown, payload: OrderPullPayload): OrderPullHandoff {
  const handoff = record(value, ["authority", "progress", "bundles", "summary", "usage"]);
  assertOrderPullAuthority(handoff.authority);
  const budget = resolveOrderPullBudget(handoff.authority, payload.bounds.plan);
  if (
    budget.kind !== "fits" ||
    canonicalJson(budget.bounds) !== canonicalJson(payload.bounds) ||
    handoff.authority.revision !== payload.policyRevision ||
    !sameSelector(handoff.authority.selector, payload.selector)
  )
    refuse();
  assertOrderPullProgress(handoff.progress);
  const progress = handoff.progress;
  const usage = record(handoff.usage, ["providerCalls", "posts", "providerNotBefore"]);
  if (
    !Number.isSafeInteger(usage.providerCalls) ||
    Number(usage.providerCalls) < 0 ||
    Number(usage.providerCalls) > payload.bounds.providerCalls ||
    !Number.isSafeInteger(usage.posts) ||
    Number(usage.posts) < 0 ||
    Number(usage.posts) > payload.bounds.maxObservationPosts ||
    !utcInstant(usage.providerNotBefore) ||
    Date.parse(usage.providerNotBefore) < Date.parse(payload.providerNotBefore)
  )
    refuse();
  if (
    progress.previousDigest !== payload.checkpointDigest ||
    progress.pages.length > payload.bounds.plan.listReads ||
    !Array.isArray(handoff.bundles) ||
    handoff.bundles.length > payload.bounds.plan.intakeReads + payload.bounds.plan.followUpReads
  )
    refuse();
  const discovered = new Set(payload.work.references);
  let traversal = payload.checkpoint.traversal;
  for (const page of progress.pages) {
    traversal = advanceOrderPullTraversal(payload.selector, traversal, page);
    for (const reference of page.orderReferences) {
      if (discovered.has(reference)) refuse();
      discovered.add(reference);
    }
  }
  const references = new Set([...discovered, ...payload.followUpReferences]);
  const bundled = new Set<string>();
  const postKeys = new Set<string>();
  let posts = 0;
  let intake = 0;
  for (const value of handoff.bundles) {
    const bundle = record(value, ["reference", "source", "posts"]);
    identifier(bundle.reference);
    if (
      !references.has(bundle.reference) ||
      bundled.has(bundle.reference) ||
      !["intake", "follow-up"].includes(String(bundle.source)) ||
      (bundle.source === "follow-up") !== payload.followUpReferences.includes(bundle.reference)
    )
      refuse();
    bundled.add(bundle.reference);
    if (bundle.source === "intake") {
      if (
        payload.work.postedReferences.includes(bundle.reference) ||
        payload.work.acceptedReferences.includes(bundle.reference)
      )
        refuse();
      intake++;
    }
    if (bundle.posts === null) continue;
    if (
      !Array.isArray(bundle.posts) ||
      bundle.posts.length < 1 ||
      bundle.posts.length > handoff.authority.maxPostsPerOrder
    )
      refuse();
    for (const value of bundle.posts) {
      const post = parsePost(value);
      if (postKeys.has(post.externalReference)) refuse();
      postKeys.add(post.externalReference);
      if (post.kind === "sale") {
        const observation = JSON.parse(post.bytes).payload.records[0];
        if (
          observation.kind !== "order" ||
          observation.orderNumber !== bundle.reference ||
          observation.pullId !== payload.pullId
        )
          refuse();
      } else if (
        bundle.source === "intake" &&
        (post.variant !== "full" || post.status.surface !== "detail" || post.status.value !== "Ready to Ship")
      )
        refuse();
      posts++;
    }
  }
  if (posts > payload.bounds.maxObservationPosts || intake > payload.bounds.plan.intakeReads) refuse();
  for (const gap of progress.gaps)
    if (
      !discovered.has(gap.reference) ||
      bundled.has(gap.reference) ||
      payload.work.acceptedReferences.includes(gap.reference)
    )
      refuse();
  const bundles = handoff.bundles as readonly OrderPullBundle[];
  const posted = bundles
    .filter((bundle) => bundle.source === "intake" && bundle.posts?.every((post) => post.state === "captured202"))
    .map((bundle) => bundle.reference);
  if (canonicalJson([...progress.postedReferences].sort()) !== canonicalJson(posted.sort())) refuse();
  if (handoff.summary !== null) {
    const summary = parsePost(handoff.summary);
    if (summary.kind !== "sale") refuse();
    const observation = JSON.parse(summary.bytes).payload.records[0];
    if (observation.kind !== "summary" || observation.pullId !== payload.pullId) refuse();
  }
  if (posts + (handoff.summary ? 1 : 0) > payload.bounds.maxObservationPosts) refuse();
  if (!handoff.summary && bundles.some((bundle) => bundle.posts?.some((post) => post.kind === "sale"))) refuse();
  if (new TextEncoder().encode(canonicalJson(value)).length > orderPullHandoffByteLimit(payload)) refuse();
  return structuredClone(handoff) as OrderPullHandoff;
}

export function assertHandoffTransition(previous: OrderPullHandoff, next: OrderPullHandoff): void {
  if (
    next.usage.providerCalls < previous.usage.providerCalls ||
    next.usage.posts < previous.usage.posts ||
    Date.parse(next.usage.providerNotBefore) < Date.parse(previous.usage.providerNotBefore)
  )
    refuse();
  if (
    !previous.summary &&
    previous.bundles.every((bundle) => bundle.posts === null) &&
    previous.progress.postedReferences.length === 0
  ) {
    if (
      canonicalJson(previous.authority) !== canonicalJson(next.authority) ||
      previous.progress.previousDigest !== next.progress.previousDigest ||
      canonicalJson(previous.progress.pages) !==
        canonicalJson(next.progress.pages.slice(0, previous.progress.pages.length)) ||
      previous.bundles.some(
        (bundle) =>
          !next.bundles.some(
            (candidate) => candidate.reference === bundle.reference && candidate.source === bundle.source,
          ),
      ) ||
      next.bundles.some((bundle) => bundle.posts?.some((post) => post.state !== "planned")) ||
      (next.summary && next.summary.state !== "planned")
    )
      refuse();
    return;
  }
  if (
    canonicalJson(previous.authority) !== canonicalJson(next.authority) ||
    canonicalJson(previous.progress.pages) !== canonicalJson(next.progress.pages) ||
    previous.progress.previousDigest !== next.progress.previousDigest ||
    previous.progress.followUpTail !== next.progress.followUpTail ||
    canonicalJson(previous.progress.gaps) !== canonicalJson(next.progress.gaps) ||
    previous.bundles.length !== next.bundles.length
  )
    refuse();
  const transition = (old: OrderPullPost, next: OrderPullPost) => {
    if (
      canonicalJson({ ...old, state: null }) !== canonicalJson({ ...next, state: null }) ||
      (old.state === "captured202" && next.state !== "captured202") ||
      (old.state === "dispatched" && next.state === "planned") ||
      (old.state === "planned" && next.state === "captured202")
    )
      refuse();
  };
  previous.bundles.forEach((old, index) => {
    const bundle = next.bundles[index]!;
    if (old.reference !== bundle.reference || old.source !== bundle.source) refuse();
    if (old.posts) {
      if (!bundle.posts || old.posts.length !== bundle.posts.length) refuse();
      old.posts.forEach((post, i) => transition(post, bundle.posts![i]!));
    } else if (bundle.posts?.some((post) => post.state !== "planned")) refuse();
  });
  if (previous.summary) {
    if (!next.summary) refuse();
    transition(previous.summary, next.summary);
  } else if (next.summary?.state !== undefined && next.summary.state !== "planned") refuse();
}

export async function assertSalePostIdentity(post: Extract<OrderPullPost, { kind: "sale" }>): Promise<void> {
  parsePost(post);
  const body = JSON.parse(post.bytes);
  const composed = await composeTcgplayerOrderInbound(body.payload.records[0]);
  if (composed.externalReference !== post.externalReference || canonicalJson(body) !== canonicalJson(composed))
    refuse();
}

export async function reconstructFulfillmentPost(
  reference: string,
  post: Extract<OrderPullPost, { kind: "fulfillment" }>,
  observation: ChannelOrderFulfillmentObservation,
): Promise<string | null> {
  if (
    observation.externalOrderReference !== reference ||
    observation.variant !== post.variant ||
    canonicalJson(observation.providerOrderStatus) !== canonicalJson(post.status) ||
    (await fulfillmentObservationDigest(observation)) !== post.digest
  )
    return null;
  const inbound = await composeChannelOrderFulfillmentInbound(observation);
  if (inbound.externalReference !== post.externalReference) return null;
  return canonicalJson(inbound);
}

export function orderPullHandoffOutcome(
  payload: OrderPullPayload,
  handoff: OrderPullHandoff,
): ClaimedOrderPullOutcome["outcome"] {
  parseOrderPullHandoff(handoff, payload);
  if (
    (handoff.summary !== null && handoff.summary.state !== "captured202") ||
    handoff.bundles.some((bundle) => bundle.posts === null || bundle.posts.some((post) => post.state !== "captured202"))
  )
    refuse();
  let traversal = payload.checkpoint.traversal;
  for (const page of handoff.progress.pages) traversal = advanceOrderPullTraversal(payload.selector, traversal, page);
  const references = [...payload.work.references, ...handoff.progress.pages.flatMap((page) => page.orderReferences)];
  const accepted = new Set(payload.work.acceptedReferences);
  const posted = new Set([...payload.work.postedReferences, ...handoff.progress.postedReferences]);
  const gaps = new Set(handoff.progress.gaps.map((gap) => gap.reference));
  const kind = orderPullProgressKind({
    exhausted: traversal?.exhausted ?? false,
    unread: references.some((ref) => !accepted.has(ref) && !posted.has(ref) && !gaps.has(ref)),
    pending: references.some((ref) => posted.has(ref) && !accepted.has(ref) && !gaps.has(ref)),
    followUpTail: handoff.progress.followUpTail,
    gapCount: payload.checkpoint.gapCount + gaps.size,
  });
  return {
    kind,
    lawVersion: payload.lawVersion,
    selector: payload.selector,
    admissionCounts: {
      readyToShipMembers: handoff.bundles.filter((bundle) => bundle.source === "intake").length,
      followUpReads: payload.followUpReferences.length,
      admitted: handoff.bundles.reduce((sum, bundle) => sum + (bundle.posts?.length ?? 0), 0),
    },
    progress: handoff.progress,
  };
}

export function assertHandoffOutcome(
  outcome: ClaimedOrderPullOutcome,
  payload: OrderPullPayload,
  handoff?: OrderPullHandoff,
): void {
  assertOrderPullOutcomeMatchesPayload(outcome, payload);
  if (outcome.outcome.kind === "order-pull-unknown" || outcome.outcome.kind === "abandoned") return;
  if (!handoff || canonicalJson(outcome.outcome) !== canonicalJson(orderPullReportOutcome(payload, handoff))) refuse();
}

export function orderPullReportOutcome(
  payload: OrderPullPayload,
  handoff: OrderPullHandoff,
): ClaimedOrderPullOutcome["outcome"] {
  const outcome = orderPullHandoffOutcome(payload, handoff);
  // The claim carries one chunk, not the global pending set. Settlement rereads all retained chunks.
  if (payload.work.chunkId !== null && (outcome.kind === "order-pull-complete" || outcome.kind === "order-pull-gaps"))
    return { ...outcome, kind: "order-pull-pending" };
  return outcome;
}
