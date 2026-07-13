import { t } from "@chase-sets/localization";
import type { AuthServices } from "../runtime-support/services";

export type RegistrationAdmissionMode = "invitation" | "open";
export type DisposableEmailMode = "enforce" | "log-only";

export type RegistrationAdmissionConfig = Readonly<{
  mode: RegistrationAdmissionMode;
  disposableEmailMode: DisposableEmailMode;
  disposableEmailDomains: readonly string[];
}>;

export const DEFAULT_DISPOSABLE_EMAIL_DOMAINS = [
  "10minutemail.com",
  "guerrillamail.com",
  "mailinator.com",
  "tempmail.com",
  "yopmail.com",
] as const;

export const DEFAULT_REGISTRATION_ADMISSION_CONFIG: RegistrationAdmissionConfig = {
  mode: "invitation",
  disposableEmailMode: "log-only",
  disposableEmailDomains: DEFAULT_DISPOSABLE_EMAIL_DOMAINS,
};

export type RegistrationGateFailure = Readonly<{
  status: 403;
  body: {
    error: {
      code: "registration_admission_required" | "disposable_email_domain";
      message: string;
      waitlistPath?: string;
      mode?: DisposableEmailMode;
      domain?: string;
    };
  };
}>;

export type RegistrationGateResult =
  | Readonly<{ ok: true; invitationId?: string }>
  | Readonly<{ ok: false; failure: RegistrationGateFailure }>;

function registrationConfig(services: AuthServices): RegistrationAdmissionConfig {
  return services.registrationAdmission ?? DEFAULT_REGISTRATION_ADMISSION_CONFIG;
}

export function emailDomain(email: string): string {
  const normalized = email.trim().toLowerCase();
  const atIndex = normalized.lastIndexOf("@");
  return atIndex >= 0 ? normalized.slice(atIndex + 1) : "";
}

function disposableDomainSet(services: AuthServices) {
  return new Set(registrationConfig(services).disposableEmailDomains.map((domain) => domain.trim().toLowerCase()));
}

function waitlistFailure(): RegistrationGateFailure {
  return {
    status: 403,
    body: {
      error: {
        code: "registration_admission_required",
        message: t("auth.support.apiSupport.registrationGates.registration.requires.an.invitation"),
        waitlistPath: "/#waitlist-form",
      },
    },
  };
}

function disposableEmailFailure(domain: string, mode: DisposableEmailMode): RegistrationGateFailure {
  return {
    status: 403,
    body: {
      error: {
        code: "disposable_email_domain",
        message: t("auth.support.apiSupport.registrationGates.disposable.email.domains.are.not.allowed"),
        domain,
        mode,
        waitlistPath: "/#waitlist-form",
      },
    },
  };
}

export async function screenRegistrationEmailDomain(
  services: AuthServices,
  email: string,
): Promise<RegistrationGateResult> {
  const domain = emailDomain(email);
  if (!domain || !disposableDomainSet(services).has(domain)) {
    return { ok: true };
  }

  const config = registrationConfig(services);
  if (config.disposableEmailMode === "log-only") {
    await services.registrationAdmission?.screeningObserver?.record({
      decision: "log-only",
      emailDomain: domain,
      reason: "disposable-email-domain",
    });
    return { ok: true };
  }

  await services.registrationAdmission?.screeningObserver?.record({
    decision: "blocked",
    emailDomain: domain,
    reason: "disposable-email-domain",
  });
  return { ok: false, failure: disposableEmailFailure(domain, config.disposableEmailMode) };
}

export async function requireRegistrationAdmission(
  services: AuthServices,
  email: string | null | undefined,
): Promise<RegistrationGateResult> {
  const normalizedEmail = email ? services.identity.normalizeEmail(email) : "";
  if (!normalizedEmail) {
    return registrationConfig(services).mode === "open" ? { ok: true } : { ok: false, failure: waitlistFailure() };
  }

  const domainScreen = await screenRegistrationEmailDomain(services, normalizedEmail);
  if (!domainScreen.ok) {
    return domainScreen;
  }

  if (registrationConfig(services).mode === "open") {
    return { ok: true };
  }

  const waveAdmission = await services.registrationAdmission?.findAdmittedWaitlistSignupByEmail?.(normalizedEmail);
  if (waveAdmission) {
    return { ok: true, invitationId: waveAdmission.beta_invitation_id };
  }

  const invitation = await services.identity.findPendingInvitationByEmail(normalizedEmail);
  if (!invitation) {
    return { ok: false, failure: waitlistFailure() };
  }

  return { ok: true, invitationId: invitation.invitation_id };
}
