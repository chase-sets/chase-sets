import type { HTMLAttributes, ReactNode } from "react";
import { motion } from "motion/react";
import { useChaseMotion } from "../../theme/provider";
import { cx } from "../../utils/cx";

export interface CardProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> {
  children?: ReactNode;
  media?: ReactNode;
  interactive?: boolean;
}

export function Card({
  children,
  media,
  interactive = false,
  ...rest
}: CardProps) {
  const motionSettings = useChaseMotion();
  const interactiveMotion =
    interactive && !motionSettings.reducedMotion
      ? {
          whileHover: { y: motionSettings.interactiveLift, scale: motionSettings.interactiveScale },
          whileTap: { y: 0, scale: 0.99 },
          transition: { duration: motionSettings.durations.base, ease: motionSettings.easing }
        }
      : undefined;
  const nativeProps = rest as unknown as Record<string, unknown>;

  return (
    <motion.div
      {...nativeProps}
      {...interactiveMotion}
      className={cx(
        "modern-surface overflow-hidden rounded-tokenLg border border-muted shadow-tokenSm",
        interactive && "cursor-pointer transition hover:border-accent hover:shadow-tokenMd",
        !media && "p-4"
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

export function DetailPanel({
  title,
  actions,
  children,
  ...rest
}: DetailPanelProps) {
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
