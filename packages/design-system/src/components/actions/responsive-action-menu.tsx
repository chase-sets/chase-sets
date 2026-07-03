import { useState, type ReactNode } from "react";
import { BottomSheet, Menu, type MenuGroup, type MenuItem } from "../feedback";
import { Icon } from "../../icons";
import { useMediaQuery } from "../../hooks";
import { minWidthQuery } from "../../theme/tokens";
import { cx } from "../../utils/cx";
import { controlHeightClasses, controlPaddingClasses, controlTextClasses } from "../control-sizing";

export interface ResponsiveActionMenuProps {
  trigger: ReactNode;
  items?: MenuItem[];
  groups?: MenuGroup[];
  menuLabel?: string;
  sheetTitle?: ReactNode;
  sheetDescription?: ReactNode;
  mobileSheetThreshold?: number;
}

function flattenItems(items?: MenuItem[], groups?: MenuGroup[]) {
  return groups ? groups.flatMap((group) => group.items) : (items ?? []);
}

function actionItemClassName(destructive?: boolean, disabled?: boolean) {
  return cx(
    "focus-ring flex w-full min-w-0 items-start gap-3 rounded-tokenMd text-left transition",
    controlHeightClasses.md,
    controlPaddingClasses.md,
    controlTextClasses.md,
    disabled && "cursor-not-allowed opacity-disabled",
    destructive ? "text-danger" : "text-foreground",
  );
}

function renderMobileActionItem(item: MenuItem, onClose: () => void) {
  const icon = item.icon ? <Icon name={item.icon} size="sm" tone={item.destructive ? "danger" : "secondary"} /> : null;
  const content = (
    <>
      {icon}
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="block font-medium">{item.label}</span>
        {item.description ? <span className="block text-xs text-secondary">{item.description}</span> : null}
      </span>
      {item.shortcut ? <span className="text-xs text-secondary">{item.shortcut}</span> : null}
    </>
  );

  if (item.href) {
    return (
      <a
        key={item.key}
        href={item.href}
        className={actionItemClassName(item.destructive, item.disabled)}
        aria-disabled={item.disabled || undefined}
        onClick={(event) => {
          if (item.disabled) {
            event.preventDefault();
            return;
          }

          item.onSelect?.();
          onClose();
        }}
      >
        {content}
      </a>
    );
  }

  return (
    <button
      key={item.key}
      type="button"
      disabled={item.disabled}
      className={actionItemClassName(item.destructive, item.disabled)}
      onClick={() => {
        item.onSelect?.();
        onClose();
      }}
    >
      {content}
    </button>
  );
}

export function ResponsiveActionMenu({
  trigger,
  items,
  groups,
  menuLabel = "Actions",
  sheetTitle = menuLabel,
  sheetDescription,
  mobileSheetThreshold = 4,
}: ResponsiveActionMenuProps) {
  const [open, setOpen] = useState(false);
  const isDesktop = useMediaQuery(minWidthQuery("md"));
  const allItems = flattenItems(items, groups);
  const useMobileSheet = !isDesktop && allItems.length > mobileSheetThreshold;

  if (!useMobileSheet) {
    return <Menu trigger={trigger} items={items} groups={groups} />;
  }

  return (
    <BottomSheet
      open={open}
      onOpenChange={setOpen}
      title={sheetTitle}
      description={sheetDescription}
      height={allItems.length > 8 ? "expanded" : "medium"}
      trigger={trigger}
    >
      <div className="grid gap-3">
        {groups ? (
          groups.map((group, groupIndex) => (
            <div key={groupIndex} className="grid gap-1">
              {group.label ? (
                <div className="px-3 py-1 text-xs font-semibold uppercase text-secondary">{group.label}</div>
              ) : null}
              {group.items.map((item) => renderMobileActionItem(item, () => setOpen(false)))}
              {groupIndex < groups.length - 1 ? <div className="my-1 h-px bg-muted" /> : null}
            </div>
          ))
        ) : (
          <div className="grid gap-1">{items?.map((item) => renderMobileActionItem(item, () => setOpen(false)))}</div>
        )}
      </div>
    </BottomSheet>
  );
}
