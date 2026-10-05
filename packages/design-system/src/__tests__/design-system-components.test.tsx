import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act, useState, type ReactNode } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import tailwindConfig from "../../../../tailwind.config";
import {
  Button,
  Breadcrumbs,
  CopyButton,
  IconButton,
  NavigationMenu,
  Pagination,
  SegmentedControl,
  Tabs,
  Toggle,
  ToggleGroup,
  Toolbar,
  ToolbarButton,
  ToolbarInput,
  ToolbarSeparator,
  TopNav,
} from "../components/actions";
import {
  AddressBlock,
  Card,
  ChecklistCard,
  DataTable,
  ImageGallery,
  OperationalLockBanner,
  OperationalStatusBanner,
  TaskSummary,
  WorkflowModule,
  WorkflowReadinessChecklist,
} from "../components/data-display";
import { CheckoutConfirmationPanel, CheckoutStateNotice, CheckoutSummaryPanel } from "../components/checkout";
import {
  Accordion,
  AccordionOptionTrigger,
  Badge,
  Banner,
  Dialog,
  LoadingSpinner,
  Menu,
  PanelSectionAccordion,
  Popover,
  ProgressiveDisclosure,
  ProgressiveDisclosureGroup,
  Rating,
  StatusPill,
  Tag,
  ToastRegion,
  Tooltip,
} from "../components/feedback";
import { Icon, type IconName } from "../icons";
import {
  Checkbox,
  Combobox,
  Autocomplete,
  NativeSelect,
  NumberField,
  PasswordInput,
  SearchInput,
  Select,
  Switch,
  TagInput,
  TextInput,
} from "../components/forms";
import { resolveChaseMotion } from "../motion/config";
import { Reveal, Stagger, ViewTransition } from "../motion/primitives";
import { ChaseSetsLogo, chaseSetsLogoSvg } from "../brand/chase-sets-logo";
import {
  AdminShell,
  CommerceActionBar,
  CommerceBottomSheet,
  CommerceSheet,
  MarketStatusBadge,
  MarketplaceFacetRail,
  MarketplaceFacetStrip,
  MarketplaceMarketSummary,
  MarketplaceProductCard,
  MarketplaceShell,
  NotificationCenterSheet,
  ProductCard,
  ResponsiveEditSheet,
  SellerBadge,
  TokenSwatch,
  Wizard,
} from "../patterns/app-shells";
import { AutoGrid, Box, Container, FlexItem, SkipLink, Stack, Surface } from "../primitives/layout";
import { LinkText, Text, Thumbnail } from "../primitives/typography";
import { ChaseRoot, ColorModeToggle, useChaseMotion, useReducedMotion } from "../theme/provider";
import { ThemePreferenceControl, ThemeToggle } from "../theme/theme-toggle";
import { chaseTheme, resolveThemeOverrideStyle, resolveThemeStyle, type SpaceToken } from "../theme/tokens";
import { resolveResponsiveClass, resolveSpaceClass } from "../utils/system";

interface MotionDivRender {
  initial: unknown;
  animate: unknown;
  variants: unknown;
  transition: unknown;
}

const motionDivRenders = vi.hoisted(() => [] as MotionDivRender[]);

// Transparent passthrough: the real Motion runtime still renders (server styles,
// hydration, animations), while every `motion.div` render records the motion
// props the Stagger tests compare against the base fixture.
// `ref` reaches the real div only because React 19 passes refs as plain props.
vi.mock("motion/react", async (importOriginal) => {
  const React = await vi.importActual<typeof import("react")>("react");
  const actual = await importOriginal<typeof import("motion/react")>();
  const ActualMotionDiv = actual.motion.div;

  function RecordingMotionDiv(props: Record<string, unknown>) {
    motionDivRenders.push({
      initial: props.initial,
      animate: props.animate,
      variants: props.variants,
      transition: props.transition,
    });

    return React.createElement(ActualMotionDiv, props as never);
  }

  return {
    ...actual,
    motion: new Proxy(actual.motion, {
      get(target, key) {
        return key === "div" ? RecordingMotionDiv : Reflect.get(target, key);
      },
    }),
  };
});

beforeEach(() => {
  motionDivRenders.length = 0;
});

const expectedSpacingTokens = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] satisfies SpaceToken[];

describe("composed Surface treatments", () => {
  it.each([
    { name: "Banner", ui: <Banner title="Notice" />, fill: "bg-info-soft" },
    { name: "CheckoutStateNotice", ui: <CheckoutStateNotice title="Notice" />, fill: "bg-info-soft" },
    { name: "CheckoutConfirmationPanel", ui: <CheckoutConfirmationPanel title="Confirmed" />, fill: "bg-success-soft" },
    {
      name: "CheckoutSummaryPanel",
      ui: <CheckoutSummaryPanel title="Summary" totals={[]} totalLabel="Total" total="$10" />,
      fill: "bg-surface-2",
    },
    { name: "AddressBlock", ui: <AddressBlock title="Address" lines={["Main Street"]} />, fill: "bg-surface-2" },
    { name: "ChecklistCard", ui: <ChecklistCard title="Tasks">Items</ChecklistCard>, fill: "bg-surface-2" },
    { name: "OperationalLockBanner", ui: <OperationalLockBanner title="Locked" />, fill: "bg-warning-soft" },
    { name: "OperationalStatusBanner", ui: <OperationalStatusBanner title="Status" />, fill: "bg-info-soft" },
    { name: "TaskSummary", ui: <TaskSummary title="Summary" items={[]} />, fill: "bg-surface-2" },
  ])("renders $name as tinted furniture", ({ ui, fill }) => {
    const { container } = render(ui);
    const classes = container.firstElementChild?.className.split(" ");
    expect(classes).toContain(fill);
    expect(classes).not.toContain("surface-border");
    expect(classes?.some((value) => /^(border|shadow|ds-glass)/.test(value))).toBe(false);
  });

  it("renders WorkflowModule as flush furniture", () => {
    const { container } = render(<WorkflowModule title="Step">Content</WorkflowModule>);
    expect(container.firstElementChild?.className).toBe("min-w-0 max-w-full rounded-tokenLg p-4 gap-3");
  });

  it.each([
    { status: "passed", fill: "bg-success-soft" },
    { status: "blocked", fill: "bg-danger-soft" },
    { status: "warning", fill: "bg-warning-soft" },
    { status: "pending", fill: "bg-surface-2" },
  ] as const)("renders $status readiness furniture with a tint but no raised chrome", ({ status, fill }) => {
    const { container } = render(
      <WorkflowReadinessChecklist items={[{ key: status, label: "Check", status, statusLabel: status }]} />,
    );
    const classes = container.querySelector("li > div")?.className.split(" ");
    expect(classes).toContain(fill);
    expect(classes).not.toContain("surface-border");
    expect(classes?.some((value) => /^(border|shadow|ds-glass)/.test(value))).toBe(false);
  });

  it.each([undefined, "/card.png"])("keeps Thumbnail elevated with image source %s", (src) => {
    const { container } = render(<Thumbnail src={src} alt="Card" />);
    expect(container.firstElementChild?.className).toBe(
      "surface-border min-w-0 max-w-full rounded-tokenLg ds-glass bg-elevated p-0 shadow-tokenLg",
    );
  });
});

function ControlledToastHarness() {
  const [open, setOpen] = useState(true);

  return (
    <ChaseRoot>
      <ToastRegion
        items={[
          {
            id: "controlled-toast",
            title: "Controlled toast",
            description: "Closes through caller state.",
            tone: "success",
            open,
            onOpenChange: setOpen,
          },
        ]}
      />
    </ChaseRoot>
  );
}

function UncontrolledToastHarness() {
  return (
    <ChaseRoot>
      <ToastRegion
        items={[
          {
            id: "uncontrolled-toast",
            title: "Uncontrolled toast",
            description: "Closes without external state.",
            tone: "info",
          },
        ]}
      />
    </ChaseRoot>
  );
}

function MotionStatus() {
  const reducedMotion = useReducedMotion();
  const motionSettings = useChaseMotion();

  return (
    <div>
      <span>{reducedMotion ? "reduced" : "full"}</span>
      <span>{motionSettings.reducedMotionSetting}</span>
    </div>
  );
}

function mockReducedMotionPreference(matches: boolean) {
  const previousMatchMedia = window.matchMedia;
  const mediaQueryList = {
    matches,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addEventListener: vi.fn(),
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

  return () => {
    if (previousMatchMedia) {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: previousMatchMedia,
      });
      return;
    }

    Reflect.deleteProperty(window, "matchMedia");
  };
}

function DialogInteractionHarness({ title }: { title: string }) {
  const [open, setOpen] = useState(true);

  return (
    <ChaseRoot>
      <Dialog open={open} onOpenChange={setOpen} title={title}>
        Dialog body
      </Dialog>
    </ChaseRoot>
  );
}

