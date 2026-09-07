import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { resolveMarketStatHygienePolicyRevisionAsOf } from "../../market-rollups/read-model/stat-hygiene-policy-revision";
import { configurationInvalidCapture, mapProviderObservationCapture } from "../domain/provider-observation-mapper";
import {
  resolveProviderObservationPolicyRevisionAsOf,
  type ProviderObservationPolicyRevision,
} from "../domain/provider-observation-policy";
import { resolvePriceSignalPolicyRevisionAsOf, type PriceSignalPolicyRevision } from "../domain/price-signal-policy";
import {
  isTcgplayerMarketCaptureReceiptSink,
  sanitizeTcgplayerMarketCaptureReceipt,
  type TcgplayerMarketCaptureReceiptSinkCapability,
} from "../integrations/tcgplayer/capture-sanitizer";
import { createTcgplayerMarketClient } from "../integrations/tcgplayer/market-client";
import {
  isTcgplayerMarketTransport,
  type TcgplayerMarketTransportCapability,
} from "../integrations/tcgplayer/transport-port";
import {
  commitProviderObservationCapture,
  selectMarketCaptureSignalWork,
  type MarketCaptureWorkItem,
} from "../read-model/provider-observation-writes";
import type { TcgplayerPriceSignalInput, TcgplayerPriceSignalRecordResult } from "./runtime";

const PROVIDER_KEY = "tcgplayer";

export type MarketCapturePassResult = Readonly<{
  status: "completed" | "configuration-invalid" | "disabled" | "retryable-abort";
  reason: "none" | "signal-policy-invalid" | "transport-not-mounted" | "signal-write-failed" | "capture-write-failed";
  signalWorkCount: number;
  signalsRecorded: number;
  signalsUnresolved: number;
  capturesCommitted: number;
}>;

export type MarketCaptureDeps = Readonly<{
  pool: PgTransactionalPool;
  transport: TcgplayerMarketTransportCapability;
  recordTcgplayerPriceSignal: (input: TcgplayerPriceSignalInput) => Promise<TcgplayerPriceSignalRecordResult>;
  now?: () => string;
  resolveSignalPolicy?: (instant: string) => Promise<PriceSignalPolicyRevision | null>;
  resolveObservationPolicy?: (instant: string) => Promise<ProviderObservationPolicyRevision | null>;
  resolveStatHygienePolicy?: (instant: string) => Promise<Readonly<{ revisionId: string }> | null>;
  receiptSink: TcgplayerMarketCaptureReceiptSinkCapability;
}>;

