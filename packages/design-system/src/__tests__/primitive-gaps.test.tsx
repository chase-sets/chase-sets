import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { QuantityStepper } from "../components/forms";
import { CurrencyInput } from "../components/forms";
import { ChaseRoot } from "../theme/provider";
import { Image } from "../components/data-display";
import {
  ActionRow,
  ActionStack,
  CheckoutNoticeStack,
  CheckoutStickyActionBar,
  CheckoutSummaryLineItem,
  CheckoutTotals,
  DestructiveAction,
  MarketplaceNotice,
  PageStepper,
  PriceBreakdown,
  StickyCtaBar,
  SecurePaymentIndicator,
  selectCheckoutNotice,
} from "../index";
import {
  AspectRatio,
  Bleed,
  Center,
  DesktopActionBar,
  EmbeddedProviderSurface,
  Grid,
  IconRow,
  LiveRegion,
  MountPoint,
  MediaFrame,
  MobileStickyBar,
  Show,
  Slot,
  StickyBar,
} from "../primitives/layout";
import { Heading, Text } from "../primitives/typography";

describe("Image primitive", () => {
  it("lazy-loads by default and exposes a loading hint", () => {
    const markup = renderToString(<Image src="/card.jpg" alt="Charizard" />);

    expect(markup).toContain('loading="lazy"');
    expect(markup).toContain('alt="Charizard"');
    expect(markup).toContain('src="/card.jpg"');
  });

  it("honours an eager loading override", () => {
    const markup = renderToString(<Image src="/card.jpg" alt="Charizard" loading="eager" />);

    expect(markup).toContain('loading="eager"');
  });

  it("shows a skeleton placeholder until the image loads", () => {
    const { container } = render(<Image src="/card.jpg" alt="Charizard" />);

    expect(container.querySelector(".animate-pulse")).toBeTruthy();
    const image = screen.getByAltText("Charizard");
    expect(image.className).toContain("opacity-0");

    fireEvent.load(image);

    expect(container.querySelector(".animate-pulse")).toBeNull();
    expect(screen.getByAltText("Charizard").className).toContain("opacity-100");
  });

  /**
   * JSDOM never dispatches a `load` event for an <img>, and it always reports
   * `complete === false` / `naturalWidth === 0`. To model an SSR image whose load
   * settled before React's synthetic handlers attached, we stub the prototype getters
   * the component's mount effect reads, render, then restore the originals. `byHref`
   * lets a single render expose different states per source (for the fallback path).
   */
  function withStubbedImageState(
    byHref: (href: string) => { complete: boolean; naturalWidth: number },
    run: () => void,
  ) {
    const proto = HTMLImageElement.prototype;
    const originalComplete = Object.getOwnPropertyDescriptor(proto, "complete");
    const originalNaturalWidth = Object.getOwnPropertyDescriptor(proto, "naturalWidth");

    Object.defineProperty(proto, "complete", {
      configurable: true,
      get(this: HTMLImageElement) {
        return byHref(this.getAttribute("src") ?? "").complete;
      },
    });
    Object.defineProperty(proto, "naturalWidth", {
      configurable: true,
      get(this: HTMLImageElement) {
        return byHref(this.getAttribute("src") ?? "").naturalWidth;
      },
    });

    try {
      run();
    } finally {
      restore(proto, "complete", originalComplete);
      restore(proto, "naturalWidth", originalNaturalWidth);
    }
  }

  function restore(target: object, key: string, descriptor: PropertyDescriptor | undefined) {
    if (descriptor) {
      Object.defineProperty(target, key, descriptor);
    } else {
      delete (target as Record<string, unknown>)[key];
    }
  }

  it("clears the skeleton when the image completed before hydration attached onLoad", () => {
    // The on-mount effect must reconcile from the live <img> rather than wait for onLoad.
    withStubbedImageState(
      () => ({ complete: true, naturalWidth: 1 }),
      () => {
        const { container } = render(<Image src="/card.jpg" alt="Charizard" />);

        const image = screen.getByAltText("Charizard");
        expect(image.className).toContain("opacity-100");
        expect(image.className).not.toContain("opacity-0");
        expect(container.querySelector(".animate-pulse")).toBeNull();
      },
    );
  });

  it("keeps the skeleton for an image that is still downloading at mount", () => {
    // An incomplete <img> must stay covered by the skeleton until it actually loads.
    withStubbedImageState(
      () => ({ complete: false, naturalWidth: 0 }),
      () => {
        const { container } = render(<Image src="/card.jpg" alt="Charizard" />);

        const image = screen.getByAltText("Charizard");
        expect(image.className).toContain("opacity-0");
        expect(container.querySelector(".animate-pulse")).toBeTruthy();

        fireEvent.load(image);

        expect(screen.getByAltText("Charizard").className).toContain("opacity-100");
        expect(container.querySelector(".animate-pulse")).toBeNull();
      },
    );
  });

  it("falls back when the image errored before hydration attached onError", () => {
    // The primary source completed with zero natural width (a pre-hydration error); the
    // effect must route to the fallback source without ever seeing a synthetic onError.
    withStubbedImageState(
      (href) => (href === "/missing.png" ? { complete: true, naturalWidth: 0 } : { complete: true, naturalWidth: 1 }),
      () => {
        render(<Image src="/missing.png" alt="Charizard" fallbackSrc="/card-back.png" />);

        expect(screen.getByAltText("Charizard").getAttribute("src")).toBe("/card-back.png");
      },
    );
  });

  it("can opt out of the skeleton placeholder", () => {
    const { container } = render(<Image src="/card.jpg" alt="Charizard" skeleton={false} />);

    expect(container.querySelector(".animate-pulse")).toBeNull();
  });

  it("swaps to the fallback source when the primary image fails", () => {
    render(<Image src="/missing.png" alt="Charizard" fallbackSrc="/card-back.png" />);

    fireEvent.error(screen.getByAltText("Charizard"));

    expect(screen.getByAltText("Charizard").getAttribute("src")).toBe("/card-back.png");
  });

  it("renders the fallback node once every source fails", () => {
    render(<Image src="/missing.png" alt="Charizard" fallback={<span>No image</span>} />);

    fireEvent.error(screen.getByAltText("Charizard"));

    expect(screen.getByText("No image")).toBeTruthy();
    expect(screen.queryByAltText("Charizard")).toBeNull();
  });

  it("applies the requested object fit", () => {
    const markup = renderToString(<Image src="/card.jpg" alt="Charizard" fit="contain" />);

    expect(markup).toContain("object-contain");
  });

  it("self-sizes to an intrinsic width and applies rounding when requested", () => {
    const { container } = render(<Image src="/card.jpg" alt="Charizard" width={180} rounded />);

    const wrapper = container.querySelector("span");
    expect(wrapper?.getAttribute("style")).toContain("width: 180px");
    expect(wrapper?.getAttribute("style")).toContain("max-width: 100%");
    expect(wrapper?.className).toContain("rounded-tokenMd");
    expect(screen.getByAltText("Charizard").className).toContain("h-auto");
  });

  it("fills its container by default without an inline width", () => {
    const { container } = render(<Image src="/card.jpg" alt="Charizard" />);

    const wrapper = container.querySelector("span");
    expect(wrapper?.getAttribute("style")).toBeNull();
    expect(wrapper?.className).toContain("h-full");
  });
});

