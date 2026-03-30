import { useState, type ReactNode } from "react";
import { motion } from "motion/react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { useChaseMotion, usePortalRoots } from "../../theme/provider";
import { resolveOverlayMotion } from "./motion-overlay";

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
}

export function Tooltip({
  content,
  children
}: TooltipProps) {
  const { overlayNode } = usePortalRoots();
  const motionSettings = useChaseMotion();
  const [open, setOpen] = useState(false);
  const motionProps = resolveOverlayMotion(
    motionSettings,
    open,
    { opacity: 1, y: 0 },
    { opacity: 0, y: 6 }
  );

  return (
    <TooltipPrimitive.Provider delayDuration={150}>
      <TooltipPrimitive.Root open={open} onOpenChange={setOpen}>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal container={overlayNode ?? undefined}>
          <TooltipPrimitive.Content
            sideOffset={8}
            forceMount
            asChild
          >
            <motion.div
              initial={motionProps.initial}
              animate={motionProps.animate}
              transition={motionProps.transition}
              className="z-popover rounded-tokenMd bg-foreground px-3 py-2 text-xs font-medium text-inverse shadow-overlay"
            >
              {content}
              <TooltipPrimitive.Arrow className="fill-foreground" />
            </motion.div>
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
