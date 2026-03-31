import type { HTMLAttributes, ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  BottomNav,
  Button,
  ButtonGroup,
  PageStepper,
  SideNav,
  TopNav,
  type NavigationItem,
  type PageStepperItem
} from "../components/actions";
import { useChaseMotion } from "../theme/provider";
import {
  SkipLink,
  layoutWidthClasses,
  type LayoutWidth,
  type SidebarWidth
} from "../primitives/layout";
import { cx } from "../utils/cx";
import {
  Card,
  DetailPanel,
  KeyValueList,
  Stat,
  StatGrid
} from "../components/data-display";
import { Badge } from "../components/feedback";

export interface PageProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  children?: ReactNode;
  width?: LayoutWidth;
}

export function Page({
  children,
  width = "full",
  ...rest
}: PageProps) {
  return (
    <div
      {...rest}
      className={cx(
        "mx-auto flex w-full flex-col gap-6 px-4 py-6 pb-24 md:px-6 md:pb-8",
        layoutWidthClasses[width]
      )}
    >
      {children}
    </div>
  );
}

export interface PageHeaderProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style" | "title"> {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  ...rest
}: PageHeaderProps) {
  return (
    <div
      {...rest}
      className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between"
    >
      <div className="space-y-2">
        {eyebrow ? (
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">
            {eyebrow}
          </div>
        ) : null}
        <h1 className="font-display text-4xl font-semibold tracking-tight text-foreground md:text-5xl">
          {title}
        </h1>
        {description ? (
          <div className="max-w-3xl text-base text-secondary">{description}</div>
        ) : null}
      </div>
      {actions ? <ButtonGroup>{actions}</ButtonGroup> : null}
    </div>
  );
}

export interface PageSectionProps
  extends Omit<HTMLAttributes<HTMLElement>, "className" | "style" | "title"> {
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}

