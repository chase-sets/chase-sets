import type { HTMLAttributes, ReactNode } from "react";
import { SectionNavigation, type SectionNavigationGroup } from "../components/actions";
import { Badge, type BadgeProps } from "../components/feedback";
import { Form, type FormProps } from "../components/forms";
import { resolveDensityMode, type DensityInput } from "../theme/tokens";
import { cx } from "../utils/cx";
import { resolveSpaceClass, type SpaceToken } from "../utils/system";

type FrameProps<T extends HTMLElement = HTMLElement> = Omit<HTMLAttributes<T>, "className" | "style">;
type TitledFrameProps<T extends HTMLElement = HTMLElement> = Omit<FrameProps<T>, "title">;
type BadgeTone = NonNullable<BadgeProps["tone"]>;

export interface DenseAdminWorkbenchProps extends FrameProps<HTMLElement> {
  children?: ReactNode;
}

export function DenseAdminWorkbench({ children, ...rest }: DenseAdminWorkbenchProps) {
  return (
    <section {...rest} className="grid gap-5">
      {children}
    </section>
  );
}

export interface DenseAdminWorkbenchHeaderProps extends TitledFrameProps<HTMLDivElement> {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  headingLevel?: 1 | 2;
}

export function DenseAdminWorkbenchHeader({
  eyebrow,
  title,
  description,
  actions,
  headingLevel = 1,
  ...rest
}: DenseAdminWorkbenchHeaderProps) {
  const Heading = headingLevel === 1 ? "h1" : "h2";

  return (
    <div {...rest} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
      <div className="min-w-0">
        {eyebrow ? <div className="text-xs font-semibold uppercase tracking-normal text-accent">{eyebrow}</div> : null}
        <Heading className="mt-1 font-heading text-2xl font-semibold leading-tight text-foreground md:text-3xl">
          {title}
        </Heading>
        {description ? <p className="mt-2 max-w-4xl text-sm leading-6 text-secondary">{description}</p> : null}
      </div>
      {actions ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end sm:justify-end">{actions}</div>
      ) : null}
    </div>
  );
}

export interface DenseAdminWorkbenchLayoutProps extends Omit<FrameProps<HTMLDivElement>, "onSelect"> {
  navigationGroups: SectionNavigationGroup[];
  activeNavigationKey: string;
  navigationLabel: string;
  mobileNavigationLabel: string;
  onNavigationSelect?: (key: string) => void;
  children?: ReactNode;
}

