import { useId, type SVGAttributes } from "react";

export const chaseSetsLogoSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1254" height="1254" viewBox="0 0 1254 1254">
  <style>
    /* brand foil: the design-system presentation term for the gold gradient
       carried by --chase-logo-start/mid/end. Distinct from "holofoil", the
       catalog finish option key owned by bounded-contexts/catalog/GLOSSARY.md. */
    :root {
      --chase-logo-start: #8a682a;
      --chase-logo-mid: #c9a44e;
      --chase-logo-end: #a87e2f;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --chase-logo-start: #b9863b;
        --chase-logo-mid: #edd28d;
        --chase-logo-end: #d4a94e;
      }
    }

    @media (forced-colors: active) {
      #logoGradient stop {
        stop-color: CanvasText;
      }
    }
  </style>
  <defs>
    <linearGradient id="logoGradient" gradientUnits="userSpaceOnUse" x1="248" y1="420" x2="1012" y2="842">
      <stop offset="0" stop-color="var(--chase-logo-start)"/>
      <stop offset="0.52" stop-color="var(--chase-logo-mid)"/>
      <stop offset="1" stop-color="var(--chase-logo-end)"/>
    </linearGradient>
  </defs>
  <g fill="url(#logoGradient)">
    <path d="M638 66 L988 310 L867 395 L640 246 L423 393 L423 488 L735 706 L628 788 L272 538 L272 323 Z"/>
    <path d="M647 385 L994 621 L994 852 L645 1108 L286 842 L399 759 L630 928 L832 778 L832 666 L540 461 Z"/>
  </g>
</svg>`;

export interface ChaseSetsLogoProps extends Omit<
  SVGAttributes<SVGSVGElement>,
  "children" | "color" | "height" | "width"
> {
  colorMode?: "auto" | "light" | "dark";
  decorative?: boolean;
  size?: number | string;
  title?: string;
}

export function ChaseSetsLogo({
  colorMode = "auto",
  decorative = false,
  size = 24,
  title = "Chase Sets",
  ...rest
}: ChaseSetsLogoProps) {
  const gradientId = `chase-sets-logo-${useId().replaceAll(":", "")}`;
  const accessibleTitle = decorative ? undefined : title;
  const lightPalette = {
    start: "#8a682a",
    mid: "#c9a44e",
    end: "#a87e2f",
  };
  const darkPalette = {
    start: "#b9863b",
    mid: "#edd28d",
    end: "#d4a94e",
  };
  const forcedPalette = colorMode === "dark" ? darkPalette : lightPalette;

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
      data-color-mode={colorMode}
      focusable="false"
    >
      {/* Forced-colors fallback scoped to this instance's gradient id: the CSS
          rule outranks the stop-color presentation attributes, so a forced
          palette flattens the brand foil to a visible system colour. */}
      <style>{`@media (forced-colors: active) { #${gradientId} stop { stop-color: CanvasText; } }`}</style>
      <defs>
        <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1="248" y1="420" x2="1012" y2="842">
          <stop
            offset="0"
            stopColor={colorMode === "auto" ? "var(--chase-logo-start, #8a682a)" : forcedPalette.start}
          />
          <stop offset="0.52" stopColor={colorMode === "auto" ? "var(--chase-logo-mid, #c9a44e)" : forcedPalette.mid} />
          <stop offset="1" stopColor={colorMode === "auto" ? "var(--chase-logo-end, #a87e2f)" : forcedPalette.end} />
        </linearGradient>
      </defs>
      <g fill={`url(#${gradientId})`}>
        <path d="M638 66 L988 310 L867 395 L640 246 L423 393 L423 488 L735 706 L628 788 L272 538 L272 323 Z" />
        <path d="M647 385 L994 621 L994 852 L645 1108 L286 842 L399 759 L630 928 L832 778 L832 666 L540 461 Z" />
      </g>
    </svg>
  );
}
