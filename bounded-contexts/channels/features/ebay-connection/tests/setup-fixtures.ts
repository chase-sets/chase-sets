import type { SetupRead } from "../api/setup-listing";
import type { PolicyType } from "../domain/setup-material";

export const policy = (type: PolicyType, name = `${type} policy`) => ({
  [`${type}PolicyId`]: `${type}-1`,
  marketplaceId: "EBAY_US",
  name,
  categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES", default: false }],
  ...(type === "fulfillment"
    ? {
        handlingTime: { value: 1, unit: "DAY" },
        shippingOptions: [
          {
            optionType: "DOMESTIC",
            costType: "FLAT_RATE",
            shippingServices: [
              { shippingServiceCode: "USPSPriority", shippingCost: { value: "5.00", currency: "USD" } },
            ],
          },
        ],
      }
    : {}),
  ...(type === "payment" ? { immediatePay: true, paymentMethods: [] } : {}),
  ...(type === "return"
    ? { returnsAccepted: true, returnPeriod: { value: 30, unit: "DAY" }, returnShippingCostPayer: "BUYER" }
    : {}),
});
export const location = (key = "warehouse-1") => ({
  merchantLocationKey: key,
  name: "Synthetic warehouse",
  merchantLocationStatus: "ENABLED",
  locationTypes: ["WAREHOUSE"],
  location: {
    address: { city: "Austin", stateOrProvince: "TX", postalCode: "78701", country: "US" },
    locationId: "synthetic-location",
  },
});
export const setupRead: SetupRead = async (url) => {
  const type = (["fulfillment", "payment", "return"] as const).find((type) => url.includes(`${type}_policy`));
  return type ? { total: 1, [`${type}Policies`]: [policy(type)] } : { total: 1, limit: 100, locations: [location()] };
};
export const choice = (expectedSetupGeneration = 0) => ({
  expectedSetupGeneration,
  policies: (["fulfillment", "payment", "return"] as const).map((policyType) => ({
    policyType,
    policyId: `${policyType}-1`,
  })),
  locationPairs: [{ storageLocationId: "storage-1", merchantLocationKey: "warehouse-1" }],
});
