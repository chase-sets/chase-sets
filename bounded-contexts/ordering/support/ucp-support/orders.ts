import { createUcpEnvelope, type UcpEnvelope } from "@chase-sets/platform-runtime/ucp";
import type { UcpOperationHandlerInput } from "@chase-sets/platform-runtime/ucp";
import type { OrderingServices } from "../runtime-support/services";
import type { OrderingOrderDetailRow, OrderingOrderListRow } from "../../features/orders/read-model/queries";

type UcpHandler = (input: UcpOperationHandlerInput) => Promise<UcpEnvelope>;

export type OrderingUcpHandlers = Readonly<{
  restHandlers: Readonly<Record<string, UcpHandler>>;
  mcpToolHandlers: Readonly<Record<string, UcpHandler>>;
}>;

export function createOrderingUcpHandlers(ordering: Pick<OrderingServices, "orders">): OrderingUcpHandlers {
  const handlers = {
    get_order: async (input: UcpOperationHandlerInput) => {
      const access = requireOrderReadAccess(input);
      if (access.error) {
        return access.error;
      }

      const orderId = input.params.id || readString(input.arguments.id) || readString(input.arguments.order_id);
      if (!orderId) {
        return createUcpEnvelope("error", {}, [
          {
            severity: "error",
            code: "validation_failed",
            message: "Order id is required.",
            target: "id",
          },
        ]);
      }

      const purchase = await ordering.orders.getPurchase(orderId, access.actor.accountId);
      if (purchase) {
        return createUcpEnvelope("ok", orderToUcpOrder(purchase, "purchase"));
      }

      const sale = await ordering.orders.getSale(orderId, access.actor.accountId);
      if (sale) {
        return createUcpEnvelope("ok", orderToUcpOrder(sale, "sale"));
      }

      return createUcpEnvelope("error", {}, [
        {
          severity: "error",
          code: "not_found",
          message: "Order not found for the linked marketplace account.",
          target: "id",
        },
      ]);
    },
  } satisfies Readonly<Record<string, UcpHandler>>;

  return {
    restHandlers: handlers,
    mcpToolHandlers: handlers,
  };
}

function requireOrderReadAccess(input: UcpOperationHandlerInput) {
  if (!input.actor) {
    return {
      error: createUcpEnvelope("error", {}, [
        {
          severity: "error",
          code: "authentication_required",
          message: "UCP order reads require a linked marketplace account.",
        },
      ]),
    };
  }

  if (!input.actor.permissions.includes("orders.view")) {
    return {
      error: createUcpEnvelope("error", {}, [
        {
          severity: "error",
          code: "authorization_forbidden",
          message: "The linked marketplace account cannot view orders.",
        },
      ]),
    };
  }

  return { actor: input.actor };
}

function orderToUcpOrder(row: OrderingOrderDetailRow, perspective: "purchase" | "sale") {
  return {
    id: row.order_id,
    label: `${perspective === "purchase" ? "Purchase" : "Sale"} ${row.display_reference}`,
    checkout_id: row.source_reference_id ?? row.order_id,
    permalink_url: perspective === "purchase" ? `/account/purchases/${row.order_id}` : `/account/sales/${row.order_id}`,
    currency: "USD",
    status: row.status,
    line_items: row.lines.map((line) => ({
      id: line.line_id,
      item: {
        id: line.product_id,
        title: line.item_title,
        subtitle: line.item_subtitle,
        price: moneyToMinorUnits(line.unit_price_amount),
        extensions: {
          chase_sets: {
            listing_id: line.listing_id,
            inventory_item_id: line.inventory_item_id,
            catalog_item_id: line.catalog_catalog_item_id,
            product_id: line.product_id,
          },
        },
      },
      quantity: {
        total: line.quantity,
        fulfilled: row.ready_for_fulfillment_at ? line.quantity : 0,
      },
      totals: [
        { type: "subtotal", amount: moneyToMinorUnits(line.line_total_amount) },
        { type: "total", amount: moneyToMinorUnits(line.line_total_amount) },
      ],
      status: row.status === "cancelled" ? "cancelled" : row.ready_for_fulfillment_at ? "fulfilled" : "pending",
    })),
    fulfillment: {
      expectations: [
        {
          id: `fulfillment_${row.order_id}`,
          line_items: row.lines.map((line) => ({
            id: line.line_id,
            quantity: line.quantity,
          })),
          method_type: "shipping",
          destination: addressToUcp(row.shipping_destination_snapshot),
          description: row.ready_for_fulfillment_at
            ? "Order is ready for fulfillment."
            : "Fulfillment will begin after payment and reservation complete.",
        },
      ],
      events: fulfillmentEvents(row),
    },
    adjustments: row.cancelled_at
      ? [
          {
            id: `cancellation_${row.order_id}`,
            type: "cancellation",
            occurred_at: row.cancelled_at,
            description: row.cancellation_reason ?? "Order cancelled.",
          },
        ]
      : [],
    totals: [
      { type: "subtotal", amount: moneyToMinorUnits(row.item_subtotal_amount) },
      { type: "fulfillment", amount: moneyToMinorUnits(row.shipping_charge_amount) },
      { type: "tax", amount: moneyToMinorUnits(row.sales_tax_amount) },
      { type: "total", amount: moneyToMinorUnits(row.total_amount) },
    ],
    extensions: {
      chase_sets: listOrderExtension(row, perspective),
    },
  };
}

function listOrderExtension(row: OrderingOrderListRow, perspective: "purchase" | "sale") {
  return {
    perspective,
    source_type: row.source_type,
    source_reference_id: row.source_reference_id,
    buyer_account_id: row.buyer_account_id,
    seller_account_id: row.seller_account_id,
    seller_net_amount: row.seller_net_amount,
    marketplace_sales_fee_amount: row.marketplace_sales_fee_amount,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function fulfillmentEvents(row: OrderingOrderDetailRow) {
  if (!row.ready_for_fulfillment_at) {
    return [];
  }
  return [
    {
      id: `ready_${row.order_id}`,
      occurred_at: row.ready_for_fulfillment_at,
      type: "ready_for_fulfillment",
      line_items: row.lines.map((line) => ({
        id: line.line_id,
        quantity: line.quantity,
      })),
      description: "Order is ready for fulfillment.",
    },
  ];
}

function addressToUcp(address: OrderingOrderDetailRow["shipping_destination_snapshot"]) {
  return {
    name: address.name,
    street_address: [address.line1, address.line2].filter(Boolean).join("\n"),
    address_locality: address.city,
    address_region: address.state,
    address_country: address.country,
    postal_code: address.postalCode,
  };
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function moneyToMinorUnits(amount: string) {
  const normalized = amount.trim();
  const [dollars = "0", cents = ""] = normalized.split(".");
  const minor = `${dollars}${cents.padEnd(2, "0").slice(0, 2)}`.replace(/^0+(?=\d)/, "");
  return Number(minor || "0");
}
