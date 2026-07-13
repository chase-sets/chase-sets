import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  ActivityList,
  Banner,
  Breadcrumbs,
  Button,
  ComparisonList,
  ComparisonListCell,
  ComparisonListHeader,
  ComparisonListPrice,
  ComparisonListRow,
  ComparisonListRowGrid,
  ConnectionStatusIndicator,
  EmptyState,
  FileDropzone,
  OperationalStatusBanner,
  PackingSlipPrintDocument,
  Pagination,
  Timeline,
  packingSlipPrintStyles,
  useMediaQuery,
} from "../index";
import { minWidthQuery } from "../theme/tokens";

function MediaQueryHarness({ query, defaultValue = false }: { query: string; defaultValue?: boolean }) {
  const matches = useMediaQuery(query, defaultValue);

  return <span>{matches ? "matches" : "does not match"}</span>;
}

function installMatchMedia(matches: boolean) {
  const previousMatchMedia = window.matchMedia;
  let currentMatches = matches;
  let changeListener: ((event: MediaQueryListEvent) => void) | undefined;
  const mediaQueryList = {
    get matches() {
      return currentMatches;
    },
    media: minWidthQuery("md"),
    onchange: null,
    addEventListener: vi.fn((eventName: string, listener: (event: MediaQueryListEvent) => void) => {
      if (eventName === "change") {
        changeListener = listener;
      }
    }),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  } as MediaQueryList;

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn(() => mediaQueryList),
  });

  return {
    setMatches(nextMatches: boolean) {
      currentMatches = nextMatches;
      act(() => {
        changeListener?.({ matches: nextMatches, media: mediaQueryList.media } as MediaQueryListEvent);
      });
    },
    restore() {
      if (previousMatchMedia) {
        Object.defineProperty(window, "matchMedia", {
          configurable: true,
          writable: true,
          value: previousMatchMedia,
        });
        return;
      }

      Reflect.deleteProperty(window, "matchMedia");
    },
  };
}

const packingSlipToolbar = {
  eyebrow: "Fulfillment",
  title: "Print packing slips",
  description: "Batch ready shipments for packing.",
  formatLabel: "Format",
  format: "thermal-4x6" as const,
  letterLabel: "Letter",
  thermalLabel: "Thermal 4 x 6",
  changeFormatLabel: "Change format",
  printLabel: "Print labels",
  shipmentIds: ["ship_123", "ship_456"],
};

const packingSlipLabels = {
  packingSlip: "Packing slip",
  order: "Order",
  item: "Item",
  product: "Product",
  quantity: "Qty",
  standardProduct: "Standard product",
};

