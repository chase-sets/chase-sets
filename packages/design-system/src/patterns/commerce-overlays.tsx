import { useState, type HTMLAttributes, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Button, ButtonGroup, LinkButton, PageStepper, type PageStepperItem } from "../components/actions";
import { Switch } from "../components/forms";
import { useChaseMotion } from "../theme/provider";
import { minWidthQuery } from "../theme/tokens";
import { useMediaQuery } from "../hooks";
import { cx } from "../utils/cx";
import { Card } from "../components/data-display";
import {
  Badge,
  BottomSheet,
  SideSheet,
  type BottomSheetHeight,
  type BottomSheetProps,
  type PanelWidth,
  type SideSheetProps,
} from "../components/feedback";
import { Icon, type IconName } from "../icons";
import { toMotionDomProps } from "../utils/motion-props";

export interface CommerceActionBarProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  intentControl?: ReactNode;
  summary?: ReactNode;
  primaryAction: ReactNode;
  secondaryAction?: ReactNode;
  tertiaryAction?: ReactNode;
}

export type FormPanelVariant = "card" | "plain";

export interface FormPanelProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  children?: ReactNode;
  variant?: FormPanelVariant;
  glow?: boolean;
}

export function FormPanel({ children, variant = "card", glow = false, ...rest }: FormPanelProps) {
  if (variant === "plain") {
    return <div {...rest}>{children}</div>;
  }

  return (
    <Card {...rest} glow={glow}>
      {children}
    </Card>
  );
}

export interface CommerceBottomSheetProps extends Omit<BottomSheetProps, "children"> {
  children?: ReactNode;
}

export function CommerceBottomSheet({ children, bodyClassName, footer, ...rest }: CommerceBottomSheetProps) {
  return (
    <BottomSheet {...rest} height="expanded" bodyLayout="edge" bodyClassName={bodyClassName} footer={footer}>
      {children}
    </BottomSheet>
  );
}

export interface CommerceSheetProps extends Omit<SideSheetProps, "children" | "side" | "width"> {
  children?: ReactNode;
  desktopWidth?: PanelWidth;
  mobileHeight?: BottomSheetHeight;
}

export function CommerceSheet({
  children,
  footer,
  bodyClassName,
  desktopWidth = "md",
  mobileHeight = "expanded",
  ...rest
}: CommerceSheetProps) {
  const isDesktop = useMediaQuery(minWidthQuery("lg"));

  if (isDesktop) {
    return (
      <SideSheet {...rest} side="right" width={desktopWidth} footer={footer}>
        {children}
      </SideSheet>
    );
  }

  return (
    <BottomSheet {...rest} height={mobileHeight} bodyLayout="edge" bodyClassName={bodyClassName} footer={footer}>
      {children}
    </BottomSheet>
  );
}

export interface MarketplaceActionSheetProps extends CommerceSheetProps {}

export function MarketplaceActionSheet(props: MarketplaceActionSheetProps) {
  return <CommerceSheet {...props} />;
}

export interface ResponsiveEditSheetProps extends Omit<SideSheetProps, "children" | "side" | "width"> {
  children?: ReactNode;
  desktopWidth?: PanelWidth;
  mobileHeight?: BottomSheetHeight;
}

export function ResponsiveEditSheet({
  children,
  footer,
  desktopWidth = "md",
  mobileHeight = "full",
  ...rest
}: ResponsiveEditSheetProps) {
  const isDesktop = useMediaQuery(minWidthQuery("lg"));

  if (isDesktop) {
    return (
      <SideSheet {...rest} side="right" width={desktopWidth} footer={footer}>
        {children}
      </SideSheet>
    );
  }

  return (
    <BottomSheet {...rest} height={mobileHeight} footer={footer}>
      {children}
    </BottomSheet>
  );
}

export interface ResponsiveSupportSheetProps extends Omit<SideSheetProps, "children" | "modal" | "side" | "width"> {
  children?: ReactNode;
  desktopModal?: boolean;
  desktopWidth?: PanelWidth;
  mobileHeight?: BottomSheetHeight;
  mobileModal?: boolean;
}