describe("design system components", () => {
  const marketplaceNav = [{ key: "browse", label: "Browse", icon: "search" as const }];

  it("resolves theme variables", () => {
    const style = resolveThemeStyle({
      colors: {
        accent: "#000000",
        successHover: "#166534",
        dangerSoft: "#fee2e2",
        dangerHover: "#991b1b",
        trust: "#0f766e",
        ratingSoft: "#fef3c7",
        overlay: "var(--test-overlay)",
      },
      borderWidth: {
        lg: "4px",
      },
      opacity: {
        disabled: "0.5",
      },
    });

    expect(style["--accent" as never]).toBe("#000000");
    expect(style["--color-accent" as never]).toBe("#000000");
    expect(style["--danger-soft" as never]).toBe("#fee2e2");
    expect(style["--color-danger-soft" as never]).toBe("#fee2e2");
    expect(style["--error-soft" as never]).toBeUndefined();
    expect(style["--success-hover" as never]).toBe("#166534");
    expect(style["--color-danger-hover" as never]).toBe("#991b1b");
    expect(style["--trust" as never]).toBe("#0f766e");
    expect(style["--rating-soft" as never]).toBe("#fef3c7");
    expect(style["--color-overlay" as never]).toBe("var(--test-overlay)");
    expect(style["--border-width-lg" as never]).toBe("4px");
    expect(style["--opacity-disabled" as never]).toBe("0.5");
  });

  it("keeps the TypeScript theme contract aligned to CSS variables", () => {
    expect(chaseTheme.colors.brandPrimary).toBe("var(--primary)");
    expect(chaseTheme.colors.accent).toBe("var(--primary)");
    expect(chaseTheme.colors.danger).toBe("var(--danger)");
    expect(chaseTheme.colors.dangerSoft).toBe("var(--danger-soft)");
    expect(chaseTheme.typography.body).toContain("--body-font");
    expect(chaseTheme.typography.body).toContain("IBM Plex Sans");
    expect(chaseTheme.typography.fontSize["2xs"]).toBe("var(--font-size-2xs, 0.6875rem)");
    expect(chaseTheme.typography.lineHeight.display).toBe("var(--line-height-display, 1.15)");
    expect(chaseTheme.typography.letterSpacing.label).toBe("var(--letter-spacing-label, 0)");
    expect(chaseTheme.radius.md).toBe("var(--radius, 0.5rem)");
    expect(chaseTheme.radius.full).toBe("var(--radius-full, 9999px)");
    expect(chaseTheme.borderWidth.lg).toBe("var(--border-width-lg, 4px)");
    expect(chaseTheme.opacity.disabled).toBe("var(--opacity-disabled, 0.5)");
    expect(chaseTheme.spacing[4]).toBe("var(--space-4)");
    expect(expectedSpacingTokens).toHaveLength(13);
    expect(chaseTheme.motion.base).toBe("var(--motion-base, 150ms)");
    expect(chaseTheme.colors.successHover).toBe("var(--success-hover)");
    expect(chaseTheme.colors.warningActive).toBe("var(--warning-active)");
    expect(chaseTheme.colors.dangerHover).toBe("var(--danger-hover)");
    expect(chaseTheme.colors.infoContrast).toBe("var(--info-contrast)");
    expect(chaseTheme.colors.trust).toBe("var(--trust)");
    expect(chaseTheme.colors.deal).toBe("var(--deal)");
    expect(chaseTheme.colors.rating).toBe("var(--rating)");
    expect(chaseTheme.colors.ratingSoft).toBe("var(--rating-soft)");
    expect(chaseTheme.colors.overlay).toBe("var(--overlay)");
    expect(chaseTheme.colors.surfaceLine).toBe("var(--surface-line)");
    expect(chaseTheme.colors).not.toHaveProperty("cyan");
    expect(chaseTheme.colors).not.toHaveProperty("indigo");
    expect(chaseTheme.colors).not.toHaveProperty("glowAccent");
  });

  it("resolves default motion from the canonical CSS variable contract", () => {
    const motion = resolveChaseMotion();

    expect(motion.durations.fast).toBe(0.12);
    expect(motion.durations.base).toBe(0.15);
    expect(motion.durations.slow).toBe(0.24);
  });

  it("only injects explicit theme overrides for scoped runtime styles", () => {
    const style = resolveThemeOverrideStyle({
      typography: {
        body: "Instrument Sans",
        fontSize: {
          "2xs": "0.7rem",
        },
      },
      spacing: {
        4: "1.125rem",
      },
    });

    expect(style?.["--font-body" as never]).toBe("Instrument Sans");
    expect(style?.["--space-4" as never]).toBe("1.125rem");
    expect(style?.["--font-size-2xs" as never]).toBe("0.7rem");
    expect(style?.["--font-size-xs" as never]).toBeUndefined();
    expect(style?.["--color-background" as never]).toBeUndefined();
  });

  it("renders safely on the server", () => {
    const markup = renderToString(
      <ChaseRoot>
        <Button>Ship it</Button>
      </ChaseRoot>,
    );

    expect(markup).toContain("data-chase-theme");
    expect(markup).toContain('data-color-mode="system"');
    expect(markup).toContain("Ship it");
  });

  it("supports explicit reduced motion policy overrides", () => {
    render(
      <ChaseRoot reducedMotion="always">
        <MotionStatus />
      </ChaseRoot>,
    );

    expect(screen.getByText("reduced")).toBeTruthy();
    expect(screen.getByText("always")).toBeTruthy();
  });

  it("resolves the user reduced motion policy from matchMedia", async () => {
    const restoreMatchMedia = mockReducedMotionPreference(true);

    try {
      render(
        <ChaseRoot>
          <MotionStatus />
        </ChaseRoot>,
      );

      expect(await screen.findByText("reduced")).toBeTruthy();
      expect(screen.getByText("user")).toBeTruthy();
    } finally {
      restoreMatchMedia();
    }
  });

  it("hydrates reduced-motion user preference without a data attribute mismatch", async () => {
    const restoreMatchMedia = mockReducedMotionPreference(true);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const markup = renderToString(
      <ChaseRoot>
        <MotionStatus />
      </ChaseRoot>,
    );
    const container = document.createElement("div");
    let root: Root | undefined;

    expect(markup).toContain('data-reduced-motion="false"');

    container.innerHTML = markup;
    document.body.appendChild(container);

    try {
      await act(async () => {
        root = hydrateRoot(
          container,
          <ChaseRoot>
            <MotionStatus />
          </ChaseRoot>,
        );
      });

      expect(
        consoleError.mock.calls.some((call) =>
          call.some((entry) => {
            const message = String(entry).toLowerCase();

            return message.includes("data-reduced-motion") || message.includes("hydration");
          }),
        ),
      ).toBe(false);

      await waitFor(() => {
        expect(container.querySelector("[data-reduced-motion]")?.getAttribute("data-reduced-motion")).toBe("true");
      });
      expect(within(container).getByText("reduced")).toBeTruthy();
    } finally {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
      consoleError.mockRestore();
      restoreMatchMedia();
    }
  });

  it("renders empty state for empty data tables", () => {
    render(
      <DataTable
        rows={[]}
        columns={[
          {
            key: "name",
            header: "Name",
            cell: (row: { name: string }) => row.name,
          },
        ]}
      />,
    );

    expect(screen.getByText("Nothing to review")).toBeTruthy();
  });

  it("gives stacked DataTable card values room for operator content", () => {
    render(
      <DataTable
        rows={[{ jobId: "job_01JYZE8ZRQ6MR6AT7YSVQKPF4A" }]}
        columns={[
          {
            key: "job",
            header: "Job",
            cell: (row: { jobId: string }) => row.jobId,
          },
        ]}
      />,
    );

    const cardValue = within(screen.getByRole("list")).getByText("job_01JYZE8ZRQ6MR6AT7YSVQKPF4A").closest("dd");

    expect(cardValue?.className).toContain("max-w-[75%]");
    expect(cardValue?.className).not.toContain("max-w-[60%]");
  });

  it("exposes DataTable loading state to assistive technology", () => {
    const columns = [{ key: "name", header: "Name", cell: (row: { name: string }) => row.name }];
    const { container, rerender } = render(<DataTable rows={[]} columns={columns} loading />);
    const tableRoot = container.firstElementChild;

    expect(tableRoot?.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("Loading table data");

    rerender(<DataTable rows={[{ name: "Alpha" }]} columns={columns} loading={false} />);

    expect(tableRoot?.getAttribute("aria-busy")).toBe("false");
    expect(screen.getByRole("status").textContent).toBe("Table data loaded");
  });

  it("exposes DataTable sort state on sortable column headers", () => {
    const columns = [
      { key: "name", header: "Name", cell: (row: { name: string; price: number }) => row.name, sortable: true },
      { key: "price", header: "Price", cell: (row: { name: string; price: number }) => row.price, sortable: true },
      { key: "stock", header: "Stock", cell: () => "Available" },
    ];
    const { rerender } = render(
      <DataTable
        rows={[{ name: "Alpha", price: 10 }]}
        columns={columns}
        sortKey="name"
        sortDirection="asc"
        onSortChange={() => {}}
      />,
    );

    expect(screen.getByRole("columnheader", { name: "Name" }).getAttribute("aria-sort")).toBe("ascending");
    expect(screen.getByRole("columnheader", { name: "Price" }).getAttribute("aria-sort")).toBe("none");
    expect(screen.getByRole("columnheader", { name: "Stock" }).hasAttribute("aria-sort")).toBe(false);

    rerender(
      <DataTable
        rows={[{ name: "Alpha", price: 10 }]}
        columns={columns}
        sortKey="price"
        sortDirection="desc"
        onSortChange={() => {}}
      />,
    );

    expect(screen.getByRole("columnheader", { name: "Name" }).getAttribute("aria-sort")).toBe("none");
    expect(screen.getByRole("columnheader", { name: "Price" }).getAttribute("aria-sort")).toBe("descending");
  });

  it("exposes LoadingSpinner updates as status text", () => {
    render(<LoadingSpinner label="Refreshing inventory" />);

    const status = screen.getByRole("status");

    expect(status.textContent).toBe("Refreshing inventory");
    expect(status.getAttribute("aria-live")).toBe("polite");
  });

  it("renders open dialogs", () => {
    render(
      <ChaseRoot>
        <Dialog open title="Review listing">
          Content body
        </Dialog>
      </ChaseRoot>,
    );

    expect(screen.getByText("Review listing")).toBeTruthy();
    expect(screen.getByText("Content body")).toBeTruthy();
  });

  it("uses motion-safe scroll areas for overlay content", async () => {
    const { unmount } = render(
      <ChaseRoot>
        <Dialog open title="Review listing">
          Content body
        </Dialog>
      </ChaseRoot>,
    );

    expect(document.querySelector(".motion-safe-scroll-area")?.textContent).toContain("Content body");

    unmount();

    const combobox = render(
      <ChaseRoot>
        <Combobox label="Condition" items={[{ value: "nm", label: "Near Mint" }]} />
      </ChaseRoot>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Condition" }));

    expect((await screen.findByRole("listbox")).getAttribute("class")).toContain("motion-safe-scroll-area");

    combobox.unmount();

    render(
      <ChaseRoot>
        <Select
          label="Expansion"
          items={Array.from({ length: 200 }, (_, index) => ({
            value: `set-${index + 1}`,
            label: `Expansion ${index + 1}`,
          }))}
        />
      </ChaseRoot>,
    );

    await userEvent.click(screen.getByRole("combobox", { name: "Expansion" }));

    const longSelectListbox = await screen.findByRole("listbox");
    expect(longSelectListbox.getAttribute("class")).toContain("motion-safe-scroll-area");
    expect(longSelectListbox.getAttribute("class")).toContain("overscroll-contain");
    expect(longSelectListbox.getAttribute("class")).toContain("[touch-action:pan-y]");
  });

  it("selects values from Base UI select popups", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(
      <ChaseRoot>
        <Select
          label="Condition"
          items={[
            { value: "lp", label: "Lightly Played" },
            { value: "nm", label: "Near Mint" },
          ]}
          onValueChange={onValueChange}
        />
      </ChaseRoot>,
    );

    await user.click(screen.getByRole("combobox", { name: "Condition" }));
    const option = await screen.findByRole("option", { name: "Near Mint" });

    await user.click(option);

    expect(onValueChange).toHaveBeenCalledWith("nm");
  });

  it("names the combobox trigger and rejects unnamed controls in its field", () => {
    const labeled = render(
      <ChaseRoot>
        <Combobox
          label="Condition"
          placeholder="Filter print condition"
          items={[{ value: "nm", label: "Near Mint" }]}
        />
      </ChaseRoot>,
    );
    const labeledField = within(labeled.container);

    expect(labeledField.getByRole("button", { name: "Condition" })).toBeTruthy();
    expect(labeledField.queryByRole("button", { name: "" })).toBeNull();
    expect(labeledField.queryByRole("combobox", { name: "" })).toBeNull();

    const unlabeled = render(
      <ChaseRoot>
        <Combobox placeholder="Filter card condition" items={[{ value: "lp", label: "Lightly Played" }]} />
      </ChaseRoot>,
    );

    expect(within(unlabeled.container).getByRole("button", { name: "" })).toBeTruthy();
  });

  it("renders secondary descriptions in combobox options", async () => {
    const user = userEvent.setup();

    render(
      <ChaseRoot>
        <Combobox
          label="Expansion"
          items={[
            {
              value: "me04",
              label: "Mega Evolution",
              description: "Mega Evolution Series - 217 official cards",
            },
            {
              value: "base1",
              label: "Base Set",
              description: "Base - 102 official cards",
            },
          ]}
        />
      </ChaseRoot>,
    );

    await user.click(screen.getByRole("button", { name: "Expansion" }));

    expect(await screen.findByText("Mega Evolution Series - 217 official cards")).toBeTruthy();
    expect(screen.getByRole("option", { name: "Mega Evolution" })).toBeTruthy();

    await user.type(screen.getByRole("combobox", { name: "Expansion" }), "base");

    expect(screen.getByText("Base - 102 official cards")).toBeTruthy();
    expect(screen.getByRole("option", { name: "Base Set" })).toBeTruthy();
    expect(screen.queryByText("Mega Evolution Series - 217 official cards")).toBeNull();
  });

  it("uses shared control sizing for comparable controls", () => {
    const markup = renderToString(
      <ChaseRoot>
        <div>
          <TextInput label="Name" />
          <SearchInput label="Search" />
          <PasswordInput label="Password" />
          <NativeSelect label="Native select" items={[{ value: "one", label: "One" }]} />
          <Select label="Select" items={[{ value: "one", label: "One" }]} />
          <Combobox label="Combobox" items={[{ value: "one", label: "One" }]} />
          <Autocomplete label="Autocomplete" items={[{ value: "one", label: "One" }]} />
          <NumberField label="Number" />
          <TagInput label="Tags" values={[]} />
          <Button>Action</Button>
          <IconButton label="Icon action" icon="check" />
          <SegmentedControl
            value="table"
            items={[
              { value: "table", label: "Table" },
              { value: "cards", label: "Cards" },
            ]}
          />
        </div>
      </ChaseRoot>,
    );

    expect(markup).toContain("min-h-[var(--control-md-height)]");
    expect(markup).toContain("px-[var(--control-md-px)]");
    expect(markup).toContain("py-[var(--control-md-py)]");
    expect(markup).toContain("min-h-[var(--control-sm-height)]");
    expect(markup).toContain("min-w-[var(--control-sm-height)]");
    expect(markup).toContain("min-w-[var(--control-md-height)]");
    expect(markup).not.toContain("touch-target");
    expect(markup).not.toContain("px-4 py-2.5");
  });

  it("uses density-aware control variables in compact mode", () => {
    const markup = renderToString(
      <ChaseRoot density="compact">
        <div>
          <TextInput label="Name" />
          <Select label="Select" items={[{ value: "one", label: "One" }]} />
          <Button>Action</Button>
        </div>
      </ChaseRoot>,
    );

    expect(markup).toContain('data-density="compact"');
    expect(markup).toContain("min-h-[var(--control-md-height)]");
    expect(markup).toContain("px-[var(--control-md-px)]");
  });

  it("uses inset-only shells for compound controls", () => {
    const markup = renderToString(
      <ChaseRoot>
        <div>
          <Combobox label="Combobox" items={[{ value: "one", label: "One" }]} />
          <Autocomplete label="Autocomplete" items={[{ value: "one", label: "One" }]} />
          <NumberField label="Number" />
          <TagInput label="Tags" values={[]} />
        </div>
      </ChaseRoot>,
    );

    expect(markup).toContain("p-[var(--control-compound-inset)]");
    expect(markup).toContain("py-0");
    expect(markup).not.toContain(" p-0");
    expect(markup).not.toContain("py-[var(--control-md-py)]");
  });

  it("closes dialogs with Escape and backdrop interaction", async () => {
    const { unmount } = render(<DialogInteractionHarness title="Escape dialog" />);

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Escape dialog" })).toBeNull();
    });

    unmount();
    render(<DialogInteractionHarness title="Backdrop dialog" />);

    const backdrop = document.querySelector(".fixed.inset-0.z-modal");
    expect(backdrop).toBeTruthy();

    fireEvent.pointerDown(backdrop as Element);
    fireEvent.click(backdrop as Element);

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Backdrop dialog" })).toBeNull();
    });
  });

  it("fires menu item selections", async () => {
    const onSelect = vi.fn();

    render(
      <ChaseRoot>
        <Menu trigger={<Button>Actions</Button>} items={[{ key: "duplicate", label: "Duplicate listing", onSelect }]} />
      </ChaseRoot>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Duplicate listing" }));

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("keeps disabled menu items discoverable without firing selections", async () => {
    const onSelect = vi.fn();

    render(
      <ChaseRoot>
        <Menu
          trigger={<Button>Actions</Button>}
          items={[{ key: "archive", label: "Archive listing", disabled: true, onSelect }]}
        />
      </ChaseRoot>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    const menuItem = await screen.findByRole("menuitem", { name: "Archive listing" });

    expect(menuItem.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(menuItem);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("respects controlled open state for popovers and menus", async () => {
    const onPopoverOpenChange = vi.fn();
    const onMenuOpenChange = vi.fn();
    const { rerender } = render(
      <ChaseRoot>
        <Popover open trigger={<Button>Filters</Button>} title="Saved filters" onOpenChange={onPopoverOpenChange}>
          Filter body
        </Popover>
        <Menu
          open={false}
          trigger={<Button>Actions</Button>}
          items={[{ key: "duplicate", label: "Duplicate listing" }]}
          onOpenChange={onMenuOpenChange}
        />
      </ChaseRoot>,
    );

    expect(await screen.findByText("Filter body")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));

    expect(onMenuOpenChange).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("menuitem", { name: "Duplicate listing" })).toBeNull();

    rerender(
      <ChaseRoot>
        <Popover open={false} trigger={<Button>Filters</Button>} title="Saved filters">
          Filter body
        </Popover>
        <Menu open trigger={<Button>Actions</Button>} items={[{ key: "duplicate", label: "Duplicate listing" }]} />
      </ChaseRoot>,
    );

    expect(screen.queryByText("Filter body")).toBeNull();
    expect(await screen.findByRole("menuitem", { name: "Duplicate listing" })).toBeTruthy();
  });

  it("maps Banner tone to live-region semantics", () => {
    render(
      <ChaseRoot>
        <Banner tone="danger" title="Payment failed" description="Update the card." />
        <Banner tone="info" title="Sync queued" />
      </ChaseRoot>,
    );

    const alert = screen.getByRole("alert");
    const status = screen.getByRole("status");

    expect(alert.textContent).toContain("Payment failed");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(status.textContent).toContain("Sync queued");
    expect(status.getAttribute("aria-live")).toBe("polite");
  });

  it("marks the final breadcrumb as the current page", () => {
    const markup = renderToString(
      <Breadcrumbs
        items={[
          { label: "Catalog", href: "/catalog" },
          { label: "Pokemon", href: "/catalog/pokemon" },
          { label: "Base Set" },
        ]}
      />,
    );

    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain("Base Set");
  });

  it("keeps pagination ends keyboard-discoverable with aria-disabled no-ops", () => {
    const onPageChange = vi.fn();

    render(<Pagination page={1} totalPages={3} onPageChange={onPageChange} />);

    const previous = screen.getByRole("button", { name: "Previous page" }) as HTMLButtonElement;
    const next = screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement;

    expect(previous.disabled).toBe(false);
    expect(previous.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(previous);
    expect(onPageChange).not.toHaveBeenCalled();

    expect(next.disabled).toBe(false);
    expect(next.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(next);
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("updates checkbox and switch state through user interaction", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    const onSwitchChange = vi.fn();

    render(
      <ChaseRoot>
        <Checkbox label="Accept terms" onCheckedChange={onCheckedChange} />
        <Switch label="Auto price" onCheckedChange={onSwitchChange} />
      </ChaseRoot>,
    );

    await user.click(screen.getByRole("checkbox", { name: "Accept terms" }));
    await user.click(screen.getByRole("switch", { name: "Auto price" }));

    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(onSwitchChange).toHaveBeenCalledWith(true);
  });

  it("shows and hides tooltips from trigger focus", async () => {
    render(
      <ChaseRoot>
        <Tooltip content="Price includes marketplace fees">
          <button type="button">Fee help</button>
        </Tooltip>
      </ChaseRoot>,
    );

    fireEvent.focus(screen.getByRole("button", { name: "Fee help" }));

    expect(await screen.findByText("Price includes marketplace fees")).toBeTruthy();

    fireEvent.blur(screen.getByRole("button", { name: "Fee help" }));

    await waitFor(() => {
      expect(screen.queryByText("Price includes marketplace fees")).toBeNull();
    });
  });

  it("respects controlled open state for tooltips", async () => {
    const onOpenChange = vi.fn();

    render(
      <ChaseRoot>
        <Tooltip open={false} content="Price includes marketplace fees" onOpenChange={onOpenChange}>
          <button type="button">Fee help</button>
        </Tooltip>
      </ChaseRoot>,
    );

    fireEvent.focus(screen.getByRole("button", { name: "Fee help" }));

    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.queryByText("Price includes marketplace fees")).toBeNull();
  });

  it("selects autocomplete options", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(
      <ChaseRoot>
        <Autocomplete
          label="Character"
          items={[
            { value: "charizard", label: "Charizard" },
            { value: "pikachu", label: "Pikachu" },
          ]}
          onValueChange={onValueChange}
        />
      </ChaseRoot>,
    );

    await user.click(screen.getByRole("combobox", { name: "Character" }));
    await user.click(await screen.findByRole("option", { name: "Pikachu" }));

    expect(onValueChange).toHaveBeenCalledWith("Pikachu");
  });

  it("names the autocomplete trigger and rejects unnamed controls in its field", () => {
    const labeled = render(
      <ChaseRoot>
        <Autocomplete
          label="Character"
          placeholder="Find a character"
          items={[{ value: "charizard", label: "Charizard" }]}
        />
      </ChaseRoot>,
    );
    const labeledField = within(labeled.container);

    expect(labeledField.getByRole("button", { name: "Character" })).toBeTruthy();
    expect(labeledField.queryByRole("button", { name: "" })).toBeNull();
    expect(labeledField.queryByRole("combobox", { name: "" })).toBeNull();

    const unlabeled = render(
      <ChaseRoot>
        <Autocomplete placeholder="Find a trainer" items={[{ value: "misty", label: "Misty" }]} />
      </ChaseRoot>,
    );

    expect(within(unlabeled.container).getByRole("button", { name: "" })).toBeTruthy();
  });

  it("increments number fields through Base UI controls", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(
      <ChaseRoot>
        <NumberField
          label="Quantity"
          defaultValue={1}
          onValueChange={onValueChange}
          incrementLabel="Increase quantity"
          decrementLabel="Decrease quantity"
        />
      </ChaseRoot>,
    );

    await user.click(screen.getByRole("button", { name: "Increase quantity" }));

    expect(onValueChange).toHaveBeenCalledWith(2);
  });

  it("updates toggle and toggle group state", async () => {
    const user = userEvent.setup();
    const onPressedChange = vi.fn();
    const onValueChange = vi.fn();

    render(
      <ChaseRoot>
        <Toggle aria-label="Watch listing" onPressedChange={onPressedChange} />
        <ToggleGroup
          label="View mode"
          items={[
            { value: "grid", label: "Grid" },
            { value: "list", label: "List" },
          ]}
          onValueChange={onValueChange}
        />
      </ChaseRoot>,
    );

    await user.click(screen.getByRole("button", { name: "Watch listing" }));
    await user.click(screen.getByRole("button", { name: "List" }));

    expect(onPressedChange).toHaveBeenCalledWith(true);
    expect(onValueChange).toHaveBeenCalledWith(["list"]);
  });

  it("keeps icon-bearing segmented controls above the active pill with inherited state color", () => {
    render(
      <ChaseRoot>
        <SegmentedControl
          label="Choose intent"
          items={[
            { value: "sell", label: "Sell", icon: "store" },
            { value: "buy", label: "Buy", icon: "cart" },
            { value: "both", label: "Both", icon: "users" },
          ]}
          value="sell"
        />
      </ChaseRoot>,
    );

    const group = screen.getByRole("radiogroup", { name: "Choose intent" });
    const selected = within(group).getByRole("radio", { name: "Sell" });
    const inactive = within(group).getByRole("radio", { name: "Buy" });
    const foreground = selected.querySelector("span.relative.z-10");
    const icon = selected.querySelector("svg")?.parentElement;
    const inactiveIcon = inactive.querySelector("svg")?.parentElement;

    expect(screen.queryByRole("tablist")).toBeNull();
    expect(selected.getAttribute("aria-checked")).toBe("true");
    expect(selected.className).toContain("text-accent");
    expect(inactive.getAttribute("aria-checked")).toBe("false");
    expect(inactive.className).toContain("text-secondary");
    expect(foreground?.className).toContain("inline-flex");
    expect(icon?.className).toContain("text-current");
    expect(inactiveIcon?.className).toContain("text-current");
    expect(foreground?.contains(icon ?? null)).toBe(true);
  });

  it("lets toggle group icons inherit pressed and unpressed state color", () => {
    render(
      <ChaseRoot>
        <ToggleGroup
          label="View mode"
          defaultValue={["list"]}
          items={[
            { value: "grid", label: "Grid", icon: "grid" },
            { value: "list", label: "List", icon: "cart" },
            { value: "locked", label: "Locked", icon: "lock", disabled: true },
          ]}
        />
      </ChaseRoot>,
    );

    const inactive = screen.getByRole("button", { name: "Grid" });
    const active = screen.getByRole("button", { name: "List" });
    const disabled = screen.getByRole("button", { name: "Locked" });
    const inactiveIcon = inactive.querySelector("svg")?.parentElement;
    const activeIcon = active.querySelector("svg")?.parentElement;
    const disabledIcon = disabled.querySelector("svg")?.parentElement;

    expect(inactive.className).toContain("text-secondary");
    expect(active.className).toContain("text-accent");
    expect(disabled.className).toContain("opacity-disabled");
    expect(inactiveIcon?.className).toContain("text-current");
    expect(activeIcon?.className).toContain("text-current");
    expect(disabledIcon?.className).toContain("text-current");
    expect(inactiveIcon?.className).not.toContain("text-accent");
    expect(activeIcon?.className).not.toContain("text-accent");
    expect(disabledIcon?.className).not.toContain("text-accent");
  });

  it("renders toolbar and navigation menu wrappers", async () => {
    const user = userEvent.setup();

    render(
      <ChaseRoot>
        <Toolbar label="Listing tools">
          <ToolbarButton icon="search">Find</ToolbarButton>
          <ToolbarSeparator />
          <ToolbarInput aria-label="Filter listings" />
        </Toolbar>
        <NavigationMenu
          items={[
            { value: "browse", label: "Browse", href: "#browse", active: true },
            {
              value: "sell",
              label: "Sell",
              content: <div>Sales workflows</div>,
            },
          ]}
        />
      </ChaseRoot>,
    );

    expect(screen.getByRole("toolbar", { name: "Listing tools" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Find" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Filter listings" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Primary navigation" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Browse" }).getAttribute("href")).toBe("#browse");

    await user.click(screen.getByRole("button", { name: "Sell" }));

    expect(await screen.findByText("Sales workflows")).toBeTruthy();
  });

  it("keeps dropdown chevrons above the active top nav pill", () => {
    render(
      <ChaseRoot>
        <TopNav
          items={[
            { key: "browse", label: "Browse", icon: "search" },
            {
              key: "sell",
              label: "Sell",
              icon: "store",
              children: [{ key: "listings", label: "Listings", href: "/account/listings" }],
            },
          ]}
          activeKey="listings"
        />
      </ChaseRoot>,
    );

    const sellTrigger = screen.getByRole("button", { name: "Sell" });
    const chevronWrapper = sellTrigger.querySelector("svg")?.parentElement?.parentElement;

    expect(sellTrigger).toBeTruthy();
    expect(chevronWrapper?.className).toContain("relative z-10");
  });

  it("renders motion primitives safely on the server", () => {
    const markup = renderToString(
      <ChaseRoot reducedMotion="never">
        <Stagger>
          <Reveal preset="lift">
            <div>Animated card</div>
          </Reveal>
          <ViewTransition transitionKey="search">
            <div>Animated page</div>
          </ViewTransition>
        </Stagger>
      </ChaseRoot>,
    );

    expect(markup).toContain("Animated card");
    expect(markup).toContain("Animated page");
  });

  it("dismisses controlled toasts through caller state", async () => {
    render(<ControlledToastHarness />);

    expect(screen.getByText("Controlled toast")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss notification" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));

    await waitFor(() => {
      expect(screen.queryByText("Controlled toast")).toBeNull();
    });
  });

  it("dismisses uncontrolled toasts without external state", async () => {
    render(<UncontrolledToastHarness />);

    expect(screen.getByText("Uncontrolled toast")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss notification" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));

    await waitFor(() => {
      expect(screen.queryByText("Uncontrolled toast")).toBeNull();
    });
  });

  it("renders the Chase Sets logo and uses it in seller badges", () => {
    const logoMarkup = renderToString(<ChaseSetsLogo title="Chase Sets logo" />);
    const badgeMarkup = renderToString(<SellerBadge name="Chase Sets" verified />);

    expect(chaseSetsLogoSvg).toContain("logoGradient");
    expect(chaseSetsLogoSvg).toContain("#c9a44e");
    expect(chaseSetsLogoSvg).toContain("prefers-color-scheme: dark");
    expect(logoMarkup).toContain('role="img"');
    expect(logoMarkup).toContain("Chase Sets logo");
    expect(logoMarkup).toContain("var(--chase-logo-mid, #c9a44e)");
    expect(badgeMarkup).toContain("Chase Sets");
    expect(badgeMarkup).toContain("Verified");
    expect(badgeMarkup).toContain("<svg");
  });

  it("renders marketplace market summaries as compact buyer signals", () => {
    const markup = renderToString(
      <MarketplaceMarketSummary
        price="$21.50"
        note="Raw / Excellent"
        facts={[
          { label: "Available", value: "3" },
          { label: "Sellers", value: "1" },
        ]}
      />,
    );

    expect(markup).toContain("$21.50");
    expect(markup).toContain("Raw / Excellent");
    expect(markup).toContain("Available");
    expect(markup).toContain("Sellers");
  });

  it("renders commerce action bars with optional intent controls", () => {
    const markup = renderToString(
      <CommerceActionBar
        intentControl={
          <SegmentedControl
            fullWidth
            aria-label="Choose intent"
            items={[
              { value: "buy", label: "Buy" },
              { value: "sell", label: "Sell" },
            ]}
            value="buy"
          />
        }
        summary="Raw / Near Mint"
        primaryAction={<button type="button">Buy</button>}
        secondaryAction={<button type="button">Make offer</button>}
      />,
    );

    expect(markup).toContain("Choose intent");
    expect(markup).toContain("Raw / Near Mint");
    expect(markup).toContain("Make offer");
  });

  it("renders commerce bottom sheets with form footer actions", () => {
    render(
      <ChaseRoot>
        <CommerceBottomSheet
          open
          title="Buy selected product"
          description="Raw / Near Mint"
          footer={
            <Button form="commerce-form" type="submit">
              Buy now
            </Button>
          }
        >
          <form id="commerce-form">Quantity</form>
        </CommerceBottomSheet>
      </ChaseRoot>,
    );

    const bottomSheet = screen.getByRole("dialog", { name: "Buy selected product" });
    expect(within(bottomSheet).getByText("Quantity")).toBeTruthy();
    expect(within(bottomSheet).getByRole("button", { name: "Buy now" })).toBeTruthy();
    expect(within(bottomSheet).getByText("Quantity").parentElement?.className).toContain("panel-edge-scroll-area");
  });

  it("renders responsive commerce and edit sheets", () => {
    const { unmount } = render(
      <ChaseRoot>
        <CommerceSheet open title="Bulk add preview" description="Inspect matching products.">
          Matching products
        </CommerceSheet>
      </ChaseRoot>,
    );

    expect(screen.getByRole("dialog", { name: "Bulk add preview" })).toBeTruthy();
    expect(screen.getByText("Matching products")).toBeTruthy();

    unmount();

    render(
      <ChaseRoot>
        <ResponsiveEditSheet open title="Edit saved address" description="Update destination details.">
          Address fields
        </ResponsiveEditSheet>
      </ChaseRoot>,
    );

    expect(screen.getByRole("dialog", { name: "Edit saved address" })).toBeTruthy();
    expect(screen.getByText("Address fields")).toBeTruthy();
  });

  it("renders notification center sheets with feed and settings actions", () => {
    const onViewChange = vi.fn();
    const onMarkRead = vi.fn();

    render(
      <ChaseRoot>
        <NotificationCenterSheet
          open
          view="feed"
          unreadCount={1}
          notifications={[
            {
              deliveryId: "del_1",
              title: "Shipment updated",
              body: "Your order is moving.",
              sourceLabel: "Shipments",
              createdAtLabel: "Today",
              read: false,
            },
          ]}
          preferences={[
            {
              key: "product-alerts",
              label: "Product alerts",
              description: "Notify when watched products match.",
              enabled: true,
            },
          ]}
          productAlerts={[
            {
              id: "alert_1",
              title: "Charizard / Near Mint",
              detail: "Listings · at or below $20",
              status: "active",
              productHref: "/items/card_1",
            },
          ]}
          onViewChange={onViewChange}
          onMarkRead={onMarkRead}
        />
      </ChaseRoot>,
    );

    const sheet = screen.getByRole("dialog", { name: "Notifications" });
    expect(within(sheet).getByText("Shipment updated")).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Mark read" }));
    expect(onMarkRead).toHaveBeenCalledWith("del_1");
    fireEvent.click(within(sheet).getByRole("button", { name: "Settings" }));
    expect(onViewChange).toHaveBeenCalledWith("settings");
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
          "2xl": "2xl:flex-row",
        },
        column: {
          base: "flex-col",
          sm: "sm:flex-col",
          md: "md:flex-col",
          lg: "lg:flex-col",
          xl: "xl:flex-col",
          "2xl": "2xl:flex-col",
        },
      },
    );

    expect(result).toContain("flex-row");
    expect(result).toContain("md:flex-col");
  });

  it("resolves spacing classes from static maps", () => {
    expect(resolveSpaceClass("gap", 5)).toBe("gap-5");
    expect(resolveSpaceClass("p", 6)).toBe("p-6");
    expect(resolveSpaceClass("px", 12)).toBe("px-12");
  });

  it("renders responsive spacing props on layout primitives", () => {
    const markup = renderToString(
      <ChaseRoot>
        <Box
          padding={{ base: 3, md: 6 }}
          paddingX={{ base: 2, lg: 4 }}
          paddingY={{ base: 1, sm: 3 }}
          gap={{ base: 2, xl: 5 }}
        >
          Box content
        </Box>
        <Stack gap={{ base: 1, md: 4 }}>
          <span>Stack content</span>
        </Stack>
        <Surface padding={{ base: 4, md: 8 }} gap={{ base: 2, lg: 6 }}>
          Surface content
        </Surface>
      </ChaseRoot>,
    );

    expect(markup).toContain("p-3");
    expect(markup).toContain("md:p-6");
    expect(markup).toContain("px-2");
    expect(markup).toContain("lg:px-4");
    expect(markup).toContain("py-1");
    expect(markup).toContain("sm:py-3");
    expect(markup).toContain("gap-2");
    expect(markup).toContain("xl:gap-5");
    expect(markup).toContain("gap-1");
    expect(markup).toContain("md:gap-4");
    expect(markup).toContain("p-4");
    expect(markup).toContain("md:p-8");
    expect(markup).toContain("lg:gap-6");
  });

  it("renders Text size as a responsive prop with breakpoint-prefixed classes", () => {
    const markup = renderToString(
      <Text size={{ base: "sm", sm: "md", md: "lg", lg: "2xs", xl: "xs", "2xl": "3xs" }}>Responsive text</Text>,
    );

    expect(markup).toContain("text-sm");
    expect(markup).toContain("sm:text-base");
    expect(markup).toContain("md:text-lg");
    expect(markup).toContain("lg:text-2xs");
    expect(markup).toContain("xl:text-xs");
    expect(markup).toContain("2xl:text-3xs");
  });

  it("preserves scalar Text size class output", () => {
    const scalarMarkup = renderToString(<Text size="lg">Scalar text</Text>);
    expect(scalarMarkup).toContain('class="leading-relaxed text-lg text-foreground font-normal"');
    expect(scalarMarkup).not.toContain("sm:text-lg");

    const defaultMarkup = renderToString(<Text>Default text</Text>);
    expect(defaultMarkup).toContain('class="leading-relaxed text-base text-foreground font-normal"');
  });

  it("renders FlexItem minWidth as a responsive prop with breakpoint-prefixed classes", () => {
    const markup = renderToString(<FlexItem minWidth={{ base: "none", md: "control" }}>Item</FlexItem>);

    expect(markup).toContain("md:min-w-[14rem]");
  });

  it("preserves scalar FlexItem minWidth class output", () => {
    const controlMarkup = renderToString(<FlexItem minWidth="control">Item</FlexItem>);
    expect(controlMarkup).toContain('class="max-w-full min-w-[14rem]"');

    const noneMarkup = renderToString(<FlexItem minWidth="none">Item</FlexItem>);
    expect(noneMarkup).toContain('class="max-w-full"');

    const defaultMarkup = renderToString(<FlexItem>Item</FlexItem>);
    expect(defaultMarkup).toContain('class="max-w-full"');
  });

  it("preserves scalar Text truncate class output", () => {
    const truncatedMarkup = renderToString(<Text truncate>Scalar truncate</Text>);
    expect(truncatedMarkup).toContain("truncate");
    expect(truncatedMarkup).not.toContain("md:truncate");

    const untruncatedMarkup = renderToString(<Text truncate={false}>Plain text</Text>);
    expect(untruncatedMarkup).not.toContain("truncate");
  });

  it("scopes Text truncate to a breakpoint, undoing all three truncate properties above it", () => {
    const markup = renderToString(<Text truncate={{ base: true, md: false }}>Breakpoint truncate</Text>);

    expect(markup).toContain("truncate");
    expect(markup).not.toContain("md:truncate");
    expect(markup).toContain("md:overflow-visible");
    expect(markup).toContain("md:text-clip");
    expect(markup).toContain("md:whitespace-normal");
  });

  it("renders FlexItem minWidth 0 to let a truncating child shrink past its content size", () => {
    const markup = renderToString(<FlexItem minWidth="0">Item</FlexItem>);
    expect(markup).toContain('class="max-w-full min-w-0"');
  });

  it("grows LinkText's hit area on coarse pointers only when touchTarget is set", () => {
    const defaultMarkup = renderToString(<LinkText href="/help">Help</LinkText>);
    expect(defaultMarkup).not.toContain("pointer-coarse:min-h-11");

    const touchTargetMarkup = renderToString(
      <LinkText href="/help" touchTarget>
        Help
      </LinkText>,
    );
    expect(touchTargetMarkup).toContain("pointer-coarse:min-h-11");
    expect(touchTargetMarkup).toContain("pointer-coarse:min-w-11");
  });

  it("renders AutoGrid minItemWidth as a responsive prop with breakpoint-prefixed classes", () => {
    const markup = renderToString(<AutoGrid minItemWidth={{ base: "sm", md: "lg" }}>Grid</AutoGrid>);

    expect(markup).toContain("grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]");
    expect(markup).toContain("md:grid-cols-[repeat(auto-fit,minmax(22rem,1fr))]");
  });

  it("preserves scalar AutoGrid minItemWidth class output", () => {
    const mdMarkup = renderToString(<AutoGrid minItemWidth="md">Grid</AutoGrid>);
    expect(mdMarkup).toContain('class="grid grid-cols-[repeat(auto-fit,minmax(18rem,1fr))] gap-4"');

    const defaultMarkup = renderToString(<AutoGrid>Grid</AutoGrid>);
    expect(defaultMarkup).toContain('class="grid grid-cols-[repeat(auto-fit,minmax(18rem,1fr))] gap-4"');
  });

  it("maps Container system props to classes without leaking DOM attributes", () => {
    const markup = renderToString(
      <Container gap={3} textAlign="center" data-testid="container">
        Container content
      </Container>,
    );

    expect(markup).toContain("gap-3");
    expect(markup).toContain("text-center");
    expect(markup).toContain('data-testid="container"');
    expect(markup).not.toContain('gap="3"');
    expect(markup).not.toContain("textAlign");
  });

  it("keeps Tailwind spacing keys aligned to SpaceToken CSS variables", () => {
    const spacing = tailwindConfig.theme?.extend?.spacing as Record<string, string> | undefined;

    expect(spacing).toBeDefined();

    for (const token of expectedSpacingTokens) {
      expect(spacing?.[String(token)]).toBe(chaseTheme.spacing[token]);
    }
  });

  it("keeps Tailwind semantic aliases aligned to token CSS variables", () => {
    const colors = tailwindConfig.theme?.extend?.colors as Record<string, string> | undefined;
    const borderRadius = tailwindConfig.theme?.extend?.borderRadius as Record<string, string> | undefined;
    const borderWidth = tailwindConfig.theme?.extend?.borderWidth as Record<string, string> | undefined;
    const opacity = tailwindConfig.theme?.extend?.opacity as Record<string, string> | undefined;

    expect(colors?.["success-soft"]).toBe("var(--color-success-soft)");
    expect(colors?.["warning-hover"]).toBe("var(--color-warning-hover)");
    expect(colors?.["danger-active"]).toBe("var(--color-danger-active)");
    expect(colors?.["info-contrast"]).toBe("var(--color-info-contrast)");
    expect(colors?.trust).toBe("var(--color-trust)");
    expect(colors?.["trust-soft"]).toBe("var(--color-trust-soft)");
    expect(colors?.deal).toBe("var(--color-deal)");
    expect(colors?.["deal-soft"]).toBe("var(--color-deal-soft)");
    expect(colors?.rating).toBe("var(--color-rating)");
    expect(colors?.["rating-soft"]).toBe("var(--color-rating-soft)");
    expect(colors?.overlay).toBe("var(--color-overlay)");
    expect(borderRadius?.tokenFull).toBe("var(--radius-full)");
    expect(borderWidth?.tokenLg).toBe("var(--border-width-lg)");
    expect(opacity?.disabled).toBe("var(--opacity-disabled)");
    expect(opacity?.overlay).toBe("var(--opacity-overlay)");
  });

  it("renders Rating with correct number of stars", () => {
    const markup = renderToString(<Rating value={3} max={5} label="Product rating" />);

    expect(markup).toContain('aria-label="Product rating"');
    // 3 filled stars have fill="currentColor", 2 empty stars do not
    const filledCount = (markup.match(/fill="currentColor"/g) || []).length;
    expect(filledCount).toBe(3);
  });

  it("renders interactive Rating with radio role", () => {
    render(
      <ChaseRoot>
        <Rating value={3} max={5} interactive label="Rate this" />
      </ChaseRoot>,
    );

    expect(screen.getByRole("radiogroup")).toBeTruthy();
  });

  it("renders Accordion items", () => {
    render(
      <ChaseRoot>
        <Accordion
          type="single"
          collapsible
          items={[
            { value: "item1", trigger: "Section 1", content: <div>Content 1</div> },
            { value: "item2", trigger: "Section 2", content: <div>Content 2</div> },
          ]}
        />
      </ChaseRoot>,
    );

    expect(screen.getByText("Section 1")).toBeTruthy();
    expect(screen.getByText("Section 2")).toBeTruthy();
  });

  it("renders section-list Accordion as a flush single-surface list", () => {
    const { container } = render(
      <ChaseRoot>
        <Accordion
          data-testid="section-list-accordion"
          type="single"
          variant="sectionList"
          edge="card"
          defaultValue="item1"
          items={[
            { value: "item1", trigger: "Section 1", content: <div>Content 1</div> },
            { value: "item2", trigger: "Section 2", content: <div>Content 2</div> },
          ]}
        />
      </ChaseRoot>,
    );

    const accordion = screen.getByTestId("section-list-accordion");
    expect(accordion.className).toContain("overflow-hidden");
    expect(accordion.className).toContain("-mx-4");
    expect(accordion.className).toContain("first:-mt-4");
    expect(accordion.className).toContain("first:rounded-t-tokenLg");
    expect(accordion.className).toContain("last:-mb-4");
    expect(accordion.className).toContain("last:rounded-b-tokenLg");
    expect(accordion.className).not.toContain("modern-surface");
    expect(container.querySelector('[class*="before:absolute"]')).toBeTruthy();
  });

  it("keeps Accordion content visible when reduced motion changes after initial render", async () => {
    const items = [{ value: "language", trigger: "Language", content: <button>English</button> }];
    const view = render(
      <ChaseRoot reducedMotion="never">
        <Accordion id="motion-state" type="multiple" items={items} />
      </ChaseRoot>,
    );
    const panel = document.getElementById("motion-state-panel-language")!;
    expect(panel.style.height).toBe("0px");
    view.rerender(
      <ChaseRoot reducedMotion="always">
        <Accordion id="motion-state" type="multiple" items={items} />
      </ChaseRoot>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Language" }));
    await waitFor(() => expect(panel.style.height).toBe("auto"));
    expect(panel.style.opacity).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "Language" }));
    await waitFor(() => expect(panel.style.height).toBe("0px"));
  });

  it("renders panel section accordions with an edge-aligned rail", () => {
    const { container } = render(
      <ChaseRoot>
        <PanelSectionAccordion
          data-testid="sheet-list-accordion"
          type="single"
          edge="panel"
          defaultValue="item1"
          items={[
            { value: "item1", trigger: "Section 1", content: <div>Content 1</div> },
            { value: "item2", trigger: "Section 2", content: <div>Content 2</div> },
          ]}
        />
      </ChaseRoot>,
    );

    const accordion = screen.getByTestId("sheet-list-accordion");
    const activeTrigger = screen.getByRole("button", { name: /Section 1/ });
    const activePanel = screen.getByText("Content 1").parentElement;

    expect(accordion.className).toContain("-mx-5");
    expect(accordion.className).toContain("w-[calc(100%+2.5rem)]");
    expect(accordion.className).toContain("self-stretch");
    expect(accordion.className).toContain("first:-mt-5");
    expect(accordion.className).toContain("first:rounded-t-tokenXl");
    expect(accordion.className).toContain("last:-mb-5");
    expect(accordion.className).toContain("last:rounded-b-tokenXl");
    expect(activeTrigger.className).toContain("px-5");
    expect(activePanel?.className).toContain("pl-12");
    expect(container.querySelector('[class*="before:w-1"]')).toBeTruthy();
  });

  it.each(["compact", "panel"] as const)(
    "separates %s horizontal bleed from vertical edges and keeps insets symbolic",
    (edge) => {
      render(
        <ChaseRoot>
          <PanelSectionAccordion
            data-testid="horizontal"
            edge={edge}
            bleed="horizontal"
            type="multiple"
            anchorActiveItemToScrollEnd={false}
            items={[
              { value: "a", trigger: "A", content: "First" },
              { value: "b", trigger: "B", content: "Second" },
              { value: "c", trigger: "C", content: "Third" },
            ]}
          />
        </ChaseRoot>,
      );
      const root = screen.getByTestId("horizontal");
      const variable = edge === "compact" ? "--sidebar-content-inset,0.75rem" : "--panel-content-inset,1.25rem";
      expect(root.className).toContain(`mx-[calc(-1*var(${variable}))]`);
      expect(root.className).toContain(`w-[calc(100%+2*var(${variable}))]`);
      expect(root.className).not.toMatch(/-m[tyb]-/);
      expect(root.className).toContain("first:rounded-t-");
      expect(root.className).toContain("last:rounded-b-");
      expect(root.className).toContain("[overflow-anchor:none]");
      const items = root.querySelectorAll<HTMLElement>("[data-accordion-item-value]");
      expect(items).toHaveLength(3);
      expect(items[0]!.className).toContain("border-b");
      expect(items[1]!.className).toContain("border-b");
      expect(items[2]!.className).not.toContain("border-b");
      expect(root.querySelectorAll('[class*="overflow-y"]')).toHaveLength(0);
    },
  );

  it("explicitly disabling panel anchoring keeps both scroll owners unchanged on toggle", () => {
    render(
      <ChaseRoot>
        {["desktop", "mobile"].map((id) => (
          <div key={id} data-testid={`${id}-scroll`} style={{ overflowY: "auto", height: 100 }}>
            <PanelSectionAccordion
              id={id}
              type="multiple"
              edge="panel"
              anchorActiveItemToScrollEnd={false}
              items={[{ value: "a", trigger: `${id} section`, content: "Options" }]}
            />
          </div>
        ))}
      </ChaseRoot>,
    );
    const owners = [screen.getByTestId("desktop-scroll"), screen.getByTestId("mobile-scroll")];
    owners.forEach((owner, index) => {
      owner.scrollTop = 30 + index;
    });
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      return {
        top: 0,
        bottom: owners.includes(this) ? 100 : 500,
        left: 0,
        right: 100,
        width: 100,
        height: 500,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      };
    });
    try {
      for (const id of ["desktop", "mobile"]) {
        fireEvent.click(screen.getByRole("button", { name: `${id} section` }));
        expect(owners.map((owner) => owner.scrollTop)).toEqual([30, 31]);
      }
    } finally {
      rect.mockRestore();
    }
  });

  it("aligns section-list option icons with the trigger title", () => {
    const { container } = render(
      <ChaseRoot>
        <AccordionOptionTrigger
          icon="cart"
          title="Add to cart"
          description="Save this exact selection and continue shopping."
          active
        />
      </ChaseRoot>,
    );

    expect(screen.getByText("Add to cart")).toBeTruthy();
    const classNames = Array.from(container.querySelectorAll("span"))
      .map((element) => element.className)
      .join(" ");
    expect(classNames).toContain("grid-cols-[1rem_minmax(0,1fr)]");
    expect(classNames).toContain("mt-0.5");
  });

  it("renders progressive disclosure with a visible summary and controlled state", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(
      <ChaseRoot>
        <ProgressiveDisclosure
          title="Advanced seller controls"
          description="Low-frequency listing constraints stay out of the primary form."
          summary="Limits are not set"
          open={false}
          onOpenChange={onOpenChange}
          tone="info"
          icon="settings"
        >
          <button type="button">Set account limits</button>
        </ProgressiveDisclosure>
      </ChaseRoot>,
    );

    const trigger = screen.getByRole("button", { name: /Advanced seller controls/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Limits are not set")).toBeTruthy();

    await user.click(trigger);

    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("renders progressive disclosure groups for advanced flow sections", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    render(
      <ChaseRoot>
        <ProgressiveDisclosureGroup
          title="Advanced options"
          description="Use this for optional workflow depth."
          value={["policy"]}
          onValueChange={onValueChange}
          items={[
            {
              value: "policy",
              title: "Policy details",
              summary: "Return window visible",
              content: <div>Order protection and return paths.</div>,
              icon: "shield",
              tone: "accent",
            },
            {
              value: "automation",
              title: "Automation settings",
              summary: "Manual review",
              content: <div>Routing and notification controls.</div>,
              icon: "spark",
              tone: "warning",
            },
          ]}
        />
      </ChaseRoot>,
    );

    expect(screen.getByText("Advanced options")).toBeTruthy();
    expect(screen.getByText("Return window visible")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Automation settings/ }));

    expect(onValueChange).toHaveBeenCalledWith(["policy", "automation"]);
  });

  it("renders ImageGallery with thumbnails", () => {
    const markup = renderToString(
      <ImageGallery
        images={[
          { src: "/img1.jpg", alt: "Front" },
          { src: "/img2.jpg", alt: "Back" },
        ]}
      />,
    );

    expect(markup).toContain("Front");
    expect(markup).toContain("Back");
  });

  it("renders ImageGallery product imagery in a chrome-less alpha-preserving frame", () => {
    const markup = renderToString(<ImageGallery images={[{ src: "/img1.webp", alt: "Front" }]} />);

    expect(markup).toContain("relative overflow-visible");
    expect(markup).toContain("object-contain");
    expect(markup).not.toContain("modern-surface relative overflow-hidden rounded-tokenLg border border-muted");
  });

  it("renders ImageGallery thumbnails on a left rail", () => {
    const markup = renderToString(
      <ImageGallery
        images={[
          { src: "/img1.jpg", alt: "Front" },
          { src: "/img2.jpg", alt: "Back" },
        ]}
        thumbnailPlacement="left"
      />,
    );

    expect(markup).toContain("flex items-start justify-center gap-3");
    expect(markup).toContain("w-16 shrink-0 flex-col");
  });

  it("renders ImageGallery empty states inside the gallery frame", () => {
    const markup = renderToString(<ImageGallery images={[]} emptyState={<div>Gallery placeholder</div>} />);

    expect(markup).toContain("Gallery placeholder");
  });

  it("renders ImageGallery fallback imagery when no images are provided", () => {
    const markup = renderToString(
      <ImageGallery
        images={[]}
        fallbackImage={{ src: "/fallback-card-back.png", alt: "Card back" }}
        emptyState={<div>Gallery placeholder</div>}
      />,
    );

    expect(markup).toContain('src="/fallback-card-back.png"');
    expect(markup).toContain('alt="Card back"');
  });

  it("renders CopyButton with label", () => {
    render(
      <ChaseRoot>
        <CopyButton value="test-value" label="Copy ID" />
      </ChaseRoot>,
    );

    expect(screen.getByText("Copy ID")).toBeTruthy();
  });

  it("renders TagInput with tag values", () => {
    render(
      <ChaseRoot>
        <TagInput values={["Pokemon", "Charizard"]} placeholder="Add tag" />
      </ChaseRoot>,
    );

    expect(screen.getByText("Pokemon")).toBeTruthy();
    expect(screen.getByText("Charizard")).toBeTruthy();
  });

  it("renders PasswordInput with visibility toggle", () => {
    render(
      <ChaseRoot>
        <PasswordInput label="Password" />
      </ChaseRoot>,
    );

    expect(screen.getByLabelText("Password")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show password" })).toBeTruthy();
  });

  it("renders SkipLink with target and label", () => {
    const markup = renderToString(<SkipLink targetId="main" label="Skip navigation" />);

    expect(markup).toContain('href="#main"');
    expect(markup).toContain("Skip navigation");
  });

  it("renders Card with media slot", () => {
    const markup = renderToString(
      <Card media={<img src="/card.jpg" alt="Card" />}>
        <div>Card content</div>
      </Card>,
    );

    expect(markup).toContain("Card content");
    expect(markup).toContain('alt="Card"');
  });

  it("keeps Card overflow clipped by default while allowing provider overlays to escape", () => {
    const defaultMarkup = renderToString(<Card>Default card</Card>);
    const providerMarkup = renderToString(<Card overflow="visible">Provider card</Card>);

    expect(defaultMarkup).toContain("overflow-hidden");
    expect(defaultMarkup).not.toContain("overflow-visible");
    expect(providerMarkup).toContain("overflow-visible");
    expect(providerMarkup).not.toContain("overflow-hidden");
  });

  it("exposes a compound Card slot API for header, body, and footer composition", () => {
    expect(typeof Card.Header).toBe("function");
    expect(typeof Card.Title).toBe("function");
    expect(typeof Card.Description).toBe("function");
    expect(typeof Card.Body).toBe("function");
    expect(typeof Card.Footer).toBe("function");

    const markup = renderToString(
      <Card>
        <Card.Header>
          <Card.Title>Listing summary</Card.Title>
          <Card.Description>Raw / Near Mint</Card.Description>
        </Card.Header>
        <Card.Body>
          <div>Quantity available: 3</div>
        </Card.Body>
        <Card.Footer>
          <button type="button">Buy now</button>
        </Card.Footer>
      </Card>,
    );

    expect(markup).toContain("Listing summary");
    expect(markup).toContain("Raw / Near Mint");
    expect(markup).toContain("Quantity available: 3");
    expect(markup).toContain("Buy now");
    // Canonical conventions: semantic title heading and secondary description tone, no raw var() passthrough.
    expect(markup).toContain("<h3");
    expect(markup).toContain("font-heading");
    expect(markup).toContain("text-secondary");
    expect(markup).not.toContain("var(--muted-foreground)");
  });

  it("renders ProductCard with contained image fit", () => {
    const markup = renderToString(
      <ProductCard
        title="2020 Pikachu VMAX"
        subtitle="PSA 10"
        price="$1,250"
        imageSrc="/demo-assets/pikachu-card.svg"
        imageAlt="Pikachu card"
        imageFit="contain"
      />,
    );

    expect(markup).toContain("2020 Pikachu VMAX");
    expect(markup).toContain('alt="Pikachu card"');
  });

  it("swaps ProductCard to the fallback image when the primary image fails", () => {
    render(
      <ChaseRoot>
        <ProductCard
          title="2020 Pikachu VMAX"
          imageSrc="/missing-card.png"
          imageAlt="Pikachu card"
          fallbackImageSrc="/pokemon-card-back.png"
          fallbackImageAlt="Pokemon card back"
        />
      </ChaseRoot>,
    );

    fireEvent.error(screen.getByAltText("Pikachu card"));

    const fallbackImage = screen.getByAltText("Pokemon card back");
    expect(fallbackImage.getAttribute("src")).toBe("/pokemon-card-back.png");
  });

  it("renders ProductCard as a link when href is provided", () => {
    const markup = renderToString(<ProductCard href="/items/pikachu" title="2020 Pikachu VMAX" price="$1,250" />);

    expect(markup).toContain("<a");
    expect(markup).toContain('href="/items/pikachu"');
    expect(markup).toContain("2020 Pikachu VMAX");
  });

  it("renders ProductCard as a button when onSelect is provided", () => {
    render(
      <ChaseRoot>
        <ProductCard title="Selectable card" selectLabel="Open selectable card" onSelect={() => {}} />
      </ChaseRoot>,
    );

    expect(screen.getByRole("button", { name: "Open selectable card" })).toBeTruthy();
  });

  it("renders marketplace product cards with canonical status and action language", () => {
    const markup = renderToString(
      <MarketplaceProductCard
        href="/items/pikachu"
        title="Pikachu"
        subtitle="Jungle 60/64"
        description="Classic electric single"
        status="available"
        price="From $21.50"
        meta="3 listings • 5 available"
        actionLabel="View listings"
        categoryTags={["Pokemon TCG", "Singles"]}
        metadataTags={["jungle", "pikachu"]}
      />,
    );

    expect(markup).toContain("Available now");
    expect(markup).toContain("From $21.50");
    expect(markup).toContain("View listings");
    expect(markup).toContain("Pokemon TCG");
  });

  it("renders marketplace facet rails from design-system patterns", () => {
    const facetMarkup = renderToString(
      <MarketplaceFacetRail
        items={[
          { id: "pokemon", label: "Pokemon TCG", count: 7 },
          { id: "comics", label: "Comics", count: 6 },
          { id: "figures", label: "Figures", count: 5 },
          { id: "sneakers", label: "Sneakers", count: 4 },
          { id: "cards", label: "Trading Cards", count: 3 },
          { id: "games", label: "Video Games", count: 2 },
          { id: "coins", label: "Coins", count: 1 },
        ]}
        selectedId="pokemon"
        searchable
        onSelect={() => {}}
      />,
    );
    const facetStripMarkup = renderToString(
      <MarketplaceFacetStrip
        title="Condition"
        allLabel="Any Condition"
        items={[{ id: "near-mint", label: "Near Mint", count: 3 }]}
        selectedIds={["near-mint"]}
        onSelect={() => {}}
      />,
    );
    const statusMarkup = renderToString(<MarketStatusBadge status="marketOnly" />);

    expect(facetMarkup).not.toContain("Browse Categories");
    expect(facetMarkup).toContain("Pokemon TCG (7)");
    expect(facetMarkup).toContain("Show more");
    expect(facetMarkup).not.toContain("<section");
    expect(facetMarkup).not.toContain(
      "ds-glass overflow-hidden rounded-tokenLg border border-muted shadow-tokenSm bg-surface-2",
    );
    expect(facetMarkup).not.toContain("overflow-y-auto");
    expect(facetStripMarkup).toContain("Condition");
    expect(facetStripMarkup).toContain("Near Mint (3)");
    expect(statusMarkup).toContain("Market only");
  });

  it("renders token swatches for the spec board", () => {
    const markup = renderToString(<TokenSwatch label="Primary Blue" value="#3882F6" color="brandPrimary" />);

    expect(markup).toContain("Primary Blue");
    expect(markup).toContain("#3882F6");
  });

  it("renders NativeSelect with accessible label and placeholder", () => {
    render(
      <ChaseRoot>
        <NativeSelect label="Condition" placeholder="Choose condition" items={[{ value: "nm", label: "Near Mint" }]} />
      </ChaseRoot>,
    );

    expect(screen.getByLabelText("Condition")).toBeTruthy();
    expect(screen.getByText("Choose condition")).toBeTruthy();
  });

  it("renders DataTable with sortable column headers", () => {
    const markup = renderToString(
      <DataTable
        rows={[{ name: "Alpha", price: 10 }]}
        columns={[
          { key: "name", header: "Name", cell: (r: { name: string }) => r.name, sortable: true },
          { key: "price", header: "Price", cell: (r: { price: number }) => r.price },
        ]}
        sortKey="name"
        sortDirection="asc"
        onSortChange={() => {}}
      />,
    );

    expect(markup).toContain("Alpha");
    // Sortable header renders as a button
    expect(markup).toContain("<button");
    expect(markup).toContain("Name");
  });

  it("renders ColorModeToggle with current mode label", () => {
    render(
      <ChaseRoot>
        <ColorModeToggle value="dark" onValueChange={() => {}} />
      </ChaseRoot>,
    );

    expect(screen.getByText("Dark")).toBeTruthy();
  });

  it("emits controlled theme preference changes without owning persistence", () => {
    const onValueChange = vi.fn();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    document.documentElement.dataset.themePreference = "system";

    render(<ThemePreferenceControl value="system" onValueChange={onValueChange} />);

    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));

    expect(onValueChange).toHaveBeenCalledWith("dark");
    expect(setItem).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.themePreference).toBe("system");

    setItem.mockRestore();
    delete document.documentElement.dataset.themePreference;
  });

  it("keeps ThemeToggle standalone behavior opt-in when a value is controlled", () => {
    const onValueChange = vi.fn();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    document.documentElement.dataset.themePreference = "system";

    render(<ThemeToggle value="system" onValueChange={onValueChange} />);

    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));

    expect(onValueChange).toHaveBeenCalledWith("dark");
    expect(setItem).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.themePreference).toBe("system");

    setItem.mockRestore();
    delete document.documentElement.dataset.themePreference;
  });

  it("renders Wizard with step content", () => {
    const markup = renderToString(
      <Wizard
        steps={[
          { key: "step1", label: "First", content: <div>Step 1 content</div> },
          { key: "step2", label: "Second", content: <div>Step 2 content</div> },
        ]}
        activeStep="step1"
        onStepChange={() => {}}
      />,
    );

    expect(markup).toContain("Step 1 content");
    expect(markup).toContain("First");
    expect(markup).toContain("Second");
  });

  it("renders marketplace shells with a main landmark and skip link target", () => {
    render(
      <ChaseRoot>
        <MarketplaceShell
          brand={<div>Brand</div>}
          topNavItems={marketplaceNav}
          bottomNavItems={marketplaceNav}
          activeKey="browse"
          search={<div>Marketplace search</div>}
        >
          <div>Body</div>
        </MarketplaceShell>
      </ChaseRoot>,
    );

    const main = screen.getByRole("main");

    expect(main.getAttribute("id")).toBe("main-content");
    expect(main.getAttribute("tabindex")).toBe("-1");
    expect(main.getAttribute("class")).toContain("relative z-0");
    expect(main.parentElement?.getAttribute("class")).toContain("[--shell-header-height:7.75rem]");
    expect(main.parentElement?.getAttribute("class")).toContain("md:[--shell-header-height:4rem]");
    expect(main.parentElement?.getAttribute("class")).toContain("[--shell-bottom-nav-height:5.25rem]");
    expect(main.parentElement?.getAttribute("class")).toContain("md:[--shell-bottom-nav-height:0px]");
    expect(screen.getByRole("link", { name: "Skip to main content" }).getAttribute("href")).toBe("#main-content");
    expect(screen.getByText("Marketplace search")).toBeTruthy();
  });

  it("renders admin shells with a main landmark and skip link target", () => {
    render(
      <ChaseRoot>
        <AdminShell brand={<div>Brand</div>} navItems={marketplaceNav} activeKey="browse">
          <div>Body</div>
        </AdminShell>
      </ChaseRoot>,
    );

    const main = screen.getByRole("main");

    expect(main.getAttribute("id")).toBe("main-content");
    expect(main.getAttribute("tabindex")).toBe("-1");
    // With local navigation the below-lg header band gains the sticky section bar.
    expect(main.parentElement?.getAttribute("class")).toContain("[--shell-header-height:7rem]");
    expect(main.parentElement?.getAttribute("class")).toContain("lg:[--shell-header-height:4rem]");
    expect(main.parentElement?.getAttribute("class")).toContain("[--shell-bottom-nav-height:5.25rem]");
    expect(main.parentElement?.getAttribute("class")).toContain("md:[--shell-bottom-nav-height:0px]");
    expect(screen.getByRole("link", { name: "Skip to main content" }).getAttribute("href")).toBe("#main-content");
  });

  it("renders sectionless admin shells without empty local navigation chrome", () => {
    render(
      <ChaseRoot>
        <AdminShell brand={<div>Admin</div>} navItems={[]}>
          <div>Root state</div>
        </AdminShell>
      </ChaseRoot>,
    );

    expect(screen.getByRole("main").getAttribute("class")).not.toContain("lg:grid-cols-[16rem_minmax(0,1fr)]");
    expect(screen.getByRole("main").parentElement?.getAttribute("class")).toContain("[--shell-header-height:4rem]");
    expect(screen.getByRole("main").parentElement?.getAttribute("class")).not.toContain("[--shell-header-height:7rem]");
    expect(screen.getByRole("main").parentElement?.getAttribute("class")).toContain("[--shell-bottom-nav-height:0px]");
    expect(screen.queryByRole("navigation", { name: "Section navigation" })).toBeNull();
    expect(document.querySelector("[data-admin-section-bar]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sections" })).toBeNull();
    expect(screen.getByText("Root state")).toBeTruthy();
  });

  it("renders admin top-level section navigation through the top app bar", () => {
    render(
      <ChaseRoot>
        <AdminShell
          brand={<div>Brand</div>}
          topNavItems={[
            { key: "catalog", label: "Catalog", href: "/catalog/dimensions" },
            { key: "platform", label: "Platform", href: "/platform/projections" },
          ]}
          topNavActiveKey="platform"
          navItems={marketplaceNav}
          activeKey="browse"
          actions={<Button>Sign out</Button>}
        >
          <div>Body</div>
        </AdminShell>
      </ChaseRoot>,
    );

    const topNav = screen.getByRole("navigation", { name: "Primary navigation" });

    expect(within(topNav).getAllByRole("link", { name: "Catalog" })[0]?.getAttribute("href")).toBe(
      "/catalog/dimensions",
    );
    expect(within(topNav).getAllByRole("link", { name: "Platform" })[0]?.getAttribute("aria-current")).toBe("page");
    expect(within(topNav).getByLabelText("Admin menu")).toBeTruthy();
    expect(within(topNav).getAllByRole("link", { name: "Catalog" })[1]?.getAttribute("href")).toBe(
      "/catalog/dimensions",
    );
    expect(within(topNav).getAllByRole("link", { name: "Platform" })[1]?.getAttribute("aria-current")).toBe("page");
    expect(within(topNav).getAllByRole("button", { name: "Sign out" })).toHaveLength(2);
  });

  const adminSectionNav = [
    { key: "dimensions", label: "Dimensions", icon: "search" as const, href: "/catalog/dimensions" },
    {
      key: "integrations",
      label: "Integrations",
      icon: "rocket" as const,
      children: [
        { key: "integrations-import", label: "Import", href: "/catalog/integrations" },
        { key: "integrations-health", label: "Integration health", href: "/catalog/integrations/health" },
      ],
    },
    { key: "scopes", label: "Scopes", href: "/catalog/scopes" },
    { key: "reference-records", label: "Reference records", href: "/catalog/reference-types" },
    { key: "settings", label: "Settings", href: "/catalog/settings" },
  ];

  it("renders the below-lg admin section bar with a tablet drawer trigger and a current-section trail", () => {
    render(
      <ChaseRoot>
        <AdminShell brand={<div>Brand</div>} navItems={adminSectionNav} activeKey="integrations-import">
          <div>Body</div>
        </AdminShell>
      </ChaseRoot>,
    );

    const bar = document.querySelector("[data-admin-section-bar]");
    expect(bar).toBeTruthy();
    // Visible only below lg (desktop keeps the persistent side nav) and pinned
    // under the 4rem top app bar so orientation survives scrolling.
    expect(bar?.getAttribute("class")).toContain("lg:hidden");
    expect(bar?.getAttribute("class")).toContain("sticky top-16");

    // The drawer trigger is a tablet-band affordance: hidden on phones (bottom
    // nav owns phone navigation) and revealed from md up within the below-lg bar.
    const trigger = screen.getByRole("button", { name: "Sections" });
    expect(trigger.parentElement?.getAttribute("class")).toContain("hidden md:block");

    // The current-section trail resolves nested children to a parent > child path
    // and marks the leaf as the current page.
    const trail = screen.getByRole("navigation", { name: "Current section" });
    expect(within(trail).getByText("Integrations")).toBeTruthy();
    expect(within(trail).getByText("Import").getAttribute("aria-current")).toBe("page");

    // Below-lg header geometry accounts for the section bar; lg restores 4rem.
    const main = screen.getByRole("main");
    expect(main.parentElement?.getAttribute("class")).toContain("[--shell-header-height:7rem]");
    expect(main.parentElement?.getAttribute("class")).toContain("lg:[--shell-header-height:4rem]");

    // Existing phone and desktop navigation paths stay untouched.
    const sideNavWrapper = main.firstElementChild;
    expect(sideNavWrapper?.getAttribute("class")).toContain("hidden lg:block");
    const bottomNav = document.querySelector("nav.fixed");
    expect(bottomNav?.getAttribute("class")).toContain("md:hidden");
    expect(within(bottomNav as HTMLElement).getByText("More")).toBeTruthy();
  });

  it("opens the tablet sections drawer and closes it when the active section changes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ChaseRoot>
        <AdminShell brand={<div>Brand</div>} navItems={adminSectionNav} activeKey="integrations-import">
          <div>Body</div>
        </AdminShell>
      </ChaseRoot>,
    );

    await user.click(screen.getByRole("button", { name: "Sections" }));
    const drawer = await screen.findByRole("dialog", { name: "Sections" });

    // The full section tree is reachable inside the drawer: one tap on the
    // trigger plus one tap on any destination link.
    expect(within(drawer).getByRole("link", { name: "Import" }).getAttribute("href")).toBe("/catalog/integrations");
    expect(within(drawer).getByRole("link", { name: "Integration health" }).getAttribute("href")).toBe(
      "/catalog/integrations/health",
    );
    expect(within(drawer).getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/catalog/settings");

    // Route selection re-renders the shell with the new activeKey; the drawer
    // must close on that signal because plain link navigation never fires
    // onOpenChange.
    rerender(
      <ChaseRoot>
        <AdminShell brand={<div>Brand</div>} navItems={adminSectionNav} activeKey="integrations-health">
          <div>Body</div>
        </AdminShell>
      </ChaseRoot>,
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sections" })).toBeNull());
    expect(
      within(screen.getByRole("navigation", { name: "Current section" })).getByText("Integration health"),
    ).toBeTruthy();
  });

  it("keeps the default Badge soft tone rendering unchanged for existing tones", () => {
    const neutralMarkup = renderToString(<Badge>Stable</Badge>);
    const successMarkup = renderToString(<Badge tone="success">Ready</Badge>);

    // Default variant stays "soft": neutral keeps its historical soft classes.
    expect(neutralMarkup).toContain("border-muted");
    expect(neutralMarkup).toContain("bg-background");
    expect(neutralMarkup).toContain("text-secondary");
    expect(neutralMarkup).toContain("shadow-tokenSm");
    // Existing semantic tones keep their soft tint.
    expect(successMarkup).toContain("border-success-soft");
    expect(successMarkup).toContain("bg-success-soft");
    expect(successMarkup).toContain("text-success");
  });

  it("renders the new commerce Badge tones with soft token classes", () => {
    expect(renderToString(<Badge tone="trust">Verified</Badge>)).toContain("bg-trust-soft");
    expect(renderToString(<Badge tone="trust">Verified</Badge>)).toContain("text-trust");
    expect(renderToString(<Badge tone="deal">On sale</Badge>)).toContain("bg-deal-soft");
    expect(renderToString(<Badge tone="deal">On sale</Badge>)).toContain("text-deal");
    expect(renderToString(<Badge tone="rating">Top rated</Badge>)).toContain("bg-rating-soft");
    expect(renderToString(<Badge tone="rating">Top rated</Badge>)).toContain("text-rating");
  });

  it("covers compat secondary/outline intents via the Badge style axis", () => {
    // compat `secondary` → neutral solid fill.
    const solidNeutral = renderToString(
      <Badge variant="solid" tone="neutral">
        Secondary
      </Badge>,
    );
    expect(solidNeutral).toContain("bg-background");
    expect(solidNeutral).toContain("text-secondary");

    // solid semantic tones use the strong fill + contrast text.
    const solidSuccess = renderToString(
      <Badge variant="solid" tone="success">
        Live
      </Badge>,
    );
    expect(solidSuccess).toContain("bg-success");
    expect(solidSuccess).toContain("text-success-contrast");

    // compat `outline` → transparent fill, tone-colored border + text.
    const outline = renderToString(
      <Badge variant="outline" tone="neutral">
        Outline
      </Badge>,
    );
    expect(outline).toContain("border-muted");
    expect(outline).toContain("bg-transparent");
    expect(outline).toContain("text-secondary");

    const outlineTrust = renderToString(
      <Badge variant="outline" tone="trust">
        Verified
      </Badge>,
    );
    expect(outlineTrust).toContain("border-trust");
    expect(outlineTrust).toContain("bg-transparent");
    expect(outlineTrust).toContain("text-trust");
  });

  it("flows the new tones and style axis through StatusPill and Tag", () => {
    expect(renderToString(<StatusPill tone="trust">Verified</StatusPill>)).toContain("bg-trust-soft");
    expect(renderToString(<Tag tone="deal">On sale</Tag>)).toContain("bg-deal-soft");
    expect(
      renderToString(
        <Tag variant="outline" tone="rating">
          Top rated
        </Tag>,
      ),
    ).toContain("bg-transparent");
  });

  it("registers the commerce icon glyphs as renderable IconNames", () => {
    const commerceIcons: IconName[] = ["mapPin", "packageCheck", "checkCircle", "inbox", "xCircle", "lockClosed"];

    for (const name of commerceIcons) {
      const markup = renderToString(<Icon name={name} label={name} />);
      expect(markup).toContain("<svg");
      expect(markup).toContain(`aria-label="${name}"`);
    }
  });

  it("keeps the keyhole lock distinct from the plain lock glyph", () => {
    const keyhole = renderToString(<Icon name="lock" label="Keyhole lock" />);
    const plain = renderToString(<Icon name="lockClosed" label="Plain lock" />);

    expect(keyhole).toContain("<svg");
    expect(plain).toContain("<svg");
    // Different lucide glyphs produce different path geometry.
    expect(keyhole).not.toBe(plain);
  });

  it("renders mail as an accessible envelope distinct from the message glyph", () => {
    const mail = renderToString(<Icon name="mail" label="Email sign-in link" />);
    const message = renderToString(<Icon name="message" label="Phone code" />);

    expect(mail).toContain('aria-label="Email sign-in link"');
    expect(mail).toContain('aria-hidden="false"');
    expect(mail).toContain("lucide-mail");
    expect(message).toContain("lucide-message-square");
    const paths = (markup: string) => [...markup.matchAll(/<path d="([^"]+)"/g)].map((match) => match[1]);
    expect(paths(mail)).not.toHaveLength(0);
    expect(paths(mail)).not.toEqual(paths(message));
  });
});

