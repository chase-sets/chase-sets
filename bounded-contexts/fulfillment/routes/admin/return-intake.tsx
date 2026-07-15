import { createId } from "@chase-sets/primitives/typed-ids";
import { t } from "@chase-sets/localization";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { defineFormAction, type FormActionContext } from "@chase-sets/platform-runtime/http";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useNavigation, useSearchParams } from "react-router";
import { FacilityIntakePage } from "../../features/return-shipments/ui/facility-intake-page";
import { createFulfillmentRequestApiClient, FulfillmentApiError } from "../../support/request-support/api-client";

const emptyMetrics = {
  delivered_not_intaken_count: 0,
  oldest_delivered_not_intaken_age_seconds: 0,
  completed_intake_count: 0,
  discrepancy_count: 0,
  discrepancy_rate: 0,
  unidentified_package_count: 0,
  duplicate_scan_count: 0,
  average_intake_latency_seconds: 0,
};

function value(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function optionalNumber(formData: FormData, key: string): number | null {
  const raw = value(formData, key);
  return raw ? Number(raw) : null;
}

function timestamp(value: string): string {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
}

function actionError(error: unknown): string {
  if (error instanceof FulfillmentApiError && error.status === 409) {
    return t("fulfillment.returnIntake.route.stale");
  }
  return error instanceof Error ? error.message : t("fulfillment.returnIntake.route.failed");
}

async function uploadEvidence(
  api: ReturnType<typeof createFulfillmentRequestApiClient>,
  formData: FormData,
  facilityId: string,
) {
  const files = formData.getAll("evidence").filter((entry): entry is File => entry instanceof File && entry.size > 0);
  const uploaded = [];
  for (const file of files) {
    const result = await api.uploadReturnIntakeEvidence(facilityId, file);
    uploaded.push(result.attachment);
  }
  return uploaded;
}

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "return-intake.view" });
  const url = new URL(request.url);
  const facilityId = url.searchParams.get("facilityId")?.trim() ?? "";
  const identifier = url.searchParams.get("identifier")?.trim() ?? "";
  if (!facilityId) {
    return {
      facilityId,
      queue: [],
      unidentified: [],
      metrics: emptyMetrics,
      resolved: null,
      expectedVersion: null,
      formToken: createId("rii"),
    };
  }
  const api = createFulfillmentRequestApiClient(request);
  const queue = await api.getReturnIntakeQueue(facilityId);
  if (!identifier) {
    return {
      facilityId,
      queue: queue.items,
      unidentified: queue.unidentified,
      metrics: queue.metrics,
      resolved: null,
      expectedVersion: null,
      formToken: createId("rii"),
    };
  }
  try {
    const resolution = await api.resolveReturnIntake(identifier, facilityId);
    return {
      facilityId,
      queue: queue.items,
      unidentified: queue.unidentified,
      metrics: queue.metrics,
      resolved: resolution.shipment,
      expectedVersion: resolution.version,
      formToken: createId("rii"),
    };
  } catch (error) {
    if (error instanceof FulfillmentApiError && (error.status === 404 || error.status === 409)) {
      return {
        facilityId,
        queue: queue.items,
        unidentified: queue.unidentified,
        metrics: queue.metrics,
        resolved: null,
        expectedVersion: null,
        formToken: createId("rii"),
      };
    }
    throw error;
  }
}

