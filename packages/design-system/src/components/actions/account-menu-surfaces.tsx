// @ds-leaf
import type { RefObject, ReactNode } from "react";
import { Badge } from "../feedback";
import { Icon } from "../../icons";
import { Box, Cluster, Divider, Stack } from "../../primitives/layout";
import { cx } from "../../utils/cx";
import { controlHeightClasses, controlSquareSizeClasses } from "../control-sizing";
import type { AccountMenuItem } from "./account-menu";

type AccountMenuSurfaceProps = Readonly<{
  accountLabel: ReactNode;
  accountName: ReactNode;
  className?: string;
  items: AccountMenuItem[];
  menuId: string;
  menuLabel: string;
  menuRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onToggle: () => void;
  open: boolean;
  preferences?: ReactNode;
  roleLabel: ReactNode;
  roleName: ReactNode;
  signOutFormId: string;
  signOutLabel: ReactNode;
  titleId: string;
  userLabel: ReactNode;
  userName: ReactNode;
}>;

function menuItemClassName(highlighted?: boolean, destructive = false) {
  return cx(
    "focus-ring flex min-w-0 cursor-pointer select-none items-center gap-3 rounded-tokenMd px-3 py-2 text-sm outline-none transition",
    controlHeightClasses.md,
    highlighted && "bg-background",
    destructive ? "text-danger" : "text-foreground",
  );
}

function AccountMenuTrigger({
  accountName,
  className,
  menuId,
  menuLabel,
  onToggle,
  open,
  roleName,
  variant,
}: Pick<
  AccountMenuSurfaceProps,
  "accountName" | "className" | "menuId" | "menuLabel" | "onToggle" | "open" | "roleName"
> &
  Readonly<{ variant: "dialog" | "menu" }>) {
  return (
    <button
      type="button"
      aria-controls={menuId}
      aria-expanded={open}
      aria-haspopup={variant}
      aria-label={menuLabel}
      className={cx(
        "focus-ring inline-flex max-w-[12.5rem] items-center gap-2 rounded-tokenMd border border-muted bg-surface px-3 py-2 text-left shadow-tokenSm transition hover:border-accent hover:bg-surface-2 sm:max-w-[15rem] md:max-w-[18rem]",
        controlHeightClasses.md,
        className,
      )}
      onClick={onToggle}
    >
      <Icon name="user" size="sm" tone="secondary" />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-xs font-semibold text-foreground">{accountName}</span>
        <span className="block truncate text-2xs text-secondary">{roleName}</span>
      </span>
      <Icon name="chevronDown" size="sm" tone="secondary" />
    </button>
  );
}

function AccountMenuSummary({
  accountLabel,
  accountName,
  roleLabel,
  roleName,
  userLabel,
  userName,
}: Pick<
  AccountMenuSurfaceProps,
  "accountLabel" | "accountName" | "roleLabel" | "roleName" | "userLabel" | "userName"
>) {
  return (
    <Box paddingX={3} paddingY={3}>
      <Stack gap={3}>
        <Cluster align="start" gap={3}>
          <Box minWidth="0">
            <div className="text-xs font-semibold uppercase text-secondary">{accountLabel}</div>
            <div className="mt-1 truncate text-sm font-semibold text-foreground">{accountName}</div>
          </Box>
          <Badge tone="neutral">{roleName}</Badge>
        </Cluster>
        <Box minWidth="0">
          <div className="text-xs font-semibold uppercase text-secondary">{userLabel}</div>
          <div className="mt-1 truncate text-sm text-foreground">{userName}</div>
        </Box>
      </Stack>
      <div className="sr-only">
        {roleLabel} {roleName}
      </div>
    </Box>
  );
}

