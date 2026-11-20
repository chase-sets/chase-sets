import { closed, safeInteger, type OperatorEnvironment } from "../protocol";
import { isSetNamesRequestResult, type SetNamesRequestResult } from "../set-names/probe";
import { sealedProductLines, type SealedFetch, type SealedRequest } from "./collector";
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
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: () => void; timer: ReturnType<typeof setTimeout> }
  >();
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
    call.resolve(event.data.result);
  };
  host.addEventListener("message", receive);
  function call(message: SealedRequestMessage | SealedPostMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (nextId === Number.MAX_SAFE_INTEGER) {
        reject(new Error("unavailable"));
        return;
      }
      const sealedId = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(sealedId);
        reject(new Error("unavailable"));
      }, 20_000);
      pending.set(sealedId, { resolve, reject: () => reject(new Error("unavailable")), timer });
      host.parent.postMessage({ sealedId, message }, bridgeOrigin);
    });
  }
  return {
    async request(request: SealedRequest): Promise<SetNamesRequestResult> {
      const message: SealedRequestMessage = { action: "fetch-sealed-products", request };
      if (!isSealedRequestMessage(message)) throw new Error("refused");
      const result = await call(message);
      if (!isSetNamesRequestResult(result)) throw new Error("invalid-response");
      return result;
    },
    async post(
      environment: OperatorEnvironment,
      post: TcgplayerSealedProductObservationPost,
    ): Promise<SealedPostResult> {
      const message: SealedPostMessage = { action: "post-sealed-products", environment, post };
      if (!isSealedPostMessage(message)) return { outcome: "refused" };
      const result = await call(message);
      return isSealedPostResult(result) ? result : { outcome: "invalid-response" };
    },
    dispose() {
      host.removeEventListener("message", receive);
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject();
      }
      pending.clear();
    },
  };
}
