import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  PostageAddress,
  PostageLabelCapability,
  PostageLabelProvider,
  PostagePackage,
  PostageProviderWebhookEvent,
  PostageProviderWebhookGateway,
  PostageProviderMode,
} from "@chase-sets/postage-labels";
import { PostageLabelProviderError } from "@chase-sets/postage-labels";

function normalizeText(value: string, fieldName: string) {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${fieldName} is required.`);
  }
  return normalized;
}

function normalizeOptionalText(value?: string | null) {
  const normalized = value?.trim() ?? "";
  return normalized ? normalized : null;
}

function ensurePositiveNumber(value: number, fieldName: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${fieldName} must be greater than zero.`);
  }
  return value;
}

function normalizeAddress(address: PostageAddress) {
  return {
    name: normalizeText(address.name, "Address name"),
    company: normalizeOptionalText(address.company),
    street1: normalizeText(address.street1, "Street address"),
    street2: normalizeOptionalText(address.street2),
    city: normalizeText(address.city, "City"),
    state: normalizeText(address.state, "State"),
    zip: normalizeText(address.postalCode, "Postal code"),
    country: normalizeText(address.country || "US", "Country"),
    phone: normalizeOptionalText(address.phone),
    email: normalizeOptionalText(address.email),
  };
}

function normalizePackage(pkg: PostagePackage) {
  const predefinedPackage = pkg.mailpieceClass === "letter" ? "Letter" : pkg.mailpieceClass === "flat" ? "Flat" : null;
  return {
    length: ensurePositiveNumber(pkg.lengthInches, "Package length"),
    width: ensurePositiveNumber(pkg.widthInches, "Package width"),
    height: ensurePositiveNumber(pkg.heightInches, "Package height"),
    weight: ensurePositiveNumber(pkg.weightOunces, "Package weight"),
    ...(predefinedPackage ? { predefined_package: predefinedPackage } : {}),
  };
}

function moneyToCents(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

function getEasyPostErrorMessage(body: unknown) {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "object" && error !== null && "message" in error) {
      return String((error as { message?: unknown }).message);
    }
    return String(error);
  }

  return "EasyPost request failed.";
}

async function parseEasyPostResponse<T>(response: Response, providerMode: PostageProviderMode): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new PostageLabelProviderError({
      kind: "provider",
      message: getEasyPostErrorMessage(body),
      providerName: "easypost",
      providerMode,
    });
  }
  return body as T;
}

function providerCapabilityError(
  capability: PostageLabelCapability,
  message: string,
  providerMode: PostageProviderMode,
) {
  return new PostageLabelProviderError({
    kind: "capability",
    capability,
    message,
    providerName: "easypost",
    providerMode,
  });
}

type EasyPostRate = Readonly<{
  id: string;
  carrier: string;
  service: string;
  rate: string;
  currency: string;
}>;

type EasyPostShipment = Readonly<{
  id: string;
  mode: PostageProviderMode;
  reference?: string | null;
  rates?: readonly EasyPostRate[];
  selected_rate?: EasyPostRate | null;
  postage_label?: Readonly<{
    id?: string;
    label_url?: string;
    label_pdf_url?: string;
  }> | null;
  tracking_code?: string | null;
  refund_status?: string | null;
}>;

type EasyPostWebhookEvent = Readonly<{
  id?: unknown;
  object?: unknown;
  mode?: unknown;
  description?: unknown;
  status?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  result?: Readonly<{
    id?: unknown;
    object?: unknown;
    mode?: unknown;
    tracking_code?: unknown;
    status?: unknown;
    status_detail?: unknown;
    public_url?: unknown;
    shipment_id?: unknown;
    updated_at?: unknown;
  }>;
}>;

function mapPurchasedShipment(
  shipment: EasyPostShipment,
  fallbackRate: EasyPostRate | null,
  providerMode: PostageProviderMode,
) {
  const label = shipment.postage_label;
  const labelDocumentUrl = label?.label_pdf_url ?? label?.label_url;
  if (!labelDocumentUrl) {
    throw providerCapabilityError(
      "label-document",
      "EasyPost did not return a label PDF for this shipment.",
      providerMode,
    );
  }
  if (!shipment.tracking_code) {
    throw providerCapabilityError(
      "tracking",
      "EasyPost did not return a tracking number for this shipment.",
      providerMode,
    );
  }

  return {
    providerName: "easypost",
    providerMode: shipment.mode ?? providerMode,
    providerShipmentId: shipment.id,
    providerLabelId: label?.id ?? shipment.id,
    providerRateId: shipment.selected_rate?.id ?? fallbackRate?.id ?? null,
    carrierName: shipment.selected_rate?.carrier ?? fallbackRate?.carrier ?? "USPS",
    serviceLevel: shipment.selected_rate?.service ?? fallbackRate?.service ?? "USPS",
    labelReference: label?.id ?? shipment.id,
    labelDocumentUrl,
    trackingIdentifier: shipment.tracking_code,
    postageAmountCents: moneyToCents(shipment.selected_rate?.rate ?? fallbackRate?.rate),
    postageCurrency: shipment.selected_rate?.currency ?? fallbackRate?.currency ?? "USD",
    purchasedAt: new Date().toISOString(),
  };
}

