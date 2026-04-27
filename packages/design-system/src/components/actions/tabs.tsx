import type { ReactNode } from "react";
import { useState, useId } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { renderActivePill } from "./shared";

export interface TabItem {
  value: string;
  label: ReactNode;
  content: ReactNode;
  badge?: string;
}

export interface TabsProps
  extends Omit<TabsPrimitive.TabsProps, "className" | "style"> {
  items: TabItem[];
}

export function Tabs({
  items,
  defaultValue,
  value,
  onValueChange,
  orientation = "horizontal",
  dir,
  activationMode = "automatic"
}: TabsProps) {
  const resolvedValue = defaultValue ?? items[0]?.value;
  const [internalValue, setInternalValue] = useState(resolvedValue);
  const currentValue = value ?? internalValue ?? resolvedValue;
  const groupId = useId();

  function handleValueChange(nextValue: string) {
    if (value === undefined) {
      setInternalValue(nextValue);
    }
    onValueChange?.(nextValue);
  }

  return (
    <TabsPrimitive.Root
      defaultValue={resolvedValue}
      value={currentValue}
      onValueChange={handleValueChange}
      orientation={orientation}
      dir={dir}
      activationMode={activationMode}
      className="space-y-4"
    >
      <LayoutGroup id={groupId}>
        <TabsPrimitive.List className="grid w-full min-w-0 max-w-full grid-cols-2 gap-2 rounded-tokenLg border border-muted bg-background p-2 md:inline-flex md:flex-wrap">
          {items.map((item) => {
            const active = item.value === currentValue;

            return (
              <TabsPrimitive.Trigger
                key={item.value}
                value={item.value}
                className="focus-ring relative inline-flex touch-target min-w-0 items-center justify-center gap-2 overflow-hidden rounded-tokenMd px-3 py-2 text-center text-sm font-semibold text-secondary transition data-[state=active]:text-accent md:flex-1 md:basis-0 md:px-4"
              >
                {active ? renderActivePill(groupId, "accent") : null}
                <span className="relative z-10 min-w-0 break-words">{item.label}</span>
                {item.badge ? (
                  <span className="relative z-10 rounded-full bg-background px-2 py-0.5 text-[0.7rem]">
                    {item.badge}
                  </span>
                ) : null}
              </TabsPrimitive.Trigger>
            );
          })}
        </TabsPrimitive.List>
      </LayoutGroup>
      <AnimatePresence initial={false} mode="wait">
        <motion.div
          key={currentValue}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.18 }}
        >
          <TabsPrimitive.Content
            value={currentValue}
            forceMount
            className="focus-visible:outline-none"
          >
            {items.find((item) => item.value === currentValue)?.content}
          </TabsPrimitive.Content>
        </motion.div>
      </AnimatePresence>
    </TabsPrimitive.Root>
  );
}
