import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";

export type OptimisticCorrectionSource = "loader-revalidation" | "typed-snapshot" | "realtime-reload-fallback";

export type OptimisticCorrectionStatus = "idle" | "pending" | "rejected";

export type OptimisticCorrectionSubmit<TValue> = (mutation: {
  value: TValue;
  sequence: number;
  correctionSource: OptimisticCorrectionSource;
}) => void;

export interface OptimisticCorrectionOptions<TValue> {
  resourceKey: string;
  sourceValue: TValue;
  correctionSource: OptimisticCorrectionSource;
  submitting: boolean;
  rejected: boolean;
  submit: OptimisticCorrectionSubmit<TValue>;
  equals?: (left: TValue, right: TValue) => boolean;
}

export interface OptimisticCorrectionController<TValue> {
  value: TValue;
  status: OptimisticCorrectionStatus;
  correctionSource: OptimisticCorrectionSource;
  activeSequence: number;
  setOptimisticValue: (value: TValue) => void;
}

interface PendingMutation<TValue> {
  value: TValue;
  sequence: number;
}

function defaultEquals<TValue>(left: TValue, right: TValue) {
  return Object.is(left, right);
}

/**
 * Shared optimistic-with-correction primitive for Checkout route UI.
 *
 * Required pattern:
 * - keep one controller per resource key, such as a cart line group key;
 * - submit absolute target values with the emitted sequence metadata;
 * - require an explicit correction source, usually fresh loader revalidation;
 * - serialize writes per resource and coalesce rapid edits to the latest target.
 *
 * Anti-patterns:
 * - do not derive the next write from a stale uncontrolled form default;
 * - do not let older responses replace newer optimistic values;
 * - do not keep optimistic state after a rejection without route-owned error UI.
 */
export function useOptimisticCorrection<TValue>({
  resourceKey,
  sourceValue,
  correctionSource,
  submitting,
  rejected,
  submit,
  equals = defaultEquals,
}: OptimisticCorrectionOptions<TValue>): OptimisticCorrectionController<TValue> {
  const [value, setValue] = useState(sourceValue);
  const [status, setStatus] = useState<OptimisticCorrectionStatus>("idle");
  const sequenceRef = useRef(0);
  const inFlightRef = useRef<PendingMutation<TValue> | null>(null);
  const queuedRef = useRef<PendingMutation<TValue> | null>(null);
  const previousSubmittingRef = useRef(false);
  const previousResourceKeyRef = useRef(resourceKey);
  const previousSourceValueRef = useRef(sourceValue);

  const submitMutation = useCallback(
    (mutation: PendingMutation<TValue>) => {
      inFlightRef.current = mutation;
      setStatus("pending");
      submit({ ...mutation, correctionSource });
    },
    [correctionSource, submit],
  );

  const setOptimisticValue = useCallback(
    (nextValue: TValue) => {
      const nextSequence = sequenceRef.current + 1;
      sequenceRef.current = nextSequence;
      const mutation = { value: nextValue, sequence: nextSequence };

      setValue(nextValue);
      setStatus("pending");

      if (inFlightRef.current || submitting) {
        queuedRef.current = mutation;
        return;
      }

      submitMutation(mutation);
    },
    [submitMutation, submitting],
  );

  useEffect(() => {
    if (previousResourceKeyRef.current !== resourceKey) {
      previousResourceKeyRef.current = resourceKey;
      previousSourceValueRef.current = sourceValue;
      sequenceRef.current = 0;
      inFlightRef.current = null;
      queuedRef.current = null;
      setValue(sourceValue);
      setStatus("idle");
    }
  }, [resourceKey, sourceValue]);

  useEffect(() => {
    if (equals(previousSourceValueRef.current, sourceValue)) {
      return;
    }

    previousSourceValueRef.current = sourceValue;

    const queued = queuedRef.current;
    const inFlight = inFlightRef.current;

    if (queued) {
      if (equals(queued.value, sourceValue)) {
        inFlightRef.current = null;
        queuedRef.current = null;
        setValue(sourceValue);
        setStatus("idle");
      }
      return;
    }

    if (inFlight && submitting) {
      if (equals(inFlight.value, sourceValue)) {
        inFlightRef.current = null;
        setValue(sourceValue);
        setStatus("idle");
      }
      return;
    }

    inFlightRef.current = null;
    setValue(sourceValue);
    setStatus("idle");
  }, [equals, sourceValue, submitting]);

  useEffect(() => {
    if (rejected && inFlightRef.current) {
      inFlightRef.current = null;
      queuedRef.current = null;
      setValue(sourceValue);
      setStatus("rejected");
    }
  }, [rejected, sourceValue]);

  useEffect(() => {
    const completed = previousSubmittingRef.current && !submitting;
    previousSubmittingRef.current = submitting;

    if (!completed || rejected || !inFlightRef.current) {
      return;
    }

    const queued = queuedRef.current;

    if (queued && !equals(queued.value, sourceValue)) {
      inFlightRef.current = null;
      queuedRef.current = null;
      submitMutation(queued);
      return;
    }

    if (queued) {
      inFlightRef.current = null;
      queuedRef.current = null;
      setValue(sourceValue);
      setStatus("idle");
      return;
    }

    if (equals(inFlightRef.current.value, sourceValue)) {
      inFlightRef.current = null;
      setValue(sourceValue);
      setStatus("idle");
    }
  }, [equals, rejected, sourceValue, submitMutation, submitting]);

  useEffect(() => {
    if (inFlightRef.current || queuedRef.current) {
      if (equals(sourceValue, value)) {
        setStatus("idle");
      }
      return;
    }

    setValue(sourceValue);
    setStatus((current) => (current === "pending" ? "idle" : current));
  }, [equals, sourceValue, value]);

  return {
    value,
    status,
    correctionSource,
    activeSequence: sequenceRef.current,
    setOptimisticValue,
  };
}

