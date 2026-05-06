import type { ReactNode } from "react";
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "../../lib/utils";

export interface TabItem {
  value: string;
  label: ReactNode;
  content: ReactNode;
}

export interface TabsProps {
  items: TabItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}

export function Tabs({
  items,
  value,
  defaultValue = items[0]?.value,
  onValueChange
}: TabsProps) {
  return (
    <TabsPrimitive.Root
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange}
      className="grid gap-4"
    >
      <TabsPrimitive.List className="inline-flex w-fit max-w-full gap-1 rounded-[var(--radius-lg)] border border-[var(--muted)] bg-[var(--secondary)] p-1 shadow-[var(--shadow-sm)]">
        {items.map((item) => (
          <TabsPrimitive.Tab
            key={item.value}
            value={item.value}
            className={(state) => cn(
              "ds-focus rounded-[var(--radius)] px-3 py-1.5 text-sm font-semibold text-[var(--muted-foreground)] transition-colors",
              state.active && "bg-[var(--card)] text-[var(--foreground)] shadow-[var(--shadow-sm)]"
            )}
          >
            {item.label}
          </TabsPrimitive.Tab>
        ))}
      </TabsPrimitive.List>
      {items.map((item) => (
        <TabsPrimitive.Panel
          key={item.value}
          value={item.value}
          className="outline-none"
        >
          {item.content}
        </TabsPrimitive.Panel>
      ))}
    </TabsPrimitive.Root>
  );
}
