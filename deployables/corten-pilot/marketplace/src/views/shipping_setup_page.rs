//! Seller shipping setup (Fulfillment's `ShippingSetupPage`): the title, Back to Sell List, why the
//! last save or read failed, and then either the request to open the Sell List first (no one's
//! setup), Retry (the setup could not be read), or whether the platform supports the saved setup
//! and the form.
//!
//! No script: the form posts and the page answers. Its fields are the kit's `Field`, `Input` and
//! `Select`, each `required` but line 2, at most 200 long, as marketplace's are. One column on a
//! phone; from 40rem the city, state, postal code and country two across.
use corten::{form::Within, prelude::*};
use platform::ui::{
    alert::{Alert, AlertEmphasis, AlertVariant},
    button::{Button, ButtonSize, ButtonVariant},
    field::Field,
    input::Input,
    select::Select,
};

use crate::{
    app::url,
    shipping_setup::{LATER, PREPAID, Screen, Values},
    text::ShippingSetupMsg,
};

/// The page's one form.
#[derive(Id, Clone, Copy)]
pub struct ShippingSetupFormId;

/// The saved setup's banner (`savedSupported` or `savedPending`), or the text for none.
fn saved(t: ShippingSetupMsg, screen: &Screen) -> Option<(AlertVariant, &'static str)> {
    let read = screen.read.as_ref()?;
    read.setup.as_ref()?;
    Some(if read.support_status == "enabled" {
        (AlertVariant::Success, t.saved_supported())
    } else {
        (AlertVariant::Warning, t.saved_pending())
    })
}

/// The page.
#[component(css)]
pub fn ShippingSetupPage<'a>(t: ShippingSetupMsg, screen: &'a Screen) -> impl Render {
    let f = Values::FIELDS;
    let e = Within::none(ShippingSetupFormId);
    let v = &screen.values;
    let secondary = Button { variant: ButtonVariant::Secondary, size: ButtonSize::Md };
    let primary = Button { variant: ButtonVariant::Primary, size: ButtonSize::Md };
    let preferences = [(PREPAID, t.label_prepaid()), (LATER, t.label_later())];
    html! {
        <header class={Header}>
            <h1 class={Title}>{t.title()}</h1>
            <p class={Muted}>{t.description()}</p>
        </header>
        <p class={Actions}><a class={secondary} href={url::SellList::PATH}>{t.back()}</a></p>
        if let Some(error) = &screen.error {
            <Alert variant={AlertVariant::Destructive} emphasis={AlertEmphasis::Soft}><p>{error}</p></Alert>
        }
        if screen.owner.is_none() {
            <Alert variant={AlertVariant::Warning} emphasis={AlertEmphasis::Soft}><p>{t.missing_identity()}</p></Alert>
        } else if screen.unavailable {
            <p class={Actions}><a class={primary} href={url::ShippingSetup::PATH}>{t.retry()}</a></p>
        } else {
            match saved(t, screen) {
                Some((variant, said)) => {
                    <Alert variant={variant} emphasis={AlertEmphasis::Soft}><p>{said}</p></Alert>
                }
                None => {
                    <p class={Muted}>{t.empty()}</p>
                }
            }
            <form id={ShippingSetupFormId} class={Form} method="post" action={url::ShippingSetup::PATH}>
                <Field id={e.id(f.name)} label={t.name()} hint="" error="">
                    <input
                        class={Input {}}
                        type="text"
                        required
                        maxlength="200"
                        autocomplete="name"
                        value={&v.name}
                        {..e.control(f.name).hint()}
                    >
                </Field>
                <Field id={e.id(f.line1)} label={t.line1()} hint="" error="">
                    <input
                        class={Input {}}
                        type="text"
                        required
                        maxlength="200"
                        autocomplete="address-line1"
                        value={&v.line1}
                        {..e.control(f.line1).hint()}
                    >
                </Field>
                <Field id={e.id(f.line2)} label={t.line2()} hint="" error="">
                    <input
                        class={Input {}}
                        type="text"
                        maxlength="200"
                        autocomplete="address-line2"
                        value={&v.line2}
                        {..e.control(f.line2).hint()}
                    >
                </Field>
                <div class={Pairs}>
                    <Field id={e.id(f.city)} label={t.city()} hint="" error="">
                        <input
                            class={Input {}}
                            type="text"
                            required
                            maxlength="200"
                            autocomplete="address-level2"
                            value={&v.city}
                            {..e.control(f.city).hint()}
                        >
                    </Field>
                    <Field id={e.id(f.state)} label={t.state()} hint="" error="">
                        <input
                            class={Input {}}
                            type="text"
                            required
                            maxlength="200"
                            autocomplete="address-level1"
                            value={&v.state}
                            {..e.control(f.state).hint()}
                        >
                    </Field>
                    <Field id={e.id(f.postal_code)} label={t.postal_code()} hint="" error="">
                        <input
                            class={Input {}}
                            type="text"
                            required
                            maxlength="200"
                            autocomplete="postal-code"
                            value={&v.postal_code}
                            {..e.control(f.postal_code).hint()}
                        >
                    </Field>
                    <Field id={e.id(f.country)} label={t.country()} hint="" error="">
                        <input
                            class={Input {}}
                            type="text"
                            required
                            maxlength="200"
                            autocomplete="country"
                            value={&v.country}
                            {..e.control(f.country).hint()}
                        >
                    </Field>
                </div>
                <Field id={e.id(f.label_preference)} label={t.label_preference()} hint="" error="">
                    <select class={Select {}} required {..e.control(f.label_preference).hint()}>
                        for (value, label) in preferences {
                            <option value={value} selected={v.label_preference == value}>{label}</option>
                        }
                    </select>
                </Field>
                <p class={Actions}><button type="submit" class={primary}>{t.save()}</button></p>
            </form>
        }
    }
}