type CartMutationType = "quantity" | "remove" | "lock-preferred-listing";

export interface OptimisticCartMutationLine {
  lineIds: readonly string[];
  quantity: number;
  fulfillment_mode: string;
  locked_listing_id: string | null;
  seller_preference_id: string | null;
  availability_state: string;
}

export interface OptimisticCartMutationController<TLine extends OptimisticCartMutationLine> {
  cartLineGroups: TLine[];
  errorMessage: string | null;
  statusForLine: (line: TLine) => OptimisticCorrectionStatus;
  setQuantity: (line: TLine, quantity: number) => void;
  removeLine: (line: TLine) => void;
  lockPreferredListing: (line: TLine) => void;
}

export interface OptimisticCartMutationOptions<TLine extends OptimisticCartMutationLine> {
  sourceCartLineGroups: readonly TLine[];
}

interface CartMutation {
  type: CartMutationType;
  resourceKey: string;
  lineIds: readonly string[];
  sellerPreferenceId: string | null;
  quantity?: number;
  sequence: number;
}

interface OptimisticCartLinePatch {
  sequence: number;
  quantity?: number;
  removed?: boolean;
  lockedListingId?: string;
  sellerPreferenceId?: string | null;
}

function cartMutationResourceKey(lineIds: readonly string[]) {
  return [...lineIds].sort().join(":");
}

function lineResourceKey(line: OptimisticCartMutationLine) {
  return cartMutationResourceKey(line.lineIds);
}

function sourceSignature(line: OptimisticCartMutationLine | undefined) {
  if (!line) {
    return "missing";
  }

  return [
    Math.max(1, Number(line.quantity) || 1),
    line.fulfillment_mode,
    line.locked_listing_id ?? "",
    line.seller_preference_id ?? "",
    line.availability_state,
    cartMutationResourceKey(line.lineIds),
  ].join("|");
}

function sourceSatisfiesMutation(line: OptimisticCartMutationLine | undefined, mutation: CartMutation) {
  if (mutation.type === "remove") {
    return !line;
  }

  if (!line) {
    return true;
  }

  if (mutation.type === "quantity") {
    return Math.max(1, Number(line.quantity) || 1) === mutation.quantity;
  }

  return line.fulfillment_mode === "locked-listing" && line.locked_listing_id === mutation.sellerPreferenceId;
}

function sourceSatisfiesPatch(line: OptimisticCartMutationLine | undefined, patch: OptimisticCartLinePatch) {
  if (patch.removed) {
    return !line;
  }

  if (!line) {
    return true;
  }

  if (patch.quantity !== undefined && Math.max(1, Number(line.quantity) || 1) !== patch.quantity) {
    return false;
  }

  if (
    patch.lockedListingId !== undefined &&
    (line.fulfillment_mode !== "locked-listing" || line.locked_listing_id !== patch.lockedListingId)
  ) {
    return false;
  }

  return true;
}

function applyMutationToPatch(
  current: OptimisticCartLinePatch | undefined,
  mutation: CartMutation,
): OptimisticCartLinePatch {
  if (mutation.type === "remove") {
    return {
      sequence: mutation.sequence,
      removed: true,
    };
  }

  if (mutation.type === "quantity") {
    return {
      ...current,
      sequence: mutation.sequence,
      quantity: Math.max(1, mutation.quantity ?? 1),
      removed: false,
    };
  }

  return {
    ...current,
    sequence: mutation.sequence,
    lockedListingId: mutation.sellerPreferenceId ?? undefined,
    sellerPreferenceId: mutation.sellerPreferenceId,
    removed: false,
  };
}

