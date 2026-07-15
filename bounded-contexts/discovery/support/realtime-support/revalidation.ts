import { useCallback, useRef } from "react";
import { useRevalidator } from "react-router";

export function useDiscoveryRealtimeRevalidation() {
  const revalidator = useRevalidator();
  const revalidateRef = useRef(revalidator.revalidate);
  revalidateRef.current = revalidator.revalidate;

  return useCallback(() => {
    revalidateRef.current();
  }, []);
}
