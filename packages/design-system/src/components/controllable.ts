import { useState } from "react";

export function useControllableValue<T>(value: T | undefined, defaultValue: T, onValueChange?: (value: T) => void) {
  const [internalValue, setInternalValue] = useState(defaultValue);
  const resolvedValue = value ?? internalValue;

  function handleValueChange(nextValue: T) {
    if (value === undefined) {
      setInternalValue(nextValue);
    }

    onValueChange?.(nextValue);
  }

  return [resolvedValue, handleValueChange] as const;
}
