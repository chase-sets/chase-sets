import type { ReactElement, ReactNode } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cn } from "../../lib/utils";
import { IconButton } from "../actions";

export interface DialogProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactElement;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  closeLabel?: string;
}

export function Dialog({
  open,
  defaultOpen,
  onOpenChange,
  trigger,
  title,
  description,
  children,
  footer,
  closeLabel = "Close",
}: DialogProps) {
  return (
    <DialogPrimitive.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      {trigger ? <DialogPrimitive.Trigger render={trigger} /> : null}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/45" />
        <DialogPrimitive.Popup
          className={cn(
            "ds-panel fixed left-1/2 top-1/2 z-50 grid max-h-[85vh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 overflow-hidden rounded-[var(--radius-xl)] border border-[var(--muted)] bg-[var(--popover)] p-6 text-[var(--popover-foreground)] shadow-[var(--shadow-overlay)]",
          )}
        >
          <div className="grid gap-1.5 pr-10">
            <DialogPrimitive.Title className="ds-display text-2xl">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Description
              className={description ? "text-sm leading-6 text-[var(--muted-foreground)]" : "sr-only"}
            >
              {description ?? "Dialog content"}
            </DialogPrimitive.Description>
          </div>
          <div className="min-h-0 overflow-y-auto">{children}</div>
          {footer ? <div className="flex flex-wrap justify-end gap-2">{footer}</div> : null}
          <div className="absolute right-3 top-3">
            <DialogPrimitive.Close render={<IconButton label={closeLabel} icon="close" tone="ghost" />} />
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
