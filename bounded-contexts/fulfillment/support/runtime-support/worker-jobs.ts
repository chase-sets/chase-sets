import type { WorkerRunner } from "@chase-sets/bounded-context-module";

import { createScheduledJobRunner, type WorkerJobInput } from "@chase-sets/platform-runtime/worker-jobs";
import type { FulfillmentServices } from "./services";

const SYSTEM_CONTEXT = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: "usr_identity_system" as never,
    forAccountId: "acc_identity_system" as never,
  },
};

type CreateFulfillmentPostageOperationReconciliationRunnersConfig = Readonly<{}>;
export function createFulfillmentPostageOperationReconciliationRunners({
  services,
  controlPlane,
  logger,
}: Pick<
  WorkerJobInput<CreateFulfillmentPostageOperationReconciliationRunnersConfig>,
  "services" | "controlPlane" | "logger"
>): readonly WorkerRunner[] {
  const fulfillment = services.fulfillment as FulfillmentServices | undefined;
  const runners: WorkerRunner[] = [];
  if (
    fulfillment?.shipments?.listStalePostageOperationLocators &&
    typeof fulfillment.shipments.reconcilePostageOperationLocator === "function"
  ) {
    runners.push(
      createScheduledJobRunner(
        "fulfillment.postage-operation-reconciliation",
        5 * 60 * 1000,
        controlPlane,
        async () => {
          const staleBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
          let afterUpdatedAt: string | null = null;
          let afterOperationId: string | null = null;
          let checked = 0;
          let quarantined = 0;
          while (true) {
            const locators = await fulfillment.shipments!.listStalePostageOperationLocators!({
              staleBefore,
              afterUpdatedAt,
              afterOperationId,
              limit: 100,
            });
            for (const locator of locators) {
              const result = await fulfillment.shipments!.reconcilePostageOperationLocator!(locator);
              checked += 1;
              if (result.outcome === "quarantined") quarantined += 1;
            }
            if (locators.length < 100) break;
            const last = locators.at(-1)!;
            afterUpdatedAt = last.updatedAt;
            afterOperationId = last.operationId;
          }
          logger.info("Fulfillment postage operation reconciliation completed.", {
            type: "fulfillment.postage-operation-reconciliation",
            checked,
            quarantined,
          });
          return checked;
        },
      ),
    );
  } else if (fulfillment?.shipments?.reconcileStalePostageLabelPurchases) {
    runners.push(
      createScheduledJobRunner(
        "fulfillment.postage-label-purchase-reconciliation",
        5 * 60 * 1000,
        controlPlane,
        async () => {
          const result = await fulfillment.shipments!.reconcileStalePostageLabelPurchases!({
            staleAfterMs: 5 * 60 * 1000,
            limit: 100,
          });
          logger.info("Fulfillment postage label purchase reconciliation completed.", {
            type: "fulfillment.postage-label-purchase-reconciliation",
            result,
          });
          return result.checked;
        },
      ),
    );
  }
  return runners;
}

type CreateFulfillmentPostageLabelVoidReconciliationRunnersConfig = Readonly<{}>;
export function createFulfillmentPostageLabelVoidReconciliationRunners({
  services,
  controlPlane,
  logger,
}: Pick<
  WorkerJobInput<CreateFulfillmentPostageLabelVoidReconciliationRunnersConfig>,
  "services" | "controlPlane" | "logger"
>): readonly WorkerRunner[] {
  const fulfillment = services.fulfillment as FulfillmentServices | undefined;
  const runners: WorkerRunner[] = [];
  if (fulfillment?.shipments?.reconcileStalePostageLabelVoids) {
    runners.push(
      createScheduledJobRunner(
        "fulfillment.postage-label-void-reconciliation",
        5 * 60 * 1000,
        controlPlane,
        async () => {
          const result = await fulfillment.shipments!.reconcileStalePostageLabelVoids!({
            staleAfterMs: 24 * 60 * 60 * 1000,
            limit: 100,
          });
          logger.info("Fulfillment postage label void reconciliation completed.", {
            type: "fulfillment.postage-label-void-reconciliation",
            result,
          });
          return result.checked;
        },
      ),
    );
  }
  return runners;
}

type CreateFulfillmentReturnShipmentDeadlineSweepRunnersConfig = Readonly<{}>;
export function createFulfillmentReturnShipmentDeadlineSweepRunners({
  services,
  controlPlane,
  logger,
}: Pick<
  WorkerJobInput<CreateFulfillmentReturnShipmentDeadlineSweepRunnersConfig>,
  "services" | "controlPlane" | "logger"
>): readonly WorkerRunner[] {
  const fulfillment = services.fulfillment as FulfillmentServices | undefined;
  const runners: WorkerRunner[] = [];
  if (fulfillment?.returnShipments?.sweepReturnShipmentDeadlines) {
    runners.push(
      createScheduledJobRunner("fulfillment.return-shipment-deadline-sweep", 5 * 60 * 1000, controlPlane, async () => {
        const result = await fulfillment.returnShipments!.sweepReturnShipmentDeadlines!({ limit: 100 }, SYSTEM_CONTEXT);
        logger.info("Fulfillment return-shipment deadline sweep completed.", {
          type: "fulfillment.return-shipment-deadline-sweep",
          result,
        });
        return result.checked;
      }),
    );
  }
  return runners;
}

type CreateFulfillmentReturnLabelPurchaseReconciliationRunnersConfig = Readonly<{}>;
export function createFulfillmentReturnLabelPurchaseReconciliationRunners({
  services,
  controlPlane,
  logger,
}: Pick<
  WorkerJobInput<CreateFulfillmentReturnLabelPurchaseReconciliationRunnersConfig>,
  "services" | "controlPlane" | "logger"
>): readonly WorkerRunner[] {
  const fulfillment = services.fulfillment as FulfillmentServices | undefined;
  const runners: WorkerRunner[] = [];
  if (fulfillment?.returnShipments?.labelPurchase?.reconcileStaleReturnLabelPurchases) {
    runners.push(
      createScheduledJobRunner(
        "fulfillment.return-label-purchase-reconciliation",
        5 * 60 * 1000,
        controlPlane,
        async () => {
          const result = await fulfillment.returnShipments!.labelPurchase!.reconcileStaleReturnLabelPurchases!({
            staleAfterMs: 5 * 60 * 1000,
            limit: 100,
          });
          logger.info("Fulfillment return-label purchase reconciliation completed.", {
            type: "fulfillment.return-label-purchase-reconciliation",
            result,
          });
          return result.checked;
        },
      ),
    );
  }
  return runners;
}
