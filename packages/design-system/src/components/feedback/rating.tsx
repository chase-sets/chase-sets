import type { HTMLAttributes } from "react";
import { Icon } from "../../icons";

export type RatingSize = "sm" | "md" | "lg";

export interface RatingProps extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "style" | "onChange"> {
  value: number;
  max?: number;
  size?: RatingSize;
  interactive?: boolean;
  onValueChange?: (value: number) => void;
  label?: string;
  /** What a read-only rating says it is, localized by the caller; defaults to "{label}: {value} out of {max}". */
  valueText?: string;
}

export function Rating({
  value,
  max = 5,
  size = "md",
  interactive = false,
  onValueChange,
  label = "Rating",
  valueText,
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
          <Icon name={iconName} size={size} tone="warning" />
        </button>
      );
    }

    return <Icon key={position} name={iconName} size={size} tone="warning" />;
  });

  return (
    <div
      {...rest}
      // A read-only rating is one image whose name is its value; its stars are hidden.
      role={interactive ? "radiogroup" : "img"}
      aria-label={interactive ? label : (valueText ?? `${label}: ${value} out of ${max}`)}
      className="inline-flex items-center gap-0.5"
    >
      {stars}
    </div>
  );
}
