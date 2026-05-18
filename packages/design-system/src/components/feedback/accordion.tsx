import { forwardRef, useState, type ComponentProps, type HTMLAttributes, type ReactNode } from "react";
import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion";
import { motion } from "motion/react";
import { Icon, type IconName } from "../../icons";
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

export interface AccordionOptionTriggerProps {
  icon: IconName;
  title: ReactNode;
  description?: ReactNode;
  active?: boolean;
  disabled?: boolean;
}

export function AccordionOptionTrigger({
  icon,
  title,
  description,
  active = false,
  disabled = false
}: AccordionOptionTriggerProps) {
  return (
    <span className="grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-3">
      <span className="mt-0.5 flex h-5 items-start justify-center">
        <Icon
          name={icon}
          size="sm"
          tone={disabled ? "secondary" : active ? "accent" : "secondary"}
        />
      </span>
      <span className="grid min-w-0 gap-1">
        <span className={cx("text-sm font-semibold", active ? "text-accent" : "text-foreground")}>
          {title}
        </span>
        {description ? (
          <span className="text-sm font-normal leading-6 text-secondary">{description}</span>
        ) : null}
      </span>
    </span>
  );
}

export interface AccordionProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style" | "defaultValue" | "dir"> {
  items: AccordionItem[];
  type?: "single" | "multiple";
  variant?: "surface" | "sectionList";
  bleed?: boolean | "card" | "compact" | "sheet";
  value?: string | string[];
  defaultValue?: string | string[];
  onValueChange?: (value: string | string[]) => void;
  collapsible?: boolean;
}

export function Accordion({
  items,
  type = "single",
  variant = "surface",
  bleed = false,
  value,
  defaultValue,
  onValueChange,
  collapsible = true,
  ...rest
}: AccordionProps) {
  const defaultOpenValues = Array.isArray(defaultValue)
    ? defaultValue
    : defaultValue
      ? [defaultValue]
      : [];
  const [uncontrolledOpenValues, setUncontrolledOpenValues] =
    useState<string[]>(defaultOpenValues);
  const controlledValue =
    value === undefined
      ? undefined
      : Array.isArray(value)
        ? value
        : value
          ? [value]
          : [];
  const rootProps =
    type === "multiple"
      ? {
          multiple: true,
          value: controlledValue,
          defaultValue: defaultOpenValues.length > 0 ? defaultOpenValues : undefined
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

    if (value === undefined) {
      setUncontrolledOpenValues(nextValue);
    }

    onValueChange?.(type === "multiple" ? nextValue : nextValue[0] ?? "");
  };
  const openValues =
    value === undefined
      ? uncontrolledOpenValues
      : Array.isArray(value)
        ? value
        : [value];
  const isSectionList = variant === "sectionList";
  const bleedMode = bleed === true ? "card" : bleed;

  return (
    <AccordionPrimitive.Root
      {...rootProps}
      {...rest}
      onValueChange={handleValueChange}
      className={cx(
        isSectionList
          ? "relative overflow-hidden"
          : "modern-surface rounded-tokenLg border border-muted shadow-tokenSm",
        isSectionList &&
          bleedMode === "card" &&
          "-mx-4 first:-mt-4 first:rounded-t-tokenLg last:-mb-4 last:rounded-b-tokenLg",
        isSectionList &&
          bleedMode === "compact" &&
          "-mx-3 first:-mt-3 first:rounded-t-tokenLg last:-mb-3 last:rounded-b-tokenLg",
        isSectionList &&
          bleedMode === "sheet" &&
          "-mx-5 first:-mt-5 first:rounded-t-tokenXl last:-mb-5 last:rounded-b-tokenXl",
      )}
    >
      {items.map((item, index) => {
        const isOpen = openValues.includes(item.value);

        return (
          <AccordionPrimitive.Item
            key={item.value}
            value={item.value}
            className={cx(
              "border-muted",
              index < items.length - 1 && "border-b",
              isSectionList && "relative",
              isSectionList &&
                isOpen &&
                "bg-accent/5 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-accent",
            )}
          >
            <AccordionPrimitive.Header>
              <AccordionPrimitive.Trigger
                className={cx(
                  "focus-ring flex w-full items-center justify-between gap-3 text-left text-sm font-semibold text-foreground transition hover:bg-background",
                  isSectionList && bleedMode === "compact" && "px-3 py-2.5",
                  isSectionList && bleedMode === "sheet" && "px-5 py-2.5",
                  isSectionList &&
                    bleedMode !== "compact" &&
                    bleedMode !== "sheet" &&
                    "px-4 py-2.5",
                  !isSectionList && "px-4 py-3",
                  isSectionList && isOpen && "text-accent hover:bg-transparent",
                )}
              >
                <span className="flex-1">{item.trigger}</span>
                <span
                  className={cx(
                    "inline-flex shrink-0 transition-transform duration-200",
                    isOpen && "rotate-180",
                  )}
                >
                  <Icon name="chevronDown" size="sm" tone="secondary" />
                </span>
              </AccordionPrimitive.Trigger>
            </AccordionPrimitive.Header>
            <AccordionPrimitive.Panel
              keepMounted
              render={(props, state) => (
                <AnimatedAccordionContent
                  {...props}
                  open={state.open}
                  className={cx("overflow-hidden", props.className)}
                />
              )}
            >
              <div
                className={cx(
                  "text-sm text-secondary",
                  isSectionList && bleedMode === "compact" && "px-3 pb-5 pl-10 pt-1",
                  isSectionList && bleedMode === "sheet" && "px-5 pb-5 pl-12 pt-1",
                  isSectionList &&
                    bleedMode !== "compact" &&
                    bleedMode !== "sheet" &&
                    "px-4 pb-5 pl-11 pt-1",
                  !isSectionList && "px-4 pb-4",
                )}
              >
                {item.content}
              </div>
            </AccordionPrimitive.Panel>
          </AccordionPrimitive.Item>
        );
      })}
    </AccordionPrimitive.Root>
  );
}
