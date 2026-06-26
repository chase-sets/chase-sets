import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Badge } from "../feedback";
import { Icon, type IconName } from "../../icons";
import { useMediaQuery } from "../../hooks";
import { Box, Cluster, Divider, Stack } from "../../primitives/layout";
import { cx } from "../../utils/cx";

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
  preferences?: ReactNode;
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
  preferences,
  roleLabel = "Role",
  roleName,
  signOutFormId,
  signOutLabel,
  userLabel = "User",
  userName,
  mobileSheetThreshold = 4,
}: AccountMenuProps) {
  const menuId = useId();
  const titleId = useId();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const useMobileSheet = !isDesktop && items.length > mobileSheetThreshold;
  const triggerContent = (
    <>
      <Icon name="user" size="sm" tone="secondary" />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-xs font-semibold text-foreground">{accountName}</span>
        <span className="block truncate text-2xs text-secondary">{roleName}</span>
      </span>
      <Icon name="chevronDown" size="sm" tone="secondary" />
    </>
  );
  const triggerClassName = cx(
    "focus-ring inline-flex max-w-[12.5rem] items-center gap-2 rounded-tokenMd border border-muted bg-surface px-3 py-2 text-left shadow-tokenSm transition hover:border-accent hover:bg-surface-2 sm:max-w-[15rem] md:max-w-[18rem]",
    className,
  );
  const accountSummary = (
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

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node | null;

      if (!target || menuRef.current?.contains(target)) {
        return;
      }

      setOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

      setOpen(false);
      menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (useMobileSheet) {
    return (
      <div ref={menuRef} className="relative">
        <button
          type="button"
          aria-controls={menuId}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={menuLabel}
          className={triggerClassName}
          onClick={() => setOpen((current) => !current)}
        >
          {triggerContent}
        </button>
        {open ? (
          <>
            <button
              type="button"
              aria-label="Close account menu"
              className="fixed inset-0 z-modal cursor-default bg-overlay"
              onClick={() => setOpen(false)}
            />
            <aside
              id={menuId}
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              className="modern-surface fixed inset-x-3 bottom-3 z-modal max-h-[60vh] rounded-tokenXl border border-muted p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-overlay"
            >
              <Stack gap={2}>
                <div className="flex items-start justify-between gap-4">
                  <h2 id={titleId} className="font-heading text-xl font-semibold text-foreground">
                    {menuLabel}
                  </h2>
                  <button
                    type="button"
                    aria-label="Close account menu"
                    className="focus-ring inline-flex h-9 w-9 items-center justify-center rounded-tokenMd text-secondary transition hover:bg-surface-2 hover:text-foreground"
                    onClick={() => setOpen(false)}
                  >
                    <Icon name="close" size="sm" tone="secondary" />
                  </button>
                </div>
                {accountSummary}
                <Divider />
                <nav aria-label={menuLabel}>
                  <Stack gap={1}>
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
                  </Stack>
                </nav>
                <Divider />
                {preferences ? (
                  <>
                    <Box paddingX={3} paddingY={2}>
                      {preferences}
                    </Box>
                    <Divider />
                  </>
                ) : null}
                <button type="submit" form={signOutFormId} className={menuItemClassName(false, true)}>
                  <Icon name="logOut" size="sm" tone="danger" />
                  <span className="min-w-0 flex-1 truncate font-medium">{signOutLabel}</span>
                </button>
              </Stack>
            </aside>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={menuLabel}
        className={triggerClassName}
        onClick={() => setOpen((current) => !current)}
      >
        {triggerContent}
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={typeof menuLabel === "string" ? menuLabel : undefined}
          className="modern-surface absolute right-0 top-[calc(100%+0.5rem)] z-dropdown w-[min(20rem,calc(100vw-2rem))] rounded-tokenLg border border-muted p-2 shadow-overlay"
        >
          {accountSummary}
          <div role="separator" className="my-1 h-px bg-muted" />
          {items.map((item) => (
            <a
              key={item.key}
              href={item.href}
              role="menuitem"
              className={menuItemClassName(false)}
              onClick={() => setOpen(false)}
            >
              {item.icon ? <Icon name={item.icon} size="sm" tone="secondary" /> : null}
              <span className="min-w-0 flex-1 truncate font-medium">{item.label}</span>
            </a>
          ))}
          <div role="separator" className="my-1 h-px bg-muted" />
          {preferences ? (
            <>
              <Box paddingX={3} paddingY={2}>
                {preferences}
              </Box>
              <div role="separator" className="my-1 h-px bg-muted" />
            </>
          ) : null}
          <button type="submit" form={signOutFormId} role="menuitem" className={menuItemClassName(false, true)}>
            <Icon name="logOut" size="sm" tone="danger" />
            <span className="min-w-0 flex-1 truncate font-medium">{signOutLabel}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
