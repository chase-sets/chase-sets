import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PromoBarAdminPage } from "./admin-pages";
import type { PromoBarMessage } from "../api/contracts";

const activeMessage = {
  id: "promo_1",
  title: "Fee lock",
  description: "Keep launch fees clear.",
  href: "/sales-fees",
  link_label: "See fees",
  tone: "info",
  is_active: true,
  display_order: 10,
  starts_at: null,
  ends_at: null,
  created_at: "2026-06-08T00:00:00.000Z",
  updated_at: "2026-06-08T00:00:00.000Z",
} satisfies PromoBarMessage;

describe("PromoBarAdminPage", () => {
  it("previews marketplace-relative promo links against the marketplace origin", () => {
    const html = renderToString(
      <PromoBarAdminPage
        messages={[activeMessage]}
        actionMessage={null}
        marketplaceOrigin="https://marketplace.chasesets.com"
      />,
    );

    expect(html).toContain('href="https://marketplace.chasesets.com/sales-fees"');
  });

  it("does not preview marketplace-relative promo links on the admin host without a marketplace origin", () => {
    const html = renderToString(
      <PromoBarAdminPage messages={[activeMessage]} actionMessage={null} marketplaceOrigin={null} />,
    );

    expect(html).not.toContain('href="/sales-fees"');
    expect(html).not.toContain('href="https://admin.chasesets.com/sales-fees"');
    expect(html).toContain("See fees");
  });
});
