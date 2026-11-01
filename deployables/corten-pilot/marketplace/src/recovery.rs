//! Confirming a write whose answer the browser may not have seen.
//!
//! Every write form carries an attempt id, Corten's `SubmitKey` (a UUID v4 drawn with the form,
//! which the runtime keeps until an answer arrives), and the pilot sends it as
//! `Inventory-Mutation-Attempt`: the Inventory API applies an attempt once and keeps
//! its result (`GET /api/inventory/mutation-attempts/{id}`). A form posted again with the same id
//! (a double click, the browser resending after a lost answer) cannot apply twice.
//!
//! The form's script remembers the attempt in sessionStorage before it is sent, as marketplace's
//! `InventoryMutationProvider` does. Each page says which attempt its answer settles; a page that
//! finds a record it does not settle asks to check it (`?attempt=..&family=..&target=..&user=..`),
//! and the pilot asks the API whether the attempt was applied. While the answer is uncertain, the
//! page's writes are off; the seller checks again or discards the record. Every page confirms a
//! record of any of the pilot's families, as marketplace's `InventoryMutationProvider` does on
//! every Inventory page.
use corten::{Fields, Route, SubmitKey};
use serde::{Deserialize, Serialize};

use corten::{axum::http::StatusCode, prelude::Errors};

use crate::{
    api::{ApiError, Caller, Inventory as _},
    auth::Actor,
};

/// The kind of write an attempt is (`InventoryMutationFamily`), as the API keeps it: the
/// storage locations' three, a restock decision's, Create inventory item's, and an item's
/// adjustment and holds.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, corten::UrlValue)]
pub enum Family {
    #[serde(rename = "location-create")]
    Create,
    #[serde(rename = "location-update")]
    Update,
    #[serde(rename = "location-archive")]
    Archive,
    #[serde(rename = "restock-record")]
    Restock,
    #[serde(rename = "item-create")]
    ItemCreate,
    #[serde(rename = "item-adjust")]
    ItemAdjust,
    #[serde(rename = "hold-create")]
    HoldCreate,
    #[serde(rename = "hold-release")]
    HoldRelease,
}

impl Family {
    pub fn as_str(self) -> &'static str {
        match self {
            Family::Create => "location-create",
            Family::Update => "location-update",
            Family::Archive => "location-archive",
            Family::Restock => "restock-record",
            Family::ItemCreate => "item-create",
            Family::ItemAdjust => "item-adjust",
            Family::HoldCreate => "hold-create",
            Family::HoldRelease => "hold-release",
        }
    }
}

/// What a page's address carries about the last write: its receipt (`after_write`), and a write
/// to confirm (`attempt`, `family`, `target`, and `user` only when the browser's record names
/// it). Every page that writes takes it.
#[derive(Clone, Debug, Default, Deserialize, Fields, Route)]
#[route(query)]
pub struct Check {
    pub after_write: Option<String>,
    pub attempt: Option<String>,
    pub family: Option<Family>,
    pub target: Option<String>,
    pub user: Option<String>,
}

impl Check {
    /// After a write the API applied: wait for its receipt and confirm its attempt.
    pub fn applied(family: Family, target: &str, attempt: &str, receipt: Option<String>) -> Self {
        Check {
            after_write: receipt,
            attempt: Some(attempt.into()),
            family: Some(family),
            target: Some(target.into()),
            user: None,
        }
    }

    /// The same check, without the receipt: the status's "check again".
    pub fn again(&self) -> Self {
        Check { after_write: None, ..self.clone() }
    }
}

/// A new attempt id, as a form's `SubmitKey` draws one.
#[cfg(test)]
pub fn new_attempt() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// An attempt id the API accepts: a UUID, version 4, as the browser record's check requires.
/// The attempt a form posted, as text: empty when it sent none. A key that is not a UUID v4 is
/// refused by the form's reader (`SubmitKey`) before the handler runs.
pub fn attempt_text(key: &Option<SubmitKey>) -> &str {
    key.as_ref().map_or("", SubmitKey::as_str)
}

/// `text` as a submit key, when it is one (a UUID v4): an attempt the server made up, to carry
/// in a form drawn again.
pub fn submit_key(text: &str) -> Option<SubmitKey> {
    use serde::de::{IntoDeserializer, value::Error};
    SubmitKey::deserialize(IntoDeserializer::<Error>::into_deserializer(text)).ok()
}

pub fn valid_attempt(id: &str) -> bool {
    uuid::Uuid::try_parse(id).is_ok_and(|u| u.get_version_num() == 4 && u.hyphenated().to_string() == id.to_ascii_lowercase())
}

