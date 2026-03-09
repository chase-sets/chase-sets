import { createPortal } from "react-dom";
import { forwardRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { motion } from "motion/react";
import * as AccordionPrimitive from "@radix-ui/react-accordion";
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as ToastPrimitive from "@radix-ui/react-toast";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Icon, type IconName } from "../icons";
import { useChaseMotion, usePortalRoots } from "../theme/provider";
import { cx } from "../utils/cx";
import { Button, IconButton } from "./actions";

type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

const toneClasses: Record<Tone, string> = {
  neutral: "border-muted bg-background text-secondary",
  accent: "border-accent bg-accent text-accent-contrast",
  success: "border-success bg-success text-inverse",
  warning: "border-warning bg-warning text-inverse",
  danger: "border-danger bg-danger text-inverse",
  info: "border-info bg-info text-inverse"
};

const softToneClasses: Record<Tone, string> = {
  neutral: "border-muted bg-background text-secondary",
  accent: "border-accent bg-background text-accent",
  success: "border-success bg-background text-success",
  warning: "border-warning bg-background text-warning",
  danger: "border-danger bg-background text-danger",
  info: "border-info bg-background text-info"
};

function toneIcon(tone: Tone): IconName {
  switch (tone) {
    case "success":
      return "check";
    case "warning":
      return "warning";
    case "danger":
      return "warning";
    case "info":
      return "info";
    case "accent":
      return "spark";
    default:
      return "info";
  }
}

function toneToIconTone(tone: Tone) {
  return tone === "neutral" ? "secondary" : tone;
}

function useControllableOpen(
  open: boolean | undefined,
  defaultOpen: boolean | undefined,
  onOpenChange?: (open: boolean) => void
) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen ?? false);
  const resolvedOpen = open ?? internalOpen;

  function handleOpenChange(nextOpen: boolean) {
    if (open === undefined) {
      setInternalOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  }

  return [resolvedOpen, handleOpenChange] as const;
}

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
          initial: reducedMotion ? false : { opacity: 0, y: 24, x: 0 },
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
          initial: reducedMotion ? false : { opacity: 0, scale: 0.96, y: 14 },
          animate: reducedMotion
            ? undefined
            : open
              ? { opacity: 1, scale: 1, y: 0 }
              : { opacity: 0, scale: 0.98, y: 10 },
          transition: reducedMotion
            ? undefined
            : { duration: durations.base, ease: easing }
        };

  return (
    <>
      <DialogPrimitive.Overlay forceMount asChild>
        <motion.div
          initial={false}
          animate={
            reducedMotion
              ? undefined
              : open
                ? { opacity: 1 }
                : { opacity: 0 }
          }
          transition={
            reducedMotion
              ? undefined
              : { duration: durations.base, ease: easing }
          }
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
        <div className="mt-4 min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer ? <div className="mt-4">{footer}</div> : null}
        </motion.div>
      </DialogPrimitive.Content>
    </>
  );
}

const AnimatedAccordionContent = forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof motion.div> & { "data-state"?: "open" | "closed" }
>(function AnimatedAccordionContent({ children, ...rest }, ref) {
  const motionSettings = useChaseMotion();
  const isOpen = rest["data-state"] === "open";

  return (
    <motion.div
      {...rest}
      ref={ref}
      initial={false}
      animate={
        motionSettings.reducedMotion
          ? undefined
          : isOpen
            ? { height: "auto", opacity: 1 }
            : { height: 0, opacity: 0 }
      }
      transition={
        motionSettings.reducedMotion
          ? undefined
          : { duration: motionSettings.durations.base, ease: motionSettings.easing }
      }
    >
      {children}
    </motion.div>
  );
});

export interface BadgeProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, "className" | "style"> {
  children?: ReactNode;
  tone?: Tone;
}

export function Badge({
  children,
  tone = "neutral",
  ...rest
}: BadgeProps) {
  return (
    <span
      {...rest}
      className={cx(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold",
        softToneClasses[tone]
      )}
    >
      {children}
    </span>
  );
}

export interface StatusPillProps extends BadgeProps {}

