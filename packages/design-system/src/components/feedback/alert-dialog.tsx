import type { ReactNode } from "react";
import { motion } from "motion/react";
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import { Icon } from "../../icons";
import { useChaseMotion, usePortalRoots } from "../../theme/provider";
import { Button } from "../actions";
import { type Tone, toneIcon, useControllableOpen } from "./shared";
import { resolveOverlayMotion, resolveOverlayFade } from "./motion-overlay";

export interface AlertDialogProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  trigger?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "warning";
  onConfirm?: () => void;
}

export function AlertDialog({
  open,
  defaultOpen,
  onOpenChange,
  title,
  description,
  trigger,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "danger",
  onConfirm
}: AlertDialogProps) {
  const { overlayNode } = usePortalRoots();
  const motionSettings = useChaseMotion();
  const [resolvedOpen, setResolvedOpen] = useControllableOpen(open, defaultOpen, onOpenChange);
  const overlayFade = resolveOverlayFade(motionSettings, resolvedOpen);
  const contentMotion = resolveOverlayMotion(
    motionSettings,
    resolvedOpen,
    { opacity: 1, scale: 1, y: 0 },
    { opacity: 0, scale: 0.96, y: 14 },
    undefined,
    "base"
  );

  return (
    <AlertDialogPrimitive.Root
      open={resolvedOpen}
      onOpenChange={setResolvedOpen}
    >
      {trigger ? (
        <AlertDialogPrimitive.Trigger asChild>
          {trigger}
        </AlertDialogPrimitive.Trigger>
      ) : null}
      <AlertDialogPrimitive.Portal container={overlayNode ?? undefined}>
        <AlertDialogPrimitive.Overlay forceMount asChild>
          <motion.div
            initial={overlayFade.initial}
            animate={overlayFade.animate}
            transition={overlayFade.transition}
            className="fixed inset-0 z-modal bg-[rgba(29,27,24,0.35)]"
          />
        </AlertDialogPrimitive.Overlay>
        <AlertDialogPrimitive.Content forceMount asChild>
          <motion.div
            initial={contentMotion.initial}
            animate={contentMotion.animate}
            transition={contentMotion.transition}
            className="modern-surface fixed left-1/2 top-1/2 z-modal w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-tokenXl border border-muted p-5 shadow-overlay"
          >
          <div className="space-y-3">
            <div className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-background">
              <Icon name={toneIcon(tone)} size="sm" tone={tone} />
            </div>
            <AlertDialogPrimitive.Title className="font-heading text-xl font-semibold text-foreground">
              {title}
            </AlertDialogPrimitive.Title>
            {description ? (
              <AlertDialogPrimitive.Description className="text-sm text-secondary">
                {description}
              </AlertDialogPrimitive.Description>
            ) : null}
          </div>
          <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <AlertDialogPrimitive.Cancel asChild>
              <Button tone="secondary">{cancelLabel}</Button>
            </AlertDialogPrimitive.Cancel>
            <AlertDialogPrimitive.Action asChild>
              <Button tone={tone === "danger" ? "danger" : "primary"} onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </AlertDialogPrimitive.Action>
          </div>
          </motion.div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
