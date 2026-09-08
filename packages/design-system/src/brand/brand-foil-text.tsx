import type { ReactNode } from "react";

export interface BrandFoilTextProps {
  children: ReactNode;
}

/**
 * The one gold-foil treatment permitted per rendered page (epic #6026,
 * ratified 2026-07-23): an inline phrasing span consuming the canonical
 * `--chase-logo-*` stops via the `ds-brand-foil-text` recipe. Adds no role or
 * second accessible name, so it composes inside an existing heading's text.
 */
export function BrandFoilText({ children }: BrandFoilTextProps) {
  return <span className="ds-brand-foil-text">{children}</span>;
}
