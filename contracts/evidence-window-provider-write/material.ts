import {
  GOVERNED_RETURN_ORIGIN,
  GOVERNED_SETUP_PATH,
  ProviderWriteRefused,
  providerWriteUtf8Length,
  type ProviderWriteBinding,
  type ProviderWriteEnvelope,
  type ProviderObjectClass,
} from "./index";

const referencePattern = /^[a-zA-Z0-9_]+$/;
const unsafe = /(?:\b(?:sk|rk)_(?:test|live)_|whsec_|_secret_|\bBearer\s|\bBasic\s|[\u0000-\u001f\u007f])/;
const baseMetadata = [
  "payment_id",
  "buyer_account_id",
  "order_ids",
  "order_count",
  "order_ids_truncated",
  "payment_method_category",
  "explicit_payment_method_selection",
  "three_d_secure_requested",
  "three_d_secure_reason_codes",
];
const riskMetadata = [
  "seller_account_ids",
  "seller_account_count",
  "max_seller_order_amount",
  "high_dollar_order",
  "fulfillment_required",
];
const savedMetadata = ["saved_checkout_instrument_id", "saved_checkout_instrument_confirmation"];
const setupMetadata = ["account_id", "setup_reference", "saved_payment_consent_id", "saved_payment_consent_text"];
const metadata = (leaves: readonly string[], prefix = "metadata") => leaves.map((leaf) => `${prefix}[${leaf}]`);

export function validProviderReference(value: string): boolean {
  return providerWriteUtf8Length(value) <= 256 && referencePattern.test(value) && !unsafe.test(value);
}

export function validateProviderBinding(binding: ProviderWriteBinding): void {
  for (const value of [binding.logicalOperationId, binding.ownerAccountId]) {
    if (!value || providerWriteUtf8Length(value) > 256 || unsafe.test(value)) refuse();
  }
  if (!validProviderReference(binding.ownerAccountId)) refuse();
  if (
    (binding.writerKind === "customer" || binding.writerKind.startsWith("connect-")) &&
    binding.logicalOperationId !== binding.ownerAccountId
  )
    refuse();
}

export function providerWriterShape(binding: ProviderWriteBinding): Readonly<{
  objectClass: ProviderObjectClass;
  logicalSlot: 1 | 2 | 3 | null;
  operation: "create" | "dispose";
  endpoint: string;
}> {
  switch (binding.writerKind) {
    case "customer":
      return { objectClass: 5, logicalSlot: null, operation: "create", endpoint: "/v1/customers" };
    case "setup-embedded":
      return { objectClass: 3, logicalSlot: null, operation: "create", endpoint: "/v1/setup_intents" };
    case "setup-hosted":
    case "payment-checkout":
      return { objectClass: 4, logicalSlot: null, operation: "create", endpoint: "/v1/checkout/sessions" };
    case "payment-saved":
      return { objectClass: 2, logicalSlot: null, operation: "create", endpoint: "/v1/payment_intents" };
    case "cancel-payment":
      return { objectClass: 2, logicalSlot: null, operation: "dispose", endpoint: "/v1/payment_intents" };
    case "cancel-setup":
      return { objectClass: 3, logicalSlot: null, operation: "dispose", endpoint: "/v1/setup_intents" };
    case "connect-setup":
      return { objectClass: 6, logicalSlot: 1, operation: "create", endpoint: "/v1/account_sessions" };
    case "connect-manage":
      return { objectClass: 6, logicalSlot: 2, operation: "create", endpoint: "/v1/account_sessions" };
    case "connect-notification":
      return { objectClass: 6, logicalSlot: 3, operation: "create", endpoint: "/v1/account_sessions" };
    case "payment-agentic":
      throw new ProviderWriteRefused("unsafe-material");
    default:
      throw new ProviderWriteRefused("invalid-identity");
  }
}

