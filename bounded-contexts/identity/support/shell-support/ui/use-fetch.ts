import { t } from "@chase-sets/localization";
import { useCallback, useEffect, useState } from "react";

export interface UseFetchResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useFetch<T>(
  fetcher: () => Promise<T>,
  deps: readonly unknown[] = [],
  initialData?: T | null,
): UseFetchResult<T> {
  const hasInitialData = initialData !== undefined;
  const [data, setData] = useState<T | null>(initialData ?? null);
  const [loading, setLoading] = useState(!hasInitialData);
  const [error, setError] = useState<string | null>(null);
  const [refreshCount, setRefreshCount] = useState(0);

  const refresh = useCallback(() => setRefreshCount((count) => count + 1), []);

  useEffect(() => {
    if (hasInitialData && refreshCount === 0) {
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetcher()
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((errorValue) => {
        if (!cancelled) {
          setError(
            errorValue instanceof Error ? errorValue.message : t("identity.support.shellSupport.ui.useFetch.unknown.error"),
          );
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [hasInitialData, refreshCount, ...deps]);

  return { data, loading, error, refresh };
}
