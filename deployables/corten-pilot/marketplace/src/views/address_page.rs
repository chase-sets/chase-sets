//! The shipping addresses page (Identity's `ShippingAddressPage`): the header with Back to account,
//! what the last write did, the add form, and the saved addresses as cards, each with Update address
//! (its form in a dialog its button opens, `command="show-modal"`), Set default and Archive (a
//! dialog that asks first). A refused update draws its dialog open again, modal once it joins the
//! page (`corten_ui::dialog::modal`). An address the API suggests instead is a choice in the form:
//! two buttons that send it again, in a new attempt, with the choice.
use corten::{form::Within, prelude::*, view::AttrValue};

use crate::{
    addresses::{AddressInput, AddressScreen, Draft, Place, Said, Which},
    api::{AccountAction, ShippingAddress, SuggestedAddress},
    app::url,
    text::{AddressesMsg, Pilot},
};

/// The add form: a refused add draws it again.
#[derive(Id, Clone, Copy)]
pub struct AddFormId;

/// An address's update form.
#[derive(Id, Clone, Copy)]
pub struct AddressFormId<'a>(pub &'a str);

/// The dialog an address's Update address opens.
#[derive(Id)]
pub struct UpdateDialogId<'a>(pub &'a str);

/// The dialog an address's Archive opens.
#[derive(Id)]
pub struct ArchiveDialogId<'a>(pub &'a str);

/// The lines an address card shows (`addressLines`).
fn lines(address: &ShippingAddress) -> Vec<String> {
    let place = format!("{}, {} {}", address.city, address.state, address.postal_code);
    [
        Some(address.recipient_name.clone()),
        address.company.clone(),
        Some(address.line1.clone()),
        address.line2.clone(),
        Some(place),
        Some(address.country.clone()),
    ]
    .into_iter()
    .flatten()
    .filter(|line| !line.trim().is_empty())
    .collect()
}

/// An address as one line (the suggestion's, and what was entered).
fn one_line(parts: [Option<&str>; 6]) -> String {
    parts.into_iter().flatten().filter(|p| !p.trim().is_empty()).collect::<Vec<_>>().join(", ")
}

fn suggested_line(s: &SuggestedAddress) -> String {
    one_line([Some(&s.line1), s.line2.as_deref(), Some(&s.city), Some(&s.state), Some(&s.postal_code), Some(&s.country)])
}

fn entered_line(i: &AddressInput) -> String {
    one_line([Some(&i.line1), Some(&i.line2), Some(&i.city), Some(&i.state), Some(&i.postal_code), Some(&i.country)])
}

/// The page.
#[component(css)]
pub fn AddressPage<'a>(t: AddressesMsg, p: Pilot, screen: &'a AddressScreen) -> impl Render {
    let draft_for = |form: Which, fresh: AddressInput| match &screen.posted {
        Some((which, draft)) if *which == form => draft.clone(),
        _ => Draft::new(fresh),
    };
    let add = draft_for(Which::Create, AddressInput::blank());
    let cards: Vec<_> = screen
        .addresses
        .iter()
        .map(|address| {
            let which = Which::Update(address.shipping_address_id.clone());
            let open = matches!(&screen.posted, Some((posted, _)) if *posted == which);
            (address, draft_for(which, AddressInput::of(address)), open)
        })
        .collect();
    let back = url::AccountHome::default().href();
    let banner = match &screen.said {
        Said::Editing => None,
        Said::Saved => Some(("info", t.manage_state_succeeded())),
        Said::NotSaved => Some(("danger", t.manage_state_failed_safe())),
        Said::Conflict => Some(("warning", t.manage_state_conflict())),
        Said::Unconfirmed { .. } => Some(("warning", t.manage_state_ambiguous())),
        Said::Denied => Some(("danger", t.manage_state_route_denied())),
    };
    let again = match &screen.said {
        Said::Unconfirmed { attempt, action, target } => Some(
            url::ShippingAddresses {
                place: Place { check: Some(attempt.clone()), action: Some(*action), target: target.clone(), ..Place::default() },
            }
            .href(),
        ),
        _ => None,
    };
    let held = |action: AccountAction, target: Option<&str>| screen.said.holds(action, target);
    html! {
        <header class={Header}>
            <div class={Heading}>
                <p class={Eyebrow}>{t.page_account()}</p>
                <h1 class={Title}>{t.page_shipping_addresses()}</h1>
                <p class={Muted}>{t.page_manage_reusable_destinations()}</p>
            </div>
            <a class={(Button, Secondary)} href={&back}>{t.page_back_to_account()}</a>
        </header>
        <div class={Status} role="status" aria-live="polite">
            if let Some((tone, text)) = banner {
                <div class={Banner} data-tone={tone} tabindex="-1" autofocus>
                    <p class={Strong}>{text}</p>
                    if let Some(again) = &again {
                        <p><a href={again}>{p.addresses_check()}</a></p>
                    }
                </div>
            }
        </div>
        if screen.pending {
            <div class={Banner} data-tone="warning">
                <p class={Strong}>{t.page_address_issue()}</p>
                <p>{t.route_addresses_updating()}</p>
            </div>
        }
        <section class={Part} aria-labelledby="add-address-title">
            <h2 id="add-address-title" class={PartTitle}>{t.page_add_shipping_address()}</h2>
            <p class={Muted}>{t.page_add_description()}</p>
            <div class={Tinted}>
                <AddressForm
                    t={t}
                    p={p}
                    id={AddFormId}
                    action={url::ShippingAddresses::default()}
                    draft={&add}
                    create
                    held={held(AccountAction::Create, None)}
                />
            </div>
        </section>
        <section class={Part} aria-labelledby="saved-addresses-title">
            <h2 id="saved-addresses-title" class={PartTitle}>{t.page_saved_addresses()}</h2>
            <p class={Muted}>{t.page_saved_description()}</p>
            if cards.is_empty() && !screen.pending {
                <div class={Empty}>
                    <p class={Strong}>{t.page_no_saved_addresses()}</p>
                    <p class={Muted}>{t.page_no_saved_addresses_description()}</p>
                </div>
            } else {
                <ul class={List}>
                    for (address, update, open) in &cards {
                        <AddressCard t={t} p={p} address={address} update={update} open={*open} said={&screen.said} />
                    }
                </ul>
            }
        </section>
    }
}