export function createEasyPostPostageLabelProvider(
  options: Readonly<{
    apiKey: string;
    apiBaseUrl?: string;
    mode?: PostageProviderMode;
    fetch?: typeof globalThis.fetch;
  }>,
): PostageLabelProvider {
  const apiBaseUrl = options.apiBaseUrl ?? "https://api.easypost.com/v2";
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const authorization = `Basic ${globalThis.btoa(`${options.apiKey}:`)}`;
  const providerMode = options.mode ?? "test";

  async function easyPostRequest<T>(path: string, init: RequestInit = {}) {
    const response = await fetchImpl(`${apiBaseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    return parseEasyPostResponse<T>(response, providerMode);
  }

  return {
    providerName: "easypost",
    providerMode,
    async purchaseUspsLabel(request) {
      const shipment = await easyPostRequest<EasyPostShipment>("/shipments", {
        method: "POST",
        body: JSON.stringify({
          shipment: {
            reference: request.idempotencyKey,
            to_address: normalizeAddress(request.recipient),
            from_address: normalizeAddress(request.sender),
            parcel: normalizePackage(request.package),
            options: {
              label_format: "PDF",
              ...(request.labelSize ? { label_size: request.labelSize } : {}),
              ...(request.deliveryConfirmation === "signature" ? { delivery_confirmation: "SIGNATURE" } : {}),
              ...(request.insuranceAmount ? { insurance: request.insuranceAmount } : {}),
            },
          },
        }),
      });
      const normalizedService = request.serviceLevel.trim().toLowerCase();
      const uspsRates = (shipment.rates ?? []).filter((rate) => rate.carrier.toLowerCase() === "usps");
      const selectedRate = uspsRates.find((rate) => rate.service.toLowerCase() === normalizedService) ?? null;

      if (!selectedRate) {
        throw providerCapabilityError(
          uspsRates.length === 0 ? "usps-rate" : "usps-service-level",
          uspsRates.length === 0
            ? "No USPS rates were returned for this shipment."
            : `USPS service level ${request.serviceLevel} is not available for this shipment.`,
          providerMode,
        );
      }

      const purchased = await easyPostRequest<EasyPostShipment>(`/shipments/${shipment.id}/buy`, {
        method: "POST",
        body: JSON.stringify({ rate: { id: selectedRate.id } }),
      });

      return mapPurchasedShipment(purchased, selectedRate, providerMode);
    },
    async recoverPurchasedUspsLabel(request) {
      const response = await fetchImpl(`${apiBaseUrl}/shipments/${encodeURIComponent(request.idempotencyKey)}`, {
        method: "GET",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
      });
      if (response.status === 404) {
        return null;
      }
      const shipment = await parseEasyPostResponse<EasyPostShipment>(response, providerMode);
      if (!shipment.postage_label || !shipment.tracking_code) {
        return null;
      }
      return mapPurchasedShipment(shipment, shipment.selected_rate ?? null, providerMode);
    },
    async voidLabel(request) {
      const refunded = await easyPostRequest<EasyPostShipment>(`/shipments/${request.providerShipmentId}/refund`, {
        method: "POST",
      });

      return {
        providerName: "easypost",
        providerMode: refunded.mode ?? providerMode,
        refundReference: refunded.id,
        refundStatus: refunded.refund_status ?? "submitted",
        voidedAt: new Date().toISOString(),
      };
    },
  };
}

export function createEasyPostPostageWebhookGateway(
  options: Readonly<{
    webhookSecret?: string | null;
    requireSignature?: boolean;
    timestampToleranceMinutes?: number;
    now?: () => Date;
  }> = {},
): PostageProviderWebhookGateway {
  const now = options.now ?? (() => new Date());
  const requireSignature = options.requireSignature ?? true;

  return {
    async processPostageProviderWebhook(input) {
      if (requireSignature) {
        verifyEasyPostWebhookSignature({
          ...input,
          webhookSecret: options.webhookSecret,
          timestampToleranceMinutes: options.timestampToleranceMinutes,
          now,
        });
      }

      const payload = JSON.parse(input.rawBody) as EasyPostWebhookEvent;
      return normalizeEasyPostWebhookEvent(payload, now().toISOString());
    },
  };
}

export function verifyEasyPostWebhookSignature(
  input: Readonly<{
    rawBody: string;
    method: string;
    path: string;
    headers: Headers;
    webhookSecret?: string | null;
    timestampToleranceMinutes?: number;
    now?: () => Date;
  }>,
) {
  const webhookSecret = normalizeOptionalText(input.webhookSecret);
  if (!webhookSecret) {
    throw new Error("EasyPost webhook secret is required.");
  }

  const timestamp = requireHeader(input.headers, "x-timestamp");
  const signedPath = requireHeader(input.headers, "x-path");
  if (signedPath !== input.path) {
    throw new Error("EasyPost webhook signed path does not match the request path.");
  }

  assertFreshEasyPostWebhookTimestamp(timestamp, input.timestampToleranceMinutes, input.now ?? (() => new Date()));
  const signature = parseEasyPostHmacSignature(requireHeader(input.headers, "x-hmac-signature-v2"));
  const signedPayload = `${timestamp}${input.method.toUpperCase()}${signedPath}${input.rawBody}`;
  const expected = createHmac("sha256", webhookSecret).update(signedPayload, "utf8").digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const receivedBuffer = Buffer.from(signature, "hex");
  if (expectedBuffer.length !== receivedBuffer.length || !timingSafeEqual(expectedBuffer, receivedBuffer)) {
    throw new Error("EasyPost webhook signature verification failed.");
  }
}

function normalizeEasyPostWebhookEvent(
  payload: EasyPostWebhookEvent,
  receivedAt: string,
): PostageProviderWebhookEvent | null {
  const providerEventId = normalizeOptionalText(asString(payload.id));
  const description = normalizeOptionalText(asString(payload.description));
  const result = payload.result;
  if (!providerEventId || !description || !result) {
    return null;
  }

  const resultObject = normalizeOptionalText(asString(result.object));
  const resultId = normalizeOptionalText(asString(result.id));
  const providerMode = asPostageProviderMode(result.mode) ?? asPostageProviderMode(payload.mode) ?? "test";
  const occurredAt =
    normalizeOptionalText(asString(result.updated_at)) ??
    normalizeOptionalText(asString(payload.updated_at)) ??
    normalizeOptionalText(asString(payload.created_at)) ??
    receivedAt;

  if (description.startsWith("tracker.") && resultObject === "Tracker" && resultId) {
    return {
      providerEventId,
      providerName: "easypost",
      providerMode,
      eventKind: "tracking-status",
      providerObjectReference: resultId,
      providerShipmentId: normalizeOptionalText(asString(result.shipment_id)),
      trackingIdentifier: normalizeOptionalText(asString(result.tracking_code)),
      status: normalizeOptionalText(asString(result.status)),
      statusDetail: normalizeOptionalText(asString(result.status_detail)),
      message: normalizeOptionalText(asString(result.public_url)),
      occurredAt,
      receivedAt,
      payload,
    };
  }

  if (description.startsWith("refund.") && resultId) {
    return {
      providerEventId,
      providerName: "easypost",
      providerMode,
      eventKind: "refund-status",
      providerObjectReference: resultId,
      providerShipmentId: normalizeOptionalText(asString(result.shipment_id)),
      trackingIdentifier: normalizeOptionalText(asString(result.tracking_code)),
      status: normalizeOptionalText(asString(result.status)),
      occurredAt,
      receivedAt,
      payload,
    };
  }

  return {
    providerEventId,
    providerName: "easypost",
    providerMode,
    eventKind: "provider-event",
    providerObjectReference: resultId ?? providerEventId,
    status: normalizeOptionalText(asString(payload.status)),
    occurredAt,
    receivedAt,
    payload,
  };
}

function requireHeader(headers: Headers, name: string) {
  const value = normalizeOptionalText(headers.get(name));
  if (!value) {
    throw new Error(`EasyPost webhook header '${name}' is required.`);
  }

  return value;
}

function parseEasyPostHmacSignature(value: string) {
  const prefix = "hmac-sha256-hex=";
  const normalized = value.toLowerCase();
  const signature = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
  if (!/^[a-f0-9]{64}$/.test(signature)) {
    throw new Error("EasyPost webhook signature format is invalid.");
  }

  return signature;
}

function assertFreshEasyPostWebhookTimestamp(value: string, toleranceMinutes = 1, now: () => Date) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error("EasyPost webhook timestamp format is invalid.");
  }

  const toleranceMs = Math.max(0, Math.min(toleranceMinutes, 60)) * 60_000;
  const deltaMs = now().getTime() - parsed;
  if (deltaMs > toleranceMs || deltaMs < -30_000) {
    throw new Error("EasyPost webhook timestamp is outside the allowed tolerance.");
  }
}

function asString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function asPostageProviderMode(value: unknown): PostageProviderMode | null {
  return value === "production" || value === "test" ? value : null;
}
