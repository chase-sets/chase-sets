import { useState, type ReactNode } from "react";
import { motion } from "motion/react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { useChaseMotion, usePortalRoots } from "../../theme/provider";
import { resolveOverlayMotion } from "./motion-overlay";

export interface PopoverProps {
  trigger: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
}

export function Popover({
  trigger,
  title,
  children
}: PopoverProps) {
  const { overlayNode } = usePortalRoots();
  const motionSettings = useChaseMotion();
  const [open, setOpen] = useState(false);
  const motionProps = resolveOverlayMotion(
    motionSettings,
    open,
    { opacity: 1, y: 0, scale: 1 },
    { opacity: 0, y: 8, scale: 0.98 }
  );

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal container={overlayNode ?? undefined}>
        <PopoverPrimitive.Content
          sideOffset={8}
          forceMount
          asChild
        >
          <motion.div
            initial={motionProps.initial}
            animate={motionProps.animate}
            transition={motionProps.transition}
            className="modern-surface z-popover w-[min(90vw,22rem)] rounded-tokenLg border border-muted p-4 shadow-overlay"
          >
            {title ? (
              <div className="mb-2 text-sm font-semibold text-foreground">{title}</div>
            ) : null}
            {children}
          </motion.div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