// Immutable oracle for the default/mount Stagger output, captured from base
// 92df7170e0dfa7b1fde72324b428f3022d4ea1ce (scratch capture over `git show
// <base>:packages/design-system/src/motion/primitives.tsx`), never from the
// changed implementation. Markup covers the Stagger subtree only; motion props
// are the group's `initial`/`animate`/`variants` and each child's `variants`.
const baseStaggerEase = [0.16, 1, 0.3, 1];
const baseStaggerFixture = {
  default: {
    markup:
      '<div><div style="opacity:0;transform:translateY(14px) scale(0.985)"><div>First</div></div><div style="opacity:0;transform:translateY(14px) scale(0.985)"><div>Second</div></div><div style="opacity:0;transform:translateY(14px) scale(0.985)"><div>Third</div></div></div>',
    group: {
      initial: "hidden",
      animate: "visible",
      variants: { hidden: {}, visible: { transition: { staggerChildren: 0.07, delayChildren: 0 } } },
    },
    children: Array.from({ length: 3 }, () => ({
      variants: {
        hidden: { opacity: 0, y: 14, scale: 0.985 },
        visible: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.15, ease: baseStaggerEase } },
      },
    })),
  },
  configured: {
    markup:
      '<div><div style="opacity:0;transform:translateY(22px)"><div>First</div></div><div style="opacity:0;transform:translateY(22px)"><div>Second</div></div><div style="opacity:0;transform:translateY(22px)"><div>Third</div></div></div>',
    group: {
      initial: "hidden",
      animate: "visible",
      variants: { hidden: {}, visible: { transition: { staggerChildren: 0.12, delayChildren: 0 } } },
    },
    children: Array.from({ length: 3 }, () => ({
      variants: {
        hidden: { opacity: 0, y: 22 },
        visible: { opacity: 1, y: 0, transition: { duration: 0.15, ease: baseStaggerEase } },
      },
    })),
  },
};

