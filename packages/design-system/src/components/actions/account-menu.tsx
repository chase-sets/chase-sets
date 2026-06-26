import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { IconName } from "../../icons";
import { useMediaQuery } from "../../hooks";
import { ThemePreferenceControl } from "../../theme/theme-toggle";
import type { ColorMode } from "../../theme/tokens";
import { AccountMenuDesktopSurface, AccountMenuMobileSurface } from "./account-menu-surfaces";

export interface AccountMenuItem {
  key: string;
  label: string;
  href: string;
  icon?: IconName;
}

export interface AccountMenuPreferences {
  colorMode: ColorMode;
  colorModeLabel?: string;
  darkLabel?: string;
  lightLabel?: string;
  onColorModeChange: (mode: ColorMode) => void;
  systemLabel?: string;
}

export interface AccountMenuProps {
  accountLabel?: ReactNode;
  accountName: ReactNode;
  className?: string;
  items: AccountMenuItem[];
  menuLabel?: string;
  preferences?: AccountMenuPreferences | ReactNode;
  roleLabel?: ReactNode;
  roleName: ReactNode;
  signOutFormId: string;
  signOutLabel: ReactNode;
  userLabel?: ReactNode;
  userName: ReactNode;
  mobileSheetThreshold?: number;
}

function isAccountMenuPreferences(preferences: AccountMenuProps["preferences"]): preferences is AccountMenuPreferences {
  return Boolean(
    preferences && typeof preferences === "object" && "colorMode" in preferences && "onColorModeChange" in preferences,
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
  const preferencesContent = isAccountMenuPreferences(preferences) ? (
    <ThemePreferenceControl
      value={preferences.colorMode}
      onValueChange={preferences.onColorModeChange}
      label={preferences.colorModeLabel}
      lightLabel={preferences.lightLabel}
      darkLabel={preferences.darkLabel}
      systemLabel={preferences.systemLabel}
    />
  ) : (
    preferences
  );
  const surfaceProps = {
    accountLabel,
    accountName,
    className,
    items,
    menuId,
    menuLabel,
    menuRef,
    open,
    preferences: preferencesContent,
    roleLabel,
    roleName,
    signOutFormId,
    signOutLabel,
    titleId,
    userLabel,
    userName,
    onClose: () => setOpen(false),
    onToggle: () => setOpen((current) => !current),
  };

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
    return <AccountMenuMobileSurface {...surfaceProps} />;
  }

  return <AccountMenuDesktopSurface {...surfaceProps} />;
}
