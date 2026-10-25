import { closed, isCommand, isStatus, safeInteger, type OperatorCommand, type OperatorStatus } from "./protocol";
import { isSetNamesRequestResult, type SetNamesRequest, type SetNamesRequestResult } from "./set-names/probe";

export type OperatorBridgeMessage =
  | OperatorCommand
  | { action: "probe-set-names"; productLineId: string }
  | { action: "copy-probe-report"; text: string };

export function isProbeSetNamesMessage(value: unknown): value is { action: "probe-set-names"; productLineId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    closed(value, ["action", "productLineId"]) &&
    value.action === "probe-set-names" &&
    typeof value.productLineId === "string" &&
    /^\d+$/.test(value.productLineId)
  );
}

export function isCopyProbeReportMessage(value: unknown): value is { action: "copy-probe-report"; text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (closed(value, ["action", "text"]) || (closed(value, ["id", "action", "text"]) && safeInteger(value.id))) &&
    value.action === "copy-probe-report" &&
    typeof value.text === "string"
  );
}

export function installOperatorBridge(
  host: Window,
  frame: HTMLIFrameElement,
  send: (message: OperatorBridgeMessage) => Promise<unknown>,
) {
  const relay = async (id: number, message: OperatorBridgeMessage) => {
    try {
      const result = await send(message);
      if (isCommand(message)) {
        if (isStatus(result)) frame.contentWindow?.postMessage({ id, status: result }, "*");
      } else if (isProbeSetNamesMessage(message)) {
        if (isSetNamesRequestResult(result)) frame.contentWindow?.postMessage({ id, result }, "*");
      } else {
        frame.contentWindow?.postMessage({ id, copied: result === true }, "*");
      }
    } catch {
      if (isCopyProbeReportMessage(message)) frame.contentWindow?.postMessage({ id, copied: false }, "*");
      /* The sandbox deadline supplies a closed UI error, never an exception echo. */
    }
  };
  const receive = (event: MessageEvent<unknown>) => {
    if (event.source !== frame.contentWindow || event.origin !== "null") return;
    if (closed(event.data, ["id", "command"]) && safeInteger(event.data.id) && isCommand(event.data.command)) {
      void relay(event.data.id, event.data.command);
      return;
    }
    if (
      closed(event.data, ["id", "action", "productLineId"]) &&
      safeInteger(event.data.id) &&
      event.data.action === "probe-set-names" &&
      typeof event.data.productLineId === "string" &&
      /^\d+$/.test(event.data.productLineId)
    ) {
      void relay(event.data.id, { action: "probe-set-names", productLineId: event.data.productLineId });
      return;
    }
    if (closed(event.data, ["id", "action", "text"]) && safeInteger(event.data.id)) {
      const id = event.data.id;
      if (isCopyProbeReportMessage(event.data)) void relay(id, event.data);
    }
  };
  host.addEventListener("message", receive);
  return () => host.removeEventListener("message", receive);
}

export function createOperatorSandboxSetNamesRequest(host: Window, bridgeOrigin: string): SetNamesRequest {
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (result: SetNamesRequestResult) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const receive = (event: MessageEvent<unknown>) => {
    if (
      event.source !== host.parent ||
      event.origin !== bridgeOrigin ||
      !closed(event.data, ["id", "result"]) ||
      !safeInteger(event.data.id) ||
      !isSetNamesRequestResult(event.data.result)
    )
      return;
    const call = pending.get(event.data.id);
    if (!call) return;
    pending.delete(event.data.id);
    clearTimeout(call.timer);
    call.resolve(event.data.result);
  };
  host.addEventListener("message", receive);
  return (productLineId) =>
    new Promise((resolve, reject) => {
      if (nextId === Number.MAX_SAFE_INTEGER) {
        reject(new Error("unavailable"));
        return;
      }
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("unavailable"));
      }, 20_000);
      pending.set(id, { resolve, timer });
      host.parent.postMessage({ id, action: "probe-set-names", productLineId }, bridgeOrigin);
    });
}

export function createOperatorSandboxCopyReport(host: Window, bridgeOrigin: string) {
  let nextId = 0;
  const pending = new Map<number, { resolve: () => void; reject: () => void; timer: ReturnType<typeof setTimeout> }>();
  const receive = (event: MessageEvent<unknown>) => {
    if (
      event.source !== host.parent ||
      event.origin !== bridgeOrigin ||
      !closed(event.data, ["id", "copied"]) ||
      !safeInteger(event.data.id) ||
      typeof event.data.copied !== "boolean"
    )
      return;
    const call = pending.get(event.data.id);
    if (!call) return;
    pending.delete(event.data.id);
    clearTimeout(call.timer);
    (event.data.copied ? call.resolve : call.reject)();
  };
  host.addEventListener("message", receive);
  return (text: string) =>
    new Promise<void>((resolve, reject) => {
      if (nextId === Number.MAX_SAFE_INTEGER) {
        reject(new Error("unavailable"));
        return;
      }
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("unavailable"));
      }, 5_000);
      pending.set(id, { resolve, reject, timer });
      host.parent.postMessage({ id, action: "copy-probe-report", text }, bridgeOrigin);
    });
}

