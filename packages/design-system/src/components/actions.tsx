import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  HTMLAttributes,
  ReactNode
} from "react";
import { forwardRef } from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { Icon, type IconName } from "../icons";
import { cx } from "../utils/cx";

export interface NavigationItem {
  key: string;
  label: string;
  icon?: IconName;
  badge?: string;
  href?: string;
}

type ButtonTone = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

const buttonToneClasses: Record<ButtonTone, string> = {
  primary:
    "border-transparent bg-accent text-accent-contrast hover:brightness-110",
  secondary:
    "border-border bg-elevated text-foreground hover:border-accent hover:text-accent",
  ghost:
    "border-transparent bg-transparent text-secondary hover:border-border hover:bg-background hover:text-foreground",
  danger:
    "border-transparent bg-danger text-inverse hover:brightness-110"
};

const buttonSizeClasses: Record<ButtonSize, string> = {
  sm: "min-h-10 px-3 text-sm",
  md: "touch-target px-4 text-sm",
  lg: "min-h-12 px-5 text-base"
};

const buttonBaseClass =
  "focus-ring inline-flex items-center justify-center gap-2 rounded-tokenMd border font-semibold shadow-tokenSm transition duration-150 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none";

function renderLeadingIcon(icon: IconName | undefined, tone: ButtonTone): ReactNode {
  if (!icon) {
    return null;
  }

  return (
    <Icon
      name={icon}
      size="sm"
      tone={tone === "primary" || tone === "danger" ? "inverse" : "accent"}
    />
  );
}

function renderNavigationItem(
  item: NavigationItem,
  active: boolean,
  orientation: "horizontal" | "vertical" | "rail",
  onSelect?: (key: string) => void
) {
  const content = (
    <>
      {item.icon ? (
        <Icon
          name={item.icon}
          size="sm"
          tone={active ? "accent" : "secondary"}
        />
      ) : null}
      <span className={cx(orientation === "rail" && "text-xs")}>
        {item.label}
      </span>
      {item.badge ? (
        <span className="rounded-full bg-background px-2 py-0.5 text-[0.7rem] font-semibold text-secondary">
          {item.badge}
        </span>
      ) : null}
    </>
  );

  const className = cx(
    "focus-ring inline-flex items-center gap-2 rounded-tokenMd px-3 py-2 text-sm font-medium transition",
    orientation === "vertical" && "w-full justify-between",
    orientation === "rail" && "w-full flex-col justify-center py-3",
    active
      ? "bg-background text-accent shadow-tokenSm"
      : "text-secondary hover:bg-background hover:text-foreground"
  );

  if (item.href) {
    return (
      <a key={item.key} href={item.href} className={className}>
        {content}
      </a>
    );
  }

  return (
    <button
      key={item.key}
      type="button"
      className={className}
      onClick={() => onSelect?.(item.key)}
    >
      {content}
    </button>
  );
}

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "style"> {
  tone?: ButtonTone;
  size?: ButtonSize;
  block?: boolean;
  leadingIcon?: IconName;
  trailingIcon?: IconName;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    children,
    tone = "primary",
    size = "md",
    block = false,
    leadingIcon,
    trailingIcon,
    type = "button",
    ...rest
  },
  ref
) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={cx(
        buttonBaseClass,
        buttonToneClasses[tone],
        buttonSizeClasses[size],
        block && "w-full"
      )}
    >
      {renderLeadingIcon(leadingIcon, tone)}
      <span>{children}</span>
      {trailingIcon ? (
        <Icon
          name={trailingIcon}
          size="sm"
          tone={tone === "primary" || tone === "danger" ? "inverse" : "accent"}
        />
      ) : null}
    </button>
  );
});

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "style" | "children"> {
  label: string;
  icon: IconName;
  tone?: ButtonTone;
  size?: ButtonSize;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      label,
      icon,
      tone = "ghost",
      size = "md",
      type = "button",
      ...rest
    },
    ref
  ) {
    return (
      <button
        {...rest}
        ref={ref}
        type={type}
        aria-label={label}
        className={cx(
          buttonBaseClass,
          buttonToneClasses[tone],
          buttonSizeClasses[size],
          "px-0"
        )}
      >
        <Icon
          name={icon}
          size="sm"
          tone={tone === "primary" || tone === "danger" ? "inverse" : "accent"}
        />
      </button>
    );
  }
);

export interface LinkButtonProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className" | "style"> {
  tone?: ButtonTone;
  size?: ButtonSize;
  leadingIcon?: IconName;
  trailingIcon?: IconName;
  block?: boolean;
}

export const LinkButton = forwardRef<HTMLAnchorElement, LinkButtonProps>(
  function LinkButton(
    {
      children,
      tone = "secondary",
      size = "md",
      leadingIcon,
      trailingIcon,
      block = false,
      ...rest
    },
    ref
  ) {
    return (
      <a
        {...rest}
        ref={ref}
        className={cx(
          buttonBaseClass,
          buttonToneClasses[tone],
          buttonSizeClasses[size],
          block && "w-full"
        )}
      >
        {renderLeadingIcon(leadingIcon, tone)}
        <span>{children}</span>
        {trailingIcon ? (
          <Icon
            name={trailingIcon}
            size="sm"
            tone={tone === "primary" || tone === "danger" ? "inverse" : "accent"}
          />
        ) : null}
      </a>
    );
  }
);

