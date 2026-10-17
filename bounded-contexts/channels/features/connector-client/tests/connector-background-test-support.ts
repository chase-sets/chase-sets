import { vi } from "vitest";
import { createConnectorBackground } from "../domain/connector-background";
import type { ConnectorBackgroundPorts, ConnectorCommand } from "../domain/connector-background-contract";
import { admitConnectorTokens } from "../domain/extension-token-codec";
import { credentialState, type ExtensionProfileState } from "../domain/extension-records";
import { TCGPLAYER_CONNECTOR_EXTENSION_ID, TCGPLAYER_CONNECTOR_REDIRECT_URI } from "../domain/identity";
import {
  binding,
  now,
  profile,
  storage,
  wire,
  extensionProfileKey,
  extensionCredentialKey,
} from "./extension-test-support";

export function backgroundFixture(
  state?: ExtensionProfileState,
  transport: Partial<ConnectorBackgroundPorts["transport"]> = {},
  factory = createConnectorBackground,
) {
  const initial = state ? profile(state) : null;
  const fake = storage(
    initial
      ? {
          [extensionProfileKey]: initial,
          ...(credentialState(initial.state)
            ? { [extensionCredentialKey]: admitConnectorTokens(wire(), initial, binding) }
            : {}),
        }
      : {},
  );
  const session = storage();
  const alarms = new Map<string, { when?: number; periodInMinutes?: number }>();
  let time = Date.parse(now);
  let installed!: Parameters<ConnectorBackgroundPorts["runtime"]["onInstalled"]>[0];
  let startup!: Parameters<ConnectorBackgroundPorts["runtime"]["onStartup"]>[0];
  let message!: Parameters<ConnectorBackgroundPorts["runtime"]["onMessage"]>[0];
  let alarm!: Parameters<ConnectorBackgroundPorts["alarms"]["onAlarm"]>[0];
  let click!: () => Promise<void>;
  const ports: ConnectorBackgroundPorts = {
    storage: fake.ports.local,
    session: session.ports.local,
    clock: { now: () => time },
    identity: {
      launchWebAuthFlow: vi.fn(async ({ url }) => {
        const query = new URL(url).searchParams;
        return `${TCGPLAYER_CONNECTOR_REDIRECT_URI}?${new URLSearchParams({ code: "synthetic-code", state: query.get("state")! })}`;
      }),
    },
    action: {
      onClicked: (listener) => {
        click = listener;
      },
      setBadge: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
      openPage: vi.fn(async () => {}),
    },
    runtime: {
      id: TCGPLAYER_CONNECTOR_EXTENSION_ID,
      onInstalled: (listener) => {
        installed = listener;
      },
      onStartup: (listener) => {
        startup = listener;
      },
      onMessage: (listener) => {
        message = listener;
      },
    },
    alarms: {
      get: vi.fn(async (name) => {
        const schedule = alarms.get(name);
        return schedule ? { scheduledTime: schedule.when ?? time, ...schedule } : undefined;
      }),
      onAlarm: (listener) => {
        alarm = listener;
      },
      create: vi.fn(async (name, schedule) => {
        alarms.set(name, schedule);
      }),
      clear: vi.fn(async (name) => {
        alarms.delete(name);
      }),
    },
    sweep: { run: vi.fn(async () => ({ ok: true, nextDeadline: null })) },
    transport: {
      platformOrigin: binding.issuer,
      clientId: binding.clientId,
      request: vi.fn(async (request) =>
        Response.json(new URL(request.url).pathname.endsWith("/revoke") ? { revoked: true } : wire()),
      ),
      coordinate: vi.fn(async () => ({ outcome: "ok" as const })),
      ...transport,
    },
  };
  const background = factory(ports);
  const sender = { id: ports.runtime.id, origin: `chrome-extension://${ports.runtime.id}` };
  return {
    ports,
    background,
    fake,
    session,
    alarms,
    sender,
    installed: (reason = "install") => installed({ reason }),
    startup: () => startup(),
    message: (input: unknown, from = sender) => message(input, from),
    command: (type: ConnectorCommand["type"]) => message({ type }, sender),
    alarm: (name: string) => alarm({ name }),
    click: () => click(),
    setTime: (value: number) => {
      time = value;
    },
  };
}