export function createOperatorPopupClient(host: Window, bridgeOrigin: string) {
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (status: OperatorStatus) => void; reject: () => void; timer: ReturnType<typeof setTimeout> }
  >();
  const receive = (event: MessageEvent<unknown>) => {
    if (
      event.source !== host.parent ||
      event.origin !== bridgeOrigin ||
      !closed(event.data, ["id", "status"]) ||
      !safeInteger(event.data.id) ||
      !isStatus(event.data.status)
    )
      return;
    const call = pending.get(event.data.id);
    if (!call) return;
    pending.delete(event.data.id);
    clearTimeout(call.timer);
    call.resolve(event.data.status);
  };
  let nextProbeId = 0;
  const pendingProbe = new Map<
    number,
    { resolve: (result: SetNamesRequestResult) => void; reject: () => void; timer: ReturnType<typeof setTimeout> }
  >();
  const pendingCopy = new Map<
    number,
    { resolve: () => void; reject: () => void; timer: ReturnType<typeof setTimeout> }
  >();
  const receiveProbe = (event: MessageEvent<unknown>) => {
    if (
      event.source !== host.parent ||
      event.origin !== bridgeOrigin ||
      !safeInteger((event.data as { id?: unknown })?.id)
    )
      return;
    const data = event.data as { id: number; result?: unknown; copied?: unknown };
    if ("result" in data && isSetNamesRequestResult(data.result)) {
      const call = pendingProbe.get(data.id);
      if (!call) return;
      pendingProbe.delete(data.id);
      clearTimeout(call.timer);
      call.resolve(data.result);
    } else if ("copied" in data && typeof data.copied === "boolean") {
      const call = pendingCopy.get(data.id);
      if (!call) return;
      pendingCopy.delete(data.id);
      clearTimeout(call.timer);
      (data.copied ? call.resolve : call.reject)();
    }
  };
  host.addEventListener("message", receive);
  host.addEventListener("message", receiveProbe);
  return {
    request(command: OperatorCommand): Promise<OperatorStatus> {
      return new Promise((resolve, reject) => {
        if (!isCommand(command) || nextId === Number.MAX_SAFE_INTEGER) {
          reject(new Error("unavailable"));
          return;
        }
        const id = ++nextId;
        const fail = () => reject(new Error("unavailable"));
        const timer = setTimeout(() => {
          pending.delete(id);
          fail();
        }, 15_000);
        pending.set(id, { resolve, reject: fail, timer });
        host.parent.postMessage({ id, command }, bridgeOrigin);
      });
    },
    requestSetNames(productLineId: string): Promise<SetNamesRequestResult> {
      return new Promise((resolve, reject) => {
        if (nextProbeId === Number.MAX_SAFE_INTEGER || !/^\d+$/.test(productLineId)) {
          reject(new Error("unavailable"));
          return;
        }
        const id = ++nextProbeId;
        const timer = setTimeout(() => {
          pendingProbe.delete(id);
          reject(new Error("unavailable"));
        }, 20_000);
        pendingProbe.set(id, { resolve, reject, timer });
        host.parent.postMessage({ id, action: "probe-set-names", productLineId }, bridgeOrigin);
      });
    },
    copyProbeReport(text: string): Promise<void> {
      return new Promise((resolve, reject) => {
        if (nextProbeId === Number.MAX_SAFE_INTEGER) {
          reject(new Error("unavailable"));
          return;
        }
        const id = ++nextProbeId;
        const timer = setTimeout(() => {
          pendingCopy.delete(id);
          reject(new Error("unavailable"));
        }, 5_000);
        pendingCopy.set(id, { resolve, reject, timer });
        host.parent.postMessage({ id, action: "copy-probe-report", text }, bridgeOrigin);
      });
    },
    dispose() {
      host.removeEventListener("message", receive);
      host.removeEventListener("message", receiveProbe);
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject();
      }
      pending.clear();
      for (const call of pendingProbe.values()) {
        clearTimeout(call.timer);
        call.reject();
      }
      pendingProbe.clear();
      for (const call of pendingCopy.values()) {
        clearTimeout(call.timer);
        call.reject();
      }
      pendingCopy.clear();
    },
  };
}
