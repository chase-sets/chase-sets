import type { HTMLAttributes, ReactNode } from "react";
import { motion } from "motion/react";
import { useChaseMotion } from "../../theme/provider";
import { cx } from "../../utils/cx";
import { toMotionDomProps } from "../../utils/motion-props";

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  children?: ReactNode;
  media?: ReactNode;
  interactive?: boolean;
  variant?: "default" | "product" | "feature" | "stat";
  glow?: boolean;
}

export function Card({ children, media, interactive = false, variant = "default", glow = false, ...rest }: CardProps) {
  const motionSettings = useChaseMotion();
  const interactiveMotion =
    interactive && !motionSettings.reducedMotion
      ? {
          whileHover: { y: motionSettings.interactiveLift, scale: motionSettings.interactiveScale },
          whileTap: { y: 0, scale: 0.99 },
          transition: { duration: motionSettings.durations.base, ease: motionSettings.easing },
        }
      : undefined;
  const nativeProps = toMotionDomProps(rest);

  return (
    <motion.div
      {...nativeProps}
      {...interactiveMotion}
      className={cx(
        "glass-surface overflow-hidden rounded-tokenLg border border-muted shadow-tokenSm",
        variant === "product" && "bg-surface",
        variant === "feature" && "bg-surface-2",
        variant === "stat" && "bg-surface-2",
        interactive && "cursor-pointer transition hover:border-accent hover:shadow-tokenMd",
        glow && "glow-accent",
        !media && "p-4",
      )}
    >
      {media ? (
        <>
          <div>{media}</div>
          <div className="p-4">{children}</div>
        </>
      ) : (
        children
      )}
    </motion.div>
  );
}

export interface DetailPanelProps extends Omit<CardProps, "title"> {
  title: ReactNode;
  actions?: ReactNode;
}

export function DetailPanel({ title, actions, children, ...rest }: DetailPanelProps) {
  return (
    <Card {...rest}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="font-heading text-lg font-semibold text-foreground">{title}</div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      {children != null ? <div className="space-y-4">{children}</div> : null}
    </Card>
  );
}
