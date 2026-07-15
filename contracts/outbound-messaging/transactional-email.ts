import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { NotificationMessage, NotificationOutbox } from ".";

type MaybePromise<T> = T | Promise<T>;

export type TransactionalEmailDelivery = Readonly<{
  message: NotificationMessage;
  availableAt?: string;
  maxAttempts?: number;
}>;

export type TransactionalEmailTemplateOutput =
  | NotificationMessage
  | TransactionalEmailDelivery
  | readonly TransactionalEmailDelivery[];

export type TransactionalEmailEventContext = Readonly<{
  event: TransportEvent;
  correlationId: string;
}>;

export type TransactionalEmailTemplateContext<TRecipient> = TransactionalEmailEventContext &
  Readonly<{
    recipient: TRecipient;
  }>;

export type TransactionalEmailDefinition<TData, TRecipient, TEventType extends string> = Readonly<{
  outbox: NotificationOutbox;
  projectionName: string;
  on: TEventType;
  recipient: (data: Readonly<TData>, context: TransactionalEmailEventContext) => MaybePromise<TRecipient | null>;
  template: (
    data: Readonly<TData>,
    context: TransactionalEmailTemplateContext<TRecipient>,
  ) => MaybePromise<TransactionalEmailTemplateOutput | null>;
  skipWhen?: (data: Readonly<TData>, context: TransactionalEmailEventContext) => MaybePromise<boolean>;
  afterEnqueue?: (data: Readonly<TData>, context: TransactionalEmailTemplateContext<TRecipient>) => MaybePromise<void>;
}>;

export function defineTransactionalEmail<TData, TRecipient, const TEventType extends string>(
  definition: TransactionalEmailDefinition<TData, TRecipient, TEventType>,
): ProjectorHandlerMap {
  return {
    [definition.on]: async (event) => {
      if (event.type !== definition.on) {
        return;
      }

      const context: TransactionalEmailEventContext = {
        event,
        correlationId: event.trace.traceId ?? event.id,
      };
      const data = event.data as Readonly<TData>;
      if (await definition.skipWhen?.(data, context)) {
        return;
      }

      const recipient = await definition.recipient(data, context);
      if (recipient === null) {
        return;
      }

      const templateContext: TransactionalEmailTemplateContext<TRecipient> = {
        ...context,
        recipient,
      };
      const output = await definition.template(data, templateContext);
      if (output === null) {
        return;
      }

      const deliveries = normalizeDeliveries(output);
      for (const delivery of deliveries) {
        await definition.outbox.enqueueNotification({
          message: delivery.message,
          source: {
            sourceEventId: event.id,
            sourceGlobalPosition: event.globalPosition,
            projectionName: definition.projectionName,
            occurredAt: event.timing.occurredAt,
          },
          ...(delivery.availableAt !== undefined ? { availableAt: delivery.availableAt } : {}),
          ...(delivery.maxAttempts !== undefined ? { maxAttempts: delivery.maxAttempts } : {}),
        });
      }

      if (deliveries.length > 0) {
        await definition.afterEnqueue?.(data, templateContext);
      }
    },
  };
}

function normalizeDeliveries(output: TransactionalEmailTemplateOutput): readonly TransactionalEmailDelivery[] {
  if (Array.isArray(output)) {
    return output as readonly TransactionalEmailDelivery[];
  }

  if ("message" in output) {
    return [output];
  }

  return [{ message: output as NotificationMessage }];
}
