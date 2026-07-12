// @vitest-environment jsdom
import { forwardRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { Breadcrumbs, BrandLink, LinkButton, TopNav } from "../components/actions";
import { ChaseRoot } from "../theme/provider";
import type { LinkAdapterProps, LinkComponent } from "../theme/link-adapter";
import { RouterLinkAdapter } from "../components/forms/router-form";

const CustomLink: LinkComponent = forwardRef<HTMLAnchorElement, LinkAdapterProps>(function CustomLink(
  { href, children, ...rest },
  ref,
) {
  return (
    <a ref={ref} href={href} data-custom-adapter="true" {...rest}>
      {children}
    </a>
  );
});

describe("LinkAdapter", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders NavigationItem, BrandLink, Breadcrumbs, and LinkButton hrefs as plain anchors by default", () => {
    render(
      <div>
        <TopNav items={[{ key: "catalog", label: "Catalog", href: "/catalog" }]} />
        <BrandLink label="Chase Sets" href="/" />
        <Breadcrumbs items={[{ label: "Pokemon", href: "/catalog/pokemon" }, { label: "Base Set" }]} />
        <LinkButton href="/checkout">Checkout</LinkButton>
      </div>,
    );

    expect(screen.getByRole("link", { name: "Catalog" }).tagName).toBe("A");
    expect(screen.getByRole("link", { name: "Chase Sets" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("link", { name: "Pokemon" }).getAttribute("href")).toBe("/catalog/pokemon");
    expect(screen.getByRole("link", { name: "Checkout" }).getAttribute("href")).toBe("/checkout");
  });

  it("renders through the link component ChaseRoot registers instead of a raw anchor", () => {
    render(
      <ChaseRoot linkComponent={CustomLink}>
        <TopNav items={[{ key: "catalog", label: "Catalog", href: "/catalog" }]} />
        <BrandLink label="Chase Sets" href="/" />
        <Breadcrumbs items={[{ label: "Pokemon", href: "/catalog/pokemon" }, { label: "Base Set" }]} />
        <LinkButton href="/checkout">Checkout</LinkButton>
      </ChaseRoot>,
    );

    expect(screen.getByRole("link", { name: "Catalog" }).getAttribute("data-custom-adapter")).toBe("true");
    expect(screen.getByRole("link", { name: "Chase Sets" }).getAttribute("data-custom-adapter")).toBe("true");
    expect(screen.getByRole("link", { name: "Pokemon" }).getAttribute("data-custom-adapter")).toBe("true");
    expect(screen.getByRole("link", { name: "Checkout" }).getAttribute("data-custom-adapter")).toBe("true");
  });

  it("keeps DS nav surfaces as real anchors (href intact for middle-click/cmd-click) when routed through RouterLinkAdapter", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/catalog",
          element: (
            <ChaseRoot linkComponent={RouterLinkAdapter}>
              <TopNav items={[{ key: "checkout", label: "Checkout", href: "/checkout" }]} />
              <Breadcrumbs items={[{ label: "Catalog", href: "/catalog" }, { label: "Base Set" }]} />
              <LinkButton href="/checkout">Go to checkout</LinkButton>
            </ChaseRoot>
          ),
        },
        { path: "/checkout", element: <div>Checkout page</div> },
      ],
      { initialEntries: ["/catalog"] },
    );

    render(<RouterProvider router={router} />);

    const navLink = screen.getByRole("link", { name: "Checkout" });
    const buttonLink = screen.getByRole("link", { name: "Go to checkout" });

    // Real anchors, so keyboard activation and modified clicks (middle-click,
    // cmd/ctrl-click to open a new tab) keep working exactly as they do today.
    expect(navLink.getAttribute("href")).toBe("/checkout");
    expect(buttonLink.getAttribute("href")).toBe("/checkout");

    fireEvent.click(buttonLink);

    expect(router.state.location.pathname).toBe("/checkout");
    expect(await screen.findByText("Checkout page")).toBeTruthy();
  });

  it("navigates client-side (no document reload) when a registered router Link's nav item is clicked", () => {
    const router = createMemoryRouter(
      [
        {
          path: "/catalog",
          element: (
            <ChaseRoot linkComponent={RouterLinkAdapter}>
              <TopNav items={[{ key: "checkout", label: "Checkout", href: "/checkout" }]} />
            </ChaseRoot>
          ),
        },
        { path: "/checkout", element: <div>Checkout page</div> },
      ],
      { initialEntries: ["/catalog"] },
    );

    render(<RouterProvider router={router} />);

    expect(router.state.location.pathname).toBe("/catalog");
    fireEvent.click(screen.getByRole("link", { name: "Checkout" }));
    expect(router.state.location.pathname).toBe("/checkout");
  });
});
