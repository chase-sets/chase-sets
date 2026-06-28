import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Fieldset,
  FormRow,
  FormSection,
  Progress,
  ProgressBar,
  ProgressTrack,
  type SurfaceSemanticTone,
} from "../index";

const semanticFillTones: Record<SurfaceSemanticTone, string> = {
  neutral: "bg-secondary",
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  trust: "bg-trust",
  primary: "bg-accent",
};

describe("ProgressTrack primitive", () => {
  it("exposes the determinate progressbar ARIA contract", () => {
    render(<ProgressTrack value={42} label="Upload progress" />);

    const bar = screen.getByRole("progressbar", { name: "Upload progress" });
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
  });

  it("drives the fill width through a single inline style inside the primitive", () => {
    const { container } = render(<ProgressTrack value={73} />);

    const fill = container.querySelector("[style]");
    expect(fill?.getAttribute("style")).toContain("width: 73%");
  });

  it("clamps the value and the reported aria-valuenow to 0–100", () => {
    const { container: low } = render(<ProgressTrack value={-20} />);
    expect(low.querySelector("[role='progressbar']")?.getAttribute("aria-valuenow")).toBe("0");
    expect(low.querySelector("[style]")?.getAttribute("style")).toContain("width: 0%");

    const { container: high } = render(<ProgressTrack value={150} />);
    expect(high.querySelector("[role='progressbar']")?.getAttribute("aria-valuenow")).toBe("100");
    expect(high.querySelector("[style]")?.getAttribute("style")).toContain("width: 100%");
  });

  it("defaults to the primary fill tone and the medium size", () => {
    const markup = renderToString(<ProgressTrack value={50} />);
    expect(markup).toContain("bg-accent");
    expect(markup).toContain("h-2");
  });

  it.each(Object.entries(semanticFillTones))("renders the saturated %s fill from the shared tone set", (tone, fill) => {
    const markup = renderToString(<ProgressTrack value={50} tone={tone as SurfaceSemanticTone} />);
    expect(markup).toContain(fill);
  });

  it("resolves the size scale to track thickness", () => {
    expect(renderToString(<ProgressTrack value={10} size="sm" />)).toContain("h-1.5");
    expect(renderToString(<ProgressTrack value={10} size="lg" />)).toContain("h-3");
  });
});

describe("ProgressBar built on ProgressTrack", () => {
  it("preserves the progressbar role and clamped percentage from value/max", () => {
    render(<ProgressBar value={30} max={60} formatLabel={(p) => `${Math.round(p)}% done`} />);

    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
    expect(screen.getByText("50% done")).toBeTruthy();
  });

  it("maps canonical tone names onto the shared fill colors", () => {
    expect(renderToString(<ProgressBar value={50} tone="accent" />)).toContain("bg-accent");
    expect(renderToString(<ProgressBar value={50} tone="neutral" />)).toContain("bg-secondary");
    expect(renderToString(<ProgressBar value={50} tone="danger" />)).toContain("bg-danger");
    expect(renderToString(<ProgressBar value={50} tone="info" />)).toContain("bg-info");
  });
});

describe("Progress built on ProgressTrack", () => {
  it("keeps the shared tone vocabulary and exposes the progressbar role", () => {
    render(<Progress value={25} tone="success" label="Sync" />);

    const bar = screen.getByRole("progressbar", { name: "Sync" });
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
    expect(renderToString(<Progress value={25} tone="accent" />)).toContain("bg-accent");
    expect(renderToString(<Progress value={25} tone="danger" />)).toContain("bg-danger");
  });
});

describe("FormRow primitive", () => {
  it("stacks on mobile and resolves two columns from sm by default", () => {
    const markup = renderToString(
      <FormRow>
        <span>First</span>
        <span>Last</span>
      </FormRow>,
    );

    expect(markup).toContain("grid");
    expect(markup).toContain("grid-cols-1");
    expect(markup).toContain("sm:grid-cols-2");
    expect(markup).toContain("First");
    expect(markup).toContain("Last");
  });

  it("supports three- and four-column layouts and passes attributes through", () => {
    expect(renderToString(<FormRow columns={3}>x</FormRow>)).toContain("sm:grid-cols-3");

    const markup = renderToString(
      <FormRow columns={4} data-testid="row">
        x
      </FormRow>,
    );
    expect(markup).toContain("sm:grid-cols-4");
    expect(markup).toContain('data-testid="row"');
  });
});

describe("Fieldset rebuilt on Surface + Stack", () => {
  it("renders a native fieldset whose legend names the group and exposes the description", () => {
    render(
      <Fieldset legend="Shipping address" description="Where the order ships.">
        <input aria-label="Street" />
      </Fieldset>,
    );

    const group = screen.getByRole("group", { name: "Shipping address" });
    expect(group.tagName).toBe("FIELDSET");
    expect(screen.getByText("Shipping address")).toBeTruthy();
    expect(screen.getByText("Where the order ships.")).toBeTruthy();
    expect(screen.getByLabelText("Street")).toBeTruthy();
  });

  it("composes the canonical flat surface chrome and stacked rhythm", () => {
    const { container } = render(<Fieldset legend="Details">body</Fieldset>);

    const fieldset = container.querySelector("fieldset");
    expect(fieldset?.className).toContain("rounded-tokenLg");
    expect(fieldset?.className).toContain("bg-surface");
    expect(fieldset?.className).toContain("border-muted");
    expect(fieldset?.className).not.toContain("space-y-4");
    expect(container.querySelector(".flex.flex-col")).toBeTruthy();
  });

  it("forwards pass-through attributes through Surface to the Base UI fieldset root", () => {
    const { container } = render(
      <Fieldset legend="Billing" id="billing-fieldset" data-section="billing">
        <input aria-label="Card" />
      </Fieldset>,
    );

    const fieldset = container.querySelector("fieldset");
    expect(fieldset?.getAttribute("id")).toBe("billing-fieldset");
    expect(fieldset?.getAttribute("data-section")).toBe("billing");
  });
});

describe("FormSection rebuilt on Surface + Stack", () => {
  it("renders a titled section with an elevated surface and a heading", () => {
    const { container } = render(
      <FormSection title="Payment" description="Choose how to pay.">
        <input aria-label="Card number" />
      </FormSection>,
    );

    const section = container.querySelector("section");
    expect(section?.className).toContain("rounded-tokenLg");
    expect(section?.className).toContain("shadow-tokenSm");
    expect(screen.getByRole("heading", { name: "Payment", level: 3 })).toBeTruthy();
    expect(screen.getByText("Choose how to pay.")).toBeTruthy();
    expect(screen.getByLabelText("Card number")).toBeTruthy();
  });
});
