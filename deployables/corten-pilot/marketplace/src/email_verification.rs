//! Whether Auth withheld a permission until the member's email is verified, so a page can offer
//! Verify your email in place of the action (contracts/auth-context's
//! `permissionAwaitsEmailVerification`), and the sign-in that verifies it
//! (`emailVerificationSignInHref`).
//!
//! Auth's session lists only the permissions it kept, so this reads Auth's role table from
//! `email-verification.json` (scripts/export.mjs), as marketplace-web does. It grants nothing. A
//! workaround until Auth says what it withheld: chase-sets/chase-sets#10987.

use std::{collections::HashMap, sync::LazyLock};

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
}

impl Purpose {
    pub fn key(self) -> &'static str {
        match self {
            Purpose::CancelPurchase => "cancel-purchase",
        }
    }
}

/// Each role's permissions Auth withholds until the member's email is verified.
static WITHHELD: LazyLock<HashMap<String, Vec<String>>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../email-verification.json")).expect("email-verification.json is the export's output")
});

/// True only when the actor's role grants `permission` and Auth withheld it pending email
/// verification. An agent's actor is never told to verify.
pub fn awaits(actor: &Actor, permission: &str) -> bool {
    !actor.agent
        && !actor.can(permission)
        && WITHHELD.get(&actor.role_key).is_some_and(|withheld| withheld.iter().any(|p| p == permission))
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

    fn actor(role: &str, permissions: &[&str], agent: bool) -> Actor {
        Actor {
            user_id: "usr_1".into(),
            account_id: "acc_1".into(),
            role_key: role.into(),
            permissions: permissions.iter().map(|p| (*p).to_owned()).collect(),
            agent,
        }
    }

    #[test]
    fn only_a_permission_the_role_grants_and_auth_withheld_awaits_verification() {
        assert!(awaits(&actor("owner", &["orders.view"], false), "orders.manage"));
        assert!(awaits(&actor("manager", &[], false), "listings.manage"));
        // Kept, not granted by the role, not one Auth withholds, or an agent's.
        assert!(!awaits(&actor("owner", &["orders.manage"], false), "orders.manage"));
        assert!(!awaits(&actor("viewer", &["orders.view"], false), "orders.manage"));
        assert!(!awaits(&actor("owner", &[], false), "accounts.manage"));
        assert!(!awaits(&actor("owner", &[], true), "orders.manage"));
    }

    #[test]
    fn the_sign_in_emails_a_link_and_returns_marked() {
        assert_eq!(
            sign_in_href("/account/purchases/ord_1", Purpose::CancelPurchase),
            "/sign-in?returnTo=%2Faccount%2Fpurchases%2Ford_1%3FverifyEmail%3Dcancel-purchase&signInMethod=magic-link"
        );
    }
}
