import { act } from "@testing-library/react";
import { vi } from "vitest";

// Controlled page-side chrome.runtime for the Admin pair handoff. The shapes
// follow the #9572 Chromium capture: sendMessage(id, message) without a
// callback returns a Promise of the receiver's reply, an uninstalled receiver
// rejects with "Receiving end does not exist", and a page outside the
// extension's externally_connectable matches has no runtime at all.
export const receivingEndDoesNotExist = "Could not establish connection. Receiving end does not exist.";

export type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}>;

export function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export function stubSendMessage(respond: () => unknown) {
  const sendMessage = vi.fn((..._args: unknown[]) => respond());
  vi.stubGlobal("chrome", { runtime: { sendMessage } });
  return sendMessage;
}

// The fake-timer windows fake only setTimeout/clearTimeout, so a macrotask
// turn lets the controlled fetch body settle without advancing fake time.
export async function flushUntil(condition: () => boolean, label: string) {
  for (let turn = 0; turn < 50 && !condition(); turn++) {
    await act(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
  }
  if (!condition()) throw new Error(`${label} did not happen`);
}

// Records every DOM insertion, text change or attribute value that carries the
// secret, so a transient render between two assertions is still caught.
export function watchDomForSecret(secret: string) {
  const exposures: string[] = [];
  const carries = (node: Node) =>
    (node instanceof Element ? node.outerHTML : (node.textContent ?? "")).includes(secret);
  const inspect = (records: MutationRecord[]) => {
    for (const record of records) {
      if (record.type === "childList" && [...record.addedNodes].some(carries)) exposures.push("inserted node");
      if (record.type === "characterData" && carries(record.target)) exposures.push("text change");
      if (record.type === "attributes" && record.attributeName) {
        const value = (record.target as Element).getAttribute(record.attributeName);
        if (value?.includes(secret)) exposures.push(`attribute ${record.attributeName}`);
      }
    }
  };
  const observer = new MutationObserver(inspect);
  observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  return () => {
    inspect(observer.takeRecords());
    observer.disconnect();
    return exposures;
  };
}
