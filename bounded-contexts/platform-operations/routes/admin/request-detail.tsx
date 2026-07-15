import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useMatches, useSearchParams } from "react-router";
import { SupportOperationsDetailPage } from "../../features/support-requests/ui/support-operations-page";
import { createSupportRequestRequestApiClient } from "../../support/request-support/support-request-api-client";
import { resolveSupportRequestsMarketplaceOrigin } from "./requests";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("support.routes.admin.operationsRequestDetail.request.failed");
}

function formValue(formData: FormData, key: string) {
  return String(formData.get(key) ?? "");
}

function remedyBody(formData: FormData) {
  return {
    remedy: {
      kind: formValue(formData, "remedyKind"),
      amount: formValue(formData, "remedyAmount"),
      currencyCode: formValue(formData, "currencyCode"),
    },
    allocation: {
      sellerFundedAmount: formValue(formData, "sellerFundedAmount"),
      platformFundedAmount: formValue(formData, "platformFundedAmount"),
      currencyCode: formValue(formData, "currencyCode"),
      fundingKind: formValue(formData, "fundingKind"),
    },
    returnDirective: formValue(formData, "returnDirective"),
    refundTrigger: formValue(formData, "refundTrigger"),
    reasonCode: formValue(formData, "reasonCode"),
    returnExceptionReasonCode: formValue(formData, "returnExceptionReasonCode") || null,
    rationale: formValue(formData, "rationale"),
    evidenceReferences: formValue(formData, "evidenceReferences"),
    idempotencyKey: formValue(formData, "idempotencyKey"),
  };
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createSupportRequestRequestApiClient(request);
  return {
    supportRequest: await api.getSupportOperationsRequest(params.id ?? ""),
    marketplaceOrigin: resolveSupportRequestsMarketplaceOrigin(),
  };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const supportRequestId = params.id ?? "";
  const api = createSupportRequestRequestApiClient(request);
  const formData = await request.formData();
  const intent = formValue(formData, "intent");

  try {
    if (intent === "note") {
      await api.recordSupportOperationsNote(supportRequestId, {
        summary: formValue(formData, "summary"),
      });
      return redirect(`/support/requests/${supportRequestId}?action=note`);
    }

    if (intent === "response") {
      await api.recordSupportOperationsResponse(supportRequestId, {
        responseType: formValue(formData, "responseType"),
        summary: formValue(formData, "summary"),
      });
      return redirect(`/support/requests/${supportRequestId}?action=response`);
    }

    if (intent === "escalate") {
      await api.escalateSupportOperationsRequest(supportRequestId, {
        reason: formValue(formData, "reason"),
      });
      return redirect(`/support/requests/${supportRequestId}?action=escalate`);
    }

    if (intent === "resolve") {
      const [responsibility = "", responsibilityReasonCode = ""] = formValue(formData, "responsibilityFinding").split(
        "|",
        2,
      );
      const evidenceBasisType = formValue(formData, "evidenceBasisType");
      await api.resolveSupportOperationsRequest(supportRequestId, {
        resolutionType: formValue(formData, "resolutionType"),
        summary: formValue(formData, "summary"),
        refundAmount: formValue(formData, "refundAmount") || null,
        responsibility,
        evidenceBasis: {
          type: evidenceBasisType,
          reference:
            evidenceBasisType === "insufficient-evidence"
              ? "support-workbench.insufficient-evidence.v1"
              : "support-workbench.operator-adjudication.v1",
        },
        responsibilityReasonCode,
      });
      return redirect(`/support/requests/${supportRequestId}?action=resolve`);
    }

    if (intent === "close") {
      await api.closeSupportOperationsRequest(supportRequestId);
      return redirect(`/support/requests/${supportRequestId}?action=close`);
    }

    if (intent === "cancel") {
      await api.cancelSupportOperationsRequest(supportRequestId, {
        reason: formValue(formData, "reason"),
      });
      return redirect(`/support/requests/${supportRequestId}?action=cancel`);
    }

    if (intent === "preview-remedy") {
      const input = remedyBody(formData);
      return { preview: await api.previewRemedyProposal(supportRequestId, input), proposalInput: input };
    }

    if (intent === "propose-remedy") {
      await api.proposeRemedy(supportRequestId, remedyBody(formData));
      return redirect(`/support/requests/${supportRequestId}?action=remedy-proposed`);
    }

    if (intent === "approve-remedy") {
      await api.approveRemedy(supportRequestId, {
        reasonCode: formValue(formData, "reasonCode"),
        rationale: formValue(formData, "rationale"),
        evidenceReferences: formValue(formData, "evidenceReferences"),
        idempotencyKey: formValue(formData, "idempotencyKey"),
      });
      return redirect(`/support/requests/${supportRequestId}?action=remedy-approved`);
    }

    if (intent === "retry-remedy-effect") {
      await api.retryRemedyEffect(supportRequestId, formValue(formData, "remedyId"), formValue(formData, "effect"), {
        reasonCode: formValue(formData, "reasonCode"),
        rationale: formValue(formData, "rationale"),
        idempotencyKey: formValue(formData, "idempotencyKey"),
      });
      return redirect(`/support/requests/${supportRequestId}?action=remedy-retry-requested`);
    }

    if (intent === "waive-remedy-effect") {
      await api.waiveRemedyEffect(supportRequestId, formValue(formData, "remedyId"), formValue(formData, "effect"), {
        reasonCode: formValue(formData, "reasonCode"),
        rationale: formValue(formData, "rationale"),
        evidenceReferences: formValue(formData, "evidenceReferences"),
        idempotencyKey: formValue(formData, "idempotencyKey"),
      });
      return redirect(`/support/requests/${supportRequestId}?action=remedy-effect-waived`);
    }

    if (intent === "release-remedy-refund") {
      await api.releaseRemedyRefund(supportRequestId, formValue(formData, "remedyId"), {
        reasonCode: formValue(formData, "reasonCode"),
        idempotencyKey: formValue(formData, "idempotencyKey"),
      });
      return redirect(`/support/requests/${supportRequestId}?action=remedy-refund-released`);
    }

    if (intent === "request-remedy-correction") {
      await api.requestRemedyCorrection(supportRequestId, {
        reasonCode: formValue(formData, "reasonCode"),
        rationale: formValue(formData, "rationale"),
        evidenceReferences: formValue(formData, "evidenceReferences"),
        idempotencyKey: formValue(formData, "idempotencyKey"),
      });
      return redirect(`/support/requests/${supportRequestId}?action=remedy-correction-requested`);
    }

    return null;
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  {
    title: data?.supportRequest
      ? t("support.routes.admin.operationsRequestDetail.meta.title", {
          id: data.supportRequest.display_reference || data.supportRequest.support_request_id,
        })
      : t("support.routes.admin.operationsQueue.meta.title"),
  },
];

export default function SupportOperationsRequestDetailRoute() {
  const { supportRequest, marketplaceOrigin } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [searchParams] = useSearchParams();
  const permissions = useMatches().flatMap((match) => {
    const actor = (match.data as { actor?: { permissions?: readonly string[] } } | undefined)?.actor;
    return actor?.permissions ?? [];
  });
  return (
    <SupportOperationsDetailPage
      request={supportRequest}
      actionError={actionData && "error" in actionData ? (actionData.error ?? null) : null}
      actionResult={searchParams.get("action")}
      marketplaceOrigin={marketplaceOrigin}
      actorPermissions={permissions}
      remedyPreview={actionData && "preview" in actionData ? actionData.preview : null}
      remedyProposalInput={actionData && "proposalInput" in actionData ? actionData.proposalInput : null}
    />
  );
}