export function ResponsiveSupportSheet({
  children,
  footer,
  desktopModal = false,
  desktopWidth = "md",
  mobileHeight = "expanded",
  mobileModal = true,
  ...rest
}: ResponsiveSupportSheetProps) {
  const isDesktop = useMediaQuery(minWidthQuery("lg"));

  if (isDesktop) {
    return (
      <SideSheet {...rest} modal={desktopModal} side="right" width={desktopWidth} footer={footer}>
        {children}
      </SideSheet>
    );
  }

  return (
    <BottomSheet {...rest} modal={mobileModal} height={mobileHeight} footer={footer}>
      {children}
    </BottomSheet>
  );
}

export interface ActivitySheetProps extends Omit<ResponsiveSupportSheetProps, "title"> {
  title?: ReactNode;
}

export function ActivitySheet({
  title = "Activity",
  description = "Review recent updates.",
  ...rest
}: ActivitySheetProps) {
  return <ResponsiveSupportSheet {...rest} title={title} description={description} />;
}

export interface CommentsSheetProps extends Omit<ResponsiveSupportSheetProps, "title"> {
  title?: ReactNode;
}

export function CommentsSheet({
  title = "Comments",
  description = "Review and add contextual comments.",
  ...rest
}: CommentsSheetProps) {
  return <ResponsiveSupportSheet {...rest} title={title} description={description} />;
}

export interface AssistantSheetProps extends Omit<ResponsiveSupportSheetProps, "title"> {
  title?: ReactNode;
}

export function AssistantSheet({
  title = "Assistant",
  description = "Get contextual help without leaving your work.",
  ...rest
}: AssistantSheetProps) {
  return <ResponsiveSupportSheet {...rest} title={title} description={description} />;
}

export interface HelpSheetProps extends Omit<ResponsiveSupportSheetProps, "title"> {
  title?: ReactNode;
}

export function HelpSheet({
  title = "Help",
  description = "Review guidance for this workflow.",
  ...rest
}: HelpSheetProps) {
  return <ResponsiveSupportSheet {...rest} title={title} description={description} />;
}

export type NotificationCenterView = "feed" | "settings";

export interface NotificationCenterItem {
  deliveryId: string;
  title: ReactNode;
  body: ReactNode;
  sourceLabel?: ReactNode;
  createdAtLabel?: ReactNode;
  actionHref?: string | null;
  actionLabel?: ReactNode;
  read?: boolean;
}

export interface NotificationCenterPreference {
  key: string;
  label: ReactNode;
  description?: ReactNode;
  enabled: boolean;
}

export interface NotificationCenterProductAlert {
  id: string;
  title: ReactNode;
  detail?: ReactNode;
  status: "active" | "paused";
  productHref?: string;
}

export interface NotificationCenterSheetProps extends Omit<
  SideSheetProps,
  "children" | "title" | "description" | "footer"
> {
  title?: ReactNode;
  description?: ReactNode;
  view?: NotificationCenterView;
  unreadCount?: number;
  loading?: boolean;
  notifications: readonly NotificationCenterItem[];
  preferences?: readonly NotificationCenterPreference[];
  productAlerts?: readonly NotificationCenterProductAlert[];
  onViewChange?: (view: NotificationCenterView) => void;
  onMarkRead?: (deliveryId: string) => void;
  onMarkAllRead?: () => void;
  onPreferenceChange?: (key: string, enabled: boolean) => void;
  onProductAlertPause?: (id: string) => void;
  onProductAlertResume?: (id: string) => void;
  onProductAlertDelete?: (id: string) => void;
}

