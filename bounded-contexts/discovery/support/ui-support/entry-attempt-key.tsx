import { createContext, useContext, useState, type ReactNode } from "react";
import { HiddenInput } from "@chase-sets/design-system";
import { createId } from "@chase-sets/primitives/typed-ids";

/** The market choices a buyer made on the page: an explicit listing or Offer and the product options they set. */
export type MarketSelection = Readonly<{
  listingId: string | null;
  offerId: string | null;
  options: readonly Readonly<{ dimensionId: string; optionId: string }>[];
}>;

/** What a Buy form submitted besides its key, so the page a returned error renders shows the same choices. */
export type BuyDraft = Readonly<{ quantity: number | null; selection: MarketSelection | null }>;

type EntryAttemptKeys = Readonly<{
  keyFor: (formId: string, inputs: string) => string;
}>;

type BuyDraftKeeper = ReturnType<typeof keepBuyDraft>;

const EntryAttemptKeyContext = createContext<Readonly<{ keys: EntryAttemptKeys; draft: BuyDraftKeeper }> | null>(null);

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
 * Keeps each form's quantity and the page's market selection for the page
 * view, so a view remount restores what the buyer chose instead of resetting
 * it. Both start from the draft a returned error carried. A selection is kept
 * with the URL selection it was made under (`basis`); a different basis means
 * the page navigated, so the market state starts from the URL instead.
 */
function keepBuyDraft(submitted: BuyDraft | null) {
  const quantities = new Map<string, number | null>();
  let selection: Readonly<{ value: MarketSelection; basis: string | null }> | null = submitted?.selection
    ? { value: submitted.selection, basis: null }
    : null;

  return {
    quantityFor(formId: string) {
      const kept = quantities.get(formId);
      return kept !== undefined ? kept : (submitted?.quantity ?? 1);
    },
    keepQuantity(formId: string, quantity: number | null) {
      quantities.set(formId, quantity);
    },
    selection: () => selection?.value ?? null,
    selectionFor(basis: string) {
      // A returned error's draft belongs to the page that error renders.
      return selection && (selection.basis === null || selection.basis === basis) ? selection.value : null;
    },
    keepSelection(basis: string, value: MarketSelection) {
      selection = { value, basis };
    },
  };
}

/**
 * Holds one Checkout entry key per page view above the route's realtime-keyed
 * view, so loader revalidation, realtime patches and view remounts keep it. It
 * starts from the action-data key, else the loader key; it ignores later loader
 * keys and adopts only a later action-data key (a refused or conflicting key).
 * The Buy draft it keeps lives as long as the page view.
 */
export function EntryAttemptKeyScope({
  loaderKey,
  actionKey,
  actionDraft,
  children,
}: Readonly<{
  loaderKey: string | null | undefined;
  actionKey?: string | null;
  actionDraft?: BuyDraft | null;
  children: ReactNode;
}>) {
  const [scope, setScope] = useState(() => ({
    actionKey,
    keys: holdEntryAttemptKeys(actionKey ?? loaderKey ?? null),
    draft: keepBuyDraft(actionDraft ?? null),
  }));

  if (actionKey && actionKey !== scope.actionKey) {
    setScope({ ...scope, actionKey, keys: holdEntryAttemptKeys(actionKey) });
  }

  return <EntryAttemptKeyContext.Provider value={scope}>{children}</EntryAttemptKeyContext.Provider>;
}

function useEntryAttemptScope() {
  const scope = useContext(EntryAttemptKeyContext);
  if (!scope) {
    throw new Error("A Buy form needs an EntryAttemptKeyScope above it.");
  }

  return scope;
}

/** The key one Buy form sends; `inputs` are the deliberate choices that make a new submission. */
export function useEntryAttemptKey(formId: string, inputs: Readonly<Record<string, unknown>>) {
  return useEntryAttemptScope().keys.keyFor(formId, JSON.stringify(inputs));
}

/** The form's quantity, kept by the page view; only the buyer's edits change it. */
export function useBuyQuantity(formId: string) {
  const { draft } = useEntryAttemptScope();
  const [quantity, setQuantity] = useState(() => draft.quantityFor(formId));

  return [
    quantity,
    (next: number | null) => {
      draft.keepQuantity(formId, next);
      setQuantity(next);
    },
  ] as const;
}

/** Where the market state keeps its selection; null where no Buy page view holds one. */
export function useMarketSelectionKeeper() {
  return useContext(EntryAttemptKeyContext)?.draft ?? null;
}

/** Server HTML carries the key, so a no-JS post, a resubmit or a 307 sends it too. */
export function EntryAttemptKeyField({
  formId,
  inputs,
}: Readonly<{ formId: string; inputs: Readonly<Record<string, unknown>> }>) {
  return <HiddenInput name="entryAttemptKey" value={useEntryAttemptKey(formId, inputs)} />;
}

/** Posts the page's market selection, so a returned error can show the choices this submission made. */
export function MarketSelectionField() {
  return <HiddenInput name="marketSelection" value={JSON.stringify(useEntryAttemptScope().draft.selection())} />;
}