const staggerChildLabels = ["First", "Second", "Third"] as const;

function staggerChildren() {
  return staggerChildLabels.map((label) => <div key={label}>{label}</div>);
}

// The latest Stagger render: the group followed by its three child wrappers.
function recordedStaggerRenders() {
  const [group, ...children] = motionDivRenders.slice(-(staggerChildLabels.length + 1));

  return {
    group: { initial: group.initial, animate: group.animate, variants: group.variants, transition: group.transition },
    children: children.map((child) => ({
      initial: child.initial,
      animate: child.animate,
      variants: child.variants,
      transition: child.transition,
    })),
  };
}

function inlineStyles(markup: string) {
  return [...markup.matchAll(/style="([^"]*)"/g)].map((match) => match[1]);
}

interface IntersectionObserverMockInstance {
  callback: IntersectionObserverCallback;
  options: IntersectionObserverInit | undefined;
  observe: ReturnType<typeof vi.fn>;
  unobserve: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function installIntersectionObserverMock() {
  const instances: IntersectionObserverMockInstance[] = [];

  class IntersectionObserverMock implements IntersectionObserverMockInstance {
    readonly root = null;
    readonly rootMargin = "0px";
    readonly thresholds: number[];
    readonly options: IntersectionObserverInit | undefined;
    readonly observe = vi.fn();
    readonly unobserve = vi.fn();
    readonly disconnect = vi.fn();
    readonly takeRecords = vi.fn(() => []);

    constructor(
      readonly callback: IntersectionObserverCallback,
      options?: IntersectionObserverInit,
    ) {
      this.options = options;
      this.thresholds = Array.isArray(options?.threshold) ? options.threshold : [options?.threshold ?? 0];
      instances.push(this);
    }
  }

  vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);

