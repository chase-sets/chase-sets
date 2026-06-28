import type { ReactNode } from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { Icon, type IconName } from "../../icons";
import { useChaseMotion, usePortalRoots } from "../../theme/provider";
import { renderButtonTrigger, renderMotionDiv } from "../../utils/base-ui";
import { cx } from "../../utils/cx";
import { resolveOverlayMotion } from "./motion-overlay";
import { useControllableOpen } from "./shared";

export interface MenuItem {
  key: string;
  label: string;
  description?: string;
  destructive?: boolean;
  href?: string;
  onSelect?: () => void;
  icon?: IconName;
  shortcut?: string;
  disabled?: boolean;
}

export interface MenuGroup {
  label?: string;
  items: MenuItem[];
}

export interface MenuProps {
  trigger: ReactNode;
  items?: MenuItem[];
  groups?: MenuGroup[];
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function renderMenuItem(item: MenuItem) {
  const content = (
    <>
      {item.icon ? <Icon name={item.icon} size="sm" tone={item.destructive ? "danger" : "secondary"} /> : null}
      <div className="flex-1 space-y-0.5">
        <div className="font-medium">{item.label}</div>
        {item.description ? <div className="text-xs text-secondary">{item.description}</div> : null}
      </div>
      {item.shortcut ? <span className="ml-auto text-xs text-secondary">{item.shortcut}</span> : null}
    </>
  );
  const className = (state: { highlighted?: boolean; disabled?: boolean }) =>
    cx(
      "focus-ring flex cursor-pointer select-none items-start gap-3 rounded-tokenMd px-3 py-2 text-sm outline-none",
      state.highlighted && "bg-background",
      state.disabled && "cursor-not-allowed opacity-disabled",
      item.destructive ? "text-danger" : "text-foreground",
    );

  if (item.href) {
    return (
      <MenuPrimitive.LinkItem
        key={item.key}
        href={item.href}
        aria-disabled={item.disabled || undefined}
        closeOnClick
        className={(state) => className({ ...state, disabled: item.disabled })}
        onClick={(event) => {
          if (item.disabled) {
            event.preventDefault();
            return;
          }

          item.onSelect?.();
        }}
      >
        {content}
      </MenuPrimitive.LinkItem>
    );
  }

  return (
    <MenuPrimitive.Item
      key={item.key}
      aria-disabled={item.disabled || undefined}
      className={(state) => className({ ...state, disabled: item.disabled })}
      onClick={(event) => {
        if (item.disabled) {
          event.preventDefault();
          return;
        }

        item.onSelect?.();
      }}
    >
      {content}
    </MenuPrimitive.Item>
  );
}

export function Menu({ trigger, items, groups, open, defaultOpen, onOpenChange }: MenuProps) {
  const { overlayNode } = usePortalRoots();
  const motionSettings = useChaseMotion();
  const [resolvedOpen, setResolvedOpen] = useControllableOpen(open, defaultOpen, onOpenChange);
  const motionProps = resolveOverlayMotion(
    motionSettings,
    resolvedOpen,
    { opacity: 1, y: 0, scale: 1 },
    { opacity: 0, y: 10, scale: 0.98 },
  );

  return (
    <MenuPrimitive.Root open={resolvedOpen} onOpenChange={setResolvedOpen}>
      <MenuPrimitive.Trigger render={renderButtonTrigger(trigger)} />
      <MenuPrimitive.Portal container={overlayNode ?? undefined}>
        <MenuPrimitive.Positioner sideOffset={8} className="z-dropdown">
          <MenuPrimitive.Popup
            render={renderMotionDiv({
              initial: motionProps.initial,
              animate: motionProps.animate,
              transition: motionProps.transition,
              className: "modern-surface min-w-56 rounded-tokenLg border border-muted p-2 shadow-overlay",
            })}
          >
            {groups
              ? groups.map((group, groupIndex) => (
                  <MenuPrimitive.Group key={groupIndex}>
                    {group.label ? (
                      <MenuPrimitive.GroupLabel className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-secondary">
                        {group.label}
                      </MenuPrimitive.GroupLabel>
                    ) : null}
                    {group.items.map(renderMenuItem)}
                    {groupIndex < groups.length - 1 ? <MenuPrimitive.Separator className="my-1 h-px bg-muted" /> : null}
                  </MenuPrimitive.Group>
                ))
              : items?.map(renderMenuItem)}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
