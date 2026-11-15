//! Save this order's page (Auth's `GuestPaymentClaimRoute` and its `GuestClaimPrompt`, see
//! `guest_claim`), drawn with the payment page's stylesheet: the title, then for a paid order whose
//! contact Auth reports bound, the prompt. It says why the last claim did not save the order, then
//! offers a passkey for the contact's email (the shared passkey step creates it and sends the form
//! with its credential; without a script the form comes without one and the page says so) and a
//! claim link emailed there, saying once sent that it was, with the token to type where the page
//! shows it. A paid order with no bound contact says it cannot be saved now, and one not paid yet
//! that it can be saved after payment; both link back to the payment. One column, as wide as a
//! form reads well.
use corten::prelude::*;
use platform::auth::{PASSKEY_LABEL, passkey};

use crate::{
    app::url,
    guest_claim::{Claim, ClaimForm, ClaimScreen},
    payment::GuestPlace,
    text::{PaymentMsg, Pilot},
};

/// The page (`GuestPaymentClaimRoute`).
#[component(css = super::payment_page::PaymentPage)]
pub fn GuestClaimPage<'a>(t: PaymentMsg, p: Pilot, screen: &'a ClaimScreen) -> impl Render {
    let payment = url::GuestPayment { id: &screen.payment_id, place: GuestPlace::default() };
    html! {
        <div class={(Page, Narrow)}>
            <header class={Header}>
                <div class={Tight}>
                    <p class={Eyebrow}>{t.secure_checkout()}</p>
                    <h1 class={Title}>{t.save_this_order()}</h1>
                </div>
            </header>
            if let Some(sent) = &screen.sent {
                <div class={Banner} role="status">
                    <p>{sent}</p>
                </div>
            }
            match &screen.claim {
                Some(claim) => {
                    <Prompt t={t} id={&screen.payment_id} claim={claim} error={screen.error.as_deref()} />
                }
                None => {
                    <section class={Section} aria-label={t.save_this_order()}>
                        <div class={Card}>
                            if let Some(error) = &screen.error {
                                <div class={Banner} data-tone="danger" role="alert">
                                    <p class={Strong}>{t.could_not_save_order()}</p>
                                    <p>{error}</p>
                                </div>
                            }
                            <p>
                                {if screen.paid { p.guest_claim_unavailable() } else { t.you_can_save_this_order_after_payment() }}
                            </p>
                            <p><a class={(Button, Secondary)} href={&payment}>{p.guest_back_to_payment()}</a></p>
                        </div>
                    </section>
                }
            }
        </div>
    }
}

/// The prompt (`GuestClaimPrompt`): why the last claim did not save the order, the passkey form,
/// the claim link's, and the token's where the page shows it.
#[component(css = super::payment_page::PaymentPage)]
fn Prompt<'a>(t: PaymentMsg, id: &'a str, claim: &'a Claim, error: Option<&'a str>) -> impl Render {
    let f = ClaimForm::FIELDS;
    let action = url::GuestClaim { id, place: Default::default() };
    let (challenge_id, challenge, credential_id, response, button, warning) = refs();
    let parts = passkey::Parts { challenge_id, challenge, credential_id, response, button, warning };
    let (email, name) = refs();
    let challenges = url::PasskeyChallenge.href();
    html! {
        <section class={Section} aria-label={t.save_this_order()}>
            <div class={Card}>
                <p><span class={Badge} data-tone="accent">{t.recommended()}</span></p>
                <p class={Muted}>{t.save_this_order_after_payment_with_a_passkey()}</p>
                if let Some(error) = error {
                    <div class={Banner} data-tone="danger" role="alert">
                        <p class={Strong}>{t.could_not_save_order()}</p>
                        <p>{error}</p>
                    </div>
                }
                <form
                    class={Form}
                    method="post"
                    action={&action}
                    on:submit={passkey::register(event, target, parts, &challenges, email, name)}
                >
                    <input type="hidden" name={f.intent} value="claim-passkey">
                    <input type="hidden" ref={email} name={f.email} value={&claim.contact_email}>
                    <input type="hidden" ref={challenge_id} name={f.challenge_id} value="">
                    <input type="hidden" ref={challenge} name={f.challenge} value="">
                    <input type="hidden" ref={credential_id} name={f.external_credential_id} value="">
                    <input type="hidden" ref={response} name={f.webauthn_response} value="">
                    <input type="hidden" name="label" value={PASSKEY_LABEL}>
                    <label class={Field}>
                        <span class={Label}>{t.contact_name()}</span>
                        <input
                            ref={name}
                            class={Input}
                            type="text"
                            name={f.display_name}
                            autocomplete="name"
                            required
                            value={&claim.display_name}
                        >
                    </label>
                    <p class={Muted}>{t.we_will_save_this_order_to(&claim.contact_email)}</p>
                    <div ref={warning} class={Banner} data-tone="warning" role="alert" tabindex="-1" hidden>
                        <p class={Strong}>{t.passkey_unavailable()}</p>
                        <p>{t.passkey_registration_failed()}</p>
                    </div>
                    <button ref={button} class={Button} type="submit">{t.save_with_passkey()}</button>
                </form>
                <hr class={Divider}>
                <form class={Form} method="post" action={&action}>
                    <input type="hidden" name={f.intent} value="claim-link-request">
                    <input type="hidden" name={f.display_name} value={&claim.display_name}>
                    <p class={Muted}>{t.send_a_claim_link_to(&claim.contact_email)}</p>
                    <button class={(Button, Secondary)} type="submit">{t.email_me_a_claim_link()}</button>
                </form>
                if let Some(sent) = &claim.link_sent {
                    <div class={Banner} role="status">
                        <p>{sent}</p>
                    </div>
                }
                if let Some(token) = &claim.token {
                    <form class={(Form, Inset)} method="post" action={&action}>
                        <p class={Muted}>{t.local_recovery_token_in_production()}</p>
                        <input type="hidden" name={f.intent} value="claim-link-consume">
                        <input type="hidden" name={f.display_name} value={&claim.display_name}>
                        <label class={Field}>
                            <span class={Label}>{t.claim_token()}</span>
                            <input class={Input} type="text" name={f.token} autocomplete="off" required value={token}>
                        </label>
                        <button class={Button} type="submit">{t.verify_email_and_save_order()}</button>
                    </form>
                }
                <details class={Fold}>
                    <summary>{t.other_options()}</summary>
                    <p class={Muted}>{t.password_setup_is_available_only_after()}</p>
                </details>
            </div>
        </section>
    }
}
