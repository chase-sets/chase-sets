import {
  forwardRef,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ComponentProps,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion";
import { motion } from "motion/react";
import { Icon, type IconName } from "../../icons";
import { Stack } from "../../primitives/layout";
import { Text } from "../../primitives/typography";
import { useChaseMotion } from "../../theme/provider";
import { cx } from "../../utils/cx";
import { compactControlPaddingClasses, controlHeightClasses, controlPaddingClasses } from "../control-sizing";

const AnimatedAccordionContent = forwardRef<HTMLDivElement, ComponentProps<"div"> & { open: boolean }>(
  function AnimatedAccordionContent({ children, open, ...rest }, ref) {
    const motionSettings = useChaseMotion();

    return (
      <motion.div
        {...(rest as ComponentProps<typeof motion.div>)}
        ref={ref}
        initial={false}
        animate={
          motionSettings.reducedMotion ? undefined : open ? { height: "auto", opacity: 1 } : { height: 0, opacity: 0 }
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
  },
);

export interface AccordionItem {
  value: string;
  trigger: ReactNode;
  content: ReactNode;
  disabled?: boolean;
  triggerProps?: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "className" | "disabled"> &
    Record<`data-${string}`, string | number | boolean | undefined>;
}

export type AccordionSectionEdge = "card" | "compact" | "panel";

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
  disabled = false,
}: AccordionOptionTriggerProps) {
  return (
    <span className="grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-3">
      <span className="mt-0.5 flex h-5 items-start justify-center">
        <Icon name={icon} size="sm" tone={disabled ? "secondary" : active ? "accent" : "secondary"} />
      </span>
      <Stack element="span" gap={1} minWidth="0">
        <Text element="span" size="sm" weight="semibold" tone={active ? "accent" : "primary"}>
          {title}
        </Text>
        {description ? (
          <Text element="span" size="sm" tone="secondary">
            {description}
          </Text>
        ) : null}
      </Stack>
    </span>
  );
}

export interface AccordionProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "className" | "style" | "defaultValue" | "dir"
> {
  items: AccordionItem[];
  type?: "single" | "multiple";
  variant?: "surface" | "sectionList";
  edge?: AccordionSectionEdge;
  value?: string | string[];
  defaultValue?: string | string[];
  onValueChange?: (value: string | string[]) => void;
  collapsible?: boolean;
  anchorActiveItemToScrollEnd?: boolean;
}

function findScrollableParent(element: HTMLElement) {
  let current = element.parentElement;

  while (current) {
    const overflowY = window.getComputedStyle(current).overflowY;

    if (overflowY === "auto" || overflowY === "scroll") {
      return current;
    }

    current = current.parentElement;
  }

  return null;
}

export function Accordion({
  items,
  type = "single",
  variant = "surface",
  edge,
  value,
  defaultValue,
  onValueChange,
  collapsible = true,
  anchorActiveItemToScrollEnd = false,
  ...rest
}: AccordionProps) {
  const generatedId = useId();
  const accordionId = rest.id ?? generatedId;
  const activeItemRef = useRef<HTMLDivElement | null>(null);
  const motionSettings = useChaseMotion();
  const defaultOpenValues = Array.isArray(defaultValue) ? defaultValue : defaultValue ? [defaultValue] : [];
  const [uncontrolledOpenValues, setUncontrolledOpenValues] = useState<string[]>(defaultOpenValues);
  const controlledValue = value === undefined ? undefined : Array.isArray(value) ? value : value ? [value] : [];
  const rootProps =
    type === "multiple"
      ? {
          multiple: true,
          value: controlledValue,
          defaultValue: defaultOpenValues.length > 0 ? defaultOpenValues : undefined,
        }
      : {
          multiple: false,
          value: controlledValue,
          defaultValue: typeof defaultValue === "string" ? [defaultValue] : undefined,
        };
  const handleValueChange = (nextValue: string[]) => {
    if (!collapsible && nextValue.length === 0) {
      return;
    }

    if (value === undefined) {
      setUncontrolledOpenValues(nextValue);
    }

    onValueChange?.(type === "multiple" ? nextValue : (nextValue[0] ?? ""));
  };
  const openValues = value === undefined ? uncontrolledOpenValues : Array.isArray(value) ? value : [value];
  const isSectionList = variant === "sectionList";
  const edgeMode = edge;

  useLayoutEffect(() => {
    if (!isSectionList || !anchorActiveItemToScrollEnd || openValues.length === 0) {
      return;
    }

    const activeItem = activeItemRef.current;
    const scrollParent = activeItem ? findScrollableParent(activeItem) : null;

    if (!activeItem || !scrollParent) {
      return;
    }

    let frameId = 0;
    const startedAt = performance.now();
    const durationMs = motionSettings.reducedMotion ? 0 : Math.ceil(motionSettings.durations.base * 1000) + 80;

    const alignActiveItemBottom = () => {
      const activeRect = activeItem.getBoundingClientRect();
      const parentRect = scrollParent.getBoundingClientRect();
      const nextScrollTop = scrollParent.scrollTop + activeRect.bottom - parentRect.bottom;

      if (nextScrollTop > scrollParent.scrollTop) {
        scrollParent.scrollTop = nextScrollTop;
      }

      if (performance.now() - startedAt < durationMs) {
        frameId = window.requestAnimationFrame(alignActiveItemBottom);
      }
    };

    alignActiveItemBottom();

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [
    anchorActiveItemToScrollEnd,
    isSectionList,
    motionSettings.durations.base,
    motionSettings.reducedMotion,
    openValues,
  ]);

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
          edgeMode === "card" &&
          "-mx-4 w-[calc(100%+2rem)] max-w-none self-stretch first:-mt-4 first:rounded-t-tokenLg last:-mb-4 last:rounded-b-tokenLg",
        isSectionList &&
          edgeMode === "compact" &&
          "-mx-3 w-[calc(100%+1.5rem)] max-w-none self-stretch first:-mt-3 first:rounded-t-tokenLg last:-mb-3 last:rounded-b-tokenLg",
        isSectionList &&
          edgeMode === "panel" &&
          "-mx-5 w-[calc(100%+2.5rem)] max-w-none self-stretch first:-mt-5 first:rounded-t-tokenXl last:-mb-5 last:rounded-b-tokenXl",
      )}
    >
      {items.map((item, index) => {
        const isOpen = openValues.includes(item.value);
        const panelId = `${accordionId}-panel-${item.value}`;

        return (
          <AccordionPrimitive.Item
            key={item.value}
            value={item.value}
            disabled={item.disabled}
            ref={isOpen ? activeItemRef : undefined}
            className={cx(
              "border-muted",
              index < items.length - 1 && "border-b",
              isSectionList && "relative",
              isSectionList && edgeMode === "panel" && "overflow-hidden first:rounded-t-tokenXl last:rounded-b-tokenXl",
              isSectionList &&
                isOpen &&
                edgeMode !== "panel" &&
                "bg-accent-soft before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-accent",
              isSectionList &&
                isOpen &&
                edgeMode === "panel" &&
                "bg-accent-soft before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-accent",
            )}
          >
            <AccordionPrimitive.Header>
              <AccordionPrimitive.Trigger
                {...item.triggerProps}
                aria-controls={item.triggerProps?.["aria-controls"] ?? panelId}
                disabled={item.disabled}
                className={cx(
                  "focus-ring flex w-full items-center justify-between gap-3 text-left text-sm font-semibold text-foreground transition hover:bg-background",
                  controlHeightClasses.md,
                  isSectionList && edgeMode === "compact" && compactControlPaddingClasses.md,
                  isSectionList && edgeMode === "panel" && "px-5 py-[var(--control-md-py)]",
                  isSectionList && edgeMode !== "compact" && edgeMode !== "panel" && controlPaddingClasses.md,
                  !isSectionList && controlPaddingClasses.md,
                  isSectionList && isOpen && "text-accent hover:bg-transparent",
                  item.disabled && "cursor-not-allowed opacity-55 hover:bg-transparent",
                )}
              >
                <span className="flex-1">{item.trigger}</span>
                <span className={cx("inline-flex shrink-0 transition-transform duration-200", isOpen && "rotate-180")}>
                  <Icon name="chevronDown" size="sm" tone="secondary" />
                </span>
              </AccordionPrimitive.Trigger>
            </AccordionPrimitive.Header>
            <AccordionPrimitive.Panel
              id={panelId}
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
                  isSectionList && edgeMode === "compact" && "px-3 pb-5 pl-10 pt-1",
                  isSectionList && edgeMode === "panel" && "px-5 pb-5 pl-12 pt-1",
                  isSectionList && edgeMode !== "compact" && edgeMode !== "panel" && "px-4 pb-5 pl-11 pt-1",
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

export interface PanelSectionAccordionProps extends Omit<AccordionProps, "variant" | "edge"> {
  edge?: AccordionSectionEdge;
}

export function PanelSectionAccordion({
  edge = "card",
  anchorActiveItemToScrollEnd,
  ...props
}: PanelSectionAccordionProps) {
  return (
    <Accordion
      {...props}
      variant="sectionList"
      edge={edge}
      anchorActiveItemToScrollEnd={anchorActiveItemToScrollEnd ?? edge === "panel"}
    />
  );
}
