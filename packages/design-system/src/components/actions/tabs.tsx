import type { ComponentProps, ReactNode } from "react";
import { useEffect, useRef, useState, useId } from "react";
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { renderActivePill } from "./shared";
import { cx } from "../../utils/cx";

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
  activationMode?: "automatic" | "manual";
  dir?: "ltr" | "rtl";
  onValueChange?: (value: string) => void;
}

export function Tabs({
  items,
  defaultValue,
  value,
  onValueChange,
  orientation = "horizontal",
  dir,
  activationMode = "automatic",
}: TabsProps) {
  const resolvedValue = defaultValue ?? items[0]?.value;
  const [internalValue, setInternalValue] = useState(resolvedValue);
  const [reservedPanelHeight, setReservedPanelHeight] = useState<number | null>(null);
  const currentValue = value ?? internalValue ?? resolvedValue;
  const groupId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
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

  function handleValueChange(nextValue: string) {
    const panelHeight = panelFrameRef.current?.getBoundingClientRect().height ?? 0;
    if (panelHeight > 0) {
      setReservedPanelHeight(Math.ceil(panelHeight));
    }
    scrollSnapshotRef.current = captureScrollSnapshot();

    if (value === undefined) {
      setInternalValue(nextValue);
    }
    onValueChange?.(nextValue);
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
      ref={rootRef}
      defaultValue={resolvedValue}
      value={currentValue}
      onValueChange={handleValueChange}
      orientation={orientation}
      className="space-y-4"
    >
      <LayoutGroup id={groupId}>
        <TabsPrimitive.List className="grid w-full min-w-0 max-w-full grid-cols-2 gap-2 rounded-tokenLg border border-muted bg-background p-2 md:inline-flex md:flex-wrap">
          {items.map((item) => {
            const active = item.value === currentValue;

            return (
              <TabsPrimitive.Tab
                key={item.value}
                value={item.value}
                className={(state) =>
                  cx(
                    "focus-ring relative inline-flex touch-target min-w-0 items-center justify-center gap-2 overflow-hidden rounded-tokenMd px-3 py-2 text-center text-sm font-semibold text-secondary transition md:flex-1 md:basis-0 md:px-4",
                    state.active && "text-accent",
                  )
                }
              >
                {active ? renderActivePill(groupId, "accent") : null}
                <span className="relative z-10 min-w-0 break-words">{item.label}</span>
                {item.badge ? (
                  <span className="relative z-10 rounded-full bg-background px-2 py-0.5 text-[0.7rem]">
                    {item.badge}
                  </span>
                ) : null}
              </TabsPrimitive.Tab>
            );
          })}
        </TabsPrimitive.List>
      </LayoutGroup>
      <div
        ref={panelFrameRef}
        className="[overflow-anchor:none]"
        style={reservedPanelHeight === null ? undefined : { minHeight: `${reservedPanelHeight}px` }}
      >
        <AnimatePresence initial={false} mode="wait">
          <motion.div
            key={currentValue}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18 }}
            onAnimationComplete={releaseReservedPanelHeight}
          >
            <TabsPrimitive.Panel value={currentValue} keepMounted className="focus-visible:outline-none">
              {items.find((item) => item.value === currentValue)?.content}
            </TabsPrimitive.Panel>
          </motion.div>
        </AnimatePresence>
      </div>
    </TabsPrimitive.Root>
  );
}
