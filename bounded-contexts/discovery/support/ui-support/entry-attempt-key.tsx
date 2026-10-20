import { createContext, useContext, useState, type ReactNode } from "react";
import { HiddenInput } from "@chase-sets/design-system";
import { createId } from "@chase-sets/primitives/typed-ids";

type EntryAttemptKeys = Readonly<{
  keyFor: (formId: string, inputs: string) => string;
}>;

const EntryAttemptKeyContext = createContext<EntryAttemptKeys | null>(null);

/**
 * Each form holds the page-view key until one of its hashed inputs changes;
 * every change after that mints one fresh key, so repeated renders of the same
 * inputs always return the key the form already holds.
 */
function holdEntryAttemptKeys(pageViewKey: string | null): EntryAttemptKeys {
  const held = new Map<string, Readonly<{ inputs: string; key: string }>>();

  return {
    keyFor(formId, inputs) {
      if (!pageViewKey) {
        throw new Error("A Buy form rendered outside a page view's entry key.");
      }

      const current = held.get(formId);
      if (current?.inputs === inputs) {
        return current.key;
      }

      const next = { inputs, key: current ? createId("chkentry") : pageViewKey };
      held.set(formId, next);
      return next.key;
    },
  };
}

/**
 * Holds one Checkout entry key per page view above the route's realtime-keyed
 * view, so loader revalidation, realtime patches and view remounts keep it. It
 * starts from the action-data key, else the loader key; it ignores later loader
 * keys and adopts only a later action-data key (a refused or conflicting key).
 */
export function EntryAttemptKeyScope({
  loaderKey,
  actionKey,
  children,
}: Readonly<{
  loaderKey: string | null | undefined;
  actionKey?: string | null;
  children: ReactNode;
}>) {
  const [scope, setScope] = useState(() => ({
    actionKey,
    keys: holdEntryAttemptKeys(actionKey ?? loaderKey ?? null),
  }));

  if (actionKey && actionKey !== scope.actionKey) {
    setScope({ actionKey, keys: holdEntryAttemptKeys(actionKey) });
  }

  return <EntryAttemptKeyContext.Provider value={scope.keys}>{children}</EntryAttemptKeyContext.Provider>;
}

/** The key one Buy form sends; `inputs` are the deliberate choices that make a new submission. */
export function useEntryAttemptKey(formId: string, inputs: Readonly<Record<string, unknown>>) {
  const keys = useContext(EntryAttemptKeyContext);
  if (!keys) {
    throw new Error("useEntryAttemptKey needs an EntryAttemptKeyScope above the Buy form.");
  }

  return keys.keyFor(formId, JSON.stringify(inputs));
}

/** Server HTML carries the key, so a no-JS post, a resubmit or a 307 sends it too. */
export function EntryAttemptKeyField({
  formId,
  inputs,
}: Readonly<{ formId: string; inputs: Readonly<Record<string, unknown>> }>) {
  return <HiddenInput name="entryAttemptKey" value={useEntryAttemptKey(formId, inputs)} />;
}
