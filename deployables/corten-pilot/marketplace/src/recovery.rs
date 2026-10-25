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
//! page's writes are off; the seller checks again or discards the record.
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::{
    api::{Caller, Inventory as _},
    auth::Actor,
};

/// The kind of write an attempt is (`InventoryMutationFamily`), as the API keeps it: the
/// screen's three, `location-create`, `location-update` and `location-archive`.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum Family {
    #[serde(rename = "location-create")]
    Create,
    #[serde(rename = "location-update")]
    Update,
    #[serde(rename = "location-archive")]
    Archive,
}

impl Family {
    pub fn as_str(self) -> &'static str {
        match self {
            Family::Create => "location-create",
            Family::Update => "location-update",
            Family::Archive => "location-archive",
        }
    }
}

impl fmt::Display for Family {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A new attempt id, as a form's `SubmitKey` draws one.
#[cfg(test)]
pub fn new_attempt() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// An attempt id the API accepts: a UUID, version 4, as the browser record's check requires.
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
