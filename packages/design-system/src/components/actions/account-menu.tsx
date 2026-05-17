import { useState, type ReactNode } from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { Badge, BottomSheet } from "../feedback";
import { Icon, type IconName } from "../../icons";
import { useMediaQuery } from "../../hooks";
import { useChaseMotion, usePortalRoots } from "../../theme/provider";
import { renderMotionDiv } from "../../utils/base-ui";
import { cx } from "../../utils/cx";
import { resolveOverlayMotion } from "../feedback/motion-overlay";

export interface AccountMenuItem {
  key: string;
  label: string;
  href: string;
  icon?: IconName;
}

export interface AccountMenuProps {
  accountLabel?: ReactNode;
  accountName: ReactNode;
  className?: string;
  items: AccountMenuItem[];
  menuLabel?: string;
  roleLabel?: ReactNode;
  roleName: ReactNode;
  signOutFormId: string;
  signOutLabel: ReactNode;
  userLabel?: ReactNode;
  userName: ReactNode;
  mobileSheetThreshold?: number;
}

function menuItemClassName(highlighted?: boolean, destructive = false) {
  return cx(
    "focus-ring flex min-w-0 cursor-pointer select-none items-center gap-3 rounded-tokenMd px-3 py-2 text-sm outline-none transition",
    highlighted && "bg-background",
    destructive ? "text-danger" : "text-foreground",
  );
}

export function AccountMenu({
  accountLabel = "Account",
  accountName,
  className,
  items,
  menuLabel = "Account menu",
  roleLabel = "Role",
  roleName,
  signOutFormId,
  signOutLabel,
  userLabel = "User",
  userName,
  mobileSheetThreshold = 4,
}: AccountMenuProps) {
  const { overlayNode } = usePortalRoots();
  const motionSettings = useChaseMotion();
  const [open, setOpen] = useState(false);
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const useMobileSheet = !isDesktop && items.length > mobileSheetThreshold;
  const motionProps = resolveOverlayMotion(
    motionSettings,
    open,
    { opacity: 1, y: 0, scale: 1 },
    { opacity: 0, y: 10, scale: 0.98 },
  );
  const triggerContent = (
    <>
      <Icon name="user" size="sm" tone="secondary" />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-xs font-semibold text-foreground">
          {accountName}
        </span>
        <span className="block truncate text-[0.72rem] text-secondary">
          {roleName}
        </span>
      </span>
      <Icon name="chevronDown" size="sm" tone="secondary" />
    </>
  );
  const triggerClassName = cx(
    "focus-ring inline-flex max-w-[12.5rem] items-center gap-2 rounded-tokenMd border border-muted bg-surface px-3 py-2 text-left shadow-tokenSm transition hover:border-accent hover:bg-surface-2 sm:max-w-[15rem] md:max-w-[18rem]",
    className,
  );
  const accountSummary = (
    <div className="px-3 py-3">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase text-secondary">
            {accountLabel}
          </div>
          <div className="mt-1 truncate text-sm font-semibold text-foreground">
            {accountName}
          </div>
        </div>
        <Badge tone="neutral">{roleName}</Badge>
      </div>
      <div className="mt-3 min-w-0">
        <div className="text-xs font-semibold uppercase text-secondary">
          {userLabel}
        </div>
        <div className="mt-1 truncate text-sm text-foreground">{userName}</div>
      </div>
      <div className="sr-only">
        {roleLabel} {roleName}
      </div>
    </div>
  );

  if (useMobileSheet) {
    return (
      <BottomSheet
        open={open}
        onOpenChange={setOpen}
        title={menuLabel}
        height="medium"
        trigger={
          <button
            type="button"
            aria-label={menuLabel}
            className={triggerClassName}
          >
            {triggerContent}
          </button>
        }
      >
        <div className="grid gap-2">
          {accountSummary}
          <div className="h-px bg-muted" />
          <nav aria-label={menuLabel} className="grid gap-1">
            {items.map((item) => (
              <a
                key={item.key}
                href={item.href}
                className={menuItemClassName(false)}
                onClick={() => setOpen(false)}
              >
                {item.icon ? <Icon name={item.icon} size="sm" tone="secondary" /> : null}
                <span className="min-w-0 flex-1 truncate font-medium">{item.label}</span>
              </a>
            ))}
          </nav>
          <div className="h-px bg-muted" />
          <button
            type="submit"
            form={signOutFormId}
            className={menuItemClassName(false, true)}
          >
            <Icon name="logOut" size="sm" tone="danger" />
            <span className="min-w-0 flex-1 truncate font-medium">{signOutLabel}</span>
          </button>
        </div>
      </BottomSheet>
    );
  }

  return (
    <MenuPrimitive.Root open={open} onOpenChange={setOpen}>
      <MenuPrimitive.Trigger
        aria-label={menuLabel}
        className={triggerClassName}
      >
        {triggerContent}
      </MenuPrimitive.Trigger>
      <MenuPrimitive.Portal container={overlayNode ?? undefined}>
        <MenuPrimitive.Positioner sideOffset={8} className="z-dropdown">
          <MenuPrimitive.Popup
            render={renderMotionDiv({
              initial: motionProps.initial,
              animate: motionProps.animate,
              transition: motionProps.transition,
              className: "modern-surface w-[min(20rem,calc(100vw-2rem))] rounded-tokenLg border border-muted p-2 shadow-overlay",
            })}
          >
            {accountSummary}
            <MenuPrimitive.Separator className="my-1 h-px bg-muted" />
            {items.map((item) => (
              <MenuPrimitive.LinkItem
                key={item.key}
                href={item.href}
                closeOnClick
                className={(state) => menuItemClassName(state.highlighted)}
              >
                {item.icon ? <Icon name={item.icon} size="sm" tone="secondary" /> : null}
                <span className="min-w-0 flex-1 truncate font-medium">{item.label}</span>
              </MenuPrimitive.LinkItem>
            ))}
            <MenuPrimitive.Separator className="my-1 h-px bg-muted" />
            <MenuPrimitive.Item
              nativeButton
              render={<button type="submit" form={signOutFormId} />}
              className={(state) => menuItemClassName(state.highlighted, true)}
            >
              <Icon name="logOut" size="sm" tone="danger" />
              <span className="min-w-0 flex-1 truncate font-medium">{signOutLabel}</span>
            </MenuPrimitive.Item>
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