export function DenseAdminWorkbenchLayout({
  navigationGroups,
  activeNavigationKey,
  navigationLabel,
  mobileNavigationLabel,
  onNavigationSelect,
  children,
  ...rest
}: DenseAdminWorkbenchLayoutProps) {
  return (
    <div {...rest} className="grid gap-5 lg:grid-cols-[18rem_minmax(0,1fr)] lg:items-start">
      <div className="lg:sticky lg:top-20">
        <SectionNavigation
          groups={navigationGroups}
          activeKey={activeNavigationKey}
          label={navigationLabel}
          mobileLabel={mobileNavigationLabel}
          onSelect={onNavigationSelect}
        />
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export interface WorkbenchStackProps extends FrameProps<HTMLDivElement> {
  children?: ReactNode;
  gap?: "sm" | "md" | "lg";
  element?: "div" | "section";
}

type WorkbenchGap = NonNullable<WorkbenchStackProps["gap"]>;

const workbenchGapTokens = {
  sm: 2,
  md: 4,
  lg: 5,
} as const satisfies Record<WorkbenchGap, SpaceToken>;

function resolveWorkbenchGapClass(gap: WorkbenchGap): string {
  return resolveSpaceClass("gap", workbenchGapTokens[gap]);
}

const stackGapClasses: Record<WorkbenchGap, string> = {
  sm: resolveWorkbenchGapClass("sm"),
  md: resolveWorkbenchGapClass("md"),
  lg: resolveWorkbenchGapClass("lg"),
};

export function WorkbenchStack({ children, gap = "md", element = "div", ...rest }: WorkbenchStackProps) {
  const Component = element;

  return (
    <Component {...rest} className={cx("grid min-w-0", stackGapClasses[gap])}>
      {children}
    </Component>
  );
}

export interface WorkbenchGridProps extends FrameProps<HTMLDivElement> {
  children?: ReactNode;
  columns?: "two" | "three" | "detail" | "sidebar" | "equalDetail";
  gap?: WorkbenchGap;
}

const workbenchGridColumnClasses: Record<NonNullable<WorkbenchGridProps["columns"]>, string> = {
  two: "xl:grid-cols-2",
  three: "xl:grid-cols-3",
  detail: "xl:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]",
  sidebar: "xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]",
  equalDetail: "xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(18rem,24rem)]",
};

export function WorkbenchGrid({ children, columns = "two", gap = "md", ...rest }: WorkbenchGridProps) {
  return (
    <div {...rest} className={cx("grid min-w-0", resolveWorkbenchGapClass(gap), workbenchGridColumnClasses[columns])}>
      {children}
    </div>
  );
}

export interface WorkbenchFormProps extends Omit<FormProps, "className" | "style" | "spacing"> {
  children?: ReactNode;
  variant?: "surface" | "inline" | "plain" | "button";
}

const workbenchFormClasses: Record<NonNullable<WorkbenchFormProps["variant"]>, string> = {
  surface: "grid min-w-0 gap-3 rounded-tokenMd border border-muted p-4",
  inline: "grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end",
  plain: "grid min-w-0 gap-3",
  button: "inline-flex",
};

export function WorkbenchForm({ children, variant = "surface", ...rest }: WorkbenchFormProps) {
  return (
    <Form {...rest} spacing="none" className={workbenchFormClasses[variant]}>
      {children}
    </Form>
  );
}

export interface WorkbenchFormGridProps extends FrameProps<HTMLDivElement> {
  children?: ReactNode;
  columns?: "one" | "two" | "three";
}

const workbenchFormGridColumnClasses: Record<NonNullable<WorkbenchFormGridProps["columns"]>, string> = {
  one: "",
  two: "md:grid-cols-2",
  three: "sm:grid-cols-3",
};

export function WorkbenchFormGrid({ children, columns = "two", ...rest }: WorkbenchFormGridProps) {
  return (
    <div {...rest} className={cx("grid gap-3", workbenchFormGridColumnClasses[columns])}>
      {children}
    </div>
  );
}

export interface WorkbenchActionRowProps extends FrameProps<HTMLDivElement> {
  children?: ReactNode;
  align?: "start" | "end" | "between";
  stackOnMobile?: boolean;
}

const actionRowAlignClasses: Record<NonNullable<WorkbenchActionRowProps["align"]>, string> = {
  start: "justify-start",
  end: "justify-end",
  between: "justify-between",
};

export function WorkbenchActionRow({
  children,
  align = "end",
  stackOnMobile = false,
  ...rest
}: WorkbenchActionRowProps) {
  return (
    <div
      {...rest}
      className={cx(
        stackOnMobile ? "flex flex-col sm:flex-row sm:flex-wrap" : "flex flex-wrap",
        "min-w-0 gap-2",
        align === "between" && "items-center",
        actionRowAlignClasses[align],
      )}
    >
      {children}
    </div>
  );
}

export interface WorkbenchSplitHeaderProps extends TitledFrameProps<HTMLDivElement> {
  title: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}

export function WorkbenchSplitHeader({ title, actions, children, ...rest }: WorkbenchSplitHeaderProps) {
  return (
    <div {...rest} className="flex min-w-0 flex-wrap items-center justify-between gap-2">
      <div className="min-w-0 text-sm font-semibold text-foreground">{title}</div>
      {actions ? <WorkbenchActionRow>{actions}</WorkbenchActionRow> : null}
      {children}
    </div>
  );
}

export interface WorkbenchDetailPanelProps extends FrameProps<HTMLDivElement> {
  children?: ReactNode;
  variant?: "surface" | "plain";
}

export function WorkbenchDetailPanel({ children, variant = "surface", ...rest }: WorkbenchDetailPanelProps) {
  return (
    <div
      {...rest}
      className={cx(
        "grid min-w-0 gap-3",
        variant === "surface" && "rounded-tokenMd border border-border bg-surface-2 p-3",
      )}
    >
      {children}
    </div>
  );
}

export interface WorkbenchGridSpanProps extends FrameProps<HTMLDivElement> {
  children?: ReactNode;
  columns?: 2 | 3;
}

export function WorkbenchGridSpan({ children, columns = 3, ...rest }: WorkbenchGridSpanProps) {
  return (
    <div {...rest} className={columns === 3 ? "xl:col-span-3" : "xl:col-span-2"}>
      {children}
    </div>
  );
}

export interface WorkbenchTextProps extends FrameProps<HTMLSpanElement> {
  children?: ReactNode;
  element?: "span" | "div" | "p" | "h3" | "h4";
  size?: "xs" | "sm";
  tone?: "foreground" | "secondary" | "tertiary";
  weight?: "regular" | "semibold";
  wrap?: "normal" | "break" | "anywhere" | "truncate";
  leading?: "tight" | "normal";
  mono?: boolean;
}

const workbenchTextSizeClasses: Record<NonNullable<WorkbenchTextProps["size"]>, string> = {
  xs: "text-xs",
  sm: "text-sm",
};

const workbenchTextToneClasses: Record<NonNullable<WorkbenchTextProps["tone"]>, string> = {
  foreground: "text-foreground",
  secondary: "text-secondary",
  tertiary: "text-tertiary",
};

export function WorkbenchText({
  children,
  element = "span",
  size = "sm",
  tone = "secondary",
  weight = "regular",
  wrap = "normal",
  leading = "normal",
  mono = false,
  ...rest
}: WorkbenchTextProps) {
  const Component = element;

  return (
    <Component
      {...rest}
      className={cx(
        workbenchTextSizeClasses[size],
        workbenchTextToneClasses[tone],
        weight === "semibold" && "font-semibold",
        leading === "normal" && "leading-5",
        wrap === "break" && "break-words",
        wrap === "anywhere" && "break-words [overflow-wrap:anywhere]",
        wrap === "truncate" && "truncate",
        mono && "font-mono",
      )}
    >
      {children}
    </Component>
  );
}

export interface WorkbenchDataCellProps extends TitledFrameProps<HTMLDivElement> {
  title: ReactNode;
  description?: ReactNode;
  detail?: ReactNode;
  badges?: ReactNode;
  titleWeight?: "regular" | "semibold";
  descriptionTone?: "secondary" | "tertiary";
  descriptionVariant?: "text" | "mono";
  truncateTitle?: boolean;
}

export function WorkbenchDataCell({
  title,
  description,
  detail,
  badges,
  titleWeight = "semibold",
  descriptionTone = "secondary",
  descriptionVariant = "text",
  truncateTitle = false,
  ...rest
}: WorkbenchDataCellProps) {
  return (
    <div {...rest} className="grid min-w-0 gap-1">
      <div
        className={cx(
          "text-sm text-foreground",
          titleWeight === "semibold" ? "font-semibold" : "font-normal",
          truncateTitle ? "truncate" : "break-words",
        )}
      >
        {title}
      </div>
      {description ? (
        <div
          className={cx(
            "break-words text-xs leading-5",
            descriptionTone === "secondary" ? "text-secondary" : "text-tertiary",
            descriptionVariant === "mono" && "break-all font-mono",
          )}
        >
          {description}
        </div>
      ) : null}
      {detail ? <div className="break-words text-xs leading-5 text-secondary">{detail}</div> : null}
      {badges ? <div>{badges}</div> : null}
    </div>
  );
}

export interface WorkbenchValueListProps extends FrameProps<HTMLDivElement> {
  children?: ReactNode;
  density?: DensityInput;
}

export function WorkbenchValueList({ children, density = "compact", ...rest }: WorkbenchValueListProps) {
  const resolvedDensity = resolveDensityMode(density);

  return (
    <div
      {...rest}
      className={cx("grid min-w-0 text-xs leading-5 text-secondary", resolvedDensity === "compact" ? "gap-1" : "gap-2")}
    >
      {children}
    </div>
  );
}

export interface WorkbenchLinkListProps extends FrameProps<HTMLDivElement> {
  children?: ReactNode;
  align?: "start" | "end";
}

export function WorkbenchLinkList({ children, align = "start", ...rest }: WorkbenchLinkListProps) {
  return (
    <div {...rest} className={cx("grid gap-1", align === "end" && "justify-items-end")}>
      {children}
    </div>
  );
}

export interface BadgeClusterItem {
  key: string;
  label: ReactNode;
  tone?: BadgeTone;
}

export interface BadgeClusterProps extends FrameProps<HTMLDivElement> {
  items?: readonly BadgeClusterItem[];
  children?: ReactNode;
  align?: "start" | "end";
  emptyLabel?: ReactNode;
  emptyTone?: BadgeTone;
}

export function BadgeCluster({
  items,
  children,
  align = "start",
  emptyLabel,
  emptyTone = "neutral",
  ...rest
}: BadgeClusterProps) {
  const itemBadges =
    items && items.length > 0
      ? items.map((item) => (
          <Badge key={item.key} tone={item.tone ?? "neutral"}>
            {item.label}
          </Badge>
        ))
      : null;
  const content = itemBadges ?? children ?? (emptyLabel ? <Badge tone={emptyTone}>{emptyLabel}</Badge> : null);

  if (!content) {
    return null;
  }

  return (
    <div {...rest} className={cx("flex min-w-0 flex-wrap gap-1.5", align === "end" ? "justify-end" : "justify-start")}>
      {content}
    </div>
  );
}

export interface EvidencePanelProps extends TitledFrameProps<HTMLElement> {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  children?: ReactNode;
}

export function EvidencePanel({ eyebrow, title, description, status, children, ...rest }: EvidencePanelProps) {
  return (
    <section {...rest} className="grid gap-3 border-t border-muted pt-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {eyebrow ? (
            <div className="text-xs font-semibold uppercase tracking-normal text-accent">{eyebrow}</div>
          ) : null}
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {description ? <p className="mt-1 text-xs leading-5 text-secondary">{description}</p> : null}
        </div>
        {status ? <div className="shrink-0">{status}</div> : null}
      </div>
      {children}
    </section>
  );
}

