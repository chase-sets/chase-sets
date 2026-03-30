import type { HTMLAttributes } from "react";
import { Icon } from "../../icons";

export type RatingSize = "sm" | "md" | "lg";

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
          <Icon name={iconName} size={size} tone="warning" />
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
