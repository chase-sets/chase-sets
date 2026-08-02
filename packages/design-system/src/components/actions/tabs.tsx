import type { ComponentProps, ReactNode } from "react";
import { useEffect, useRef, useState, useId } from "react";
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { motion } from "motion/react";
import { useChaseMotion } from "../../theme/provider";
import { renderActivePill, renderActivePillGroup } from "./shared";
import { cx } from "../../utils/cx";
import { useControllableValue } from "../controllable";
import { controlHeightClasses, controlPaddingClasses, controlTextClasses } from "../control-sizing";

export interface TabItem {
  value: string;
  label: ReactNode;
  content: ReactNode;
  badge?: string;
}

export interface TabsProps extends Omit<
  ComponentProps<typeof TabsPrimitive.Root>,
  "children" | "className" | "style" | "onValueChange"
> {
  items: TabItem[];
  dir?: "ltr" | "rtl";
  mobileLayout?: "scrollable-row";
  onValueChange?: (value: string) => void;
}

export function Tabs({
  items,
  defaultValue,
  value,
  onValueChange,
  orientation = "horizontal",
  dir,
  mobileLayout,
  ...rootProps
}: TabsProps) {
  const resolvedValue = defaultValue ?? items[0]?.value;
  const [currentValue, setCurrentValue] = useControllableValue(value, resolvedValue, onValueChange);
  const [reservedPanelHeight, setReservedPanelHeight] = useState<number | null>(null);
  const groupId = useId();
  const motionSettings = useChaseMotion();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef(new Map<string, HTMLElement>());
  const panelFrameRef = useRef<HTMLDivElement | null>(null);
  const scrollSnapshotRef = useRef<{ top: number } | null>(null);

  function captureScrollSnapshot() {
    if (typeof window === "undefined") {
      return null;
    }

    const root = rootRef.current;

    return root ? { top: root.getBoundingClientRect().top } : null;
  }

  function restoreScrollSnapshot(snapshot: { top: number } | null) {
    if (typeof window === "undefined" || !snapshot) {
      return;
    }

    window.requestAnimationFrame(() => {
      const root = rootRef.current;
      if (!root) {
        return;
      }

      const nextTop = root.getBoundingClientRect().top;
      const delta = nextTop - snapshot.top;

      if (Math.abs(delta) > 1) {
        window.scrollBy(0, delta);
      }
    });
  }

  useEffect(() => {
    const snapshot = scrollSnapshotRef.current;

    if (snapshot) {
      scrollSnapshotRef.current = null;
      restoreScrollSnapshot(snapshot);
    }
  }, [currentValue]);

  useEffect(() => {
    if (mobileLayout !== "scrollable-row") {
      return;
    }

    const list = listRef.current;
    const activeTab = currentValue ? tabRefs.current.get(currentValue) : null;
    if (!list || !activeTab) {
      return;
    }

    const listBounds = list.getBoundingClientRect();
    const tabBounds = activeTab.getBoundingClientRect();
    let overflow = 0;
    if (tabBounds.left < listBounds.left) {
      overflow = tabBounds.left - listBounds.left;
    } else if (tabBounds.right > listBounds.right) {
      overflow = tabBounds.right - listBounds.right;
    }

    if (Math.abs(overflow) > 1 && typeof list.scrollBy === "function") {
      list.scrollBy({ left: overflow, behavior: motionSettings.reducedMotion ? "auto" : "smooth" });
    }
  }, [currentValue, mobileLayout, motionSettings.reducedMotion]);

  function handleValueChange(nextValue: string) {
    const panelHeight = panelFrameRef.current?.getBoundingClientRect().height ?? 0;
    if (!motionSettings.reducedMotion && panelHeight > 0) {
      setReservedPanelHeight(Math.ceil(panelHeight));
    }
    scrollSnapshotRef.current = captureScrollSnapshot();

    setCurrentValue(nextValue);
  }

  function releaseReservedPanelHeight() {
    if (reservedPanelHeight === null) {
      return;
    }

    const snapshot = captureScrollSnapshot();
    setReservedPanelHeight(null);
    restoreScrollSnapshot(snapshot);
  }

  return (
    <TabsPrimitive.Root
      {...rootProps}
      ref={rootRef}
      defaultValue={resolvedValue}
      value={currentValue}
      onValueChange={handleValueChange}
      orientation={orientation}
      dir={dir}
      className="space-y-4"
    >
      {renderActivePillGroup(
        groupId,
        motionSettings.reducedMotion,
        <TabsPrimitive.List
          ref={listRef}
          data-mobile-layout={mobileLayout}
          className={
            mobileLayout === "scrollable-row"
              ? "flex w-full min-w-0 max-w-full flex-nowrap gap-2 overflow-x-auto overscroll-x-contain rounded-tokenLg border border-muted bg-background p-2 md:inline-flex md:flex-wrap md:overflow-visible"
              : "grid w-full min-w-0 max-w-full grid-cols-2 gap-2 rounded-tokenLg border border-muted bg-background p-2 md:inline-flex md:flex-wrap"
          }
        >
          {items.map((item) => {
            const active = item.value === currentValue;

            return (
              <TabsPrimitive.Tab
                key={item.value}
                value={item.value}
                ref={(node) => {
                  if (node) {
                    tabRefs.current.set(item.value, node);
                  } else {
                    tabRefs.current.delete(item.value);
                  }
                }}
                className={(state) =>
                  cx(
                    "focus-ring relative inline-flex min-w-0 items-center justify-center gap-2 overflow-hidden rounded-tokenMd text-center font-semibold text-secondary transition md:flex-1 md:basis-0",
                    mobileLayout === "scrollable-row" && "shrink-0 whitespace-nowrap md:shrink md:whitespace-normal",
                    controlHeightClasses.md,
                    controlPaddingClasses.md,
                    controlTextClasses.md,
                    state.active && "text-accent",
                  )
                }
              >
                {active ? renderActivePill(groupId, "accent", motionSettings.reducedMotion) : null}
                <span className="relative z-10 min-w-0 break-words">{item.label}</span>
                {item.badge ? (
                  <span className="relative z-10 rounded-tokenFull bg-background px-2 py-0.5 text-2xs">
                    {item.badge}
                  </span>
                ) : null}
              </TabsPrimitive.Tab>
            );
          })}
        </TabsPrimitive.List>,
      )}
      <div
        ref={panelFrameRef}
        className="[overflow-anchor:none]"
        style={reservedPanelHeight === null ? undefined : { minHeight: `${reservedPanelHeight}px` }}
      >
        <motion.div
          key={currentValue}
          initial={motionSettings.reducedMotion ? false : { opacity: 0, y: 10 }}
          animate={motionSettings.reducedMotion ? undefined : { opacity: 1, y: 0 }}
          transition={motionSettings.reducedMotion ? undefined : { duration: 0.18 }}
          onAnimationComplete={releaseReservedPanelHeight}
        >
          <TabsPrimitive.Panel value={currentValue} keepMounted className="focus-visible:outline-none">
            {items.find((item) => item.value === currentValue)?.content}
          </TabsPrimitive.Panel>
        </motion.div>
      </div>
    </TabsPrimitive.Root>
  );
}
