import { useCallback, useMemo, useState } from "react";

export function useBulkOperationState(availableIds: readonly string[]) {
  const available = useMemo(() => new Set(availableIds), [availableIds]);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const selected = useMemo(() => new Set([...selectedIds].filter((id) => available.has(id))), [available, selectedIds]);

  const toggle = useCallback((id: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);

  const clear = useCallback(() => setSelectedIds(new Set()), []);

  return {
    selectedIds: [...selected],
    selectedCount: selected.size,
    isSelected: (id: string) => selected.has(id),
    toggle,
    clear,
  };
}
