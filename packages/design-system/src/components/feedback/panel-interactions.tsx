import type { HTMLAttributes, ReactNode } from "react";
import { useId } from "react";
import type { NavigationItem, SideNavProps } from "../actions";
import { IconButton, SideNav } from "../actions";
import { layoutWidthClasses, type LayoutWidth, type SidebarWidth as LayoutSidebarWidth } from "../../primitives/layout";
import { cx } from "../../utils/cx";
import { Dialog, ModalPanel, type DialogProps, type ModalPanelProps, type PanelBodyLayout } from "./dialog";

export type PanelWidth = "sm" | "md" | "lg";
export type SupportSidebarWidth = LayoutSidebarWidth | PanelWidth;
export type BottomSheetHeight = "compact" | "medium" | "expanded" | "full";

const sideSheetWidthClasses: Record<PanelWidth, string> = {
  sm: "md:w-[24rem] md:max-w-[24rem]",
  md: "md:w-[28rem] md:max-w-[28rem]",
  lg: "md:w-[36rem] md:max-w-[36rem]",
};

const sidebarWidthClasses: Record<SupportSidebarWidth, string> = {
  nav: "lg:w-64 lg:max-w-64",
  filter: "lg:w-72 lg:max-w-72",
  detail: "lg:w-[22rem] lg:max-w-[22rem]",
  summary: "lg:w-96 lg:max-w-96",
  sm: sideSheetWidthClasses.sm,
  md: sideSheetWidthClasses.md,
  lg: sideSheetWidthClasses.lg,
};

const bottomSheetHeightClasses: Record<BottomSheetHeight, string> = {
  compact: "max-h-[35vh]",
  medium: "max-h-[60vh]",
  expanded: "max-h-[88vh]",
  full: "inset-x-0 bottom-0 max-h-[calc(100vh-env(safe-area-inset-top))] rounded-b-none",
};

function renderPanelHeader({
  title,
  description,
  titleId,
  descriptionId,
  closeLabel,
  onClose,
}: {
  title: ReactNode;
  description?: ReactNode;
  titleId: string;
  descriptionId: string;
  closeLabel?: string;
  onClose?: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <h2 id={titleId} className="font-heading text-xl font-semibold text-foreground">
          {title}
        </h2>
        {description ? (
          <p id={descriptionId} className="text-sm leading-6 text-secondary">
            {description}
          </p>
        ) : null}
      </div>
      {onClose ? <IconButton label={closeLabel ?? "Close panel"} icon="close" tone="ghost" onClick={onClose} /> : null}
    </div>
  );
}

export interface NonModalPanelFrameProps extends Omit<HTMLAttributes<HTMLElement>, "className" | "style" | "title"> {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  closeLabel?: string;
  onClose?: () => void;
  bodyClassName?: string;
  bodyLayout?: PanelBodyLayout;
  placement?: "left" | "right" | "bottom";
  width?: PanelWidth;
  height?: BottomSheetHeight;
}

function NonModalPanelFrame({
  title,
  description,
  children,
  footer,
  closeLabel,
  onClose,
  bodyClassName,
  bodyLayout = "default",
  placement = "right",
  width = "md",
  height = "medium",
  ...rest
}: NonModalPanelFrameProps) {
  const titleId = useId();
  const descriptionId = useId();

  return (
    <aside
      {...rest}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      className={cx(
        "modern-surface flex min-h-0 flex-col rounded-tokenXl border border-muted p-5 shadow-overlay [--panel-content-inset:1.25rem]",
        placement === "bottom"
          ? cx(
              "fixed inset-x-3 bottom-3 z-sticky pb-[max(1.25rem,env(safe-area-inset-bottom))]",
              bottomSheetHeightClasses[height],
            )
          : cx("w-full", sideSheetWidthClasses[width]),
      )}
    >
      {renderPanelHeader({
        title,
        description,
        titleId,
        descriptionId,
        closeLabel,
        onClose,
      })}
      <div
        className={cx(
          "motion-safe-scroll-area mt-4 min-h-0 flex-1",
          bodyLayout === "edge" && "panel-edge-scroll-area",
          bodyClassName,
        )}
      >
        {children}
      </div>
      {footer ? <div className="mt-4 shrink-0">{footer}</div> : null}
    </aside>
  );
}

export interface ModalDialogProps extends DialogProps {}

export function ModalDialog(props: ModalDialogProps) {
  return <Dialog {...props} />;
}

export interface SideSheetProps extends Omit<ModalPanelProps, "placement"> {
  modal?: boolean;
  side?: "left" | "right";
  width?: PanelWidth;
}

export function SideSheet({
  modal = true,
  side = "right",
  width = "md",
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
}: SideSheetProps) {
  if (modal) {
    return (
      <ModalPanel
        open={open}
        defaultOpen={defaultOpen}
        onOpenChange={onOpenChange}
        title={title}
        description={description}
        trigger={trigger}
        footer={footer}
        closeLabel={closeLabel}
        placement={side === "left" ? "sideLeft" : "side"}
        surfaceClassName={cx(sideSheetWidthClasses[width], surfaceClassName)}
        bodyClassName={bodyClassName}
        bodyLayout={bodyLayout}
      >
        {children}
      </ModalPanel>
    );
  }

  if (open === false) {
    return null;
  }

  return (
    <NonModalPanelFrame
      title={title}
      description={description}
      footer={footer}
      closeLabel={closeLabel}
      onClose={onOpenChange ? () => onOpenChange(false) : undefined}
      bodyClassName={bodyClassName}
      bodyLayout={bodyLayout}
      placement={side}
      width={width}
    >
      {children}
    </NonModalPanelFrame>
  );
}

