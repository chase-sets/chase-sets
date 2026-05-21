import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion";
import { cn } from "../../lib/utils";

export interface AccordionItem {
  value: string;
  trigger: ReactNode;
  content: ReactNode;
}

export function Accordion({ items, defaultValue }: { items: AccordionItem[]; defaultValue?: string }) {
  return (
    <AccordionPrimitive.Root
      defaultValue={defaultValue ? [defaultValue] : undefined}
      className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--muted)] bg-[var(--card)] shadow-[var(--shadow-sm)]"
    >
      {items.map((item, index) => (
        <AccordionPrimitive.Item
          key={item.value}
          value={item.value}
          className={cn(index < items.length - 1 && "border-b border-[var(--muted)]")}
        >
          <AccordionPrimitive.Header>
            <AccordionPrimitive.Trigger className="ds-focus flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-semibold transition hover:bg-[var(--secondary)]">
              <span>{item.trigger}</span>
              <ChevronDown className="h-4 w-4 text-[var(--muted-foreground)]" aria-hidden="true" />
            </AccordionPrimitive.Trigger>
          </AccordionPrimitive.Header>
          <AccordionPrimitive.Panel className="px-4 pb-4 text-sm leading-6 text-[var(--muted-foreground)]">
            {item.content}
          </AccordionPrimitive.Panel>
        </AccordionPrimitive.Item>
      ))}
    </AccordionPrimitive.Root>
  );
}