  return {
    instances,
    async deliver(instance: IntersectionObserverMockInstance, target: Element, ratios: number[]) {
      const entries = ratios.map(
        (ratio) =>
          ({
            target,
            intersectionRatio: ratio,
            isIntersecting: ratio > 0,
            time: 0,
            rootBounds: null,
            boundingClientRect: target.getBoundingClientRect(),
            intersectionRect: target.getBoundingClientRect(),
          }) as IntersectionObserverEntry,
      );

      await act(async () => {
        instance.callback(entries, instance as unknown as IntersectionObserver);
      });
    },
    restore() {
      vi.unstubAllGlobals();
    },
  };
}

async function settleFrames() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

function hydratedStaggerHarness() {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const container = document.createElement("div");
  let root: Root | undefined;

  document.body.appendChild(container);

  return {
    container,
    consoleError,
    async hydrate(ui: ReactNode) {
      const markup = renderToString(ui);
      container.innerHTML = markup;

      await act(async () => {
        root = hydrateRoot(container, ui);
      });

      return markup;
    },
    async rerender(ui: ReactNode) {
      await act(async () => {
        root?.render(ui);
      });
    },
    childWrappers() {
      return staggerChildLabels.map((label) => within(container).getByText(label).parentElement as HTMLElement);
    },
    group() {
      return this.childWrappers()[0].parentElement as HTMLElement;
    },
    hydrationErrors() {
      return consoleError.mock.calls.filter((call) =>
        call.some((entry) => /hydrat|did not match|server rendered/i.test(String(entry))),
      );
    },
    async cleanup() {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
      consoleError.mockRestore();
    },
  };
}

