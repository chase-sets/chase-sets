import type { ReactElement, ReactNode } from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";

export interface TooltipProps {
  content: ReactNode;
  children: ReactElement;
}

export function Tooltip({ content, children }: TooltipProps) {
  return (
    <TooltipPrimitive.Provider delay={180}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger render={children} />
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Positioner sideOffset={8} className="z-50">
            <TooltipPrimitive.Popup className="max-w-64 rounded-[calc(var(--radius)-2px)] bg-[var(--foreground)] px-3 py-2 text-xs font-medium leading-5 text-[var(--background)] shadow-[var(--shadow-md)]">
              {content}
              <TooltipPrimitive.Arrow className="fill-[var(--foreground)]" />
            </TooltipPrimitive.Popup>
          </TooltipPrimitive.Positioner>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
