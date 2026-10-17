import { closed, isCommand, isStatus, safeInteger, type OperatorCommand, type OperatorStatus } from "./protocol";

export function installOperatorBridge(
  host: Window,
  frame: HTMLIFrameElement,
  send: (command: OperatorCommand) => Promise<unknown>,
) {
  const receive = async (event: MessageEvent<unknown>) => {
    if (
      event.source !== frame.contentWindow ||
      event.origin !== "null" ||
      !closed(event.data, ["id", "command"]) ||
      !safeInteger(event.data.id) ||
      !isCommand(event.data.command)
    )
      return;
    const id = event.data.id;
    try {
      const status = await send(event.data.command);
      if (isStatus(status)) frame.contentWindow?.postMessage({ id, status }, "*");
    } catch {
      /* The sandbox deadline supplies a closed UI error, never an exception echo. */
    }
  };
  host.addEventListener("message", receive);
  return () => host.removeEventListener("message", receive);
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
  host.addEventListener("message", receive);
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
