import type { ImgHTMLAttributes } from "react";
import { cx } from "../../utils/cx";

export interface ResponsiveImageSource {
  src: string;
  srcSet?: string;
  sizes?: string;
  width?: ImgHTMLAttributes<HTMLImageElement>["width"];
  height?: ImgHTMLAttributes<HTMLImageElement>["height"];
}

export interface ProductMediaImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "className"> {
  image?: ResponsiveImageSource;
  className?: string;
}

export function ProductMediaImage({ image, className, ...props }: ProductMediaImageProps) {
  return <img {...image} {...props} className={cx("block h-full w-full object-contain", className)} />;
}
