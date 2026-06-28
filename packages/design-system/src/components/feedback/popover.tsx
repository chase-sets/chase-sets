import type { ReactNode } from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useChaseMotion, usePortalRoots } from "../../theme/provider";
import { renderButtonTrigger, renderMotionDiv } from "../../utils/base-ui";
import { resolveOverlayMotion } from "./motion-overlay";
import { useControllableOpen } from "./shared";

export interface PopoverProps {
  trigger: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  title?: ReactNode;
  children?: ReactNode;
}

export function Popover({ trigger, open, defaultOpen, onOpenChange, title, children }: PopoverProps) {
  const { overlayNode } = usePortalRoots();
  const motionSettings = useChaseMotion();
  const [resolvedOpen, setResolvedOpen] = useControllableOpen(open, defaultOpen, onOpenChange);
  const motionProps = resolveOverlayMotion(
    motionSettings,
    resolvedOpen,
    { opacity: 1, y: 0, scale: 1 },
    { opacity: 0, y: 8, scale: 0.98 },
  );

  return (
    <PopoverPrimitive.Root open={resolvedOpen} onOpenChange={setResolvedOpen}>
      <PopoverPrimitive.Trigger render={renderButtonTrigger(trigger)} />
      <PopoverPrimitive.Portal container={overlayNode ?? undefined}>
        <PopoverPrimitive.Positioner sideOffset={8} className="z-popover">
          <PopoverPrimitive.Popup
            render={renderMotionDiv({
              initial: motionProps.initial,
              animate: motionProps.animate,
              transition: motionProps.transition,
              className: "modern-surface w-[min(90vw,22rem)] rounded-tokenLg border border-muted p-4 shadow-overlay",
            })}
          >
            {title ? <div className="mb-2 text-sm font-semibold text-foreground">{title}</div> : null}
            {children}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
