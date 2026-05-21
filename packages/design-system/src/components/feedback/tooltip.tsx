import { useState, type ReactNode } from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { useChaseMotion, usePortalRoots } from "../../theme/provider";
import { renderInlineTrigger, renderMotionDiv } from "../../utils/base-ui";
import { resolveOverlayMotion } from "./motion-overlay";

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
}

export function Tooltip({ content, children }: TooltipProps) {
  const { overlayNode } = usePortalRoots();
  const motionSettings = useChaseMotion();
  const [open, setOpen] = useState(false);
  const motionProps = resolveOverlayMotion(motionSettings, open, { opacity: 1, y: 0 }, { opacity: 0, y: 6 });

  return (
    <TooltipPrimitive.Provider delay={150}>
      <TooltipPrimitive.Root open={open} onOpenChange={setOpen}>
        <TooltipPrimitive.Trigger render={renderInlineTrigger(children)} />
        <TooltipPrimitive.Portal container={overlayNode ?? undefined}>
          <TooltipPrimitive.Positioner sideOffset={8} className="z-popover">
            <TooltipPrimitive.Popup
              render={renderMotionDiv({
                initial: motionProps.initial,
                animate: motionProps.animate,
                transition: motionProps.transition,
                className: "rounded-tokenMd bg-foreground px-3 py-2 text-xs font-medium text-inverse shadow-overlay",
              })}
            >
              {content}
              <TooltipPrimitive.Arrow className="fill-foreground" />
            </TooltipPrimitive.Popup>
          </TooltipPrimitive.Positioner>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