export interface ButtonGroupProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  children?: ReactNode;
}

export function ButtonGroup({
  children,
  ...rest
}: ButtonGroupProps) {
  return (
    <div
      {...rest}
      role="group"
      className="inline-flex flex-wrap items-center gap-3"
    >
      {children}
    </div>
  );
}

export interface TabItem {
  value: string;
  label: ReactNode;
  content: ReactNode;
  badge?: string;
}

export interface TabsProps
  extends Omit<TabsPrimitive.TabsProps, "className" | "style"> {
  items: TabItem[];
}

export function Tabs({
  items,
  defaultValue,
  value,
  onValueChange,
  orientation = "horizontal",
  dir,
  activationMode = "automatic"
}: TabsProps) {
  const resolvedValue = defaultValue ?? items[0]?.value;

  return (
    <TabsPrimitive.Root
      defaultValue={resolvedValue}
      value={value}
      onValueChange={onValueChange}
      orientation={orientation}
      dir={dir}
      activationMode={activationMode}
      className="space-y-4"
    >
      <TabsPrimitive.List className="inline-flex w-full flex-wrap gap-2 rounded-tokenLg border border-muted bg-background p-2">
        {items.map((item) => (
          <TabsPrimitive.Trigger
            key={item.value}
            value={item.value}
            className="focus-ring inline-flex touch-target flex-1 items-center justify-center gap-2 rounded-tokenMd px-4 py-2 text-sm font-semibold text-secondary transition data-[state=active]:bg-elevated data-[state=active]:text-accent data-[state=active]:shadow-tokenSm"
          >
            <span>{item.label}</span>
            {item.badge ? (
              <span className="rounded-full bg-background px-2 py-0.5 text-[0.7rem]">
                {item.badge}
              </span>
            ) : null}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {items.map((item) => (
        <TabsPrimitive.Content
          key={item.value}
          value={item.value}
          className="focus-visible:outline-none"
        >
          {item.content}
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  );
}

export interface SegmentedControlItem {
  value: string;
  label: string;
  icon?: IconName;
}

export interface SegmentedControlProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style" | "onChange"> {
  items: SegmentedControlItem[];
  value: string;
  onValueChange?: (value: string) => void;
}

export function SegmentedControl({
  items,
  value,
  onValueChange,
  ...rest
}: SegmentedControlProps) {
  return (
    <div
      {...rest}
      role="tablist"
      className="inline-flex flex-wrap rounded-tokenLg border border-muted bg-background p-1"
    >
      {items.map((item) => {
        const active = item.value === value;

        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            className={cx(
              "focus-ring inline-flex min-h-10 items-center gap-2 rounded-tokenMd px-3 py-2 text-sm font-semibold transition",
              active
                ? "bg-elevated text-accent shadow-tokenSm"
                : "text-secondary hover:text-foreground"
            )}
            onClick={() => onValueChange?.(item.value)}
          >
            {item.icon ? <Icon name={item.icon} size="sm" /> : null}
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export interface BreadcrumbsProps
  extends Omit<HTMLAttributes<HTMLElement>, "className" | "style"> {
  items: BreadcrumbItem[];
}

export function Breadcrumbs({
  items,
  ...rest
}: BreadcrumbsProps) {
  return (
    <nav {...rest} aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-2 text-sm text-secondary">
        {items.map((item, index) => {
          const isCurrent = index === items.length - 1;

          return (
            <li key={`${item.label}-${index}`} className="inline-flex items-center gap-2">
              {item.href && !isCurrent ? (
                <a href={item.href} className="focus-ring rounded-tokenSm hover:text-foreground">
                  {item.label}
                </a>
              ) : (
                <span className={isCurrent ? "font-semibold text-foreground" : undefined}>
                  {item.label}
                </span>
              )}
              {!isCurrent ? (
                <Icon name="chevronRight" size="sm" tone="secondary" />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export interface PaginationProps
  extends Omit<HTMLAttributes<HTMLElement>, "className" | "style"> {
  page: number;
  totalPages: number;
  onPageChange?: (page: number) => void;
}

export function Pagination({
  page,
  totalPages,
  onPageChange,
  ...rest
}: PaginationProps) {
  const pages = Array.from({ length: totalPages }, (_, index) => index + 1);

  return (
    <nav {...rest} aria-label="Pagination" className="flex items-center gap-2">
      <IconButton
        label="Previous page"
        icon="chevronLeft"
        tone="secondary"
        disabled={page <= 1}
        onClick={() => onPageChange?.(Math.max(1, page - 1))}
      />
      <div className="flex flex-wrap gap-2">
        {pages.map((value) => (
          <button
            key={value}
            type="button"
            className={cx(
              "focus-ring inline-flex min-h-10 min-w-10 items-center justify-center rounded-tokenMd border px-3 text-sm font-semibold transition",
              value === page
                ? "border-accent bg-accent text-accent-contrast"
                : "border-muted bg-elevated text-secondary hover:text-foreground"
            )}
            onClick={() => onPageChange?.(value)}
          >
            {value}
          </button>
        ))}
      </div>
      <IconButton
        label="Next page"
        icon="chevronRight"
        tone="secondary"
        disabled={page >= totalPages}
        onClick={() => onPageChange?.(Math.min(totalPages, page + 1))}
      />
    </nav>
  );
}

export interface PageStepperItem {
  label: string;
  description?: string;
  status: "complete" | "current" | "upcoming";
}

export interface PageStepperProps
  extends Omit<HTMLAttributes<HTMLOListElement>, "className" | "style"> {
  items: PageStepperItem[];
}

export function PageStepper({
  items,
  ...rest
}: PageStepperProps) {
  return (
    <ol
      {...rest}
      className="grid gap-3 md:grid-cols-3"
    >
      {items.map((item, index) => (
        <li
          key={`${item.label}-${index}`}
          className={cx(
            "rounded-tokenLg border p-4 shadow-tokenSm",
            item.status === "complete" && "border-success bg-elevated",
            item.status === "current" && "border-accent bg-elevated",
            item.status === "upcoming" && "border-muted bg-background"
          )}
        >
          <div className="flex items-start gap-3">
            <span
              className={cx(
                "inline-flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold",
                item.status === "complete" && "bg-success text-inverse",
                item.status === "current" && "bg-accent text-accent-contrast",
                item.status === "upcoming" && "bg-muted text-secondary"
              )}
            >
              {item.status === "complete" ? <Icon name="check" size="sm" /> : index + 1}
            </span>
            <div className="space-y-1">
              <div className="text-sm font-semibold text-foreground">{item.label}</div>
              {item.description ? (
                <div className="text-xs text-secondary">{item.description}</div>
              ) : null}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

export interface TopNavProps
  extends Omit<HTMLAttributes<HTMLElement>, "className" | "style" | "onSelect"> {
  items: NavigationItem[];
  activeKey?: string;
  onSelect?: (key: string) => void;
  brand?: ReactNode;
  actions?: ReactNode;
}

export function TopNav({
  items,
  activeKey,
  onSelect,
  brand,
  actions,
  ...rest
}: TopNavProps) {
  return (
    <nav
      {...rest}
      className="sticky top-0 z-sticky border-b border-muted bg-elevated px-4 py-3 shadow-tokenSm"
    >
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          {brand}
          <div className="hidden items-center gap-1 md:flex">
            {items.map((item) =>
              renderNavigationItem(item, item.key === activeKey, "horizontal", onSelect)
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">{actions}</div>
      </div>
    </nav>
  );
}

export interface SideNavProps
  extends Omit<HTMLAttributes<HTMLElement>, "className" | "style" | "onSelect"> {
  items: NavigationItem[];
  activeKey?: string;
  onSelect?: (key: string) => void;
}

export function SideNav({
  items,
  activeKey,
  onSelect,
  ...rest
}: SideNavProps) {
  return (
    <nav
      {...rest}
      className="modern-surface flex h-full flex-col gap-2 rounded-tokenLg border border-muted p-3 shadow-tokenSm"
    >
      {items.map((item) =>
        renderNavigationItem(item, item.key === activeKey, "vertical", onSelect)
      )}
    </nav>
  );
}

export interface BottomNavProps
  extends Omit<HTMLAttributes<HTMLElement>, "className" | "style" | "onSelect"> {
  items: NavigationItem[];
  activeKey?: string;
  onSelect?: (key: string) => void;
}

export function BottomNav({
  items,
  activeKey,
  onSelect,
  ...rest
}: BottomNavProps) {
  return (
    <nav
      {...rest}
      className="fixed inset-x-0 bottom-0 z-sticky border-t border-muted bg-elevated px-3 py-2 shadow-tokenLg md:hidden"
    >
      <div className="mx-auto grid max-w-lg grid-cols-4 gap-2">
        {items.slice(0, 4).map((item) =>
          renderNavigationItem(item, item.key === activeKey, "rail", onSelect)
        )}
      </div>
    </nav>
  );
}

export interface NavRailProps
  extends Omit<HTMLAttributes<HTMLElement>, "className" | "style" | "onSelect"> {
  items: NavigationItem[];
  activeKey?: string;
  onSelect?: (key: string) => void;
}

export function NavRail({
  items,
  activeKey,
  onSelect,
  ...rest
}: NavRailProps) {
  return (
    <nav
      {...rest}
      className="modern-surface hidden h-full w-24 flex-col gap-2 rounded-tokenLg border border-muted p-2 md:flex"
    >
      {items.map((item) =>
        renderNavigationItem(item, item.key === activeKey, "rail", onSelect)
      )}
    </nav>
  );
}
