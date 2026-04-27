import { useId, type SVGAttributes } from "react";

export const chaseSetsLogoSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1254" height="1254" viewBox="0 0 1254 1254">
  <defs>
    <linearGradient id="logoGradient" gradientUnits="userSpaceOnUse" x1="248" y1="420" x2="1012" y2="842">
      <stop offset="0" stop-color="#05c2ef"/>
      <stop offset="0.48" stop-color="#1d64ff"/>
      <stop offset="1" stop-color="#702cff"/>
    </linearGradient>
  </defs>
  <g fill="url(#logoGradient)">
    <path d="M638 66 L988 310 L867 395 L640 246 L423 393 L423 488 L735 706 L628 788 L272 538 L272 323 Z"/>
    <path d="M647 385 L994 621 L994 852 L645 1108 L286 842 L399 759 L630 928 L832 778 L832 666 L540 461 Z"/>
  </g>
</svg>`;

export interface ChaseSetsLogoProps
  extends Omit<SVGAttributes<SVGSVGElement>, "children" | "color" | "height" | "width"> {
  decorative?: boolean;
  size?: number | string;
  title?: string;
}

export function ChaseSetsLogo({
  decorative = false,
  size = 24,
  title = "Chase Sets",
  ...rest
}: ChaseSetsLogoProps) {
  const gradientId = `chase-sets-logo-${useId().replaceAll(":", "")}`;
  const accessibleTitle = decorative ? undefined : title;

  return (
    <svg
      {...rest}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 1254 1254"
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={accessibleTitle}
      focusable="false"
    >
      <defs>
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1="248"
          y1="420"
          x2="1012"
          y2="842"
        >
          <stop offset="0" stopColor="#05c2ef" />
          <stop offset="0.48" stopColor="#1d64ff" />
          <stop offset="1" stopColor="#702cff" />
        </linearGradient>
      </defs>
      <g fill={`url(#${gradientId})`}>
        <path d="M638 66 L988 310 L867 395 L640 246 L423 393 L423 488 L735 706 L628 788 L272 538 L272 323 Z" />
        <path d="M647 385 L994 621 L994 852 L645 1108 L286 842 L399 759 L630 928 L832 778 L832 666 L540 461 Z" />
      </g>
    </svg>
  );
}
