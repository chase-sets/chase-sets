import { readApiErrorCode, readApiErrorMessage, type ApiErrorDetail } from "@chase-sets/http/responses";
import type { ValidationSummaryError } from "@chase-sets/design-system";
import { SettlementApiError } from "../../client";

/**
 * Every distinct way a Wallet Adjustment API call can fail, collapsed into a
 * single closed set the guided flow renders deterministically. New API error
 * shapes must be classified here rather than surfaced as raw status codes or
 * raw JSON in the UI, so every workflow state and API error stays
 * deterministic.
 */
export const WALLET_ADJUSTMENT_FLOW_ERROR_KINDS = [
  "validation",
  "stale-preview",
  "step-up-required",
  "requires-elevated-approval",
  "self-benefiting-blocked",
  "not-found",
  "forbidden",
  "authentication-required",
  "conflict",
  "unknown",
] as const;

export type WalletAdjustmentFlowErrorKind = (typeof WALLET_ADJUSTMENT_FLOW_ERROR_KINDS)[number];

export type WalletAdjustmentFlowError = Readonly<{
  kind: WalletAdjustmentFlowErrorKind;
  message: string;
  fieldErrors: readonly ValidationSummaryError[];
}>;

function fieldErrorsFromDetails(details: readonly ApiErrorDetail[] | undefined): readonly ValidationSummaryError[] {
  if (!details || details.length === 0) {
    return [];
  }
  return details.map((detail) => ({
    fieldId: detail.field,
    fieldName: detail.field,
    message: detail.message,
  }));
}

function detailCodes(body: unknown): readonly string[] {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return [];
  }
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null || !("details" in error)) {
    return [];
  }
  const details = (error as { details?: unknown }).details;
  if (!Array.isArray(details)) {
    return [];
  }
  return details
    .map((detail) => (typeof detail === "object" && detail !== null ? (detail as { code?: unknown }).code : null))
    .filter((code): code is string => typeof code === "string");
}

function detailsFromBody(body: unknown): readonly ApiErrorDetail[] | undefined {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return undefined;
  }
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null || !("details" in error)) {
    return undefined;
  }
  const details = (error as { details?: unknown }).details;
  return Array.isArray(details) ? (details as ApiErrorDetail[]) : undefined;
}

/**
 * Classifies a caught wallet-adjustment API failure into the closed
 * `WalletAdjustmentFlowError` shape the guided-flow UI renders.
 *
 * Kinds come from the top-level error code, an `ApiErrorDetail.code`, or the
 * HTTP status, never from message text: the approve route's `409 conflict`
 * carries `elevated_approval_required` or `self_benefiting_blocked` as its
 * detail code, and a conflict without a known detail code stays a generic
 * `conflict`.
 */
export function describeWalletAdjustmentFlowError(error: unknown, fallbackMessage: string): WalletAdjustmentFlowError {
  if (!(error instanceof SettlementApiError)) {
    return {
      kind: "unknown",
      message: error instanceof Error && error.message ? error.message : fallbackMessage,
      fieldErrors: [],
    };
  }

  const message = readApiErrorMessage(error.body, fallbackMessage);
  const code = readApiErrorCode(error.body);
  const fieldErrors = fieldErrorsFromDetails(detailsFromBody(error.body));
  const codes = detailCodes(error.body);

  if (code === "step_up_required") {
    return { kind: "step-up-required", message, fieldErrors };
  }
  if (codes.includes("stale_balance_revision")) {
    return { kind: "stale-preview", message, fieldErrors };
  }
  if (codes.includes("elevated_approval_required")) {
    return { kind: "requires-elevated-approval", message, fieldErrors };
  }
  if (codes.includes("self_benefiting_blocked")) {
    return { kind: "self-benefiting-blocked", message, fieldErrors };
  }
  if (code === "validation_failed") {
    return { kind: "validation", message, fieldErrors };
  }
  if (code === "not_found") {
    return { kind: "not-found", message, fieldErrors };
  }
  if (code === "authorization_forbidden") {
    return { kind: "forbidden", message, fieldErrors };
  }
  if (code === "authentication_required") {
    return { kind: "authentication-required", message, fieldErrors };
  }
  if (code === "conflict" || error.status === 409) {
    return { kind: "conflict", message, fieldErrors };
  }

  return { kind: "unknown", message, fieldErrors };
}