describe("root export coverage smoke tests", () => {
  it("renders Breadcrumbs from the root export with current-page semantics", () => {
    render(
      <Breadcrumbs
        ariaLabel="Listing path"
        items={[
          { label: "Marketplace", href: "/marketplace" },
          { label: "Pokemon", href: "/marketplace/pokemon" },
          { label: "Base Set Charizard" },
        ]}
      />,
    );

    const breadcrumbs = screen.getByRole("navigation", { name: "Listing path" });

    expect(within(breadcrumbs).getByRole("link", { name: "Marketplace" }).getAttribute("href")).toBe("/marketplace");
    expect(within(breadcrumbs).getByText("Base Set Charizard").getAttribute("aria-current")).toBe("page");
  });

  it("renders Pagination from the root export and preserves page-change behavior", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();

    render(<Pagination page={4} totalPages={10} onPageChange={onPageChange} />);

    expect(screen.getByRole("button", { name: "4" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getAllByText("\u2026")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Previous page" }));
    await user.click(screen.getByRole("button", { name: "Next page" }));
    await user.click(screen.getByRole("button", { name: "5" }));

    expect(onPageChange).toHaveBeenNthCalledWith(1, 3);
    expect(onPageChange).toHaveBeenNthCalledWith(2, 5);
    expect(onPageChange).toHaveBeenNthCalledWith(3, 5);
  });

  it("renders Banner and EmptyState actions from the root export", () => {
    render(
      <>
        <Banner
          tone="warning"
          title="Shipment needs review"
          description="Confirm the package weight before buying postage."
          actions={<Button tone="secondary">Review weight</Button>}
        />
        <EmptyState
          title="No shipments ready"
          description="Create a label or refresh the queue."
          actions={<Button>Create label</Button>}
        />
      </>,
    );

    expect(screen.getByRole("alert").textContent).toContain("Shipment needs review");
    expect(screen.getByRole("button", { name: "Review weight" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "No shipments ready" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create label" })).toBeTruthy();
  });

  it("wires FileDropzone file input metadata and change callbacks", async () => {
    const user = userEvent.setup();
    const onFilesChange = vi.fn();
    const file = new File(["sku,qty"], "pick-list.csv", { type: "text/csv" });

    render(
      <FileDropzone
        id="pick-list"
        name="pickList"
        form="packing-form"
        label="Upload pick list"
        description="CSV exports only."
        accept=".csv"
        capture="environment"
        multiple
        onFilesChange={onFilesChange}
      />,
    );

    const input = screen.getByLabelText("Upload pick list") as HTMLInputElement;

    expect(input.name).toBe("pickList");
    expect(input.getAttribute("form")).toBe("packing-form");
    expect(input.accept).toBe(".csv");
    expect(input.multiple).toBe(true);
    expect(input.getAttribute("capture")).toBe("environment");
    expect(input.getAttribute("aria-describedby")).toContain("pick-list-description");

    await user.upload(input, file);

    expect(onFilesChange).toHaveBeenCalledTimes(1);
    expect(onFilesChange.mock.calls[0]?.[0]?.[0]).toBe(file);
  });

  it("renders Timeline and ActivityList ordered facts from the root export", () => {
    render(
      <>
        <Timeline
          aria-label="Shipment timeline"
          items={[
            { title: "Packed", description: "Box sealed.", timestamp: "9:00 AM" },
            { title: "Label bought", timestamp: "9:05 AM" },
          ]}
        />
        <ActivityList
          aria-label="Shipment activity"
          items={[
            { title: "Weight updated", actor: "Todd", timestamp: "9:10 AM" },
            { title: "Carrier selected", description: "USPS Ground Advantage" },
          ]}
        />
      </>,
    );

    expect(within(screen.getByRole("list", { name: "Shipment timeline" })).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Box sealed.")).toBeTruthy();
    expect(screen.getByText(/Todd/).textContent).toContain("9:10 AM");
    expect(screen.getByText("USPS Ground Advantage")).toBeTruthy();
  });

  it("renders ComparisonList primitives with selected-row and price affordances", () => {
    const { container } = render(
      <ComparisonList>
        <ComparisonListHeader labels={["Price", "Seller", "Condition", "Action"]} />
        <ComparisonListRow selected aria-label="Best offer">
          <ComparisonListRowGrid>
            <ComparisonListCell>
              <ComparisonListPrice>$42.00</ComparisonListPrice>
            </ComparisonListCell>
            <ComparisonListCell area="account">Card Corner</ComparisonListCell>
            <ComparisonListCell area="product">Near mint, English</ComparisonListCell>
            <ComparisonListCell area="action">
              <Button>Buy</Button>
            </ComparisonListCell>
          </ComparisonListRowGrid>
        </ComparisonListRow>
      </ComparisonList>,
    );

    const selectedRow = screen.getByRole("article", { name: "Best offer" });

    expect(selectedRow.textContent).toContain("$42.00");
    expect(selectedRow.textContent).toContain("Card Corner");
    expect(container.querySelector(".bg-accent")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Buy" })).toBeTruthy();
  });

  it("renders OperationalStatusBanner status copy and action", () => {
    render(
      <OperationalStatusBanner
        tone="danger"
        title="Packing blocked"
        description="Resolve the inventory hold before printing."
        action={<Button tone="danger">Resolve hold</Button>}
      />,
    );

    expect(screen.getByText("Packing blocked")).toBeTruthy();
    expect(screen.getByText("Resolve the inventory hold before printing.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resolve hold" })).toBeTruthy();
  });

  it("renders ConnectionStatusIndicator live and stale states in a shared status region", () => {
    const { rerender } = render(
      <ConnectionStatusIndicator status="live" liveLabel="Live" staleLabel="Stale since 10:32 AM" />,
    );

    const liveRegion = screen.getByRole("status");
    expect(liveRegion.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByText("Live")).toBeTruthy();

    rerender(
      <ConnectionStatusIndicator
        status="stale"
        liveLabel="Live"
        staleLabel="Stale since 10:32 AM"
        staleDescription="Data may be out of date until it reconnects."
        action={<Button>Reload</Button>}
      />,
    );

    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
    expect(screen.getByText("Stale since 10:32 AM")).toBeTruthy();
    expect(screen.getByText("Data may be out of date until it reconnects.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();

    rerender(<ConnectionStatusIndicator status="connecting" liveLabel="Live" connectingLabel="Connecting…" />);
    expect(screen.getByText("Connecting…")).toBeTruthy();
  });

  it("renders PackingSlipPrintDocument and format-specific print styles", async () => {
    const print = vi.fn();
    const previousPrint = globalThis.print;

    Object.defineProperty(globalThis, "print", {
      configurable: true,
      writable: true,
      value: print,
    });

    try {
      const { container } = render(
        <PackingSlipPrintDocument
          format="thermal-4x6"
          toolbar={packingSlipToolbar}
          labels={packingSlipLabels}
          slips={[
            {
              id: "ship_123",
              orderReference: "order_789",
              referenceLabel: "Shipment",
              referenceValue: "ship_123",
              shipToTitle: "Ship to",
              shipToLines: ["Avery Buyer", "100 Market St"],
              shipFromTitle: "Ship from",
              shipFromLines: ["Chase Sets", "200 Seller Ave"],
              itemsTitle: "Items",
              lines: [
                {
                  id: "line_1",
                  title: "Base Set Charizard",
                  subtitle: "Near mint",
                  quantity: "1",
                },
              ],
              footer: "Thanks for buying on Chase Sets.",
            },
          ]}
        />,
      );

      expect(packingSlipPrintStyles("thermal-4x6")).toContain("size: 4in 6in");
      expect(container.querySelector('[data-format="thermal-4x6"]')).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Packing slip" })).toBeTruthy();
      expect(screen.getByText(/order_789/)).toBeTruthy();
      expect(screen.getByText("Base Set Charizard")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Print labels" }));

      expect(print).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(globalThis, "print", {
        configurable: true,
        writable: true,
        value: previousPrint,
      });
    }
  });

  it("updates useMediaQuery consumers when matchMedia changes", async () => {
    const matchMedia = installMatchMedia(false);

    try {
      render(<MediaQueryHarness query={minWidthQuery("md")} />);

      expect(await screen.findByText("does not match")).toBeTruthy();

      matchMedia.setMatches(true);

      await waitFor(() => {
        expect(screen.getByText("matches")).toBeTruthy();
      });
    } finally {
      matchMedia.restore();
    }
  });
});