export function PageSection({
  title,
  description,
  children,
  ...rest
}: PageSectionProps) {
  return (
    <section {...rest} className="space-y-4">
      {title ? (
        <div className="space-y-1">
          <h2 className="font-heading text-2xl font-semibold text-foreground">{title}</h2>
          {description ? (
            <div className="text-sm text-secondary">{description}</div>
          ) : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export interface SplitPaneProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  primary: ReactNode;
  secondary: ReactNode;
  secondaryWidth?: SidebarWidth;
  secondarySticky?: boolean;
}

const splitPaneWidthClasses: Record<SidebarWidth, string> = {
  nav: "lg:grid-cols-[minmax(0,1fr)_16rem]",
  filter: "lg:grid-cols-[minmax(0,1fr)_18rem]",
  detail: "lg:grid-cols-[minmax(0,1fr)_22rem]",
  summary: "lg:grid-cols-[minmax(0,1fr)_24rem]"
};

export function SplitPane({
  primary,
  secondary,
  secondaryWidth = "detail",
  secondarySticky = false,
  ...rest
}: SplitPaneProps) {
  return (
    <div
      {...rest}
      className={cx(
        "grid gap-6",
        splitPaneWidthClasses[secondaryWidth]
      )}
    >
      <div>{primary}</div>
      <div className={cx(secondarySticky && "lg:sticky lg:top-24 lg:self-start")}>
        {secondary}
      </div>
    </div>
  );
}

export interface RecordPageProps {
  header: ReactNode;
  summary: ReactNode;
  details: ReactNode;
  width?: LayoutWidth;
}

export function RecordPage({
  header,
  summary,
  details,
  width = "full"
}: RecordPageProps) {
  return (
    <Page width={width}>
      {header}
      <SplitPane
        primary={summary}
        secondary={details}
      />
    </Page>
  );
}

export interface MarketplaceShellProps {
  brand: ReactNode;
  topNavItems: NavigationItem[];
  bottomNavItems: NavigationItem[];
  activeKey?: string;
  actions?: ReactNode;
  hero?: ReactNode;
  sidebar?: ReactNode;
  children?: ReactNode;
  width?: LayoutWidth;
}

export function MarketplaceShell({
  brand,
  topNavItems,
  bottomNavItems,
  activeKey,
  actions,
  hero,
  sidebar,
  children,
  width = "full"
}: MarketplaceShellProps) {
  const content = <div className="space-y-6">{children}</div>;

  return (
    <div className="min-h-screen bg-background">
      <SkipLink />
      <TopNav
        brand={brand}
        items={topNavItems}
        activeKey={activeKey}
        actions={actions}
        width={width}
      />
      <main id="main-content">
        <Page width={width}>
          {hero}
          {sidebar ? (
            <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
              <div className="hidden lg:block">{sidebar}</div>
              {content}
            </div>
          ) : (
            content
          )}
        </Page>
      </main>
      <BottomNav items={bottomNavItems} activeKey={activeKey} width={width} />
    </div>
  );
}

export interface AdminShellProps {
  brand: ReactNode;
  navItems: NavigationItem[];
  activeKey?: string;
  actions?: ReactNode;
  children?: ReactNode;
  width?: LayoutWidth;
}

export function AdminShell({
  brand,
  navItems,
  activeKey,
  actions,
  children,
  width = "full"
}: AdminShellProps) {
  return (
    <div className="min-h-screen bg-background">
      <SkipLink />
      <TopNav
        brand={brand}
        items={navItems}
        activeKey={activeKey}
        actions={actions}
        width={width}
      />
      <main
        id="main-content"
        className={cx(
          "mx-auto grid min-h-[calc(100vh-4rem)] w-full gap-6 px-4 py-6 pb-24 lg:grid-cols-[16rem_minmax(0,1fr)] lg:pb-8",
          layoutWidthClasses[width]
        )}
      >
        <div className="hidden lg:block">
          <div className="sticky top-24 self-start">
            <SideNav items={navItems} activeKey={activeKey} />
          </div>
        </div>
        <div className="space-y-6">{children}</div>
      </main>
      <BottomNav items={navItems} activeKey={activeKey} width={width} />
    </div>
  );
}

export interface SearchResultsLayoutProps {
  filters?: ReactNode;
  summary?: ReactNode;
  children?: ReactNode;
}

export function SearchResultsLayout({
  filters,
  summary,
  children
}: SearchResultsLayoutProps) {
  const content = (
    <div className="space-y-6">
      {summary}
      {children}
    </div>
  );

  if (!filters) {
    return content;
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <div className="hidden lg:block">{filters}</div>
      {content}
    </div>
  );
}

export interface CheckoutLayoutProps {
  summary: ReactNode;
  children?: ReactNode;
}

export function CheckoutLayout({
  summary,
  children
}: CheckoutLayoutProps) {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
      <div>{children}</div>
      <div className="lg:sticky lg:top-24 lg:self-start">{summary}</div>
    </div>
  );
}

export interface InspectorLayoutProps {
  main: ReactNode;
  inspector: ReactNode;
}

export function InspectorLayout({
  main,
  inspector
}: InspectorLayoutProps) {
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div>{main}</div>
      <div>{inspector}</div>
    </div>
  );
}

export interface SelectionToolbarProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
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
      {actions ? <ButtonGroup>{actions}</ButtonGroup> : null}
    </motion.div>
  );
}

export interface PriceDisplayProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, "className" | "style"> {
  amount: number;
  currency?: string;
  emphasis?: boolean;
  locale?: string;
}

export function PriceDisplay({
  amount,
  currency = "USD",
  emphasis = false,
  locale,
  ...rest
}: PriceDisplayProps) {
  return (
    <span
      {...rest}
      className={cx(
        "font-heading",
        emphasis ? "text-2xl font-semibold text-foreground" : "text-lg font-semibold text-foreground"
      )}
    >
      {new Intl.NumberFormat(locale, {
        style: "currency",
        currency
      }).format(amount)}
    </span>
  );
}

export interface ConditionBadgeProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, "className" | "style"> {
  condition: "NM" | "LP" | "MP" | "HP" | "DMG";
}

export function ConditionBadge({
  condition,
  ...rest
}: ConditionBadgeProps) {
  const tone =
    condition === "NM"
      ? "success"
      : condition === "LP"
        ? "accent"
        : condition === "MP"
          ? "warning"
          : "danger";

  return (
    <Badge {...rest} tone={tone}>
      {condition}
    </Badge>
  );
}

export interface SellerBadgeProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  name: ReactNode;
  verified?: boolean;
}

