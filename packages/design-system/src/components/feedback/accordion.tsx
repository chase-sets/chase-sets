import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { motion } from "motion/react";
import * as AccordionPrimitive from "@radix-ui/react-accordion";
import { Icon } from "../../icons";
import { useChaseMotion } from "../../theme/provider";
import { cx } from "../../utils/cx";

const AnimatedAccordionContent = forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof motion.div> & { "data-state"?: "open" | "closed" }
>(function AnimatedAccordionContent({ children, ...rest }, ref) {
  const motionSettings = useChaseMotion();
  const isOpen = rest["data-state"] === "open";

  return (
    <motion.div
      {...rest}
      ref={ref}
      initial={false}
      animate={
        motionSettings.reducedMotion
          ? undefined
          : isOpen
            ? { height: "auto", opacity: 1 }
            : { height: 0, opacity: 0 }
      }
      transition={
        motionSettings.reducedMotion
          ? undefined
          : { duration: motionSettings.durations.base, ease: motionSettings.easing }
      }
    >
      {children}
    </motion.div>
  );
});

export interface AccordionItem {
  value: string;
  trigger: ReactNode;
  content: ReactNode;
}

export interface AccordionProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style" | "defaultValue" | "dir"> {
  items: AccordionItem[];
  type?: "single" | "multiple";
  defaultValue?: string | string[];
  collapsible?: boolean;
}

export function Accordion({
  items,
  type = "single",
  defaultValue,
  collapsible = true,
  ...rest
}: AccordionProps) {
  const rootProps =
    type === "multiple"
      ? {
          type: "multiple" as const,
          defaultValue: Array.isArray(defaultValue)
            ? defaultValue
            : defaultValue
              ? [defaultValue]
              : undefined
        }
      : {
          type: "single" as const,
          collapsible,
          defaultValue: typeof defaultValue === "string" ? defaultValue : undefined
        };

  return (
    <AccordionPrimitive.Root
      {...rootProps}
      {...rest}
      className="modern-surface rounded-tokenLg border border-muted shadow-tokenSm"
    >
      {items.map((item, index) => (
        <AccordionPrimitive.Item
          key={item.value}
          value={item.value}
          className={cx(
            "border-muted",
            index < items.length - 1 && "border-b"
          )}
        >
          <AccordionPrimitive.Header>
            <AccordionPrimitive.Trigger className="focus-ring flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-semibold text-foreground transition hover:bg-background [&[data-state=open]>span]:rotate-180">
              <span className="flex-1">{item.trigger}</span>
              <span className="inline-flex shrink-0 transition-transform duration-200">
                <Icon name="chevronDown" size="sm" tone="secondary" />
              </span>
            </AccordionPrimitive.Trigger>
          </AccordionPrimitive.Header>
          <AccordionPrimitive.Content forceMount asChild>
            <AnimatedAccordionContent className="overflow-hidden">
              <div className="px-4 pb-4 text-sm text-secondary">
              {item.content}
              </div>
            </AnimatedAccordionContent>
          </AccordionPrimitive.Content>
        </AccordionPrimitive.Item>
      ))}
    </AccordionPrimitive.Root>
  );
}
