// @ts-check
// A passkey's step on the sign-in, registration and invitation pages (Auth's passkey-browser.ts).
// Its form's press asks the page's challenge route for a challenge, the browser's WebAuthn signs
// it (or creates a credential for it), and the form is sent again with the credential in its
// hidden fields, which the page's action hands to Auth. Any failure, a browser without passkeys
// included, shows the form's warning and leaves the press for another try. Without a script the
// form is sent as it is, and the page says the passkey could not be used.

/** WebAuthn's wait for the user, as Auth's browser helper waits. */
const TIMEOUT_MS = 60_000;

/**
 * The form's hidden fields the credential fills, and what the press shows.
 * @typedef {object} Parts
 * @property {HTMLInputElement} challenge_id
 * @property {HTMLInputElement} challenge
 * @property {HTMLInputElement} credential_id
 * @property {HTMLInputElement} response
 * @property {HTMLButtonElement} button
 * @property {HTMLDivElement} warning
 */

/**
 * Use Passkey: the browser signs a sign-in challenge for `email` with a passkey it has.
 *
 * @param {SubmitEvent} event
 * @param {HTMLFormElement} form
 * @param {Parts} parts
 * @param {string} challenges the page's challenge route
 * @param {string} email
 */
export function signIn(event, form, parts, challenges, email) {
  press(event, form, parts, async () => {
    const issued = await challenge(challenges, "passkey-sign-in", email);
    const credential = await navigator.credentials.get({
      publicKey: { challenge: bytes(issued.challenge), timeout: TIMEOUT_MS, userVerification: "required" },
    });
    return { issued, credential: assertion(credential) };
  });
}

/**
 * Create with passkey: the browser creates a passkey for the email and name the form holds.
 *
 * @param {SubmitEvent} event
 * @param {HTMLFormElement} form
 * @param {Parts} parts
 * @param {string} challenges the page's challenge route
 * @param {HTMLInputElement} email
 * @param {HTMLInputElement} name
 */
export function register(event, form, parts, challenges, email, name) {
  create(event, form, parts, challenges, email.value.trim(), name.value.trim());
}

/**
 * Accept with passkey: the browser creates a passkey for the invited email, named by it.
 *
 * @param {SubmitEvent} event
 * @param {HTMLFormElement} form
 * @param {Parts} parts
 * @param {string} challenges the page's challenge route
 * @param {string} email
 */
export function accept(event, form, parts, challenges, email) {
  create(event, form, parts, challenges, email, email);
}

/**
 * @param {SubmitEvent} event @param {HTMLFormElement} form @param {Parts} parts
 * @param {string} challenges @param {string} email @param {string} name
 */
function create(event, form, parts, challenges, email, name) {
  press(event, form, parts, async () => {
    const issued = await challenge(challenges, "passkey-register", email);
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge: bytes(issued.challenge),
        rp: { name: "Chase Sets" },
        user: { id: new TextEncoder().encode(email), name: email, displayName: name || email },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
        timeout: TIMEOUT_MS,
        attestation: "none",
      },
    });
    return { issued, credential: attestation(credential) };
  });
}

/**
 * The press: once the credential is in its fields the form goes; before, the browser's ceremony
 * runs and the form is sent again with it.
 *
 * @param {SubmitEvent} event @param {HTMLFormElement} form @param {Parts} parts
 * @param {() => Promise<{ issued: { challengeId: string, challenge: string }, credential: { id: string, json: string } }>} ceremony
 */
function press(event, form, parts, ceremony) {
  if (form.dataset.passkey === "ready") {
    delete form.dataset.passkey;
    return;
  }
  event.preventDefault();
  if (parts.button.disabled) return;
  parts.warning.hidden = true;
  parts.button.disabled = true;
  parts.button.setAttribute("aria-busy", "true");
  const done = () => {
    parts.button.disabled = false;
    parts.button.removeAttribute("aria-busy");
  };
  const available = "PublicKeyCredential" in window && Boolean(navigator.credentials);
  (available ? ceremony() : Promise.reject(new Error("no passkeys"))).then(
    ({ issued, credential }) => {
      parts.challenge_id.value = issued.challengeId;
      parts.challenge.value = issued.challenge;
      parts.credential_id.value = credential.id;
      parts.response.value = credential.json;
      done();
      form.dataset.passkey = "ready";
      form.requestSubmit(parts.button);
    },
    () => {
      done();
      parts.warning.hidden = false;
      parts.warning.focus();
    },
  );
}

/**
 * A challenge from the page's route (`requestChallenge`).
 * @param {string} route @param {string} purpose @param {string} email
 * @returns {Promise<{ challengeId: string, challenge: string }>}
 */
async function challenge(route, purpose, email) {
  const res = await fetch(route, {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json" },
    body: new URLSearchParams({ purpose, email }),
  });
  if (!res.ok) throw new Error(`challenge ${res.status}`);
  const issued = await res.json();
  if (typeof issued?.challengeId !== "string" || typeof issued?.challenge !== "string") throw new Error("challenge");
  return issued;
}

/** @param {Credential | null} value */
function publicKey(value) {
  if (!(value instanceof PublicKeyCredential)) throw new Error("No passkey credential was selected.");
  return value;
}

/** A sign-in's credential as Auth reads it (`serializeAuthenticationCredential`). @param {Credential | null} value */
function assertion(value) {
  const credential = publicKey(value);
  const response = /** @type {AuthenticatorAssertionResponse} */ (credential.response);
  if (!("authenticatorData" in response) || !("signature" in response)) throw new Error("no assertion");
  const json = JSON.stringify({
    id: credential.id,
    rawId: text(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: text(response.clientDataJSON),
      authenticatorData: text(response.authenticatorData),
      signature: text(response.signature),
      userHandle: response.userHandle ? text(response.userHandle) : undefined,
    },
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
  });
  return { id: credential.id, json };
}

/** A new credential as Auth reads it (`serializeRegistrationCredential`). @param {Credential | null} value */
function attestation(value) {
  const credential = publicKey(value);
  const response = /** @type {AuthenticatorAttestationResponse} */ (credential.response);
  if (!("attestationObject" in response)) throw new Error("no attestation");
  const json = JSON.stringify({
    id: credential.id,
    rawId: text(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: text(response.clientDataJSON),
      attestationObject: text(response.attestationObject),
      transports: typeof response.getTransports === "function" ? response.getTransports() : [],
    },
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
  });
  return { id: credential.id, json };
}

/** base64url to bytes. @param {string} value */
function bytes(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** Bytes to base64url. @param {ArrayBuffer} value */
function text(value) {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