export function NotificationCenterSheet({
  title = "Notifications",
  description = "Review marketplace updates and notification settings.",
  view = "feed",
  unreadCount = 0,
  loading = false,
  notifications,
  preferences = [],
  productAlerts = [],
  onViewChange,
  onMarkRead,
  onMarkAllRead,
  onPreferenceChange,
  onProductAlertPause,
  onProductAlertResume,
  onProductAlertDelete,
  ...rest
}: NotificationCenterSheetProps) {
  const isDesktop = useMediaQuery(minWidthQuery("lg"));
  const hasNotifications = notifications.length > 0;
  const unreadLabel = unreadCount === 1 ? "1 unread" : `${unreadCount} unread`;
  const footer =
    view === "feed" ? (
      <Button
        type="button"
        tone="secondary"
        size="sm"
        block
        disabled={unreadCount === 0 || loading}
        onClick={onMarkAllRead}
      >
        Mark all read
      </Button>
    ) : null;
  const content = (
    <div className="grid min-h-0 gap-4">
      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          tone={view === "feed" ? "primary" : "secondary"}
          size="sm"
          onClick={() => onViewChange?.("feed")}
        >
          Feed
        </Button>
        <Button
          type="button"
          tone={view === "settings" ? "primary" : "secondary"}
          size="sm"
          leadingIcon="settings"
          onClick={() => onViewChange?.("settings")}
        >
          Settings
        </Button>
      </div>

      {view === "feed" ? (
        <div className="grid gap-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold text-foreground">Recent updates</span>
            <Badge tone={unreadCount > 0 ? "accent" : "neutral"}>{unreadLabel}</Badge>
          </div>

          {loading ? (
            <div className="rounded-tokenMd border border-muted bg-surface p-4 text-sm text-secondary">
              Loading notifications
            </div>
          ) : hasNotifications ? (
            notifications.map((notification) => (
              <div
                key={notification.deliveryId}
                className="rounded-tokenMd border border-muted bg-surface p-4 shadow-tokenSm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="text-sm font-semibold text-foreground">{notification.title}</div>
                    <div className="text-sm leading-6 text-secondary">{notification.body}</div>
                  </div>
                  <Badge tone={notification.read ? "neutral" : "accent"}>{notification.read ? "Read" : "New"}</Badge>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-secondary">
                  {notification.sourceLabel ? <span>{notification.sourceLabel}</span> : null}
                  {notification.createdAtLabel ? <span>{notification.createdAtLabel}</span> : null}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {notification.actionHref ? (
                    <LinkButton href={notification.actionHref} tone="secondary" size="sm">
                      {notification.actionLabel ?? "Open"}
                    </LinkButton>
                  ) : null}
                  {!notification.read ? (
                    <Button type="button" tone="ghost" size="sm" onClick={() => onMarkRead?.(notification.deliveryId)}>
                      Mark read
                    </Button>
                  ) : null}
                </div>
              </div>
            ))
          ) : (
            <div className="rounded-tokenMd border border-muted bg-surface p-4">
              <div className="text-sm font-semibold text-foreground">No notifications</div>
              <div className="mt-1 text-sm leading-6 text-secondary">
                Order, shipment, and Product alert updates will appear here.
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="grid gap-4">
          <section className="grid gap-3">
            <div>
              <div className="text-sm font-semibold text-foreground">Delivery settings</div>
              <div className="text-sm text-secondary">Control how marketplace updates reach this account.</div>
            </div>
            {preferences.map((preference) => (
              <Switch
                key={preference.key}
                label={preference.label}
                description={preference.description}
                checked={preference.enabled}
                onCheckedChange={(enabled) => onPreferenceChange?.(preference.key, enabled)}
              />
            ))}
          </section>

          <section className="grid gap-3">
            <div>
              <div className="text-sm font-semibold text-foreground">Product alerts</div>
              <div className="text-sm text-secondary">Pause or remove watches created from product detail pages.</div>
            </div>
            {productAlerts.length > 0 ? (
              productAlerts.map((alert) => (
                <div key={alert.id} className="rounded-tokenMd border border-muted bg-surface p-4 shadow-tokenSm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-foreground">{alert.title}</div>
                      {alert.detail ? (
                        <div className="mt-1 text-sm leading-6 text-secondary">{alert.detail}</div>
                      ) : null}
                    </div>
                    <Badge tone={alert.status === "active" ? "success" : "neutral"}>{alert.status}</Badge>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {alert.status === "active" ? (
                      <Button type="button" tone="secondary" size="sm" onClick={() => onProductAlertPause?.(alert.id)}>
                        Pause
                      </Button>
                    ) : (
                      <Button type="button" tone="secondary" size="sm" onClick={() => onProductAlertResume?.(alert.id)}>
                        Resume
                      </Button>
                    )}
                    <Button type="button" tone="ghost" size="sm" onClick={() => onProductAlertDelete?.(alert.id)}>
                      Delete
                    </Button>
                    {alert.productHref ? (
                      <LinkButton href={alert.productHref} tone="ghost" size="sm">
                        View product
                      </LinkButton>
                    ) : null}
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-tokenMd border border-muted bg-surface p-4">
                <div className="text-sm font-semibold text-foreground">No Product alerts yet</div>
                <div className="mt-1 text-sm leading-6 text-secondary">
                  Create alerts from product detail pages after choosing product options.
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );

  if (!isDesktop) {
    return (
      <BottomSheet {...rest} height="expanded" title={title} description={description} footer={footer}>
        {content}
      </BottomSheet>
    );
  }

  return (
    <SideSheet {...rest} side="right" width="md" title={title} description={description} footer={footer}>
      {content}
    </SideSheet>
  );
}

export function CommerceActionBar({
  intentControl,
  summary,
  primaryAction,
  secondaryAction,
  tertiaryAction,
  ...rest
}: CommerceActionBarProps) {
  const actionCount = [primaryAction, secondaryAction, tertiaryAction].filter(Boolean).length;

  return (
    <div {...rest} className="modern-surface rounded-tokenLg border border-muted p-3 shadow-overlay">
      {intentControl ? <div className="mb-3">{intentControl}</div> : null}
      <div className="flex items-center gap-3">
        {summary ? <div className="min-w-0 flex-1 shrink text-xs font-medium text-secondary">{summary}</div> : null}
        <div className={cx("flex shrink-0 items-center gap-2", actionCount === 1 && "flex-1")}>
          {primaryAction}
          {secondaryAction}
          {tertiaryAction}
        </div>
      </div>
    </div>
  );
}

export interface WizardStep {
  key: string;
  label: string;
  description?: string;
  content: ReactNode;
  isValid?: boolean;
}

export interface WizardProps {
  steps: WizardStep[];
  activeStep: string;
  onStepChange: (key: string) => void;
  onComplete?: () => void;
  nextLabel?: string;
  previousLabel?: string;
  completeLabel?: string;
}

export function Wizard({
  steps,
  activeStep,
  onStepChange,
  onComplete,
  nextLabel = "Continue",
  previousLabel = "Back",
  completeLabel = "Complete",
}: WizardProps) {
  const motionSettings = useChaseMotion();
  const activeIndex = steps.findIndex((s) => s.key === activeStep);
  const current = steps[activeIndex];
  const isFirst = activeIndex === 0;
  const isLast = activeIndex === steps.length - 1;

  const stepperItems: PageStepperItem[] = steps.map((step, index) => ({
    label: step.label,
    description: step.description,
    status: index < activeIndex ? "complete" : index === activeIndex ? "current" : "upcoming",
  }));

  return (
    <div className="space-y-6">
      <PageStepper items={stepperItems} />
      <AnimatePresence initial={false} mode="wait">
        <motion.div
          key={current?.key}
          initial={motionSettings.reducedMotion ? false : { opacity: 0, x: 18 }}
          animate={motionSettings.reducedMotion ? undefined : { opacity: 1, x: 0 }}
          exit={motionSettings.reducedMotion ? undefined : { opacity: 0, x: -12 }}
          transition={
            motionSettings.reducedMotion
              ? undefined
              : { duration: motionSettings.durations.base, ease: motionSettings.easing }
          }
        >
          {current?.content}
        </motion.div>
      </AnimatePresence>
      <div className="flex items-center justify-between gap-3">
        <div>
          {!isFirst ? (
            <Button tone="secondary" onClick={() => onStepChange(steps[activeIndex - 1].key)}>
              {previousLabel}
            </Button>
          ) : null}
        </div>
        <div>
          {isLast ? (
            <Button tone="primary" disabled={current?.isValid === false} onClick={onComplete}>
              {completeLabel}
            </Button>
          ) : (
            <Button
              tone="primary"
              disabled={current?.isValid === false}
              onClick={() => onStepChange(steps[activeIndex + 1].key)}
            >
              {nextLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