export function createTcgplayerMarketCapture(deps: MarketCaptureDeps) {
  const now = deps.now ?? (() => new Date().toISOString());
  const resolveSignal =
    deps.resolveSignalPolicy ?? ((instant) => resolvePriceSignalPolicyRevisionAsOf(deps.pool, instant));
  const resolveObservation =
    deps.resolveObservationPolicy ?? ((instant) => resolveProviderObservationPolicyRevisionAsOf(deps.pool, instant));
  const resolveStat =
    deps.resolveStatHygienePolicy ?? ((instant) => resolveMarketStatHygienePolicyRevisionAsOf(deps.pool, instant));

  return async function runTcgplayerMarketCapture(): Promise<MarketCapturePassResult> {
    const signalPassStartedAt = now();
    let signalPolicy: PriceSignalPolicyRevision | null;
    try {
      signalPolicy = await resolveSignal(signalPassStartedAt);
    } catch {
      signalPolicy = null;
    }
    if (!signalPolicy) return result("configuration-invalid", "signal-policy-invalid");
    if (!isTcgplayerMarketTransport(deps.transport)) return result("disabled", "transport-not-mounted");

    const work = await selectMarketCaptureSignalWork(deps.pool, PROVIDER_KEY, signalPolicy.value.productsPerPass);
    if (work.length === 0) return result("completed", "none");
    const client = createTcgplayerMarketClient(deps.transport);
    const allSkuIds = work.flatMap((item) => item.skus.map((sku) => sku.skuId));
    let points: Awaited<ReturnType<typeof client.fetchPricePoints>>;
    try {
      points = await client.fetchPricePoints(allSkuIds);
    } catch {
      return { ...result("retryable-abort", "signal-write-failed"), signalWorkCount: work.length };
    }

    const perProductCounts = new Map<string, { recorded: number; unresolved: number }>();
    let signalsRecorded = 0;
    let signalsUnresolved = 0;
    try {
      // This complete loop is the essential arm. No capture authority is read
      // and no capture timestamp exists until every selected write settles.
      for (const item of work) {
        const counts = { recorded: 0, unresolved: 0 };
        for (const sku of item.skus) {
          const pricePoint = points.get(sku.skuId) ?? null;
          const recorded = await deps.recordTcgplayerPriceSignal({
            skuId: sku.skuId,
            observedAt: now(),
            pricePoint,
          });
          if (recorded.status === "recorded") {
            counts.recorded += 1;
            signalsRecorded += 1;
          } else {
            counts.unresolved += 1;
            signalsUnresolved += 1;
          }
        }
        perProductCounts.set(item.productExternalKey, counts);
      }
    } catch {
      return {
        status: "retryable-abort",
        reason: "signal-write-failed",
        signalWorkCount: work.length,
        signalsRecorded,
        signalsUnresolved,
        capturesCommitted: 0,
      };
    }

    // Exactly one post-signal instant freezes every authority for the capture arm.
    const captureStartedAt = now();
    let observationPolicy: ProviderObservationPolicyRevision | null = null;
    let statHygienePolicy: Readonly<{ revisionId: string }> | null = null;
    let invalidReason: "observation-policy-invalid" | "stat-hygiene-policy-invalid" | null = null;
    try {
      observationPolicy = await resolveObservation(captureStartedAt);
      if (!observationPolicy) invalidReason = "observation-policy-invalid";
    } catch {
      invalidReason = "observation-policy-invalid";
    }
    if (!invalidReason) {
      try {
        statHygienePolicy = await resolveStat(captureStartedAt);
        if (!statHygienePolicy) invalidReason = "stat-hygiene-policy-invalid";
      } catch {
        invalidReason = "stat-hygiene-policy-invalid";
      }
    }

    let capturesCommitted = 0;
    if (invalidReason) {
      for (const item of work) {
        const counts = perProductCounts.get(item.productExternalKey)!;
        const capture = configurationInvalidCapture({
          providerKey: PROVIDER_KEY,
          catalogItemId: item.catalogItemId,
          productExternalKey: item.productExternalKey,
          signalPassStartedAt,
          signalPolicy,
          captureStartedAt,
          completedAt: now(),
          observationPolicyRevisionId: observationPolicy?.revisionId ?? null,
          statHygienePolicyRevisionId: statHygienePolicy?.revisionId ?? null,
          capturesPerPass: observationPolicy?.value.capturesPerPass ?? null,
          currency: observationPolicy?.value.currency ?? null,
          recordedSignalCount: counts.recorded,
          unresolvedSignalCount: counts.unresolved,
          reasonCode: invalidReason,
        });
        try {
          const committed = await commitProviderObservationCapture(deps.pool, PROVIDER_KEY, item, capture);
          if (committed !== "committed") break;
          capturesCommitted += 1;
        } catch {
          return {
            status: "retryable-abort",
            reason: "capture-write-failed",
            signalWorkCount: work.length,
            signalsRecorded,
            signalsUnresolved,
            capturesCommitted,
          };
        }
      }
      return {
        status: "configuration-invalid",
        reason: "none",
        signalWorkCount: work.length,
        signalsRecorded,
        signalsUnresolved,
        capturesCommitted,
      };
    }

    const secondary = work.slice(0, observationPolicy!.value.capturesPerPass);
    for (const item of secondary) {
      const counts = perProductCounts.get(item.productExternalKey)!;
      const fetched = await client.fetchSecondary({
        productId: item.productId,
        policy: observationPolicy!.value,
        now,
      });
      const capture = mapProviderObservationCapture({
        providerKey: PROVIDER_KEY,
        catalogItemId: item.catalogItemId,
        productExternalKey: item.productExternalKey,
        catalogProductKeysBySku: new Map(item.skus.map((sku) => [sku.skuId, sku.catalogProductKey])),
        signalPassStartedAt,
        signalPolicy,
        captureStartedAt,
        captureCompletedAt: now(),
        observationPolicy: observationPolicy!,
        statHygienePolicyRevisionId: statHygienePolicy!.revisionId,
        authenticatedRequest: true,
        recordedSignalCount: counts.recorded,
        unresolvedSignalCount: counts.unresolved,
        observation: fetched.observation,
      });
      try {
        const committed = await commitProviderObservationCapture(deps.pool, PROVIDER_KEY, item, capture);
        if (committed !== "committed") break;
        capturesCommitted += 1;
      } catch {
        return {
          status: "retryable-abort",
          reason: "capture-write-failed",
          signalWorkCount: work.length,
          signalsRecorded,
          signalsUnresolved,
          capturesCommitted,
        };
      }
      if (isTcgplayerMarketCaptureReceiptSink(deps.receiptSink)) {
        await deps.receiptSink.retain(
          sanitizeTcgplayerMarketCaptureReceipt(capture, fetched.responseFieldSummary),
        );
      }
    }
    return {
      status: "completed",
      reason: "none",
      signalWorkCount: work.length,
      signalsRecorded,
      signalsUnresolved,
      capturesCommitted,
    };
  };
}

function result(
  status: MarketCapturePassResult["status"],
  reason: MarketCapturePassResult["reason"],
): MarketCapturePassResult {
  return { status, reason, signalWorkCount: 0, signalsRecorded: 0, signalsUnresolved: 0, capturesCommitted: 0 };
}
