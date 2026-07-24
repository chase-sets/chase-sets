import { useEffect, useMemo, useState, type HTMLAttributes, type ReactNode } from "react";
import { IconButton, LinkButton } from "../actions/button";
import { Icon } from "../../icons";
import { FlexItem, IconRow, Inline, Show, Stack } from "../../primitives/layout";
import { Text } from "../../primitives/typography";
import { useReducedMotion } from "../../hooks";
import { cx } from "../../utils/cx";
import { type Tone, toneIcon, toneToIconTone } from "./shared";

export type PromoBarTone = Exclude<Tone, "neutral">;

export type PromoBarMessage = Readonly<{
  id: string;
  title: ReactNode;
  description?: ReactNode;
  href?: string | null;
  linkLabel?: ReactNode;
  tone?: PromoBarTone;
}>;

export interface PromoBarProps extends Omit<HTMLAttributes<HTMLElement>, "className" | "style" | "title"> {
  messages: readonly PromoBarMessage[];
  cycleIntervalMs?: number;
  ariaLabel?: string;
  previousLabel?: string;
  nextLabel?: string;
  pauseLabel?: string;
  resumeLabel?: string;
}

const toneClasses: Record<PromoBarTone, string> = {
  accent: "border-accent-soft bg-accent-soft text-foreground",
  info: "border-info-soft bg-info-soft text-foreground",
  success: "border-success-soft bg-success-soft text-foreground",
  warning: "border-warning-soft bg-warning-soft text-foreground",
  danger: "border-danger-soft bg-danger-soft text-foreground",
};

export function PromoBar({
  messages,
  cycleIntervalMs = 7000,
  ariaLabel = "Marketplace announcements",
  previousLabel = "Previous announcement",
  nextLabel = "Next announcement",
  pauseLabel = "Pause announcements",
  resumeLabel = "Resume announcements",
  ...rest
}: PromoBarProps) {
  const visibleMessages = useMemo(() => messages.filter((message) => message.title), [messages]);
  const reducedMotion = useReducedMotion();
  const [activeIndex, setActiveIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const hasMultipleMessages = visibleMessages.length > 1;
  const activeMessage = visibleMessages[activeIndex] ?? visibleMessages[0];
  const tone = activeMessage?.tone ?? "info";

  useEffect(() => {
    if (activeIndex >= visibleMessages.length) {
      setActiveIndex(0);
    }
  }, [activeIndex, visibleMessages.length]);

  useEffect(() => {
    if (!hasMultipleMessages || paused || reducedMotion || cycleIntervalMs <= 0) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setActiveIndex((current) => (current + 1) % visibleMessages.length);
    }, cycleIntervalMs);

    return () => window.clearInterval(timer);
  }, [cycleIntervalMs, hasMultipleMessages, paused, reducedMotion, visibleMessages.length]);

  if (!activeMessage) {
    return null;
  }

  function showPrevious() {
    setActiveIndex((current) => (current - 1 + visibleMessages.length) % visibleMessages.length);
  }

  function showNext() {
    setActiveIndex((current) => (current + 1) % visibleMessages.length);
  }

  return (
    <section
      {...rest}
      aria-label={ariaLabel}
      className={cx("rounded-tokenMd border px-3 py-2 md:px-4", toneClasses[tone])}
    >
      <Stack direction="row" align="center" justify="between" gap={3}>
        <FlexItem grow minWidth="0">
          <IconRow icon={<Icon name={toneIcon(tone)} size="sm" tone={toneToIconTone(tone)} />} align="center" gap={3}>
            <Stack gap={1} minWidth="0">
              <Text size="sm" weight="semibold" tone="inherit" truncate={{ base: true, md: false }}>
                {activeMessage.title}
              </Text>
              {activeMessage.description ? (
                <Show above="md">
                  <Text size="sm" tone="secondary" truncate={{ base: true, md: false }}>
                    {activeMessage.description}
                  </Text>
                </Show>
              ) : null}
            </Stack>
          </IconRow>
        </FlexItem>
        <Inline gap={2} align="center" wrap={false}>
          {activeMessage.href && activeMessage.linkLabel ? (
            <LinkButton href={activeMessage.href} tone="secondary" size="sm" trailingIcon="chevronRight">
              {activeMessage.linkLabel}
            </LinkButton>
          ) : null}
          {hasMultipleMessages ? (
            <Inline gap={1} align="center" wrap={false}>
              <IconButton label={previousLabel} icon="chevronLeft" size="sm" onClick={showPrevious} />
              <span className="min-w-10 text-center text-xs font-medium text-secondary" aria-live="polite">
                {activeIndex + 1}/{visibleMessages.length}
              </span>
              <IconButton label={nextLabel} icon="chevronRight" size="sm" onClick={showNext} />
              {reducedMotion ? null : (
                <IconButton
                  label={paused ? resumeLabel : pauseLabel}
                  icon={paused ? "play" : "pause"}
                  size="sm"
                  onClick={() => setPaused((current) => !current)}
                />
              )}
            </Inline>
          ) : null}
        </Inline>
      </Stack>
    </section>
  );
}