export function validateProviderMaterial(binding: ProviderWriteBinding, envelope: ProviderWriteEnvelope): void {
  const envelopeKeys = [
    "accountScope",
    "apiVersion",
    "bodyKind",
    "bodyText",
    "connectedAccountReference",
    "endpoint",
    "method",
    "target",
  ];
  if (Object.keys(envelope).sort().join(",") !== envelopeKeys.join(",")) refuse();
  validateProviderBinding(binding);
  const shape = providerWriterShape(binding);
  if (
    envelope.method !== "POST" ||
    !envelope.apiVersion ||
    providerWriteUtf8Length(envelope.apiVersion) > 64 ||
    !/^[a-zA-Z0-9.-]+$/.test(envelope.apiVersion)
  )
    refuse();
  if (envelope.accountScope === "connected") {
    if (!envelope.connectedAccountReference || !validProviderReference(envelope.connectedAccountReference)) refuse();
  } else if (envelope.accountScope !== "platform" || envelope.connectedAccountReference !== null) refuse();
  const endpoint = shape.operation === "dispose" ? `${shape.endpoint}/${envelope.target}/cancel` : shape.endpoint;
  if (
    envelope.endpoint !== endpoint ||
    (shape.operation === "dispose"
      ? !envelope.target || !validProviderReference(envelope.target)
      : envelope.target !== null)
  )
    refuse();
  if (binding.writerKind === "cancel-payment") {
    if (envelope.bodyKind !== "absent" || envelope.bodyText !== null) refuse();
    return;
  }
  if (
    envelope.bodyKind !== "form" ||
    typeof envelope.bodyText !== "string" ||
    providerWriteUtf8Length(envelope.bodyText) > 65_536
  )
    refuse();
  const fields = new URLSearchParams(envelope.bodyText);
  if (fields.toString() !== envelope.bodyText) refuse();
  const allowed = new Set<string>();
  const required = new Map<string, string>();
  const requiredFields = new Set<string>();
  const allow = (...names: string[]) => names.forEach((name) => allowed.add(name));
  const requireValue = (name: string, value: string) => {
    allow(name);
    required.set(name, value);
  };
  switch (binding.writerKind) {
    case "customer":
      allow("name", "email");
      requireValue("metadata[account_id]", binding.ownerAccountId);
      break;
    case "setup-embedded":
    case "setup-hosted": {
      allow("customer", ...metadata(setupMetadata));
      for (const name of ["customer", ...metadata(setupMetadata)]) requiredFields.add(name);
      requireValue("metadata[account_id]", binding.ownerAccountId);
      if (binding.writerKind === "setup-embedded") {
        requireValue("usage", "off_session");
        requireValue("automatic_payment_methods[enabled]", "true");
      } else {
        requireValue("mode", "setup");
        requireValue("ui_mode", "hosted_page");
        allow("currency");
        requireValue("client_reference_id", binding.ownerAccountId);
        const url = `${GOVERNED_RETURN_ORIGIN}${GOVERNED_SETUP_PATH}?setupReferenceId=${encodeURIComponent(binding.logicalOperationId)}`;
        requireValue("success_url", url);
        requireValue("cancel_url", url);
      }
      break;
    }
    case "payment-saved":
      allow(
        "amount",
        "currency",
        "customer",
        "payment_method",
        "confirm",
        "off_session",
        "description",
        "statement_descriptor_suffix",
        "transfer_group",
        "payment_method_options[card][request_three_d_secure]",
        ...metadata([...baseMetadata, ...riskMetadata, ...savedMetadata, "funds_strategy", "transfer_group"]),
      );
      requireValue("metadata[payment_id]", binding.logicalOperationId);
      requireValue("metadata[buyer_account_id]", binding.ownerAccountId);
      for (const name of [
        "amount",
        "currency",
        "payment_method",
        "confirm",
        "off_session",
        "description",
        "statement_descriptor_suffix",
        "transfer_group",
      ])
        requiredFields.add(name);
      requireValue("confirm", "true");
      break;
    case "payment-checkout": {
      allow(
        "return_url",
        "customer",
        "payment_method_types[0]",
        "payment_method_types[1]",
        "line_items[0][quantity]",
        "line_items[0][price_data][currency]",
        "line_items[0][price_data][unit_amount]",
        "line_items[0][price_data][product_data][name]",
        "payment_intent_data[transfer_group]",
        "payment_intent_data[statement_descriptor_suffix]",
        "payment_intent_data[setup_future_usage]",
        "payment_intent_data[payment_method_options][card][request_three_d_secure]",
        ...metadata([
          ...baseMetadata,
          ...riskMetadata,
          ...savedMetadata,
          "saved_payment_consent_id",
          "saved_payment_consent_text",
          "funds_strategy",
          "transfer_group",
          "client_ip_collected",
          "user_agent_collected",
        ]),
        ...metadata(
          [...baseMetadata, ...riskMetadata, ...savedMetadata, "saved_payment_consent_id"],
          "payment_intent_data[metadata]",
        ),
      );
      requireValue("mode", "payment");
      requireValue("ui_mode", "elements");
      requireValue("client_reference_id", binding.logicalOperationId);
      for (const name of [
        "payment_method_types[0]",
        "line_items[0][quantity]",
        "line_items[0][price_data][currency]",
        "line_items[0][price_data][unit_amount]",
        "line_items[0][price_data][product_data][name]",
        "payment_intent_data[transfer_group]",
        "payment_intent_data[statement_descriptor_suffix]",
      ])
        requiredFields.add(name);
      requireValue("line_items[0][quantity]", "1");
      for (const prefix of ["metadata", "payment_intent_data[metadata]"]) {
        requireValue(`${prefix}[payment_id]`, binding.logicalOperationId);
        requireValue(`${prefix}[buyer_account_id]`, binding.ownerAccountId);
      }
      const urls = ["checkout", "account"].map(
        (root) => `${GOVERNED_RETURN_ORIGIN}/${root}/payments/${encodeURIComponent(binding.logicalOperationId)}`,
      );
      if (!urls.includes(fields.get("return_url") ?? "")) refuse();
      break;
    }
    case "connect-setup":
    case "connect-manage":
    case "connect-notification": {
      allow("account");
      requiredFields.add("account");
      const component =
        binding.writerKind === "connect-setup"
          ? "account_onboarding"
          : binding.writerKind === "connect-manage"
            ? "account_management"
            : "notification_banner";
      for (const name of new Set([component, "notification_banner"])) {
        requireValue(`components[${name}][enabled]`, "true");
        allow(`components[${name}][features][disable_stripe_user_authentication]`);
        requiredFields.add(`components[${name}][features][disable_stripe_user_authentication]`);
        if (name !== "notification_banner")
          requireValue(`components[${name}][features][external_account_collection]`, "true");
      }
      break;
    }
    case "cancel-setup":
      break;
  }
  const seen = new Set<string>();
  for (const [name, value] of fields) {
    if (seen.has(name) || !allowed.has(name) || providerWriteUtf8Length(name) > 160 || unsafe.test(value)) refuse();
    seen.add(name);
    const isUrl = ["return_url", "success_url", "cancel_url"].includes(name);
    const bound =
      isUrl || name.endsWith("[saved_payment_consent_text]")
        ? 4096
        : name === "email"
          ? 320
          : name === "name" || name === "description" || name.endsWith("[product_data][name]")
            ? 1024
            : name.includes("metadata]") || name.startsWith("metadata[")
              ? 500
              : 256;
    if (providerWriteUtf8Length(value) > bound) refuse();
    if (/(?:_id|_reference)\]$/.test(name) && (!validProviderReference(value) || providerWriteUtf8Length(value) > 256))
      refuse();
    if (/_count\]$/.test(name) && (!/^(0|[1-9][0-9]{0,15})$/.test(value) || !Number.isSafeInteger(Number(value))))
      refuse();
    if (
      /\[(?:order_ids_truncated|explicit_payment_method_selection|high_dollar_order|fulfillment_required|client_ip_collected|user_agent_collected)\]$/.test(
        name,
      ) &&
      value !== "true" &&
      value !== "false"
    )
      refuse();
    if (name.endsWith("[payment_method_category]") && !["card", "bank-account", "platform-credit"].includes(value))
      refuse();
    if (
      name.endsWith("[saved_checkout_instrument_confirmation]") &&
      !["trusted-payment-step", "off-session-token"].includes(value)
    )
      refuse();
    if (name.endsWith("[funds_strategy]") && value !== "platform-held") refuse();
    if (name.endsWith("[three_d_secure_requested]") && value !== "automatic" && value !== "any") refuse();
    if (["customer", "payment_method", "account"].includes(name) && !validProviderReference(value)) refuse();
    if ((name === "currency" || name.endsWith("[currency]")) && !/^[a-z]{3}$/.test(value)) refuse();
    if (
      ["amount", "line_items[0][quantity]", "line_items[0][price_data][unit_amount]"].includes(name) &&
      (!/^(0|[1-9][0-9]{0,15})$/.test(value) || !Number.isSafeInteger(Number(value)))
    )
      refuse();
    if (
      (name.endsWith("[enabled]") || name.includes("[features]") || ["confirm", "off_session"].includes(name)) &&
      value !== "true" &&
      value !== "false"
    )
      refuse();
    if (name.endsWith("[request_three_d_secure]") && value !== "any") refuse();
    if (name === "payment_method_types[0]" && !["card", "us_bank_account"].includes(value)) refuse();
    if (name === "payment_method_types[1]" && (value !== "link" || fields.get("payment_method_types[0]") !== "card"))
      refuse();
  }
  if (seen.size > 96) refuse();
  for (const name of requiredFields) if (!fields.has(name)) refuse();
  for (const [name, value] of required) if (fields.get(name) !== value) refuse();
}

export async function providerWriteDigest(envelope: ProviderWriteEnvelope): Promise<string> {
  const sorted = Object.fromEntries(
    Object.keys(envelope)
      .sort()
      .map((key) => [key, envelope[key as keyof ProviderWriteEnvelope]]),
  );
  const bytes = new TextEncoder().encode(`evidence-window-provider-write/v1\n${JSON.stringify(sorted)}`);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function refuse(): never {
  throw new ProviderWriteRefused("unsafe-material");
}