describe("DesktopActionBar primitive", () => {
  it("hides on mobile, shows as a flex row from md, and passes contract attributes through", () => {
    const markup = renderToString(
      <DesktopActionBar data-primary-action-count="1">
        <button type="submit">Confirm</button>
      </DesktopActionBar>,
    );

    expect(markup).toContain("hidden md:flex md:items-center md:gap-2");
    expect(markup).toContain('data-primary-action-count="1"');
  });
});

describe("Show primitive", () => {
  it("reveals content from a breakpoint up", () => {
    const markup = renderToString(
      <Show from="md" minWidth="0">
        <span>Desktop</span>
      </Show>,
    );

    expect(markup).toContain("hidden md:block");
    expect(markup).toContain("min-w-0");
  });

  it("shows content only below a breakpoint", () => {
    const markup = renderToString(
      <Show until="md">
        <span>Mobile</span>
      </Show>,
    );

    expect(markup).toContain("md:hidden");
  });

  it("supports the above/below aliases across breakpoints", () => {
    const above = renderToString(
      <Show above="lg" display="flex">
        <span>Wide</span>
      </Show>,
    );
    const below = renderToString(
      <Show below="sm">
        <span>Narrow</span>
      </Show>,
    );

    expect(above).toContain("hidden lg:flex");
    expect(below).toContain("sm:hidden");
  });
});

describe("IconRow primitive", () => {
  it("pins the icon, nudges it at the top by default, and lets content shrink", () => {
    const { container } = render(
      <IconRow icon={<svg data-testid="icon" />} data-testid="row">
        <span>Body</span>
      </IconRow>,
    );

    const row = screen.getByTestId("row");
    expect(row.className).toContain("flex");
    expect(row.className).toContain("items-start");

    const iconSlot = container.querySelector('[aria-hidden="true"]');
    expect(iconSlot?.className).toContain("shrink-0");
    expect(iconSlot?.className).toContain("mt-0.5");
    expect(container.querySelector(".min-w-0")?.textContent).toContain("Body");
  });

  it("centers the icon and drops the nudge when aligned center", () => {
    const { container } = render(
      <IconRow icon={<svg />} align="center" data-testid="row">
        <span>Body</span>
      </IconRow>,
    );

    expect(screen.getByTestId("row").className).toContain("items-center");
    expect(container.querySelector('[aria-hidden="true"]')?.className).not.toContain("mt-0.5");
  });
});

