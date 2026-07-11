// @vitest-environment jsdom
import { renderToString } from "react-dom/server";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
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

afterEach(() => {
  cleanup();
});

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
    expect(html).toContain("Fee lock");
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

  it("renders the messages table as a read-only summary with edit and delete row actions, not an inline edit form", () => {
    const html = renderToString(
      <PromoBarAdminPage messages={[activeMessage]} actionMessage={null} marketplaceOrigin={null} />,
    );

    const messagesStart = html.indexOf("Messages</h2>");
    const rowHtml = html.slice(messagesStart);

    // The row shows the read-only summary (status, message, order) and Edit/Delete actions...
    expect(rowHtml).toContain("Fee lock");
    expect(rowHtml).toContain("Keep launch fees clear.");
    expect(rowHtml).toContain(">Edit<");
    expect(rowHtml).toContain(">Delete<");

    // ...but not the full field-by-field edit form (name/link/tone/schedule inputs) inline in the row,
    // and no bare submit button can fire a delete without going through the confirmation dialog.
    expect(rowHtml).not.toContain('name="linkLabel"');
    expect(rowHtml).not.toContain('name="displayOrder"');
    expect(rowHtml).not.toContain('name="startsAt"');
    expect(rowHtml).not.toContain(">Save<");
    expect(rowHtml).not.toMatch(/<button[^>]*type="submit"[^>]*name="intent"[^>]*value="delete"/);
  });

  it("surfaces action failures visibly through a danger banner", () => {
    const html = renderToString(
      <PromoBarAdminPage
        messages={[activeMessage]}
        actionMessage={null}
        errorMessage="Promo bar message could not be saved."
        marketplaceOrigin={null}
      />,
    );

    expect(html).toContain("Promo bar action failed.");
    expect(html).toContain("Promo bar message could not be saved.");
  });

  it("surfaces action success through a banner instead of plain text", () => {
    const html = renderToString(
      <PromoBarAdminPage
        messages={[activeMessage]}
        actionMessage="Promo bar message updated."
        marketplaceOrigin={null}
      />,
    );

    expect(html).toContain("Promo bar message updated.");
  });

  it("opens a dedicated edit surface with the full message fields when Edit is clicked", async () => {
    const user = userEvent.setup();
    render(<PromoBarAdminPage messages={[activeMessage]} actionMessage={null} marketplaceOrigin={null} />);

    const [editButton] = screen.getAllByRole("button", { name: "Edit" });
    await user.click(editButton!);

    expect(await screen.findByText("Edit message")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();

    // Both the always-visible create form and the now-open edit surface expose a
    // "Link label" field; the edit surface's instance is pre-filled from the record.
    const linkLabelInputs = screen.getAllByLabelText("Link label") as HTMLInputElement[];
    expect(linkLabelInputs.some((input) => input.value === "See fees")).toBe(true);
  });

  it("requires confirmation before a row delete can submit", async () => {
    const user = userEvent.setup();
    render(<PromoBarAdminPage messages={[activeMessage]} actionMessage={null} marketplaceOrigin={null} />);

    const [deleteButton] = screen.getAllByRole("button", { name: "Delete" });
    await user.click(deleteButton!);

    expect(await screen.findByText("Delete this promo bar message?")).toBeTruthy();
    expect(
      screen.getByText('The message "Fee lock" will be permanently removed from the promo bar. This cannot be undone.'),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });
});
