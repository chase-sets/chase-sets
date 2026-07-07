import type { AddressVerificationSnapshot } from "@chase-sets/primitives/address-snapshot";

export type ShippingAddress = Readonly<{
  shipping_address_id: string;
  account_id: string;
  label: string;
  recipient_name: string;
  company: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  phone: string | null;
  email: string | null;
  verification: AddressVerificationSnapshot | null;
  is_default: boolean;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}>;
