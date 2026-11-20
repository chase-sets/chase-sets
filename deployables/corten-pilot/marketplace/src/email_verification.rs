//! Whether Auth withheld a permission until the member's email is verified, so a page can offer
//! Verify your email in place of the action (contracts/auth-context's
//! `permissionAwaitsEmailVerification`), and the sign-in that verifies it
//! (`emailVerificationSignInHref`).
//!
//! Auth's session says which permissions it withheld and why (`withheldPermissions`); this reads
//! that and grants nothing.

use corten::Route;
use platform::api::Actor;

use crate::{
    app::url,
    sign_in::{Ask, Method},
};

/// The marker on a sign-in's return that names the action the member verifies their email to
/// finish (`EMAIL_VERIFICATION_RETURN_PARAMETER`).
pub const RETURN_PARAMETER: &str = "verifyEmail";

/// What the member verifies their email to do (`EmailVerificationPurpose`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Purpose {
    CancelPurchase,
    PayCheckout,
}

impl Purpose {
    pub fn key(self) -> &'static str {
        match self {
            Purpose::CancelPurchase => "cancel-purchase",
            Purpose::PayCheckout => "pay-checkout",
        }
    }
}

/// Auth's reason for a permission it withholds until the member's email is verified.
const REASON: &str = "email_verification_required";

/// True only when Auth withheld `permission` from the actor pending email verification.
pub fn awaits(actor: &Actor, permission: &str) -> bool {
    actor.withheld(permission, REASON)
}

/// The sign-in that emails a magic link and, once it is opened (which verifies the email), returns
/// to `return_path` marked with `purpose`.
pub fn sign_in_href(return_path: &str, purpose: Purpose) -> String {
    let mark = if return_path.contains('?') { '&' } else { '?' };
    let return_to = format!("{return_path}{mark}{RETURN_PARAMETER}={}", purpose.key());
    let ask = Ask { return_to: Some(return_to), sign_in_method: Some(Method::MagicLink.key().into()), ..Ask::default() };
    url::SignIn { ask }.href()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn actor(withheld: &[(&str, &str)]) -> Actor {
        Actor {
            user_id: "usr_1".into(),
            account_id: "acc_1".into(),
            role_key: "owner".into(),
            permissions: vec!["orders.view".into()],
            session_id: "ses_1".into(),
            withheld_permissions: withheld
                .iter()
                .map(|(permission, reason)| platform::api::WithheldPermission {
                    permission: (*permission).into(),
                    reason: (*reason).into(),
                })
                .collect(),
        }
    }

    #[test]
    fn only_a_permission_auth_withheld_for_the_email_awaits_verification() {
        assert!(awaits(&actor(&[("orders.manage", REASON)]), "orders.manage"));
        // Nothing withheld (a verified member, an agent), another permission, or another reason.
        assert!(!awaits(&actor(&[]), "orders.manage"));
        assert!(!awaits(&actor(&[("orders.manage", REASON)]), "listings.manage"));
        assert!(!awaits(&actor(&[("orders.manage", "another_reason")]), "orders.manage"));
    }

    #[test]
    fn the_sign_in_emails_a_link_and_returns_marked() {
        assert_eq!(
            sign_in_href("/account/purchases/ord_1", Purpose::CancelPurchase),
            "/sign-in?returnTo=%2Faccount%2Fpurchases%2Ford_1%3FverifyEmail%3Dcancel-purchase&signInMethod=magic-link"
        );
        assert_eq!(
            sign_in_href("/checkout/buy/session/chk_1", Purpose::PayCheckout),
            "/sign-in?returnTo=%2Fcheckout%2Fbuy%2Fsession%2Fchk_1%3FverifyEmail%3Dpay-checkout&signInMethod=magic-link"
        );
    }
}
