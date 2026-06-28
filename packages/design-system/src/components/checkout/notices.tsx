import type { HTMLAttributes, ReactNode } from "react";

// Single-notice helper. Takes prioritized notices and renders exactly ONE,
// encoding the §4 priority ladder (blocking > needs-review > savings > none) so
// the checkout path stops stacking a warning notice and an info notice at once.
export type CheckoutNoticePriority = "blocking" | "needs-review" | "savings" | "info";

export interface CheckoutNoticeCandidate {
  /** Priority bucket. Higher buckets win; `blocking` is highest. */
  priority: CheckoutNoticePriority;
  /** Whether this candidate currently applies. A candidate that is not active is skipped. */
  active?: boolean;
  /** The notice to render when this candidate wins. */
  notice: ReactNode;
}

const noticePriorityRank: Record<CheckoutNoticePriority, number> = {
  blocking: 3,
  "needs-review": 2,
  savings: 1,
  info: 0,
};

/** Pick the single highest-priority active notice from the candidate ladder. */
export function selectCheckoutNotice(candidates: CheckoutNoticeCandidate[]): ReactNode {
  let winner: CheckoutNoticeCandidate | undefined;

  for (const candidate of candidates) {
    if (candidate.active === false) {
      continue;
    }

    if (!winner || noticePriorityRank[candidate.priority] > noticePriorityRank[winner.priority]) {
      winner = candidate;
    }
  }

  return winner?.notice ?? null;
}

export interface CheckoutNoticeStackProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "className" | "style" | "role" | "aria-live" | "aria-atomic"
> {
  candidates: CheckoutNoticeCandidate[];
}

/**
 * Renders the single highest-priority active notice from the candidate ladder
 * (§4 priority ladder). The container is a `role="status"` live region so that
 * screen readers announce the winning notice when checkout state changes — e.g.
 * when a fulfillment review warning replaces a savings info notice. `aria-atomic`
 * ensures the entire notice is re-read, not just the changed text fragment.
 */
export function CheckoutNoticeStack({ candidates, ...rest }: CheckoutNoticeStackProps) {
  const notice = selectCheckoutNotice(candidates);

  // Keep the live region in the DOM even when empty so screen readers have a
  // stable container to observe for changes. When empty, it renders no visual
  // output but the ARIA attributes remain active.
  return (
    <div {...rest} role="status" aria-live="polite" aria-atomic="true">
      {notice}
    </div>
  );
}
