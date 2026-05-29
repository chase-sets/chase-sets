export type PromoBarMessageTone = "info" | "success" | "warning";

export type PromoBarMessage = Readonly<{
  id: string;
  title: string;
  description: string | null;
  href: string | null;
  link_label: string | null;
  tone: PromoBarMessageTone;
  is_active: boolean;
  display_order: number;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
  updated_at: string;
}>;

export type SavePromoBarMessageRequest = Readonly<{
  title: string;
  description?: string | null;
  href?: string | null;
  linkLabel?: string | null;
  tone?: PromoBarMessageTone;
  isActive?: boolean;
  displayOrder?: number;
  startsAt?: string | null;
  endsAt?: string | null;
}>;
