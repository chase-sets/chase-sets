import { describe, expect, it } from "vitest";
import { createPlatformApiBootstrapTestHarness } from "./bootstrap-db-test-support";
import {
  assignAuthoritativeSeedResumeState,
  contextEventCount,
  createHost,
  expectZeroRelationCaseEntry,
  ordinaryBoot,
  paymentStreamEventCounts,
  paymentStreamEventTypes,
  pools,
  replaceResolvedSeedRequestWithCancelled,
  requirePlatformOperationsContext,
  resolvedSeedSupportRequestId,
  seedOptions,
  supportRequestServices,
  supportRequestStreamEventTypes,
} from "./authoritative-seed-resume-test-support";

/**
 * Recovery truth for the authoritative seed-resume partition: a cancelled
 * resolution-bearing seed request that must stay incomplete, and the missing
 * review-eligible payment that must be recreated without touching its completed
 * sibling. Split out of the single `authoritative-seed-resume.db.test.ts` file
 * by #6520 with every case body byte-identical; only file and execution-unit
 * ownership changed.
 */
createPlatformApiBootstrapTestHarness(
  "platform_api_authoritative_seed_resume_recovery",
  assignAuthoritativeSeedResumeState,
);

describe("authoritative seed resume", () => {
  it("keeps a cancelled resolution-bearing seed request incomplete and does not silently repair it", async () => {
    await expectZeroRelationCaseEntry("cancelled seed request control");

    const runtime = createHost();
    await ordinaryBoot(runtime);
    const context = requirePlatformOperationsContext(runtime);
    await replaceResolvedSeedRequestWithCancelled(supportRequestServices(context));
    const supportRequestId = resolvedSeedSupportRequestId;
    const cancelledTypes = await supportRequestStreamEventTypes(supportRequestId);
    expect(cancelledTypes.at(-1)).toBe("support.support-request.cancelled");

    const beforeReconciliationEventCount = await contextEventCount("platform-operations");
    const beforeReconciliationReports = await context.module.inspectSeedState!(context.pool);
    expect(beforeReconciliationReports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: supportRequestId,
          kind: "draft",
          status: "cancelled",
        }),
      ]),
    );

    await expect(context.module.seed!(context.pool, context.services, seedOptions)).rejects.toThrow();
    expect(await contextEventCount("platform-operations")).toBe(beforeReconciliationEventCount);
    expect(await supportRequestStreamEventTypes(supportRequestId)).toEqual(cancelledTypes);
    const afterReconciliationReports = await context.module.inspectSeedState!(context.pool);
    expect(afterReconciliationReports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: supportRequestId,
          kind: "draft",
          status: "cancelled",
        }),
      ]),
    );
    console.log("[#6167 cancelled-control] inspection=draft seed-reentry=reject appends=0");
  }, 300_000);

  it("recreates only a missing review-eligible payment after a sibling payment has completed", async () => {
    await expectZeroRelationCaseEntry("review-eligible payment recreation");

    const runtime = createHost();
    await ordinaryBoot(runtime);

    const paymentsContext = runtime.mountedContexts.find((context) => context.contextName === "payments");
    if (!paymentsContext?.module.seed || !paymentsContext.module.inspectSeedState) {
      throw new Error("Payments context is not mounted with seed-state inspection.");
    }
    const paymentReports = (await paymentsContext.module.inspectSeedState(paymentsContext.pool)).filter(
      (report) => report.aggregateName === "Payment",
    );
    const reviewEligibleReport = paymentReports.find((report) => report.key === "review-eligible-captured");
    if (!reviewEligibleReport) {
      throw new Error("Payments seed-state inspection did not report the review-eligible payment.");
    }
    const paymentId = reviewEligibleReport.id;
    const paymentIds = paymentReports.map((report) => report.id);
    const streamId = reviewEligibleReport.streamId;
    const created = await pools.payments.query<Readonly<{ order_id: string }>>(
      `SELECT payload->'orderIds'->>0 AS order_id
       FROM event_store_events
       WHERE stream_id = $1
         AND event_type = 'payments.payment-created'`,
      [streamId],
    );
    const orderId = created.rows[0]?.order_id;
    expect(orderId, "review-eligible payment has no created order").toBeDefined();

    const beforeCrash = await paymentStreamEventCounts(paymentIds);
    expect(beforeCrash[paymentId]).toBeGreaterThan(0);

    await pools.payments.query("DELETE FROM event_store_aggregate_snapshots WHERE stream_id = $1", [streamId]);
    await pools.payments.query("DELETE FROM event_store_events WHERE stream_id = $1", [streamId]);
    await pools.payments.query(
      "UPDATE event_store_streams SET current_version = 0, updated_at = now() WHERE stream_id = $1",
      [streamId],
    );
    await pools.payments.query(
      `UPDATE payments_order_inputs
       SET status = 'pending-payment',
           ready_for_fulfillment_at = NULL
       WHERE order_id = $1`,
      [orderId],
    );
    expect((await paymentStreamEventCounts(paymentIds))[paymentId]).toBe(0);

    try {
      await paymentsContext.module.seed(paymentsContext.pool, paymentsContext.services, seedOptions);
    } catch (error) {
      console.log(
        `[#4906 F1 fail-before] error=${error instanceof Error ? error.message : String(error)} ` +
          `missing-stream-events=${(await paymentStreamEventCounts(paymentIds))[paymentId]}`,
      );
      throw error;
    }

    const afterRepair = await paymentStreamEventCounts(paymentIds);
    const siblingAppends = Object.fromEntries(
      Object.entries(afterRepair)
        .filter(([candidateId]) => candidateId !== paymentId)
        .map(([candidateId, count]) => [candidateId, count - (beforeCrash[candidateId] ?? 0)]),
    );
    expect(afterRepair[paymentId]).toBe(3);
    expect(await paymentStreamEventTypes(paymentId)).toEqual([
      "payments.payment-created",
      "payments.payment-captured",
      "payments.csat-outcome-fact.v1",
    ]);
    expect(siblingAppends).toEqual(
      Object.fromEntries(Object.keys(siblingAppends).map((candidateId) => [candidateId, 0])),
    );

    await paymentsContext.module.seed(paymentsContext.pool, paymentsContext.services, seedOptions);
    const afterSteadyState = await paymentStreamEventCounts(paymentIds);
    expect(afterSteadyState).toEqual(afterRepair);
    console.log(
      `[#4906 F1 pass-after] recreated-events=${afterRepair[paymentId]} ` +
        `sibling-appends=${JSON.stringify(siblingAppends)} next-invocation-appends=0`,
    );
  }, 300_000);
});
