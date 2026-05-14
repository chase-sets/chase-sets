import type { HTMLAttributes, ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { LayoutGroup } from "motion/react";
import { ChaseSetsLogo } from "../../brand/chase-sets-logo";
import type { IconName } from "../../icons";
import { Icon } from "../../icons";
import { layoutWidthClasses, type LayoutWidth } from "../../primitives/layout";
import { cx } from "../../utils/cx";
import { renderActivePill } from "./shared";

export interface NavigationItem {
  key: string;
  label: string;
  icon?: IconName;
  badge?: string;
  href?: string;
  placement?: "primary" | "utility";
  avatar?: ReactNode;
  children?: NavigationItem[];
}

function renderNavigationItem(
  item: NavigationItem,
  active: boolean,
  orientation: "horizontal" | "vertical" | "rail",
  groupId?: string,
  onSelect?: (key: string) => void,
  activeKey?: string
) {
  const content = (
    <>
      {item.avatar ? item.avatar : item.icon ? (
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
        <span className="rounded-full bg-accent px-2 py-0.5 text-[0.7rem] font-semibold text-accent-contrast">
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
      ? "bg-surface-2 text-accent shadow-tokenSm"
      : "text-secondary hover:bg-surface-2 hover:text-foreground"
  );

  if (orientation === "horizontal" && item.children?.length) {
    return (
      <NavigationItemGroup
        key={item.key}
        item={item}
        active={active}
        className={className}
        content={content}
        groupId={groupId}
        onSelect={onSelect}
        activeKey={activeKey}
      />
    );
  }

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

function NavigationItemGroup({
  item,
  active,
  className,
  content,
  groupId,
  onSelect,
  activeKey,
}: {
  item: NavigationItem;
  active: boolean;
  className: string;
  content: ReactNode;
  groupId?: string;
  onSelect?: (key: string) => void;
  activeKey?: string;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const closeWhenPointerStartsOutside = (event: PointerEvent) => {
      const details = detailsRef.current;

      if (!details || !(event.target instanceof Node) || details.contains(event.target)) {
        return;
      }

      setOpen(false);
    };

    document.addEventListener("pointerdown", closeWhenPointerStartsOutside, true);

    return () => document.removeEventListener("pointerdown", closeWhenPointerStartsOutside, true);
  }, [open]);

  return (
    <details
      ref={detailsRef}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="group relative"
    >
      <summary
        className={cx(
          className,
          "list-none [&::-webkit-details-marker]:hidden",
          active && "bg-surface-2 text-accent shadow-tokenSm"
        )}
      >
        {active && groupId ? renderActivePill(groupId) : null}
        <span className="relative z-10 inline-flex items-center gap-2">{content}</span>
        <Icon name="chevronDown" size="sm" tone={active ? "accent" : "secondary"} />
      </summary>
      <div className="modern-surface absolute left-0 top-[calc(100%+0.5rem)] z-dropdown min-w-56 rounded-tokenLg border border-muted p-2 shadow-overlay">
        {item.children?.map((child) =>
          renderNavigationItem(child, child.key === activeKey, "vertical", undefined, onSelect, activeKey)
        )}
      </div>
    </details>
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
            className="absolute -right-2 -top-2 inline-flex min-h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[0.65rem] font-semibold leading-none text-accent-contrast shadow-tokenSm"
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
      ? "bg-surface-2 text-accent shadow-tokenSm"
      : "text-secondary hover:bg-surface-2 hover:text-foreground"
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

function isNavigationItemActive(item: NavigationItem, activeKey?: string): boolean {
  return item.key === activeKey || Boolean(item.children?.some((child) => child.key === activeKey));
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
  const primaryItems = items.filter((item) => item.placement !== "utility");
  const utilityItems = items
    .filter((item) => item.placement === "utility")
    .sort((left, right) => {
      if (left.key === "cart" && right.key !== "cart") {
        return 1;
      }

      if (right.key === "cart" && left.key !== "cart") {
        return -1;
      }

      return 0;
    });

  return (
    <nav
      {...rest}
      className="sticky top-0 z-sticky border-b border-muted bg-background/88 px-4 py-3 shadow-tokenSm backdrop-blur-xl"
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
              {primaryItems.map((item) =>
                renderNavigationItem(
                  item,
                  isNavigationItemActive(item, activeKey),
                  "horizontal",
                  groupId,
                  onSelect,
                  activeKey
                )
              )}
            </div>
          </LayoutGroup>
        </div>
        <div className="flex items-center gap-2">
          {actions}
          {utilityItems.length > 0 ? (
            <LayoutGroup id={`${groupId}-utility`}>
              <div className="hidden items-center gap-1 md:flex">
                {utilityItems.map((item) =>
                  renderNavigationItem(
                    item,
                    isNavigationItemActive(item, activeKey),
                    "horizontal",
                    `${groupId}-utility`,
                    onSelect,
                    activeKey
                  )
                )}
              </div>
            </LayoutGroup>
          ) : null}
        </div>
      </div>
    </nav>
  );
}

export interface BrandLinkProps {
  href?: string;
  label: string;
}

export function BrandLink({ href = "/", label }: BrandLinkProps) {
  return (
    <a
      href={href}
      aria-label={label}
      className="focus-ring inline-flex items-center gap-2 rounded-tokenSm px-1 py-1 text-sm font-semibold text-foreground transition hover:text-accent"
    >
      <ChaseSetsLogo decorative size={20} />
      <span>{label}</span>
    </a>
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
      className="glass-surface flex h-full flex-col gap-2 rounded-tokenLg border border-muted p-3 shadow-tokenSm"
    >
      <LayoutGroup id={groupId}>
        {items.map((item) =>
          renderNavigationItem(item, item.key === activeKey, "vertical", groupId, onSelect, activeKey)
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
  const visibleItems = items;
  const gridColumnsClass =
    visibleItems.length > 5
      ? "grid-flow-col auto-cols-[minmax(4.75rem,1fr)] overflow-x-auto"
      : visibleItems.length === 5
      ? "grid-cols-5"
      : visibleItems.length === 4
        ? "grid-cols-4"
        : visibleItems.length === 3
          ? "grid-cols-3"
          : visibleItems.length === 2
            ? "grid-cols-2"
            : "grid-cols-1";

  return (
    <nav
      {...rest}
      className="fixed inset-x-0 bottom-0 z-sticky border-t border-muted bg-background/88 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-tokenLg backdrop-blur-xl md:hidden"
    >
      <LayoutGroup id={groupId}>
        <div className={cx("mx-auto grid w-full gap-2", gridColumnsClass, layoutWidthClasses[width])}>
          {visibleItems.map((item) =>
            renderBottomNavigationItem(item, isNavigationItemActive(item, activeKey), groupId, onSelect)
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
      className="glass-surface hidden h-full w-24 flex-col gap-2 rounded-tokenLg border border-muted p-2 md:flex"
    >
      <LayoutGroup id={groupId}>
        {items.map((item) =>
          renderNavigationItem(item, item.key === activeKey, "rail", groupId, onSelect, activeKey)
        )}
      </LayoutGroup>
    </nav>
  );
}
