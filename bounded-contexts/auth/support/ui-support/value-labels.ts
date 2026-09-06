import { formatMachineValue, t, type Translate } from "@chase-sets/localization";
import type { AgentGrantActivityRecord } from "../../features/agent-grants/ui/contracts";
import { AUTH_SESSION_STATUSES } from "../../features/sessions/ui/list-filters";

type AuthSessionStatus = (typeof AUTH_SESSION_STATUSES)[number];

const sessionStatusTranslationKeys = {
  active: "auth.features.sessions.ui.sessionListPage.status.filter.active",
  revoked: "auth.features.sessions.ui.sessionListPage.status.filter.revoked",
  expired: "auth.features.sessions.ui.sessionListPage.status.filter.expired",
} as const satisfies Record<AuthSessionStatus, string>;

const agentGrantStatusTranslationKeys = {
  active: "auth.values.agentGrantStatus.active",
  revoked: "auth.values.agentGrantStatus.revoked",
} as const;

const agentGrantOutcomeTranslationKeys = {
  allowed: "auth.values.agentGrantOutcome.allowed",
  denied: "auth.values.agentGrantOutcome.denied",
  failed: "auth.values.agentGrantOutcome.failed",
} as const satisfies Record<AgentGrantActivityRecord["outcome"], string>;

function authValueLabel(
  value: string,
  knownValueTranslationKeys: Readonly<Record<string, string>>,
  familyTranslationKey: string,
  translate: Translate,
) {
  return formatMachineValue(value, {
    knownValueTranslationKeys,
    family: translate(familyTranslationKey),
    translate,
    unrecognizedTranslationKey: "auth.values.unrecognized",
    unrecognizedWithValueTranslationKey: "auth.values.unrecognized.withValue",
  });
}

export function sessionStatusLabel(value: string, translate: Translate = t) {
  return authValueLabel(value, sessionStatusTranslationKeys, "auth.values.family.sessionStatus", translate);
}

export function agentGrantStatusLabel(value: string, translate: Translate = t) {
  return authValueLabel(value, agentGrantStatusTranslationKeys, "auth.values.family.agentGrantStatus", translate);
}

export function agentGrantOutcomeLabel(value: string, translate: Translate = t) {
  return authValueLabel(value, agentGrantOutcomeTranslationKeys, "auth.values.family.agentGrantOutcome", translate);
}

export const agentGrantStatusValues = Object.freeze(Object.keys(agentGrantStatusTranslationKeys));

export function authDateUnavailable(translate: Translate = t) {
  return translate("auth.values.date.unavailable");
}