describe("StickyBar primitive", () => {
  it("pins to the bottom with a frosted backdrop and passes contract attributes through", () => {
    const markup = renderToString(
      <StickyBar data-primary-action-count="1">
        <button type="submit">Buy</button>
      </StickyBar>,
    );

    expect(markup).toContain("fixed inset-x-0");
    expect(markup).toContain("bottom-0");
    expect(markup).toContain("pb-[max(0.5rem,env(safe-area-inset-bottom))]");
    expect(markup).toContain("backdrop-blur-xl");
    expect(markup).toContain('data-primary-action-count="1"');
  });

  it("supports a top edge, a hide-from breakpoint, and an opaque variant", () => {
    const markup = renderToString(
      <StickyBar position="top" hideFrom="md" backdrop={false}>
        <span>Top</span>
      </StickyBar>,
    );

    expect(markup).toContain("top-0");
    expect(markup).toContain("md:hidden");
    expect(markup).toContain("bg-background");
    expect(markup).not.toContain("backdrop-blur-xl");
  });

  it("keeps MobileStickyBar rendering the same fixed bottom chrome", () => {
    const markup = renderToString(
      <MobileStickyBar>
        <span>Cta</span>
      </MobileStickyBar>,
    );

    expect(markup).toContain("fixed inset-x-0");
    expect(markup).toContain("bottom-0");
    expect(markup).toContain("md:hidden");
    expect(markup).toContain("backdrop-blur-xl");
  });
});

describe("MediaFrame primitive", () => {
  it("renders a fixed, bordered, clipped media frame at the default md size", () => {
    const markup = renderToString(
      <MediaFrame>
        <Image src="/card.jpg" alt="Charizard" fit="contain" />
      </MediaFrame>,
    );

    expect(markup).toContain("h-24 w-20");
    expect(markup).toContain("sm:h-28 sm:w-24");
    expect(markup).toContain("shrink-0");
    expect(markup).toContain("overflow-hidden");
  });

  it("resolves the generic sm/md/lg size scale", () => {
    expect(renderToString(<MediaFrame size="sm">x</MediaFrame>)).toContain("h-16 w-14 sm:h-20 sm:w-16");
    expect(renderToString(<MediaFrame size="lg">x</MediaFrame>)).toContain("h-32 w-28 sm:h-36 sm:w-32");
  });
});

describe("EmbeddedProviderSurface primitive", () => {
  it("keeps provider iframes at a usable minimum height", () => {
    const { container } = render(
      <EmbeddedProviderSurface data-testid="provider-surface">
        <iframe title="Provider setup" />
      </EmbeddedProviderSurface>,
    );

    const surface = screen.getByTestId("provider-surface");

    expect(surface.className).toContain("min-h-[36rem]");
    expect(surface.className).toContain("md:min-h-[44rem]");
    expect(surface.className).toContain("[&_iframe]:min-h-[36rem]");
    expect(surface.className).toContain("[&_iframe]:w-full");
    expect(container.querySelector("iframe")).toBeTruthy();
  });
});

describe("LiveRegion primitive", () => {
  it("renders assertive alert regions for urgent messages", () => {
    render(
      <LiveRegion data-testid="live-region">
        <Text>Payment failed</Text>
      </LiveRegion>,
    );

    const region = screen.getByTestId("live-region");
    expect(region.getAttribute("role")).toBe("alert");
    expect(region.getAttribute("aria-live")).toBe("assertive");
    expect(region.getAttribute("aria-atomic")).toBe("true");
  });

  it("renders polite status regions for non-blocking updates", () => {
    render(<LiveRegion politeness="polite">Saved</LiveRegion>);

    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
  });
});

describe("MountPoint and Slot primitives", () => {
  it("forwards refs to sanctioned provider mount hosts", () => {
    const ref = vi.fn();

    render(<MountPoint ref={ref} purpose="provider" data-testid="mount-point" aria-label="Stripe payment" />);

    const mountPoint = screen.getByTestId("mount-point");
    expect(ref).toHaveBeenCalledWith(mountPoint);
    expect(mountPoint.className).toContain("w-full");
    expect(mountPoint.getAttribute("aria-hidden")).toBeNull();
  });

  it("hides observer slots from assistive technology by default", () => {
    render(<Slot purpose="observer" data-testid="sentinel" />);

    const sentinel = screen.getByTestId("sentinel");
    expect(sentinel.getAttribute("aria-hidden")).toBe("true");
    expect(sentinel.className).toContain("h-px");
  });
});

