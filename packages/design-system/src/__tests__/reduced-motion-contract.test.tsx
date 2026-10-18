import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SegmentedControl } from "../components/actions/segmented-control";
import { SideNav } from "../components/actions/navigation";
import { Tabs } from "../components/actions/tabs";
import { MarketplaceShell } from "../patterns/app-shells/shells";
import { ChaseRoot } from "../theme/provider";

const layoutGroupCalls = vi.hoisted(() => [] as string[]);
const motionElementCalls = vi.hoisted(
  () =>
    [] as Array<{
      tag: string;
      initial: unknown;
      animate: unknown;
      transition: unknown;
      layoutId: unknown;
    }>,
);

vi.mock("motion/react", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const motion = new Proxy(
    {},
    {
      get(_target, tag: string) {
        return React.forwardRef<HTMLElement, Record<string, unknown>>(function MotionElement(props, ref) {
          const { initial, animate, transition, layoutId, whileHover, whileTap, ...domProps } = props;
          motionElementCalls.push({ tag, initial, animate, transition, layoutId });

          return React.createElement(tag, { ...domProps, ref });
        });
      },
    },
  );

  return {
    LayoutGroup({ children, id }: { children: ReactNode; id: string }) {
      layoutGroupCalls.push(id);
      return <>{children}</>;
    },
    MotionConfig({ children }: { children: ReactNode }) {
      return <>{children}</>;
    },
    motion,
  };
});

describe("reduced motion contract", () => {
  beforeEach(() => {
    layoutGroupCalls.length = 0;
    motionElementCalls.length = 0;
  });

  it("removes active-pill layout groups and Tabs panel motion when ChaseRoot always reduces motion", () => {
    render(
      <ChaseRoot reducedMotion="always">
        <Tabs
          items={[
            { value: "summary", label: "Summary", content: <div>Summary content</div> },
            { value: "activity", label: "Activity", content: <div>Activity content</div> },
          ]}
        />
        <SegmentedControl
          value="seller"
          items={[
            { value: "buyer", label: "Buyer" },
            { value: "seller", label: "Seller" },
          ]}
        />
        <SideNav
          activeKey="orders"
          items={[
            { key: "overview", label: "Overview", href: "/overview" },
            { key: "orders", label: "Orders", href: "/orders" },
          ]}
        />
      </ChaseRoot>,
    );

    expect(layoutGroupCalls).toEqual([]);
    expect(motionElementCalls.some((call) => typeof call.layoutId === "string")).toBe(false);

    const tabsPanelMotion = motionElementCalls.find((call) => call.tag === "div" && call.initial === false);
    expect(tabsPanelMotion).toMatchObject({
      animate: undefined,
      transition: undefined,
    });
  });

  it("keeps active-pill layout groups available when ChaseRoot allows motion", () => {
    render(
      <ChaseRoot reducedMotion="never">
        <SegmentedControl
          value="seller"
          items={[
            { value: "buyer", label: "Buyer" },
            { value: "seller", label: "Seller" },
          ]}
        />
      </ChaseRoot>,
    );

    expect(layoutGroupCalls).toHaveLength(1);
    expect(motionElementCalls.some((call) => typeof call.layoutId === "string")).toBe(true);
  });

  function setWindowMetric(name: "innerWidth" | "scrollY", value: number) {
    Object.defineProperty(window, name, { configurable: true, writable: true, value });
  }

  function renderSearchRowShell(reducedMotion: "always" | "user") {
    return render(
      <ChaseRoot reducedMotion={reducedMotion}>
        <MarketplaceShell
          brand={<a href="/">Chase Sets</a>}
          topNavItems={[]}
          bottomNavItems={[]}
          search={<input aria-label="Marketplace search fixture" />}
          collapseSearchOnScroll
          routeIdentity="/items/charizard-base-set-4-102-holo-rare-seed-charizard-base-set-xsr3yp"
        >
          <div>Body</div>
        </MarketplaceShell>
      </ChaseRoot>,
    );
  }

  it("removes the search-row collapse transition when ChaseRoot always reduces motion", () => {
    setWindowMetric("innerWidth", 390);
    setWindowMetric("scrollY", 2000);
    const view = renderSearchRowShell("always");
    const outer = view.container.querySelector('div[class*="--shell-header-height"]')!;
    const slot = view.container.querySelector("[data-search-row-slot]")!;
    const painted = view.container.querySelector('[data-shell-header-box="painted"]')!;

    // The published phase and geometry are identical to the motion-enabled
    // shell; only the transition treatment changes, in one step.
    expect(outer.getAttribute("data-search-row-state")).toBe("collapsed");
    expect(outer.getAttribute("class")).toContain("data-[search-row-state=collapsed]:[--shell-header-height:4rem]");
    expect(slot.getAttribute("class")).toContain("grid-rows-[0fr]");
    expect(slot.getAttribute("class")).not.toContain("transition-[grid-template-rows]");
    expect(slot.getAttribute("class")).not.toContain("duration-200");
    expect((slot as HTMLElement).style.transition).toBe("");
    expect(painted.getAttribute("class")).not.toContain("transition-[height]");
    view.unmount();
  });

  it("keeps the shipped search-row motion treatment under the default user setting", () => {
    setWindowMetric("innerWidth", 390);
    setWindowMetric("scrollY", 2000);
    const view = renderSearchRowShell("user");
    const outer = view.container.querySelector('div[class*="--shell-header-height"]')!;
    const slot = view.container.querySelector("[data-search-row-slot]")!;
    const painted = view.container.querySelector('[data-shell-header-box="painted"]')!;

    expect(outer.getAttribute("data-search-row-state")).toBe("collapsed");
    expect(outer.getAttribute("class")).toContain("data-[search-row-state=collapsed]:[--shell-header-height:4rem]");
    expect(slot.getAttribute("class")).toContain("grid-rows-[0fr]");
    expect(slot.getAttribute("class")).toContain("transition-[grid-template-rows]");
    expect(slot.getAttribute("class")).toContain("duration-200");
    expect(painted.getAttribute("class")).toContain("transition-[height]");
    view.unmount();
  });
});
