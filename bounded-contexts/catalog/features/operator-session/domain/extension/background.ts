import {
  cookieExpiry,
  isCommand,
  isOperatorCookie,
  operatorEnvironments,
  type OperatorCommand,
  type OperatorCookie,
  type OperatorEnvironment,
  type OperatorStatus,
} from "./protocol";
import { emptyOperatorRecord, isOperatorRecord, operatorRecordKey, type OperatorRecord } from "./record";
import { createOperatorTransport, type OperatorResult } from "./transport";

export type OperatorAdapters = {
  storage: {
    trust(): Promise<void>;
    read(key: string): Promise<unknown>;
    write(key: string, value: OperatorRecord): Promise<void>;
  };
  readCookie(): Promise<OperatorCookie | null>;
  schedule(environment: OperatorEnvironment, when: number): Promise<void>;
  badge(required: boolean): Promise<void>;
  fetch: typeof fetch;
  now(): number;
};
type Slot = {
  record: OperatorRecord;
  blocked: boolean;
  queue: Promise<unknown>;
  flight: Promise<void> | null;
  cookiePresent: boolean;
  browserExpiresAt: string | null;
};

export function createOperatorBackground(adapters: OperatorAdapters) {
  const transport = createOperatorTransport(adapters.fetch);
  const slots = new Map<OperatorEnvironment, Slot>(
    operatorEnvironments.map((environment) => [
      environment,
      {
        record: emptyOperatorRecord(environment),
        blocked: false,
        queue: Promise.resolve(),
        flight: null,
        cookiePresent: false,
        browserExpiresAt: null,
      },
    ]),
  );
  function slot(environment: OperatorEnvironment) {
    return slots.get(environment)!;
  }
  function status(environment: OperatorEnvironment): OperatorStatus {
    const current = slot(environment);
    const record = current.record;
    return {
      paired: !current.blocked && record.grant !== null,
      state: current.blocked ? "upgrade-required" : record.state,
      lastOutcome: record.lastOutcome,
      lastPushedAt: record.lastPushedAt,
      serverRevision: record.lastRevision,
      cookiePresent: current.cookiePresent,
      browserExpiresAt: current.browserExpiresAt,
    };
  }
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
  async function schedule(current: Slot) {
    if (!current.blocked && current.record.grant && current.record.dirty) {
      await adapters.schedule(
        current.record.environment,
        Math.max(adapters.now() + 1000, current.record.nextAttemptAt),
      );
    }
  }
  async function badge() {
    await adapters.badge([...slots.values()].some((current) => current.record.state === "re-pair-required"));
  }
  async function applyResponse(environment: OperatorEnvironment, fence: number, result: OperatorResult) {
    await serial(environment, async (current) => {
      if (current.blocked || current.record.profileRevision !== fence || !current.record.grant) return;
      const record = { ...current.record };
      if ("revision" in result && result.revision < record.lastRevision) result = { outcome: "invalid-response" };
      if (result.outcome === "stored" || result.outcome === "unchanged") {
        record.lastRevision = result.revision;
        record.lastPushedAt = new Date(adapters.now()).toISOString();
        record.state = "idle";
        record.staleRetries = 0;
      } else if (result.outcome === "stale-revision") {
        record.lastRevision = result.revision;
        record.state = record.staleRetries < 3 ? "retrying" : "error";
        record.dirty = record.staleRetries < 3;
        record.staleRetries = Math.min(3, record.staleRetries + 1);
      } else if (result.outcome === "grant-invalid") {
        if (record.profileRevision === Number.MAX_SAFE_INTEGER) {
          current.blocked = true;
          return;
        }
        record.profileRevision++;
        record.grant = null;
        record.state = "re-pair-required";
        record.dirty = false;
      } else if (result.outcome === "unavailable" || result.outcome === "rate-limited") {
        record.state = "retrying";
        record.dirty = true;
        record.nextAttemptAt = Math.max(
          record.nextAttemptAt,
          adapters.now() + (result.outcome === "rate-limited" ? result.retryAfterMs : 300_000),
        );
      } else {
        record.state = "error";
        record.dirty = false;
      }
      record.lastOutcome = result.outcome === "revoked" ? "refused" : result.outcome;
      await write(current, record);
      await schedule(current);
      await badge();
    });
  }
  async function push(environment: OperatorEnvironment) {
    const fence = await serial(environment, async (current) => {
      const record = current.record;
      if (current.blocked || !record.grant || !record.dirty || record.state === "error") return null;
      if (adapters.now() < record.nextAttemptAt) {
        await schedule(current);
        return null;
      }
      // Reserve the rate slot durably before reading or sending. Eviction can only delay work.
      await write(current, { ...record, state: "pushing", dirty: true, nextAttemptAt: adapters.now() + 60_000 });
      return record.profileRevision;
    });
    if (fence === null) return;
    let cookie: OperatorCookie | null;
    let observedAt: string;
    try {
      cookie = await adapters.readCookie();
      observedAt = new Date(adapters.now()).toISOString();
    } catch {
      await applyResponse(environment, fence, { outcome: "unavailable" });
      return;
    }
    const call = await serial(environment, async (current) => {
      if (current.blocked || current.record.profileRevision !== fence || !current.record.grant) return null;
      current.cookiePresent = cookie !== null && isOperatorCookie(cookie);
      current.browserExpiresAt = current.cookiePresent && cookie ? cookieExpiry(cookie) : null;
      if (!current.cookiePresent || !cookie) {
        await write(current, { ...current.record, state: "idle", dirty: false, lastOutcome: "cookie-absent" });
        return null;
      }
      await write(current, { ...current.record, dirty: false });
      return {
        response: transport.push(environment, current.record.grant!, {
          expectedRevision: current.record.lastRevision,
          value: cookie.value,
          observedAt,
          browserExpiresAt: current.browserExpiresAt,
        }),
      };
    });
    if (call) await applyResponse(environment, fence, await call.response);
  }
  async function kick(environment: OperatorEnvironment): Promise<void> {
    const current = slot(environment);
    if (current.flight) return current.flight;
    const flight = push(environment)
      .catch(() => {
        current.blocked = true;
      })
      .finally(() => {
        current.flight = null;
      });
    current.flight = flight;
    await flight;
    await serial(environment, async (active) => {
      await schedule(active);
    }).catch(() => undefined);
  }
  async function trigger(environment: OperatorEnvironment, recovery = false) {
    await serial(environment, async (current) => {
      if (current.blocked || !current.record.grant || (current.record.state === "error" && !recovery)) return;
      await write(current, {
        ...current.record,
        dirty: true,
        ...(recovery ? ({ state: "idle", staleRetries: 0 } as const) : {}),
      });
    });
    await kick(environment);
  }
  async function command(command: OperatorCommand): Promise<OperatorStatus> {
    const environment = command.environment;
    if (command.action === "status") {
      await serial(environment, async () => undefined);
      return status(environment);
    }
    if (command.action === "recover") {
      await trigger(environment, true);
      return status(environment);
    }
    const revoke = await serial(environment, async (current) => {
      if (current.blocked) return null;
      if (current.record.profileRevision === Number.MAX_SAFE_INTEGER) {
        current.blocked = true;
        return null;
      }
      const prior = current.record;
      const next = {
        ...emptyOperatorRecord(environment),
        profileRevision: prior.profileRevision + 1,
        nextAttemptAt: prior.nextAttemptAt,
        grant: command.action === "pair" ? command.grant : null,
        state: command.action === "pair" ? ("idle" as const) : ("unpaired" as const),
        dirty: command.action === "pair",
      };
      await write(current, next);
      await badge();
      return command.action === "unpair" ? prior.grant : null;
    });
    // The old grant is already removed and fenced. Revoke completion has no writer.
    if (revoke) await transport.revoke(environment, revoke);
    if (command.action === "pair") await kick(environment);
    return status(environment);
  }
  return {
    async receive(
      value: unknown,
      sender: { id?: string; url?: string; origin?: string; hasTab: boolean },
      extensionId: string,
    ): Promise<OperatorStatus | null> {
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
      for (const environment of operatorEnvironments) await trigger(environment);
      await badge();
    },
    async alarm(environment: OperatorEnvironment) {
      await trigger(environment);
    },
    async cookieChanged(change: { removed: boolean; cookie: OperatorCookie }) {
      if (!isOperatorCookie(change.cookie)) return;
      for (const environment of operatorEnvironments) {
        if (change.removed) {
          await serial(environment, async (current) => {
            current.cookiePresent = false;
            current.browserExpiresAt = null;
          });
        } else await trigger(environment, true);
      }
    },
  };
}
