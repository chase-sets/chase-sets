import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "@chase-sets/event-core";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}

export type ProductAlertMarketSide = "listing" | "offer";
export type ProductAlertStatus = "active" | "paused" | "deleted";

export type ProductAlertSelectedOption = Readonly<{
  dimensionId: string;
  optionId: string;
}>;

export type ProductAlertState = Readonly<{
  alertId: string | null;
  accountId: string | null;
  marketSide: ProductAlertMarketSide | null;
  catalogItemId: string | null;
  productId: string | null;
  selectedOptions: readonly ProductAlertSelectedOption[];
  productSummary: string | null;
  thresholdAmount: string | null;
  status: ProductAlertStatus | null;
}>;

export const initialProductAlertState: ProductAlertState = {
  alertId: null,
  accountId: null,
  marketSide: null,
  catalogItemId: null,
  productId: null,
  selectedOptions: [],
  productSummary: null,
  thresholdAmount: null,
  status: null,
};

export type CreateProductAlertCommand = Readonly<{
  type: "CreateProductAlert";
  alertId: string;
  accountId: string;
  marketSide: ProductAlertMarketSide;
  catalogItemId: string;
  productId: string;
  selectedOptions: readonly ProductAlertSelectedOption[];
  productSummary?: string | null;
  thresholdAmount?: string | null;
}>;

export type PauseProductAlertCommand = Readonly<{ type: "PauseProductAlert" }>;
export type ResumeProductAlertCommand = Readonly<{ type: "ResumeProductAlert" }>;
export type DeleteProductAlertCommand = Readonly<{ type: "DeleteProductAlert" }>;

export type ProductAlertCommand =
  | CreateProductAlertCommand
  | PauseProductAlertCommand
  | ResumeProductAlertCommand
  | DeleteProductAlertCommand;

export type ProductAlertCreatedEvent = DomainEvent<
  "discovery.product-alert.created",
  Readonly<{
    alertId: string;
    accountId: string;
    marketSide: ProductAlertMarketSide;
    catalogItemId: string;
    productId: string;
    selectedOptions: ProductAlertSelectedOption[];
    productSummary: string | null;
    thresholdAmount: string | null;
  }>
>;

export type ProductAlertPausedEvent = DomainEvent<
  "discovery.product-alert.paused",
  Readonly<Record<string, never>>
>;

export type ProductAlertResumedEvent = DomainEvent<
  "discovery.product-alert.resumed",
  Readonly<Record<string, never>>
>;

export type ProductAlertDeletedEvent = DomainEvent<
  "discovery.product-alert.deleted",
  Readonly<Record<string, never>>
>;

export type ProductAlertEvent =
  | ProductAlertCreatedEvent
  | ProductAlertPausedEvent
  | ProductAlertResumedEvent
  | ProductAlertDeletedEvent;

export const decideProductAlert: AggregateDecider<
  ProductAlertState,
  ProductAlertCommand,
  ProductAlertEvent
> = (state, command) => {
  switch (command.type) {
    case "CreateProductAlert":
      assert(state.alertId === null, "Product Alert already exists.");
      return [
        {
          type: "discovery.product-alert.created",
          data: {
            alertId: normalizeRequiredText(command.alertId, "Product Alert requires an id."),
            accountId: normalizeRequiredText(command.accountId, "Product Alert requires an account."),
            marketSide: normalizeMarketSide(command.marketSide),
            catalogItemId: normalizeRequiredText(
              command.catalogItemId,
              "Product Alert requires a Catalog Item.",
            ),
            productId: normalizeRequiredText(
              command.productId,
              "Product Alert requires a Product.",
            ),
            selectedOptions: normalizeSelectedOptions(command.selectedOptions),
            productSummary: normalizeOptionalText(command.productSummary),
            thresholdAmount: normalizeOptionalMoney(command.thresholdAmount),
          },
        },
      ];
    case "PauseProductAlert":
      requireActiveOrPausedAlert(state);
      if (state.status === "paused") {
        return [];
      }
      return [{ type: "discovery.product-alert.paused", data: {} }];
    case "ResumeProductAlert":
      requireActiveOrPausedAlert(state);
      if (state.status === "active") {
        return [];
      }
      return [{ type: "discovery.product-alert.resumed", data: {} }];
    case "DeleteProductAlert":
      assert(state.alertId !== null, "Product Alert must be created first.");
      if (state.status === "deleted") {
        return [];
      }
      return [{ type: "discovery.product-alert.deleted", data: {} }];
    default:
      return assertNever(command);
  }
};

export const evolveProductAlert: AggregateEvolver<
  ProductAlertState,
  ProductAlertEvent
> = (state, event) => {
  switch (event.type) {
    case "discovery.product-alert.created":
      return {
        alertId: event.data.alertId,
        accountId: event.data.accountId,
        marketSide: event.data.marketSide,
        catalogItemId: event.data.catalogItemId,
        productId: event.data.productId,
        selectedOptions: event.data.selectedOptions,
        productSummary: event.data.productSummary,
        thresholdAmount: event.data.thresholdAmount,
        status: "active",
      };
    case "discovery.product-alert.paused":
      return { ...state, status: "paused" };
    case "discovery.product-alert.resumed":
      return { ...state, status: "active" };
    case "discovery.product-alert.deleted":
      return { ...state, status: "deleted" };
    default:
      return assertNever(event);
  }
};

export function productAlertStreamId(alertId: string) {
  return `discovery.product-alert-${alertId}`;
}

function requireActiveOrPausedAlert(state: ProductAlertState) {
  assert(state.alertId !== null, "Product Alert must be created first.");
  assert(state.status !== "deleted", "Deleted Product Alerts cannot be changed.");
}

function normalizeMarketSide(value: ProductAlertMarketSide) {
  assert(value === "listing" || value === "offer", "Product Alert market side is invalid.");
  return value;
}

function normalizeRequiredText(value: string, message: string) {
  const normalized = value.trim();
  assert(normalized.length > 0, message);
  return normalized;
}

function normalizeOptionalText(value: string | null | undefined) {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function normalizeOptionalMoney(value: string | null | undefined) {
  const normalized = normalizeOptionalText(value);
  if (normalized === null) {
    return null;
  }
  assert(/^\d+(\.\d{1,2})?$/.test(normalized), "Price threshold must be a valid decimal.");
  return Number.parseFloat(normalized).toFixed(2);
}

function normalizeSelectedOptions(
  selectedOptions: readonly ProductAlertSelectedOption[],
) {
  return [...selectedOptions]
    .map((selection) => ({
      dimensionId: selection.dimensionId.trim(),
      optionId: selection.optionId.trim(),
    }))
    .filter(
      (selection) =>
        selection.dimensionId.length > 0 && selection.optionId.length > 0,
    )
    .sort((left, right) =>
      left.dimensionId === right.dimensionId
        ? left.optionId.localeCompare(right.optionId)
        : left.dimensionId.localeCompare(right.dimensionId),
    );
}
