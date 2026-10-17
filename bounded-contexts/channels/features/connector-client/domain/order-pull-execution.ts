import type { ChannelOrderFulfillmentObservation } from "../../order-fulfillment-observations/domain/contracts";
import { canonicalJson } from "../../listing-composition/domain/canonical-json";
import {
  ORDER_PULL_LEASE_MARGIN_MS,
  orderPullProviderReady,
  type OrderPullUnknownReason,
} from "../../outbound-sync/domain/order-pull-codec";
import {
  assertSalePostIdentity,
  orderPullReportOutcome,
  parseOrderPullHandoff,
  reconstructFulfillmentPost,
  type OrderPullHandoff,
  type OrderPullPost,
} from "./order-pull-handoff";
import { OperationProtocolError, refuse, type OperationAttempt, type ExecutorResult } from "./operation-protocol";

type PullAttempt = Extract<OperationAttempt, { operationKind: "tcgplayer-order-pull" }>;
export type OrderPullExecution = ReturnType<typeof createOrderPullExecution>;
type Ports = Readonly<{
  current(): PullAttempt;
  save(handoff: OrderPullHandoff): Promise<void>;
  fence(): Promise<boolean>;
  now(): number;
  signal: AbortSignal;
}>;

/** Admission custody only. Provider traversal and the detail mapper remain injected by the executor owner. */
export function createOrderPullExecution(ports: Ports) {
  let busy = false;
  const attempted = new Set<string>();
  let unknown: OrderPullUnknownReason | undefined;
  const check = async (budgetMs: number) => {
    const member = ports.current();
    const now = ports.now();
    if (
      ports.signal.aborted ||
      !(await ports.fence()) ||
      !["dispatched", "outcome-unknown"].includes(member.state) ||
      !member.dispatchedAt ||
      now + budgetMs + ORDER_PULL_LEASE_MARGIN_MS >= Date.parse(member.leaseExpiresAt) ||
      now + budgetMs > Date.parse(member.dispatchedAt) + member.payload.bounds.budgetMs ||
      !orderPullProviderReady(member.payload, new Date(now).toISOString())
    )
      throw new OperationProtocolError("stale-fence");
    return member;
  };
  const serial = async <T>(action: () => Promise<T>) => {
    if (busy) throw new OperationProtocolError("stale-fence");
    busy = true;
    try {
      return await action();
    } finally {
      busy = false;
    }
  };
  const save = async (handoff: OrderPullHandoff) => {
    const member = await check(handoff.authority.reportTimeoutMs);
    parseOrderPullHandoff(handoff, member.payload);
    await ports.save(handoff);
  };
  const consume = async (kind: "providerCalls" | "posts") => {
    const handoff = ports.current().handoff;
    if (!handoff) refuse();
    if (kind === "providerCalls" && ports.now() < Date.parse(handoff.usage.providerNotBefore))
      throw new OperationProtocolError("stale-fence");
    await save({
      ...handoff,
      usage: {
        ...handoff.usage,
        [kind]: handoff.usage[kind] + 1,
        ...(kind === "providerCalls"
          ? { providerNotBefore: new Date(ports.now() + handoff.authority.providerCadenceMs).toISOString() }
          : {}),
      },
    });
  };
  const selected = (reference: string | null, index: number) => {
    const handoff = ports.current().handoff;
    if (!handoff) refuse();
    const post =
      reference === null
        ? handoff.summary
        : handoff.bundles.find((bundle) => bundle.reference === reference)?.posts?.[index];
    if (!post) refuse();
    return { handoff, post };
  };
  const capture = async (reference: string | null, index: number, state: OrderPullPost["state"]) => {
    const { handoff, post } = selected(reference, index);
    let next: OrderPullHandoff;
    if (reference === null) {
      if (post.kind !== "sale") refuse();
      next = { ...handoff, summary: { ...post, state } };
    } else {
      const bundles = handoff.bundles.map((bundle) =>
        bundle.reference !== reference
          ? bundle
          : {
              ...bundle,
              posts: bundle.posts!.map((value, i) => (i === index ? { ...value, state } : value)),
            },
      );
      next = {
        ...handoff,
        bundles,
        progress: {
          ...handoff.progress,
          postedReferences: bundles
            .filter(
              (bundle) => bundle.source === "intake" && bundle.posts?.every((value) => value.state === "captured202"),
            )
            .map((bundle) => bundle.reference),
        },
      };
    }
    await save(next);
  };
  const claimAttempt = (reference: string | null, index: number) => {
    const identity = JSON.stringify([reference, index]);
    if (attempted.has(identity)) throw new OperationProtocolError("stale-fence");
    attempted.add(identity);
  };
  const postBytes = async (
    reference: string | null,
    index: number,
    bytes: string,
    post: (bytes: string, signal: AbortSignal) => Promise<Response>,
  ) => {
    const { handoff } = selected(reference, index);
    await check(handoff.authority.postTimeoutMs + handoff.authority.reportTimeoutMs);
    await consume("posts");
    await capture(reference, index, "dispatched");
    await check(handoff.authority.postTimeoutMs + handoff.authority.reportTimeoutMs);
    const signal = AbortSignal.any([ports.signal, AbortSignal.timeout(handoff.authority.postTimeoutMs)]);
    const response = await post(bytes, signal);
    if (signal.aborted || response.status !== 202 || (await response.text()) !== "{}") {
      unknown = "admission-ambiguous";
      return;
    }
    await capture(reference, index, "captured202");
  };
  return {
    save: (handoff: OrderPullHandoff) =>
      serial(async () => {
        const previous = ports.current().handoff;
        if (
          previous &&
          (canonicalJson(previous.usage) !== canonicalJson(handoff.usage) ||
            previous.bundles.some((bundle) =>
              bundle.posts?.some(
                (post, j) =>
                  post.state !==
                  handoff.bundles.find((candidate) => candidate.reference === bundle.reference)?.posts?.[j]?.state,
              ),
            ) ||
            (previous.summary && previous.summary.state !== handoff.summary?.state))
        )
          refuse();
        await save(handoff);
      }),
    read: <T>(read: (signal: AbortSignal) => Promise<T>) =>
      serial(async () => {
        const member = ports.current();
        const handoff = member.handoff;
        if (!handoff) refuse();
        await check(handoff.authority.providerCallTimeoutMs + handoff.authority.reportTimeoutMs);
        await consume("providerCalls");
        const signal = AbortSignal.any([ports.signal, AbortSignal.timeout(handoff.authority.providerCallTimeoutMs)]);
        const result = await read(signal);
        if (signal.aborted) throw new OperationProtocolError("stale-fence");
        await check(handoff.authority.reportTimeoutMs);
        return result;
      }),
    sale: (reference: string | null, index: number, post: (bytes: string, signal: AbortSignal) => Promise<Response>) =>
      serial(async () => {
        const selectedPost = selected(reference, index).post;
        if (selectedPost.state === "captured202") return;
        if (selectedPost.kind !== "sale") refuse();
        claimAttempt(reference, index);
        await assertSalePostIdentity(selectedPost);
        await postBytes(reference, index, selectedPost.bytes, post);
      }),
    fulfillment: (
      reference: string,
      index: number,
      observationOrReread:
        | ChannelOrderFulfillmentObservation
        | ((signal: AbortSignal) => Promise<ChannelOrderFulfillmentObservation>),
      post: (bytes: string, signal: AbortSignal) => Promise<Response>,
    ) =>
      serial(async () => {
        const { handoff, post: selectedPost } = selected(reference, index);
        if (selectedPost.state === "captured202") return;
        if (selectedPost.kind !== "fulfillment") refuse();
        const recovery = selectedPost.state === "dispatched";
        if (recovery !== (typeof observationOrReread === "function")) refuse();
        claimAttempt(reference, index);
        await check(
          (recovery ? handoff.authority.providerCallTimeoutMs : 0) +
            handoff.authority.postTimeoutMs +
            handoff.authority.reportTimeoutMs,
        );
        if (recovery) await consume("providerCalls");
        const signal = AbortSignal.any([ports.signal, AbortSignal.timeout(handoff.authority.providerCallTimeoutMs)]);
        let bytes: string | null;
        try {
          const observation =
            typeof observationOrReread === "function" ? await observationOrReread(signal) : observationOrReread;
          bytes = await reconstructFulfillmentPost(reference, selectedPost, observation);
        } catch {
          bytes = null;
        }
        if (!bytes || signal.aborted) {
          unknown = "recovery-content-changed";
          return;
        }
        await postBytes(reference, index, bytes, post);
      }),
    result: (reason?: OrderPullUnknownReason): ExecutorResult => {
      const member = ports.current();
      const refusal = reason ?? unknown;
      const outcome = refusal
        ? { kind: "order-pull-unknown" as const, reason: refusal }
        : member.handoff
          ? orderPullReportOutcome(member.payload, member.handoff)
          : refuse();
      return {
        outcomes: [
          {
            operationKind: member.operationKind,
            operationId: member.operationId,
            attemptId: member.attemptId,
            claimGeneration: member.claimGeneration,
            pullId: member.payload.pullId,
            payloadDigest: member.payloadDigest,
            outcome,
          },
        ],
      };
    },
    snapshot: () => structuredClone(ports.current().handoff),
  };
}
