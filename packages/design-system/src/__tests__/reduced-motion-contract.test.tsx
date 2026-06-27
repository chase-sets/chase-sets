import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SegmentedControl } from "../components/actions/segmented-control";
import { SideNav } from "../components/actions/navigation";
import { Tabs } from "../components/actions/tabs";
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
});
