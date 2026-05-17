import { useState, type HTMLAttributes, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  BottomNav,
  Button,
  ButtonGroup,
  LinkButton,
  PageStepper,
  SideNav,
  TopNav,
  type NavigationItem,
  type PageStepperItem
} from "../components/actions";
import { Switch } from "../components/forms";
import { useChaseMotion } from "../theme/provider";
import { useMediaQuery } from "../hooks";
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
import {
  Badge,
  BottomSheet,
  Sidebar,
  SideSheet,
  type BadgeProps,
  type BottomSheetHeight,
  type BottomSheetProps,
  type PanelWidth,
  type SideSheetProps
} from "../components/feedback";
import { ChaseSetsLogo } from "../brand/chase-sets-logo";
import { Icon, type IconName } from "../icons";
import { toMotionDomProps } from "../utils/motion-props";

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
        "mx-auto flex w-full min-w-0 max-w-full flex-col gap-6 overflow-x-clip px-4 py-6 pb-24 md:px-6 md:pb-8",
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
      className="flex min-w-0 max-w-full flex-col gap-4 md:flex-row md:items-end md:justify-between"
    >
      <div className="min-w-0 space-y-2">
        {eyebrow ? (
          <div className="text-xs font-semibold uppercase text-accent">
            {eyebrow}
          </div>
        ) : null}
        <h1 className="font-display text-4xl font-semibold text-foreground md:text-5xl">
          {title}
        </h1>
        {description ? (
          <div className="max-w-full text-base text-secondary md:max-w-3xl">{description}</div>
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
        <div className="max-w-4xl space-y-2">
          <h2 className="font-heading text-2xl font-semibold leading-tight text-foreground md:text-3xl">{title}</h2>
          {description ? (
            <div className="max-w-3xl text-base leading-7 text-secondary">{description}</div>
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
  onNavSelect?: (key: string) => void;
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
  onNavSelect,
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
        onSelect={onNavSelect}
        actions={actions}
        width={width}
      />
      <main id="main-content" className="relative z-0">
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
      <BottomNav
        items={bottomNavItems}
        activeKey={activeKey}
        onSelect={onNavSelect}
        width={width}
      />
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
        items={[]}
        activeKey={activeKey}
        actions={actions}
        width={width}
      />
      <main
        id="main-content"
        className={cx(
          "mx-auto grid min-h-[calc(100vh-4rem)] w-full gap-6 px-4 py-5 pb-24 lg:grid-cols-[16rem_minmax(0,1fr)] lg:py-6 lg:pb-8",
          layoutWidthClasses[width]
        )}
      >
        <div className="hidden lg:block">
          <div className="sticky top-20 self-start">
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
        <Sidebar label="Desktop search filters" purpose="support" width="filter" sticky>
          <div className="max-h-[calc(100dvh-6rem)] overflow-y-auto overscroll-contain pb-4 pr-1">
            {filters}
          </div>
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
  summaryLabel = "Summary"
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

export function InspectorLayout({
  main,
  inspector
}: InspectorLayoutProps) {
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div>{main}</div>
      <Sidebar label="Inspector" purpose="support" width="detail">
        {inspector}
      </Sidebar>
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
  logo?: ReactNode | false;
  name: ReactNode;
  verified?: boolean;
}

export function SellerBadge({
  logo,
  name,
  verified = false,
  ...rest
}: SellerBadgeProps) {
  const resolvedLogo = logo === false ? null : logo ?? <ChaseSetsLogo decorative size={20} />;

  return (
    <div
      {...rest}
      className="inline-flex items-center gap-2 rounded-full border border-muted bg-elevated px-3 py-1.5 text-sm font-medium text-foreground shadow-tokenSm"
    >
      <span className="inline-flex min-w-0 items-center gap-0">
        {resolvedLogo ? (
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
            {resolvedLogo}
          </span>
        ) : null}
        <span>{name}</span>
      </span>
      {verified ? <Badge tone="success">Verified</Badge> : null}
    </div>
  );
}

export interface OrderSummaryLine {
  label: ReactNode;
  value: ReactNode;
}

export interface TokenSwatchProps {
  label: ReactNode;
  value: ReactNode;
  color:
    | "brandPrimary"
    | "brandSecondary"
    | "cyan"
    | "indigo"
    | "background"
    | "surface"
    | "surface2"
    | "surface3"
    | "border"
    | "textPrimary"
    | "textSecondary"
    | "success"
    | "warning"
    | "danger";
}

const tokenSwatchClasses: Record<TokenSwatchProps["color"], string> = {
  brandPrimary: "bg-accent",
  brandSecondary: "bg-accent-2",
  cyan: "bg-info",
  indigo: "bg-indigo",
  background: "bg-background",
  surface: "bg-surface",
  surface2: "bg-surface-2",
  surface3: "bg-surface-3",
  border: "bg-border",
  textPrimary: "bg-foreground",
  textSecondary: "bg-secondary",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger"
};

export function TokenSwatch({
  label,
  value,
  color
}: TokenSwatchProps) {
  return (
    <Card variant="feature">
      <div className="space-y-3">
        <div
          aria-hidden="true"
          className={cx(
            "h-10 rounded-tokenMd border border-muted shadow-tokenSm",
            tokenSwatchClasses[color]
          )}
        />
        <div>
          <div className="text-sm font-semibold text-foreground">{label}</div>
          <div className="font-mono text-xs text-secondary">{value}</div>
        </div>
      </div>
    </Card>
  );
}

export interface ProductCardProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style" | "title"> {
  title: ReactNode;
  subtitle?: ReactNode;
  price?: ReactNode;
  imageSrc?: string;
  imageAlt?: string;
  imageFit?: "cover" | "contain";
  fallbackImageSrc?: string;
  fallbackImageAlt?: string;
  fallbackImageFit?: "cover" | "contain";
  href?: string;
  target?: string;
  rel?: string;
  onSelect?: () => void;
  selectLabel?: string;
  status?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  actionLabel?: ReactNode;
  children?: ReactNode;
}

export function ProductCard({
  title,
  subtitle,
  price,
  imageSrc,
  imageAlt,
  imageFit = "cover",
  fallbackImageSrc,
  fallbackImageAlt,
  fallbackImageFit = "contain",
  href,
  target,
  rel,
  onSelect,
  selectLabel,
  status,
  meta,
  actions,
  actionLabel,
  children,
  ...rest
}: ProductCardProps) {
  const motionSettings = useChaseMotion();
  const [failedImageSources, setFailedImageSources] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const resolvedImageSrc = imageSrc && !failedImageSources.has(imageSrc)
    ? imageSrc
    : fallbackImageSrc && !failedImageSources.has(fallbackImageSrc)
      ? fallbackImageSrc
      : undefined;
  const showingFallbackImage = Boolean(fallbackImageSrc) && resolvedImageSrc === fallbackImageSrc;
  const resolvedImageFit = showingFallbackImage ? fallbackImageFit : imageFit;
  const resolvedImageAlt = showingFallbackImage
    ? fallbackImageAlt ?? imageAlt ?? ""
    : imageAlt ?? "";
  const interactiveMotion = motionSettings.reducedMotion
    ? {}
    : {
        whileHover: { y: -2, scale: 1.01 },
        whileTap: { y: 0, scale: 0.99 },
        transition: { duration: motionSettings.durations.base, ease: motionSettings.easing }
      };
  const content = (
      <div className="space-y-3">
        <div className="relative overflow-hidden rounded-tokenMd border border-muted bg-surface-2">
          {status ? <div className="absolute left-2 top-2 z-10">{status}</div> : null}
          <div className="flex aspect-[4/3] items-center justify-center">
            {resolvedImageSrc ? (
              <img
                src={resolvedImageSrc}
                alt={resolvedImageAlt}
                onError={() => {
                  setFailedImageSources((current) => {
                    if (current.has(resolvedImageSrc)) {
                      return current;
                    }

                    const next = new Set(current);
                    next.add(resolvedImageSrc);
                    return next;
                  });
                }}
                className={cx(
                  "h-full w-full",
                  resolvedImageFit === "contain" ? "object-contain p-3" : "object-cover"
                )}
              />
            ) : (
              <Icon name="image" size="lg" tone="secondary" />
            )}
          </div>
        </div>
        <div className="space-y-1">
          <div className="text-sm font-semibold leading-snug text-foreground">{title}</div>
          {subtitle ? <div className="text-xs text-secondary">{subtitle}</div> : null}
        </div>
        <div className="flex items-end justify-between gap-3">
          <div>
            {price ? <div className="font-heading text-xl font-semibold text-foreground">{price}</div> : null}
            {meta ? <div className="mt-1 text-xs text-secondary">{meta}</div> : null}
          </div>
          {actions}
        </div>
        {children ? <div>{children}</div> : null}
        {actionLabel ? (
          <div className="inline-flex items-center gap-2 text-sm font-semibold text-accent">
            <span>{actionLabel}</span>
            <Icon name="chevronRight" size="sm" tone="accent" />
          </div>
        ) : null}
      </div>
  );

  const interactiveClassName = cx(
    "focus-ring glass-surface block w-full overflow-hidden rounded-tokenLg border border-muted bg-surface p-4 text-left shadow-tokenSm transition hover:border-accent hover:shadow-tokenMd"
  );

  if (href) {
    return (
      <motion.a
        {...toMotionDomProps(rest)}
        href={href}
        target={target}
        rel={rel ?? (target === "_blank" ? "noreferrer" : undefined)}
        className={interactiveClassName}
        {...interactiveMotion}
      >
        {content}
      </motion.a>
    );
  }

  if (onSelect) {
    return (
      <motion.button
        {...toMotionDomProps(rest)}
        type="button"
        aria-label={selectLabel}
        className={interactiveClassName}
        onClick={onSelect}
        {...interactiveMotion}
      >
        {content}
      </motion.button>
    );
  }

  return (
    <Card {...rest} variant="product" interactive>
      {content}
    </Card>
  );
}

export interface CategoryTileProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  icon: IconName;
  label: ReactNode;
  detail?: ReactNode;
}

export type MarketplaceStatus =
  | "available"
  | "marketOnly"
  | "unavailable"
  | "verified"
  | "watching";

const marketplaceStatusLabels: Record<MarketplaceStatus, string> = {
  available: "Available now",
  marketOnly: "Market only",
  unavailable: "Unavailable",
  verified: "Verified",
  watching: "Watching"
};

const marketplaceStatusTones: Record<MarketplaceStatus, BadgeProps["tone"]> = {
  available: "success",
  marketOnly: "neutral",
  unavailable: "neutral",
  verified: "success",
  watching: "warning"
};

export interface MarketStatusBadgeProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, "className" | "style"> {
  status: MarketplaceStatus;
  label?: ReactNode;
}

export function MarketStatusBadge({
  status,
  label,
  ...rest
}: MarketStatusBadgeProps) {
  return (
    <Badge {...rest} tone={marketplaceStatusTones[status]}>
      {label ?? marketplaceStatusLabels[status]}
    </Badge>
  );
}

export interface MarketplaceFacetItem {
  id: string;
  label: string;
  count?: number;
}

export type MarketplaceFacetSelectionMode = "single" | "multiple";

export interface MarketplaceFacetRailProps {
  title?: ReactNode;
  description?: ReactNode;
  allLabel?: string;
  items: MarketplaceFacetItem[];
  selectedId?: string;
  selectedIds?: readonly string[];
  selectionMode?: MarketplaceFacetSelectionMode;
  onSelect: (id: string) => void;
}

export function MarketplaceFacetRail({
  title = "Browse Categories",
  description = "Narrow the marketplace by category and current catalog depth.",
  allLabel = "All Categories",
  items,
  selectedId = "",
  selectedIds,
  selectionMode = selectedIds ? "multiple" : "single",
  onSelect
}: MarketplaceFacetRailProps) {
  const selectedValues = selectedIds ? new Set(selectedIds) : null;
  const multiple = selectionMode === "multiple";
  return (
    <Card variant="feature">
      <div className="space-y-4">
        <div className="space-y-1">
          <div className="font-heading text-base font-semibold text-foreground">{title}</div>
          {description ? <div className="text-sm text-secondary">{description}</div> : null}
        </div>
        <div className="h-px bg-border" />
        <div className="space-y-2">
          <Button
            tone={!selectedId && (!selectedValues || selectedValues.size === 0) ? "primary" : "ghost"}
            size="sm"
            onClick={() => onSelect("")}
            leadingIcon="grid"
            aria-pressed={!selectedId && (!selectedValues || selectedValues.size === 0)}
            block
          >
            {allLabel}
          </Button>
          {items.map((item) => {
            const selected = selectedValues?.has(item.id) ?? selectedId === item.id;

            return (
              <Button
                key={item.id}
                tone={selected ? "primary" : "ghost"}
                size="sm"
                onClick={() => onSelect(item.id)}
                leadingIcon={multiple && selected ? "check" : "tag"}
                aria-pressed={selected}
                block
              >
                {item.count == null ? item.label : `${item.label} (${item.count})`}
              </Button>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

export interface MarketplaceFacetStripProps {
  title?: ReactNode;
  ariaLabel?: string;
  allLabel: string;
  items: MarketplaceFacetItem[];
  selectedId?: string;
  selectedIds?: readonly string[];
  selectionMode?: MarketplaceFacetSelectionMode;
  onSelect: (id: string) => void;
  allLeadingIcon?: IconName;
  itemLeadingIcon?: IconName;
}

export function MarketplaceFacetStrip({
  title,
  ariaLabel,
  allLabel,
  items,
  selectedId = "",
  selectedIds,
  selectionMode = selectedIds ? "multiple" : "single",
  onSelect,
  allLeadingIcon = "grid",
  itemLeadingIcon = "tag"
}: MarketplaceFacetStripProps) {
  const selectedValues = selectedIds ? new Set(selectedIds) : null;
  const multiple = selectionMode === "multiple";

  return (
    <section
      className="grid min-w-0 gap-2"
      aria-label={ariaLabel ?? (typeof title === "string" ? title : allLabel)}
    >
      {title ? (
        <div className="font-heading text-sm font-semibold text-foreground">{title}</div>
      ) : null}
      <div className="w-full min-w-0 overflow-x-auto">
        <div className="flex min-w-max gap-2 pb-1">
          <Button
            tone={!selectedId && (!selectedValues || selectedValues.size === 0) ? "primary" : "ghost"}
            size="sm"
            onClick={() => onSelect("")}
            leadingIcon={allLeadingIcon}
            aria-pressed={!selectedId && (!selectedValues || selectedValues.size === 0)}
          >
            {allLabel}
          </Button>
          {items.map((item) => {
            const selected = selectedValues?.has(item.id) ?? selectedId === item.id;

            return (
              <Button
                key={item.id}
                tone={selected ? "primary" : "ghost"}
                size="sm"
                onClick={() => onSelect(item.id)}
                leadingIcon={multiple && selected ? "check" : itemLeadingIcon}
                aria-pressed={selected}
              >
                {item.count == null ? item.label : `${item.label} (${item.count})`}
              </Button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export interface MarketplaceFacetChoiceGroupProps {
  title: ReactNode;
  description?: ReactNode;
  allLabel: string;
  items: MarketplaceFacetItem[];
  selectedId?: string;
  selectedIds?: readonly string[];
  selectionMode?: MarketplaceFacetSelectionMode;
  onSelect: (id: string) => void;
  allLeadingIcon?: IconName;
  itemLeadingIcon?: IconName;
}

export function MarketplaceFacetChoiceGroup({
  title,
  description,
  allLabel,
  items,
  selectedId = "",
  selectedIds,
  selectionMode = selectedIds ? "multiple" : "single",
  onSelect,
  allLeadingIcon = "grid",
  itemLeadingIcon = "tag"
}: MarketplaceFacetChoiceGroupProps) {
  const selectedValues = selectedIds ? new Set(selectedIds) : null;
  const anySelected = selectedValues ? selectedValues.size > 0 : Boolean(selectedId);
  const multiple = selectionMode === "multiple";

  const renderChoice = (
    id: string,
    label: string,
    count: number | undefined,
    selected: boolean,
    icon: IconName
  ) => (
    <button
      key={id || "__all__"}
      type="button"
      aria-label={count == null ? label : `${label} (${count})`}
      aria-pressed={selected}
      onClick={() => onSelect(id)}
      className={cx(
        "focus-ring flex min-h-11 w-full items-center justify-between gap-3 rounded-tokenMd border px-3 py-2 text-left text-sm font-semibold transition",
        selected
          ? "border-accent bg-accent text-inverse shadow-tokenSm"
          : "border-muted bg-surface text-foreground hover:border-accent hover:bg-elevated"
      )}
    >
      <span className="inline-flex min-w-0 items-center gap-2">
        {multiple && id ? (
          <span
            aria-hidden="true"
            className={cx(
              "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-tokenSm border",
              selected ? "border-inverse text-inverse" : "border-muted bg-surface-2"
            )}
          >
            {selected ? <Icon name="check" size="sm" tone="inverse" /> : null}
          </span>
        ) : (
          <Icon name={icon} size="sm" tone={selected ? "inverse" : "accent"} />
        )}
        <span className="min-w-0 truncate">{label}</span>
      </span>
      {count == null ? null : (
        <span
          className={cx(
            "shrink-0 rounded-full px-2 py-0.5 text-xs tabular-nums",
            selected ? "bg-accent-contrast/20 text-inverse" : "bg-surface-2 text-secondary"
          )}
        >
          {count}
        </span>
      )}
    </button>
  );

  return (
    <section className="grid gap-3" aria-label={typeof title === "string" ? title : undefined}>
      <div className="space-y-1">
        <h3 className="m-0 font-heading text-sm font-semibold text-foreground">{title}</h3>
        {description ? <div className="text-sm leading-5 text-secondary">{description}</div> : null}
      </div>
      <div className="grid gap-2">
        {renderChoice("", allLabel, undefined, !anySelected, allLeadingIcon)}
        {items.map((item) =>
          renderChoice(
            item.id,
            item.label,
            item.count,
            selectedValues?.has(item.id) ?? selectedId === item.id,
            itemLeadingIcon
          )
        )}
      </div>
    </section>
  );
}

export interface MarketplaceMobileFilterBarProps {
  title?: ReactNode;
  summary?: ReactNode;
  activeFilterCount?: number;
  openLabel?: ReactNode;
  activeFilterLabel?: ReactNode;
  ariaLabel?: string;
  onOpen: () => void;
  clearAction?: ReactNode;
}

export function MarketplaceMobileFilterBar({
  title = "Filters",
  summary,
  activeFilterCount = 0,
  openLabel = "Filters",
  activeFilterLabel,
  ariaLabel = "Search filters",
  onOpen,
  clearAction
}: MarketplaceMobileFilterBarProps) {
  const hasActiveFilters = activeFilterCount > 0;

  return (
    <section className="grid min-w-0 gap-2 lg:hidden" aria-label={ariaLabel}>
      <div className="modern-surface rounded-tokenLg border border-muted p-3 shadow-tokenSm">
        <div className="grid gap-3 min-[420px]:grid-cols-[minmax(0,1fr)_auto] min-[420px]:items-center">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-2 text-sm font-semibold text-foreground">
                <Icon name="filter" size="sm" tone="accent" />
                {title}
              </span>
              {hasActiveFilters ? (
                <Badge tone="accent">
                  {activeFilterLabel ?? `${activeFilterCount} active`}
                </Badge>
              ) : null}
            </div>
            {summary ? <div className="mt-1 text-sm leading-5 text-secondary">{summary}</div> : null}
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-2 min-[420px]:flex min-[420px]:items-center">
            <Button
              type="button"
              tone={hasActiveFilters ? "primary" : "secondary"}
              size="sm"
              leadingIcon="filter"
              onClick={onOpen}
            >
              {openLabel}
            </Button>
            {clearAction}
          </div>
        </div>
      </div>
    </section>
  );
}

export interface MarketplaceFilterBottomSheetProps
  extends Omit<BottomSheetProps, "children" | "trigger"> {
  children?: ReactNode;
  resultSummary?: ReactNode;
}

export function MarketplaceFilterBottomSheet({
  children,
  resultSummary,
  footer,
  ...rest
}: MarketplaceFilterBottomSheetProps) {
  return (
    <BottomSheet
      {...rest}
      height="expanded"
      footer={footer}
    >
      <div className="grid gap-5">
        {resultSummary ? (
          <div className="rounded-tokenMd border border-muted bg-surface-2 px-3 py-2 text-sm font-semibold text-foreground">
            {resultSummary}
          </div>
        ) : null}
        {children}
      </div>
    </BottomSheet>
  );
}

export interface MarketplaceFilterAction {
  id: string;
  label: ReactNode;
  selected?: boolean;
  onSelect: () => void;
}

export interface MarketplaceLandingMetric {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
}

export interface MarketplaceHeroBadge {
  label: ReactNode;
  tone?: BadgeProps["tone"];
}

export interface MarketplaceLandingHeroProps {
  badges?: MarketplaceHeroBadge[];
  title: ReactNode;
  description?: ReactNode;
  search: ReactNode;
  filters?: MarketplaceFilterAction[];
  metrics?: MarketplaceLandingMetric[];
}

export function MarketplaceLandingHero({
  badges = [],
  title,
  description,
  search,
  filters = [],
  metrics = []
}: MarketplaceLandingHeroProps) {
  return (
    <Card variant="feature" glow>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex flex-col justify-center gap-5">
          <div className="space-y-3">
            {badges.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                {badges.map((badge, index) => (
                  <Badge key={index} tone={badge.tone ?? "accent"}>
                    {badge.label}
                  </Badge>
                ))}
              </div>
            ) : null}
            <h1 className="font-display text-3xl font-semibold leading-tight text-foreground md:text-5xl">
              {title}
            </h1>
            {description ? <div className="text-base text-secondary">{description}</div> : null}
          </div>
          {search}
          {filters.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              {filters.map((filter) => (
                <Button
                  key={filter.id}
                  tone={filter.selected ? "primary" : "secondary"}
                  size="sm"
                  onClick={filter.onSelect}
                  leadingIcon={filter.id ? "tag" : "grid"}
                >
                  {filter.label}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
        {metrics.length > 0 ? (
          <div className="hidden md:block">
            <StatGrid columns={{ base: 1 }}>
              {metrics.map((metric, index) => (
                <Stat
                  key={index}
                  label={metric.label}
                  value={metric.value}
                  trend={metric.detail}
                />
              ))}
            </StatGrid>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

export interface MarketingHeroHighlight {
  label: ReactNode;
  value: ReactNode;
}

export interface MarketingImageHeroProps {
  imageSrc: string;
  imageAlt: string;
  imagePosition?: "left" | "center" | "right";
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  conversionPanel?: ReactNode;
  highlights?: MarketingHeroHighlight[];
}

export function MarketingImageHero({
  imageSrc,
  imageAlt,
  imagePosition = "center",
  eyebrow,
  title,
  description,
  actions,
  conversionPanel,
  highlights = []
}: MarketingImageHeroProps) {
  const imagePositionClass =
    imagePosition === "left"
      ? "object-left"
      : imagePosition === "right"
        ? "object-right"
        : "object-[18%_72%]";

  return (
    <section className="relative min-h-[22rem] overflow-hidden rounded-tokenLg border border-[var(--border)] bg-[var(--card)] shadow-tokenLg">
      <img
        src={imageSrc}
        alt={imageAlt}
        className={cx("absolute inset-0 h-full w-full object-cover", imagePositionClass)}
      />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--background)_92%,transparent)_0%,color-mix(in_srgb,var(--background)_78%,transparent)_48%,color-mix(in_srgb,var(--background)_46%,transparent)_100%)] lg:bg-[linear-gradient(90deg,color-mix(in_srgb,var(--background)_94%,transparent)_0%,color-mix(in_srgb,var(--background)_76%,transparent)_44%,color-mix(in_srgb,var(--background)_14%,transparent)_100%)]" />
      <div className="relative grid min-h-[22rem] gap-4 p-4 sm:gap-5 sm:p-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(18rem,0.55fr)] lg:p-6">
        <div className="flex max-w-3xl flex-col justify-start gap-4 lg:justify-center">
          <div className="grid gap-3">
            {eyebrow ? (
              <div className="text-xs font-semibold uppercase tracking-wide text-[var(--primary)]">
                {eyebrow}
              </div>
            ) : null}
            <h1 className="max-w-2xl font-display text-3xl font-semibold leading-tight text-[var(--foreground)] sm:text-4xl md:text-5xl md:leading-[1.08]">
              {title}
            </h1>
            {description ? (
              <p className="max-w-2xl text-base leading-7 text-[var(--text-secondary)] md:text-lg">
                {description}
              </p>
            ) : null}
          </div>
          {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
        </div>
        {conversionPanel ? (
          <div className="grid w-full min-w-0 content-center lg:justify-self-end">
            {conversionPanel}
          </div>
        ) : highlights.length > 0 ? (
          <div className="grid content-end gap-3 lg:justify-self-end">
            {highlights.map((highlight, index) => (
              <div
                key={index}
                className="max-w-sm rounded-tokenLg border border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_88%,transparent)] p-4 shadow-tokenSm backdrop-blur"
              >
                <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
                  {highlight.label}
                </div>
                <div className="mt-1 font-heading text-lg font-semibold text-[var(--foreground)]">
                  {highlight.value}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export interface MarketingVisualCardProps
  extends Omit<HTMLAttributes<HTMLElement>, "className" | "style" | "title"> {
  imageSrc: string;
  imageAlt: string;
  imagePosition?: "left" | "center" | "right";
  badge?: ReactNode;
  badgeTone?: BadgeProps["tone"];
  title: ReactNode;
  description?: ReactNode;
}

const marketingVisualCardImagePositionClasses: Record<
  NonNullable<MarketingVisualCardProps["imagePosition"]>,
  string
> = {
  left: "object-left",
  center: "object-center",
  right: "object-right"
};

export function MarketingVisualCard({
  imageSrc,
  imageAlt,
  imagePosition = "center",
  badge,
  badgeTone = "neutral",
  title,
  description,
  ...rest
}: MarketingVisualCardProps) {
  return (
    <article
      {...rest}
      className="relative min-h-[22rem] overflow-hidden rounded-tokenLg border border-[var(--border)] bg-[var(--card)] shadow-tokenLg"
    >
      <img
        src={imageSrc}
        alt={imageAlt}
        className={cx(
          "absolute inset-0 h-full w-full object-cover",
          marketingVisualCardImagePositionClasses[imagePosition]
        )}
      />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_34%,transparent)_0%,color-mix(in_srgb,var(--card)_88%,transparent)_58%,var(--card)_100%)]" />
      <div className="relative flex min-h-[22rem] flex-col justify-end gap-3 p-5">
        {badge ? (
          <div className="flex">
            <Badge tone={badgeTone}>{badge}</Badge>
          </div>
        ) : null}
        <div className="space-y-2">
          <h3 className="font-heading text-2xl font-semibold leading-snug text-foreground">
            {title}
          </h3>
          {description ? (
            <p className="text-sm leading-6 text-secondary">{description}</p>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export interface MarketplaceProductCardProps {
  href?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  description?: ReactNode;
  imageSrc?: string;
  imageAlt?: string;
  fallbackImageSrc?: string;
  fallbackImageAlt?: string;
  fallbackImageFit?: "cover" | "contain";
  status: MarketplaceStatus;
  price?: ReactNode;
  meta?: ReactNode;
  actionLabel?: ReactNode;
  categoryTags?: ReactNode[];
  metadataTags?: ReactNode[];
}

export function MarketplaceProductCard({
  href,
  title,
  subtitle,
  description,
  imageSrc,
  imageAlt,
  fallbackImageSrc,
  fallbackImageAlt,
  fallbackImageFit = "contain",
  status,
  price,
  meta,
  actionLabel,
  categoryTags = [],
  metadataTags = []
}: MarketplaceProductCardProps) {
  return (
    <ProductCard
      href={href}
      title={title}
      subtitle={subtitle}
      imageSrc={imageSrc}
      imageAlt={imageAlt}
      imageFit="cover"
      fallbackImageSrc={fallbackImageSrc}
      fallbackImageAlt={fallbackImageAlt}
      fallbackImageFit={fallbackImageFit}
      status={<MarketStatusBadge status={status} />}
      price={price}
      meta={meta}
      actionLabel={actionLabel}
    >
      <div className="space-y-2">
        {description ? <div className="text-sm text-secondary">{description}</div> : null}
        {categoryTags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {categoryTags.map((tag, index) => (
              <Badge key={index} tone="accent">
                {tag}
              </Badge>
            ))}
          </div>
        ) : null}
        {metadataTags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {metadataTags.map((tag, index) => (
              <Badge key={index} tone="neutral">
                {tag}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>
    </ProductCard>
  );
}

export function CategoryTile({
  icon,
  label,
  detail,
  ...rest
}: CategoryTileProps) {
  return (
    <Card {...rest} variant="feature" interactive>
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="rounded-tokenLg border border-accent/40 bg-accent/10 p-3 text-accent shadow-tokenSm">
          <Icon name={icon} size="lg" tone="accent" />
        </div>
        <div>
          <div className="text-sm font-semibold text-foreground">{label}</div>
          {detail ? <div className="mt-1 text-xs text-secondary">{detail}</div> : null}
        </div>
      </div>
    </Card>
  );
}

export interface FeatureCardProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style" | "title"> {
  icon: IconName;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

export function FeatureCard({
  icon,
  title,
  description,
  action,
  ...rest
}: FeatureCardProps) {
  return (
    <Card {...rest} variant="feature">
      <div className="flex gap-4">
        <div className="shrink-0 text-accent">
          <Icon name={icon} size="lg" tone="accent" />
        </div>
        <div className="space-y-2">
          <div className="font-heading text-lg font-semibold text-foreground">{title}</div>
          {description ? <div className="text-sm leading-relaxed text-secondary">{description}</div> : null}
          {action ? <div>{action}</div> : null}
        </div>
      </div>
    </Card>
  );
}

export interface PromoStripProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style" | "title"> {
  icon?: IconName;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

export function PromoStrip({
  icon = "spark",
  title,
  description,
  action,
  ...rest
}: PromoStripProps) {
  return (
    <div
      {...rest}
      className="glass-surface glow-accent flex flex-col gap-4 rounded-tokenLg border border-accent/40 p-5 md:flex-row md:items-center md:justify-between"
    >
      <div className="flex items-center gap-4">
        <div className="brand-gradient rounded-tokenLg p-3 text-accent-contrast shadow-tokenMd">
          <Icon name={icon} size="lg" tone="inverse" />
        </div>
        <div>
          <div className="font-heading text-xl font-semibold text-foreground">{title}</div>
          {description ? <div className="mt-1 text-sm text-secondary">{description}</div> : null}
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export interface CheckoutTrustPanelProps {
  title?: ReactNode;
  items: Array<{
    icon: IconName;
    title: ReactNode;
    description?: ReactNode;
  }>;
}

export function CheckoutTrustPanel({
  title = "Buyer Protection",
  items
}: CheckoutTrustPanelProps) {
  return (
    <DetailPanel
      title={
        <span className="inline-flex items-center gap-3">
          <Icon name="shield" size="lg" tone="accent" />
          {title}
        </span>
      }
    >
      <div className="space-y-4">
        {items.map((item, index) => (
          <div key={index} className="flex gap-3">
            <Icon name={item.icon} size="sm" tone="accent" />
            <div>
              <div className="text-sm font-semibold text-foreground">{item.title}</div>
              {item.description ? <div className="text-sm text-secondary">{item.description}</div> : null}
            </div>
          </div>
        ))}
      </div>
    </DetailPanel>
  );
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

export interface MarketplaceProductDetailLayoutProps {
  summary: ReactNode;
  media: ReactNode;
  market: ReactNode;
  commerce: ReactNode;
  mobileActionBar?: ReactNode;
  children?: ReactNode;
}

export function MarketplaceProductDetailLayout({
  summary,
  media,
  market,
  commerce,
  mobileActionBar,
  children
}: MarketplaceProductDetailLayoutProps) {
  return (
    <>
      <div className="grid gap-6 xl:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)_24rem] xl:items-start 2xl:grid-cols-[minmax(20rem,26rem)_minmax(0,1fr)_26rem]">
        <div className="order-2 xl:order-1 xl:sticky xl:top-24">{media}</div>
        <div className="contents min-w-0 xl:order-2 xl:block">
          <div className="order-1 min-w-0">
            {summary}
          </div>
          <div className="order-3 min-w-0 xl:mt-6">{market}</div>
          <div className="order-4 min-w-0 xl:mt-6">{children}</div>
        </div>
        <div className="order-4 hidden min-w-0 xl:order-3 xl:block">
          <Sidebar label="Commerce options" purpose="support" width="summary" sticky>
            {commerce}
          </Sidebar>
        </div>
      </div>
      {mobileActionBar ? (
        <div className="fixed inset-x-3 bottom-20 z-sticky xl:hidden md:bottom-4">
          <div className="mx-auto max-w-3xl">{mobileActionBar}</div>
        </div>
      ) : null}
    </>
  );
}

export interface MarketplaceMetricItem {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
}

export interface MarketplaceMetricStripProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  items: MarketplaceMetricItem[];
}

export function MarketplaceMetricStrip({
  items,
  ...rest
}: MarketplaceMetricStripProps) {
  return (
    <div
      {...rest}
      className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-2 2xl:grid-cols-4"
    >
      {items.map((item, index) => (
        <div
          key={index}
          className="rounded-tokenLg border border-muted bg-surface p-3 shadow-tokenSm"
        >
          <div className="text-xs font-semibold uppercase text-secondary">
            {item.label}
          </div>
          <div className="mt-1 font-heading text-lg font-semibold text-foreground md:text-xl">
            {item.value}
          </div>
          {item.detail ? (
            <div className="mt-1 text-xs text-secondary">{item.detail}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export interface MarketplaceMarketSummaryFact {
  label: ReactNode;
  value: ReactNode;
}

export interface MarketplaceMarketSummaryProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  priceLabel?: ReactNode;
  price: ReactNode;
  facts: MarketplaceMarketSummaryFact[];
  note?: ReactNode;
}

export function MarketplaceMarketSummary({
  priceLabel = "Lowest ask",
  price,
  facts,
  note,
  ...rest
}: MarketplaceMarketSummaryProps) {
  return (
    <div
      {...rest}
      className="modern-surface rounded-tokenLg border border-muted p-4 shadow-tokenSm"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase text-secondary">
            {priceLabel}
          </div>
          <div className="mt-1 font-heading text-2xl font-semibold text-foreground">
            {price}
          </div>
          {note ? <div className="mt-1 text-sm text-secondary">{note}</div> : null}
        </div>
        {facts.length > 0 ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:min-w-[22rem]">
            {facts.map((fact, index) => (
              <div key={index}>
                <div className="text-xs font-semibold uppercase text-secondary">
                  {fact.label}
                </div>
                <div className="mt-1 text-sm font-semibold text-foreground">
                  {fact.value}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export interface CommerceActionBarProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  intentControl?: ReactNode;
  summary: ReactNode;
  primaryAction: ReactNode;
  secondaryAction?: ReactNode;
  tertiaryAction?: ReactNode;
}

export type FormPanelVariant = "card" | "plain";

export interface FormPanelProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  children?: ReactNode;
  variant?: FormPanelVariant;
  glow?: boolean;
}

export function FormPanel({
  children,
  variant = "card",
  glow = false,
  ...rest
}: FormPanelProps) {
  if (variant === "plain") {
    return <div {...rest}>{children}</div>;
  }

  return (
    <Card {...rest} glow={glow}>
      {children}
    </Card>
  );
}

export interface CommerceBottomSheetProps
  extends Omit<BottomSheetProps, "children"> {
  children?: ReactNode;
}

export function CommerceBottomSheet({
  children,
  footer,
  ...rest
}: CommerceBottomSheetProps) {
  return (
    <BottomSheet
      {...rest}
      height="expanded"
      footer={footer}
    >
      {children}
    </BottomSheet>
  );
}

export interface CommerceSheetProps
  extends Omit<SideSheetProps, "children" | "side" | "width"> {
  children?: ReactNode;
  desktopWidth?: PanelWidth;
  mobileHeight?: BottomSheetHeight;
}

export function CommerceSheet({
  children,
  footer,
  desktopWidth = "md",
  mobileHeight = "expanded",
  ...rest
}: CommerceSheetProps) {
  const isDesktop = useMediaQuery("(min-width: 1024px)");

  if (isDesktop) {
    return (
      <SideSheet
        {...rest}
        side="right"
        width={desktopWidth}
        footer={footer}
      >
        {children}
      </SideSheet>
    );
  }

  return (
    <BottomSheet
      {...rest}
      height={mobileHeight}
      footer={footer}
    >
      {children}
    </BottomSheet>
  );
}

export interface MarketplaceActionSheetProps extends CommerceSheetProps {}

export function MarketplaceActionSheet(props: MarketplaceActionSheetProps) {
  return <CommerceSheet {...props} />;
}

export interface ResponsiveEditSheetProps
  extends Omit<SideSheetProps, "children" | "side" | "width"> {
  children?: ReactNode;
  desktopWidth?: PanelWidth;
  mobileHeight?: BottomSheetHeight;
}

export function ResponsiveEditSheet({
  children,
  footer,
  desktopWidth = "md",
  mobileHeight = "full",
  ...rest
}: ResponsiveEditSheetProps) {
  const isDesktop = useMediaQuery("(min-width: 1024px)");

  if (isDesktop) {
    return (
      <SideSheet
        {...rest}
        side="right"
        width={desktopWidth}
        footer={footer}
      >
        {children}
      </SideSheet>
    );
  }

  return (
    <BottomSheet
      {...rest}
      height={mobileHeight}
      footer={footer}
    >
      {children}
    </BottomSheet>
  );
}

export type NotificationCenterView = "feed" | "settings";

export interface NotificationCenterItem {
  deliveryId: string;
  title: ReactNode;
  body: ReactNode;
  sourceLabel?: ReactNode;
  createdAtLabel?: ReactNode;
  actionHref?: string | null;
  actionLabel?: ReactNode;
  read?: boolean;
}

export interface NotificationCenterPreference {
  key: string;
  label: ReactNode;
  description?: ReactNode;
  enabled: boolean;
}

export interface NotificationCenterProductAlert {
  id: string;
  title: ReactNode;
  detail?: ReactNode;
  status: "active" | "paused";
  productHref?: string;
}

export interface NotificationCenterSheetProps
  extends Omit<SideSheetProps, "children" | "title" | "description" | "footer"> {
  title?: ReactNode;
  description?: ReactNode;
  view?: NotificationCenterView;
  unreadCount?: number;
  loading?: boolean;
  notifications: readonly NotificationCenterItem[];
  preferences?: readonly NotificationCenterPreference[];
  productAlerts?: readonly NotificationCenterProductAlert[];
  onViewChange?: (view: NotificationCenterView) => void;
  onMarkRead?: (deliveryId: string) => void;
  onMarkAllRead?: () => void;
  onPreferenceChange?: (key: string, enabled: boolean) => void;
  onProductAlertPause?: (id: string) => void;
  onProductAlertResume?: (id: string) => void;
  onProductAlertDelete?: (id: string) => void;
}

export function NotificationCenterSheet({
  title = "Notifications",
  description = "Review marketplace updates and notification settings.",
  view = "feed",
  unreadCount = 0,
  loading = false,
  notifications,
  preferences = [],
  productAlerts = [],
  onViewChange,
  onMarkRead,
  onMarkAllRead,
  onPreferenceChange,
  onProductAlertPause,
  onProductAlertResume,
  onProductAlertDelete,
  ...rest
}: NotificationCenterSheetProps) {
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const hasNotifications = notifications.length > 0;
  const unreadLabel = unreadCount === 1 ? "1 unread" : `${unreadCount} unread`;
  const footer = view === "feed" ? (
    <Button
      type="button"
      tone="secondary"
      size="sm"
      block
      disabled={unreadCount === 0 || loading}
      onClick={onMarkAllRead}
    >
      Mark all read
    </Button>
  ) : null;
  const content = (
    <div className="grid min-h-0 gap-4">
      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          tone={view === "feed" ? "primary" : "secondary"}
          size="sm"
          onClick={() => onViewChange?.("feed")}
        >
          Feed
        </Button>
        <Button
          type="button"
          tone={view === "settings" ? "primary" : "secondary"}
          size="sm"
          leadingIcon="settings"
          onClick={() => onViewChange?.("settings")}
        >
          Settings
        </Button>
      </div>

      {view === "feed" ? (
        <div className="grid gap-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold text-foreground">Recent updates</span>
            <Badge tone={unreadCount > 0 ? "accent" : "neutral"}>{unreadLabel}</Badge>
          </div>

          {loading ? (
            <div className="rounded-tokenMd border border-muted bg-surface p-4 text-sm text-secondary">
              Loading notifications
            </div>
          ) : hasNotifications ? (
            notifications.map((notification) => (
              <div
                key={notification.deliveryId}
                className="rounded-tokenMd border border-muted bg-surface p-4 shadow-tokenSm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="text-sm font-semibold text-foreground">
                      {notification.title}
                    </div>
                    <div className="text-sm leading-6 text-secondary">
                      {notification.body}
                    </div>
                  </div>
                  <Badge tone={notification.read ? "neutral" : "accent"}>
                    {notification.read ? "Read" : "New"}
                  </Badge>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-secondary">
                  {notification.sourceLabel ? <span>{notification.sourceLabel}</span> : null}
                  {notification.createdAtLabel ? <span>{notification.createdAtLabel}</span> : null}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {notification.actionHref ? (
                    <LinkButton href={notification.actionHref} tone="secondary" size="sm">
                      {notification.actionLabel ?? "Open"}
                    </LinkButton>
                  ) : null}
                  {!notification.read ? (
                    <Button
                      type="button"
                      tone="ghost"
                      size="sm"
                      onClick={() => onMarkRead?.(notification.deliveryId)}
                    >
                      Mark read
                    </Button>
                  ) : null}
                </div>
              </div>
            ))
          ) : (
            <div className="rounded-tokenMd border border-muted bg-surface p-4">
              <div className="text-sm font-semibold text-foreground">No notifications</div>
              <div className="mt-1 text-sm leading-6 text-secondary">
                Order, shipment, and Product alert updates will appear here.
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="grid gap-4">
          <section className="grid gap-3">
            <div>
              <div className="text-sm font-semibold text-foreground">Delivery settings</div>
              <div className="text-sm text-secondary">
                Control how marketplace updates reach this account.
              </div>
            </div>
            {preferences.map((preference) => (
              <Switch
                key={preference.key}
                label={preference.label}
                description={preference.description}
                checked={preference.enabled}
                onCheckedChange={(enabled) => onPreferenceChange?.(preference.key, enabled)}
              />
            ))}
          </section>

          <section className="grid gap-3">
            <div>
              <div className="text-sm font-semibold text-foreground">Product alerts</div>
              <div className="text-sm text-secondary">
                Pause or remove watches created from product detail pages.
              </div>
            </div>
            {productAlerts.length > 0 ? (
              productAlerts.map((alert) => (
                <div
                  key={alert.id}
                  className="rounded-tokenMd border border-muted bg-surface p-4 shadow-tokenSm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-foreground">{alert.title}</div>
                      {alert.detail ? (
                        <div className="mt-1 text-sm leading-6 text-secondary">{alert.detail}</div>
                      ) : null}
                    </div>
                    <Badge tone={alert.status === "active" ? "success" : "neutral"}>
                      {alert.status}
                    </Badge>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {alert.status === "active" ? (
                      <Button
                        type="button"
                        tone="secondary"
                        size="sm"
                        onClick={() => onProductAlertPause?.(alert.id)}
                      >
                        Pause
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        tone="secondary"
                        size="sm"
                        onClick={() => onProductAlertResume?.(alert.id)}
                      >
                        Resume
                      </Button>
                    )}
                    <Button
                      type="button"
                      tone="ghost"
                      size="sm"
                      onClick={() => onProductAlertDelete?.(alert.id)}
                    >
                      Delete
                    </Button>
                    {alert.productHref ? (
                      <LinkButton href={alert.productHref} tone="ghost" size="sm">
                        View product
                      </LinkButton>
                    ) : null}
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-tokenMd border border-muted bg-surface p-4">
                <div className="text-sm font-semibold text-foreground">No Product alerts yet</div>
                <div className="mt-1 text-sm leading-6 text-secondary">
                  Create alerts from product detail pages after choosing product options.
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );

  if (!isDesktop) {
    return (
      <BottomSheet
        {...rest}
        height="expanded"
        title={title}
        description={description}
        footer={footer}
      >
        {content}
      </BottomSheet>
    );
  }

  return (
    <SideSheet
      {...rest}
      side="right"
      width="md"
      title={title}
      description={description}
      footer={footer}
    >
      {content}
    </SideSheet>
  );
}

export function CommerceActionBar({
  intentControl,
  summary,
  primaryAction,
  secondaryAction,
  tertiaryAction,
  ...rest
}: CommerceActionBarProps) {
  const actionCount = [
    primaryAction,
    secondaryAction,
    tertiaryAction,
  ].filter(Boolean).length;

  return (
    <div
      {...rest}
      className="modern-surface rounded-tokenLg border border-muted p-3 shadow-overlay"
    >
      {intentControl ? <div className="mb-3">{intentControl}</div> : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1 text-xs font-medium text-secondary">
          {summary}
        </div>
        <div
          className={cx(
            "grid shrink-0 gap-2 sm:flex sm:items-center [&>*]:w-full sm:[&>*]:w-auto",
            actionCount === 3
              ? "grid-cols-3"
              : actionCount === 2
                ? "grid-cols-2"
                : "grid-cols-1"
          )}
        >
          {primaryAction}
          {secondaryAction}
          {tertiaryAction}
        </div>
      </div>
    </div>
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
