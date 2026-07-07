export type PostageProviderMode = "test" | "production";

export type PostageLabelProviderErrorKind = "validation" | "capability" | "provider";

export type PostageLabelCapability =
  | "usps-rate"
  | "usps-service-level"
  | "signature-delivery-confirmation"
  | "label-document"
  | "tracking";

export class PostageLabelProviderError extends Error {
  readonly kind: PostageLabelProviderErrorKind;
  readonly capability: PostageLabelCapability | null;
  readonly providerName: string | null;
  readonly providerMode: PostageProviderMode | null;

  constructor(input: {
    kind: PostageLabelProviderErrorKind;
    message: string;
    capability?: PostageLabelCapability | null;
    providerName?: string | null;
    providerMode?: PostageProviderMode | null;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name =
      input.kind === "capability"
        ? "postage_provider_capability_failure"
        : input.kind === "validation"
          ? "postage_provider_validation_failed"
          : "postage_provider_error";
    this.kind = input.kind;
    this.capability = input.capability ?? null;
    this.providerName = input.providerName ?? null;
    this.providerMode = input.providerMode ?? null;
  }
}

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

export type AddressVerificationStatus = "verified" | "corrected" | "unverified" | "undeliverable";

export type AddressVerificationResult = Readonly<{
  providerName: string;
  providerMode: PostageProviderMode;
  status: AddressVerificationStatus;
  checkedAt: string;
  address: PostageAddress;
  suggestedAddress?: PostageAddress | null;
  messages: readonly string[];
}>;

export type VerifyPostageAddressRequest = Readonly<{
  address: PostageAddress;
}>;

export type PostagePackage = Readonly<{
  mailpieceClass?: "letter" | "flat" | "parcel";
  lengthInches: number;
  widthInches: number;
  heightInches: number;
  weightOunces: number;
}>;

export type PurchaseUspsLabelRequest = Readonly<{
  shipmentId: string;
  orderId: string;
  idempotencyKey: string;
  serviceLevel: string;
  deliveryConfirmation?: "signature" | null;
  insuranceAmount?: string | null;
  labelSize?: "4x6" | "6x4" | "7x3" | null;
  sender: PostageAddress;
  recipient: PostageAddress;
  package: PostagePackage;
}>;

export type RecoverPurchasedPostageLabelRequest = Readonly<{
  idempotencyKey: string;
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
  verifyAddress?(request: VerifyPostageAddressRequest): Promise<AddressVerificationResult>;
  purchaseUspsLabel(request: PurchaseUspsLabelRequest): Promise<PurchasedPostageLabel>;
  recoverPurchasedUspsLabel?(request: RecoverPurchasedPostageLabelRequest): Promise<PurchasedPostageLabel | null>;
  voidLabel(
    request: Readonly<{
      providerShipmentId: string;
      providerLabelId: string;
      trackingIdentifier: string;
    }>,
  ): Promise<VoidedPostageLabel>;
}
