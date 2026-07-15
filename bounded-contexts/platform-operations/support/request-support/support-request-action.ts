import type { createSupportRequestRequestApiClient } from "./support-request-api-client";

type SupportRequestApi = ReturnType<typeof createSupportRequestRequestApiClient>;

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

export type SupportRequestActionResult =
  | Readonly<{ kind: "completed"; action: string }>
  | Readonly<{
      kind: "preview";
      preview: Awaited<ReturnType<SupportRequestApi["previewRemedyProposal"]>>;
      proposalInput: ReturnType<typeof remedyBody>;
    }>;

export async function executeSupportRequestAction(
  api: SupportRequestApi,
  supportRequestId: string,
  formData: FormData,
): Promise<SupportRequestActionResult | null> {
  const intent = formValue(formData, "intent");

  switch (intent) {
    case "note":
      await api.recordSupportOperationsNote(supportRequestId, { summary: formValue(formData, "summary") });
      return { kind: "completed", action: "note" };
    case "response":
      await api.recordSupportOperationsResponse(supportRequestId, {
        responseType: formValue(formData, "responseType"),
        summary: formValue(formData, "summary"),
      });
      return { kind: "completed", action: "response" };
    case "escalate":
      await api.escalateSupportOperationsRequest(supportRequestId, { reason: formValue(formData, "reason") });
      return { kind: "completed", action: "escalate" };
    case "resolve": {
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
      return { kind: "completed", action: "resolve" };
    }
    case "close":
      await api.closeSupportOperationsRequest(supportRequestId);
      return { kind: "completed", action: "close" };
    case "cancel":
      await api.cancelSupportOperationsRequest(supportRequestId, { reason: formValue(formData, "reason") });
      return { kind: "completed", action: "cancel" };
    case "preview-remedy": {
      const proposalInput = remedyBody(formData);
      return {
        kind: "preview",
        preview: await api.previewRemedyProposal(supportRequestId, proposalInput),
        proposalInput,
      };
    }
    case "propose-remedy":
      await api.proposeRemedy(supportRequestId, remedyBody(formData));
      return { kind: "completed", action: "remedy-proposed" };
    case "approve-remedy":
      await api.approveRemedy(supportRequestId, {
        reasonCode: formValue(formData, "reasonCode"),
        rationale: formValue(formData, "rationale"),
        evidenceReferences: formValue(formData, "evidenceReferences"),
        idempotencyKey: formValue(formData, "idempotencyKey"),
      });
      return { kind: "completed", action: "remedy-approved" };
    case "retry-remedy-effect":
      await api.retryRemedyEffect(supportRequestId, formValue(formData, "remedyId"), formValue(formData, "effect"), {
        reasonCode: formValue(formData, "reasonCode"),
        rationale: formValue(formData, "rationale"),
        idempotencyKey: formValue(formData, "idempotencyKey"),
      });
      return { kind: "completed", action: "remedy-retry-requested" };
    case "waive-remedy-effect":
      await api.waiveRemedyEffect(supportRequestId, formValue(formData, "remedyId"), formValue(formData, "effect"), {
        reasonCode: formValue(formData, "reasonCode"),
        rationale: formValue(formData, "rationale"),
        evidenceReferences: formValue(formData, "evidenceReferences"),
        idempotencyKey: formValue(formData, "idempotencyKey"),
      });
      return { kind: "completed", action: "remedy-effect-waived" };
    case "release-remedy-refund":
      await api.releaseRemedyRefund(supportRequestId, formValue(formData, "remedyId"), {
        reasonCode: formValue(formData, "reasonCode"),
        idempotencyKey: formValue(formData, "idempotencyKey"),
      });
      return { kind: "completed", action: "remedy-refund-released" };
    case "request-remedy-correction":
      await api.requestRemedyCorrection(supportRequestId, {
        reasonCode: formValue(formData, "reasonCode"),
        rationale: formValue(formData, "rationale"),
        evidenceReferences: formValue(formData, "evidenceReferences"),
        idempotencyKey: formValue(formData, "idempotencyKey"),
      });
      return { kind: "completed", action: "remedy-correction-requested" };
    default:
      return null;
  }
}
