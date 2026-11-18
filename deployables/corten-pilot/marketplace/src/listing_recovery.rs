//! A seller's Listing change and what came of it (marketplace's `listing-batch` and
//! `ListingRecoveryNotice`), on the list of listings and a listing's page. Before a change to a
//! listing, to many, or to the account's listing settings is sent, Marketplace prepares it
//! (`prepare`): it works out each target's request hash from the change and answers the reference
//! the change is sent under, whose batch id is its Listing attempt. The page after the change
//! carries that reference on its address (`listingRecovery`), so it, a reload, and the page after
//! a lost answer read back what came of the change (`read`) and say so. While a page shows a
//! change that is recorded, or one it cannot confirm, its changes are off; only the same form
//! entered again while nothing is recorded is sent, under the same attempt. The server refuses the
//! others too, so a page drawn before still sends nothing.
use std::collections::BTreeMap;

use corten::http::StatusCode;

use crate::api::{
    ApiError, Caller as Api, ListingCommand, ListingPreparation, ListingRecovery, ListingReference, Prepared, RecoveredTarget,
    RecoveryPhase, SellerListings as _, SellerSetting, TargetOutcome,
};

/// A reference as the address carries it (`listingRecoveryUrl`): its JSON.
pub fn param(reference: &ListingReference) -> String {
    serde_json::to_string(reference).expect("a reference is JSON")
}

/// The reference an address carries (`readListingRecoveryReference`): none, or one that does not
/// read as one.
pub fn reference(param: Option<&str>) -> Result<Option<ListingReference>, serde_json::Error> {
    param.map(serde_json::from_str).transpose()
}

/// What came of the change the address names (`loadListingRecovery`): nothing without one; a
/// reference that does not read, or a read that fails, is unconfirmed.
pub async fn read(caller: &Api<'_>, param: Option<&str>) -> Option<ListingRecovery> {
    match reference(param) {
        Ok(None) => None,
        Ok(Some(reference)) => Some(recover(caller, &reference).await),
        Err(_) => Some(ListingRecovery::ambiguous()),
    }
}

async fn recover(caller: &Api<'_>, reference: &ListingReference) -> ListingRecovery {
    caller.recover_listing(reference).await.unwrap_or_else(|error| {
        tracing::warn!("a Listing change's outcome could not be read: {error}");
        ListingRecovery::ambiguous()
    })
}

/// A change a form sends: its intent and attempt, the listing or the checked listings, and its
/// fields in the form's names.
pub struct Change<'a> {
    pub intent: &'a str,
    pub attempt: Option<&'a str>,
    pub listing_id: Option<&'a str>,
    pub listing_ids: &'a [String],
    pub fields: BTreeMap<&'static str, String>,
}

/// What to do with a change.
#[derive(Debug)]
pub enum Next {
    /// Send it under this reference's batch id.
    Send(ListingReference),
    /// Do not send it: show this.
    Show(ListingRecovery),
}

/// Prepares `change` from a page whose address carries `param` (marketplace's
/// `prepareListingAction`, and `ListingRecoveryScope`'s submit). With a reference, only the form
/// its recovery offers to enter again is sent, under that attempt; anything else shows the
/// recovery. A preparation that fails sends nothing: unconfirmed with a reference, else not sent.
/// An error only for a session that ended.
pub async fn prepare(caller: &Api<'_>, param: Option<&str>, change: Change<'_>) -> Result<Next, ApiError> {
    let Ok(retained) = reference(param) else {
        return Ok(Next::Show(ListingRecovery::ambiguous()));
    };
    let mut attempt = change.attempt.map(str::to_owned);
    if let Some(retained) = &retained {
        let recovery = recover(caller, retained).await;
        match &recovery.reentry {
            Some(reentry) if reentry.intent == change.intent => attempt = Some(reentry.idempotency_key.clone()),
            _ => return Ok(Next::Show(recovery)),
        }
    }
    let Some(attempt) = attempt else {
        return Ok(Next::Show(ListingRecovery::failed_safe()));
    };
    let preparation = ListingPreparation {
        intent: change.intent,
        idempotency_key: &attempt,
        listing_id: change.listing_id,
        listing_ids: change.listing_ids,
        fields: change.fields,
        retained: retained.as_ref(),
    };
    Ok(match caller.prepare_listing(&preparation).await {
        Ok(Prepared::Recovery { recovery }) => Next::Show(recovery),
        Ok(Prepared::Reference { reference: Some(reference) }) => Next::Send(reference),
        Ok(Prepared::Reference { reference: None }) => Next::Show(ListingRecovery::failed_safe()),
        Err(error) if error.status() == Some(StatusCode::UNAUTHORIZED) => return Err(error),
        Err(error) => {
            tracing::warn!("a Listing change could not be prepared: {error}");
            Next::Show(if retained.is_some() { ListingRecovery::ambiguous() } else { ListingRecovery::failed_safe() })
        }
    })
}

