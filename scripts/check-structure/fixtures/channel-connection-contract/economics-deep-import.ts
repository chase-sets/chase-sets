import type { ChannelEnvironment } from "../../../../bounded-contexts/channels/features/connections/domain/contracts";

export type EconomicsChannel = Readonly<{ environment: ChannelEnvironment }>;
