import type { ReactNode } from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { useChaseMotion, usePortalRoots } from "../../theme/provider";
import { renderInlineTrigger, renderMotionDiv } from "../../utils/base-ui";
import { resolveOverlayMotion } from "./motion-overlay";
import { useControllableOpen } from "./shared";

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function Tooltip({ content, children, open, defaultOpen, onOpenChange }: TooltipProps) {
  const { overlayNode } = usePortalRoots();
  const motionSettings = useChaseMotion();
  const [resolvedOpen, setResolvedOpen] = useControllableOpen(open, defaultOpen, onOpenChange);
  const motionProps = resolveOverlayMotion(motionSettings, resolvedOpen, { opacity: 1, y: 0 }, { opacity: 0, y: 6 });

  return (
    <TooltipPrimitive.Provider delay={150}>
      <TooltipPrimitive.Root open={resolvedOpen} onOpenChange={setResolvedOpen}>
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