/// Whether a sent change's failure leaves its outcome unknown, so the page reads it back instead
/// of saying why it was refused (`isDefiniteMarketplaceCommandResponse`, negated): no answer, a
/// 5xx, or a history Marketplace could not read whole.
pub fn interrupted(error: &ApiError) -> bool {
    match error.status() {
        None => true,
        Some(status) => status.is_server_error() || error.code() == Some("history_incomplete"),
    }
}

/// A listing's prepared change Marketplace refused with a definite answer (`account-listing`'s
/// action): in conflict for a 409, else not applied. Nothing offers it again, so the page's
/// writes stay off until another change is started.
pub fn refused(reference: &ListingReference, listing: &str, conflict: bool) -> ListingRecovery {
    let (phase, outcome) = if conflict {
        (RecoveryPhase::Conflict, TargetOutcome::Conflict)
    } else {
        (RecoveryPhase::FailedSafe, TargetOutcome::Error)
    };
    ListingRecovery {
        identity: Some(reference.clone()),
        phase,
        items: vec![RecoveredTarget { target_id: listing.to_owned(), outcome }],
        retry_target_ids: Vec::new(),
        reentry: None,
    }
}

/// A listing command's fields as its form names them, with the text the command sends.
pub fn command_fields(command: &ListingCommand) -> BTreeMap<&'static str, String> {
    let count = |n: &Option<u64>| n.map(|n| n.to_string()).unwrap_or_default();
    match command {
        ListingCommand::Price { amount, currency, .. } => {
            BTreeMap::from([("priceAmount", amount.clone()), ("priceCurrencyCode", currency.clone())])
        }
        ListingCommand::QuantityCap { cap, .. } => BTreeMap::from([("quantityCap", cap.to_string())]),
        ListingCommand::PurchaseLimits { per_order, per_day, per_customer } => BTreeMap::from([
            ("maxUnitsPerOrder", count(per_order)),
            ("maxUnitsPerDay", count(per_day)),
            ("maxUnitsPerCustomerAccount", count(per_customer)),
        ]),
        _ => BTreeMap::new(),
    }
}

/// A listing setting's fields as marketplace's forms name them, with the text the setting sends.
pub fn setting_fields(setting: &SellerSetting) -> BTreeMap<&'static str, String> {
    match setting {
        SellerSetting::Disable { reason, on, at } => BTreeMap::from([
            ("reasonCategory", reason.clone()),
            ("availableAgainOn", on.clone()),
            ("availableAgainAt", at.clone()),
        ]),
        SellerSetting::Schedule { reason, starts_at, ends_at } => BTreeMap::from([
            ("awayWindowReasonCategory", reason.clone()),
            ("awayWindowStartsAt", starts_at.clone()),
            ("awayWindowEndsAt", ends_at.clone()),
        ]),
        SellerSetting::Capacity(max) => BTreeMap::from([("maxOpenOrders", max.to_string())]),
        SellerSetting::Enable | SellerSetting::CancelWindow | SellerSetting::ClearCapacity => BTreeMap::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reference_is_the_json_marketplace_puts_on_the_address() {
        let reference =
            ListingReference { batch_id: "k".repeat(22) + "_pauseListing", mutation_kind: "listing.pause".into(), bulk: false };
        let text = param(&reference);
        assert_eq!(text, format!(r#"{{"batchId":"{}","mutationKind":"listing.pause","bulk":false}}"#, reference.batch_id));
        assert_eq!(super::reference(Some(&text)).unwrap(), Some(reference));
        assert!(super::reference(Some("{}")).is_err(), "not a reference");
        assert!(super::reference(Some(r#"{"batchId":"a","mutationKind":"b","bulk":true,"extra":1}"#)).is_err(), "strict");
        assert_eq!(super::reference(None).unwrap(), None);
    }

    #[test]
    fn a_failure_with_no_definite_answer_is_read_back() {
        let status = |status: u16, code: Option<&str>| ApiError::Status {
            status: StatusCode::from_u16(status).unwrap(),
            code: code.map(str::to_owned),
            message: String::new(),
        };
        assert!(interrupted(&status(500, None)));
        assert!(interrupted(&status(503, Some("projection_freshness_timeout"))));
        assert!(interrupted(&status(409, Some("history_incomplete"))));
        assert!(!interrupted(&status(409, Some("attempt_conflict"))));
        assert!(!interrupted(&status(400, Some("order_capacity_invalid"))));
    }

    #[test]
    fn a_definite_refusal_is_a_conflict_or_not_applied_and_blocks_the_page() {
        let reference =
            ListingReference { batch_id: "k_pauseListing".into(), mutation_kind: "listing.pause".into(), bulk: false };
        let conflict = refused(&reference, "lst_1", true);
        assert_eq!(conflict.phase, RecoveryPhase::Conflict);
        assert_eq!(conflict.items[0].target_id, "lst_1");
        assert_eq!(conflict.items[0].outcome, TargetOutcome::Conflict);
        assert!(conflict.blocks());
        let failed = refused(&reference, "lst_1", false);
        assert_eq!(failed.phase, RecoveryPhase::FailedSafe);
        assert_eq!(failed.items[0].outcome, TargetOutcome::Error);
        assert!(failed.blocks());
    }
}
