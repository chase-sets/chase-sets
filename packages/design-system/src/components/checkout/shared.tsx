import type { ReactNode } from "react";
import { cx } from "../../utils/cx";
import { surfaceSemanticToneClasses } from "../../primitives/layout";

export type CheckoutPrimitiveTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface CheckoutSummaryLine {
  label: ReactNode;
  value: ReactNode;
  muted?: boolean;
}

// One canonical quiet style for a deferred/pending money value, shared by every
// totals and line primitive so the "repeat the deferral string in five slots"
// anti-pattern is impossible to express: there is exactly one way to render the
// quiet state, and it never carries a hard currency emphasis.
export const quietMoneyClass = "font-medium text-tertiary";

// The status-tint triple (`border-{tone}-soft bg-{tone}-soft text-{tone}`) is the
// canonical `Surface` semantic tone map. Reuse it so checkout notice/status
// surfaces tint from the same source of truth instead of a duplicated lookup.
const toneClasses = surfaceSemanticToneClasses;

export function CheckoutStatusBadge({
  tone = "neutral",
  children,
}: {
  tone?: CheckoutPrimitiveTone;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-tokenMd border px-2.5 py-1 text-xs font-semibold",
        toneClasses[tone],
      )}
    >
      {children}
    </span>
  );
}
