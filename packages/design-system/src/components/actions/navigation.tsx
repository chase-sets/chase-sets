import type { HTMLAttributes, ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { ChaseSetsLogo } from "../../brand/chase-sets-logo";
import type { IconName } from "../../icons";
import { Icon } from "../../icons";
import { Cluster, Container, Inline, layoutWidthClasses, Show, type LayoutWidth } from "../../primitives/layout";
import { AnchorLink, useLinkComponent, type LinkComponent } from "../../theme/link-adapter";
import { useChaseMotion, usePortalRoots } from "../../theme/provider";
import { renderMotionDiv } from "../../utils/base-ui";
import { cx } from "../../utils/cx";
import { resolveOverlayMotion } from "../feedback/motion-overlay";
import { controlSquareSizeClasses } from "../control-sizing";
import { renderActivePill, renderActivePillGroup } from "./shared";

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
  reducedMotion = false,
  Link: LinkComponent = AnchorLink,
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
        reducedMotion={reducedMotion}
        Link={Link}
      />
    );
  }

  if (orientation === "vertical" && item.children?.length) {
    return (
      <NavigationTreeItem
        key={item.key}
        item={item}
        active={active}
        className={className}
        content={content}
        groupId={groupId}
        onSelect={onSelect}
        activeKey={activeKey}
        reducedMotion={reducedMotion}
        Link={Link}
      />
    );
  }

  if (item.href) {
    return (
      <Link key={item.key} href={item.href} aria-current={active ? "page" : undefined} className={className}>
        {active && groupId ? renderActivePill(groupId, "default", reducedMotion) : null}
        <NavItemContent>{content}</NavItemContent>
      </Link>
    );
  }

  return (
    <button key={item.key} type="button" className={className} onClick={() => onSelect?.(item.key)}>
      {active && groupId ? renderActivePill(groupId, "default", reducedMotion) : null}
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
  reducedMotion,
  Link,
}: {
  item: NavigationItem;
  active: boolean;
  className: string;
  content: ReactNode;
  groupId?: string;
  onSelect?: (key: string) => void;
  activeKey?: string;
  reducedMotion: boolean;
  Link: LinkComponent;
}) {
  const { overlayNode } = usePortalRoots();
  const motionSettings = useChaseMotion();
  const [open, setOpen] = useState(false);
  const motionProps = resolveOverlayMotion(
    motionSettings,
    open,
    { opacity: 1, y: 0, scale: 1 },
    { opacity: 0, y: 10, scale: 0.98 },
  );

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger className={cx(className, active && "bg-surface-2 text-accent shadow-tokenSm")}>
        {active && groupId ? renderActivePill(groupId, "default", reducedMotion) : null}
        <NavItemContent>{content}</NavItemContent>
        <NavItemContent className={cx("transition-transform duration-200", open && "rotate-180")}>
          <Icon name="chevronDown" size="sm" tone={active ? "accent" : "secondary"} />
        </NavItemContent>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal container={overlayNode ?? undefined}>
        <PopoverPrimitive.Positioner sideOffset={8} className="z-dropdown">
          <PopoverPrimitive.Popup
            render={renderMotionDiv({
              initial: motionProps.initial,
              animate: motionProps.animate,
              transition: motionProps.transition,
              className: "modern-surface min-w-56 rounded-tokenLg border border-muted p-2 shadow-overlay",
            })}
          >
            {item.children?.map((child) =>
              renderNavigationItem(
                child,
                child.key === activeKey,
                "vertical",
                undefined,
                onSelect,
                activeKey,
                undefined,
                Link,
              ),
            )}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/**
 * Vertical expandable group for nested admin side navigation. Unlike the
 * horizontal {@link NavigationItemGroup} (a floating popover), this renders an
 * inline disclosure: a toggle row whose children stack beneath it on a guide
 * rail. The toggle is a plain button with `aria-expanded`/`aria-controls`, so
 * screen readers announce it as a collapsible region and keyboard users get
 * native Enter/Space activation and focus order. Parent rows highlight whenever
 * a descendant route is active and auto-expand to reveal that descendant.
 */
function NavigationTreeItem({
  item,
  active,
  className,
  content,
  groupId,
  onSelect,
  activeKey,
  reducedMotion,
  Link,
}: {
  item: NavigationItem;
  active: boolean;
  className: string;
  content: ReactNode;
  groupId?: string;
  onSelect?: (key: string) => void;
  activeKey?: string;
  reducedMotion: boolean;
  Link: LinkComponent;
}) {
  const regionId = useId();
  const [open, setOpen] = useState(active);
  const toggleProps = {
    className: cx(className, active && "bg-surface-2 text-accent shadow-tokenSm"),
  };
  const regionProps = {
    className: "mt-1 ml-3 flex flex-col gap-1 border-l border-muted pl-2",
  };

  // Keep the branch open whenever it owns the active route so navigating to a
  // nested child reveals it without forcing the consumer to manage open state.
  useEffect(() => {
    if (active) {
      setOpen(true);
    }
  }, [active]);

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((previous) => !previous)}
        {...toggleProps}
      >
        <NavItemContent>{content}</NavItemContent>
        <NavItemContent className={cx("transition-transform duration-200", open && "rotate-90")}>
          <Icon name="chevronRight" size="sm" tone={active ? "accent" : "secondary"} />
        </NavItemContent>
      </button>
      <div id={regionId} role="group" aria-label={item.label} hidden={!open} {...regionProps}>
        {item.children?.map((child) =>
          renderNavigationItem(
            child,
            isNavigationItemActive(child, activeKey),
            "vertical",
            groupId,
            onSelect,
            activeKey,
            reducedMotion,
            Link,
          ),
        )}
      </div>
    </div>
  );
}

