import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  HTMLAttributes,
  ReactNode
} from "react";
import { forwardRef, useCallback, useId, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { Icon, type IconName } from "../icons";
import { useChaseMotion } from "../theme/provider";
import { layoutWidthClasses, type LayoutWidth } from "../primitives/layout";
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
  "focus-ring relative inline-flex items-center justify-center gap-2 overflow-hidden rounded-tokenMd border font-semibold shadow-tokenSm transition duration-150 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none";

function resolveInteractiveMotion(reducedMotion: boolean, scale: number, lift: number) {
  if (reducedMotion) {
    return undefined;
  }

  return {
    whileHover: { y: lift, scale },
    whileTap: { y: 0, scale: 0.985 },
    transition: { duration: 0.18 }
  };
}

function renderActivePill(groupId: string, tone: "default" | "accent" = "default") {
  return (
    <motion.span
      layoutId={`${groupId}-active-pill`}
      className={cx(
        "absolute inset-0 rounded-tokenMd",
        tone === "accent" ? "bg-elevated shadow-tokenSm" : "bg-background shadow-tokenSm"
      )}
      transition={{ duration: 0.18 }}
    />
  );
}

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
  groupId?: string,
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
    "focus-ring relative inline-flex items-center gap-2 overflow-hidden rounded-tokenMd px-3 py-2 text-sm font-medium transition",
    orientation === "vertical" && "w-full justify-between",
    orientation === "rail" && "w-full flex-col justify-center py-3",
    active
      ? "bg-background text-accent shadow-tokenSm"
      : "text-secondary hover:bg-background hover:text-foreground"
  );

  if (item.href) {
    return (
      <a key={item.key} href={item.href} className={className}>
        {active && groupId ? renderActivePill(groupId) : null}
        <span className="relative z-10 inline-flex items-center gap-2">{content}</span>
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
      {active && groupId ? renderActivePill(groupId) : null}
      <span className="relative z-10 inline-flex items-center gap-2">{content}</span>
    </button>
  );
}