describe("Grid templateColumns", () => {
  it("applies explicit tracks via inline style and merges incoming style", () => {
    const { container } = render(
      <Grid templateColumns="minmax(0,1fr) auto" style={{ rowGap: "8px" }} data-testid="grid">
        <span>content</span>
      </Grid>,
    );

    const grid = screen.getByTestId("grid");
    expect(grid.className).toContain("grid");
    expect(grid.getAttribute("style")).toContain("grid-template-columns: minmax(0,1fr) auto");
    expect(grid.getAttribute("style")).toContain("row-gap: 8px");
    expect(grid.className).not.toContain("grid-cols-1");
  });

  it("stacks below a breakpoint and only resolves tracks above it", () => {
    const markup = renderToString(
      <Grid templateColumns="auto minmax(0,1fr) auto" stackUntil="md" gap={4}>
        <span>content</span>
      </Grid>,
    );

    expect(markup).toContain("min-w-0 md:items-start");
    expect(markup).toContain("md:[grid-template-columns:var(--grid-template-columns-md)]");
    expect(markup).toContain("--grid-template-columns-md:auto minmax(0,1fr) auto");
    expect(markup).not.toContain("gridTemplateColumns");
  });
});

describe("Bleed primitive", () => {
  it("pulls horizontally against the container padding by default", () => {
    const { container } = render(
      <Bleed space={4} data-testid="bleed">
        <div>Media</div>
      </Bleed>,
    );

    const bleed = screen.getByTestId("bleed");
    expect(bleed.className).toContain("-mx-4");
    expect(bleed.className).toContain("max-w-none");
    expect(bleed.className).not.toContain("-my-4");
    expect(container.textContent).toContain("Media");
  });

  it("supports vertical and both-axis bleed", () => {
    render(
      <div>
        <Bleed space={6} axis="vertical" data-testid="bleed-y">
          <div>Y</div>
        </Bleed>
        <Bleed space={5} axis="both" data-testid="bleed-both">
          <div>Both</div>
        </Bleed>
      </div>,
    );

    expect(screen.getByTestId("bleed-y").className).toContain("-my-6");
    expect(screen.getByTestId("bleed-y").className).not.toContain("-mx-6");
    expect(screen.getByTestId("bleed-both").className).toContain("-mx-5");
    expect(screen.getByTestId("bleed-both").className).toContain("-my-5");
  });
});

describe("Center axis control", () => {
  it("centers on both axes by default and respects single-axis options", () => {
    render(
      <div>
        <Center data-testid="center-both">A</Center>
        <Center axis="horizontal" data-testid="center-x">
          B
        </Center>
        <Center axis="vertical" data-testid="center-y">
          C
        </Center>
      </div>,
    );

    expect(screen.getByTestId("center-both").className).toContain("items-center");
    expect(screen.getByTestId("center-both").className).toContain("justify-center");
    expect(screen.getByTestId("center-x").className).toContain("justify-center");
    expect(screen.getByTestId("center-x").className).not.toContain("items-center");
    expect(screen.getByTestId("center-y").className).toContain("items-center");
    expect(screen.getByTestId("center-y").className).not.toContain("justify-center");
  });
});

describe("AspectRatio media options", () => {
  it("clips overflow and applies object-fit hooks to media children", () => {
    const { container } = render(
      <AspectRatio ratio={16 / 9} fit="cover" data-testid="ratio">
        <img src="/card.jpg" alt="Charizard" />
      </AspectRatio>,
    );

    const ratio = screen.getByTestId("ratio");
    expect(ratio.className).toContain("overflow-hidden");
    expect(ratio.className).toContain("[&>img]:object-cover");
    expect(container.querySelector("img")).toBeTruthy();
  });

  it("can opt out of clipping", () => {
    render(
      <AspectRatio ratio={1} clip={false} data-testid="ratio">
        <div>Inner</div>
      </AspectRatio>,
    );

    expect(screen.getByTestId("ratio").className).not.toContain("overflow-hidden");
  });
});

