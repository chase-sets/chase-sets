import { useEffect, useMemo, useState, type HTMLAttributes, type ReactNode } from "react";
import { IconButton, LinkButton } from "../actions/button";
import { Icon } from "../../icons";
import { cx } from "../../utils/cx";

export type PromoBarTone = "info" | "success" | "warning";

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
  info: "border-info-soft bg-info-soft text-foreground",
  success: "border-success-soft bg-success-soft text-foreground",
  warning: "border-warning-soft bg-warning-soft text-foreground",
};

const iconTone: Record<PromoBarTone, "info" | "success" | "warning"> = {
  info: "info",
  success: "success",
  warning: "warning",
};

function usePrefersReducedMotion() {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }

    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(query.matches);
    const handleChange = () => setReducedMotion(query.matches);
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  return reducedMotion;
}

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
  const reducedMotion = usePrefersReducedMotion();
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
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <Icon name="spark" size="sm" tone={iconTone[tone]} />
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-5">{activeMessage.title}</p>
            {activeMessage.description ? (
              <p className="text-sm leading-5 text-secondary">{activeMessage.description}</p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {activeMessage.href && activeMessage.linkLabel ? (
            <LinkButton href={activeMessage.href} tone="secondary" size="sm" trailingIcon="chevronRight">
              {activeMessage.linkLabel}
            </LinkButton>
          ) : null}
          {hasMultipleMessages ? (
            <div className="flex items-center gap-1">
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
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
