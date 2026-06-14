import type { HTMLAttributes, ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { LayoutGroup } from "motion/react";
import { ChaseSetsLogo } from "../../brand/chase-sets-logo";
import type { IconName } from "../../icons";
import { Icon } from "../../icons";
import { Cluster, Container, Inline, layoutWidthClasses, Show, type LayoutWidth } from "../../primitives/layout";
import { cx } from "../../utils/cx";
import { controlSquareSizeClasses } from "../control-sizing";
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

/**
 * Shared layered content row for an interactive nav item. Sits above the active
 * pill (`relative z-10`) so the motion background never overlaps the label, icon,
 * and badge. Pure layout, so it composes from raw inline-flex rather than owning
 * any interactive chrome — the surrounding `a`/`button`/`summary` leaf owns focus,
 * hover, and active styling.
 */
function NavItemContent({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("relative z-10 inline-flex items-center gap-2", className)}>{children}</span>;
}

function renderNavigationItem(
  item: NavigationItem,
  active: boolean,
  orientation: "horizontal" | "vertical" | "rail",
  groupId?: string,
  onSelect?: (key: string) => void,
  activeKey?: string,
) {
  const content = (
    <>
      {item.avatar ? (
        item.avatar
      ) : item.icon ? (
        <Icon name={item.icon} size="sm" tone={active ? "accent" : "secondary"} />
      ) : null}
      <span className={cx(orientation === "rail" && "text-xs")}>{item.label}</span>
      {item.badge ? (
        <span className="rounded-tokenFull bg-accent px-2 py-0.5 text-2xs font-semibold text-accent-contrast">
          {item.badge}
        </span>
      ) : null}
    </>
  );

  const className = cx(
    "focus-ring relative inline-flex items-center gap-2 overflow-hidden rounded-tokenMd px-3 py-2 text-sm font-medium transition",
    orientation === "vertical" && "w-full justify-between",
    orientation === "rail" && "w-full flex-col justify-center py-3",
    active ? "bg-surface-2 text-accent shadow-tokenSm" : "text-secondary hover:bg-surface-2 hover:text-foreground",
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
      <a key={item.key} href={item.href} aria-current={active ? "page" : undefined} className={className}>
        {active && groupId ? renderActivePill(groupId) : null}
        <NavItemContent>{content}</NavItemContent>
      </a>
    );
  }

  return (
    <button key={item.key} type="button" className={className} onClick={() => onSelect?.(item.key)}>
      {active && groupId ? renderActivePill(groupId) : null}
      <NavItemContent>{content}</NavItemContent>
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
          active && "bg-surface-2 text-accent shadow-tokenSm",
        )}
      >
        {active && groupId ? renderActivePill(groupId) : null}
        <NavItemContent>{content}</NavItemContent>
        <NavItemContent>
          <Icon name="chevronDown" size="sm" tone={active ? "accent" : "secondary"} />
        </NavItemContent>
      </summary>
      <div className="modern-surface absolute left-0 top-[calc(100%+0.5rem)] z-dropdown min-w-56 rounded-tokenLg border border-muted p-2 shadow-overlay">
        {item.children?.map((child) =>
          renderNavigationItem(child, child.key === activeKey, "vertical", undefined, onSelect, activeKey),
        )}
      </div>
    </details>
  );
}