export function StatusPill(props: StatusPillProps) {
  return <Badge {...props} />;
}

export interface TagProps extends BadgeProps {
  onRemove?: () => void;
}

export function Tag({
  children,
  tone = "neutral",
  onRemove,
  ...rest
}: TagProps) {
  return (
    <span
      {...rest}
      className={cx(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold",
        softToneClasses[tone]
      )}
    >
      <span>{children}</span>
      {onRemove ? (
        <button
          type="button"
          className="focus-ring rounded-full"
          onClick={onRemove}
          aria-label={`Remove ${typeof children === "string" ? children : "tag"}`}
        >
          <Icon name="close" size="sm" tone={toneToIconTone(tone)} />
        </button>
      ) : null}
    </span>
  );
}

export interface BannerProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style" | "title"> {
  title: ReactNode;
  description?: ReactNode;
  tone?: Exclude<Tone, "neutral">;
  actions?: ReactNode;
}

export function Banner({
  title,
  description,
  tone = "info",
  actions,
  ...rest
}: BannerProps) {
  return (
    <div
      {...rest}
      className={cx(
        "flex flex-col gap-4 rounded-tokenLg border p-4 md:flex-row md:items-center md:justify-between",
        softToneClasses[tone]
      )}
    >
      <div className="flex items-start gap-3">
        <Icon name={toneIcon(tone)} size="sm" tone={tone} />
        <div className="space-y-1">
          <div className="text-sm font-semibold">{title}</div>
          {description ? <div className="text-sm">{description}</div> : null}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
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
            initial={false}
            animate={
              motionSettings.reducedMotion
                ? undefined
                : resolvedOpen
                  ? { opacity: 1 }
                  : { opacity: 0 }
            }
            transition={
              motionSettings.reducedMotion
                ? undefined
                : { duration: motionSettings.durations.base, ease: motionSettings.easing }
            }
            className="fixed inset-0 z-modal bg-[rgba(29,27,24,0.35)]"
          />
        </AlertDialogPrimitive.Overlay>
        <AlertDialogPrimitive.Content forceMount asChild>
          <motion.div
            initial={motionSettings.reducedMotion ? false : { opacity: 0, scale: 0.96, y: 14 }}
            animate={
              motionSettings.reducedMotion
                ? undefined
                : resolvedOpen
                  ? { opacity: 1, scale: 1, y: 0 }
                  : { opacity: 0, scale: 0.98, y: 8 }
            }
            transition={
              motionSettings.reducedMotion
                ? undefined
                : { duration: motionSettings.durations.base, ease: motionSettings.easing }
            }
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
            initial={motionSettings.reducedMotion ? false : { opacity: 0, y: 8, scale: 0.98 }}
            animate={
              motionSettings.reducedMotion
                ? undefined
                : open
                  ? { opacity: 1, y: 0, scale: 1 }
                  : { opacity: 0, y: 8, scale: 0.99 }
            }
            transition={
              motionSettings.reducedMotion
                ? undefined
                : { duration: motionSettings.durations.fast, ease: motionSettings.easing }
            }
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
              initial={motionSettings.reducedMotion ? false : { opacity: 0, y: 6 }}
              animate={
                motionSettings.reducedMotion
                  ? undefined
                  : open
                    ? { opacity: 1, y: 0 }
                    : { opacity: 0, y: 6 }
              }
              transition={
                motionSettings.reducedMotion
                  ? undefined
                  : { duration: motionSettings.durations.fast, ease: motionSettings.easing }
              }
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

export interface MenuItem {
  key: string;
  label: string;
  description?: string;
  destructive?: boolean;
  onSelect?: () => void;
  icon?: IconName;
  shortcut?: string;
  disabled?: boolean;
}

export interface MenuGroup {
  label?: string;
  items: MenuItem[];
}

export interface MenuProps {
  trigger: ReactNode;
  items?: MenuItem[];
  groups?: MenuGroup[];
}

function renderMenuItem(item: MenuItem) {
  return (
    <DropdownMenuPrimitive.Item
      key={item.key}
      disabled={item.disabled}
      className={cx(
        "focus-ring flex cursor-pointer select-none items-start gap-3 rounded-tokenMd px-3 py-2 text-sm outline-none data-[highlighted]:bg-background data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
        item.destructive ? "text-danger" : "text-foreground"
      )}
      onSelect={item.onSelect}
    >
      {item.icon ? (
        <Icon
          name={item.icon}
          size="sm"
          tone={item.destructive ? "danger" : "secondary"}
        />
      ) : null}
      <div className="flex-1 space-y-0.5">
        <div className="font-medium">{item.label}</div>
        {item.description ? (
          <div className="text-xs text-secondary">{item.description}</div>
        ) : null}
      </div>
      {item.shortcut ? (
        <span className="ml-auto text-xs text-secondary">{item.shortcut}</span>
      ) : null}
    </DropdownMenuPrimitive.Item>
  );
}

export function Menu({
  trigger,
  items,
  groups
}: MenuProps) {
  const { overlayNode } = usePortalRoots();
  const motionSettings = useChaseMotion();
  const [open, setOpen] = useState(false);

  return (
    <DropdownMenuPrimitive.Root open={open} onOpenChange={setOpen}>
      <DropdownMenuPrimitive.Trigger asChild>
        {trigger}
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal container={overlayNode ?? undefined}>
        <DropdownMenuPrimitive.Content
          sideOffset={8}
          forceMount
          asChild
        >
          <motion.div
            initial={motionSettings.reducedMotion ? false : { opacity: 0, y: 10, scale: 0.98 }}
            animate={
              motionSettings.reducedMotion
                ? undefined
                : open
                  ? { opacity: 1, y: 0, scale: 1 }
                  : { opacity: 0, y: 8, scale: 0.99 }
            }
            transition={
              motionSettings.reducedMotion
                ? undefined
                : { duration: motionSettings.durations.fast, ease: motionSettings.easing }
            }
            className="modern-surface z-dropdown min-w-56 rounded-tokenLg border border-muted p-2 shadow-overlay"
          >
            {groups
              ? groups.map((group, groupIndex) => (
                  <DropdownMenuPrimitive.Group key={groupIndex}>
                    {group.label ? (
                      <DropdownMenuPrimitive.Label className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-secondary">
                        {group.label}
                      </DropdownMenuPrimitive.Label>
                    ) : null}
                    {group.items.map(renderMenuItem)}
                    {groupIndex < groups.length - 1 ? (
                      <DropdownMenuPrimitive.Separator className="my-1 h-px bg-muted" />
                    ) : null}
                  </DropdownMenuPrimitive.Group>
                ))
              : items?.map(renderMenuItem)}
          </motion.div>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

export interface ToastItem {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  tone?: Exclude<Tone, "neutral">;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  dismissLabel?: string;
}

export interface ToastRegionProps {
  items: ToastItem[];
}

function ToastRegionItem({ item }: { item: ToastItem }) {
  const motionSettings = useChaseMotion();
  const [internalOpen, setInternalOpen] = useState(item.open ?? true);
  const resolvedOpen = item.open ?? internalOpen;

  function handleOpenChange(nextOpen: boolean) {
    if (item.open === undefined) {
      setInternalOpen(nextOpen);
    }
    item.onOpenChange?.(nextOpen);
  }

  return (
    <ToastPrimitive.Root
      forceMount
      open={resolvedOpen}
      onOpenChange={handleOpenChange}
      className="modern-surface rounded-tokenLg border border-muted shadow-overlay"
    >
      {resolvedOpen ? (
        <motion.div
          layout
          initial={motionSettings.reducedMotion ? false : { opacity: 0, y: 16, scale: 0.98 }}
          animate={
            motionSettings.reducedMotion
              ? undefined
              : { opacity: 1, y: 0, scale: 1, height: "auto" }
          }
          transition={
            motionSettings.reducedMotion
              ? undefined
              : { duration: motionSettings.durations.base, ease: motionSettings.easing }
          }
          className="grid grid-cols-[auto_1fr_auto] items-start gap-3 p-4"
        >
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-background">
            <Icon
              name={toneIcon(item.tone ?? "info")}
              size="sm"
              tone={item.tone ?? "info"}
            />
          </div>
          <div className="min-w-0 space-y-1">
            <ToastPrimitive.Title className="text-sm font-semibold text-foreground">
              {item.title}
            </ToastPrimitive.Title>
            {item.description ? (
              <ToastPrimitive.Description className="text-sm text-secondary">
                {item.description}
              </ToastPrimitive.Description>
            ) : null}
          </div>
          <div className="self-start">
            <ToastPrimitive.Close asChild>
              <IconButton
                label={item.dismissLabel ?? "Dismiss notification"}
                icon="close"
                tone="ghost"
                size="sm"
              />
            </ToastPrimitive.Close>
          </div>
        </motion.div>
      ) : null}
    </ToastPrimitive.Root>
  );
}

export function ToastRegion({
  items
}: ToastRegionProps) {
  const { toastNode } = usePortalRoots();

  const viewport = (
    <ToastPrimitive.Viewport className="fixed inset-x-0 bottom-0 z-toast mx-auto flex w-full max-w-md flex-col gap-3 p-4 outline-none" />
  );

  return (
    <ToastPrimitive.Provider duration={4000} swipeDirection="right">
      {items.map((item) => <ToastRegionItem key={item.id} item={item} />)}
      {toastNode ? createPortal(viewport, toastNode) : viewport}
    </ToastPrimitive.Provider>
  );
}

export interface LoadingSpinnerProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  label?: string;
  size?: "sm" | "md" | "lg";
}

export function LoadingSpinner({
  label = "Loading",
  size = "md",
  ...rest
}: LoadingSpinnerProps) {
  const sizeClass =
    size === "sm" ? "h-4 w-4" : size === "lg" ? "h-8 w-8" : "h-6 w-6";

  return (
    <div {...rest} className="inline-flex items-center gap-2 text-secondary">
      <span
        aria-hidden="true"
        className={cx(
          "inline-flex animate-spin rounded-full border-2 border-muted border-t-accent",
          sizeClass
        )}
      />
      <span className="text-sm">{label}</span>
    </div>
  );
}

export interface ProgressBarProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  value: number;
  max?: number;
  tone?: Exclude<Tone, "neutral">;
  formatLabel?: (percentage: number) => string;
}

export function ProgressBar({
  value,
  max = 100,
  tone = "accent",
  formatLabel = (p) => `${Math.round(p)}%`,
  ...rest
}: ProgressBarProps) {
  const percentage = Math.max(0, Math.min(100, (value / max) * 100));

  return (
    <div {...rest} className="space-y-2">
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cx(
            "h-full rounded-full transition-all",
            tone === "accent" && "bg-accent",
            tone === "success" && "bg-success",
            tone === "warning" && "bg-warning",
            tone === "danger" && "bg-danger",
            tone === "info" && "bg-info"
          )}
          style={{ width: `${percentage}%` }}
        />
      </div>
      <div className="text-xs text-secondary">{formatLabel(percentage)}</div>
    </div>
  );
}

export interface SkeletonProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  height?: "sm" | "md" | "lg";
}