function renderBottomNavigationItem(
  item: NavigationItem,
  active: boolean,
  groupId?: string,
  onSelect?: (key: string) => void
) {
  const content = (
    <>
      <span className="relative inline-flex h-5 w-5 items-center justify-center">
        {item.icon ? (
          <Icon
            name={item.icon}
            size="sm"
            tone={active ? "accent" : "secondary"}
          />
        ) : null}
        {item.badge ? (
          <span
            aria-hidden="true"
            className="absolute -right-2 -top-2 inline-flex min-h-4 min-w-4 items-center justify-center rounded-full bg-background px-1 text-[0.65rem] font-semibold leading-none text-secondary shadow-tokenSm"
          >
            {item.badge}
          </span>
        ) : null}
      </span>
      <span className="text-xs">{item.label}</span>
      {item.badge ? (
        <span className="sr-only">{` ${item.badge}`}</span>
      ) : null}
    </>
  );

  const className = cx(
    "focus-ring relative inline-flex w-full flex-col items-center justify-center gap-1 overflow-hidden rounded-tokenMd px-3 py-3 text-sm font-medium transition",
    active
      ? "bg-background text-accent shadow-tokenSm"
      : "text-secondary hover:bg-background hover:text-foreground"
  );

  if (item.href) {
    return (
      <a key={item.key} href={item.href} className={className}>
        {active && groupId ? renderActivePill(groupId) : null}
        <span className="relative z-10 inline-flex flex-col items-center justify-center gap-1">
          {content}
        </span>
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
      {active && groupId ? renderActivePill(groupId) : null}
      <span className="relative z-10 inline-flex flex-col items-center justify-center gap-1">
        {content}
      </span>
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
  const motionSettings = useChaseMotion();
  const interactiveMotion = resolveInteractiveMotion(
    motionSettings.reducedMotion,
    motionSettings.interactiveScale,
    motionSettings.interactiveLift
  );
  const nativeProps = rest as unknown as Record<string, unknown>;

  return (
    <motion.button
      {...nativeProps}
      ref={ref}
      type={type}
      {...interactiveMotion}
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
    </motion.button>
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
    const motionSettings = useChaseMotion();
    const interactiveMotion = resolveInteractiveMotion(
      motionSettings.reducedMotion,
      motionSettings.interactiveScale,
      motionSettings.interactiveLift
    );
    const nativeProps = rest as unknown as Record<string, unknown>;

    return (
      <motion.button
        {...nativeProps}
        ref={ref}
        type={type}
        aria-label={label}
        {...interactiveMotion}
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
      </motion.button>
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
    const motionSettings = useChaseMotion();
    const interactiveMotion = resolveInteractiveMotion(
      motionSettings.reducedMotion,
      motionSettings.interactiveScale,
      motionSettings.interactiveLift
    );
    const nativeProps = rest as unknown as Record<string, unknown>;

    return (
      <motion.a
        {...nativeProps}
        ref={ref}
        {...interactiveMotion}
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
      </motion.a>
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
  const [internalValue, setInternalValue] = useState(resolvedValue);
  const currentValue = value ?? internalValue ?? resolvedValue;
  const groupId = useId();

  function handleValueChange(nextValue: string) {
    if (value === undefined) {
      setInternalValue(nextValue);
    }
    onValueChange?.(nextValue);
  }

  return (
    <TabsPrimitive.Root
      defaultValue={resolvedValue}
      value={currentValue}
      onValueChange={handleValueChange}
      orientation={orientation}
      dir={dir}
      activationMode={activationMode}
      className="space-y-4"
    >
      <LayoutGroup id={groupId}>
        <TabsPrimitive.List className="inline-flex w-full flex-wrap gap-2 rounded-tokenLg border border-muted bg-background p-2">
          {items.map((item) => {
            const active = item.value === currentValue;

            return (
              <TabsPrimitive.Trigger
                key={item.value}
                value={item.value}
                className="focus-ring relative inline-flex touch-target flex-1 items-center justify-center gap-2 overflow-hidden rounded-tokenMd px-4 py-2 text-sm font-semibold text-secondary transition data-[state=active]:text-accent"
              >
                {active ? renderActivePill(groupId, "accent") : null}
                <span className="relative z-10">{item.label}</span>
                {item.badge ? (
                  <span className="relative z-10 rounded-full bg-background px-2 py-0.5 text-[0.7rem]">
                    {item.badge}
                  </span>
                ) : null}
              </TabsPrimitive.Trigger>
            );
          })}
        </TabsPrimitive.List>
      </LayoutGroup>
      <AnimatePresence initial={false} mode="wait">
        <motion.div
          key={currentValue}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.18 }}
        >
          <TabsPrimitive.Content
            value={currentValue}
            forceMount
            className="focus-visible:outline-none"
          >
            {items.find((item) => item.value === currentValue)?.content}
          </TabsPrimitive.Content>
        </motion.div>
      </AnimatePresence>
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
  const groupId = useId();

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = -1;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = (index + 1) % items.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = (index - 1 + items.length) % items.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = items.length - 1;
    }
    if (next >= 0) {
      event.preventDefault();
      onValueChange?.(items[next].value);
      const container = event.currentTarget.parentElement;
      const buttons = container?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
      buttons?.[next]?.focus();
    }
  }

  return (
    <LayoutGroup id={groupId}>
      <div
        {...rest}
        role="tablist"
        className="inline-flex flex-wrap rounded-tokenLg border border-muted bg-background p-1"
      >
        {items.map((item, index) => {
          const active = item.value === value;

          return (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={cx(
                "focus-ring relative inline-flex min-h-10 items-center gap-2 overflow-hidden rounded-tokenMd px-3 py-2 text-sm font-semibold transition",
                active
                  ? "text-accent"
                  : "text-secondary hover:text-foreground"
              )}
              onClick={() => onValueChange?.(item.value)}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              {active ? renderActivePill(groupId, "accent") : null}
              {item.icon ? <Icon name={item.icon} size="sm" /> : null}
              <span className="relative z-10">{item.label}</span>
            </button>
          );
        })}
      </div>
    </LayoutGroup>
  );
}

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export interface BreadcrumbsProps
  extends Omit<HTMLAttributes<HTMLElement>, "className" | "style"> {
  items: BreadcrumbItem[];
  ariaLabel?: string;
}

export function Breadcrumbs({
  items,
  ariaLabel = "Breadcrumb",
  ...rest
}: BreadcrumbsProps) {
  return (
    <nav {...rest} aria-label={ariaLabel}>
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
  previousLabel?: string;
  nextLabel?: string;
}

function buildPageRange(page: number, totalPages: number): (number | "ellipsis-start" | "ellipsis-end")[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const pages: (number | "ellipsis-start" | "ellipsis-end")[] = [1];
  if (page > 3) {
    pages.push("ellipsis-start");
  }
  const start = Math.max(2, page - 1);
  const end = Math.min(totalPages - 1, page + 1);
  for (let i = start; i <= end; i++) {
    pages.push(i);
  }
  if (page < totalPages - 2) {
    pages.push("ellipsis-end");
  }
  pages.push(totalPages);
  return pages;
}

export function Pagination({
  page,
  totalPages,
  onPageChange,
  previousLabel = "Previous page",
  nextLabel = "Next page",
  ...rest
}: PaginationProps) {
  const pages = buildPageRange(page, totalPages);

  return (
    <nav {...rest} aria-label="Pagination" className="flex items-center gap-2">
      <IconButton
        label={previousLabel}
        icon="chevronLeft"
        tone="secondary"
        disabled={page <= 1}
        onClick={() => onPageChange?.(Math.max(1, page - 1))}
      />
      <div className="flex flex-wrap gap-2">
        {pages.map((value) => {
          if (typeof value === "string") {
            return (
              <span
                key={value}
                className="inline-flex min-h-10 min-w-10 items-center justify-center text-sm text-secondary"
                aria-hidden="true"
              >
                &hellip;
              </span>
            );
          }
          return (
            <button
              key={value}
              type="button"
              aria-current={value === page ? "page" : undefined}
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
          );
        })}
      </div>
      <IconButton
        label={nextLabel}
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
  width?: LayoutWidth;
}

export function TopNav({
  items,
  activeKey,
  onSelect,
  brand,
  actions,
  width = "full",
  ...rest
}: TopNavProps) {
  const groupId = useId();

  return (
    <nav
      {...rest}
      className="sticky top-0 z-sticky border-b border-muted bg-elevated px-4 py-3 shadow-tokenSm"
    >
      <div
        className={cx(
          "mx-auto flex w-full items-center justify-between gap-4",
          layoutWidthClasses[width]
        )}
      >
        <div className="flex items-center gap-4">
          {brand}
          <LayoutGroup id={groupId}>
            <div className="hidden items-center gap-1 md:flex">
              {items.map((item) =>
                renderNavigationItem(item, item.key === activeKey, "horizontal", groupId, onSelect)
              )}
            </div>
          </LayoutGroup>
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
  const groupId = useId();

  return (
    <nav
      {...rest}
      className="modern-surface flex h-full flex-col gap-2 rounded-tokenLg border border-muted p-3 shadow-tokenSm"
    >
      <LayoutGroup id={groupId}>
        {items.map((item) =>
          renderNavigationItem(item, item.key === activeKey, "vertical", groupId, onSelect)
        )}
      </LayoutGroup>
    </nav>
  );
}

export interface BottomNavProps
  extends Omit<HTMLAttributes<HTMLElement>, "className" | "style" | "onSelect"> {
  items: NavigationItem[];
  activeKey?: string;
  onSelect?: (key: string) => void;
  width?: LayoutWidth;
}

export function BottomNav({
  items,
  activeKey,
  onSelect,
  width = "full",
  ...rest
}: BottomNavProps) {
  const groupId = useId();

  return (
    <nav
      {...rest}
      className="fixed inset-x-0 bottom-0 z-sticky border-t border-muted bg-elevated px-3 py-2 shadow-tokenLg md:hidden"
    >
      <LayoutGroup id={groupId}>
        <div className={cx("mx-auto grid w-full grid-cols-4 gap-2", layoutWidthClasses[width])}>
          {items.slice(0, 4).map((item) =>
            renderBottomNavigationItem(item, item.key === activeKey, groupId, onSelect)
          )}
        </div>
      </LayoutGroup>
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
  const groupId = useId();

  return (
    <nav
      {...rest}
      className="modern-surface hidden h-full w-24 flex-col gap-2 rounded-tokenLg border border-muted p-2 md:flex"
    >
      <LayoutGroup id={groupId}>
        {items.map((item) =>
          renderNavigationItem(item, item.key === activeKey, "rail", groupId, onSelect)
        )}
      </LayoutGroup>
    </nav>
  );
}

export interface CopyButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "style" | "children"> {
  value: string;
  label?: string;
  copiedLabel?: string;
  tone?: ButtonTone;
  size?: ButtonSize;
}

export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  tone = "secondary",
  size = "sm",
  type = "button",
  ...rest
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const motionSettings = useChaseMotion();
  const interactiveMotion = resolveInteractiveMotion(
    motionSettings.reducedMotion,
    motionSettings.interactiveScale,
    motionSettings.interactiveLift
  );
  const nativeProps = rest as unknown as Record<string, unknown>;

  const handleClick = useCallback(() => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    });
  }, [value]);

  return (
    <motion.button
      {...nativeProps}
      type={type}
      {...interactiveMotion}
      className={cx(
        buttonBaseClass,
        buttonToneClasses[tone],
        buttonSizeClasses[size]
      )}
      onClick={handleClick}
    >
      <Icon
        name={copied ? "check" : "copy"}
        size="sm"
        tone={tone === "primary" || tone === "danger" ? "inverse" : "accent"}
      />
      <span>{copied ? copiedLabel : label}</span>
    </motion.button>
  );
}