function renderBottomNavigationItem(
  item: NavigationItem,
  active: boolean,
  groupId?: string,
  onSelect?: (key: string) => void,
  activeKey?: string,
) {
  const content = (
    <>
      <span className="relative inline-flex h-5 w-5 items-center justify-center">
        {item.icon ? <Icon name={item.icon} size="sm" tone={active ? "accent" : "secondary"} /> : null}
        {item.badge ? (
          <span
            aria-hidden="true"
            className="absolute -right-2 -top-2 inline-flex min-h-4 min-w-4 items-center justify-center rounded-tokenFull bg-accent px-1 text-3xs font-semibold leading-none text-accent-contrast shadow-tokenSm"
          >
            {item.badge}
          </span>
        ) : null}
      </span>
      <span className="max-w-full text-center text-2xs leading-tight [overflow-wrap:anywhere]">{item.label}</span>
      {item.badge ? <span className="sr-only">{` ${item.badge}`}</span> : null}
    </>
  );

  const className = cx(
    "focus-ring relative inline-flex w-full flex-col items-center justify-center gap-1 overflow-hidden rounded-tokenMd px-1 py-3 text-sm font-medium transition",
    active ? "bg-surface-2 text-accent shadow-tokenSm" : "text-secondary hover:bg-surface-2 hover:text-foreground",
  );

  if (item.children?.length) {
    return (
      <details key={item.key} className="group relative min-w-0">
        <summary className={cx(className, "cursor-pointer list-none [&::-webkit-details-marker]:hidden")}>
          {active && groupId ? renderActivePill(groupId) : null}
          <NavItemContent className="w-full min-w-0 flex-col justify-center">{content}</NavItemContent>
        </summary>
        <div className="modern-surface absolute bottom-[calc(100%+0.5rem)] right-0 z-dropdown w-[min(16rem,calc(100vw-1.5rem))] rounded-tokenLg border border-muted p-2 shadow-overlay">
          {item.children.map((child) =>
            renderNavigationItem(
              child,
              isNavigationItemActive(child, activeKey),
              "vertical",
              undefined,
              onSelect,
              activeKey,
            ),
          )}
        </div>
      </details>
    );
  }

  if (item.href) {
    return (
      <a key={item.key} href={item.href} className={className}>
        {active && groupId ? renderActivePill(groupId) : null}
        <NavItemContent className="w-full min-w-0 flex-col justify-center">{content}</NavItemContent>
      </a>
    );
  }

  return (
    <button key={item.key} type="button" className={className} onClick={() => onSelect?.(item.key)}>
      {active && groupId ? renderActivePill(groupId) : null}
      <NavItemContent className="w-full min-w-0 flex-col justify-center">{content}</NavItemContent>
    </button>
  );
}

function isNavigationItemActive(item: NavigationItem, activeKey?: string): boolean {
  return item.key === activeKey || Boolean(item.children?.some((child) => child.key === activeKey));
}

export interface TopNavProps extends Omit<HTMLAttributes<HTMLElement>, "className" | "style" | "onSelect"> {
  items: NavigationItem[];
  activeKey?: string;
  onSelect?: (key: string) => void;
  brand?: ReactNode;
  actions?: ReactNode;
  mobileActionsLabel?: string;
  width?: LayoutWidth;
}

function TopNavActionsMenu({
  actions,
  activeKey,
  items,
  label,
  onSelect,
}: {
  actions: ReactNode;
  activeKey?: string;
  items: NavigationItem[];
  label: string;
  onSelect?: (key: string) => void;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node | null;

      if (!target || detailsRef.current?.contains(target)) {
        return;
      }

      if (detailsRef.current) {
        detailsRef.current.open = false;
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || !detailsRef.current) {
        return;
      }

      detailsRef.current.open = false;
      setOpen(false);
      detailsRef.current.querySelector("summary")?.focus();
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <details ref={detailsRef} className="relative md:hidden" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary
        aria-label={label}
        className={cx(
          "focus-ring flex cursor-pointer list-none items-center justify-center rounded-tokenMd border border-muted bg-surface text-foreground shadow-tokenSm transition hover:border-accent hover:bg-surface-2 [&::-webkit-details-marker]:hidden",
          controlSquareSizeClasses.md,
        )}
      >
        <Icon name="menu" size="sm" tone="secondary" />
        <span className="sr-only">{label}</span>
      </summary>
      <div className="modern-surface absolute right-0 top-[calc(100%+0.5rem)] z-dropdown w-[min(16rem,calc(100vw-2rem))] rounded-tokenLg border border-muted p-2 shadow-overlay">
        <div className="flex flex-col gap-2 [&>div]:flex-col [&>div]:items-stretch [&>div]:gap-2 [&_a]:w-full [&_button]:w-full [&_form]:w-full [&_form>button]:w-full">
          {items.length > 0 ? (
            <div className="flex flex-col gap-1">
              {items.map((item) =>
                renderNavigationItem(item, isNavigationItemActive(item, activeKey), "vertical", undefined, onSelect),
              )}
            </div>
          ) : null}
          {actions}
        </div>
      </div>
    </details>
  );
}

