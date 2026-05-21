import type {
  PostageAddress,
  PostageLabelProvider,
  PostagePackage,
  PostageProviderMode,
} from "@chase-sets/postage-labels";

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
  return {
    length: ensurePositiveNumber(pkg.lengthInches, "Package length"),
    width: ensurePositiveNumber(pkg.widthInches, "Package width"),
    height: ensurePositiveNumber(pkg.heightInches, "Package height"),
    weight: ensurePositiveNumber(pkg.weightOunces, "Package weight"),
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

async function parseEasyPostResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(getEasyPostErrorMessage(body));
  }
  return body as T;
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

  async function easyPostRequest<T>(path: string, init: RequestInit = {}) {
    return parseEasyPostResponse<T>(
      await fetchImpl(`${apiBaseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
          ...init.headers,
        },
      }),
    );
  }

  return {
    providerName: "easypost",
    providerMode: options.mode ?? "test",
    async purchaseUspsLabel(request) {
      const shipment = await easyPostRequest<EasyPostShipment>("/shipments", {
        method: "POST",
        body: JSON.stringify({
          shipment: {
            reference: request.shipmentId,
            to_address: normalizeAddress(request.recipient),
            from_address: normalizeAddress(request.sender),
            parcel: normalizePackage(request.package),
            options: {
              label_format: "PDF",
            },
          },
        }),
      });
      const normalizedService = request.serviceLevel.trim().toLowerCase();
      const uspsRates = (shipment.rates ?? []).filter((rate) => rate.carrier.toLowerCase() === "usps");
      const selectedRate = uspsRates.find((rate) => rate.service.toLowerCase() === normalizedService) ?? uspsRates[0];

      if (!selectedRate) {
        throw new Error("No USPS rates were returned for this shipment.");
      }

      const purchased = await easyPostRequest<EasyPostShipment>(`/shipments/${shipment.id}/buy`, {
        method: "POST",
        body: JSON.stringify({ rate: { id: selectedRate.id } }),
      });
      const label = purchased.postage_label;
      const labelDocumentUrl = label?.label_pdf_url ?? label?.label_url;
      if (!labelDocumentUrl || !purchased.tracking_code) {
        throw new Error("EasyPost did not return a label PDF and tracking number.");
      }

      return {
        providerName: "easypost",
        providerMode: purchased.mode ?? options.mode ?? "test",
        providerShipmentId: purchased.id,
        providerLabelId: label?.id ?? purchased.id,
        providerRateId: purchased.selected_rate?.id ?? selectedRate.id,
        carrierName: "USPS",
        serviceLevel: purchased.selected_rate?.service ?? selectedRate.service,
        labelReference: label?.id ?? purchased.id,
        labelDocumentUrl,
        trackingIdentifier: purchased.tracking_code,
        postageAmountCents: moneyToCents(purchased.selected_rate?.rate ?? selectedRate.rate),
        postageCurrency: purchased.selected_rate?.currency ?? selectedRate.currency ?? "USD",
        purchasedAt: new Date().toISOString(),
      };
    },
    async voidLabel(request) {
      const refunded = await easyPostRequest<EasyPostShipment>(`/shipments/${request.providerShipmentId}/refund`, {
        method: "POST",
      });

      return {
        providerName: "easypost",
        providerMode: refunded.mode ?? options.mode ?? "test",
        refundReference: refunded.id,
        refundStatus: refunded.refund_status ?? "submitted",
        voidedAt: new Date().toISOString(),
      };
    },
  };
}
