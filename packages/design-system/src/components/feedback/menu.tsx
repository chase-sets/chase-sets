import { useState, type ReactNode } from "react";
import { motion } from "motion/react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Icon, type IconName } from "../../icons";
import { useChaseMotion, usePortalRoots } from "../../theme/provider";
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
    <DropdownMenuPrimitive.Item
      key={item.key}
      disabled={item.disabled}
      className={cx(
        "focus-ring flex cursor-pointer select-none items-start gap-3 rounded-tokenMd px-3 py-2 text-sm outline-none data-[highlighted]:bg-background data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
        item.destructive ? "text-danger" : "text-foreground"
      )}
      onSelect={item.onSelect}
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
    </DropdownMenuPrimitive.Item>
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
    <DropdownMenuPrimitive.Root open={open} onOpenChange={setOpen}>
      <DropdownMenuPrimitive.Trigger asChild>
        {trigger}
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal container={overlayNode ?? undefined}>
        <DropdownMenuPrimitive.Content
          sideOffset={8}
          forceMount
          asChild
        >
          <motion.div
            initial={motionProps.initial}
            animate={motionProps.animate}
            transition={motionProps.transition}
            className="modern-surface z-dropdown min-w-56 rounded-tokenLg border border-muted p-2 shadow-overlay"
          >
            {groups
              ? groups.map((group, groupIndex) => (
                  <DropdownMenuPrimitive.Group key={groupIndex}>
                    {group.label ? (
                      <DropdownMenuPrimitive.Label className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-secondary">
                        {group.label}
                      </DropdownMenuPrimitive.Label>
                    ) : null}
                    {group.items.map(renderMenuItem)}
                    {groupIndex < groups.length - 1 ? (
                      <DropdownMenuPrimitive.Separator className="my-1 h-px bg-muted" />
                    ) : null}
                  </DropdownMenuPrimitive.Group>
                ))
              : items?.map(renderMenuItem)}
          </motion.div>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
