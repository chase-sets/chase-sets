import type { ButtonHTMLAttributes } from "react";
import { useCallback, useRef, useState } from "react";
import { motion } from "motion/react";
import { Icon } from "../../icons";
import { useChaseMotion } from "../../theme/provider";
import { cx } from "../../utils/cx";
import { toMotionDomProps } from "../../utils/motion-props";
import type { ButtonTone, ButtonSize } from "./shared";
import { buttonBaseClass, buttonToneClasses, buttonSizeClasses, resolveInteractiveMotion } from "./shared";

export interface CopyButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className" | "style" | "children"
> {
  value: string;
  label?: string;
  copiedLabel?: string;
  tone?: ButtonTone;
  size?: ButtonSize;
}

export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  tone = "secondary",
  size = "sm",
  type = "button",
  ...rest
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const motionSettings = useChaseMotion();
  const interactiveMotion = resolveInteractiveMotion(
    motionSettings.reducedMotion,
    motionSettings.interactiveScale,
    motionSettings.interactiveLift,
  );
  const nativeProps = toMotionDomProps(rest);

  const handleClick = useCallback(() => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    });
  }, [value]);

  return (
    <motion.button
      {...nativeProps}
      type={type}
      {...interactiveMotion}
      className={cx(buttonBaseClass, buttonToneClasses[tone], buttonSizeClasses[size])}
      onClick={handleClick}
    >
      <Icon
        name={copied ? "check" : "copy"}
        size="sm"
        tone={tone === "primary" || tone === "danger" ? "inverse" : "accent"}
      />
      <span>{copied ? copiedLabel : label}</span>
    </motion.button>
  );
}