export function TopNav({
  items,
  activeKey,
  onSelect,
  brand,
  actions,
  mobileActionsLabel,
  width = "full",
  ...rest
}: TopNavProps) {
  const groupId = useId();
  const navLabel = rest["aria-label"] ?? "Primary navigation";
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
      aria-label={navLabel}
      className="sticky top-0 z-sticky border-b border-muted bg-background/overlay px-4 py-3 shadow-tokenSm backdrop-blur-xl"
    >
      <Container width={width} paddingX={0}>
        <Cluster justify="between" gap={4}>
          <Inline gap={4} wrap={false}>
            {brand}
            <LayoutGroup id={groupId}>
              <Show above="md" display="flex">
                <Inline gap={1} wrap={false}>
                  {primaryItems.map((item) =>
                    renderNavigationItem(
                      item,
                      isNavigationItemActive(item, activeKey),
                      "horizontal",
                      groupId,
                      onSelect,
                      activeKey,
                    ),
                  )}
                </Inline>
              </Show>
            </LayoutGroup>
          </Inline>
          <Inline gap={2} wrap={false}>
            {actions && mobileActionsLabel ? (
              <>
                <Show above="md" display="flex">
                  <Inline gap={2} wrap={false}>
                    {actions}
                  </Inline>
                </Show>
                <TopNavActionsMenu
                  actions={actions}
                  activeKey={activeKey}
                  items={[...primaryItems, ...utilityItems]}
                  label={mobileActionsLabel}
                  onSelect={onSelect}
                />
              </>
            ) : (
              actions
            )}
            {utilityItems.length > 0 ? (
              <LayoutGroup id={`${groupId}-utility`}>
                <Show above="md" display="flex">
                  <Inline gap={1} wrap={false}>
                    {utilityItems.map((item) =>
                      renderNavigationItem(
                        item,
                        isNavigationItemActive(item, activeKey),
                        "horizontal",
                        `${groupId}-utility`,
                        onSelect,
                        activeKey,
                      ),
                    )}
                  </Inline>
                </Show>
              </LayoutGroup>
            ) : null}
          </Inline>
        </Cluster>
      </Container>
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

export interface SideNavProps extends Omit<HTMLAttributes<HTMLElement>, "className" | "style" | "onSelect"> {
  items: NavigationItem[];
  activeKey?: string;
  onSelect?: (key: string) => void;
}

export function SideNav({ items, activeKey, onSelect, ...rest }: SideNavProps) {
  const groupId = useId();

  return (
    <nav
      {...rest}
      className="glass-surface flex h-full flex-col gap-2 rounded-tokenLg border border-muted p-3 shadow-tokenSm"
    >
      <LayoutGroup id={groupId}>
        {items.map((item) =>
          renderNavigationItem(item, item.key === activeKey, "vertical", groupId, onSelect, activeKey),
        )}
      </LayoutGroup>
    </nav>
  );
}

export interface BottomNavProps extends Omit<HTMLAttributes<HTMLElement>, "className" | "style" | "onSelect"> {
  items: NavigationItem[];
  activeKey?: string;
  onSelect?: (key: string) => void;
  width?: LayoutWidth;
}

export function BottomNav({ items, activeKey, onSelect, width = "full", ...rest }: BottomNavProps) {
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
      className="fixed inset-x-0 bottom-0 z-sticky border-t border-muted bg-background/overlay px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-tokenLg backdrop-blur-xl md:hidden"
    >
      <LayoutGroup id={groupId}>
        <div className={cx("mx-auto grid w-full gap-2", gridColumnsClass, layoutWidthClasses[width])}>
          {visibleItems.map((item) =>
            renderBottomNavigationItem(item, isNavigationItemActive(item, activeKey), groupId, onSelect, activeKey),
          )}
        </div>
      </LayoutGroup>
    </nav>
  );
}

export interface NavRailProps extends Omit<HTMLAttributes<HTMLElement>, "className" | "style" | "onSelect"> {
  items: NavigationItem[];
  activeKey?: string;
  onSelect?: (key: string) => void;
}

export function NavRail({ items, activeKey, onSelect, ...rest }: NavRailProps) {
  const groupId = useId();

  return (
    <nav
      {...rest}
      className="glass-surface hidden h-full w-24 flex-col gap-2 rounded-tokenLg border border-muted p-2 md:flex"
    >
      <LayoutGroup id={groupId}>
        {items.map((item) => renderNavigationItem(item, item.key === activeKey, "rail", groupId, onSelect, activeKey))}
      </LayoutGroup>
    </nav>
  );
}
