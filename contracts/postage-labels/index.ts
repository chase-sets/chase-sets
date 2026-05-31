export type PostageProviderMode = "test" | "production";

export type PostageAddress = Readonly<{
  name: string;
  company?: string | null;
  street1: string;
  street2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone?: string | null;
  email?: string | null;
}>;

export type PostagePackage = Readonly<{
  lengthInches: number;
  widthInches: number;
  heightInches: number;
  weightOunces: number;
}>;

export type PurchaseUspsLabelRequest = Readonly<{
  shipmentId: string;
  orderId: string;
  serviceLevel: string;
  sender: PostageAddress;
  recipient: PostageAddress;
  package: PostagePackage;
}>;

export type PurchasedPostageLabel = Readonly<{
  providerName: string;
  providerMode: PostageProviderMode;
  providerShipmentId: string;
  providerLabelId: string;
  providerRateId: string | null;
  carrierName: string;
  serviceLevel: string;
  labelReference: string;
  labelDocumentUrl: string;
  trackingIdentifier: string;
  postageAmountCents: number | null;
  postageCurrency: string | null;
  purchasedAt: string;
}>;

export type VoidedPostageLabel = Readonly<{
  providerName: string;
  providerMode: PostageProviderMode;
  refundReference: string | null;
  refundStatus: string;
  voidedAt: string;
}>;

export type PostageProviderWebhookEvent = Readonly<{
  providerEventId: string;
  providerName: string;
  providerMode: PostageProviderMode;
  eventKind: "tracking-status" | "refund-status" | "provider-event";
  providerObjectReference: string;
  providerShipmentId?: string | null;
  trackingIdentifier?: string | null;
  status?: string | null;
  statusDetail?: string | null;
  message?: string | null;
  occurredAt: string;
  receivedAt?: string;
  payload: unknown;
}>;

export type PostageProviderWebhookInput = Readonly<{
  rawBody: string;
  method: string;
  path: string;
  headers: Headers;
}>;

export interface PostageProviderWebhookGateway {
  processPostageProviderWebhook(input: PostageProviderWebhookInput): Promise<PostageProviderWebhookEvent | null>;
}

export function createNoopPostageProviderWebhookGateway(): PostageProviderWebhookGateway {
  return {
    async processPostageProviderWebhook() {
      return null;
    },
  };
}

export interface PostageLabelProvider {
  readonly providerName: string;
  readonly providerMode: PostageProviderMode;
  purchaseUspsLabel(request: PurchaseUspsLabelRequest): Promise<PurchasedPostageLabel>;
  voidLabel(
    request: Readonly<{
      providerShipmentId: string;
      providerLabelId: string;
      trackingIdentifier: string;
    }>,
  ): Promise<VoidedPostageLabel>;
}
