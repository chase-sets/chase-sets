import type { ChannelsServices } from "./features/connections/domain/contracts";

export function useWrongPath(services: ChannelsServices): ChannelsServices {
  return services;
}
