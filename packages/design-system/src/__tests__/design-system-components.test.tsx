import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act, useState } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import tailwindConfig from "../../../../tailwind.config";
import {
  Button,
  CopyButton,
  IconButton,
  NavigationMenu,
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
import { Card, DataTable, ImageGallery } from "../components/data-display";
import {
  Accordion,
  AccordionOptionTrigger,
  Dialog,
  LoadingSpinner,
  Menu,
  PanelSectionAccordion,
  ProgressiveDisclosure,
  ProgressiveDisclosureGroup,
  Rating,
  ToastRegion,
  Tooltip,
} from "../components/feedback";
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
  MarketplaceLandingHero,
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
import { SkipLink } from "../primitives/layout";
import { ChaseRoot, ColorModeToggle, useChaseMotion, useReducedMotion } from "../theme/provider";
import { chaseTheme, resolveThemeOverrideStyle, resolveThemeStyle, type SpaceToken } from "../theme/tokens";
import { resolveResponsiveClass, resolveSpaceClass } from "../utils/system";

const expectedSpacingTokens = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] satisfies SpaceToken[];

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
        trust: "#0f766e",
      },
    });

    expect(style["--color-accent" as never]).toBe("#000000");
    expect(style["--trust" as never]).toBe("#0f766e");
  });

  it("keeps the TypeScript theme contract aligned to CSS variables", () => {
    expect(chaseTheme.colors.brandPrimary).toBe("var(--primary)");
    expect(chaseTheme.typography.body).toContain("--body-font");
    expect(chaseTheme.typography.body).toContain("IBM Plex Sans");
    expect(chaseTheme.radius.md).toBe("var(--radius, 0.5rem)");
    expect(chaseTheme.spacing[4]).toBe("var(--space-4)");
    expect(expectedSpacingTokens).toHaveLength(13);
    expect(chaseTheme.motion.base).toBe("var(--motion-base, 150ms)");
    expect(chaseTheme.colors.trust).toBe("var(--trust)");
    expect(chaseTheme.colors.deal).toBe("var(--deal)");
    expect(chaseTheme.colors.rating).toBe("var(--rating)");
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
      },
      spacing: {
        4: "1.125rem",
      },
    });

    expect(style?.["--font-body" as never]).toBe("Instrument Sans");
    expect(style?.["--space-4" as never]).toBe("1.125rem");
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
    expect(markup).toContain("h-[var(--control-md-icon-size)]");
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
    expect(disabled.className).toContain("opacity-50");
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

    const sellSummary = screen.getByText("Sell").closest("summary");
    const chevronWrapper = sellSummary?.querySelector("svg")?.parentElement?.parentElement;

    expect(sellSummary).toBeTruthy();
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
    expect(chaseSetsLogoSvg).toContain("#1d5fd6");
    expect(chaseSetsLogoSvg).toContain("prefers-color-scheme: dark");
    expect(logoMarkup).toContain('role="img"');
    expect(logoMarkup).toContain("Chase Sets logo");
    expect(logoMarkup).toContain("var(--chase-logo-mid, #1d5fd6)");
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

  it("keeps Tailwind spacing keys aligned to SpaceToken CSS variables", () => {
    const spacing = tailwindConfig.theme?.extend?.spacing as Record<string, string> | undefined;

    expect(spacing).toBeDefined();

    for (const token of expectedSpacingTokens) {
      expect(spacing?.[String(token)]).toBe(chaseTheme.spacing[token]);
    }
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

  it("renders marketplace facet rails and landing heroes from design-system patterns", () => {
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
    const heroMarkup = renderToString(
      <MarketplaceLandingHero
        badges={[{ label: "Verified supply", tone: "success" }]}
        title="Find collectibles worth chasing."
        description="Search live supply and compare active markets."
        search={<SearchInput hideLabel label="Search" />}
        filters={[{ id: "", label: "All", selected: true, onSelect: () => {} }]}
        metrics={[{ label: "Available Now", value: 3, detail: "With active listings" }]}
      />,
    );
    const statusMarkup = renderToString(<MarketStatusBadge status="marketOnly" />);

    expect(facetMarkup).toContain("Browse Categories");
    expect(facetMarkup).toContain("Pokemon TCG (7)");
    expect(facetMarkup).toContain("Show more");
    expect(facetMarkup).toContain("<section");
    expect(facetMarkup).not.toContain(
      "glass-surface overflow-hidden rounded-tokenLg border border-muted shadow-tokenSm bg-surface-2",
    );
    expect(facetMarkup).not.toContain("overflow-y-auto");
    expect(facetStripMarkup).toContain("Condition");
    expect(facetStripMarkup).toContain("Near Mint (3)");
    expect(heroMarkup).toContain("Find collectibles worth chasing.");
    expect(heroMarkup).toContain("Available Now");
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
        >
          <div>Body</div>
        </MarketplaceShell>
      </ChaseRoot>,
    );

    const main = screen.getByRole("main");

    expect(main.getAttribute("id")).toBe("main-content");
    expect(main.getAttribute("class")).toContain("relative z-0");
    expect(screen.getByRole("link", { name: "Skip to main content" }).getAttribute("href")).toBe("#main-content");
  });

  it("renders admin shells with a main landmark and skip link target", () => {
    render(
      <ChaseRoot>
        <AdminShell brand={<div>Brand</div>} navItems={marketplaceNav} activeKey="browse">
          <div>Body</div>
        </AdminShell>
      </ChaseRoot>,
    );

    expect(screen.getByRole("main").getAttribute("id")).toBe("main-content");
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
    expect(screen.queryByRole("navigation", { name: "Section navigation" })).toBeNull();
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
});
