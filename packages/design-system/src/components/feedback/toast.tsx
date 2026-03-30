import { createPortal } from "react-dom";
import { useState, type ReactNode } from "react";
import { motion } from "motion/react";
import * as ToastPrimitive from "@radix-ui/react-toast";
import { Icon } from "../../icons";
import { useChaseMotion, usePortalRoots } from "../../theme/provider";
import { IconButton } from "../actions";
import { type Tone, toneIcon } from "./shared";
import { resolveOverlayMotion } from "./motion-overlay";

export interface ToastItem {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  tone?: Exclude<Tone, "neutral">;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  dismissLabel?: string;
}

export interface ToastRegionProps {
  items: ToastItem[];
}

function ToastRegionItem({ item }: { item: ToastItem }) {
  const motionSettings = useChaseMotion();
  const [internalOpen, setInternalOpen] = useState(item.open ?? true);
  const resolvedOpen = item.open ?? internalOpen;
  const motionProps = resolveOverlayMotion(
    motionSettings,
    resolvedOpen,
    { opacity: 1, y: 0, scale: 1 },
    { opacity: 0, y: 16, scale: 0.98 },
    undefined,
    "base"
  );

  function handleOpenChange(nextOpen: boolean) {
    if (item.open === undefined) {
      setInternalOpen(nextOpen);
    }
    item.onOpenChange?.(nextOpen);
  }

  return (
    <ToastPrimitive.Root
      forceMount
      open={resolvedOpen}
      onOpenChange={handleOpenChange}
      className="modern-surface rounded-tokenLg border border-muted shadow-overlay"
    >
      {resolvedOpen ? (
        <motion.div
          layout
          initial={motionProps.initial}
          animate={motionProps.animate}
          transition={motionProps.transition}
          className="grid grid-cols-[auto_1fr_auto] items-start gap-3 p-4"
        >
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-background">
            <Icon
              name={toneIcon(item.tone ?? "info")}
              size="sm"
              tone={item.tone ?? "info"}
            />
          </div>
          <div className="min-w-0 space-y-1">
            <ToastPrimitive.Title className="text-sm font-semibold text-foreground">
              {item.title}
            </ToastPrimitive.Title>
            {item.description ? (
              <ToastPrimitive.Description className="text-sm text-secondary">
                {item.description}
              </ToastPrimitive.Description>
            ) : null}
          </div>
          <div className="self-start">
            <ToastPrimitive.Close asChild>
              <IconButton
                label={item.dismissLabel ?? "Dismiss notification"}
                icon="close"
                tone="ghost"
                size="sm"
              />
            </ToastPrimitive.Close>
          </div>
        </motion.div>
      ) : null}
    </ToastPrimitive.Root>
  );
}

export function ToastRegion({
  items
}: ToastRegionProps) {
  const { toastNode } = usePortalRoots();

  const viewport = (
    <ToastPrimitive.Viewport className="fixed inset-x-0 bottom-0 z-toast mx-auto flex w-full max-w-md flex-col gap-3 p-4 outline-none" />
  );

  return (
    <ToastPrimitive.Provider duration={4000} swipeDirection="right">
      {items.map((item) => <ToastRegionItem key={item.id} item={item} />)}
      {toastNode ? createPortal(viewport, toastNode) : viewport}
    </ToastPrimitive.Provider>
  );
}
