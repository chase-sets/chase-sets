import { createElement, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Banner,
  Box,
  Button,
  Heading,
  LinkButton,
  Stack,
  ThemePreferenceControl,
  type ColorMode,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import {
  createIdentityApiClient,
  IdentityApiError,
  PreferenceWriteNotDispatchedError,
  type IdentityApiClient,
} from "../api/client";
import type { UserPreferences } from "../../../features/preferences/api/contracts";
import type { UserId } from "@chase-sets/primitives/typed-ids";
import { canonicalPreferences } from "../../../features/preferences/domain/domain";

export type PreferenceWritePhase =
  | "editing"
  | "submitting"
  | "confirming"
  | "succeeded"
  | "failed-safe"
  | "conflict"
  | "ambiguous"
  | "reauthentication-required";
export type UserPreferencesAccountMenuState = Readonly<{
  colorMode: ColorMode;
  preferences: ReactNode;
  phase: PreferenceWritePhase;
}>;
type OperationState = {
  userId: string | null;
  colorMode: ColorMode;
  phase: PreferenceWritePhase;
  choice: ColorMode | null;
};

const phaseMessages = {
  submitting: "identity.preferences.recovery.submitting",
  confirming: "identity.preferences.recovery.confirming",
  succeeded: "identity.preferences.recovery.succeeded",
  "failed-safe": "identity.preferences.recovery.failedSafe",
  conflict: "identity.preferences.recovery.conflict",
  ambiguous: "identity.preferences.recovery.ambiguous",
  "reauthentication-required": "identity.preferences.recovery.reauthentication",
} as const;
const phaseDescriptions = {
  submitting: "identity.preferences.recovery.submitting.description",
  confirming: "identity.preferences.recovery.confirming.description",
  succeeded: "identity.preferences.recovery.succeeded.description",
  "failed-safe": "identity.preferences.recovery.failedSafe.description",
  conflict: "identity.preferences.recovery.conflict.description",
  ambiguous: "identity.preferences.recovery.ambiguous.description",
  "reauthentication-required": "identity.preferences.recovery.reauthentication.description",
} as const;

function PreferenceContent({
  colorMode,
  phase,
  onChange,
  onSave,
  onCheck,
}: {
  colorMode: ColorMode;
  phase: PreferenceWritePhase;
  onChange: (mode: ColorMode) => void;
  onSave: () => void;
  onCheck: () => void;
}) {
  const result = useRef<HTMLDivElement>(null);
  const active = phase === "submitting" || phase === "confirming";
  useEffect(() => {
    if (phase !== "editing" && !active) result.current?.querySelector<HTMLHeadingElement>("h3")?.focus();
  }, [phase, active]);
  return createElement(
    Stack,
    { gap: 2 },
    createElement(
      Box,
      { as: "fieldset", disabled: active, "aria-busy": active },
      createElement(ThemePreferenceControl, { value: colorMode, onValueChange: onChange }),
    ),
    phase === "editing"
      ? null
      : createElement(
          Box,
          { ref: result },
          createElement(Banner, {
            role: "status",
            "aria-live": "polite",
            tone: phase === "succeeded" ? "success" : "info",
            title: createElement(Heading, { level: 3, visualSize: 6, tabIndex: -1 }, t(phaseMessages[phase])),
            description: t(phaseDescriptions[phase]),
            actions:
              phase === "ambiguous"
                ? createElement(Button, { size: "sm", onClick: onCheck }, t("identity.preferences.recovery.check"))
                : phase === "failed-safe" || phase === "conflict"
                  ? createElement(Button, { size: "sm", onClick: onSave }, t("identity.preferences.recovery.save"))
                  : phase === "reauthentication-required"
                    ? createElement(
                        LinkButton,
                        { href: "/sign-in", size: "sm" },
                        t("identity.preferences.recovery.signIn"),
                      )
                    : null,
          }),
        ),
  );
}

export function useUserPreferencesAccountMenu(
  initialColorMode: ColorMode | null | undefined,
  userId: string | null,
  client?: Pick<IdentityApiClient, "getUserPreferences" | "updateUserPreferences">,
): UserPreferencesAccountMenuState {
  const [defaultClient] = useState(() => createIdentityApiClient());
  const resolvedClient = client ?? defaultClient;
  const [state, setState] = useState<OperationState>({
    userId,
    colorMode: initialColorMode ?? "system",
    phase: "editing",
    choice: null,
  });
  const generation = useRef({ userId, sequence: 0, mounted: true });
  if (generation.current.userId !== userId) {
    generation.current = { userId, sequence: generation.current.sequence + 1, mounted: true };
  }
  const current =
    state.userId === userId
      ? state
      : { userId, colorMode: initialColorMode ?? "system", phase: "editing" as const, choice: null };
  const currentState = useRef(current);
  currentState.current = current;

  useEffect(() => {
    generation.current.mounted = true;
    return () => {
      generation.current.mounted = false;
      generation.current.sequence += 1;
    };
  }, []);
  useEffect(() => {
    setState((old) =>
      old.userId === userId && old.phase !== "editing"
        ? old
        : { userId, colorMode: initialColorMode ?? "system", phase: "editing", choice: null },
    );
  }, [userId, initialColorMode]);

  const begin = useCallback(
    (choice: ColorMode, checkOnly: boolean) => {
      if (!userId || ["submitting", "confirming"].includes(currentState.current.phase)) return;
      const sequence = ++generation.current.sequence;
      currentState.current = { userId, colorMode: choice, phase: checkOnly ? "confirming" : "submitting", choice };
      const live = () =>
        generation.current.mounted && generation.current.userId === userId && generation.current.sequence === sequence;
      const update = (phase: PreferenceWritePhase, preferences?: UserPreferences) => {
        if (!live()) return;
        setState((old) => ({
          userId,
          colorMode: preferences?.colorMode ?? old.colorMode,
          phase,
          choice: phase === "succeeded" ? null : choice,
        }));
      };
      const authoritative = (preferences: UserPreferences) => {
        return canonicalPreferences(userId as UserId, preferences);
      };
      const confirm = async () => {
        update("confirming");
        try {
          const preferences = authoritative(await resolvedClient.getUserPreferences());
          update(preferences.colorMode === choice ? "succeeded" : "conflict", preferences);
        } catch (error) {
          update(
            error instanceof IdentityApiError && [401, 403].includes(error.status)
              ? "reauthentication-required"
              : "ambiguous",
          );
        }
      };
      setState({ userId, colorMode: choice, phase: checkOnly ? "confirming" : "submitting", choice });
      if (checkOnly) {
        void confirm();
        return;
      }
      void (async () => {
        try {
          const response = await resolvedClient.updateUserPreferences({ colorMode: choice });
          if (!live()) return;
          const preferences = authoritative(response.preferences);
          update(preferences.colorMode === choice ? "succeeded" : "conflict", preferences);
        } catch (error) {
          if (!live()) return;
          if (
            error instanceof PreferenceWriteNotDispatchedError ||
            (error instanceof IdentityApiError && error.status === 400)
          )
            update("failed-safe");
          else if (error instanceof IdentityApiError && [401, 403].includes(error.status))
            update("reauthentication-required");
          else if (error instanceof IdentityApiError && error.status === 409) {
            const body = error.body as { preferences?: UserPreferences } | null;
            try {
              update("conflict", authoritative(body?.preferences as UserPreferences));
            } catch {
              update("conflict");
            }
          } else await confirm();
        }
      })();
    },
    [resolvedClient, userId],
  );

  return {
    colorMode: current.colorMode,
    phase: current.phase,
    preferences: createElement(PreferenceContent, {
      colorMode: current.colorMode,
      phase: current.phase,
      onChange: (choice: ColorMode) => begin(choice, false),
      onSave: () => begin(current.choice ?? current.colorMode, false),
      onCheck: () => begin(current.choice ?? current.colorMode, true),
    }),
  };
}
