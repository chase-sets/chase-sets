import type { HTMLAttributes, ReactNode } from "react";
import { Icon } from "../../icons";
import { cx } from "../../utils/cx";
import { type Tone, softToneClasses, toneIcon } from "./shared";

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
