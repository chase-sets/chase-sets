import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button, Tabs } from "../components/actions";
import { DataTable } from "../components/data-display";
import { Dialog } from "../components/feedback";
import { ChaseRoot } from "../theme/provider";
import { resolveThemeOverrideStyle, resolveThemeStyle } from "../theme/tokens";
import { resolveResponsiveClass } from "../utils/system";

describe("design system", () => {
  it("resolves theme variables", () => {
    const style = resolveThemeStyle({
      colors: {
        accent: "#000000"
      }
    });

    expect(style["--color-accent" as never]).toBe("#000000");
  });

  it("only injects explicit theme overrides for scoped runtime styles", () => {
    const style = resolveThemeOverrideStyle({
      typography: {
        body: "Instrument Sans"
      }
    });

    expect(style?.["--font-body" as never]).toBe("Instrument Sans");
    expect(style?.["--color-background" as never]).toBeUndefined();
  });

  it("renders safely on the server", () => {
    const markup = renderToString(
      <ChaseRoot>
        <Button>Ship it</Button>
      </ChaseRoot>
    );

    expect(markup).toContain("data-chase-theme");
    expect(markup).toContain('data-color-mode="system"');
    expect(markup).toContain("Ship it");
  });

  it("renders tab content", () => {
    render(
      <ChaseRoot>
        <Tabs
          items={[
            {
              value: "one",
              label: "One",
              content: <div>First tab</div>
            }
          ]}
        />
      </ChaseRoot>
    );

    expect(screen.getByText("First tab")).toBeTruthy();
  });

  it("renders empty state for empty data tables", () => {
    render(
      <DataTable
        rows={[]}
        columns={[
          {
            key: "name",
            header: "Name",
            cell: (row: { name: string }) => row.name
          }
        ]}
      />
    );

    expect(screen.getByText("Nothing to review")).toBeTruthy();
  });

  it("renders open dialogs", () => {
    render(
      <ChaseRoot>
        <Dialog open title="Review listing">
          Content body
        </Dialog>
      </ChaseRoot>
    );

    expect(screen.getByText("Review listing")).toBeTruthy();
    expect(screen.getByText("Content body")).toBeTruthy();
  });

  it("resolves responsive classes from maps", () => {
    const result = resolveResponsiveClass(
      { base: "row", md: "column" },
      {
        row: {
          base: "flex-row",
          sm: "sm:flex-row",
          md: "md:flex-row",
          lg: "lg:flex-row",
          xl: "xl:flex-row",
          "2xl": "2xl:flex-row"
        },
        column: {
          base: "flex-col",
          sm: "sm:flex-col",
          md: "md:flex-col",
          lg: "lg:flex-col",
          xl: "xl:flex-col",
          "2xl": "2xl:flex-col"
        }
      }
    );

    expect(result).toContain("flex-row");
    expect(result).toContain("md:flex-col");
  });
});
