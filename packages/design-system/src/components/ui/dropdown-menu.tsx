import type { ReactElement } from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cn } from "../../lib/utils";

export interface DropdownMenuItem {
  key: string;
  label: string;
  description?: string;
  destructive?: boolean;
  onSelect?: () => void;
}

export function DropdownMenu({
  trigger,
  items
}: {
  trigger: ReactElement;
  items: DropdownMenuItem[];
}) {
  return (
    <MenuPrimitive.Root>
      <MenuPrimitive.Trigger render={trigger} />
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner sideOffset={8} className="z-50">
          <MenuPrimitive.Popup className="min-w-56 rounded-[var(--radius-lg)] border border-[var(--muted)] bg-[var(--popover)] p-2 text-[var(--popover-foreground)] shadow-[var(--shadow-overlay)]">
            {items.map((item) => (
              <MenuPrimitive.Item
                key={item.key}
                onClick={item.onSelect}
                className={(state) => cn(
                  "ds-focus grid cursor-pointer gap-0.5 rounded-[var(--radius)] px-3 py-2 text-sm outline-none",
                  state.highlighted && "bg-[var(--secondary)]",
                  item.destructive && "text-[var(--destructive)]"
                )}
              >
                <span className="font-medium">{item.label}</span>
                {item.description ? (
                  <span className="text-xs text-[var(--muted-foreground)]">{item.description}</span>
                ) : null}
              </MenuPrimitive.Item>
            ))}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
