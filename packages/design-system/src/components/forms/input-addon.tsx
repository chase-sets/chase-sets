import { type ReactNode } from "react";
import { cx } from "../../utils/cx";

/**
 * Internal forms-slice slot helper for inputs that pin a decorative or
 * interactive adornment (currency symbol, search icon, password toggle) inside a
 * single-line control. It owns the `relative` positioning context and the
 * `absolute inset-y-0` slot chrome so no input needs to hand-roll a raw
 * `relative` wrapper plus an absolutely-positioned host span. The control itself
 * keeps its own padding offset (e.g. `pl-[...]`) so the text never overlaps the
 * adornment.
 *
 * Not exported from the design-system surface — it is a leaf used only by the
 * forms inputs in this slice.
 */
export interface InputAddonSlot {
  /** Slot content (an icon, a symbol, or an interactive control). */
  content: ReactNode;
  /**
   * Interactive slots (a toggle button) receive pointer events and stay in the
   * accessibility tree. Decorative slots (a currency symbol, a search icon) are
   * `pointer-events-none` and `aria-hidden` so clicks fall through to the input
   * and assistive tech ignores the ornament. Defaults to decorative (`false`).
   */
  interactive?: boolean;
  /** Optional muted tone applied to a decorative ornament (e.g. a currency symbol). */
  muted?: boolean;
}

export interface InputAddonProps {
  /** The control the adornment decorates (typically an `<input>`). */
  children: ReactNode;
  /** Adornment pinned to the leading (inline-start) edge. */
  start?: InputAddonSlot;
  /** Adornment pinned to the trailing (inline-end) edge. */
  end?: InputAddonSlot;
}

function AddonSlot({ side, slot }: { side: "left" | "right"; slot: InputAddonSlot }) {
  const interactive = slot.interactive ?? false;

  return (
    <span
      aria-hidden={interactive ? undefined : "true"}
      className={cx(
        "absolute inset-y-0 flex items-center",
        side === "left" ? "left-[var(--control-md-px)]" : "right-[var(--control-md-px)]",
        !interactive && "pointer-events-none",
        slot.muted && "text-secondary",
      )}
    >
      {slot.content}
    </span>
  );
}

export function InputAddon({ children, start, end }: InputAddonProps) {
  return (
    <div className="relative">
      {start ? <AddonSlot side="left" slot={start} /> : null}
      {children}
      {end ? <AddonSlot side="right" slot={end} /> : null}
    </div>
  );
}
