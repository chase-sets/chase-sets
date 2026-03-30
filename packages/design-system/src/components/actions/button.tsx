import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  HTMLAttributes,
  ReactNode
} from "react";
import { forwardRef } from "react";
import { motion } from "motion/react";
import type { IconName } from "../../icons";
import { Icon } from "../../icons";
import { useChaseMotion } from "../../theme/provider";
import { cx } from "../../utils/cx";
import type { ButtonTone, ButtonSize } from "./shared";
import {
  buttonBaseClass,
  buttonToneClasses,
  buttonSizeClasses,
  resolveInteractiveMotion
} from "./shared";

function renderLeadingIcon(icon: IconName | undefined, tone: ButtonTone): ReactNode {
  if (!icon) {
    return null;
  }

  return (
    <Icon
      name={icon}
      size="sm"
      tone={tone === "primary" || tone === "danger" ? "inverse" : "accent"}
    />
  );
}

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "style"> {
  tone?: ButtonTone;
  size?: ButtonSize;
  block?: boolean;
  leadingIcon?: IconName;
  trailingIcon?: IconName;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    children,
    tone = "primary",
    size = "md",
    block = false,
    leadingIcon,
    trailingIcon,
    type = "button",
    ...rest
  },
  ref
) {
  const motionSettings = useChaseMotion();
  const interactiveMotion = resolveInteractiveMotion(
    motionSettings.reducedMotion,
    motionSettings.interactiveScale,
    motionSettings.interactiveLift
  );
  const nativeProps = rest as unknown as Record<string, unknown>;

  return (
    <motion.button
      {...nativeProps}
      ref={ref}
      type={type}
      {...interactiveMotion}
      className={cx(
        buttonBaseClass,
        buttonToneClasses[tone],
        buttonSizeClasses[size],
        block && "w-full"
      )}
    >
      {renderLeadingIcon(leadingIcon, tone)}
      <span>{children}</span>
      {trailingIcon ? (
        <Icon
          name={trailingIcon}
          size="sm"
          tone={tone === "primary" || tone === "danger" ? "inverse" : "accent"}
        />
      ) : null}
    </motion.button>
  );
});

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "style" | "children"> {
  label: string;
  icon: IconName;
  tone?: ButtonTone;
  size?: ButtonSize;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      label,
      icon,
      tone = "ghost",
      size = "md",
      type = "button",
      ...rest
    },
    ref
  ) {
    const motionSettings = useChaseMotion();
    const interactiveMotion = resolveInteractiveMotion(
      motionSettings.reducedMotion,
      motionSettings.interactiveScale,
      motionSettings.interactiveLift
    );
    const nativeProps = rest as unknown as Record<string, unknown>;

    return (
      <motion.button
        {...nativeProps}
        ref={ref}
        type={type}
        aria-label={label}
        {...interactiveMotion}
        className={cx(
          buttonBaseClass,
          buttonToneClasses[tone],
          buttonSizeClasses[size],
          "px-0"
        )}
      >
        <Icon
          name={icon}
          size="sm"
          tone={tone === "primary" || tone === "danger" ? "inverse" : "accent"}
        />
      </motion.button>
    );
  }
);

export interface LinkButtonProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className" | "style"> {
  tone?: ButtonTone;
  size?: ButtonSize;
  leadingIcon?: IconName;
  trailingIcon?: IconName;
  block?: boolean;
}

export const LinkButton = forwardRef<HTMLAnchorElement, LinkButtonProps>(
  function LinkButton(
    {
      children,
      tone = "secondary",
      size = "md",
      leadingIcon,
      trailingIcon,
      block = false,
      ...rest
    },
    ref
  ) {
    const motionSettings = useChaseMotion();
    const interactiveMotion = resolveInteractiveMotion(
      motionSettings.reducedMotion,
      motionSettings.interactiveScale,
      motionSettings.interactiveLift
    );
    const nativeProps = rest as unknown as Record<string, unknown>;

    return (
      <motion.a
        {...nativeProps}
        ref={ref}
        {...interactiveMotion}
        className={cx(
          buttonBaseClass,
          buttonToneClasses[tone],
          buttonSizeClasses[size],
          block && "w-full"
        )}
      >
        {renderLeadingIcon(leadingIcon, tone)}
        <span>{children}</span>
        {trailingIcon ? (
          <Icon
            name={trailingIcon}
            size="sm"
            tone={tone === "primary" || tone === "danger" ? "inverse" : "accent"}
          />
        ) : null}
      </motion.a>
    );
  }
);

export interface ButtonGroupProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  children?: ReactNode;
}

export function ButtonGroup({
  children,
  ...rest
}: ButtonGroupProps) {
  return (
    <div
      {...rest}
      role="group"
      className="inline-flex flex-wrap items-center gap-3"
    >
      {children}
    </div>
  );
}