/// How an input takes its text.
#[derive(Clone, Copy)]
enum Kind {
    Text,
    Email,
    Tel,
}

/// A labelled input, its error next to it.
#[component(css = AddressPage)]
fn Field<'a, I: Id>(
    label: &'a str,
    name: FieldName<String>,
    value: &'a str,
    kind: Kind,
    auto: &'a str,
    required: bool,
    errors: &'a Within<'a, I>,
) -> impl Render {
    let kind = match kind {
        Kind::Text => "text",
        Kind::Email => "email",
        Kind::Tel => "tel",
    };
    html! {
        <div class={Field}>
            <label class={Field}>
                <span class={Label}>{label}</span>
                <input type={kind} name={name} value={value} autocomplete={auto} required={required} {..errors.aria(name)}>
            </label>
            {errors.message(name)}
        </div>
    }
}

/// The add form or an address's update form: its fields, then Save address or Update address, or,
/// when the API suggested another address, the choice between the two.
#[component(css = AddressPage)]
fn AddressForm<'a, I: Id + Copy + AttrValue, A: AttrValue>(
    t: AddressesMsg,
    p: Pilot,
    id: I,
    action: A,
    draft: &'a Draft,
    create: bool,
    held: bool,
) -> impl Render {
    let f = AddressInput::FIELDS;
    let (i, e) = (&draft.input, draft.errors.within(id));
    let default = i.make_default == "true";
    html! {
        <form id={id} class={Form} method="post" action={action}>
            {SubmitKey::field(f.attempt)}
            {draft.errors.form_message()}
            <fieldset class={Controls} disabled={held}>
                <div class={Grid}>
                    <Field
                        label={t.page_label()}
                        name={f.label}
                        value={&i.label}
                        kind={Kind::Text}
                        auto="off"
                        required={false}
                        errors={&e}
                    />
                    <Field
                        label={t.page_recipient_name()}
                        name={f.name}
                        value={&i.name}
                        kind={Kind::Text}
                        auto="name"
                        required
                        errors={&e}
                    />
                    <Field
                        label={t.page_company()}
                        name={f.company}
                        value={&i.company}
                        kind={Kind::Text}
                        auto="organization"
                        required={false}
                        errors={&e}
                    />
                    <Field
                        label={t.page_country()}
                        name={f.country}
                        value={&i.country}
                        kind={Kind::Text}
                        auto="country"
                        required
                        errors={&e}
                    />
                    <Field
                        label={t.page_address_line1()}
                        name={f.line1}
                        value={&i.line1}
                        kind={Kind::Text}
                        auto="address-line1"
                        required
                        errors={&e}
                    />
                    <Field
                        label={t.page_address_line2()}
                        name={f.line2}
                        value={&i.line2}
                        kind={Kind::Text}
                        auto="address-line2"
                        required={false}
                        errors={&e}
                    />
                    <Field
                        label={t.page_city()}
                        name={f.city}
                        value={&i.city}
                        kind={Kind::Text}
                        auto="address-level2"
                        required
                        errors={&e}
                    />
                    <Field
                        label={t.page_state()}
                        name={f.state}
                        value={&i.state}
                        kind={Kind::Text}
                        auto="address-level1"
                        required
                        errors={&e}
                    />
                    <Field
                        label={t.page_postal_code()}
                        name={f.postal_code}
                        value={&i.postal_code}
                        kind={Kind::Text}
                        auto="postal-code"
                        required
                        errors={&e}
                    />
                    <Field
                        label={t.page_phone()}
                        name={f.phone}
                        value={&i.phone}
                        kind={Kind::Tel}
                        auto="tel"
                        required={false}
                        errors={&e}
                    />
                    <Field
                        label={t.page_email()}
                        name={f.email}
                        value={&i.email}
                        kind={Kind::Email}
                        auto="email"
                        required={false}
                        errors={&e}
                    />
                    <div class={Field}>
                        <label class={Field}>
                            <span class={Label}>{t.page_default()}</span>
                            <select name={f.make_default}>
                                <option value="false" selected={!default}>{t.page_keep_default()}</option>
                                <option value="true" selected={default}>{t.page_make_default()}</option>
                            </select>
                        </label>
                    </div>
                </div>
                if let Some(suggested) = &draft.suggested {
                    <div class={Choice} role="group" aria-label={t.manage_address_choice()}>
                        <p class={Strong}>{t.manage_address_choice()}</p>
                        <p><span class={Strong}>{p.addresses_suggested()}</span>" "{suggested_line(suggested)}</p>
                        <p><span class={Strong}>{p.addresses_entered()}</span>" "{entered_line(i)}</p>
                        <div class={Actions}>
                            <button type="submit" name={f.decision} value="accept-suggested">
                                {t.manage_accept_suggested()}
                            </button>
                            <button type="submit" class={Secondary} name={f.decision} value="keep-original">
                                {t.manage_keep_original()}
                            </button>
                        </div>
                    </div>
                } else {
                    <div class={Actions}>
                        if create {
                            <button type="submit">{t.page_save_address()}</button>
                        } else {
                            <button type="submit" class={Secondary}>{t.page_update_address()}</button>
                        }
                    </div>
                }
            </fieldset>
        </form>
    }
}

