export const catalogOperatorSessionEnglishTranslations = {
  "catalog.features.operatorSession.ui.adminPanel.title": "Operator session",
  "catalog.features.operatorSession.ui.adminPanel.description":
    "Server-side TCGplayer credential custody is retired. This panel only issues and revokes the grant used to pair the operator extension; no session value or password is entered here.",
  "catalog.features.operatorSession.ui.adminPanel.loading": "Loading operator session…",
  "catalog.features.operatorSession.ui.adminPanel.absent.title": "No stored session",
  "catalog.features.operatorSession.ui.adminPanel.absent.description":
    "No active extension grant exists. Pair the operator extension from the signed-in browser when you need a handoff.",
  "catalog.features.operatorSession.ui.adminPanel.cleared.title": "Stored session cleared",
  "catalog.features.operatorSession.ui.adminPanel.cleared.description":
    "The extension grant was revoked. No TCGplayer credential is stored by the service.",
  "catalog.features.operatorSession.ui.adminPanel.unavailable.title": "Operator session unavailable",
  "catalog.features.operatorSession.ui.adminPanel.unavailable.description":
    "Grant status could not be read. Reload to try again.",
  "catalog.features.operatorSession.ui.adminPanel.facts.revision": "Revision",
  "catalog.features.operatorSession.ui.adminPanel.facts.storedAt": "Stored at",
  "catalog.features.operatorSession.ui.adminPanel.facts.browserExpiresAt": "Browser expiry",
  "catalog.features.operatorSession.ui.adminPanel.facts.browserExpiresAt.none": "None",
  "catalog.features.operatorSession.ui.adminPanel.facts.custodyAvailable": "Server credential custody",
  "catalog.features.operatorSession.ui.adminPanel.facts.custodyAvailable.yes": "Yes",
  "catalog.features.operatorSession.ui.adminPanel.facts.custodyAvailable.no": "No",
  "catalog.features.operatorSession.ui.adminPanel.facts.custodyAvailable.hint":
    "Server-side TCGplayer credential custody is retired and unavailable by design.",
  "catalog.features.operatorSession.ui.adminPanel.facts.custodyAvailable.unreadable":
    "No TCGplayer session is stored or read by this service. Disconnect only revokes the extension grant.",
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
    "Pairing issues a one-time grant for the operator extension. Pairing again replaces the current grant.",
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
  "catalog.features.operatorSession.ui.adminPanel.pair.handoff.paired": "Paired with extension.",
  "catalog.features.operatorSession.ui.adminPanel.pair.handoff.notConfirmed":
    "Automatic pairing was not confirmed. You can paste this grant into the extension.",
  "catalog.features.operatorSession.ui.adminPanel.disconnect.submit": "Disconnect",
  "catalog.features.operatorSession.ui.adminPanel.disconnect.submitting": "Disconnecting…",
  "catalog.features.operatorSession.ui.adminPanel.disconnect.submitting.accessible": "Disconnecting the stored session",
  "catalog.features.operatorSession.ui.adminPanel.disconnect.dialog.title": "Disconnect the stored session?",
  "catalog.features.operatorSession.ui.adminPanel.disconnect.dialog.description":
    "This revokes the extension grant. No TCGplayer credential is stored or used by the service, and this does not sign you out of TCGplayer or end the session in your browser.",
  "catalog.features.operatorSession.ui.adminPanel.disconnect.dialog.confirm": "Disconnect",
  "catalog.features.operatorSession.ui.adminPanel.disconnect.outcome.cleared":
    "Extension grant revoked. The record is now revision {revision}.",
  "catalog.features.operatorSession.ui.adminPanel.disconnect.outcome.unchanged":
    "There was no stored session to clear; any active extension grant was revoked and revision {revision} is unchanged.",
  "catalog.features.operatorSession.ui.adminPanel.disconnect.outcome.conflict":
    "The stored session changed before Disconnect ran; it is now revision {revision}. Review the refreshed status, then confirm Disconnect again.",
  "catalog.features.operatorSession.ui.adminPanel.disconnect.outcome.partialFailure":
    "Disconnect did not finish. The extension grant may already be revoked. Check the status shown here before trying again.",
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