function applyPatchToLine<TLine extends OptimisticCartMutationLine>(
  line: TLine,
  patch: OptimisticCartLinePatch | undefined,
): TLine | null {
  if (!patch) {
    return line;
  }

  if (patch.removed) {
    return null;
  }

  let projected: OptimisticCartMutationLine = line;

  if (patch.quantity !== undefined) {
    projected = {
      ...projected,
      quantity: Math.max(1, patch.quantity),
    };
  }

  if (patch.lockedListingId !== undefined) {
    projected = {
      ...projected,
      fulfillment_mode: "locked-listing",
      locked_listing_id: patch.lockedListingId,
      seller_preference_id: patch.sellerPreferenceId ?? patch.lockedListingId,
      availability_state: "available",
    };
  }

  return projected as TLine;
}

function buildCartMutationFormData(mutation: CartMutation) {
  const formData = new FormData();
  const intent =
    mutation.type === "quantity"
      ? "update-cart-line"
      : mutation.type === "remove"
        ? "remove-cart-line"
        : "lock-preferred-listing";

  formData.set("intent", intent);
  for (const lineId of mutation.lineIds) {
    formData.append("lineId", lineId);
  }
  formData.set("sellerPreferenceId", mutation.sellerPreferenceId ?? "");

  if (mutation.type === "quantity") {
    formData.set("quantity", String(Math.max(1, mutation.quantity ?? 1)));
  }

  formData.set("optimisticSequence", String(mutation.sequence));
  formData.set("optimisticStrategy", "optimistic-with-correction");
  formData.set("correctionSource", "fresh-read:loader-revalidation");

  return formData;
}

function queueCartMutation(queued: readonly CartMutation[], mutation: CartMutation): CartMutation[] {
  if (mutation.type === "remove") {
    return [...queued.filter((queuedMutation) => queuedMutation.resourceKey !== mutation.resourceKey), mutation];
  }

  return [
    ...queued.filter(
      (queuedMutation) => queuedMutation.resourceKey !== mutation.resourceKey || queuedMutation.type !== mutation.type,
    ),
    mutation,
  ];
}

function sourceMaps<TLine extends OptimisticCartMutationLine>(lines: readonly TLine[]) {
  const byResource = new Map<string, TLine>();
  const signatures = new Map<string, string>();

  for (const line of lines) {
    const resourceKey = lineResourceKey(line);
    byResource.set(resourceKey, line);
    signatures.set(resourceKey, sourceSignature(line));
  }

  return { byResource, signatures };
}

/**
 * Cart-level optimistic-with-correction controller for reversible Buy Cart UI
 * mutations. Quantity, Remove, and preferred-listing Lock all project through
 * this single controller so visible rows, totals, and cart count cannot drift
 * behind a child-only optimistic state machine.
 */
