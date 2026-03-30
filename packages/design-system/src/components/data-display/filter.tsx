import type { HTMLAttributes, ReactNode } from "react";
import { motion } from "motion/react";
import { useChaseMotion } from "../../theme/provider";
import { cx } from "../../utils/cx";
import { Button } from "../actions";
import { Drawer, type DrawerProps } from "../feedback";

export interface FilterBarProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  children?: ReactNode;
  actions?: ReactNode;
  stickyOffset?: string;
}

export function FilterBar({
  children,
  actions,
  stickyOffset,
  ...rest
}: FilterBarProps) {
  const motionSettings = useChaseMotion();
  const nativeProps = rest as unknown as Record<string, unknown>;

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
      style={stickyOffset ? { top: stickyOffset } : undefined}
      className={cx(
        "modern-surface sticky z-sticky flex flex-col gap-3 rounded-tokenLg border border-muted p-4 shadow-tokenSm md:flex-row md:items-center md:justify-between",
        !stickyOffset && "top-16"
      )}
    >
      <div className="flex flex-1 flex-wrap gap-3">{children}</div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </motion.div>
  );
}

export interface FilterDrawerProps
  extends Omit<DrawerProps, "title" | "trigger" | "children"> {
  trigger: ReactNode;
  children?: ReactNode;
  title?: ReactNode;
  applyLabel?: string;
}

export function FilterDrawer({
  trigger,
  children,
  title = "Filters",
  applyLabel = "Apply filters",
  ...rest
}: FilterDrawerProps) {
  return (
    <Drawer
      {...rest}
      trigger={trigger}
      title={title}
      footer={<Button tone="primary" block>{applyLabel}</Button>}
    >
      <div className="space-y-4">{children}</div>
    </Drawer>
  );
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
  const nativeProps = rest as unknown as Record<string, unknown>;

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
      className="modern-surface sticky bottom-20 z-sticky flex flex-col gap-3 rounded-tokenLg border border-accent p-4 shadow-overlay md:bottom-4 md:flex-row md:items-center md:justify-between"
    >
      <div className="text-sm font-semibold text-foreground">
        {formatSelectedLabel(count)}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </motion.div>
  );
}
