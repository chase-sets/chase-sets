import { useState, type ReactNode } from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { Icon, type IconName } from "../../icons";
import { useChaseMotion, usePortalRoots } from "../../theme/provider";
import { renderButtonTrigger, renderMotionDiv } from "../../utils/base-ui";
import { cx } from "../../utils/cx";
import { resolveOverlayMotion } from "./motion-overlay";

export interface MenuItem {
  key: string;
  label: string;
  description?: string;
  destructive?: boolean;
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
}

function renderMenuItem(item: MenuItem) {
  return (
    <MenuPrimitive.Item
      key={item.key}
      disabled={item.disabled}
      className={(state) => cx(
        "focus-ring flex cursor-pointer select-none items-start gap-3 rounded-tokenMd px-3 py-2 text-sm outline-none",
        state.highlighted && "bg-background",
        state.disabled && "cursor-not-allowed opacity-50",
        item.destructive ? "text-danger" : "text-foreground"
      )}
      onClick={item.onSelect}
    >
      {item.icon ? (
        <Icon
          name={item.icon}
          size="sm"
          tone={item.destructive ? "danger" : "secondary"}
        />
      ) : null}
      <div className="flex-1 space-y-0.5">
        <div className="font-medium">{item.label}</div>
        {item.description ? (
          <div className="text-xs text-secondary">{item.description}</div>
        ) : null}
      </div>
      {item.shortcut ? (
        <span className="ml-auto text-xs text-secondary">{item.shortcut}</span>
      ) : null}
    </MenuPrimitive.Item>
  );
}

export function Menu({
  trigger,
  items,
  groups
}: MenuProps) {
  const { overlayNode } = usePortalRoots();
  const motionSettings = useChaseMotion();
  const [open, setOpen] = useState(false);
  const motionProps = resolveOverlayMotion(
    motionSettings,
    open,
    { opacity: 1, y: 0, scale: 1 },
    { opacity: 0, y: 10, scale: 0.98 }
  );

  return (
    <MenuPrimitive.Root open={open} onOpenChange={setOpen}>
      <MenuPrimitive.Trigger render={renderButtonTrigger(trigger)} />
      <MenuPrimitive.Portal container={overlayNode ?? undefined}>
        <MenuPrimitive.Positioner sideOffset={8} className="z-dropdown">
          <MenuPrimitive.Popup
            render={renderMotionDiv({
              initial: motionProps.initial,
              animate: motionProps.animate,
              transition: motionProps.transition,
              className: "modern-surface min-w-56 rounded-tokenLg border border-muted p-2 shadow-overlay"
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
                    {groupIndex < groups.length - 1 ? (
                      <MenuPrimitive.Separator className="my-1 h-px bg-muted" />
                    ) : null}
                  </MenuPrimitive.Group>
                ))
              : items?.map(renderMenuItem)}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
