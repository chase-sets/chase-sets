import { createRef, forwardRef, type ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Box, Inset, Stack, Surface } from "../primitives/layout";
import { Heading, Text } from "../primitives/typography";

interface TestLinkProps {
  children?: ReactNode;
  className?: string;
  "data-testid"?: string;
  to: string;
}

const TestLink = forwardRef<HTMLAnchorElement, TestLinkProps>(function TestLink({ children, to, ...rest }, ref) {
  return (
    <a {...rest} ref={ref} href={to}>
      {children}
    </a>
  );
});

describe("polymorphic primitives", () => {
  it("renders Box and Text with custom component targets", () => {
    const boxRef = createRef<HTMLAnchorElement>();
    const textRef = createRef<HTMLAnchorElement>();

    render(
      <div>
        <Box as={TestLink} ref={boxRef} to="/account/orders" data-testid="box-link" padding={2}>
          Orders
        </Box>
        <Text render={TestLink} ref={textRef} to="/account/activity" data-testid="text-link" size="sm">
          Activity
        </Text>
      </div>,
    );

    expect(screen.getByTestId("box-link").tagName).toBe("A");
    expect(screen.getByTestId("box-link").getAttribute("href")).toBe("/account/orders");
    expect(boxRef.current).toBe(screen.getByTestId("box-link"));
    expect(screen.getByTestId("box-link").className).toContain("p-2");

    expect(screen.getByTestId("text-link").tagName).toBe("A");
    expect(screen.getByTestId("text-link").getAttribute("href")).toBe("/account/activity");
    expect(textRef.current).toBe(screen.getByTestId("text-link"));
    expect(screen.getByTestId("text-link").className).toContain("text-sm");
  });

  it("forwards refs through layout primitive targets", () => {
    const stackRef = createRef<HTMLElement>();
    const surfaceRef = createRef<HTMLElement>();
    const insetRef = createRef<HTMLElement>();

    render(
      <div>
        <Stack as="nav" ref={stackRef} data-testid="stack">
          Navigation
        </Stack>
        <Surface as="section" ref={surfaceRef} data-testid="surface">
          Surface
        </Surface>
        <Inset as="aside" ref={insetRef} data-testid="inset">
          Inset
        </Inset>
      </div>,
    );

    expect(stackRef.current).toBe(screen.getByTestId("stack"));
    expect(stackRef.current?.tagName).toBe("NAV");
    expect(surfaceRef.current).toBe(screen.getByTestId("surface"));
    expect(surfaceRef.current?.tagName).toBe("SECTION");
    expect(insetRef.current).toBe(screen.getByTestId("inset"));
    expect(insetRef.current?.tagName).toBe("ASIDE");
  });

  it("keeps legacy element props working", () => {
    render(
      <div>
        <Box element="main" data-testid="box-main">
          Main
        </Box>
        <Text element="strong">Important</Text>
      </div>,
    );

    expect(screen.getByTestId("box-main").tagName).toBe("MAIN");
    expect(screen.getByText("Important").tagName).toBe("STRONG");
  });

  it("decouples Heading level from visual size", () => {
    render(
      <Heading level={3} visualSize={1}>
        Shipment status
      </Heading>,
    );

    const heading = screen.getByRole("heading", { level: 3, name: "Shipment status" });

    expect(heading.tagName).toBe("H3");
    expect(heading.className).toContain("text-4xl");
    expect(heading.className).not.toContain("text-2xl");
  });
});