describe("Typography polish", () => {
  it("balances heading line lengths when requested", () => {
    render(
      <Heading balance level={2}>
        A long marketing headline that should balance
      </Heading>,
    );

    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.className).toContain("text-balance");
  });

  it("does not balance headings by default", () => {
    render(<Heading level={2}>Plain heading</Heading>);

    expect(screen.getByRole("heading", { level: 2 }).className).not.toContain("text-balance");
  });

  it("clamps Text to the requested number of lines", () => {
    render(
      <Text lineClamp={3} data-testid="clamped">
        Multi-line description that overflows after three lines.
      </Text>,
    );

    expect(screen.getByTestId("clamped").className).toContain("line-clamp-3");
  });
});

describe("QuantityStepper primitive", () => {
  it("renders decrement and increment buttons with accessible labels", () => {
    render(
      <ChaseRoot>
        <QuantityStepper label="Quantity" defaultValue={2} decrementLabel="Remove one" incrementLabel="Add one" />
      </ChaseRoot>,
    );

    expect(screen.getByRole("button", { name: "Remove one" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add one" })).toBeTruthy();
  });

  it("increments the value within max and fires onValueChange", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(
      <ChaseRoot>
        <QuantityStepper
          label="Quantity"
          defaultValue={3}
          max={5}
          onValueChange={onValueChange}
          incrementLabel="Add one"
          decrementLabel="Remove one"
        />
      </ChaseRoot>,
    );

    await user.click(screen.getByRole("button", { name: "Add one" }));

    expect(onValueChange).toHaveBeenCalledWith(4);
  });

  it("decrements the value within min and fires onValueChange", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(
      <ChaseRoot>
        <QuantityStepper
          label="Quantity"
          defaultValue={2}
          min={1}
          onValueChange={onValueChange}
          incrementLabel="Add one"
          decrementLabel="Remove one"
        />
      </ChaseRoot>,
    );

    await user.click(screen.getByRole("button", { name: "Remove one" }));

    expect(onValueChange).toHaveBeenCalledWith(1);
  });

  it("does not decrement below min", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(
      <ChaseRoot>
        <QuantityStepper
          label="Qty"
          defaultValue={1}
          min={1}
          onValueChange={onValueChange}
          decrementLabel="Remove one"
          incrementLabel="Add one"
        />
      </ChaseRoot>,
    );

    await user.click(screen.getByRole("button", { name: "Remove one" }));

    // At min — callback is either not called, or called with the clamped min value (not below it)
    const calls = onValueChange.mock.calls.map((c) => c[0]);
    expect(calls.every((v: number | null) => v === null || v >= 1)).toBe(true);
  });

  it("disables both buttons when disabled prop is true", () => {
    render(
      <ChaseRoot>
        <QuantityStepper
          label="Quantity"
          defaultValue={1}
          disabled
          decrementLabel="Remove one"
          incrementLabel="Add one"
        />
      </ChaseRoot>,
    );

    expect(screen.getByRole("button", { name: "Remove one" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Add one" }).hasAttribute("disabled")).toBe(true);
  });

  it("disables both buttons when loading prop is true", () => {
    render(
      <ChaseRoot>
        <QuantityStepper
          label="Quantity"
          defaultValue={1}
          loading
          decrementLabel="Remove one"
          incrementLabel="Add one"
        />
      </ChaseRoot>,
    );

    expect(screen.getByRole("button", { name: "Remove one" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Add one" }).hasAttribute("disabled")).toBe(true);
  });

  it("exposes role=spinbutton and inputMode=numeric on the input for keyboard/aria accessibility", () => {
    render(
      <ChaseRoot>
        <QuantityStepper label="Qty" defaultValue={1} decrementLabel="Less" incrementLabel="More" />
      </ChaseRoot>,
    );

    const spinbutton = screen.getByRole("spinbutton");
    expect(spinbutton).toBeTruthy();
    expect(spinbutton.getAttribute("inputmode")).toBe("numeric");
  });

  it("marks the input aria-busy when loading", () => {
    const markup = renderToString(
      <ChaseRoot>
        <QuantityStepper label="Qty" defaultValue={1} loading decrementLabel="Less" incrementLabel="More" />
      </ChaseRoot>,
    );

    expect(markup).toContain('aria-busy="true"');
  });

  it("marks the input aria-invalid when an error is provided", () => {
    const markup = renderToString(
      <ChaseRoot>
        <QuantityStepper
          label="Qty"
          defaultValue={1}
          error="Quantity exceeds available stock"
          decrementLabel="Less"
          incrementLabel="More"
        />
      </ChaseRoot>,
    );

    expect(markup).toContain('aria-invalid="true"');
  });
});

describe("Single numeric-input engine — no bare native number spinners (#3846)", () => {
  it("CurrencyInput builds on the Base UI Number Field: the visible control is type=text with role=spinbutton", () => {
    const markup = renderToString(
      <ChaseRoot>
        <CurrencyInput label="Amount" currencyCode="USD" />
      </ChaseRoot>,
    );

    // Base UI's NumberField.Input renders a text input with role="spinbutton" —
    // the visible, interactive control never has type="number", so there is no
    // wheel-scrub, no native "e"/"+" grammar, and no OS-native spinner chevron
    // to suppress. Base UI's Root also renders one companion `type="number"`
    // input for native HTML form constraint validation (min/max/step/required);
    // it is unconditionally `aria-hidden` and `tabindex="-1"` — never focusable,
    // never rendered to assistive tech, never the element a user interacts with.
    expect(markup).toContain('role="spinbutton"');
    expect(markup).toContain('type="text"');
    expect(markup).toMatch(/aria-hidden="true"[^>]*type="number"|type="number"[^>]*aria-hidden="true"/);
  });

  it("QuantityStepper exposes role=spinbutton (Base UI renders type=text with spinbutton role)", () => {
    render(
      <ChaseRoot>
        <QuantityStepper label="Qty" defaultValue={1} decrementLabel="Less" incrementLabel="More" />
      </ChaseRoot>,
    );

    const spinbutton = screen.getByRole("spinbutton");
    expect(spinbutton.getAttribute("inputmode")).toBe("numeric");
  });
});

describe("Single-deferred-total totals model (#1853)", () => {
  it("renders one deferred total with a single caption and the canonical quiet style", () => {
    const markup = renderToString(
      <CheckoutTotals
        lines={[{ label: "Shipping & tax", value: "Calculated at checkout", muted: true }]}
        totalLabel="Estimated total"
        total="$42.00"
        totalCaption="Final total confirmed at checkout"
        deferred
      />,
    );

    // The deferral statement appears exactly once.
    expect(markup.match(/Final total confirmed at checkout/g)).toHaveLength(1);
    expect(markup).toContain("Estimated total");
    // The deferred total drops the bold charge emphasis for the quiet tertiary style.
    expect(markup).toContain("text-tertiary");
    expect(markup).not.toContain("text-xl font-bold");
  });

  it("renders a firm total in the bold charge style when not deferred", () => {
    const markup = renderToString(
      <CheckoutTotals lines={[{ label: "Subtotal", value: "$40.00" }]} totalLabel="Payable total" total="$42.00" />,
    );

    expect(markup).toContain("Payable total");
    expect(markup).toContain("font-bold");
  });

  it("threads the deferred model and single caption through PriceBreakdown (pending alias)", () => {
    const markup = renderToString(
      <PriceBreakdown
        lines={[{ label: "Subtotal", value: "Pending", muted: true }]}
        totalLabel="Total"
        total="Pending"
        totalCaption="Secure payment"
        pending
      />,
    );

    expect(markup.match(/Secure payment/g)).toHaveLength(1);
    expect(markup).toContain("text-tertiary");
    expect(markup).not.toContain("font-bold");
  });
});

describe("CheckoutSummaryLineItem indicative pricing (#1853)", () => {
  it("prefixes an indicative price with `from` and keeps the tabular-nums slot", () => {
    const markup = renderToString(
      <CheckoutSummaryLineItem item={{ id: "1", title: "Charizard", price: "$120.00", priceState: "indicative" }} />,
    );

    expect(markup).toContain("from");
    expect(markup).toContain("$120.00");
    expect(markup).toContain("tabular-nums");
  });

  it("shows a single quiet `Priced at checkout` state for a deferred line and ignores price", () => {
    const markup = renderToString(
      <CheckoutSummaryLineItem item={{ id: "2", title: "Blastoise", price: "$99.00", priceState: "deferred" }} />,
    );

    expect(markup).toContain("Priced at checkout");
    expect(markup).not.toContain("$99.00");
    expect(markup).toContain("text-tertiary");
  });

  it("renders an exact price with no `from` prefix by default", () => {
    const markup = renderToString(<CheckoutSummaryLineItem item={{ id: "3", title: "Venusaur", price: "$80.00" }} />);

    expect(markup).toContain("$80.00");
    expect(markup).not.toContain(">from<");
  });

  it("routes a present image through the Image primitive with lazy loading", () => {
    const markup = renderToString(
      <CheckoutSummaryLineItem item={{ id: "4", title: "Mewtwo", image: { src: "/card.jpg", alt: "Mewtwo card" } }} />,
    );

    expect(markup).toContain('loading="lazy"');
    expect(markup).toContain('alt="Mewtwo card"');
  });

  it("renders a designed placeholder, not a blank square, when no image is supplied", () => {
    const { container } = render(<CheckoutSummaryLineItem item={{ id: "5", title: "No art" }} />);

    // The placeholder uses a decorative icon rather than an empty box.
    expect(container.querySelector('[aria-hidden="true"] svg')).toBeTruthy();
  });
});

describe("Unified sticky CTA bar + reassurance (#1853)", () => {
  it("accepts the totalLabel/total/context triple and stamps a single primary action", () => {
    const markup = renderToString(
      <StickyCtaBar
        totalLabel="Estimated total"
        total="$42.00"
        context="Final total confirmed at checkout"
        reassurance={<SecurePaymentIndicator label="Secure payment" reassurance="Not charged yet" />}
        primaryAction={<button type="submit">Check out</button>}
        secondaryAction={<button type="button">Keep shopping</button>}
      />,
    );

    expect(markup).toContain("Estimated total");
    expect(markup).toContain("$42.00");
    expect(markup).toContain('data-primary-action-count="1"');
    expect(markup).toContain("Secure payment");
    expect(markup).toContain("Not charged yet");
  });

  it("keeps the deprecated price alias working for existing consumers", () => {
    const markup = renderToString(
      <StickyCtaBar price="$472.19" primaryAction={<button type="submit">Continue</button>} />,
    );

    expect(markup).toContain("$472.19");
  });
});

describe("Action-hierarchy helpers (#1853)", () => {
  it("ActionRow stamps a single primary action and orders primary last", () => {
    const { container } = render(
      <ActionRow
        lowEmphasis={<DestructiveAction>Remove</DestructiveAction>}
        secondary={<button type="button">Find alternatives</button>}
        primary={<button type="submit">Check out</button>}
        data-testid="row"
      />,
    );

    const row = screen.getByTestId("row");
    expect(row.getAttribute("data-primary-action-count")).toBe("1");
    const buttons = Array.from(container.querySelectorAll("button")).map((b) => b.textContent);
    expect(buttons).toEqual(["Remove", "Find alternatives", "Check out"]);
  });

  it("ActionStack stamps a single primary action and leads with primary", () => {
    const { container } = render(
      <ActionStack
        primary={<button type="submit">Pay now</button>}
        secondary={<button type="button">Back to cart</button>}
        data-testid="stack"
      />,
    );

    expect(screen.getByTestId("stack").getAttribute("data-primary-action-count")).toBe("1");
    const buttons = Array.from(container.querySelectorAll("button")).map((b) => b.textContent);
    expect(buttons).toEqual(["Pay now", "Back to cart"]);
  });

  it("reports zero primary actions when no primary is provided", () => {
    render(<ActionRow secondary={<button type="button">Edit</button>} data-testid="row" />);

    expect(screen.getByTestId("row").getAttribute("data-primary-action-count")).toBe("0");
  });

  it("DestructiveAction renders a non-danger ghost recipe for routine Remove", () => {
    const markup = renderToString(<DestructiveAction>Remove</DestructiveAction>);

    expect(markup).toContain("Remove");
    expect(markup).toContain('type="button"');
    // Quiet, non-danger styling — red tone is reserved for blocking confirmations.
    expect(markup).toContain("text-secondary");
    expect(markup).not.toContain("bg-danger");
  });
});

describe("CheckoutNoticeStack single-notice ladder (#1853)", () => {
  it("renders only the highest-priority active notice (blocking beats needs-review beats savings)", () => {
    const { container } = render(
      <CheckoutNoticeStack
        candidates={[
          { priority: "savings", notice: <MarketplaceNotice tone="info" title="Save $4.20 by changing fulfillment" /> },
          {
            priority: "needs-review",
            notice: <MarketplaceNotice tone="warning" title="2 items need a fulfillment choice" />,
          },
          { priority: "blocking", notice: <MarketplaceNotice tone="danger" title="An item is unavailable" /> },
        ]}
      />,
    );

    expect(container.textContent).toContain("An item is unavailable");
    expect(container.textContent).not.toContain("need a fulfillment choice");
    expect(container.textContent).not.toContain("Save $4.20");
  });

  it("skips inactive candidates and falls back down the ladder", () => {
    const notice = selectCheckoutNotice([
      { priority: "blocking", active: false, notice: "blocking" },
      { priority: "needs-review", active: true, notice: "needs-review" },
      { priority: "savings", active: true, notice: "savings" },
    ]);

    expect(notice).toBe("needs-review");
  });

  it("renders no notice content when no candidate is active (but keeps the live region container)", () => {
    const { container } = render(
      <CheckoutNoticeStack candidates={[{ priority: "info", active: false, notice: <span>none</span> }]} />,
    );

    // The live region container remains in the DOM (stable observer for screen readers)
    // but shows no notice text.
    const region = container.querySelector('[role="status"]');
    expect(region).toBeTruthy();
    expect(region?.textContent).toBe("");
  });
});

describe("PageStepper multi-step spine (#1853)", () => {
  it("marks the current step with aria-current and uses list semantics", () => {
    render(
      <PageStepper
        aria-label="Checkout steps"
        items={[
          { label: "Contact", status: "complete" },
          { label: "Delivery", status: "current" },
          { label: "Payment", status: "upcoming" },
          { label: "Review", status: "upcoming" },
        ]}
      />,
    );

    const list = screen.getByRole("list", { name: "Checkout steps" });
    expect(list.tagName).toBe("OL");
    expect(screen.getAllByRole("listitem")).toHaveLength(4);

    const current = screen.getByText("Delivery").closest("li");
    expect(current?.getAttribute("aria-current")).toBe("step");
  });

  it("flags a blocked step distinctly from upcoming", () => {
    render(
      <PageStepper
        items={[
          { label: "Shipping", status: "current" },
          { label: "Payment", status: "blocked" },
        ]}
      />,
    );

    const blocked = screen.getByText("Payment").closest("li");
    expect(blocked?.getAttribute("aria-current")).toBeNull();
    expect(blocked?.className).toContain("border-danger");
  });

  it("exposes a default accessible label so the list is always named without consumer effort", () => {
    render(
      <PageStepper
        items={[
          { label: "Contact", status: "current" },
          { label: "Payment", status: "upcoming" },
        ]}
      />,
    );

    // Default aria-label="Progress" is set; consumers can override via ...rest.
    const list = screen.getByRole("list", { name: "Progress" });
    expect(list.tagName).toBe("OL");
  });
});

describe("Accessibility — focus, aria, live regions (#1857)", () => {
  it("CheckoutNoticeStack is a polite live region so screen readers announce state changes", () => {
    const markup = renderToString(
      <CheckoutNoticeStack
        candidates={[{ priority: "needs-review", active: true, notice: <span>Cart needs attention</span> }]}
      />,
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-atomic="true"');
  });

  it("CheckoutNoticeStack keeps the live region container in the DOM even when empty", () => {
    const { container } = render(
      <CheckoutNoticeStack candidates={[{ priority: "info", active: false, notice: <span>None</span> }]} />,
    );

    // The wrapper div must remain in the DOM (not null-rendered) so the browser
    // has a stable live region to observe for future insertions.
    const region = container.querySelector('[role="status"]');
    expect(region).toBeTruthy();
    expect(region?.textContent).toBe("");
  });

  it("StickyCtaBar exposes a named region landmark for assistive technology", () => {
    const { container } = render(
      <StickyCtaBar
        totalLabel="Estimated total"
        total="$42.00"
        primaryAction={<button type="submit">Check out</button>}
      />,
    );

    const region = container.querySelector('[role="region"]');
    expect(region).toBeTruthy();
    expect(region?.getAttribute("aria-label")).toBe("Checkout");
  });

  it("StickyCtaBar accepts a custom region label", () => {
    const markup = renderToString(
      <StickyCtaBar total="$10.00" primaryAction={<button type="submit">Buy</button>} label="Cart checkout" />,
    );

    expect(markup).toContain('role="region"');
    expect(markup).toContain('aria-label="Cart checkout"');
  });

  it("CheckoutStickyActionBar exposes a named region landmark for assistive technology", () => {
    const markup = renderToString(
      <CheckoutStickyActionBar
        totalLabel="Total"
        total="$42.00"
        primaryAction={<button type="submit">Pay now</button>}
      />,
    );

    expect(markup).toContain('role="region"');
    expect(markup).toContain('aria-label="Checkout actions"');
  });

  it("DestructiveAction carries a visible focus ring class for keyboard navigation", () => {
    const markup = renderToString(<DestructiveAction>Remove</DestructiveAction>);

    // focus-ring applies box-shadow on :focus-visible — the class must be present
    // on the button element so keyboard users see a ring on dark surfaces.
    expect(markup).toContain("focus-ring");
  });

  it("PageStepper completed steps show a check icon for non-text status cues", () => {
    render(
      <PageStepper
        items={[
          { label: "Contact", status: "complete" },
          { label: "Payment", status: "current" },
        ]}
      />,
    );

    // The complete step badge renders an icon (SVG) instead of a number so the
    // status is communicated visually; aria-current="step" on the current item
    // handles the screen-reader status signal.
    const completeBadge = screen.getByText("Contact").closest("li");
    expect(completeBadge?.querySelector("svg")).toBeTruthy();
    expect(completeBadge?.getAttribute("aria-current")).toBeNull();
  });
});
