import { useCallback, useEffect, useRef, useState } from "react";
import type { AccountMenuPreferences, ColorMode } from "@chase-sets/design-system";
import { createIdentityApiClient } from "../api/client";

type UserPreferencesUpdateResponse = Readonly<{
  preferences?: Readonly<{
    colorMode?: ColorMode;
  }>;
}>;

type UserPreferencesAccountMenuClient = Readonly<{
  updateUserPreferences<T>(body: Record<string, unknown>): Promise<T>;
}>;

export type UserPreferencesAccountMenuState = Readonly<{
  colorMode: ColorMode;
  preferences: AccountMenuPreferences;
}>;

export function useUserPreferencesAccountMenu(
  initialColorMode: ColorMode | null | undefined,
  client?: UserPreferencesAccountMenuClient,
): UserPreferencesAccountMenuState {
  const [defaultClient] = useState(() => createIdentityApiClient());
  const resolvedClient = client ?? defaultClient;
  const [colorMode, setColorMode] = useState<ColorMode>(initialColorMode ?? "system");
  const changeSequence = useRef(0);

  useEffect(() => {
    setColorMode(initialColorMode ?? "system");
  }, [initialColorMode]);

  const onColorModeChange = useCallback(
    (nextColorMode: ColorMode) => {
      const sequence = changeSequence.current + 1;
      changeSequence.current = sequence;
      const previousColorMode = colorMode;
      setColorMode(nextColorMode);

      void resolvedClient
        .updateUserPreferences<UserPreferencesUpdateResponse>({ colorMode: nextColorMode })
        .then((response) => {
          if (changeSequence.current === sequence) {
            setColorMode(response.preferences?.colorMode ?? nextColorMode);
          }
        })
        .catch(() => {
          if (changeSequence.current === sequence) {
            setColorMode(previousColorMode);
          }
        });
    },
    [resolvedClient, colorMode],
  );

  return {
    colorMode,
    preferences: {
      colorMode,
      onColorModeChange,
    },
  };
}
