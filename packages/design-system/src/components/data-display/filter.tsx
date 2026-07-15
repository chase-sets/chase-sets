import { Children, createContext, useContext, useId, useState, type HTMLAttributes, type ReactNode } from "react";
import { motion } from "motion/react";
import { useChaseMotion } from "../../theme/provider";
import { cx } from "../../utils/cx";
import { toMotionDomProps } from "../../utils/motion-props";
import { Button } from "../actions";
import { BottomSheet, Menu, SideSheet, type BottomSheetProps, type MenuItem, type SideSheetProps } from "../feedback";

export interface FilterBarProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  children?: ReactNode;
  actions?: ReactNode;
  sticky?: boolean;
  stickyOffset?: string;
}

export function FilterBar({ children, actions, sticky = true, stickyOffset, ...rest }: FilterBarProps) {
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
        "modern-surface grid gap-3 rounded-tokenLg border border-muted p-4 shadow-tokenSm md:grid-cols-[minmax(0,1fr)_auto] md:items-end",
        sticky && "sticky z-sticky",
        sticky && !stickyOffset && "top-[var(--shell-header-height,4rem)]",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-end gap-3 md:[&>*]:w-48 md:[&>*]:max-w-full md:[&>*]:min-w-[12rem]">
        {children}
      </div>
      {actions ? (
        <div className="flex min-w-0 flex-wrap items-end justify-start gap-2 md:ml-auto md:justify-end md:self-end md:[&>*]:max-w-full md:[&>div]:items-end">
          {actions}
        </div>
      ) : null}
    </motion.div>
  );
}

export interface ActionBarProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  children?: ReactNode;
  sticky?: boolean;
  stickyOffset?: string;
}

export function ActionBar({ children, sticky = false, stickyOffset, ...rest }: ActionBarProps) {
  const motionSettings = useChaseMotion();
  const nativeProps = toMotionDomProps(rest);

  if (!children) {
    return null;
  }

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
        "modern-surface flex min-w-0 flex-wrap items-end justify-start gap-2 rounded-tokenLg border border-muted p-3 shadow-tokenSm md:justify-end",
        sticky && "sticky z-sticky",
        sticky && !stickyOffset && "top-[var(--shell-header-height,4rem)]",
      )}
    >
      {children}
    </motion.div>
  );
}

export interface FilterAreaProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
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

function formatOverflowTriggerLabel(baseLabel: string, overflowCount: number, activeFilterCount: number | undefined) {
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
  const triggerLabel = formatOverflowTriggerLabel(overflowTriggerLabel, overflowFilters.length, activeFilterCount);

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
        "modern-surface grid gap-3 rounded-tokenLg border border-muted p-4 shadow-tokenSm lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end",
        sticky && "sticky z-sticky",
        sticky && !stickyOffset && "top-[var(--shell-header-height,4rem)]",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-end gap-3">
        {inlineFilters.map((filter, index) => (
          <div key={index} className="min-w-[12rem] max-w-full">
            {filter}
          </div>
        ))}
      </div>
      {hasOverflow || actions ? (
        <div className="flex min-w-0 flex-wrap items-end justify-start gap-2 lg:ml-auto lg:justify-end lg:self-end lg:[&>*]:max-w-full lg:[&>div]:items-end">
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

export interface FilterBottomSheetProps extends Omit<BottomSheetProps, "title" | "trigger" | "children"> {
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
      footer={
        <Button tone="primary" block>
          {applyLabel}
        </Button>
      }
    >
      <div className="space-y-4">{children}</div>
    </BottomSheet>
  );
}

export interface BulkActionBarProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  count: number;
  primaryActions?: ReactNode;
  secondaryActions?: ReactNode;
  overflowActions?: MenuItem[];
  overflowLabel?: string;
  formatSelectedLabel?: (count: number) => string;
}

type BulkActionSurfaceRegistration = {
  ids: Set<string>;
};

const BulkActionSurfaceContext = createContext<BulkActionSurfaceRegistration | null>(null);

export interface BulkActionSurfaceProps {
  children?: ReactNode;
}

export function BulkActionSurface({ children }: BulkActionSurfaceProps) {
  const registration: BulkActionSurfaceRegistration = { ids: new Set() };

  return <BulkActionSurfaceContext.Provider value={registration}>{children}</BulkActionSurfaceContext.Provider>;
}

export function BulkActionBar({
  count,
  primaryActions,
  secondaryActions,
  overflowActions,
  overflowLabel = "More actions",
  formatSelectedLabel = (n) => `${n} item${n === 1 ? "" : "s"} selected`,
  ...rest
}: BulkActionBarProps) {
  const motionSettings = useChaseMotion();
  const nativeProps = toMotionDomProps(rest);
  const hasPrimaryActions = hasActionContent(primaryActions);
  const hasSecondaryActions = hasActionContent(secondaryActions);
  const hasOverflowActions = (overflowActions?.length ?? 0) > 0;
  const hasActions = hasPrimaryActions || hasSecondaryActions || hasOverflowActions;
  useBulkActionSurfaceRegistration();

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
      className="modern-surface sticky bottom-[calc(var(--shell-bottom-nav-height,0px)+var(--space-4)+env(safe-area-inset-bottom))] z-sticky rounded-tokenLg border border-accent p-3 shadow-overlay md:bottom-4"
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-tokenFull bg-accent" />
          <div className="min-w-0 text-sm font-semibold text-foreground">{formatSelectedLabel(count)}</div>
        </div>
        {hasActions ? (
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end sm:justify-end">
            {hasPrimaryActions ? (
              <div data-bulk-action-region="primary" className="flex flex-wrap items-end gap-2">
                {primaryActions}
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
                    <Button tone="secondary" size="sm" trailingIcon="chevronDown">
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

export interface BulkActionPanelProps extends Omit<SideSheetProps, "title" | "trigger" | "children" | "footer"> {
  title: ReactNode;
  description?: ReactNode;
  triggerLabel?: ReactNode;
  trigger?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
}

export function BulkActionPanel({
  title,
  description,
  triggerLabel = "Configure actions",
  trigger,
  children,
  footer,
  width = "md",
  ...rest
}: BulkActionPanelProps) {
  return (
    <SideSheet
      {...rest}
      width={width}
      title={title}
      description={description}
      trigger={
        trigger ?? (
          <Button tone="primary" size="sm" trailingIcon="chevronRight">
            {triggerLabel}
          </Button>
        )
      }
      footer={footer}
    >
      <div className="grid gap-4">{children}</div>
    </SideSheet>
  );
}

function useBulkActionSurfaceRegistration() {
  const registration = useContext(BulkActionSurfaceContext);
  const id = useId();

  if (!registration) {
    return;
  }

  registration.ids.add(id);

  if (registration.ids.size > 1) {
    throw new Error(
      "BulkActionSurface can render only one BulkActionBar. Combine actions into one bar and move advanced choices into BulkActionPanel or overflowActions.",
    );
  }
}

function hasActionContent(node: ReactNode): boolean {
  return node !== null && node !== undefined && node !== false;
}