function AccountMenuLink({
  item,
  onClose,
  role,
}: Readonly<{ item: AccountMenuItem; onClose: () => void; role?: "menuitem" }>) {
  return (
    <a key={item.key} href={item.href} role={role} className={menuItemClassName(false)} onClick={onClose}>
      {item.icon ? <Icon name={item.icon} size="sm" tone="secondary" /> : null}
      <span className="min-w-0 flex-1 truncate font-medium">{item.label}</span>
    </a>
  );
}

function AccountMenuSignOut({
  role,
  signOutFormId,
  signOutLabel,
}: Pick<AccountMenuSurfaceProps, "signOutFormId" | "signOutLabel"> & Readonly<{ role?: "menuitem" }>) {
  return (
    <button type="submit" form={signOutFormId} role={role} className={menuItemClassName(false, true)}>
      <Icon name="logOut" size="sm" tone="danger" />
      <span className="min-w-0 flex-1 truncate font-medium">{signOutLabel}</span>
    </button>
  );
}

export function AccountMenuMobileSurface(props: AccountMenuSurfaceProps) {
  return (
    <div ref={props.menuRef} className="relative">
      <AccountMenuTrigger {...props} variant="dialog" />
      {props.open ? (
        <>
          <button
            type="button"
            aria-label="Close account menu"
            className="fixed inset-0 z-modal cursor-default bg-overlay"
            onClick={props.onClose}
          />
          <aside
            id={props.menuId}
            role="dialog"
            aria-modal="true"
            aria-labelledby={props.titleId}
            className="modern-surface fixed inset-x-3 bottom-3 z-modal max-h-[60vh] rounded-tokenXl border border-muted p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-overlay"
          >
            <Stack gap={2}>
              <div className="flex items-start justify-between gap-4">
                <h2 id={props.titleId} className="font-heading text-xl font-semibold text-foreground">
                  {props.menuLabel}
                </h2>
                <button
                  type="button"
                  aria-label="Close account menu"
                  className={cx(
                    "focus-ring inline-flex items-center justify-center rounded-tokenMd text-secondary transition hover:bg-surface-2 hover:text-foreground",
                    controlSquareSizeClasses.md,
                  )}
                  onClick={props.onClose}
                >
                  <Icon name="close" size="sm" tone="secondary" />
                </button>
              </div>
              <AccountMenuSummary {...props} />
              <Divider />
              <nav aria-label={props.menuLabel}>
                <Stack gap={1}>
                  {props.items.map((item) => (
                    <AccountMenuLink key={item.key} item={item} onClose={props.onClose} />
                  ))}
                </Stack>
              </nav>
              <Divider />
              {props.preferences ? (
                <>
                  <Box paddingX={3} paddingY={2}>
                    {props.preferences}
                  </Box>
                  <Divider />
                </>
              ) : null}
              <AccountMenuSignOut {...props} />
            </Stack>
          </aside>
        </>
      ) : null}
    </div>
  );
}

export function AccountMenuDesktopSurface(props: AccountMenuSurfaceProps) {
  return (
    <div ref={props.menuRef} className="relative">
      <AccountMenuTrigger {...props} variant="menu" />
      {props.open ? (
        <div
          id={props.menuId}
          role="menu"
          aria-label={props.menuLabel}
          className="modern-surface absolute right-0 top-[calc(100%+0.5rem)] z-dropdown w-[min(20rem,calc(100vw-2rem))] rounded-tokenLg border border-muted p-2 shadow-overlay"
        >
          <AccountMenuSummary {...props} />
          <div role="separator" className="my-1 h-px bg-muted" />
          {props.items.map((item) => (
            <AccountMenuLink key={item.key} item={item} role="menuitem" onClose={props.onClose} />
          ))}
          <div role="separator" className="my-1 h-px bg-muted" />
          {props.preferences ? (
            <>
              <Box paddingX={3} paddingY={2}>
                {props.preferences}
              </Box>
              <div role="separator" className="my-1 h-px bg-muted" />
            </>
          ) : null}
          <AccountMenuSignOut {...props} role="menuitem" />
        </div>
      ) : null}
    </div>
  );
}
