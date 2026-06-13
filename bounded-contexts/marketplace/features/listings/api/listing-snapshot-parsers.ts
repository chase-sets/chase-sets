import { parseGradedCardSnapshot } from "@chase-sets/primitives/graded-card-snapshot";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import { z } from "zod";

const requiredTextSchema = z.string().refine((value) => value.trim().length > 0);
const optionalTextSchema = z.string().nullable().optional();

const shipFromAddressSnapshotSchema = z.object({
  name: requiredTextSchema,
  company: optionalTextSchema,
  line1: requiredTextSchema,
  line2: optionalTextSchema,
  city: requiredTextSchema,
  state: requiredTextSchema,
  postalCode: requiredTextSchema,
  country: requiredTextSchema,
  phone: optionalTextSchema,
  email: optionalTextSchema,
});

export function parseShipFromAddressSnapshot(value: unknown): AddressSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const parsed = shipFromAddressSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Ship-from address snapshot is invalid.");
  }

  return parsed.data;
}

export { parseGradedCardSnapshot };
