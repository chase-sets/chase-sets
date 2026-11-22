import { describe, expect, it, vi } from "vitest";
import { getEventCommitMetadata, runWithEventCommitMetadata } from "@chase-sets/event-core/consistency";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { productAlertStreamId } from "../domain/domain";
import { createProductAlertRuntime } from "./runtime";

const checkpointStore: ProjectionCheckpointStore = {
  loadCheckpoint: async () => ZERO_GLOBAL_POSITION,
  saveCheckpoint: async () => {},
};

const context = {
  tenantId: "tnt_discovery" as never,
  audit: { performedByUserId: "usr_buyer" as never, forAccountId: "acc_buyer" as never },
};

const ATTEMPT = "chkentry_01JZ0000000000000000000000";

const request = {
  accountId: "acc_buyer",
  marketSide: "listing" as const,
  catalogItemId: "cat_1",
  productId: "cat_1::dim_form:chc_raw",
  selectedOptions: [{ dimensionId: "dim_form", optionId: "chc_raw" }],
  productSummary: "Raw",
  thresholdAmount: "300.00",
  thresholdCurrencyCode: "USD",
};

const productSchema = {
  canonicalDimensionOrder: [{ dimensionId: "dim_form", dimensionName: "Form" }],
  dimensions: [
    {
      dimensionId: "dim_form",
      dimensionName: "Form",
      valueKind: "unordered",
      required: true,
      appliesWhen: [],
      allowedOptions: [{ optionId: "chc_raw", code: "raw", label: "Raw", displayOrder: 1, numericValue: null }],
    },
  ],
};

function setUp() {
  const { eventStore } = createInMemoryEventStore();
  const query = vi.fn(async (sql: string, params: readonly unknown[] = []) =>
    sql.includes("FROM discovery_item_detail_pages") && params[0] === "cat_1"
      ? { rows: [{ catalog_item_id: "cat_1", status: "active", product_schema: productSchema }] }
      : { rows: [] },
  );
  const services = createProductAlertRuntime({ eventStore, checkpointStore, db: { query } as never });
  const created = async () =>
    (await eventStore.readAll()).filter((event) => event.eventType === "discovery.product-alert.created");
  return { services, created };
}

describe("an account Product Alert create attempt", () => {
  it("answers the alert the first send created when the same attempt is sent again", async () => {
    const { services, created } = setUp();

    const first = await services.createProductAlert({ ...request, attemptId: ATTEMPT }, context);
    const again = await runWithEventCommitMetadata(async () => {
      const answer = await services.createProductAlert({ ...request, attemptId: ATTEMPT }, context);
      return { answer, receipt: getEventCommitMetadata() };
    });

    expect(again.answer).toEqual(first);
    expect(first).toMatchObject({ status: "active", version: 1 });
    expect(await created()).toHaveLength(1);
    // The resend's receipt is the created event, so the page after it reads that alert.
    const [event] = await created();
    expect(again.receipt.eventIds).toEqual([String(event!.eventId)]);
  });

  it("creates the alert once when the same attempt is sent concurrently", async () => {
    const { services, created } = setUp();

    const answers = await Promise.all([
      services.createProductAlert({ ...request, attemptId: ATTEMPT }, context),
      services.createProductAlert({ ...request, attemptId: ATTEMPT }, context),
    ]);

    expect(answers[1]!.alertId).toBe(answers[0]!.alertId);
    expect(await created()).toHaveLength(1);
  });

  it("is the same alert whatever spacing, case and money format the same request is sent with", async () => {
    const { services, created } = setUp();

    const first = await services.createProductAlert({ ...request, attemptId: ATTEMPT }, context);
    const again = await services.createProductAlert(
      {
        ...request,
        attemptId: ` ${ATTEMPT} `,
        productId: " cat_1::dim_form:chc_raw ",
        thresholdAmount: "300",
        thresholdCurrencyCode: "usd",
        productSummary: "Raw / Near Mint",
      },
      context,
    );

    expect(again.alertId).toBe(first.alertId);
    expect(await created()).toHaveLength(1);
  });

  it("creates another alert when the same attempt is sent with a different request or by another account", async () => {
    const { services, created } = setUp();

    const first = await services.createProductAlert({ ...request, attemptId: ATTEMPT }, context);
    const otherPrice = await services.createProductAlert(
      { ...request, attemptId: ATTEMPT, thresholdAmount: "250.00" },
      context,
    );
    const otherSide = await services.createProductAlert(
      { ...request, attemptId: ATTEMPT, marketSide: "offer" },
      context,
    );
    const otherAccount = await services.createProductAlert(
      { ...request, attemptId: ATTEMPT, accountId: "acc_other" },
      context,
    );

    expect(new Set([first.alertId, otherPrice.alertId, otherSide.alertId, otherAccount.alertId]).size).toBe(4);
    expect(await created()).toHaveLength(4);
  });

  it("answers the attempt's alert as it now is after it was deleted", async () => {
    const { services, created } = setUp();
    const first = await services.createProductAlert({ ...request, attemptId: ATTEMPT }, context);
    await services.commandHandler({
      streamId: productAlertStreamId(first.alertId),
      context,
      command: { type: "DeleteProductAlert" },
    });

    const again = await services.createProductAlert({ ...request, attemptId: ATTEMPT }, context);

    expect(again).toEqual({ alertId: first.alertId, version: 2, status: "deleted" });
    expect(await created()).toHaveLength(1);
  });

  it("refuses an attempt id it cannot take and creates nothing", async () => {
    const { services, created } = setUp();

    await expect(services.createProductAlert({ ...request, attemptId: "short" }, context)).rejects.toThrow(
      "Product Alert attempt id is invalid.",
    );
    await expect(services.createProductAlert({ ...request, attemptId: "a".repeat(22) + "/" }, context)).rejects.toThrow(
      "Product Alert attempt id is invalid.",
    );
    expect(await created()).toHaveLength(0);
  });

  it("still refuses a request the alert cannot record, with the alert's own message", async () => {
    const { services, created } = setUp();

    await expect(
      services.createProductAlert({ ...request, attemptId: ATTEMPT, thresholdCurrencyCode: null }, context),
    ).rejects.toThrow("Product Alert threshold must include both amount and currency.");
    expect(await created()).toHaveLength(0);
  });

  it("creates a new alert for each create sent without an attempt", async () => {
    const { services, created } = setUp();

    const first = await services.createProductAlert(request, context);
    const second = await services.createProductAlert({ ...request, attemptId: null }, context);

    expect(second.alertId).not.toBe(first.alertId);
    expect(await created()).toHaveLength(2);
  });
});
