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

const scheduledMessage = {
  ...activeMessage,
  id: "promo_scheduled",
  title: "Tomorrow drop",
  starts_at: "2026-07-02T00:00:00.000Z",
  updated_at: "2026-06-08T00:01:00.000Z",
} satisfies PromoBarMessage;

const expiredMessage = {
  ...activeMessage,
  id: "promo_expired",
  title: "Old drop",
  ends_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-06-08T00:02:00.000Z",
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

  it("renders scheduled and expired messages outside the public preview", () => {
    const html = renderToString(
      <PromoBarAdminPage
        messages={[activeMessage, scheduledMessage, expiredMessage]}
        actionMessage={null}
        currentTime="2026-07-01T12:00:00.000Z"
        marketplaceOrigin="https://marketplace.chasesets.com"
      />,
    );

    expect(html).toContain("Fee lock");
    expect(html).toContain("Tomorrow drop");
    expect(html).toContain("Old drop");
    expect(html).toContain("Active");
    expect(html).toContain("Scheduled");
    expect(html).toContain("Expired");

    const previewStart = html.indexOf("Public preview");
    const createStart = html.indexOf("Create message");
    const previewHtml = html.slice(previewStart, createStart);
    expect(previewHtml).toContain("Fee lock");
    expect(previewHtml).not.toContain("Tomorrow drop");
    expect(previewHtml).not.toContain("Old drop");
  });
});
