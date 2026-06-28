import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  Surface,
  ToneIcon,
  surfaceSemanticToneClasses,
  type SurfaceSemanticTone,
  type ToneIconSize,
  type ToneIconTone,
} from "../index";
import { toneIconSizeClasses, toneIconToneClasses } from "../primitives/tone-icon";

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
  it.each(["default", "muted", "accent", "subtle"] as const)(
    "renders the %s structural tone without changing the content contract",
    (tone) => {
      render(
        <Surface tone={tone} data-testid={`${tone}-surface`}>
          {tone} content
        </Surface>,
      );

      expect(screen.getByTestId(`${tone}-surface`).textContent).toBe(`${tone} content`);
    },
  );

  it.each(Object.keys(semanticTones) as SurfaceSemanticTone[])(
    "renders the %s semantic tone without changing the content contract",
    (tone) => {
      render(
        <Surface tone={tone} data-testid={`${tone}-surface`}>
          {tone} content
        </Surface>,
      );

      expect(screen.getByTestId(`${tone}-surface`).textContent).toBe(`${tone} content`);
    },
  );

  it("exposes the semantic tone map as the canonical border/bg/text triple", () => {
    for (const [tone, classes] of Object.entries(semanticTones)) {
      expect(surfaceSemanticToneClasses[tone as SurfaceSemanticTone]).toBe(
        `${classes.border} ${classes.bg} ${classes.text}`,
      );
    }
  });

  it("renders the requested element and content without exposing a custom element contract", () => {
    render(
      <Surface element="section" tone="success" data-testid="status-surface">
        Import completed
      </Surface>,
    );

    const surface = screen.getByTestId("status-surface");
    expect(surface.tagName).toBe("SECTION");
    expect(surface.textContent).toContain("Import completed");
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

  it("renders as a decorative badge by default", () => {
    const { container } = render(<ToneIcon name="shield" tone="trust" data-testid="trust-badge" />);

    expect(screen.getByTestId("trust-badge").tagName).toBe("SPAN");
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it.each(Object.entries(sizeClassMap))("exports the %s badge size token", (size, sizeClass) => {
    expect(toneIconSizeClasses[size as ToneIconSize]).toBe(sizeClass);
  });

  it.each(Object.entries(toneTints))("exports the %s badge soft token pair", (tone, tint) => {
    expect(toneIconToneClasses[tone as ToneIconTone]).toBe(`${tint.bg} ${tint.text}`);
  });

  it("passes an accessible label through to the inner Icon", () => {
    render(<ToneIcon name="shield" tone="trust" label="Buyer protection" />);

    expect(screen.getByLabelText("Buyer protection")).toBeTruthy();
  });
});
