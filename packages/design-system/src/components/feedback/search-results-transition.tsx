// @ds-leaf

import type { ReactNode } from "react";
import { cx } from "../../utils/cx";
import { Skeleton } from "./loading";

export interface SearchResultsTransitionProps {
  busy?: boolean;
  busyLabel: ReactNode;
  children?: ReactNode;
}

/** Keeps stale results visible while exposing a consistent visual and assistive pending state. */
export function SearchResultsTransition({ busy = false, busyLabel, children }: SearchResultsTransitionProps) {
  return (
    <div>
      {busy ? (
        <div className="mb-4" role="status" aria-live="polite" aria-atomic="true">
          <span className="sr-only">{busyLabel}</span>
          <Skeleton height="sm" />
        </div>
      ) : null}
      <div
        aria-busy={busy || undefined}
        className={cx("transition-opacity motion-reduce:transition-none", busy && "opacity-60")}
      >
        {children}
      </div>
    </div>
  );
}
