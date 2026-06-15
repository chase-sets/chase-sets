import { useCallback, useEffect, useRef, useState } from "react";

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

    if (!queuedRef.current) {
      inFlightRef.current = null;
      setValue(sourceValue);
      setStatus("idle");
    }
  }, [equals, sourceValue]);

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
    inFlightRef.current = null;
    queuedRef.current = null;

    if (queued && !equals(queued.value, sourceValue)) {
      submitMutation(queued);
      return;
    }

    setStatus("idle");
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
