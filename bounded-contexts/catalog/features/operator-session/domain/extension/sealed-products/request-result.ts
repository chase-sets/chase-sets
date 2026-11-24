import { closed } from "../protocol";
import { isSetNamesRequestResult, type SetNamesRequestResult } from "../set-names/probe";

const relayFailureCodes = ["refused", "unavailable", "invalid-response", "timeout"] as const;
type RelayFailureCode = (typeof relayFailureCodes)[number];

export function sealedRequestFailure(code: RelayFailureCode) {
  return { ok: false, status: null, contentClass: "unknown", bytes: 0, body: null, code } as const;
}

export type SealedRequestResult = SetNamesRequestResult | ReturnType<typeof sealedRequestFailure>;

export function isSealedRequestResult(value: unknown): value is SealedRequestResult {
  return (
    isSetNamesRequestResult(value) ||
    (closed(value, ["ok", "status", "contentClass", "bytes", "body", "code"]) &&
      value.ok === false &&
      value.status === null &&
      value.contentClass === "unknown" &&
      value.bytes === 0 &&
      value.body === null &&
      relayFailureCodes.some((code) => value.code === code))
  );
}
