import type { BcSeedOptions, EnvironmentDataProfile } from "@chase-sets/bounded-context-module";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PromoBarMessageTone } from "./contracts";

const defaultProfiles: readonly EnvironmentDataProfile[] = [
  "critical-bootstrap",
  "catalog-integration-bootstrap",
  "scenario-seed",
];

const publicPresencePromoBarSeedMessages: readonly Readonly<{
  id: string;
  title: string;
  description: string;
  href: string;
  linkLabel: string;
  tone: PromoBarMessageTone;
  displayOrder: number;
}>[] = [
  {
    id: "pbm_seed_shipping_credit",
    title: "Earn 5% toward shipping on all orders.",
    description: "Shipping credit stays visible before checkout so low-value card orders are easier to compare.",
    href: "/order-protection",
    linkLabel: "Order protection",
    tone: "success",
    displayOrder: 10,
  },
  {
    id: "pbm_seed_beta_listing_fees",
    title: "0% seller fees on beta listings.",
    description: "Beta-created listings keep the seller fee lock while unchanged after beta ends.",
    href: "/sales-fees",
    linkLabel: "Seller fees",
    tone: "info",
    displayOrder: 20,
  },
];

function profileEnabled(options: BcSeedOptions | undefined, profile: "critical-bootstrap" | "scenario-seed") {
  return (options?.enabledDataProfiles ?? defaultProfiles).includes(profile);
}

export async function seedPublicPresencePromoBarMessages(db: PgQueryable, options?: BcSeedOptions): Promise<void> {
  if (!profileEnabled(options, "critical-bootstrap") && !profileEnabled(options, "scenario-seed")) {
    console.log("Public Presence promo bar seed skipped for selected data profiles.");
    return;
  }

  for (const message of publicPresencePromoBarSeedMessages) {
    await db.query(
      `INSERT INTO public_presence_promo_bar_messages (
         id,
         title,
         description,
         href,
         link_label,
         tone,
         is_active,
         display_order,
         created_at,
         updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, true, $7, now(), now())
       ON CONFLICT (id) DO UPDATE
       SET title = excluded.title,
           description = excluded.description,
           href = excluded.href,
           link_label = excluded.link_label,
           tone = excluded.tone,
           is_active = true,
           display_order = excluded.display_order,
           updated_at = now()`,
      [
        message.id,
        message.title,
        message.description,
        message.href,
        message.linkLabel,
        message.tone,
        message.displayOrder,
      ],
    );
  }
}