export interface EvidenceListItem {
  key: string;
  label?: ReactNode;
  description: ReactNode;
  tone?: BadgeTone;
}

export interface EvidenceListProps extends TitledFrameProps<HTMLDivElement> {
  title: ReactNode;
  items: readonly EvidenceListItem[];
  emptyLabel?: ReactNode;
  emptyTone?: BadgeTone;
  density?: DensityInput;
}

export function EvidenceList({
  title,
  items,
  emptyLabel,
  emptyTone = "success",
  density = "comfortable",
  ...rest
}: EvidenceListProps) {
  const resolvedDensity = resolveDensityMode(density);

  return (
    <div {...rest} className="grid gap-2">
      <div className="text-sm font-semibold text-foreground">{title}</div>
      <div className="grid gap-2">
        {items.length > 0 ? (
          items.map((item) => (
            <div
              key={item.key}
              className={cx(
                "grid gap-1 rounded-tokenMd border border-muted",
                resolvedDensity === "compact" ? "p-2" : "p-3",
              )}
            >
              {item.label ? (
                <BadgeCluster items={[{ key: item.key, label: item.label, tone: item.tone ?? "neutral" }]} />
              ) : null}
              <div className="break-words text-xs leading-5 text-secondary">{item.description}</div>
            </div>
          ))
        ) : emptyLabel ? (
          <Badge tone={emptyTone}>{emptyLabel}</Badge>
        ) : null}
      </div>
    </div>
  );
}

