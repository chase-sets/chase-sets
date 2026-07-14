import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CoverageRejectionReasonCode } from "@chase-sets/primitives/platform-coverage";
import {
  decideProtectionCoverage,
  evolveProtectionCoverage,
  initialProtectionReserveState,
  protectionReserveStreamId,
  type CoverageReleaseReason,
  type ProtectionCoverageCommand,
  type ProtectionCoverageEvent,
  type ProtectionReserveState,
} from "../domain/protection-coverage";
import { buildProtectionCoverageProjectionHandlers } from "../read-model/protection-coverage-projection";
import {
  getProtectionCoverage,
  getProtectionCoverageAvailability,
  getProtectionCoverageMetrics,
  getProtectionReservePoolBalance,
  listProtectionCoverageReconciliation,
} from "../read-model/protection-coverage-queries";
import { SettlementDomainError } from "../../../support/runtime-support/common";
import {
  createNoopSettlementOperationsRecorder,
  type SettlementOperationsRecorder,
} from "../../../support/runtime-support/operations";

const MAX_CONCURRENCY_RETRIES = 8;

function isConcurrencyConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "concurrency_conflict";
}

export type ReserveProtectionCoverageInput = Readonly<{
  coverageId: string;
  remedyId: string;
  supportRequestId: string;
  requestedAmount: string;
  currencyCode: string;
  policyVersion: string;
  reasonCode: string;
  causationId?: string | null;
  idempotencyKey?: string;
  occurredAt?: string;
  policyLimitAmount?: string | null;
}>;

export type SettleProtectionCoverageInput = Readonly<{
  coverageId: string;
  currencyCode: string;
  refundId: string;
  platformFundedAmount: string;
  sellerFundedAmount: string;
  policyVersion: string;
  causationId?: string | null;
  idempotencyKey?: string;
  occurredAt?: string;
}>;

export type ReleaseProtectionCoverageInput = Readonly<{
  coverageId: string;
  currencyCode: string;
  releaseReason: CoverageReleaseReason;
  policyVersion: string;
  causationId?: string | null;
  idempotencyKey?: string;
  occurredAt?: string;
}>;

export type ExpireProtectionCoverageInput = Readonly<{
  coverageId: string;
  currencyCode: string;
  policyVersion: string;
  deadline: string;
  causationId?: string | null;
  idempotencyKey?: string;
  occurredAt?: string;
}>;

export type ReserveProtectionCoverageResult = Readonly<{
  outcome: "reserved" | "rejected" | "already-reserved";
  coverageId: string;
  currencyCode: string;
  reservedAmount: string | null;
  rejectionReason: CoverageRejectionReasonCode | null;
}>;

export type TerminalProtectionCoverageResult = Readonly<{
  outcome: "applied" | "noop";
  coverageId: string;
}>;

export type ProtectionCoverageServices = Readonly<{
  reserve: (
    input: ReserveProtectionCoverageInput,
    context: EventStoreContext,
  ) => Promise<ReserveProtectionCoverageResult>;
  settle: (
    input: SettleProtectionCoverageInput,
    context: EventStoreContext,
  ) => Promise<TerminalProtectionCoverageResult>;
  release: (
    input: ReleaseProtectionCoverageInput,
    context: EventStoreContext,
  ) => Promise<TerminalProtectionCoverageResult>;
  expire: (
    input: ExpireProtectionCoverageInput,
    context: EventStoreContext,
  ) => Promise<TerminalProtectionCoverageResult>;
  getPoolBalance: () => Promise<string>;
  getAvailability: ReturnType<typeof buildQueries>["getAvailability"];
  getCoverage: ReturnType<typeof buildQueries>["getCoverage"];
  listReconciliation: ReturnType<typeof buildQueries>["listReconciliation"];
  getMetrics: ReturnType<typeof buildQueries>["getMetrics"];
  projectors: readonly ProjectionHandlerSet[];
}>;

type ProtectionCoverageRuntimeDeps = Readonly<{
  eventStore: EventStore;
  db: PgQueryable;
  operationsRecorder?: Pick<SettlementOperationsRecorder, "record">;
}>;

