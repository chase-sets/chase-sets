import { fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Image } from "../components/data-display";
import { AspectRatio, Bleed, Center } from "../primitives/layout";
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
