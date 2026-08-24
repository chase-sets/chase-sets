import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EyebrowProps } from "../primitives/typography";
import { MarketingImageHero, PageHeader } from "../index";

const { eyebrowSentinel } = vi.hoisted(() => ({ eyebrowSentinel: vi.fn() }));

// The sentinel replaces the exported Eyebrow while preserving its props, so an
// output-equivalent inline element can never satisfy these assertions: only a
// component that instantiates the exported primitive renders the sentinel.
vi.mock("../primitives/typography", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../primitives/typography")>();
  return {
    ...actual,
    Eyebrow: (props: EyebrowProps) => {
      eyebrowSentinel(props);
      return <div data-testid="eyebrow-sentinel" data-variant={props.variant ?? "omitted"} />;
    },
  };
});

describe("Eyebrow adoption is proven by module identity, not output", () => {
  beforeEach(() => {
    eyebrowSentinel.mockClear();
  });

  it("PageHeader instantiates the exported Eyebrow exactly once with the explicit accent variant", () => {
    render(<PageHeader eyebrow="Orders" title="Open orders" />);

    expect(screen.getAllByTestId("eyebrow-sentinel")).toHaveLength(1);
    expect(screen.getByTestId("eyebrow-sentinel").getAttribute("data-variant")).toBe("accent");
    expect(eyebrowSentinel).toHaveBeenCalledTimes(1);
    expect(eyebrowSentinel.mock.calls[0]?.[0]).toMatchObject({ variant: "accent", children: "Orders" });
  });

  it("MarketingImageHero instantiates the exported Eyebrow exactly once with the explicit primary variant", () => {
    render(<MarketingImageHero imageSrc="/hero.png" imageAlt="" title="Chase the set" eyebrow="New season" />);

    expect(screen.getAllByTestId("eyebrow-sentinel")).toHaveLength(1);
    expect(screen.getByTestId("eyebrow-sentinel").getAttribute("data-variant")).toBe("primary");
    expect(eyebrowSentinel).toHaveBeenCalledTimes(1);
    expect(eyebrowSentinel.mock.calls[0]?.[0]).toMatchObject({ variant: "primary", children: "New season" });
  });

  it("neither site instantiates Eyebrow when no eyebrow content is passed", () => {
    render(
      <>
        <PageHeader title="Open orders" />
        <MarketingImageHero imageSrc="/hero.png" imageAlt="" title="Chase the set" />
      </>,
    );

    expect(eyebrowSentinel).not.toHaveBeenCalled();
    expect(screen.queryByTestId("eyebrow-sentinel")).toBeNull();
  });
});
