import type { HTMLAttributes, ReactNode } from "react";
import { motion } from "motion/react";
import { ButtonGroup } from "../../components/actions";
import { useChaseMotion } from "../../theme/provider";
import { cx } from "../../utils/cx";
import { Sidebar } from "../../components/feedback";
import { toMotionDomProps } from "../../utils/motion-props";

export interface SearchResultsLayoutProps {
  filters?: ReactNode;
  filtersLabel?: string;
  summary?: ReactNode;
  children?: ReactNode;
}

export function SearchResultsLayout({
  filters,
  filtersLabel = "Desktop search filters",
  summary,
  children,
}: SearchResultsLayoutProps) {
  const content = (
    <div className="min-w-0 space-y-6">
      {summary}
      {children}
    </div>
  );

  if (!filters) {
    return content;
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <div className="hidden lg:block">
        <Sidebar label={filtersLabel} purpose="support" width="filter" sticky>
          <div className="max-h-[calc(100dvh-6rem)] overflow-y-auto overscroll-contain pb-4 pr-1">{filters}</div>
        </Sidebar>
      </div>
      {content}
    </div>
  );
}

export interface CheckoutLayoutProps {
  summary: ReactNode;
  children?: ReactNode;
  summaryMobile?: "after" | "hidden";
  summaryLabel?: string;
}

export function CheckoutLayout({
  summary,
  children,
  summaryMobile = "after",
  summaryLabel = "Summary",
}: CheckoutLayoutProps) {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
      <div>{children}</div>
      <div className={cx(summaryMobile === "hidden" && "hidden lg:block")}>
        <Sidebar label={summaryLabel} purpose="support" width="summary" sticky>
          {summary}
        </Sidebar>
      </div>
    </div>
  );
}

export interface InspectorLayoutProps {
  main: ReactNode;
  inspector: ReactNode;
}

export function InspectorLayout({ main, inspector }: InspectorLayoutProps) {
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div>{main}</div>
      <Sidebar label="Inspector" purpose="support" width="detail">
        {inspector}
      </Sidebar>
    </div>
  );
}

export interface SelectionToolbarProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  count: number;
  actions?: ReactNode;
  formatSelectedLabel?: (count: number) => string;
}

export function SelectionToolbar({
  count,
  actions,
  formatSelectedLabel = (n) => `${n} record${n === 1 ? "" : "s"} selected`,
  ...rest
}: SelectionToolbarProps) {
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
      className="modern-surface sticky bottom-20 z-sticky flex flex-col gap-3 rounded-tokenLg border border-accent p-4 shadow-overlay md:bottom-4 md:flex-row md:items-center md:justify-between"
    >
      <div className="text-sm font-semibold text-foreground">{formatSelectedLabel(count)}</div>
      {actions ? <ButtonGroup>{actions}</ButtonGroup> : null}
    </motion.div>
  );
}
