import { forwardRef, type ComponentProps, type HTMLAttributes, type ReactNode } from "react";
import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion";
import { motion } from "motion/react";
import { Icon } from "../../icons";
import { useChaseMotion } from "../../theme/provider";
import { cx } from "../../utils/cx";

const AnimatedAccordionContent = forwardRef<
  HTMLDivElement,
  ComponentProps<"div"> & { open: boolean }
>(function AnimatedAccordionContent({ children, open, ...rest }, ref) {
  const motionSettings = useChaseMotion();

  return (
    <motion.div
      {...(rest as ComponentProps<typeof motion.div>)}
      ref={ref}
      initial={false}
      animate={
        motionSettings.reducedMotion
          ? undefined
          : open
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
  value?: string | string[];
  defaultValue?: string | string[];
  onValueChange?: (value: string | string[]) => void;
  collapsible?: boolean;
}

export function Accordion({
  items,
  type = "single",
  value,
  defaultValue,
  onValueChange,
  collapsible = true,
  ...rest
}: AccordionProps) {
  const controlledValue =
    value === undefined
      ? undefined
      : Array.isArray(value)
        ? value
        : [value];
  const rootProps =
    type === "multiple"
      ? {
          multiple: true,
          value: controlledValue,
          defaultValue: Array.isArray(defaultValue)
            ? defaultValue
            : defaultValue
              ? [defaultValue]
              : undefined
        }
      : {
          multiple: false,
          value: controlledValue,
          defaultValue: typeof defaultValue === "string" ? [defaultValue] : undefined
        };
  const handleValueChange = (nextValue: string[]) => {
    if (!collapsible && nextValue.length === 0) {
      return;
    }

    onValueChange?.(type === "multiple" ? nextValue : nextValue[0] ?? "");
  };

  return (
    <AccordionPrimitive.Root
      {...rootProps}
      {...rest}
      onValueChange={handleValueChange}
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
            <AccordionPrimitive.Trigger className="focus-ring flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-semibold text-foreground transition hover:bg-background">
              <span className="flex-1">{item.trigger}</span>
              <span className="inline-flex shrink-0 transition-transform duration-200">
                <Icon name="chevronDown" size="sm" tone="secondary" />
              </span>
            </AccordionPrimitive.Trigger>
          </AccordionPrimitive.Header>
          <AccordionPrimitive.Panel
            keepMounted
            render={(props, state) => (
              <AnimatedAccordionContent {...props} open={state.open} className={cx("overflow-hidden", props.className)} />
            )}
          >
              <div className="px-4 pb-4 text-sm text-secondary">
              {item.content}
              </div>
          </AccordionPrimitive.Panel>
        </AccordionPrimitive.Item>
      ))}
    </AccordionPrimitive.Root>
  );
}