export interface BottomSheetProps extends Omit<ModalPanelProps, "placement"> {
  modal?: boolean;
  height?: BottomSheetHeight;
}

export function BottomSheet({
  modal = true,
  height = "medium",
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
}: BottomSheetProps) {
  if (modal) {
    return (
      <ModalPanel
        open={open}
        defaultOpen={defaultOpen}
        onOpenChange={onOpenChange}
        title={title}
        description={description}
        trigger={trigger}
        footer={footer}
        closeLabel={closeLabel}
        placement="bottomSheet"
        surfaceClassName={cx(bottomSheetHeightClasses[height], surfaceClassName)}
        bodyClassName={bodyClassName}
        bodyLayout={bodyLayout}
      >
        {children}
      </ModalPanel>
    );
  }

  if (open === false) {
    return null;
  }

  return (
    <NonModalPanelFrame
      title={title}
      description={description}
      footer={footer}
      closeLabel={closeLabel}
      onClose={onOpenChange ? () => onOpenChange(false) : undefined}
      bodyClassName={bodyClassName}
      bodyLayout={bodyLayout}
      placement="bottom"
      height={height}
    >
      {children}
    </NonModalPanelFrame>
  );
}

export interface NavigationDrawerProps extends Omit<
  SideSheetProps,
  "children" | "title" | "description" | "footer" | "modal" | "side"
> {
  label?: ReactNode;
  description?: ReactNode;
  items: NavigationItem[];
  activeKey?: string;
  onSelect?: (key: string) => void;
  brand?: ReactNode;
  footer?: ReactNode;
}

export function NavigationDrawer({
  label = "Navigation",
  description,
  items,
  activeKey,
  onSelect,
  brand,
  footer,
  width = "sm",
  ...rest
}: NavigationDrawerProps) {
  return (
    <SideSheet {...rest} modal side="left" width={width} title={label} description={description} footer={footer}>
      <div className="grid gap-4">
        {brand ? <div>{brand}</div> : null}
        <SideNav
          aria-label={typeof label === "string" ? label : "Navigation"}
          items={items}
          activeKey={activeKey}
          onSelect={onSelect}
        />
      </div>
    </SideSheet>
  );
}

export interface SidebarProps extends Omit<HTMLAttributes<HTMLElement>, "className" | "style" | "title" | "onSelect"> {
  title?: ReactNode;
  description?: ReactNode;
  label?: string;
  items?: NavigationItem[];
  activeKey?: string;
  onSelect?: SideNavProps["onSelect"];
  children?: ReactNode;
  footer?: ReactNode;
  width?: SupportSidebarWidth;
  sticky?: boolean;
  purpose?: "navigation" | "support";
}

export function Sidebar({
  title,
  description,
  label,
  items,
  activeKey,
  onSelect,
  children,
  footer,
  width = "sm",
  sticky = false,
  purpose = items ? "navigation" : "support",
  ...rest
}: SidebarProps) {
  const titleId = useId();
  const isNavigation = purpose === "navigation" || Boolean(items);

  return (
    <aside
      {...rest}
      aria-label={!isNavigation ? label : undefined}
      aria-labelledby={!isNavigation && !label && title ? titleId : undefined}
      className={cx("min-h-0 w-full", sidebarWidthClasses[width], sticky && "sticky top-20 self-start")}
    >
      <div className="glass-surface flex h-full min-h-0 flex-col gap-4 rounded-tokenLg border border-muted p-3 shadow-tokenSm">
        {title || description ? (
          <div className="space-y-1 px-1">
            {title ? (
              <h2 id={titleId} className="text-sm font-semibold text-foreground">
                {title}
              </h2>
            ) : null}
            {description ? <p className="text-xs leading-5 text-secondary">{description}</p> : null}
          </div>
        ) : null}
        {items ? (
          <SideNav
            aria-label={label ?? (typeof title === "string" ? title : "Sidebar navigation")}
            items={items}
            activeKey={activeKey}
            onSelect={onSelect}
          />
        ) : null}
        {children ? <div className="min-h-0 flex-1">{children}</div> : null}
        {footer ? <div className="shrink-0">{footer}</div> : null}
      </div>
    </aside>
  );
}

export interface FullPageProps extends Omit<HTMLAttributes<HTMLElement>, "className" | "style" | "title"> {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: LayoutWidth;
}

export function FullPage({
  title,
  description,
  eyebrow,
  actions,
  children,
  footer,
  width = "wide",
  ...rest
}: FullPageProps) {
  return (
    <main
      {...rest}
      className={cx(
        "mx-auto flex w-full min-w-0 max-w-full flex-col gap-6 px-4 py-6 md:px-6",
        layoutWidthClasses[width],
      )}
    >
      <header className="flex min-w-0 flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0 space-y-2">
          {eyebrow ? <div className="text-xs font-semibold uppercase text-accent">{eyebrow}</div> : null}
          <h1 className="font-display text-4xl font-semibold text-foreground md:text-5xl">{title}</h1>
          {description ? <p className="max-w-3xl text-base leading-7 text-secondary">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-3">{actions}</div> : null}
      </header>
      <div className="min-w-0 flex-1">{children}</div>
      {footer ? <footer>{footer}</footer> : null}
    </main>
  );
}
