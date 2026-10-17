import { useEffect, useState } from "react";
import { useLocation, useNavigation, useRevalidator } from "react-router";

// Each attempt re-runs the loader with the same post-write receipt, and the
// API already waits up to its freshness budget before answering, so attempts
// only need a short pause between them. The cap bounds the recovery; the
// catching-up refresh link stays available once it is spent.
export const REPRICING_DESK_CATCH_UP_DELAY_MS = 250;
export const REPRICING_DESK_CATCH_UP_MAX_ATTEMPTS = 10;

// Reloads a catching-up Seller Desk repricing page until the policy read
// model reaches the seller's write. A new write starts a new budget.
export function useRepricingDeskCatchUp(catchingUp: boolean): void {
  const location = useLocation();
  const navigation = useNavigation();
  const { revalidate, state: revalidationState } = useRevalidator();
  const href = `${location.pathname}${location.search}`;
  const [budget, setBudget] = useState({ href, attempts: 0 });
  if (budget.href !== href) {
    setBudget({ href, attempts: 0 });
  }
  const attempts = budget.href === href ? budget.attempts : 0;

  useEffect(() => {
    if (
      !catchingUp ||
      navigation.state !== "idle" ||
      revalidationState !== "idle" ||
      attempts >= REPRICING_DESK_CATCH_UP_MAX_ATTEMPTS
    ) {
      return;
    }
    const timer = setTimeout(() => {
      setBudget((current) => ({ ...current, attempts: current.attempts + 1 }));
      void revalidate();
    }, REPRICING_DESK_CATCH_UP_DELAY_MS);
    return () => clearTimeout(timer);
  }, [catchingUp, navigation.state, revalidationState, revalidate, attempts]);
}
