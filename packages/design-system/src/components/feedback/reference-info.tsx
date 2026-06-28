import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { KeyValueList, type KeyValueItem } from "../data-display";
import { Stack } from "../../primitives/layout";
import { Text } from "../../primitives/typography";
import { Icon } from "../../icons";
import { cx } from "../../utils/cx";
import type { Tone } from "./shared";
import { Dialog, type DialogProps } from "./dialog";

type ReferenceInfoTriggerTone = Extract<Tone, "accent" | "neutral">;

type ReferenceInfoTriggerBaseProps = {
  children?: ReactNode;
  tone?: ReferenceInfoTriggerTone;
};

type ReferenceInfoAnchorTriggerProps = ReferenceInfoTriggerBaseProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "children" | "className" | "style"> & {
    href: string;
  };

type ReferenceInfoButtonTriggerProps = ReferenceInfoTriggerBaseProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "className" | "style" | "type"> & {
    href?: undefined;
  };

export type ReferenceInfoTriggerProps = ReferenceInfoAnchorTriggerProps | ReferenceInfoButtonTriggerProps;

function referenceInfoTriggerClassName(tone: NonNullable<ReferenceInfoTriggerBaseProps["tone"]>) {
  return cx(
    "focus-ring inline-flex items-center gap-2 rounded-tokenSm font-medium underline-offset-4",
    tone === "accent"
      ? "text-accent hover:text-foreground hover:underline"
      : "text-secondary hover:text-foreground hover:underline",
  );
}

export function ReferenceInfoTrigger(props: ReferenceInfoTriggerProps) {
  const { children, tone = "accent" } = props;
  const content = (
    <>
      <span>{children}</span>
      <Icon name="info" size="sm" />
    </>
  );

  if ("href" in props && typeof props.href === "string") {
    const { href, children: _children, tone: _tone, ...anchorProps } = props as ReferenceInfoAnchorTriggerProps;

    return (
      <a
        {...anchorProps}
        href={href}
        aria-haspopup={anchorProps["aria-haspopup"] ?? "dialog"}
        className={referenceInfoTriggerClassName(tone)}
      >
        {content}
      </a>
    );
  }

  const { children: _children, tone: _tone, ...buttonProps } = props as ReferenceInfoButtonTriggerProps;

  return (
    <button
      {...buttonProps}
      type="button"
      aria-haspopup={buttonProps["aria-haspopup"] ?? "dialog"}
      className={referenceInfoTriggerClassName(tone)}
    >
      {content}
    </button>
  );
}

export interface ReferenceInfoSection {
  title?: ReactNode;
  items?: KeyValueItem[];
  emptyState?: ReactNode;
  children?: ReactNode;
}

export interface ReferenceInfoDialogProps extends Omit<DialogProps, "children"> {
  summary?: ReactNode;
  sections?: ReferenceInfoSection[];
  children?: ReactNode;
}

export function ReferenceInfoDialog({
  summary,
  sections = [],
  children,
  bodyClassName,
  ...dialogProps
}: ReferenceInfoDialogProps) {
  return (
    <Dialog {...dialogProps} bodyClassName={cx("min-w-0", bodyClassName)}>
      <Stack gap={4}>
        {summary ? (
          <Text size="sm" tone="secondary">
            {summary}
          </Text>
        ) : null}
        {sections.map((section, index) => {
          const hasItems = Boolean(section.items?.length);

          return (
            <Stack key={index} gap={2}>
              {section.title ? <Text weight="semibold">{section.title}</Text> : null}
              {hasItems ? <KeyValueList density="compact" variant="plain" items={section.items ?? []} /> : null}
              {!hasItems && section.emptyState ? (
                <Text size="sm" tone="secondary">
                  {section.emptyState}
                </Text>
              ) : null}
              {section.children}
            </Stack>
          );
        })}
        {children}
      </Stack>
    </Dialog>
  );
}
