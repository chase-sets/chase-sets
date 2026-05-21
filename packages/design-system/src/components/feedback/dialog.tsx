import type { ReactNode } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useChaseMotion, usePortalRoots } from "../../theme/provider";
import { cx } from "../../utils/cx";
import { renderButtonTrigger, renderMotionDiv } from "../../utils/base-ui";
import { IconButton } from "../actions";
import { useControllableOpen } from "./shared";

function renderDialogFrame({
  open,
  title,
  description,
  children,
  footer,
  onDismiss,
  kind,
  panelPlacement = "side",
  surfaceClassName,
  bodyClassName,
  bodyLayout = "default",
  reducedMotion,
  durations,
  easing,
  closeLabel = "Close",
}: {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  onDismiss?: () => void;
  kind: "dialog" | "panel";
  panelPlacement?: ModalPanelPlacement;
  surfaceClassName?: string;
  bodyClassName?: string;
  bodyLayout?: PanelBodyLayout;
  reducedMotion: boolean;
  durations: { base: number; slow: number };
  easing: [number, number, number, number];
  closeLabel?: string;
}) {
  const frameAnimation =
    kind === "panel"
      ? {
          initial: reducedMotion ? (false as const) : { opacity: 0, y: 24, x: 0 },
          animate: reducedMotion ? undefined : open ? { opacity: 1, y: 0, x: 0 } : { opacity: 0, y: 20, x: 12 },
          transition: reducedMotion ? undefined : { duration: durations.slow, ease: easing },
        }
      : {
          initial: reducedMotion ? (false as const) : { opacity: 0, scale: 0.96, y: 14 },
          animate: reducedMotion
            ? undefined
            : open
              ? { opacity: 1, scale: 1, y: 0 }
              : { opacity: 0, scale: 0.98, y: 10 },
          transition: reducedMotion ? undefined : { duration: durations.base, ease: easing },
        };

  const overlayAnimation = {
    initial: false as const,
    animate: reducedMotion ? undefined : open ? { opacity: 1 } : { opacity: 0 },
    transition: reducedMotion ? undefined : { duration: durations.base, ease: easing },
  };

  return (
    <>
      <DialogPrimitive.Backdrop
        render={renderMotionDiv({
          initial: overlayAnimation.initial,
          animate: overlayAnimation.animate,
          transition: overlayAnimation.transition,
          className: "fixed inset-0 z-modal bg-[rgba(29,27,24,0.35)]",
        })}
      />
      <DialogPrimitive.Popup
        render={renderMotionDiv({
          initial: frameAnimation.initial,
          animate: frameAnimation.animate,
          transition: frameAnimation.transition,
          className: (baseClassName) =>
            cx(
              "modern-surface fixed z-modal flex max-h-[85vh] w-[calc(100vw-2rem)] flex-col rounded-tokenXl border border-muted p-5 shadow-overlay focus-visible:outline-none [--panel-content-inset:1.25rem] md:w-full md:max-w-2xl",
              kind === "dialog" && "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2",
              kind === "panel" &&
                panelPlacement === "side" &&
                "inset-x-4 bottom-4 md:inset-y-4 md:right-4 md:left-auto md:w-[28rem]",
              kind === "panel" &&
                panelPlacement === "sideLeft" &&
                "inset-x-4 bottom-4 md:inset-y-4 md:left-4 md:right-auto md:w-[28rem]",
              kind === "panel" &&
                panelPlacement === "bottomSheet" &&
                "inset-x-3 bottom-3 w-auto max-h-[88vh] rounded-tokenXl md:inset-x-6 md:bottom-6 lg:hidden",
              surfaceClassName,
              baseClassName,
            ),
        })}
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
          <DialogPrimitive.Close
            render={<IconButton label={closeLabel} icon="close" tone="ghost" onClick={onDismiss} />}
          />
        </div>
        <div
          className={cx(
            "motion-safe-scroll-area mt-4 min-h-0 flex-1",
            bodyLayout === "edge" && "panel-edge-scroll-area",
            bodyClassName,
          )}
        >
          {children}
        </div>
        {footer ? <div className="mt-4">{footer}</div> : null}
      </DialogPrimitive.Popup>
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
  surfaceClassName?: string;
  bodyClassName?: string;
  bodyLayout?: PanelBodyLayout;
}

export type PanelBodyLayout = "default" | "edge";

export function Dialog({
  open,
  defaultOpen,
  onOpenChange,
  title,
  description,
  trigger,
  children,
  footer,
  closeLabel,
  surfaceClassName,
  bodyClassName,
  bodyLayout,
}: DialogProps) {
  const { overlayNode } = usePortalRoots();
  const motionSettings = useChaseMotion();
  const [resolvedOpen, setResolvedOpen] = useControllableOpen(open, defaultOpen, onOpenChange);

  return (
    <DialogPrimitive.Root open={resolvedOpen} onOpenChange={setResolvedOpen}>
      {trigger ? <DialogPrimitive.Trigger render={renderButtonTrigger(trigger)} /> : null}
      <DialogPrimitive.Portal container={overlayNode ?? undefined}>
        {renderDialogFrame({
          open: resolvedOpen,
          title,
          description,
          footer,
          kind: "dialog",
          children,
          surfaceClassName,
          bodyClassName,
          bodyLayout,
          reducedMotion: motionSettings.reducedMotion,
          durations: motionSettings.durations,
          easing: motionSettings.easing,
          closeLabel,
        })}
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export type ModalPanelPlacement = "side" | "sideLeft" | "bottomSheet";

export interface ModalPanelProps extends DialogProps {
  placement?: ModalPanelPlacement;
}

export function ModalPanel({
  open,
  defaultOpen,
  onOpenChange,
  title,
  description,
  trigger,
  children,
  footer,
  closeLabel,
  surfaceClassName,
  bodyClassName,
  bodyLayout,
  placement = "side",
}: ModalPanelProps) {
  const { overlayNode } = usePortalRoots();
  const motionSettings = useChaseMotion();
  const [resolvedOpen, setResolvedOpen] = useControllableOpen(open, defaultOpen, onOpenChange);

  return (
    <DialogPrimitive.Root open={resolvedOpen} onOpenChange={setResolvedOpen}>
      {trigger ? <DialogPrimitive.Trigger render={renderButtonTrigger(trigger)} /> : null}
      <DialogPrimitive.Portal container={overlayNode ?? undefined}>
        {renderDialogFrame({
          open: resolvedOpen,
          title,
          description,
          footer,
          kind: "panel",
          panelPlacement: placement,
          children,
          surfaceClassName,
          bodyClassName,
          bodyLayout,
          reducedMotion: motionSettings.reducedMotion,
          durations: motionSettings.durations,
          easing: motionSettings.easing,
          closeLabel,
        })}
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
