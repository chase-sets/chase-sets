import type { ReactNode } from "react";
import { NavigationMenu as NavigationMenuPrimitive } from "@base-ui/react/navigation-menu";
import { Icon } from "../../icons";
import { usePortalRoots } from "../../theme/provider";
import { cx } from "../../utils/cx";
import { controlHeightClasses } from "../control-sizing";

export interface NavigationMenuItem {
  value: string;
  label: ReactNode;
  href?: string;
  active?: boolean;
  content?: ReactNode;
}

export interface NavigationMenuProps {
  items: NavigationMenuItem[];
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (value: string | null) => void;
  orientation?: "horizontal" | "vertical";
  label?: string;
}

export function NavigationMenu({
  items,
  value,
  defaultValue,
  onValueChange,
  orientation = "horizontal",
  label = "Primary navigation",
}: NavigationMenuProps) {
  const { overlayNode } = usePortalRoots();

  return (
    <NavigationMenuPrimitive.Root
      value={value}
      defaultValue={defaultValue}
      onValueChange={(nextValue) => onValueChange?.(nextValue)}
      orientation={orientation}
      aria-label={label}
      className="relative"
    >
      <NavigationMenuPrimitive.List
        className={cx(
          "flex gap-1 rounded-tokenLg border border-muted bg-surface-2 p-1",
          orientation === "vertical" && "flex-col",
        )}
      >
        {items.map((item) => (
          <NavigationMenuPrimitive.Item key={item.value} value={item.value}>
            {item.content ? (
              <>
                <NavigationMenuPrimitive.Trigger
                  className={(state) =>
                    cx(
                      "focus-ring inline-flex items-center gap-2 rounded-tokenMd px-3 text-sm font-semibold text-secondary transition hover:bg-elevated hover:text-foreground",
                      controlHeightClasses.md,
                      state.open && "bg-elevated text-accent",
                    )
                  }
                >
                  <span>{item.label}</span>
                  <NavigationMenuPrimitive.Icon>
                    <Icon name="chevronDown" size="sm" tone="secondary" />
                  </NavigationMenuPrimitive.Icon>
                </NavigationMenuPrimitive.Trigger>
                <NavigationMenuPrimitive.Content className="p-4">{item.content}</NavigationMenuPrimitive.Content>
              </>
            ) : (
              <NavigationMenuPrimitive.Link
                href={item.href}
                active={item.active}
                closeOnClick
                className={(state) =>
                  cx(
                    "focus-ring inline-flex items-center rounded-tokenMd px-3 text-sm font-semibold text-secondary transition hover:bg-elevated hover:text-foreground",
                    controlHeightClasses.md,
                    state.active && "bg-elevated text-accent",
                  )
                }
              >
                {item.label}
              </NavigationMenuPrimitive.Link>
            )}
          </NavigationMenuPrimitive.Item>
        ))}
      </NavigationMenuPrimitive.List>
      <NavigationMenuPrimitive.Portal container={overlayNode ?? undefined}>
        <NavigationMenuPrimitive.Positioner sideOffset={8} className="z-popover">
          <NavigationMenuPrimitive.Popup className="modern-surface min-w-72 overflow-hidden rounded-tokenLg border border-muted shadow-overlay">
            <NavigationMenuPrimitive.Viewport />
          </NavigationMenuPrimitive.Popup>
        </NavigationMenuPrimitive.Positioner>
      </NavigationMenuPrimitive.Portal>
    </NavigationMenuPrimitive.Root>
  );
}