function expectVisibleWrapper(wrapper: HTMLElement) {
  expect(wrapper.style.opacity).not.toBe("0");
  expect(["", "none"]).toContain(wrapper.style.transform);
}

function expectHiddenWrapper(wrapper: HTMLElement) {
  expect(wrapper.style.opacity).toBe("0");
}

async function waitForOrderedReveal(wrappers: HTMLElement[]) {
  const revealOrder: number[] = [];

  await waitFor(
    () => {
      wrappers.forEach((wrapper, index) => {
        if (wrapper.style.opacity === "1" && !revealOrder.includes(index)) {
          revealOrder.push(index);
        }
      });

      // A later child may never be fully revealed before an earlier one; a
      // stalled frame can only make reveals look simultaneous, never inverted.
      expect(revealOrder).toEqual(revealOrder.map((_, index) => index));
      expect(revealOrder).toHaveLength(wrappers.length);
    },
    { timeout: 4000, interval: 10 },
  );
}

describe("Stagger in-view trigger", () => {
  it("preserves base Stagger markup and child motion props for default and mount triggers", () => {
    const cases = [
      { name: "default", props: {} },
      { name: "configured", props: { preset: "slideUp", staggerMs: 120 } },
    ] as const;

    for (const { name, props } of cases) {
      for (const trigger of [undefined, "mount"] as const) {
        motionDivRenders.length = 0;
        const markup = renderToString(
          <Stagger {...props} {...(trigger ? { trigger } : {})}>
            {staggerChildren()}
          </Stagger>,
        );
        const expected = baseStaggerFixture[name];

        expect(markup).toBe(expected.markup);
        expect(recordedStaggerRenders()).toEqual({ group: expected.group, children: expected.children });
      }
    }
  });

  it("renders all in-view Stagger children visibly on the server and hydrates without warnings", async () => {
    const harness = hydratedStaggerHarness();

    try {
      const markup = await harness.hydrate(
        <ChaseRoot reducedMotion="never">
          <Stagger trigger="in-view">{staggerChildren()}</Stagger>
        </ChaseRoot>,
      );
      const styles = inlineStyles(markup);

      for (const label of staggerChildLabels) {
        expect(markup).toContain(label);
      }
      expect(styles.length).toBeGreaterThanOrEqual(staggerChildLabels.length);
      for (const style of styles) {
        expect(style).not.toContain("opacity:0");
        for (const transform of style.matchAll(/transform:([^;]*)/g)) {
          expect(transform[1]).toBe("none");
        }
      }

      expect(harness.hydrationErrors()).toEqual([]);
      await settleFrames();
      harness.childWrappers().forEach(expectVisibleWrapper);
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps in-view Stagger visible when IntersectionObserver is unavailable", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const harness = hydratedStaggerHarness();

    try {
      expect(typeof IntersectionObserver).toBe("undefined");
      await harness.hydrate(
        <ChaseRoot reducedMotion="never">
          <Stagger trigger="in-view">{staggerChildren()}</Stagger>
        </ChaseRoot>,
      );
      await settleFrames();

      expect(harness.consoleError.mock.calls).toEqual([]);
      harness.childWrappers().forEach(expectVisibleWrapper);
    } finally {
      await harness.cleanup();
      vi.unstubAllGlobals();
    }
  });

  it("arms off-screen Stagger and plays ordered children only at ratio 0.4", async () => {
    const observers = installIntersectionObserverMock();
    const harness = hydratedStaggerHarness();

    try {
      await harness.hydrate(
        <ChaseRoot reducedMotion="never">
          <Stagger trigger="in-view" staggerMs={200}>
            {staggerChildren()}
          </Stagger>
        </ChaseRoot>,
      );
      const group = harness.group();
      const wrappers = harness.childWrappers();

      expect(observers.instances).toHaveLength(1);
      const [observer] = observers.instances;
      expect(observer.observe).toHaveBeenCalledWith(group);
      expect(observer.options?.threshold).toEqual([0, 0.4]);
      wrappers.forEach(expectVisibleWrapper);

      await observers.deliver(observer, group, [0]);
      await waitFor(() => {
        wrappers.forEach(expectHiddenWrapper);
      });
      expect(wrappers[0].style.transform).not.toBe("none");
      expect(observer.disconnect).not.toHaveBeenCalled();

      await observers.deliver(observer, group, [0.3]);
      await settleFrames();
      wrappers.forEach(expectHiddenWrapper);
      expect(observer.disconnect).not.toHaveBeenCalled();

      motionDivRenders.length = 0;
      await observers.deliver(observer, group, [0.4]);
      await waitForOrderedReveal(wrappers);
      wrappers.forEach(expectVisibleWrapper);
      expect(observer.disconnect).toHaveBeenCalled();

      const playing = recordedStaggerRenders();
      expect(playing.group).toMatchObject({
        animate: "visible",
        variants: { visible: { transition: { staggerChildren: 0.2, delayChildren: 0 } } },
      });
      expect(playing.children.map((child) => child.variants)).toEqual(
        staggerChildLabels.map(() => ({
          hidden: { opacity: 0, y: 14, scale: 0.985, transition: { duration: 0 } },
          visible: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.15, ease: [0.16, 1, 0.3, 1] } },
        })),
      );
    } finally {
      await harness.cleanup();
      observers.restore();
    }
  });

  it("never hides Stagger initially intersecting at ratio 0.3", async () => {
    const observers = installIntersectionObserverMock();
    const harness = hydratedStaggerHarness();

    try {
      await harness.hydrate(
        <ChaseRoot reducedMotion="never">
          <Stagger trigger="in-view">{staggerChildren()}</Stagger>
        </ChaseRoot>,
      );
      const group = harness.group();
      const wrappers = harness.childWrappers();
      const [observer] = observers.instances;

      await observers.deliver(observer, group, [0.3]);
      await settleFrames();
      wrappers.forEach(expectVisibleWrapper);
      expect(observer.disconnect).toHaveBeenCalled();

      await observers.deliver(observer, group, [0]);
      await observers.deliver(observer, group, [0.4]);
      await settleFrames();
      wrappers.forEach(expectVisibleWrapper);
      expect(motionDivRenders.some((call) => call.animate === "hidden")).toBe(false);
    } finally {
      await harness.cleanup();
      observers.restore();
    }
  });

  it("never re-hides or replays completed in-view Stagger", async () => {
    const observers = installIntersectionObserverMock();
    const harness = hydratedStaggerHarness();
    const tree = (
      <ChaseRoot reducedMotion="never">
        <Stagger trigger="in-view" staggerMs={10}>
          {staggerChildren()}
        </Stagger>
      </ChaseRoot>
    );

    try {
      await harness.hydrate(tree);
      const group = harness.group();
      const wrappers = harness.childWrappers();
      const [observer] = observers.instances;

      await observers.deliver(observer, group, [0]);
      await waitFor(() => {
        wrappers.forEach(expectHiddenWrapper);
      });
      await observers.deliver(observer, group, [0.4]);
      await waitFor(() => {
        wrappers.forEach((wrapper) => expect(wrapper.style.opacity).toBe("1"));
      });
      expect(observer.disconnect).toHaveBeenCalled();

      motionDivRenders.length = 0;
      await observers.deliver(observer, group, [0]);
      await settleFrames();
      wrappers.forEach((wrapper) => expect(wrapper.style.opacity).toBe("1"));

      await observers.deliver(observer, group, [0.4]);
      await settleFrames();
      wrappers.forEach((wrapper) => expect(wrapper.style.opacity).toBe("1"));

      await harness.rerender(
        <ChaseRoot reducedMotion="never" density="compact">
          <Stagger trigger="in-view" staggerMs={10}>
            {staggerChildren()}
          </Stagger>
        </ChaseRoot>,
      );
      await observers.deliver(observer, group, [0, 0.4]);
      await settleFrames();
      wrappers.forEach((wrapper) => expect(wrapper.style.opacity).toBe("1"));

      expect(motionDivRenders.some((call) => call.animate === "hidden")).toBe(false);
      expect(observers.instances).toHaveLength(1);
      expect(observer.observe).toHaveBeenCalledTimes(1);
    } finally {
      await harness.cleanup();
      observers.restore();
    }
  });

  it("keeps in-view Stagger visible without transform or delay under always reduced motion", async () => {
    const observers = installIntersectionObserverMock();
    const harness = hydratedStaggerHarness();

    try {
      await harness.hydrate(
        <ChaseRoot reducedMotion="always">
          <Stagger trigger="in-view">{staggerChildren()}</Stagger>
        </ChaseRoot>,
      );
      const group = harness.group();
      const wrappers = harness.childWrappers();

      for (const observer of observers.instances) {
        await observers.deliver(observer, group, [0]);
      }
      await settleFrames();

      wrappers.forEach(expectVisibleWrapper);
      expect(motionDivRenders.some((call) => call.animate === "hidden")).toBe(false);

      const rendered = recordedStaggerRenders();
      expect(rendered.group).toMatchObject({
        initial: "visible",
        animate: "visible",
        variants: { visible: { transition: { staggerChildren: 0, delayChildren: 0 } } },
      });
      expect(rendered.children.map((child) => child.variants)).toEqual(
        staggerChildLabels.map(() => ({
          hidden: { opacity: 0, transition: { duration: 0 } },
          visible: { opacity: 1, transition: { duration: 0.01, ease: "linear" } },
        })),
      );
    } finally {
      await harness.cleanup();
      observers.restore();
    }
  });

  it("immediately shows armed Stagger when reduced motion resolves after mount", async () => {
    const observers = installIntersectionObserverMock();
    const harness = hydratedStaggerHarness();

    try {
      await harness.hydrate(
        <ChaseRoot reducedMotion="never">
          <Stagger trigger="in-view">{staggerChildren()}</Stagger>
        </ChaseRoot>,
      );
      const group = harness.group();
      const wrappers = harness.childWrappers();
      const [observer] = observers.instances;

      await observers.deliver(observer, group, [0]);
      await waitFor(() => {
        wrappers.forEach(expectHiddenWrapper);
      });

      await harness.rerender(
        <ChaseRoot reducedMotion="always">
          <Stagger trigger="in-view">{staggerChildren()}</Stagger>
        </ChaseRoot>,
      );
      await waitFor(() => {
        wrappers.forEach((wrapper) => {
          expect(wrapper.style.opacity).toBe("1");
          expect(["", "none"]).toContain(wrapper.style.transform);
        });
      });
      expect(observer.disconnect).toHaveBeenCalled();

      await observers.deliver(observer, group, [0]);
      await settleFrames();
      wrappers.forEach(expectVisibleWrapper);
    } finally {
      await harness.cleanup();
      observers.restore();
    }
  });

  it("ignores a mount to in-view trigger change after the group has played", async () => {
    const observers = installIntersectionObserverMock();
    const harness = hydratedStaggerHarness();

    try {
      await harness.hydrate(
        <ChaseRoot reducedMotion="never">
          <Stagger trigger="mount">{staggerChildren()}</Stagger>
        </ChaseRoot>,
      );
      const group = harness.group();
      const wrappers = harness.childWrappers();

      await waitForOrderedReveal(wrappers);
      expect(observers.instances).toHaveLength(0);

      motionDivRenders.length = 0;
      await harness.rerender(
        <ChaseRoot reducedMotion="never">
          <Stagger trigger="in-view">{staggerChildren()}</Stagger>
        </ChaseRoot>,
      );
      for (const observer of observers.instances) {
        await observers.deliver(observer, group, [0]);
      }
      await settleFrames();

      expect(observers.instances).toHaveLength(0);
      wrappers.forEach((wrapper) => expect(wrapper.style.opacity).toBe("1"));
      expect(motionDivRenders.some((call) => call.animate === "hidden")).toBe(false);
    } finally {
      await harness.cleanup();
      observers.restore();
    }
  });

  it("ignores an in-view to mount trigger change while the group is armed", async () => {
    const observers = installIntersectionObserverMock();
    const harness = hydratedStaggerHarness();

    try {
      await harness.hydrate(
        <ChaseRoot reducedMotion="never">
          <Stagger trigger="in-view" staggerMs={10}>
            {staggerChildren()}
          </Stagger>
        </ChaseRoot>,
      );
      const group = harness.group();
      const wrappers = harness.childWrappers();
      const [observer] = observers.instances;

      await observers.deliver(observer, group, [0]);
      await waitFor(() => {
        wrappers.forEach(expectHiddenWrapper);
      });

      await harness.rerender(
        <ChaseRoot reducedMotion="never">
          <Stagger trigger="mount" staggerMs={10}>
            {staggerChildren()}
          </Stagger>
        </ChaseRoot>,
      );
      await settleFrames();

      wrappers.forEach(expectHiddenWrapper);
      expect(observer.disconnect).not.toHaveBeenCalled();
      expect(observers.instances).toHaveLength(1);

      await observers.deliver(observer, group, [0.4]);
      await waitForOrderedReveal(wrappers);
      wrappers.forEach(expectVisibleWrapper);
      expect(observer.disconnect).toHaveBeenCalled();
    } finally {
      await harness.cleanup();
      observers.restore();
    }
  });
});