async function handleAction(intent: string, { request, formData }: FormActionContext) {
  const api = createFulfillmentRequestApiClient(request);
  const facilityId = value(formData, "facilityId");
  const redirectBase = `/return-intake?facilityId=${encodeURIComponent(facilityId)}`;

  try {
    if (intent === "complete") {
      const evidence = await uploadEvidence(api, formData, facilityId);
      const discrepancyType = value(formData, "discrepancyType");
      const result = (await api.completeReturnIntake(value(formData, "returnShipmentId"), {
        facilityId,
        stationId: value(formData, "stationId"),
        receivedAt: timestamp(value(formData, "receivedAt")),
        packageCondition: value(formData, "packageCondition"),
        sealCondition: value(formData, "sealCondition"),
        measuredWeightOunces: optionalNumber(formData, "measuredWeightOunces"),
        evidence,
        discrepancies: [
          {
            type: discrepancyType,
            expectedItemReference: value(formData, "expectedItemReference") || null,
            observedItemReference: value(formData, "observedItemReference") || null,
            quantity: Number(value(formData, "quantity") || 1),
            notes: value(formData, "notes") || null,
            evidenceAttachmentIds: evidence.map((attachment) => attachment.attachmentId),
            owner: value(formData, "owner"),
            nextAction: value(formData, "nextAction"),
          },
        ],
        disposition: value(formData, "disposition"),
        custodyIdentifier: value(formData, "custodyIdentifier"),
        idempotencyKey: value(formData, "idempotencyKey"),
        expectedVersion: Number(value(formData, "expectedVersion")),
      })) as { duplicate?: boolean };
      return redirect(`${redirectBase}&result=${result.duplicate ? "duplicate" : "completed"}`);
    }
    if (intent === "unidentified") {
      const evidence = await uploadEvidence(api, formData, facilityId);
      await api.recordUnidentifiedReturnPackage({
        facilityId,
        stationId: value(formData, "stationId"),
        receivedAt: timestamp(value(formData, "receivedAt")),
        packageCondition: value(formData, "packageCondition"),
        sealCondition: value(formData, "sealCondition"),
        measuredWeightOunces: optionalNumber(formData, "measuredWeightOunces"),
        evidence,
        custodyIdentifier: value(formData, "custodyIdentifier"),
        notes: value(formData, "notes") || null,
        owner: value(formData, "owner"),
        nextAction: value(formData, "nextAction"),
      });
      return redirect(`${redirectBase}&result=unidentified`);
    }
    if (intent === "reconcile") {
      await api.reconcileUnidentifiedReturnPackage(value(formData, "unidentifiedPackageId"), {
        returnShipmentId: value(formData, "returnShipmentId"),
        reason: value(formData, "reason"),
      });
      return redirect(`${redirectBase}&result=reconciled`);
    }
    if (intent === "correct") {
      await api.correctReturnIntake(value(formData, "returnShipmentId"), {
        facilityId,
        expectedVersion: Number(value(formData, "expectedVersion")),
        correctionId: createId("ric"),
        reason: value(formData, "reason"),
        owner: value(formData, "owner") || null,
        nextAction: value(formData, "nextAction") || null,
        custodyIdentifier: value(formData, "custodyIdentifier") || null,
      });
      return redirect(`${redirectBase}&result=corrected`);
    }
    return { error: t("fulfillment.returnIntake.route.chooseAction") };
  } catch (error) {
    return { error: actionError(error) };
  }
}

export const action = defineFormAction({
  authorization: { permission: "return-intake.manage" },
  intents: {
    complete: (context) => handleAction("complete", context),
    unidentified: (context) => handleAction("unidentified", context),
    reconcile: (context) => handleAction("reconcile", context),
    correct: (context) => handleAction("correct", context),
  },
  onUnknownIntent: () => ({ error: t("fulfillment.returnIntake.route.chooseAction") }),
});

export const meta: MetaFunction = () => [{ title: t("fulfillment.returnIntake.route.metaTitle") }];

export default function FacilityReturnIntakeRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const result = searchParams.get("result");
  return (
    <FacilityIntakePage
      {...data}
      actionError={actionData && "error" in actionData ? actionData.error : null}
      actionResult={
        result === "completed" ||
        result === "duplicate" ||
        result === "unidentified" ||
        result === "reconciled" ||
        result === "corrected"
          ? result
          : null
      }
      submitting={navigation.state !== "idle"}
    />
  );
}
