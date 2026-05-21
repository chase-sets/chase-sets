import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  MobileMessageProviderWebhookEvent,
  MobileMessageWebhookGateway,
  NotificationChannelAdapter,
  NotificationDelivery,
  RcsNotificationChannel,
  SentNotificationReceipt,
  SmsNotificationChannel,
} from "@chase-sets/notifications";
import {
  ProviderAdapterError,
  providerFailureCategoryFromHttpStatus,
  providerFailureCategoryFromText,
} from "@chase-sets/http/provider-errors";

const DEFAULT_TWILIO_API_BASE_URL = "https://api.twilio.com";
export type TwilioMessagingAdapterChannel = "sms" | "rcs";

export type TwilioMessagingAdapterOptions = Readonly<{
  accountSid: string;
  authToken: string;
  messagingServiceSid: string;
  channel: TwilioMessagingAdapterChannel;
  apiBaseUrl?: string;
  statusCallbackBaseUrl?: string | null;
  sendRequest?: (input: TwilioSendMessageRequest) => Promise<TwilioMessageResponse>;
  now?: () => Date;
}>;

export type TwilioSendMessageRequest = Readonly<{
  url: string;
  authorization: string;
  body: URLSearchParams;
}>;

export type TwilioMessageResponse = Readonly<{
  sid: string;
  status?: string | null;
}>;

export type TwilioMessagingWebhookGatewayOptions = Readonly<{
  authToken: string;
  requireSignature?: boolean;
  now?: () => Date;
}>;

type TwilioWebhookForm = ReadonlyMap<string, string>;

function normalizeOptional(value?: string | null) {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function encodeBasicAuth(accountSid: string, authToken: string) {
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
}

function mapError(error: unknown) {
  if (error instanceof ProviderAdapterError) {
    return error;
  }

  const message = error instanceof Error ? error.message : "Twilio messaging request failed.";

  return new ProviderAdapterError(
    providerFailureCategoryFromText(message, providerFailureCategoryFromHttpStatus(502)),
    message,
    502,
  );
}

async function sendTwilioRequest(input: TwilioSendMessageRequest): Promise<TwilioMessageResponse> {
  const response = await fetch(input.url, {
    method: "POST",
    headers: {
      Authorization: input.authorization,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: input.body,
  });
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      extractTwilioErrorMessage(body) ?? `Twilio messaging request failed with status ${response.status}.`;
    throw new ProviderAdapterError(
      providerFailureCategoryFromText(message, providerFailureCategoryFromHttpStatus(response.status)),
      message,
      response.status,
    );
  }

  if (!isTwilioMessageResponse(body)) {
    throw new Error("Twilio messaging response did not include a message SID.");
  }

  return body;
}

function extractTwilioErrorMessage(body: unknown) {
  if (typeof body === "object" && body !== null && "message" in body && typeof body.message === "string") {
    return body.message;
  }

  return null;
}

function isTwilioMessageResponse(value: unknown): value is TwilioMessageResponse {
  return typeof value === "object" && value !== null && "sid" in value && typeof value.sid === "string";
}

function assertTwilioMessageChannel(
  channel: NotificationDelivery["channel"],
  adapterChannel: TwilioMessagingAdapterChannel,
): SmsNotificationChannel | RcsNotificationChannel {
  if (adapterChannel === "sms" && isSmsNotificationChannel(channel)) {
    if (!channel.to.e164.trim()) {
      throw new Error("Twilio sms recipient requires an E.164 phone number.");
    }

    return channel;
  }

  if (adapterChannel === "rcs" && isRcsNotificationChannel(channel)) {
    if (!channel.to.e164.trim()) {
      throw new Error("Twilio rcs recipient requires an E.164 phone number.");
    }

    return channel;
  }

  if (typeof channel.channel === "string") {
    throw new Error(`Twilio ${adapterChannel} adapter cannot send '${channel.channel}'.`);
  }

  throw new Error(`Twilio ${adapterChannel} adapter cannot send this channel.`);
}

function isSmsNotificationChannel(channel: NotificationDelivery["channel"]): channel is SmsNotificationChannel {
  return channel.channel === "sms" && hasPhoneRecipient(channel);
}

function isRcsNotificationChannel(channel: NotificationDelivery["channel"]): channel is RcsNotificationChannel {
  return channel.channel === "rcs" && hasPhoneRecipient(channel);
}

function hasPhoneRecipient(
  channel: NotificationDelivery["channel"],
): channel is NotificationDelivery["channel"] & Readonly<{ to: { e164: string } }> {
  return (
    "to" in channel &&
    typeof channel.to === "object" &&
    channel.to !== null &&
    "e164" in channel.to &&
    typeof channel.to.e164 === "string"
  );
}

function statusCallbackUrl(baseUrl: string | null, deliveryId: string) {
  if (!baseUrl) {
    return null;
  }

  const url = new URL(baseUrl);
  url.searchParams.set("deliveryId", deliveryId);
  return url.toString();
}

export function createTwilioMessagingAdapter(options: TwilioMessagingAdapterOptions): NotificationChannelAdapter {
  const now = options.now ?? (() => new Date());
  const apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_TWILIO_API_BASE_URL).replace(/\/+$/, "");
  const sendRequest = options.sendRequest ?? sendTwilioRequest;
  const authorization = encodeBasicAuth(options.accountSid, options.authToken);
  const messagesUrl = `${apiBaseUrl}/2010-04-01/Accounts/${encodeURIComponent(options.accountSid)}/Messages.json`;

  return {
    channel: options.channel,
    async sendNotificationChannel(delivery: NotificationDelivery): Promise<SentNotificationReceipt> {
      const channel = assertTwilioMessageChannel(delivery.channel, options.channel);
      const body = new URLSearchParams();
      body.set("To", channel.to.e164.trim());
      body.set("MessagingServiceSid", options.messagingServiceSid);
      body.set("Body", channel.body?.trim() || delivery.message.body);

      if (channel.channel === "sms") {
        for (const mediaUrl of channel.mediaUrls ?? []) {
          body.append("MediaUrl", mediaUrl);
        }
      } else if (channel.mediaUrl?.trim()) {
        body.append("MediaUrl", channel.mediaUrl.trim());
      }

      const callbackUrl = statusCallbackUrl(normalizeOptional(options.statusCallbackBaseUrl), delivery.deliveryId);
      if (callbackUrl) {
        body.set("StatusCallback", callbackUrl);
      }

      try {
        const response = await sendRequest({
          url: messagesUrl,
          authorization,
          body,
        });

        return {
          channel: options.channel,
          providerName: "twilio",
          providerMessageId: response.sid,
          acceptedAt: now().toISOString(),
          attemptCount: 1,
        };
      } catch (error) {
        throw mapError(error);
      }
    },
  };
}

