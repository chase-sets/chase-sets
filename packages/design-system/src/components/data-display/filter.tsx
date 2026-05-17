import type { HTMLAttributes, ReactNode } from "react";
import { motion } from "motion/react";
import { useChaseMotion } from "../../theme/provider";
import { cx } from "../../utils/cx";
import { toMotionDomProps } from "../../utils/motion-props";
import { Button } from "../actions";
import { BottomSheet, type BottomSheetProps } from "../feedback";

export interface FilterBarProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  children?: ReactNode;
  actions?: ReactNode;
  sticky?: boolean;
  stickyOffset?: string;
}

export function FilterBar({
  children,
  actions,
  sticky = true,
  stickyOffset,
  ...rest
}: FilterBarProps) {
  const motionSettings = useChaseMotion();
  const nativeProps = toMotionDomProps(rest);

  return (
    <motion.div
      {...nativeProps}
      initial={motionSettings.reducedMotion ? false : { opacity: 0, y: 10 }}
      animate={motionSettings.reducedMotion ? undefined : { opacity: 1, y: 0 }}
      transition={
        motionSettings.reducedMotion
          ? undefined
          : { duration: motionSettings.durations.base, ease: motionSettings.easing }
      }
      style={sticky && stickyOffset ? { top: stickyOffset } : undefined}
      className={cx(
        "modern-surface flex flex-col gap-3 rounded-tokenLg border border-muted p-4 shadow-tokenSm md:flex-row md:items-center md:justify-between",
        sticky && "sticky z-sticky",
        sticky && !stickyOffset && "top-16"
      )}
    >
      <div className="flex flex-1 flex-wrap items-end gap-3">{children}</div>
      {actions ? <div className="flex flex-wrap items-end gap-2 md:self-end">{actions}</div> : null}
    </motion.div>
  );
}

export interface FilterBottomSheetProps
  extends Omit<BottomSheetProps, "title" | "trigger" | "children"> {
  trigger: ReactNode;
  children?: ReactNode;
  title?: ReactNode;
  applyLabel?: string;
}

export function FilterBottomSheet({
  trigger,
  children,
  title = "Filters",
  applyLabel = "Apply filters",
  ...rest
}: FilterBottomSheetProps) {
  return (
    <BottomSheet
      {...rest}
      trigger={trigger}
      height="expanded"
      title={title}
      footer={<Button tone="primary" block>{applyLabel}</Button>}
    >
      <div className="space-y-4">{children}</div>
    </BottomSheet>
  );
}

/** @deprecated Use FilterBottomSheet. Drawers are reserved for navigation. */
export interface FilterDrawerProps extends FilterBottomSheetProps {}

/** @deprecated Use FilterBottomSheet. Drawers are reserved for navigation. */
export function FilterDrawer(props: FilterDrawerProps) {
  return <FilterBottomSheet {...props} />;
}

export interface BulkActionBarProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  count: number;
  actions?: ReactNode;
  formatSelectedLabel?: (count: number) => string;
}

export function BulkActionBar({
  count,
  actions,
  formatSelectedLabel = (n) => `${n} item${n === 1 ? "" : "s"} selected`,
  ...rest
}: BulkActionBarProps) {
  const motionSettings = useChaseMotion();
  const nativeProps = toMotionDomProps(rest);

  return (
    <motion.div
      {...nativeProps}
      initial={motionSettings.reducedMotion ? false : { opacity: 0, y: 14 }}
      animate={motionSettings.reducedMotion ? undefined : { opacity: 1, y: 0 }}
      transition={
        motionSettings.reducedMotion
          ? undefined
          : { duration: motionSettings.durations.base, ease: motionSettings.easing }
      }
      className="modern-surface sticky bottom-[calc(7rem+env(safe-area-inset-bottom))] z-sticky flex flex-col gap-3 rounded-tokenLg border border-accent p-4 shadow-overlay md:bottom-4 md:flex-row md:items-center md:justify-between"
    >
      <div className="text-sm font-semibold text-foreground">
        {formatSelectedLabel(count)}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </motion.div>
  );
}
