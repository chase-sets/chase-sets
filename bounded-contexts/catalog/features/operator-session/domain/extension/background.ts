import {
  closed,
  isCommand,
  isGrant,
  operatorEnvironments,
  operatorOrigins,
  type OperatorCommand,
  type OperatorEnvironment,
  type OperatorStatus,
} from "./protocol";
import { emptyOperatorRecord, isOperatorRecord, operatorRecordKey, type OperatorRecord } from "./record";
import { createOperatorTransport } from "./transport";

export type OperatorAdapters = {
  storage: {
    trust(): Promise<void>;
    read(key: string): Promise<unknown>;
    write(key: string, value: OperatorRecord): Promise<void>;
  };
  badge(required: boolean): Promise<void>;
  fetch: typeof fetch;
};

type Slot = { record: OperatorRecord; blocked: boolean; queue: Promise<unknown> };

export function createOperatorBackground(adapters: OperatorAdapters) {
  const transport = createOperatorTransport(adapters.fetch);
  const slots = new Map<OperatorEnvironment, Slot>(
    operatorEnvironments.map((environment) => [
      environment,
      { record: emptyOperatorRecord(environment), blocked: false, queue: Promise.resolve() },
    ]),
  );
  const slot = (environment: OperatorEnvironment) => slots.get(environment)!;
  const status = (environment: OperatorEnvironment): OperatorStatus => {
    const current = slot(environment);
    return {
      paired: !current.blocked && current.record.grant !== null,
      state: current.blocked ? "upgrade-required" : current.record.state,
      lastOutcome: current.record.lastOutcome,
      lastPushedAt: null,
      serverRevision: current.record.lastRevision,
    };
  };
  const ready = adapters.storage
    .trust()
    .then(async () => {
      await Promise.all(
        operatorEnvironments.map(async (environment) => {
          const current = slot(environment);
          try {
            const stored = await adapters.storage.read(operatorRecordKey(environment));
            if (stored !== undefined) {
              if (!isOperatorRecord(stored, environment)) current.blocked = true;
              else current.record = stored;
            }
          } catch {
            current.blocked = true;
          }
        }),
      );
    })
    .catch(() => {
      for (const current of slots.values()) current.blocked = true;
    });
  function serial<T>(environment: OperatorEnvironment, work: (current: Slot) => Promise<T>): Promise<T> {
    const current = slot(environment);
    const result = current.queue.then(() => ready).then(() => work(current));
    current.queue = result.catch(() => {
      current.blocked = true;
    });
    return result;
  }
  async function write(current: Slot, record: OperatorRecord) {
    if (current.blocked) return;
    await adapters.storage.write(operatorRecordKey(record.environment), record);
    current.record = record;
  }
  async function badge() {
    await adapters.badge([...slots.values()].some((current) => current.record.state === "re-pair-required"));
  }
  async function command(command: OperatorCommand): Promise<OperatorStatus> {
    const environment = command.environment;
    if (command.action === "status" || command.action === "recover") {
      await serial(environment, async () => undefined);
      return status(environment);
    }
    if (command.action === "pair") {
      await serial(environment, async (current) => {
        if (current.blocked || current.record.profileRevision === Number.MAX_SAFE_INTEGER) return;
        await write(current, {
          ...emptyOperatorRecord(environment),
          profileRevision: current.record.profileRevision + 1,
          grant: command.grant,
          state: "idle",
          dirty: false,
        });
        await badge();
      });
      return status(environment);
    }
    const revoke = await serial(environment, async (current) => {
      if (current.blocked || !current.record.grant) return null;
      const prior = current.record;
      await write(current, { ...emptyOperatorRecord(environment), profileRevision: prior.profileRevision + 1 });
      await badge();
      return prior.grant;
    });
    if (revoke) await transport.revoke(environment, revoke);
    return status(environment);
  }
  return {
    async receiveHandoff(
      value: unknown,
      sender: { id?: string; url?: string; origin?: string; frameId?: number; hasTab: boolean },
      extensionId: string,
    ) {
      const refused = { outcome: "refused" as const };
      if (
        !closed(value, ["action", "grant"]) ||
        value.action !== "pair-handoff" ||
        (sender.id !== undefined && sender.id !== extensionId) ||
        sender.frameId !== 0 ||
        sender.hasTab !== true
      )
        return refused;
      const grant = value.grant;
      if (!isGrant(grant)) return refused;
      const environment = operatorEnvironments.find((candidate) => operatorOrigins[candidate] === sender.origin);
      if (!environment || typeof sender.url !== "string") return refused;
      try {
        const url = new URL(sender.url);
        if (url.origin !== sender.origin || url.pathname !== "/catalog/providers/tcgplayer") return refused;
      } catch {
        return refused;
      }
      try {
        const result = await serial(environment, async (current) => {
          if (current.blocked) return "refused";
          if (current.record.grant === grant) return "unchanged";
          if (current.record.profileRevision === Number.MAX_SAFE_INTEGER) return "refused";
          await write(current, {
            ...emptyOperatorRecord(environment),
            profileRevision: current.record.profileRevision + 1,
            grant,
            state: "idle",
            dirty: false,
          });
          await badge();
          return "committed";
        });
        return result === "refused" ? refused : { outcome: "paired" as const };
      } catch {
        return refused;
      }
    },
    async receive(
      value: unknown,
      sender: { id?: string; url?: string; origin?: string; hasTab: boolean },
      extensionId: string,
    ) {
      const origin = `chrome-extension://${extensionId}`;
      if (
        sender.id !== extensionId ||
        sender.url !== `${origin}/popup.html` ||
        sender.origin !== origin ||
        sender.hasTab ||
        !isCommand(value)
      )
        return null;
      try {
        return await command(value);
      } catch {
        return status(value.environment);
      }
    },
    async resume() {
      await ready;
      await badge();
    },
    async alarm(_environment: OperatorEnvironment) {
      await ready;
    },
  };
}
