import { fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Image } from "../components/data-display";
import {
  AspectRatio,
  Bleed,
  Center,
  DesktopActionBar,
  Grid,
  IconRow,
  MediaFrame,
  MobileStickyBar,
  Show,
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
