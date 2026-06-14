import { forwardRef, type ComponentProps, type HTMLAttributes, type ReactNode } from "react";
import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion";
import { motion } from "motion/react";
import { Icon, type IconName } from "../../icons";
import { Stack } from "../../primitives/layout";
import { Heading, Text } from "../../primitives/typography";
import { useChaseMotion } from "../../theme/provider";
import { cx } from "../../utils/cx";
import { softToneClasses, type Tone, toneToIconTone } from "./shared";

const singleDisclosureValue = "content";

const AnimatedDisclosureContent = forwardRef<HTMLDivElement, ComponentProps<"div"> & { open: boolean }>(
  function AnimatedDisclosureContent({ children, open, ...rest }, ref) {
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

export type ProgressiveDisclosureTone = Extract<Tone, "neutral" | "accent" | "info" | "warning">;

export interface ProgressiveDisclosureProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "className" | "defaultValue" | "style" | "title"
> {
  title: ReactNode;
  description?: ReactNode;
  summary?: ReactNode;
  children?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  tone?: ProgressiveDisclosureTone;
  icon?: IconName;
}

export interface ProgressiveDisclosureItem {
  value: string;
  title: ReactNode;
  description?: ReactNode;
  summary?: ReactNode;
  content: ReactNode;
  tone?: ProgressiveDisclosureTone;
  icon?: IconName;
}

export interface ProgressiveDisclosureGroupProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "className" | "defaultValue" | "style" | "title"
> {
  title?: ReactNode;
  description?: ReactNode;
  items: ProgressiveDisclosureItem[];
  defaultValue?: string[];
  value?: string[];
  onValueChange?: (value: string[]) => void;
  multiple?: boolean;
}

function DisclosureTriggerContent({
  title,
  description,
  summary,
  tone = "neutral",
  icon,
}: {
  title: ReactNode;
  description?: ReactNode;
  summary?: ReactNode;
  tone?: ProgressiveDisclosureTone;
  icon?: IconName;
}) {
  return (
    <span className="flex min-w-0 flex-1 items-start gap-3">
      {icon ? (
        <span className={cx("mt-0.5 rounded-tokenSm border p-1.5", softToneClasses[tone])}>
          <Icon name={icon} size="sm" tone={toneToIconTone(tone)} />
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <Stack element="span" gap={1}>
          <Text element="span" size="sm" weight="semibold">
            {title}
          </Text>
          {description ? (
            <Text element="span" size="xs" tone="secondary">
              {description}
            </Text>
          ) : null}
          {summary ? (
            <Text element="span" size="xs" weight="medium" tone="tertiary">
              {summary}
            </Text>
          ) : null}
        </Stack>
      </span>
    </span>
  );
}

function DisclosureItem({
  value,
  title,
  description,
  summary,
  content,
  tone,
  icon,
  last,
}: ProgressiveDisclosureItem & { last: boolean }) {
  return (
    <AccordionPrimitive.Item value={value} className={cx("border-muted", !last && "border-b")}>
      <AccordionPrimitive.Header>
        <AccordionPrimitive.Trigger className="focus-ring group flex w-full items-start justify-between gap-3 px-4 py-3 text-left transition hover:bg-background">
          <DisclosureTriggerContent title={title} description={description} summary={summary} tone={tone} icon={icon} />
          <span className="mt-0.5 inline-flex shrink-0 transition-transform duration-200 group-data-[panel-open]:rotate-180">
            <Icon name="chevronDown" size="sm" tone="secondary" />
          </span>
        </AccordionPrimitive.Trigger>
      </AccordionPrimitive.Header>
      <AccordionPrimitive.Panel
        keepMounted
        render={(props, state) => (
          <AnimatedDisclosureContent {...props} open={state.open} className={cx("overflow-hidden", props.className)} />
        )}
      >
        <div className="px-4 pb-4 text-sm leading-6 text-secondary">{content}</div>
      </AccordionPrimitive.Panel>
    </AccordionPrimitive.Item>
  );
}

export function ProgressiveDisclosure({
  title,
  description,
  summary,
  children,
  defaultOpen = false,
  open,
  onOpenChange,
  tone = "neutral",
  icon,
  ...rest
}: ProgressiveDisclosureProps) {
  const value = open === undefined ? undefined : open ? [singleDisclosureValue] : [];
  const defaultValue = open === undefined && defaultOpen ? [singleDisclosureValue] : undefined;

  return (
    <AccordionPrimitive.Root<string>
      {...rest}
      value={value}
      defaultValue={defaultValue}
      onValueChange={(nextValue) => onOpenChange?.(nextValue.includes(singleDisclosureValue))}
      className="modern-surface overflow-hidden rounded-tokenLg border border-muted shadow-tokenSm"
    >
      <DisclosureItem
        value={singleDisclosureValue}
        title={title}
        description={description}
        summary={summary}
        content={children}
        tone={tone}
        icon={icon}
        last
      />
    </AccordionPrimitive.Root>
  );
}

export function ProgressiveDisclosureGroup({
  title,
  description,
  items,
  defaultValue,
  value,
  onValueChange,
  multiple = true,
  ...rest
}: ProgressiveDisclosureGroupProps) {
  return (
    <Stack {...rest} element="section" gap={3}>
      {title || description ? (
        <Stack gap={1}>
          {title ? (
            <Heading level={3} visualSize={5}>
              {title}
            </Heading>
          ) : null}
          {description ? (
            <Text size="sm" tone="secondary">
              {description}
            </Text>
          ) : null}
        </Stack>
      ) : null}
      <AccordionPrimitive.Root<string>
        multiple={multiple}
        value={value}
        defaultValue={defaultValue}
        onValueChange={(nextValue) => onValueChange?.(nextValue)}
        className="modern-surface overflow-hidden rounded-tokenLg border border-muted shadow-tokenSm"
      >
        {items.map((item, index) => (
          <DisclosureItem key={item.value} {...item} last={index === items.length - 1} />
        ))}
      </AccordionPrimitive.Root>
    </Stack>
  );
}
