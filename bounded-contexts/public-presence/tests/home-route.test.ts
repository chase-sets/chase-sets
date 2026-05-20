import { describe, expect, it } from "vitest";
import { meta, publicPresenceHomeJsonLd } from "../routes/marketplace/home";

describe("public presence home route", () => {
  it("positions the homepage metadata around the seller beta waitlist", () => {
    expect(meta({} as never)).toEqual(
      expect.arrayContaining([
        { title: "Chase Sets Seller Beta Waitlist | Trading Card Marketplace" },
        {
          name: "description",
          content: "Join the Chase Sets seller beta waitlist for 0% seller fee locks, no separate seller payment-processing fee, bulk card workflows, and buyer-visible delivered totals.",
        },
      ]),
    );
  });

  it("exposes structured data for the public waitlist action", () => {
    expect(publicPresenceHomeJsonLd()).toMatchObject({
      "@context": "https://schema.org",
      "@graph": expect.arrayContaining([
        expect.objectContaining({
          "@type": "Organization",
          name: "Chase Sets",
          contactPoint: expect.objectContaining({
            "@type": "ContactPoint",
            email: "support@chasesets.com",
          }),
        }),
        expect.objectContaining({
          "@type": "WebSite",
          name: "Chase Sets",
          url: "https://chasesets.com/",
          potentialAction: {
            "@type": "RegisterAction",
            name: "Join the beta waitlist",
            target: "https://chasesets.com/#waitlist-form",
          },
        }),
      ]),
    });
  });
});
