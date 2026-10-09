import type { TrustedStorageArea } from "./extension-credential-custody";
import { closedRecord, type ExtensionProfileState, type ExtensionPauseReason } from "./extension-records";
import type { CoordinatorInput, CoordinatorResult } from "./operation-coordinator";

export type ConnectorCommand = Readonly<{ type: "start-pairing" | "pause" | "resume" | "unpair" | "status" }>;
export type ConnectorStatus = Readonly<{
  state: ExtensionProfileState;
  connectionId: string | null;
  pauseReason: ExtensionPauseReason | null;
  pollWindowSeconds: number | null;
  pollWindowClamped: boolean;
}>;
type Sender = Readonly<{ id?: string; origin?: string }>;
type Result = Readonly<{ ok: true; status: ConnectorStatus }> | Readonly<{ ok: false; error: "message-refused" }>;
export type ConnectorBackgroundPorts = Readonly<{
  storage: TrustedStorageArea;
  session: TrustedStorageArea;
  alarms: Readonly<{
    create(name: string, schedule: Readonly<{ when?: number; periodInMinutes?: number }>): Promise<void>;
    clear(name: string): Promise<void>;
    onAlarm(listener: (alarm: Readonly<{ name: string }>) => Promise<void>): void;
  }>;
  identity: Readonly<{ launchWebAuthFlow(details: Readonly<{ url: string; interactive: true }>): Promise<string> }>;
  action: Readonly<{
    onClicked(listener: () => Promise<void>): void;
    setBadge(status: ConnectorStatus): Promise<void>;
    setTitle(status: ConnectorStatus): Promise<void>;
    openPage(url: string): Promise<void>;
  }>;
  runtime: Readonly<{
    id: string;
    onInstalled(listener: (details: Readonly<{ reason: string }>) => Promise<void>): void;
    onStartup(listener: () => Promise<void>): void;
    onMessage(listener: (message: unknown, sender: Sender) => Promise<Result>): void;
  }>;
  sweep: Readonly<{
    inspect?(): Promise<"ready" | "upgrade-required" | "cleanup-failed">;
    run(
      input: Readonly<{ reason: "boot" | "work" | "unpair" | "retention"; deleteAll: boolean }>,
    ): Promise<Readonly<{ ok: boolean; nextDeadline: number | null; error?: "upgrade-required" | "cleanup-failed" }>>;
  }>;
  transport: Readonly<{
    platformOrigin: string;
    clientId: string;
    request(request: Request): Promise<Response>;
    coordinate?(input: CoordinatorInput): Promise<CoordinatorResult>;
  }>;
  clock: Readonly<{ now(): number }>;
}>;

export function parseConnectorCommand(value: unknown): ConnectorCommand | null {
  try {
    const row = closedRecord(value, ["type"]);
    return ["start-pairing", "pause", "resume", "unpair", "status"].includes(row.type as string)
      ? { type: row.type as ConnectorCommand["type"] }
      : null;
  } catch {
    return null;
  }
}

export function acceptsConnectorSender(sender: Sender, id: string): boolean {
  return sender.id === id && sender.origin === `chrome-extension://${id}`;
}
