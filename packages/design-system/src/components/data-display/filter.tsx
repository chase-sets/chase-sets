import { Children, useState, type HTMLAttributes, type ReactNode } from "react";
import { motion } from "motion/react";
import { useChaseMotion } from "../../theme/provider";
import { cx } from "../../utils/cx";
import { toMotionDomProps } from "../../utils/motion-props";
import { Button } from "../actions";
import {
  BottomSheet,
  Menu,
  SideSheet,
  type BottomSheetProps,
  type MenuItem,
} from "../feedback";

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

export interface FilterAreaProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  children?: ReactNode;
  filters?: readonly ReactNode[];
  actions?: ReactNode;
  sticky?: boolean;
  stickyOffset?: string;
  primaryFilterCount?: number;
  activeFilterCount?: number;
  panelTitle?: ReactNode;
  panelDescription?: ReactNode;
  panelApplyLabel?: string;
  panelCloseLabel?: string;
  overflowTriggerLabel?: string;
}

function formatOverflowTriggerLabel(
  baseLabel: string,
  overflowCount: number,
  activeFilterCount: number | undefined,
) {
  if (activeFilterCount !== undefined && activeFilterCount > 0) {
    return `${baseLabel} (${activeFilterCount} active)`;
  }

  return overflowCount > 0 ? `${baseLabel} (${overflowCount})` : baseLabel;
}

export function FilterArea({
  children,
  filters,
  actions,
  sticky = false,
  stickyOffset,
  primaryFilterCount = 2,
  activeFilterCount,
  panelTitle = "Filters",
  panelDescription,
  panelApplyLabel = "Apply filters",
  panelCloseLabel = "Close filters",
  overflowTriggerLabel = "More filters",
  ...rest
}: FilterAreaProps) {
  const motionSettings = useChaseMotion();
  const nativeProps = toMotionDomProps(rest);
  const [panelOpen, setPanelOpen] = useState(false);
  const filterItems = (filters ?? Children.toArray(children)).filter(Boolean);
  const visibleFilterCount = Math.max(0, primaryFilterCount);
  const inlineFilters = filterItems.slice(0, visibleFilterCount);
  const overflowFilters = filterItems.slice(visibleFilterCount);
  const hasOverflow = overflowFilters.length > 0;
  const triggerLabel = formatOverflowTriggerLabel(
    overflowTriggerLabel,
    overflowFilters.length,
    activeFilterCount,
  );

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
        "modern-surface flex flex-col gap-3 rounded-tokenLg border border-muted p-4 shadow-tokenSm lg:flex-row lg:items-end lg:justify-between",
        sticky && "sticky z-sticky",
        sticky && !stickyOffset && "top-16"
      )}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-end gap-3">
        {inlineFilters.map((filter, index) => (
          <div key={index} className="min-w-[10rem] max-w-full">
            {filter}
          </div>
        ))}
      </div>
      {(hasOverflow || actions) ? (
        <div className="flex shrink-0 flex-wrap items-end gap-2 lg:self-end">
          {hasOverflow ? (
            <SideSheet
              open={panelOpen}
              onOpenChange={setPanelOpen}
              title={panelTitle}
              description={panelDescription}
              closeLabel={panelCloseLabel}
              width="md"
              trigger={
                <Button tone="secondary" leadingIcon="filter">
                  {triggerLabel}
                </Button>
              }
              footer={
                <Button tone="primary" block onClick={() => setPanelOpen(false)}>
                  {panelApplyLabel}
                </Button>
              }
            >
              <div className="grid gap-4">
                {overflowFilters.map((filter, index) => (
                  <div key={index} className="min-w-0">
                    {filter}
                  </div>
                ))}
              </div>
            </SideSheet>
          ) : null}
          {actions}
        </div>
      ) : null}
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

export interface BulkActionBarProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  count: number;
  /**
   * @deprecated Use primaryActions, secondaryActions, and overflowActions to
   * preserve a clear action hierarchy.
   */
  actions?: ReactNode;
  primaryActions?: ReactNode;
  secondaryActions?: ReactNode;
  overflowActions?: MenuItem[];
  overflowLabel?: string;
  formatSelectedLabel?: (count: number) => string;
}

export function BulkActionBar({
  count,
  actions,
  primaryActions,
  secondaryActions,
  overflowActions,
  overflowLabel = "More actions",
  formatSelectedLabel = (n) => `${n} item${n === 1 ? "" : "s"} selected`,
  ...rest
}: BulkActionBarProps) {
  const motionSettings = useChaseMotion();
  const nativeProps = toMotionDomProps(rest);
  const visiblePrimaryActions = primaryActions ?? actions;
  const hasPrimaryActions = hasActionContent(visiblePrimaryActions);
  const hasSecondaryActions = hasActionContent(secondaryActions);
  const hasOverflowActions = (overflowActions?.length ?? 0) > 0;
  const hasActions = hasPrimaryActions || hasSecondaryActions || hasOverflowActions;

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
      className="modern-surface sticky bottom-[calc(7rem+env(safe-area-inset-bottom))] z-sticky rounded-tokenLg border border-accent p-3 shadow-overlay md:bottom-4"
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 shrink-0 rounded-full bg-accent"
          />
          <div className="min-w-0 text-sm font-semibold text-foreground">
            {formatSelectedLabel(count)}
          </div>
        </div>
        {hasActions ? (
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end sm:justify-end">
            {hasPrimaryActions ? (
              <div
                data-bulk-action-region="primary"
                className="flex flex-wrap items-end gap-2"
              >
                {visiblePrimaryActions}
              </div>
            ) : null}
            {hasSecondaryActions ? (
              <div
                data-bulk-action-region="secondary"
                className="flex flex-wrap items-end gap-2 border-t border-muted pt-2 sm:border-l sm:border-t-0 sm:pl-2 sm:pt-0"
              >
                {secondaryActions}
              </div>
            ) : null}
            {hasOverflowActions ? (
              <div
                data-bulk-action-region="overflow"
                className="flex items-center border-t border-muted pt-2 sm:border-l sm:border-t-0 sm:pl-2 sm:pt-0"
              >
                <Menu
                  trigger={
                    <Button
                      tone="secondary"
                      size="sm"
                      trailingIcon="chevronDown"
                    >
                      {overflowLabel}
                    </Button>
                  }
                  items={overflowActions}
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </motion.div>
  );
}

function hasActionContent(node: ReactNode): boolean {
  return node !== null && node !== undefined && node !== false;
}
