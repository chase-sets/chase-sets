import type { AnchorHTMLAttributes, ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { forwardRef, useMemo } from "react";
import { motion } from "motion/react";
import type { IconName } from "../../icons";
import { Icon } from "../../icons";
import { useLinkComponent } from "../../theme/link-adapter";
import { useChaseMotion } from "../../theme/provider";
import { cx } from "../../utils/cx";
import { toMotionDomProps } from "../../utils/motion-props";
import { controlSquareSizeClasses } from "../control-sizing";
import type { ButtonTone, ButtonSize } from "./shared";
import { buttonBaseClass, buttonToneClasses, buttonSizeClasses, resolveInteractiveMotion } from "./shared";

function iconTone(tone: ButtonTone): "inverse" | "accent" {
  return tone === "primary" || tone === "danger" ? "inverse" : "accent";
}

function renderLeadingIcon(icon: IconName | undefined, tone: ButtonTone): ReactNode {
  if (!icon) {
    return null;
  }

  return <Icon name={icon} size="sm" tone={iconTone(tone)} />;
}

function ButtonSpinner({ tone }: { tone: ButtonTone }) {
  const color =
    tone === "primary" || tone === "danger"
      ? "border-t-accent-contrast border-accent-contrast/30"
      : "border-t-accent border-accent-soft";

  return (
    <span aria-hidden="true" className={cx("absolute inset-0 flex items-center justify-center")}>
      <span className={cx("h-4 w-4 animate-spin rounded-tokenFull border-2", color)} />
    </span>
  );
}

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "style"> {
  tone?: ButtonTone;
  size?: ButtonSize;
  block?: boolean;
  loading?: boolean;
  leadingIcon?: IconName;
  trailingIcon?: IconName;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    children,
    tone = "primary",
    size = "md",
    block = false,
    loading = false,
    leadingIcon,
    trailingIcon,
    type = "button",
    disabled,
    ...rest
  },
  ref,
) {
  const motionSettings = useChaseMotion();
  const interactiveMotion = resolveInteractiveMotion(
    motionSettings.reducedMotion,
    motionSettings.interactiveScale,
    motionSettings.interactiveLift,
  );
  const nativeProps = toMotionDomProps(rest);
  const isDisabled = disabled || loading;

  return (
    <motion.button
      {...nativeProps}
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      {...(isDisabled ? undefined : interactiveMotion)}
      className={cx(buttonBaseClass, buttonToneClasses[tone], buttonSizeClasses[size], block && "w-full")}
    >
      {loading ? <ButtonSpinner tone={tone} /> : null}
      <span className={cx("inline-flex min-w-0 max-w-full items-center justify-center gap-2", loading && "invisible")}>
        {renderLeadingIcon(leadingIcon, tone)}
        <span className="min-w-0">{children}</span>
        {trailingIcon ? <Icon name={trailingIcon} size="sm" tone={iconTone(tone)} /> : null}
      </span>
    </motion.button>
  );
});

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className" | "style" | "children"
> {
  label: string;
  icon: IconName;
  tone?: ButtonTone;
  size?: ButtonSize;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, tone = "ghost", size = "md", type = "button", ...rest },
  ref,
) {
  const motionSettings = useChaseMotion();
  const isAriaDisabled = rest["aria-disabled"] === true || rest["aria-disabled"] === "true";
  const interactiveMotion = resolveInteractiveMotion(
    motionSettings.reducedMotion,
    motionSettings.interactiveScale,
    motionSettings.interactiveLift,
  );
  const nativeProps = toMotionDomProps(rest);

  return (
    <motion.button
      {...nativeProps}
      ref={ref}
      type={type}
      aria-label={label}
      {...(rest.disabled || isAriaDisabled ? undefined : interactiveMotion)}
      className={cx(buttonBaseClass, buttonToneClasses[tone], controlSquareSizeClasses[size], "p-0")}
    >
      <Icon name={icon} size="sm" tone={iconTone(tone)} />
    </motion.button>
  );
});

export interface LinkButtonProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className" | "style"> {
  tone?: ButtonTone;
  size?: ButtonSize;
  leadingIcon?: IconName;
  trailingIcon?: IconName;
  block?: boolean;
}

export const LinkButton = forwardRef<HTMLAnchorElement, LinkButtonProps>(function LinkButton(
  { children, tone = "secondary", size = "md", leadingIcon, trailingIcon, block = false, ...rest },
  ref,
) {
  const motionSettings = useChaseMotion();
  const Link = useLinkComponent();
  // Motion-enable whatever link component ChaseRoot registered (a plain `<a>` by
  // default, a router `Link` when the host app opted in) instead of hardcoding
  // `motion.a`, so LinkButton gets SPA transitions for free. Memoized on `Link` so
  // the motion-wrapped component keeps a stable identity across renders — recreating
  // it every render would remount the anchor and drop hover/tap state.
  const MotionLink = useMemo(() => motion.create(Link), [Link]);
  const interactiveMotion = resolveInteractiveMotion(
    motionSettings.reducedMotion,
    motionSettings.interactiveScale,
    motionSettings.interactiveLift,
  );
  const nativeProps = toMotionDomProps(rest);

  return (
    <MotionLink
      {...nativeProps}
      ref={ref}
      {...interactiveMotion}
      className={cx(buttonBaseClass, buttonToneClasses[tone], buttonSizeClasses[size], block && "w-full")}
    >
      {renderLeadingIcon(leadingIcon, tone)}
      <span className="min-w-0">{children}</span>
      {trailingIcon ? <Icon name={trailingIcon} size="sm" tone={iconTone(tone)} /> : null}
    </MotionLink>
  );
});

export interface ButtonGroupProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  children?: ReactNode;
}

export function ButtonGroup({ children, ...rest }: ButtonGroupProps) {
  return (
    <div {...rest} role="group" className="inline-flex flex-wrap items-center gap-3">
      {children}
    </div>
  );
}