export function createTwilioMessagingWebhookGateway(
  options: TwilioMessagingWebhookGatewayOptions,
): MobileMessageWebhookGateway {
  const now = options.now ?? (() => new Date());
  const requireSignature = options.requireSignature ?? true;

  return {
    async processMobileMessageWebhook(input) {
      return parseTwilioMessagingWebhook({
        ...input,
        authToken: options.authToken,
        requireSignature,
        receivedAt: now().toISOString(),
      });
    },
  };
}

export function parseTwilioMessagingWebhook(
  input: Readonly<{
    rawBody: string;
    url: string;
    signatureHeader?: string | null;
    authToken: string;
    requireSignature?: boolean;
    receivedAt?: string;
  }>,
): MobileMessageProviderWebhookEvent | null {
  const form = parseFormBody(input.rawBody);
  if (input.requireSignature ?? true) {
    verifyTwilioSignature({
      url: input.url,
      form,
      signatureHeader: input.signatureHeader ?? null,
      authToken: input.authToken,
    });
  }

  const providerMessageId = form.get("MessageSid") ?? form.get("SmsSid");
  if (!providerMessageId) {
    return null;
  }

  const deliveryId = normalizeOptional(new URL(input.url).searchParams.get("deliveryId"));
  const messageStatus = normalizeOptional(form.get("MessageStatus") ?? form.get("SmsStatus"));
  const inboundBody = normalizeOptional(form.get("Body"));
  const eventKind = messageStatus ? "delivery-status" : "inbound-message";
  const eventStatus = messageStatus ?? (inboundBody ? "received" : null);
  const occurredAt = normalizeOptional(form.get("Timestamp")) ?? input.receivedAt ?? new Date().toISOString();

  return {
    providerEventId: buildProviderEventId(providerMessageId, eventKind, eventStatus),
    providerName: "twilio",
    eventKind,
    providerMessageId,
    deliveryId,
    status: eventStatus,
    failureCode: normalizeOptional(form.get("ErrorCode")),
    failureMessage: normalizeOptional(form.get("ErrorMessage")),
    fromPhoneNumber: normalizeOptional(form.get("From")),
    toPhoneNumber: normalizeOptional(form.get("To")),
    body: inboundBody,
    occurredAt,
    receivedAt: input.receivedAt,
  };
}

function buildProviderEventId(
  providerMessageId: string,
  eventKind: MobileMessageProviderWebhookEvent["eventKind"],
  status: string | null,
) {
  return `twilio:${providerMessageId}:${eventKind}:${status ?? "unknown"}`;
}

function parseFormBody(rawBody: string): TwilioWebhookForm {
  const params = new URLSearchParams(rawBody);
  const values = new Map<string, string>();

  for (const [key, value] of params.entries()) {
    values.set(key, value);
  }

  return values;
}

function verifyTwilioSignature(
  input: Readonly<{
    url: string;
    form: TwilioWebhookForm;
    signatureHeader: string | null;
    authToken: string;
  }>,
) {
  const signature = normalizeOptional(input.signatureHeader);
  if (!signature) {
    throw new Error("Twilio webhook signature is required.");
  }

  const signedPayload = `${input.url}${[...input.form.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}${value}`)
    .join("")}`;
  const expected = createHmac("sha1", input.authToken).update(signedPayload).digest("base64");
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(signature);

  if (expectedBuffer.length !== receivedBuffer.length || !timingSafeEqual(expectedBuffer, receivedBuffer)) {
    throw new Error("Twilio webhook signature verification failed.");
  }
}
