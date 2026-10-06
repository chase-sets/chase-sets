export const catalogOperatorSessionEnglishTranslations = {
  "catalog.features.operatorSession.ui.adminPanel.title": "Operator session",
  "catalog.features.operatorSession.ui.adminPanel.description":
    "The TCGplayer session stored for provider automation, and pairing for the operator extension that sends it. No session value or password is entered here.",
  "catalog.features.operatorSession.ui.adminPanel.loading": "Loading operator session…",
  "catalog.features.operatorSession.ui.adminPanel.absent.title": "No stored session",
  "catalog.features.operatorSession.ui.adminPanel.absent.description":
    "No session has been stored for this provider yet. Pair the operator extension, then send a session from the browser that is signed in to TCGplayer.",
  "catalog.features.operatorSession.ui.adminPanel.cleared.title": "Stored session cleared",
  "catalog.features.operatorSession.ui.adminPanel.cleared.description":
    "The stored session was cleared and the record is kept at revision {revision}. Automation uses the environment session if one is configured; otherwise it has no credential until the extension sends a new session.",
  "catalog.features.operatorSession.ui.adminPanel.unavailable.title": "Operator session unavailable",
  "catalog.features.operatorSession.ui.adminPanel.unavailable.description":
    "The stored session status could not be read. Reload to try again.",
  "catalog.features.operatorSession.ui.adminPanel.facts.revision": "Revision",
  "catalog.features.operatorSession.ui.adminPanel.facts.storedAt": "Stored at",
  "catalog.features.operatorSession.ui.adminPanel.facts.browserExpiresAt": "Browser expiry",
  "catalog.features.operatorSession.ui.adminPanel.facts.browserExpiresAt.none": "None",
  "catalog.features.operatorSession.ui.adminPanel.facts.custodyAvailable": "Custody available",
  "catalog.features.operatorSession.ui.adminPanel.facts.custodyAvailable.yes": "Yes",
  "catalog.features.operatorSession.ui.adminPanel.facts.custodyAvailable.no": "No",
  "catalog.features.operatorSession.ui.adminPanel.facts.custodyAvailable.hint":
    "Whether this service can read and store sessions with its current key. It does not say whether TCGplayer still accepts the session, when it expires, or who may use it.",
  "catalog.features.operatorSession.ui.adminPanel.facts.custodyAvailable.unreadable":
    "The stored session cannot be read with the current key. Automation fails closed and does not use the environment session while this record remains. Disconnect still clears it.",
  "catalog.features.operatorSession.ui.adminPanel.grant.heading": "Extension grant",
  "catalog.features.operatorSession.ui.adminPanel.grant.state.none": "No grant",
  "catalog.features.operatorSession.ui.adminPanel.grant.state.active": "Active",
  "catalog.features.operatorSession.ui.adminPanel.grant.state.inactive": "Inactive",
  "catalog.features.operatorSession.ui.adminPanel.grant.state.inactive.hint":
    "This grant can no longer be used. Pair again to issue a new one.",
  "catalog.features.operatorSession.ui.adminPanel.grant.createdAt": "Created",
  "catalog.features.operatorSession.ui.adminPanel.grant.lastUsedAt": "Last used",
  "catalog.features.operatorSession.ui.adminPanel.grant.idleExpiresAt": "Idle expiry",
  "catalog.features.operatorSession.ui.adminPanel.pair.description":
    "Pairing issues a one-time grant that the operator extension uses to send this browser's TCGplayer session. Pairing again replaces the current grant.",
  "catalog.features.operatorSession.ui.adminPanel.pair.submit": "Pair extension",
  "catalog.features.operatorSession.ui.adminPanel.pair.submitting": "Pairing…",
  "catalog.features.operatorSession.ui.adminPanel.pair.submitting.accessible": "Pairing the operator extension",
  "catalog.features.operatorSession.ui.adminPanel.pair.grant.heading": "New extension grant",
  "catalog.features.operatorSession.ui.adminPanel.pair.grant.once":
    "This grant is shown once. It is not stored anywhere you can see it again.",
  "catalog.features.operatorSession.ui.adminPanel.pair.grant.paste":
    "Copy it now and paste it into the operator extension. If you lose it, pair again to replace it.",
  "catalog.features.operatorSession.ui.adminPanel.pair.grant.idleExpiresAt": "Idle expiry {instant}",
  "catalog.features.operatorSession.ui.adminPanel.pair.grant.dismiss": "Dismiss grant",
  "catalog.features.operatorSession.ui.adminPanel.pair.grant.announcement":
    "A new extension grant is ready to copy. It is shown once.",
  "catalog.features.operatorSession.ui.adminPanel.disconnect.submit": "Disconnect",
  "catalog.features.operatorSession.ui.adminPanel.disconnect.submitting": "Disconnecting…",
  "catalog.features.operatorSession.ui.adminPanel.disconnect.submitting.accessible": "Disconnecting the stored session",
  "catalog.features.operatorSession.ui.adminPanel.disconnect.dialog.title": "Disconnect the stored session?",
  "catalog.features.operatorSession.ui.adminPanel.disconnect.dialog.description":
    "This clears the TCGplayer session stored here and revokes the extension grant. Afterwards, automation uses the environment session if one is configured; otherwise it has no credential until the extension sends a new session. It does not sign you out of TCGplayer or end the session in your browser.",
  "catalog.features.operatorSession.ui.adminPanel.disconnect.dialog.confirm": "Disconnect",
  "catalog.features.operatorSession.ui.adminPanel.disconnect.outcome.cleared":
    "Stored session cleared. The record is now revision {revision}.",
  "catalog.features.operatorSession.ui.adminPanel.disconnect.outcome.unchanged":
    "There was no stored session to clear, so revision {revision} is unchanged. Any active extension grant was revoked.",
  "catalog.features.operatorSession.ui.adminPanel.disconnect.outcome.conflict":
    "The stored session changed before Disconnect ran; it is now revision {revision}. Review the refreshed status, then confirm Disconnect again.",
  "catalog.features.operatorSession.ui.adminPanel.disconnect.outcome.partialFailure":
    "Disconnect did not finish. The extension grant may already be revoked, and the stored session may or may not have been cleared. Check the status shown here before trying again.",
  "catalog.features.operatorSession.ui.adminPanel.stepUp.message": "This action needs a recent sign-in.",
  "catalog.features.operatorSession.ui.adminPanel.stepUp.signIn": "Sign in again",
  "catalog.features.operatorSession.ui.adminPanel.error.forbidden":
    "This action is not permitted for your current access.",
  "catalog.features.operatorSession.ui.adminPanel.error.unauthenticated":
    "Your sign-in has expired. Sign in again to continue.",
  "catalog.features.operatorSession.ui.adminPanel.error.custodyUnavailable":
    "Session custody is unavailable right now, so this request could not be completed.",
  "catalog.features.operatorSession.ui.adminPanel.error.revisionExhausted":
    "This session record has reached its revision limit and cannot be changed.",
  "catalog.features.operatorSession.ui.adminPanel.error.rateLimited":
    "Too many operator session requests. Wait a moment, then try again.",
  "catalog.features.operatorSession.ui.adminPanel.error.unknown":
    "The request could not be completed and may not have reached the server. Check the status shown here before trying again.",
} as const;