function buildQueries(db: PgQueryable) {
  return {
    getAvailability: () => getProtectionCoverageAvailability(db),
    getCoverage: (coverageId: string) => getProtectionCoverage(db, coverageId),
    listReconciliation: (params?: Parameters<typeof listProtectionCoverageReconciliation>[1]) =>
      listProtectionCoverageReconciliation(db, params),
    getMetrics: (params?: Parameters<typeof getProtectionCoverageMetrics>[1]) =>
      getProtectionCoverageMetrics(db, params),
  };
}

export function createProtectionCoverageRuntime(deps: ProtectionCoverageRuntimeDeps): ProtectionCoverageServices {
  const operationsRecorder = deps.operationsRecorder ?? createNoopSettlementOperationsRecorder();
  const { commandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<ProtectionCoverageEvent>(),
    initialState: () => initialProtectionReserveState,
    evolve: evolveProtectionCoverage,
    decide: decideProtectionCoverage,
  });

  function recordSignal(
    kind:
      | "protection-coverage-reserved"
      | "protection-coverage-rejected"
      | "protection-coverage-settled"
      | "protection-coverage-released"
      | "protection-coverage-expired"
      | "protection-coverage-concurrency-conflict"
      | "protection-coverage-idempotent-retry",
    fields: Readonly<{ amount?: string; safeCategory?: string | null }> = {},
  ): void {
    void operationsRecorder.record({
      kind,
      amount: fields.amount,
      safeCategory: fields.safeCategory ?? undefined,
      occurredAt: new Date().toISOString(),
    });
  }

  /**
   * Executes one pool command with optimistic-concurrency retry. Because every
   * reservation for a currency folds into a single pool stream, a concurrent
   * write conflicts; the loser retries against the winner's committed state so
   * two approvals cannot overdraw. The `resolveCommand` callback is re-run per
   * attempt so the funded ceiling is re-read on retry.
   */
  async function runCommand(
    streamId: string,
    resolveCommand: () => Promise<ProtectionCoverageCommand>,
    context: EventStoreContext,
  ): Promise<Readonly<{ state: ProtectionReserveState; newEvents: readonly ProtectionCoverageEvent[] }>> {
    for (let attempt = 0; attempt < MAX_CONCURRENCY_RETRIES; attempt += 1) {
      try {
        const command = await resolveCommand();
        const result = await commandHandler({ streamId, command, context });
        return { state: result.state, newEvents: result.newEvents };
      } catch (error) {
        if (!isConcurrencyConflict(error)) {
          throw error;
        }
        recordSignal("protection-coverage-concurrency-conflict");
      }
    }
    throw new SettlementDomainError(
      "Protection coverage command could not be serialized after repeated concurrent writes.",
    );
  }

  async function reserve(
    input: ReserveProtectionCoverageInput,
    context: EventStoreContext,
  ): Promise<ReserveProtectionCoverageResult> {
    const streamId = protectionReserveStreamId(input.currencyCode);
    const { newEvents } = await runCommand(
      streamId,
      async () => {
        // Re-read the funded ceiling on every attempt (reversals may have moved it).
        const fundedAmount = await getProtectionReservePoolBalance(deps.db);
        return {
          type: "ReserveProtectionCoverage",
          coverageId: input.coverageId,
          remedyId: input.remedyId,
          supportRequestId: input.supportRequestId,
          requestedAmount: input.requestedAmount,
          currencyCode: input.currencyCode,
          policyVersion: input.policyVersion,
          reasonCode: input.reasonCode,
          idempotencyKey: input.idempotencyKey ?? `coverage-reserve:${input.coverageId}`,
          causationId: input.causationId ?? null,
          occurredAt: input.occurredAt ?? new Date().toISOString(),
          fundedAmount,
          policyLimitAmount: input.policyLimitAmount ?? null,
        } satisfies ProtectionCoverageCommand;
      },
      context,
    );

    const reserved = newEvents.find((event) => event.type === "settlement.protection-coverage.reserved.v1");
    if (reserved) {
      recordSignal("protection-coverage-reserved", { amount: reserved.data.reservedAmount });
      return {
        outcome: "reserved",
        coverageId: input.coverageId,
        currencyCode: input.currencyCode,
        reservedAmount: reserved.data.reservedAmount,
        rejectionReason: null,
      };
    }
    const rejectedEvent = newEvents.find((event) => event.type === "settlement.protection-coverage.rejected.v1");
    if (rejectedEvent) {
      const reason = rejectedEvent.data.reasonCode;
      recordSignal("protection-coverage-rejected", { safeCategory: reason });
      return {
        outcome: "rejected",
        coverageId: input.coverageId,
        currencyCode: input.currencyCode,
        reservedAmount: null,
        rejectionReason: reason,
      };
    }
    // No new events: an identical retry of an already-reserved coverage.
    recordSignal("protection-coverage-idempotent-retry");
    return {
      outcome: "already-reserved",
      coverageId: input.coverageId,
      currencyCode: input.currencyCode,
      reservedAmount: null,
      rejectionReason: null,
    };
  }

  async function settle(
    input: SettleProtectionCoverageInput,
    context: EventStoreContext,
  ): Promise<TerminalProtectionCoverageResult> {
    const streamId = protectionReserveStreamId(input.currencyCode);
    const { newEvents } = await runCommand(
      streamId,
      async () =>
        ({
          type: "SettleProtectionCoverage",
          coverageId: input.coverageId,
          refundId: input.refundId,
          platformFundedAmount: input.platformFundedAmount,
          sellerFundedAmount: input.sellerFundedAmount,
          currencyCode: input.currencyCode,
          policyVersion: input.policyVersion,
          idempotencyKey: input.idempotencyKey ?? `coverage-settle:${input.coverageId}`,
          causationId: input.causationId ?? null,
          occurredAt: input.occurredAt ?? new Date().toISOString(),
        }) satisfies ProtectionCoverageCommand,
      context,
    );
    if (newEvents.length === 0) {
      recordSignal("protection-coverage-idempotent-retry");
      return { outcome: "noop", coverageId: input.coverageId };
    }
    recordSignal("protection-coverage-settled", { amount: input.platformFundedAmount });
    return { outcome: "applied", coverageId: input.coverageId };
  }

  async function release(
    input: ReleaseProtectionCoverageInput,
    context: EventStoreContext,
  ): Promise<TerminalProtectionCoverageResult> {
    const streamId = protectionReserveStreamId(input.currencyCode);
    const { newEvents } = await runCommand(
      streamId,
      async () =>
        ({
          type: "ReleaseProtectionCoverage",
          coverageId: input.coverageId,
          releaseReason: input.releaseReason,
          policyVersion: input.policyVersion,
          idempotencyKey: input.idempotencyKey ?? `coverage-release:${input.coverageId}`,
          causationId: input.causationId ?? null,
          occurredAt: input.occurredAt ?? new Date().toISOString(),
        }) satisfies ProtectionCoverageCommand,
      context,
    );
    if (newEvents.length === 0) {
      recordSignal("protection-coverage-idempotent-retry");
      return { outcome: "noop", coverageId: input.coverageId };
    }
    recordSignal("protection-coverage-released");
    return { outcome: "applied", coverageId: input.coverageId };
  }

  async function expire(
    input: ExpireProtectionCoverageInput,
    context: EventStoreContext,
  ): Promise<TerminalProtectionCoverageResult> {
    const streamId = protectionReserveStreamId(input.currencyCode);
    const { newEvents } = await runCommand(
      streamId,
      async () =>
        ({
          type: "ExpireProtectionCoverage",
          coverageId: input.coverageId,
          policyVersion: input.policyVersion,
          idempotencyKey: input.idempotencyKey ?? `coverage-expire:${input.coverageId}`,
          causationId: input.causationId ?? null,
          deadline: input.deadline,
          occurredAt: input.occurredAt ?? new Date().toISOString(),
        }) satisfies ProtectionCoverageCommand,
      context,
    );
    if (newEvents.length === 0) {
      recordSignal("protection-coverage-idempotent-retry");
      return { outcome: "noop", coverageId: input.coverageId };
    }
    recordSignal("protection-coverage-expired");
    return { outcome: "applied", coverageId: input.coverageId };
  }

  const queries = buildQueries(deps.db);

  return {
    reserve,
    settle,
    release,
    expire,
    getPoolBalance: () => getProtectionReservePoolBalance(deps.db),
    getAvailability: queries.getAvailability,
    getCoverage: queries.getCoverage,
    listReconciliation: queries.listReconciliation,
    getMetrics: queries.getMetrics,
    projectors: [
      createProjectionHandlerSet({
        projectionName: "settlement-protection-coverage-projection",
        handlers: buildProtectionCoverageProjectionHandlers(deps.db),
      }),
    ],
  };
}