export interface EvidenceStringListProps extends TitledFrameProps<HTMLDivElement> {
  title: ReactNode;
  items: readonly ReactNode[];
  emptyLabel: ReactNode;
  emptyTone?: BadgeTone;
}

export function EvidenceStringList({
  title,
  items,
  emptyLabel,
  emptyTone = "success",
  ...rest
}: EvidenceStringListProps) {
  return (
    <div {...rest} className="grid gap-2">
      <div className="text-sm font-semibold text-foreground">{title}</div>
      {items.length > 0 ? (
        <ul className="grid gap-1 text-sm leading-6 text-secondary">
          {items.map((item, index) => (
            <li key={typeof item === "string" ? item : index}>{item}</li>
          ))}
        </ul>
      ) : (
        <Badge tone={emptyTone}>{emptyLabel}</Badge>
      )}
    </div>
  );
}

export interface StatusReasonItem {
  key: string;
  label: ReactNode;
  reason?: ReactNode;
  nextStep?: ReactNode;
  tone?: BadgeTone;
  // Optional resolving affordance (e.g. a deep link to the workspace that clears
  // this status) rendered beneath the reason/next-step copy.
  action?: ReactNode;
}

export interface StatusReasonListProps extends FrameProps<HTMLDivElement> {
  items: readonly StatusReasonItem[];
  emptyLabel?: ReactNode;
  emptyTone?: BadgeTone;
  compact?: boolean;
  nextStepPrefix?: ReactNode;
}

export function StatusReasonList({
  items,
  emptyLabel,
  emptyTone = "success",
  compact = false,
  nextStepPrefix,
  ...rest
}: StatusReasonListProps) {
  if (items.length === 0) {
    return emptyLabel ? <Badge tone={emptyTone}>{emptyLabel}</Badge> : null;
  }

  return (
    <div {...rest} className={cx("grid min-w-0 text-left", compact ? "gap-1" : "gap-2")}>
      {items.map((item) => (
        <div key={item.key} className={cx("grid min-w-0", compact ? "gap-1" : "gap-1.5")}>
          <BadgeCluster items={[{ key: item.key, label: item.label, tone: item.tone ?? "warning" }]} />
          {item.reason || item.nextStep ? (
            <div className={cx("text-xs leading-5 text-secondary", compact && "max-w-72")}>
              {item.reason}
              {item.nextStep ? (
                <>
                  {item.reason && " "}
                  {nextStepPrefix}
                  {nextStepPrefix ? " " : null}
                  {item.nextStep}
                </>
              ) : null}
            </div>
          ) : null}
          {item.action ? <div className="flex min-w-0 flex-wrap items-center gap-2">{item.action}</div> : null}
        </div>
      ))}
    </div>
  );
}

export interface EvidenceCodeBlockProps extends FrameProps<HTMLDivElement> {
  label: ReactNode;
  children: ReactNode;
}

export function EvidenceCodeBlock({ label, children, ...rest }: EvidenceCodeBlockProps) {
  return (
    <div {...rest} className="rounded-tokenMd border border-muted bg-surface-2 p-3">
      <div className="text-xs font-semibold uppercase text-tertiary">{label}</div>
      <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-secondary">{children}</pre>
    </div>
  );
}