export function SellerBadge({
  name,
  verified = false,
  ...rest
}: SellerBadgeProps) {
  return (
    <div
      {...rest}
      className="inline-flex items-center gap-2 rounded-full border border-muted bg-elevated px-3 py-1.5 text-sm font-medium text-foreground shadow-tokenSm"
    >
      <span>{name}</span>
      {verified ? <Badge tone="success">Verified</Badge> : null}
    </div>
  );
}

export interface OrderSummaryLine {
  label: ReactNode;
  value: ReactNode;
}

export interface OrderSummaryProps {
  title?: ReactNode;
  lines: OrderSummaryLine[];
  total: ReactNode;
  totalLabel?: ReactNode;
}

export function OrderSummary({
  title = "Order summary",
  lines,
  total,
  totalLabel = "Total"
}: OrderSummaryProps) {
  return (
    <DetailPanel title={title}>
      <KeyValueList
        items={lines.map((line) => ({
          key: line.label,
          value: line.value
        }))}
      />
      <div className="flex items-center justify-between border-t border-muted pt-4">
        <span className="text-sm font-semibold text-foreground">{totalLabel}</span>
        <span className="font-heading text-2xl font-semibold text-foreground">{total}</span>
      </div>
    </DetailPanel>
  );
}

export interface MetricStripItem {
  label: ReactNode;
  value: ReactNode;
  trend?: ReactNode;
}

export interface MetricStripProps {
  items: MetricStripItem[];
}

export function MetricStrip({
  items
}: MetricStripProps) {
  return (
    <StatGrid columns={{ base: 1, sm: 2, xl: 4 }}>
      {items.map((item, index) => (
        <Stat
          key={index}
          label={item.label}
          value={item.value}
          trend={item.trend}
        />
      ))}
    </StatGrid>
  );
}

export interface WizardStep {
  key: string;
  label: string;
  description?: string;
  content: ReactNode;
  isValid?: boolean;
}

export interface WizardProps {
  steps: WizardStep[];
  activeStep: string;
  onStepChange: (key: string) => void;
  onComplete?: () => void;
  nextLabel?: string;
  previousLabel?: string;
  completeLabel?: string;
}

export function Wizard({
  steps,
  activeStep,
  onStepChange,
  onComplete,
  nextLabel = "Continue",
  previousLabel = "Back",
  completeLabel = "Complete"
}: WizardProps) {
  const motionSettings = useChaseMotion();
  const activeIndex = steps.findIndex((s) => s.key === activeStep);
  const current = steps[activeIndex];
  const isFirst = activeIndex === 0;
  const isLast = activeIndex === steps.length - 1;

  const stepperItems: PageStepperItem[] = steps.map((step, index) => ({
    label: step.label,
    description: step.description,
    status:
      index < activeIndex
        ? "complete"
        : index === activeIndex
          ? "current"
          : "upcoming"
  }));

  return (
    <div className="space-y-6">
      <PageStepper items={stepperItems} />
      <AnimatePresence initial={false} mode="wait">
        <motion.div
          key={current?.key}
          initial={motionSettings.reducedMotion ? false : { opacity: 0, x: 18 }}
          animate={motionSettings.reducedMotion ? undefined : { opacity: 1, x: 0 }}
          exit={motionSettings.reducedMotion ? undefined : { opacity: 0, x: -12 }}
          transition={
            motionSettings.reducedMotion
              ? undefined
              : { duration: motionSettings.durations.base, ease: motionSettings.easing }
          }
        >
          {current?.content}
        </motion.div>
      </AnimatePresence>
      <div className="flex items-center justify-between gap-3">
        <div>
          {!isFirst ? (
            <Button
              tone="secondary"
              onClick={() => onStepChange(steps[activeIndex - 1].key)}
            >
              {previousLabel}
            </Button>
          ) : null}
        </div>
        <div>
          {isLast ? (
            <Button
              tone="primary"
              disabled={current?.isValid === false}
              onClick={onComplete}
            >
              {completeLabel}
            </Button>
          ) : (
            <Button
              tone="primary"
              disabled={current?.isValid === false}
              onClick={() => onStepChange(steps[activeIndex + 1].key)}
            >
              {nextLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