function renderBottomNavigationItem(
  item: NavigationItem,
  active: boolean,
  groupId?: string,
  onSelect?: (key: string) => void,
  activeKey?: string,
  reducedMotion = false,
  Link: LinkComponent = AnchorLink,
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
          {active && groupId ? renderActivePill(groupId, "default", reducedMotion) : null}
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
              undefined,
              Link,
            ),
          )}
        </div>
      </details>
    );
  }

  if (item.href) {
    return (
      <Link key={item.key} href={item.href} className={className}>
        {active && groupId ? renderActivePill(groupId, "default", reducedMotion) : null}
        <NavItemContent className="w-full min-w-0 flex-col justify-center">{content}</NavItemContent>
      </Link>
    );
  }

  return (
    <button key={item.key} type="button" className={className} onClick={() => onSelect?.(item.key)}>
      {active && groupId ? renderActivePill(groupId, "default", reducedMotion) : null}
      <NavItemContent className="w-full min-w-0 flex-col justify-center">{content}</NavItemContent>
    </button>
  );
}

function isNavigationItemActive(item: NavigationItem, activeKey?: string): boolean {
  return item.key === activeKey || Boolean(item.children?.some((child) => isNavigationItemActive(child, activeKey)));
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
  const Link = useLinkComponent();

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
                renderNavigationItem(
                  item,
                  isNavigationItemActive(item, activeKey),
                  "vertical",
                  undefined,
                  onSelect,
                  undefined,
                  undefined,
                  Link,
                ),
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
  const motionSettings = useChaseMotion();
  const Link = useLinkComponent();
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
            {renderActivePillGroup(
              groupId,
              motionSettings.reducedMotion,
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
                      motionSettings.reducedMotion,
                      Link,
                    ),
                  )}
                </Inline>
              </Show>,
            )}
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
            {utilityItems.length > 0
              ? renderActivePillGroup(
                  `${groupId}-utility`,
                  motionSettings.reducedMotion,
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
                          motionSettings.reducedMotion,
                          Link,
                        ),
                      )}
                    </Inline>
                  </Show>,
                )
              : null}
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
  const Link = useLinkComponent();

  return (
    <Link
      href={href}
      aria-label={label}
      className="focus-ring inline-flex items-center gap-2 rounded-tokenSm px-1 py-1 text-sm font-semibold text-foreground transition hover:text-accent"
    >
      <ChaseSetsLogo decorative size={20} />
      <span>{label}</span>
    </Link>
  );
}

export interface SideNavProps extends Omit<HTMLAttributes<HTMLElement>, "className" | "style" | "onSelect"> {
  items: NavigationItem[];
  activeKey?: string;
  onSelect?: (key: string) => void;
}

export function SideNav({ items, activeKey, onSelect, ...rest }: SideNavProps) {
  const groupId = useId();
  const motionSettings = useChaseMotion();
  const Link = useLinkComponent();

  return (
    <nav
      {...rest}
      className="ds-glass flex h-full flex-col gap-2 rounded-tokenLg border border-muted p-3 shadow-tokenSm"
    >
      {renderActivePillGroup(
        groupId,
        motionSettings.reducedMotion,
        items.map((item) =>
          renderNavigationItem(
            item,
            isNavigationItemActive(item, activeKey),
            "vertical",
            groupId,
            onSelect,
            activeKey,
            motionSettings.reducedMotion,
            Link,
          ),
        ),
      )}
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
  const motionSettings = useChaseMotion();
  const Link = useLinkComponent();
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
      {renderActivePillGroup(
        groupId,
        motionSettings.reducedMotion,
        <div className={cx("mx-auto grid w-full gap-2", gridColumnsClass, layoutWidthClasses[width])}>
          {visibleItems.map((item) =>
            renderBottomNavigationItem(
              item,
              isNavigationItemActive(item, activeKey),
              groupId,
              onSelect,
              activeKey,
              motionSettings.reducedMotion,
              Link,
            ),
          )}
        </div>,
      )}
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
  const motionSettings = useChaseMotion();
  const Link = useLinkComponent();

  return (
    <nav
      {...rest}
      className="ds-glass hidden h-full w-24 flex-col gap-2 rounded-tokenLg border border-muted p-2 md:flex"
    >
      {renderActivePillGroup(
        groupId,
        motionSettings.reducedMotion,
        items.map((item) =>
          renderNavigationItem(
            item,
            item.key === activeKey,
            "rail",
            groupId,
            onSelect,
            activeKey,
            motionSettings.reducedMotion,
            Link,
          ),
        ),
      )}
    </nav>
  );
}
