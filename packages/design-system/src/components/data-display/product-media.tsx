import type { ImgHTMLAttributes } from "react";
import { cx } from "../../utils/cx";

export interface ProductMediaImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "className"> {
  className?: string;
}

export function ProductMediaImage({ className, ...props }: ProductMediaImageProps) {
  return <img {...props} className={cx("block h-full w-full object-contain", className)} />;
}