/// What the page says about the last write.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", content = "attempt", rename_all = "kebab-case")]
pub enum Status {
    /// Nothing to confirm.
    Ready,
    /// This answer settles the attempt: nothing was applied (the input or the API refused it).
    Refused(String),
    /// The API holds the attempt's result: it was applied, once.
    Confirmed(String),
    /// Whether the attempt was applied is not known.
    Uncertain(String),
    /// The record is another user's: they must sign in to confirm it.
    Reauth(String),
}

impl Status {
    /// The attempt this answer settles: the browser forgets it.
    pub fn settles(&self) -> Option<&str> {
        match self {
            Status::Refused(id) | Status::Confirmed(id) => Some(id),
            _ => None,
        }
    }

    /// The attempt this page checked and could not confirm: the browser keeps it, and does not
    /// ask again on its own.
    pub fn unsettled(&self) -> Option<&str> {
        match self {
            Status::Uncertain(id) | Status::Reauth(id) => Some(id),
            _ => None,
        }
    }

    pub fn writes(&self) -> bool {
        self.unsettled().is_none()
    }

    /// Whether the status takes focus, as marketplace's does for an outcome.
    pub fn announces(&self) -> bool {
        !matches!(self, Status::Ready | Status::Refused(_))
    }
}

/// The page's answer about `attempt`, as the browser's record describes it.
pub async fn check(
    caller: &Caller<'_>,
    actor: &Actor,
    attempt: &str,
    family: Option<Family>,
    target: Option<&str>,
    user: Option<&str>,
) -> Status {
    let (Some(family), Some(target)) = (family, target) else {
        return Status::Uncertain(attempt.into());
    };
    if !valid_attempt(attempt) {
        return Status::Uncertain(attempt.into());
    }
    if user.is_some_and(|u| u != actor.user_id) {
        return Status::Reauth(attempt.into());
    }
    match caller.attempt(attempt).await {
        Ok(Some(result)) if result.version == 1 && result.family == family.as_str() && result.target_id == target => {
            Status::Confirmed(attempt.into())
        }
        Ok(_) => Status::Uncertain(attempt.into()),
        Err(error) if matches!(error.status().map(|s| s.as_u16()), Some(401 | 403)) => Status::Reauth(attempt.into()),
        Err(error) => {
            tracing::warn!("attempt check failed: {error}");
            Status::Uncertain(attempt.into())
        }
    }
}

/// What a write's failed API call means for its form.
pub enum Failed {
    /// The API refused the attempt with a message for the user: nothing was applied.
    Refused(Errors),
    /// The API refused this request, but holds a result for its attempt: the same attempt was
    /// applied before (the form was posted again with other fields).
    AppliedBefore,
    /// Not signed in any more: sign in again.
    SignIn,
    /// No answer, or one that says nothing about the attempt: the error page. The browser keeps
    /// its record and the next page checks it.
    Unknown(corten::Error),
}

/// What `error`, the answer to a write of `family` on `target` sent as `attempt`, means.
pub async fn failed(caller: &Caller<'_>, family: Family, target: &str, attempt: &str, error: ApiError) -> Failed {
    if error.status() == Some(StatusCode::UNAUTHORIZED) {
        return Failed::SignIn;
    }
    let Some(message) = error.refusal() else {
        return Failed::Unknown(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY));
    };
    match caller.attempt(attempt).await {
        Ok(Some(result)) if result.family == family.as_str() && result.target_id == target => Failed::AppliedBefore,
        Ok(_) => {
            let mut errors = Errors::new();
            errors.add_form(message);
            Failed::Refused(errors)
        }
        Err(lookup) => {
            tracing::warn!("attempt check after a refusal failed: {lookup}");
            Failed::Unknown(corten::Error::new(error).with_status(StatusCode::BAD_GATEWAY))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attempts_are_version_4_uuids() {
        let id = new_attempt();
        assert!(valid_attempt(&id), "{id}");
        assert!(!valid_attempt(""));
        assert!(!valid_attempt("unreadable"));
        assert!(!valid_attempt("00000000-0000-1000-8000-000000000000"), "version 1");
        assert!(!valid_attempt(&id.replace('-', "")), "the hyphenated form only");
    }

    #[test]
    fn only_an_unsettled_answer_turns_writes_off() {
        assert!(Status::Ready.writes() && Status::Refused("a".into()).writes() && Status::Confirmed("a".into()).writes());
        assert!(!Status::Uncertain("a".into()).writes() && !Status::Reauth("a".into()).writes());
        assert_eq!(Status::Refused("a".into()).settles(), Some("a"));
        assert_eq!(Status::Uncertain("a".into()).settles(), None);
    }
}