/// One saved address: its label, Default, its lines, and its three actions.
#[component(css = AddressPage)]
fn AddressCard<'a>(
    t: AddressesMsg,
    p: Pilot,
    address: &'a ShippingAddress,
    update: &'a Draft,
    open: bool,
    said: &'a Said,
) -> impl Render {
    let id = address.shipping_address_id.as_str();
    let title = address.label.as_deref().filter(|l| !l.trim().is_empty()).unwrap_or(&address.recipient_name);
    let (update_title, archive_title, archive_text) =
        (format!("address-{id}-update-title"), format!("address-{id}-archive-title"), format!("address-{id}-archive-text"));
    let attempt = AddressInput::FIELDS.attempt;
    html! {
        <li class={Card}>
            <div class={CardHead}>
                <p class={Strong}>{title}</p>
                if address.is_default {
                    <span class={Badge}>{t.page_default_badge()}</span>
                }
            </div>
            <address class={Lines}>
                for line in lines(address) {
                    <span>{line}</span>
                }
            </address>
            <div class={Actions}>
                <button type="button" class={Secondary} command="show-modal" commandfor={UpdateDialogId(id)}>
                    {t.page_update_address()}
                </button>
                if !address.is_default {
                    <form method="post" action={url::AddressDefault { id }}>
                        {SubmitKey::field(attempt)}
                        <button type="submit" class={Secondary} disabled={said.holds(AccountAction::Default, Some(id))}>
                            {t.page_set_default()}
                        </button>
                    </form>
                }
                <button type="button" class={Danger} command="show-modal" commandfor={ArchiveDialogId(id)}>
                    {t.page_archive()}
                </button>
            </div>
            <dialog
                id={UpdateDialogId(id)}
                class={Dialog}
                aria-labelledby={&update_title}
                open={open}
                on:connect={corten_ui::dialog::modal(target)}
            >
                <div class={DialogHead}>
                    <h3 id={&update_title} class={PartTitle}>{t.page_update_address()}</h3>
                    <button type="button" class={Ghost} command="close" commandfor={UpdateDialogId(id)}>
                        {p.addresses_close()}
                    </button>
                </div>
                <p class={Muted}>{t.page_saved_description()}</p>
                <AddressForm
                    t={t}
                    p={p}
                    id={AddressFormId(id)}
                    action={url::AddressUpdate { id }}
                    draft={update}
                    create={false}
                    held={said.holds(AccountAction::Update, Some(id))}
                />
            </dialog>
            <dialog id={ArchiveDialogId(id)} class={Dialog} aria-labelledby={&archive_title} aria-describedby={&archive_text}>
                <h3 id={&archive_title} class={PartTitle}>{t.page_archive()}</h3>
                <p id={&archive_text} class={Muted}>{t.page_archive_confirm_description()}</p>
                <form class={Actions} method="post" action={url::AddressArchive { id }}>
                    {SubmitKey::field(attempt)}
                    <button type="button" class={Secondary} command="close" commandfor={ArchiveDialogId(id)}>
                        {p.addresses_cancel()}
                    </button>
                    <button type="submit" class={Danger} disabled={said.holds(AccountAction::Archive, Some(id))}>
                        {t.page_archive()}
                    </button>
                </form>
            </dialog>
        </li>
    }
}
