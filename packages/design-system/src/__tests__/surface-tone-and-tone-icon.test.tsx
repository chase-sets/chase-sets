import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Surface,
  ToneIcon,
  surfaceSemanticToneClasses,
  type SurfaceSemanticTone,
  type ToneIconSize,
  type ToneIconTone,
} from "../index";

const semanticTones: Record<SurfaceSemanticTone, { border: string; bg: string; text: string }> = {
  neutral: { border: "border-muted", bg: "bg-surface-2", text: "text-secondary" },
  info: { border: "border-info-soft", bg: "bg-info-soft", text: "text-info" },
  success: { border: "border-success-soft", bg: "bg-success-soft", text: "text-success" },
  warning: { border: "border-warning-soft", bg: "bg-warning-soft", text: "text-warning" },
  danger: { border: "border-danger-soft", bg: "bg-danger-soft", text: "text-danger" },
  trust: { border: "border-trust-soft", bg: "bg-trust-soft", text: "text-trust" },
  primary: { border: "border-primary-soft", bg: "bg-primary-soft", text: "text-primary" },
};

describe("Surface semantic tones", () => {
  it("keeps the structural tones rendering unchanged", () => {
    expect(renderToString(<Surface>Default chrome</Surface>)).toContain("glass-surface bg-elevated");
    expect(renderToString(<Surface tone="muted">Recessed</Surface>)).toContain("bg-surface-2");
    expect(renderToString(<Surface tone="accent">Brand</Surface>)).toContain("brand-gradient text-accent-contrast");
    expect(renderToString(<Surface tone="subtle">Flat</Surface>)).toContain("bg-surface border-muted");
  });

  it.each(Object.entries(semanticTones))("renders the canonical soft token triple for the %s tone", (tone, classes) => {
    const markup = renderToString(<Surface tone={tone as SurfaceSemanticTone}>{tone}</Surface>);

    expect(markup).toContain(classes.border);
    expect(markup).toContain(classes.bg);
    expect(markup).toContain(classes.text);
  });

  it("exposes the semantic tone map as the canonical border/bg/text triple", () => {
    for (const [tone, classes] of Object.entries(semanticTones)) {
      expect(surfaceSemanticToneClasses[tone as SurfaceSemanticTone]).toBe(
        `${classes.border} ${classes.bg} ${classes.text}`,
      );
    }
  });
});

describe("ToneIcon", () => {
  const sizeClassMap: Record<ToneIconSize, string> = {
    sm: "h-7 w-7",
    md: "h-9 w-9",
    lg: "h-11 w-11",
  };

  const toneTints: Record<ToneIconTone, { bg: string; text: string }> = {
    neutral: { bg: "bg-surface-2", text: "text-secondary" },
    info: { bg: "bg-info-soft", text: "text-info" },
    success: { bg: "bg-success-soft", text: "text-success" },
    warning: { bg: "bg-warning-soft", text: "text-warning" },
    danger: { bg: "bg-danger-soft", text: "text-danger" },
    trust: { bg: "bg-trust-soft", text: "text-trust" },
    primary: { bg: "bg-primary-soft", text: "text-primary" },
  };

  it("renders a tinted circle wrapping the design-system Icon", () => {
    const markup = renderToString(<ToneIcon name="shield" tone="trust" />);

    expect(markup).toContain("inline-flex");
    expect(markup).toContain("items-center");
    expect(markup).toContain("justify-center");
    expect(markup).toContain("rounded-tokenFull");
  });

  it.each(Object.entries(sizeClassMap))("sizes the %s badge with its size token", (size, sizeClass) => {
    const markup = renderToString(<ToneIcon name="check" size={size as ToneIconSize} />);

    expect(markup).toContain(sizeClass);
  });

  it.each(Object.entries(toneTints))("tints the %s badge with the soft token pair", (tone, tint) => {
    const markup = renderToString(<ToneIcon name="info" tone={tone as ToneIconTone} />);

    expect(markup).toContain(tint.bg);
    expect(markup).toContain(tint.text);
  });

  it("passes an accessible label through to the inner Icon", () => {
    const markup = renderToString(<ToneIcon name="shield" tone="trust" label="Buyer protection" />);

    expect(markup).toContain('aria-label="Buyer protection"');
  });
});
