import type { UcpAp2MandateVerificationResult, UcpAp2MandateVerifier } from "./payment-handlers";

const UCP_VERSION = "2026-04-08";
const DEFAULT_TIMEOUT_MS = 5_000;

const rejectionCodes = new Set([
  "mandate_required",
  "agent_missing_key",
  "mandate_invalid_signature",
  "mandate_expired",
  "mandate_scope_mismatch",
  "merchant_authorization_invalid",
  "merchant_authorization_missing",
] as const);

type RejectionCode =
  | "mandate_required"
  | "agent_missing_key"
  | "mandate_invalid_signature"
  | "mandate_expired"
  | "mandate_scope_mismatch"
  | "merchant_authorization_invalid"
  | "merchant_authorization_missing";

export type RemoteUcpAp2MandateVerifierConfig = Readonly<{
  endpoint: string;
  authorizationToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}>;

export function createRemoteUcpAp2MandateVerifier(config: RemoteUcpAp2MandateVerifierConfig): UcpAp2MandateVerifier {
  const endpoint = new URL(config.endpoint);
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    verify: async (input) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.authorizationToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            schema_version: "chase-sets-ucp-ap2-verification/v1",
            ucp_version: UCP_VERSION,
            accepted_modes: ["human-present"],
            verified_at: input.verifiedAt,
            checkout: input.checkout,
            checkout_mandate: input.checkoutMandate.token,
            checkout_mandate_id: input.checkoutMandate.id,
            payment_token_present: input.paymentTokenPresent,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          return unavailable();
        }

        return parseResponse(await response.json(), endpoint.hostname, input.verifiedAt);
      } catch {
        return unavailable();
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

function parseResponse(value: unknown, verifier: string, verifiedAt: string): UcpAp2MandateVerificationResult {
  const response = readObject(value);
  if (response?.valid === true) {
    const mode = response.mode;
    if (mode !== "human-present" && mode !== "human-not-present") {
      return unavailable();
    }
    return {
      ok: true,
      mode,
      evidence: compact({
        verificationId: readString(response.verification_id),
        mandateVct: readString(response.mandate_vct),
        verifier,
        verifiedAt,
      }),
    };
  }

  if (response?.valid === false && isRejectionCode(response.code)) {
    return {
      ok: false,
      code: response.code,
      message: rejectionMessage(response.code),
    };
  }

  return unavailable();
}

function rejectionMessage(code: RejectionCode) {
  const messages: Record<RejectionCode, string> = {
    mandate_required: "AP2 mandate verification requires a Checkout Mandate.",
    agent_missing_key: "The AP2 agent verification key is unavailable.",
    mandate_invalid_signature: "The AP2 mandate signature is invalid.",
    mandate_expired: "The AP2 mandate has expired.",
    mandate_scope_mismatch: "The AP2 mandate does not authorize this checkout.",
    merchant_authorization_invalid: "The AP2 merchant authorization is invalid.",
    merchant_authorization_missing: "The AP2 merchant authorization is missing.",
  };
  return messages[code];
}

function unavailable(): UcpAp2MandateVerificationResult {
  return {
    ok: false,
    code: "mandate_verification_unavailable",
    message: "AP2 mandate verification is temporarily unavailable.",
  };
}

function isRejectionCode(value: unknown): value is RejectionCode {
  return typeof value === "string" && rejectionCodes.has(value as RejectionCode);
}

function compact(value: Readonly<Record<string, string | undefined>>) {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => Boolean(entry[1])));
}

function readObject(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
