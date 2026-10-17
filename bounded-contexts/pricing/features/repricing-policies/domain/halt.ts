import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";

export type RepricingHaltState = Readonly<{
  engaged: boolean;
  engagedAt: string | null;
  releasedAt: string | null;
}>;
export type RepricingHaltCommand = Readonly<{ engaged: boolean; changedAt: string }>;
export type RepricingHaltEvent = DomainEvent<
  "pricing.repricing-halt.engaged" | "pricing.repricing-halt.released",
  Readonly<{ changedAt: string }>
>;
export const initialRepricingHaltState: RepricingHaltState = {
  engaged: false,
  engagedAt: null,
  releasedAt: null,
};
export const decideRepricingHalt: AggregateDecider<RepricingHaltState, RepricingHaltCommand, RepricingHaltEvent> = (
  state,
  command,
) =>
  state.engaged === command.engaged
    ? []
    : [
        {
          type: command.engaged ? "pricing.repricing-halt.engaged" : "pricing.repricing-halt.released",
          data: { changedAt: command.changedAt },
        },
      ];
export const evolveRepricingHalt: AggregateEvolver<RepricingHaltState, RepricingHaltEvent> = (state, event) =>
  event.type === "pricing.repricing-halt.engaged"
    ? { ...state, engaged: true, engagedAt: event.data.changedAt }
    : { ...state, engaged: false, releasedAt: event.data.changedAt };

export const repricingHaltStreamId = (accountId: string): string => `pricing.repricing-halt-${accountId}`;
