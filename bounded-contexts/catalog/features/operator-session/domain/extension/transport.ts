import {
  closed,
  isEnvironment,
  isGrant,
  observationPollVersion,
  operatorOrigins,
  parseObservationPoll,
  type OperatorEnvironment,
  type OperatorObservationRequest,
} from "./protocol";
import { setNameRequestHeader } from "./set-names/request";
import { sealedPartHeader } from "./sealed-products/answer-contract";

export type OperatorResult = { outcome: "revoked" | "grant-invalid" | "unavailable" | "refused" | "invalid-response" };
type ObservationPollResult =
  | { outcome: "polled"; request: OperatorObservationRequest | null }
  | { outcome: "unavailable"; retryAt: number }
  | { outcome: "grant-invalid" | "refused" | "invalid-response" };

function retryAt(value: string | null): number {
  if (!value) return 0;
  const instant = /^\d+$/.test(value) ? Date.now() + Number(value) * 1000 : Date.parse(value);
  return Number.isSafeInteger(instant) && instant > Date.now() ? instant : 0;
}

async function readPollJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("invalid-observation-poll");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(text + decoder.decode()) as unknown;
      bytes += value.byteLength;
      if (bytes > 64 * 1024) throw new Error("invalid-observation-poll");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

export function createOperatorTransport(fetcher: typeof fetch) {
  async function poll(environment: OperatorEnvironment, grant: string): Promise<ObservationPollResult> {
    if (!isEnvironment(environment) || !isGrant(grant)) return { outcome: "refused" };
    let response: Response;
    try {
      response = await fetcher(
        `${operatorOrigins[environment]}/api/public/catalog/operator-session/observation-requests/current?version=${observationPollVersion}`,
        {
          method: "GET",
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
          headers: { Authorization: `Bearer ${grant}` },
        },
      );
    } catch {
      return { outcome: "unavailable", retryAt: 0 };
    }
    if (response.status === 429 || response.status >= 500)
      return { outcome: "unavailable", retryAt: retryAt(response.headers.get("Retry-After")) };
    if (response.status !== 200 && response.status !== 401 && response.status !== 403) return { outcome: "refused" };
    try {
      const body = await readPollJson(response);
      if (response.status === 200) return { outcome: "polled", request: parseObservationPoll(body) };
      return closed(body, ["code"]) && body.code === (response.status === 401 ? "grant-invalid" : "authority-lost")
        ? { outcome: "grant-invalid" }
        : { outcome: "refused" };
    } catch {
      return { outcome: "invalid-response" };
    }
  }
  async function revoke(environment: OperatorEnvironment, grant: string): Promise<OperatorResult> {
    if (!isGrant(grant)) return { outcome: "refused" };
    try {
      const response = await fetcher(`${operatorOrigins[environment]}/api/public/catalog/operator-session/grant`, {
        method: "DELETE",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        headers: { Authorization: `Bearer ${grant}` },
      });
      if (response.status === 401) return { outcome: "grant-invalid" };
      if (response.status >= 500) return { outcome: "unavailable" };
      const body: unknown = await response.json();
      return response.status === 200 && closed(body, ["outcome"]) && body.outcome === "revoked"
        ? { outcome: "revoked" }
        : { outcome: "invalid-response" };
    } catch {
      return { outcome: "unavailable" };
    }
  }
  async function postAnswer(
    environment: OperatorEnvironment,
    grant: string,
    kind: "set-names" | "sealed-products",
    requestId: string,
    body: string,
    partIndex?: number,
  ): Promise<{ outcome: "recorded" | "grant-invalid" | "refused" } | { outcome: "unavailable"; retryAt: number }> {
    try {
      const init: RequestInit = {
        method: "POST",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${grant}`,
          "Content-Type": "application/json",
          [setNameRequestHeader]: requestId,
          ...(partIndex === undefined ? {} : { [sealedPartHeader]: String(partIndex) }),
        },
        body,
      };
      const response =
        kind === "set-names"
          ? await fetcher(
              `${operatorOrigins[environment]}/api/public/catalog/operator-session/scope-observations/tcgplayer-set-names`,
              init,
            )
          : await fetcher(
              `${operatorOrigins[environment]}/api/public/catalog/operator-session/catalog-observations/tcgplayer-sealed-products`,
              init,
            );
      if (response.status === 429 || response.status >= 500)
        return { outcome: "unavailable", retryAt: retryAt(response.headers.get("Retry-After")) };
      if (response.status === 200) return { outcome: "recorded" };
      if (response.status === 401 || response.status === 403) {
        const value = await readPollJson(response);
        if (closed(value, ["code"]) && value.code === (response.status === 401 ? "grant-invalid" : "authority-lost"))
          return { outcome: "grant-invalid" };
      }
      return { outcome: "refused" };
    } catch {
      return { outcome: "unavailable", retryAt: 0 };
    }
  }
  return { poll, revoke, postAnswer };
}
