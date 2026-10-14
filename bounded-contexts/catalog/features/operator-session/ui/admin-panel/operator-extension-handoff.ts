import { closed, operatorExtensionId } from "../../domain/extension/protocol";

// Admin side of the pair handoff to the operator extension's external receiver
// (domain/extension/background.ts receiveHandoff). Only a closed
// {outcome:"paired"} reply confirms that the extension committed the grant to
// its local storage. A refusal, rejection, missing runtime or malformed reply
// is "not-confirmed": it is not proof that the grant was not received, and
// nothing is rolled back.
export type OperatorExtensionHandoffResult = "paired" | "not-confirmed";
export type OperatorExtensionHandoff = (grant: string) => Promise<OperatorExtensionHandoffResult>;

// Decision #9570 condition 4: the grant stays unrendered for at most this long.
export const operatorExtensionHandoffTimeoutMs = 15_000;

// The page-side shapes follow the #9572 Chromium capture: without a callback,
// sendMessage returns a Promise of the reply; pages outside the extension's
// externally_connectable matches have no sendMessage; an uninstalled receiver
// rejects. A callback-only runtime returns nothing to await.
export const handOffToOperatorExtension: OperatorExtensionHandoff = async (grant) => {
  try {
    const chrome: unknown = Reflect.get(globalThis, "chrome");
    const runtime: unknown = isObject(chrome) ? Reflect.get(chrome, "runtime") : undefined;
    const sendMessage: unknown = isObject(runtime) ? Reflect.get(runtime, "sendMessage") : undefined;
    if (typeof sendMessage !== "function") return "not-confirmed";
    const pending: unknown = sendMessage.call(runtime, operatorExtensionId, { action: "pair-handoff", grant });
    if (!isObject(pending) || typeof Reflect.get(pending, "then") !== "function") return "not-confirmed";
    const reply: unknown = await pending;
    return closed(reply, ["outcome"]) && reply.outcome === "paired" ? "paired" : "not-confirmed";
  } catch {
    return "not-confirmed";
  }
};

// Settles once: with the handoff's result, or "not-confirmed" when it throws,
// rejects or outlasts the timeout. A result that arrives later is discarded.
export function awaitOperatorExtensionHandoff(
  handoff: OperatorExtensionHandoff,
  grant: string,
): Promise<OperatorExtensionHandoffResult> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve("not-confirmed"), operatorExtensionHandoffTimeoutMs);
    const settle = (result: OperatorExtensionHandoffResult) => {
      clearTimeout(timeout);
      resolve(result);
    };
    new Promise<OperatorExtensionHandoffResult>((run) => run(handoff(grant))).then(
      (result) => settle(result === "paired" ? "paired" : "not-confirmed"),
      () => settle("not-confirmed"),
    );
  });
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}