export function Skeleton({
  height = "md",
  ...rest
}: SkeletonProps) {
  const heightClass =
    height === "sm" ? "h-4" : height === "lg" ? "h-24" : "h-12";

  return (
    <div
      {...rest}
      aria-hidden="true"
      className={cx(
        "w-full animate-pulse rounded-tokenMd bg-muted",
        heightClass
      )}
    />
  );
}

export interface EmptyStateProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style" | "title"> {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: IconName;
}

export function EmptyState({
  title,
  description,
  actions,
  icon = "spark",
  ...rest
}: EmptyStateProps) {
  return (
    <div
      {...rest}
      className="rounded-tokenLg border border-dashed border-muted bg-background p-6 text-center"
    >
      <div className="mx-auto flex max-w-sm flex-col items-center gap-4">
        <div className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-elevated shadow-tokenSm">
          <Icon name={icon} size="lg" tone="accent" />
        </div>
        <div className="space-y-2">
          <div className="font-heading text-xl font-semibold text-foreground">{title}</div>
          {description ? <div className="text-sm text-secondary">{description}</div> : null}
        </div>
        {actions ? <div className="flex flex-wrap justify-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

export type RatingSize = "sm" | "md" | "lg";

const ratingSizeClasses: Record<RatingSize, string> = {
  sm: "h-4 w-4",
  md: "h-5 w-5",
  lg: "h-6 w-6"
};

export interface RatingProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style" | "onChange"> {
  value: number;
  max?: number;
  size?: RatingSize;
  interactive?: boolean;
  onValueChange?: (value: number) => void;
  label?: string;
}

export function Rating({
  value,
  max = 5,
  size = "md",
  interactive = false,
  onValueChange,
  label = "Rating",
  ...rest
}: RatingProps) {
  const stars = Array.from({ length: max }, (_, i) => {
    const position = i + 1;
    const filled = value >= position;
    const half = !filled && value >= position - 0.5;
    const iconName = filled ? "star" : half ? "starHalf" : "starEmpty";

    if (interactive) {
      return (
        <button
          key={position}
          type="button"
          role="radio"
          aria-checked={value === position}
          aria-label={`${position} of ${max}`}
          className="focus-ring rounded-sm text-warning"
          onClick={() => onValueChange?.(position)}
        >
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={ratingSizeClasses[size]}
          >
            {iconName === "star" ? (
              <path
                d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.27 5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z"
                fill="currentColor"
              />
            ) : iconName === "starHalf" ? (
              <>
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.27 5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z" />
                <path
                  d="M12 2v15.27L5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z"
                  fill="currentColor"
                />
              </>
            ) : (
              <path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.27 5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z" />
            )}
          </svg>
        </button>
      );
    }

    return (
      <Icon
        key={position}
        name={iconName}
        size={size}
        tone="warning"
      />
    );
  });

  return (
    <div
      {...rest}
      role={interactive ? "radiogroup" : undefined}
      aria-label={label}
      className="inline-flex items-center gap-0.5"
    >
      {stars}
    </div>
  );
}

export interface AccordionItem {
  value: string;
  trigger: ReactNode;
  content: ReactNode;
}

export interface AccordionProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style" | "defaultValue" | "dir"> {
  items: AccordionItem[];
  type?: "single" | "multiple";
  defaultValue?: string | string[];
  collapsible?: boolean;
}

export function Accordion({
  items,
  type = "single",
  defaultValue,
  collapsible = true,
  ...rest
}: AccordionProps) {
  const rootProps =
    type === "multiple"
      ? {
          type: "multiple" as const,
          defaultValue: Array.isArray(defaultValue)
            ? defaultValue
            : defaultValue
              ? [defaultValue]
              : undefined
        }
      : {
          type: "single" as const,
          collapsible,
          defaultValue: typeof defaultValue === "string" ? defaultValue : undefined
        };

  return (
    <AccordionPrimitive.Root
      {...rootProps}
      {...rest}
      className="modern-surface rounded-tokenLg border border-muted shadow-tokenSm"
    >
      {items.map((item, index) => (
        <AccordionPrimitive.Item
          key={item.value}
          value={item.value}
          className={cx(
            "border-muted",
            index < items.length - 1 && "border-b"
          )}
        >
          <AccordionPrimitive.Header>
            <AccordionPrimitive.Trigger className="focus-ring flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-semibold text-foreground transition hover:bg-background [&[data-state=open]>span]:rotate-180">
              <span className="flex-1">{item.trigger}</span>
              <span className="inline-flex shrink-0 transition-transform duration-200">
                <Icon name="chevronDown" size="sm" tone="secondary" />
              </span>
            </AccordionPrimitive.Trigger>
          </AccordionPrimitive.Header>
          <AccordionPrimitive.Content forceMount asChild>
            <AnimatedAccordionContent className="overflow-hidden">
              <div className="px-4 pb-4 text-sm text-secondary">
              {item.content}
              </div>
            </AnimatedAccordionContent>
          </AccordionPrimitive.Content>
        </AccordionPrimitive.Item>
      ))}
    </AccordionPrimitive.Root>
  );
}
