import { closed, safeInteger, type OperatorEnvironment } from "../protocol";
import { sealedProductLines, type SealedFetch, type SealedRequest } from "./collector";
import { isSealedRequestResult, sealedRequestFailure } from "./request-result";
import {
  isSealedPostMessage,
  isSealedPostResult,
  type SealedPostMessage,
  type SealedPost,
  type SealedPostResult,
} from "./transport";
import type { TcgplayerSealedProductObservationPost } from "./contract";
export type SealedRequestMessage = { action: "fetch-sealed-products"; request: SealedRequest };
export function isSealedRequestMessage(value: unknown): value is SealedRequestMessage {
  if (!closed(value, ["action", "request"]) || value.action !== "fetch-sealed-products") return false;
  const request = value.request;
  if (closed(request, ["endpoint", "productId"]))
    return (
      request.endpoint === "detail" &&
      safeInteger(request.productId) &&
      request.productId > 0 &&
      request.productId <= 2_147_483_647
    );
  return (
    closed(request, ["endpoint", "productLineId", "setName", "from", "includeProductLine"]) &&
    request.endpoint === "search" &&
    sealedProductLines().some((line) => line.id === request.productLineId) &&
    typeof request.setName === "string" &&
    request.setName.length > 0 &&
    request.setName.length <= 512 &&
    safeInteger(request.from) &&
    request.from < 12_000 &&
    request.from % 24 === 0 &&
    typeof request.includeProductLine === "boolean"
  );
}
// Request-sized bridge deadlines, not a whole-run deadline: a set may take many minutes.
export function createSealedPopupClient(
  host: Window,
  bridgeOrigin: string,
): { request: SealedFetch; post: SealedPost; dispose: () => void } {
  let nextId = 0;
  type Reply = { kind: "reply"; result: unknown } | { kind: "timeout" | "unavailable" };
  const pending = new Map<number, { resolve: (value: Reply) => void; timer: ReturnType<typeof setTimeout> }>();
  const receive = (event: MessageEvent<unknown>) => {
    if (
      event.source !== host.parent ||
      event.origin !== bridgeOrigin ||
      !closed(event.data, ["sealedId", "result"]) ||
      !safeInteger(event.data.sealedId)
    )
      return;
    const call = pending.get(event.data.sealedId);
    if (!call) return;
    pending.delete(event.data.sealedId);
    clearTimeout(call.timer);
    call.resolve({ kind: "reply", result: event.data.result });
  };
  host.addEventListener("message", receive);
  function call(message: SealedRequestMessage | SealedPostMessage): Promise<Reply> {
    return new Promise((resolve) => {
      if (nextId === Number.MAX_SAFE_INTEGER) {
        resolve({ kind: "unavailable" });
        return;
      }
      const sealedId = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(sealedId);
        resolve({ kind: "timeout" });
      }, 20_000);
      pending.set(sealedId, { resolve, timer });
      try {
        host.parent.postMessage({ sealedId, message }, bridgeOrigin);
      } catch {
        pending.delete(sealedId);
        clearTimeout(timer);
        resolve({ kind: "unavailable" });
      }
    });
  }
  return {
    async request(request: SealedRequest) {
      const message: SealedRequestMessage = { action: "fetch-sealed-products", request };
      if (!isSealedRequestMessage(message)) return sealedRequestFailure("refused");
      const reply = await call(message);
      if (reply.kind !== "reply") return sealedRequestFailure(reply.kind);
      return isSealedRequestResult(reply.result) ? reply.result : sealedRequestFailure("invalid-response");
    },
    async post(
      environment: OperatorEnvironment,
      post: TcgplayerSealedProductObservationPost,
    ): Promise<SealedPostResult> {
      const message: SealedPostMessage = { action: "post-sealed-products", environment, post };
      if (!isSealedPostMessage(message)) return { outcome: "refused" };
      const reply = await call(message);
      if (reply.kind !== "reply") return { outcome: "unavailable" };
      return isSealedPostResult(reply.result) ? reply.result : { outcome: "invalid-response" };
    },
    dispose() {
      host.removeEventListener("message", receive);
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.resolve({ kind: "unavailable" });
      }
      pending.clear();
    },
  };
}
