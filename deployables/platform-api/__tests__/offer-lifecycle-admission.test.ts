import { afterEach, describe, expect, it, vi } from "vitest";
import { getObservabilityRuntime } from "@chase-sets/observability";
import { WORKER_CONSUMED_EVENT_TYPES_METADATA_KEY } from "@chase-sets/platform-runtime/worker-event-capability";
import { createOfferLifecycleAdmission } from "../src/offer-lifecycle-admission";

afterEach(() => vi.restoreAllMocks());

const snapshotAt = "2026-10-14T12:00:00.000Z";
const quiescedAt = "2026-10-14T11:00:00.000Z";
const heartbeat = (workerId: string, consumed?: readonly string[]) => ({
  worker_id: workerId,
  started_at: "2026-10-14T11:05:00.000Z",
  heartbeat_at: snapshotAt,
  metadata: consumed ? { [WORKER_CONSUMED_EVENT_TYPES_METADATA_KEY]: consumed } : {},
});
const capable = [
  "marketplace.offer.paused",
  "marketplace.offer.resumed",
  "marketplace.offer.submitted",
  "marketplace.offer.withdrawn",
];

describe("platform API Offer lifecycle admission", () => {
  it("stays closed by default and logs why", async () => {
    const info = vi.spyOn(getObservabilityRuntime().logger, "info");
    const query = vi.fn();
    await expect(createOfferLifecycleAdmission({ open: false, db: { query } as never }).check()).resolves.toEqual({
      admitted: false,
      reason: "switch_closed",
    });
    expect(query).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("offer_lifecycle_closed_refusal", {
      type: "offer_lifecycle_closed_refusal",
      reason: "switch_closed",
      workerIds: [],
    });
  });

  it("requires every worker since the deployment quiesce to read the Marketplace lifecycle events once the switch is open", async () => {
    const info = vi.spyOn(getObservabilityRuntime().logger, "info");
    let quiesced: string | null = null;
    let workers = [heartbeat("wrk_capable", capable), heartbeat("wrk_old")];
    const admission = createOfferLifecycleAdmission({
      open: true,
      db: {
        query: async () => ({
          rows: [{ snapshot_at: snapshotAt, quiesced_at: quiesced, workers, lease_owner_ids: [] }],
        }),
      } as never,
    });
    await expect(admission.check()).resolves.toMatchObject({ admitted: false, reason: "workers_not_quiesced" });
    quiesced = quiescedAt;
    await expect(admission.check()).resolves.toMatchObject({ admitted: false, reason: "worker_without_capability" });
    expect(info).toHaveBeenLastCalledWith("offer_lifecycle_closed_refusal", {
      type: "offer_lifecycle_closed_refusal",
      reason: "worker_without_capability",
      workerIds: ["wrk_old"],
    });
    workers = [heartbeat("wrk_capable", capable), heartbeat("wrk_missing_withdrawn", capable.slice(0, 3))];
    await expect(admission.check()).resolves.toMatchObject({ workerIds: ["wrk_missing_withdrawn"] });
    info.mockClear();
    workers = [heartbeat("wrk_capable", capable)];
    await expect(admission.check()).resolves.toEqual({ admitted: true });
    expect(info).not.toHaveBeenCalled();
  });
});
