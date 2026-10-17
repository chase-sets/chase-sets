export const easyPostTestSender = {
  name: "Chase Sets Seller",
  street1: "417 Montgomery St",
  city: "San Francisco",
  state: "CA",
  postalCode: "94104",
  country: "US",
  phone: "4155550100",
  email: "seller@example.com",
} as const;

export const easyPostTestRecipient = {
  name: "Chase Sets Buyer",
  street1: "388 Townsend St",
  city: "San Francisco",
  state: "CA",
  postalCode: "94107",
  country: "US",
  phone: "4155550101",
  email: "buyer@example.com",
} as const;

export const easyPostTestMemberParcel = {
  lengthInches: 7,
  widthInches: 5,
  heightInches: 1,
  weightOunces: 4,
} as const;