export function useOptimisticCartMutationConsistency<TLine extends OptimisticCartMutationLine>({
  sourceCartLineGroups,
}: OptimisticCartMutationOptions<TLine>): OptimisticCartMutationController<TLine> {
  const fetcher = useFetcher<{ error?: string }>();
  const [optimisticByResource, setOptimisticByResource] = useState<Record<string, OptimisticCartLinePatch>>({});
  const sequenceRef = useRef(0);
  const inFlightRef = useRef<CartMutation | null>(null);
  const queuedRef = useRef<CartMutation[]>([]);
  const previousSubmittingRef = useRef(false);
  const previousSourceSignaturesRef = useRef<Map<string, string>>(new Map());
  const source = useMemo(() => sourceMaps(sourceCartLineGroups), [sourceCartLineGroups]);
  const sourceByResourceRef = useRef(source.byResource);
  const submitting = fetcher.state !== "idle";
  const errorMessage = typeof fetcher.data?.error === "string" ? fetcher.data.error : null;

  sourceByResourceRef.current = source.byResource;

  const submitMutation = useCallback(
    (mutation: CartMutation) => {
      inFlightRef.current = mutation;
      fetcher.submit(buildCartMutationFormData(mutation), { method: "post", action: "/account/cart" });
    },
    [fetcher],
  );

  const flushNextQueued = useCallback(() => {
    while (queuedRef.current.length > 0) {
      const [nextMutation, ...remaining] = queuedRef.current;
      queuedRef.current = remaining;

      if (sourceSatisfiesMutation(sourceByResourceRef.current.get(nextMutation.resourceKey), nextMutation)) {
        continue;
      }

      submitMutation(nextMutation);
      return;
    }
  }, [submitMutation]);

  const applyMutation = useCallback(
    (mutation: CartMutation) => {
      setOptimisticByResource((current) => ({
        ...current,
        [mutation.resourceKey]: applyMutationToPatch(current[mutation.resourceKey], mutation),
      }));

      if (inFlightRef.current) {
        queuedRef.current = queueCartMutation(queuedRef.current, mutation);
        return;
      }

      submitMutation(mutation);
    },
    [submitMutation],
  );

  const createMutation = useCallback(
    (
      line: OptimisticCartMutationLine,
      mutation: Omit<CartMutation, "resourceKey" | "lineIds" | "sellerPreferenceId" | "sequence">,
    ): CartMutation => {
      const nextSequence = sequenceRef.current + 1;
      sequenceRef.current = nextSequence;

      return {
        ...mutation,
        resourceKey: lineResourceKey(line),
        lineIds: line.lineIds,
        sellerPreferenceId: line.seller_preference_id,
        sequence: nextSequence,
      };
    },
    [],
  );

  const setQuantity = useCallback(
    (line: TLine, quantity: number) => {
      const safeQuantity = Math.max(1, Number(quantity) || 1);
      applyMutation(createMutation(line, { type: "quantity", quantity: safeQuantity }));
    },
    [applyMutation, createMutation],
  );

  const removeLine = useCallback(
    (line: TLine) => {
      applyMutation(createMutation(line, { type: "remove" }));
    },
    [applyMutation, createMutation],
  );

  const lockPreferredListing = useCallback(
    (line: TLine) => {
      if (!line.seller_preference_id) {
        return;
      }

      applyMutation(createMutation(line, { type: "lock-preferred-listing" }));
    },
    [applyMutation, createMutation],
  );

  useEffect(() => {
    if (!errorMessage) {
      return;
    }

    inFlightRef.current = null;
    queuedRef.current = [];
    setOptimisticByResource({});
  }, [errorMessage]);

  useEffect(() => {
    const previousSignatures = previousSourceSignaturesRef.current;
    const changedResources = new Set<string>();

    for (const [resourceKey, nextSignature] of source.signatures) {
      if (previousSignatures.get(resourceKey) !== nextSignature) {
        changedResources.add(resourceKey);
      }
    }

    for (const resourceKey of previousSignatures.keys()) {
      if (!source.signatures.has(resourceKey)) {
        changedResources.add(resourceKey);
      }
    }

    previousSourceSignaturesRef.current = new Map(source.signatures);
    queuedRef.current = queuedRef.current.filter(
      (mutation) => !sourceSatisfiesMutation(source.byResource.get(mutation.resourceKey), mutation),
    );

    const inFlight = inFlightRef.current;
    if (inFlight && sourceSatisfiesMutation(source.byResource.get(inFlight.resourceKey), inFlight)) {
      inFlightRef.current = null;
    }

    setOptimisticByResource((current) => {
      let next = current;

      for (const [resourceKey, patch] of Object.entries(current)) {
        const sourceLine = source.byResource.get(resourceKey);
        const hasQueuedMutation = queuedRef.current.some((mutation) => mutation.resourceKey === resourceKey);
        const isSubmittingInFlight = inFlightRef.current?.resourceKey === resourceKey && submitting;
        const shouldClear =
          sourceSatisfiesPatch(sourceLine, patch) ||
          (!sourceLine && !patch.removed) ||
          (!hasQueuedMutation && !isSubmittingInFlight && changedResources.has(resourceKey) && !submitting);

        if (!shouldClear) {
          continue;
        }

        if (next === current) {
          next = { ...current };
        }
        delete next[resourceKey];
      }

      return next;
    });

    if (!submitting && !inFlightRef.current) {
      flushNextQueued();
    }
  }, [flushNextQueued, source, submitting]);

  useEffect(() => {
    const completed = previousSubmittingRef.current && !submitting;
    previousSubmittingRef.current = submitting;

    if (!completed || errorMessage) {
      return;
    }

    inFlightRef.current = null;
    flushNextQueued();
  }, [errorMessage, flushNextQueued, submitting]);

  const cartLineGroups = useMemo(() => {
    const projected: TLine[] = [];

    for (const sourceLine of sourceCartLineGroups) {
      const line = applyPatchToLine(sourceLine, optimisticByResource[lineResourceKey(sourceLine)]);
      if (line) {
        projected.push(line);
      }
    }

    return projected;
  }, [optimisticByResource, sourceCartLineGroups]);

  const statusForLine = useCallback(
    (line: TLine): OptimisticCorrectionStatus => (optimisticByResource[lineResourceKey(line)] ? "pending" : "idle"),
    [optimisticByResource],
  );

  return {
    cartLineGroups,
    errorMessage,
    statusForLine,
    setQuantity,
    removeLine,
    lockPreferredListing,
  };
}
