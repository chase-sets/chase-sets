//! What came of a seller's Listing change (marketplace's `ListingRecoveryNotice`), on the list of
//! listings and a listing's page: its phase, each target's outcome, that the same form may be
//! entered again while nothing is recorded, Retry for a bulk change's listings whose outcome is
//! unknown, and Start another change (the page without the change) or, when nothing is
//! confirmed, Check the recorded result again.
use corten::prelude::*;
use platform::ui::{
    alert::{Alert, AlertEmphasis, AlertVariant},
    button::{Button, ButtonSize, ButtonVariant},
};

use crate::{
    api::{ListingRecovery, RecoveryPhase, TargetOutcome},
    text::{ListingRecoveryMsg, listing_recovery_msg},
};

fn outcome(t: ListingRecoveryMsg, outcome: TargetOutcome) -> &'static str {
    match outcome {
        TargetOutcome::Succeeded => t.outcome_succeeded(),
        TargetOutcome::Conflict => t.outcome_conflict(),
        TargetOutcome::Error => t.outcome_error(),
        TargetOutcome::Unknown => t.outcome_unknown(),
        TargetOutcome::Ambiguous => t.outcome_ambiguous(),
    }
}

/// `here` is the page with the change, which Retry posts to and Check again reads; `clear` is the
/// page without it.
#[component(css)]
pub fn ListingRecoveryNotice<'a>(
    t: ListingRecoveryMsg,
    recovery: &'a ListingRecovery,
    here: &'a str,
    clear: &'a str,
) -> impl Render {
    let succeeded = recovery.items.iter().filter(|item| item.outcome == TargetOutcome::Succeeded).count();
    let title = match recovery.phase {
        RecoveryPhase::Confirming => t.confirming().to_owned(),
        RecoveryPhase::Succeeded => t.succeeded().to_owned(),
        RecoveryPhase::Partial => t.partial(listing_recovery_msg::Partial { succeeded, total: recovery.items.len() }).to_string(),
        RecoveryPhase::Conflict => t.conflict().to_owned(),
        RecoveryPhase::FailedSafe => t.failed_safe().to_owned(),
        RecoveryPhase::Ambiguous => t.ambiguous().to_owned(),
    };
    let variant = match recovery.phase {
        RecoveryPhase::Ambiguous | RecoveryPhase::Conflict | RecoveryPhase::FailedSafe => AlertVariant::Warning,
        RecoveryPhase::Succeeded => AlertVariant::Success,
        RecoveryPhase::Confirming | RecoveryPhase::Partial => AlertVariant::Info,
    };
    let ambiguous = recovery.phase == RecoveryPhase::Ambiguous;
    let reenter = recovery.reentry.is_some() && !recovery.identity.as_ref().is_some_and(|identity| identity.bulk);
    let secondary = Button { variant: ButtonVariant::Secondary, size: ButtonSize::Md };
    html! {
        <div class={Notice}>
            <Alert variant={variant} emphasis={AlertEmphasis::Soft}>
                <strong>{&title}</strong>
                if !recovery.items.is_empty() {
                    <ul>
                        for item in &recovery.items {
                            <li>
                                {t.target(listing_recovery_msg::Target {
                                    target: &item.target_id,
                                    outcome: outcome(t, item.outcome),
                                })}
                            </li>
                        }
                    </ul>
                }
                if reenter {
                    <p>{t.reenter()}</p>
                }
            </Alert>
            <div class={Actions}>
                if !recovery.retry_target_ids.is_empty() {
                    <form method="post" action={here}>
                        <button
                            class={Button { variant: ButtonVariant::Primary, size: ButtonSize::Md }}
                            type="submit"
                            name="intent"
                            value="retry-listing-batch"
                        >
                            {t.retry_unknown()}
                        </button>
                    </form>
                }
                if ambiguous {
                    <a class={secondary} href={here}>{t.check_again()}</a>
                } else {
                    <a class={secondary} href={clear}>{t.start_another()}</a>
                }
            </div>
        </div>
    }
}
