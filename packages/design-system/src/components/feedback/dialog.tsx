import type { ReactNode } from "react";
import { motion } from "motion/react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useChaseMotion, usePortalRoots } from "../../theme/provider";
import { cx } from "../../utils/cx";
import { IconButton } from "../actions";
import { useControllableOpen } from "./shared";
import { resolveOverlayMotion, resolveOverlayFade } from "./motion-overlay";

function renderDialogFrame({
  open,
  title,
  description,
  children,
  footer,
  onDismiss,
  kind,
  reducedMotion,
  durations,
  easing,
  closeLabel = "Close"
}: {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  onDismiss?: () => void;
  kind: "dialog" | "drawer";
  reducedMotion: boolean;
  durations: { base: number; slow: number };
  easing: [number, number, number, number];
  closeLabel?: string;
}) {
  const frameAnimation =
    kind === "drawer"
      ? {
          initial: reducedMotion ? (false as const) : { opacity: 0, y: 24, x: 0 },
          animate: reducedMotion
            ? undefined
            : open
              ? { opacity: 1, y: 0, x: 0 }
              : { opacity: 0, y: 20, x: 12 },
          transition: reducedMotion
            ? undefined
            : { duration: durations.slow, ease: easing }
        }
      : {
          initial: reducedMotion ? (false as const) : { opacity: 0, scale: 0.96, y: 14 },
          animate: reducedMotion
            ? undefined
            : open
              ? { opacity: 1, scale: 1, y: 0 }
              : { opacity: 0, scale: 0.98, y: 10 },
          transition: reducedMotion
            ? undefined
            : { duration: durations.base, ease: easing }
        };

  const overlayAnimation = {
    initial: false as const,
    animate: reducedMotion
      ? undefined
      : open
        ? { opacity: 1 }
        : { opacity: 0 },
    transition: reducedMotion
      ? undefined
      : { duration: durations.base, ease: easing }
  };

  return (
    <>
      <DialogPrimitive.Overlay forceMount asChild>
        <motion.div
          initial={overlayAnimation.initial}
          animate={overlayAnimation.animate}
          transition={overlayAnimation.transition}
          className="fixed inset-0 z-modal bg-[rgba(29,27,24,0.35)]"
        />
      </DialogPrimitive.Overlay>
      <DialogPrimitive.Content
        forceMount
        asChild
      >
        <motion.div
          initial={frameAnimation.initial}
          animate={frameAnimation.animate}
          transition={frameAnimation.transition}
          className={cx(
            "modern-surface fixed z-modal flex max-h-[85vh] w-[calc(100vw-2rem)] flex-col rounded-tokenXl border border-muted p-5 shadow-overlay focus-visible:outline-none md:w-full md:max-w-2xl",
            kind === "dialog" && "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2",
            kind === "drawer" &&
              "inset-x-4 bottom-4 md:inset-y-4 md:right-4 md:left-auto md:w-[28rem]"
          )}
        >
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <DialogPrimitive.Title className="font-heading text-xl font-semibold text-foreground">
              {title}
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className={description ? "text-sm text-secondary" : "sr-only"}>
              {description ?? "Dialog content"}
            </DialogPrimitive.Description>
          </div>
          <DialogPrimitive.Close asChild>
            <IconButton
              label={closeLabel}
              icon="close"
              tone="ghost"
              onClick={onDismiss}
            />
          </DialogPrimitive.Close>
        </div>
        <div className="motion-safe-scroll-area mt-4 min-h-0 flex-1">
          {children}
        </div>
        {footer ? <div className="mt-4">{footer}</div> : null}
        </motion.div>
      </DialogPrimitive.Content>
    </>
  );
}

export interface DialogProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  trigger?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  closeLabel?: string;
}

export function Dialog({
  open,
  defaultOpen,
  onOpenChange,
  title,
  description,
  trigger,
  children,
  footer,
  closeLabel
}: DialogProps) {
  const { overlayNode } = usePortalRoots();
  const motionSettings = useChaseMotion();
  const [resolvedOpen, setResolvedOpen] = useControllableOpen(open, defaultOpen, onOpenChange);

  return (
    <DialogPrimitive.Root
      open={resolvedOpen}
      onOpenChange={setResolvedOpen}
    >
      {trigger ? <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger> : null}
      <DialogPrimitive.Portal container={overlayNode ?? undefined}>
        {renderDialogFrame({
          open: resolvedOpen,
          title,
          description,
          footer,
          kind: "dialog",
          children,
          reducedMotion: motionSettings.reducedMotion,
          durations: motionSettings.durations,
          easing: motionSettings.easing,
          closeLabel
        })}
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export interface DrawerProps extends DialogProps {}

export function Drawer({
  open,
  defaultOpen,
  onOpenChange,
  title,
  description,
  trigger,
  children,
  footer,
  closeLabel
}: DrawerProps) {
  const { overlayNode } = usePortalRoots();
  const motionSettings = useChaseMotion();
  const [resolvedOpen, setResolvedOpen] = useControllableOpen(open, defaultOpen, onOpenChange);

  return (
    <DialogPrimitive.Root
      open={resolvedOpen}
      onOpenChange={setResolvedOpen}
    >
      {trigger ? <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger> : null}
      <DialogPrimitive.Portal container={overlayNode ?? undefined}>
        {renderDialogFrame({
          open: resolvedOpen,
          title,
          description,
          footer,
          kind: "drawer",
          children,
          reducedMotion: motionSettings.reducedMotion,
          durations: motionSettings.durations,
          easing: motionSettings.easing,
          closeLabel
        })}
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
