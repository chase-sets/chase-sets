//! The cart page's parts, after marketplace's design-system ones: a line (`MarketplaceCartLineItem`),
//! the page's one notice (`CheckoutNoticeStack`), the totals (`CheckoutTotals`), the checkout bar
//! (`StickyCtaBar`) and the empty cart (`MarketplaceEmptyState`).
use corten::{prelude::*, view::AttrValue};

use super::{marketplace, on_marketplace, srcset_on_marketplace};
use crate::{
    api::{Snapshot, segment},
    app::url,
    cart::{AttemptNotice, CheckoutInput, Line, LineInput, Price, Reason, Seller, Write},
    cart_attempt::State,
    text::CartMsg,
};

/// What a line without an image shows (marketplace's `CART_ITEM_FALLBACK_IMAGE_URL`, on its origin).
const FALLBACK_IMAGE: &str = "/fake-cdn/assets/pokemon-card-back.png";
/// A marketplace page's address, or none when the origin is not a URL.
pub fn link(path: &str) -> String {
    marketplace(path).map(|u| u.to_string()).unwrap_or_default()
}

/// The option values a product summary names (`productOptionsFromSummary`): "Form: Raw |
/// Condition: Excellent" is Raw and Excellent.
pub(crate) fn options(summary: Option<&str>) -> Vec<&str> {
    let Some(summary) = summary else { return Vec::new() };
    summary
        .split(['|', '/', ',', '\u{2022}'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|segment| match segment.split_once(':') {
            Some((_, value)) if !value.trim().is_empty() => value.trim(),
            _ => segment,
        })
        .collect()
}

/// A language code's label (`formatLanguageCodeLabel`): English, Japanese, or the code.
fn language(t: CartMsg, code: &str) -> &str {
    match code.trim().to_ascii_lowercase().as_str() {
        "en" => t.language_en(),
        "ja" => t.language_ja(),
        _ => code.trim(),
    }
}

/// An amount the API sent, in the request's locale (`formatMoney`), or `<amount> <CODE>` when it
/// is not money.
pub fn money(t: CartMsg, amount: &str, currency: &str) -> String {
    match (platform::money::decimal(amount), corten::i18n::Currency::parse(currency.trim())) {
        (Some(amount), Some(currency)) => t.money(amount, currency).to_string(),
        _ => format!("{amount} {}", currency.trim().to_ascii_uppercase()).trim().to_owned(),
    }
}

/// A line's badge: what it needs, in marketplace's words.
fn reason(t: CartMsg, reason: Reason) -> &'static str {
    match reason {
        Reason::Ready => t.page_ready(),
        Reason::UnassignedFulfillment => t.page_needs_fulfillment(),
        Reason::Unavailable => t.page_unavailable(),
        Reason::WaitingForSupply => t.page_waiting_for_supply(),
        Reason::ShippingMeasureMissing => t.page_shipping_measure_missing(),
        Reason::Changed | Reason::CurrencyMismatch | Reason::Other => t.page_needs_review(),
    }
}

/// The items' heading and what to do with them (`PageSection`'s title and description).
#[component(css = CartItem)]
pub fn CartHeading<'a>(title: &'a str, description: &'a str) -> impl Render {
    html! {
        <div class={Section}>
            <h2 class={SectionTitle}>{title}</h2>
            <p class={Muted}>{description}</p>
        </div>
    }
}

/// The notice, the lines, the totals and the bar, spaced as one stack.
#[component(css = CartItem)]
pub fn CartStack<C: Render>(children: C) -> impl Render {
    html! { <div class={Stack}>{children}</div> }
}

/// The cart's lines, one card each.
#[component(css = CartItem)]
pub fn CartList<C: Render>(children: C) -> impl Render {
    html! { <ul class={List}>{children}</ul> }
}

/// One line: its picture, item, badges, options, listing, seller and price, its quantity and its
/// writes. `paused` turns the writes off while one is not known to have applied.
#[component(css)]
pub fn CartItem<'a>(t: CartMsg, line: &'a Line, paused: bool) -> impl Render {
    let l = &line.line;
    // The line keeps the picture as the add sent it, a card back's site-relative to marketplace.
    let image = on_marketplace(l.item_image_url.as_deref().unwrap_or(FALLBACK_IMAGE));
    let srcset = l.item_image_srcset.as_deref().map(srcset_on_marketplace);
    let options = options(l.product_summary.as_deref());
    let ready = line.reason.is_none_or(|r| r == Reason::Ready);
    let fulfillable = line.reason.is_none_or(Reason::fulfillable);
    let alternatives = link(&format!("/search?q={}", segment(&l.item_title)));
    let locked = (l.fulfillment_mode == "locked-listing").then_some(l.locked_listing_id.as_deref()).flatten();
    let preferred = if locked.is_none() { l.seller_preference_id.as_deref() } else { None };
    let seller = line.seller();
    html! {
        <li class={CartItem} data-cart-line={&l.line_id}>
            <div class={Thumb}>
                <img
                    src={image}
                    srcset={srcset.as_deref()}
                    sizes="6rem"
                    alt={t.page_product_image_alt(&l.item_title)}
                    loading="lazy"
                    decoding="async"
                >
            </div>
            <div class={Body}>
                <div class={Heading}>
                    <p class={Title}>{&l.item_title}</p>
                    if let Some(subtitle) = &l.item_subtitle {
                        <p class={Subtitle}>{subtitle}</p>
                    }
                </div>
                <div class={Badges}>
                    if let Some(code) = l.item_language_code.as_deref().filter(|c| !c.trim().is_empty()) {
                        <span class={(Pill, Neutral)}>{language(t, code)}</span>
                    }
                    if let Some(r) = line.reason {
                        <span class={(Pill, ready.then_some(Success), (!ready).then_some(Warning))} data-reason>
                            {reason(t, r)}
                        </span>
                    }
                </div>
                if options.is_empty() {
                    <p class={Badges}><span class={(Pill, Neutral)}>{t.page_standard()}</span></p>
                } else {
                    <ul class={Chips}>
                        for option in &options {
                            <li class={Chip}>{*option}</li>
                        }
                    </ul>
                }
                if let Some(id) = locked {
                    <p class={Muted}>{t.page_locked_listing_summary(line.listing_label(id, t.page_selected_listing()))}</p>
                } else if let Some(id) = preferred {
                    <p class={Badges}><span class={(Pill, Neutral)}>{t.page_preferred_listing()}</span></p>
                    <p class={Muted}>{t.page_preferred_listing_summary(line.listing_label(id, t.page_selected_listing()))}</p>
                }
                if let Some(seller) = &seller {
                    <Reputation t={t} seller={seller} />
                }
                match &line.price {
                    Price::Exact { amount, currency } => { <p class={Price} data-price>{money(t, amount, currency)}</p> }
                    Price::From { amount, currency } => {
                        <p class={Price} data-price><span class={From}>{t.page_from()}</span> " " {money(t, amount, currency)}</p>
                    }
                    Price::Deferred => { <p class={Muted} data-price>{t.page_priced_at_checkout()}</p> }
                }
            </div>
            <div class={Foot}>
                <LineForm action={url::CartQuantity} line={line} paused={paused} label={t.page_quantity()}>
                    <input type="hidden" name={LineInput::FIELDS.quantity} value={l.quantity}>
                    <button
                        type="submit"
                        class={(Button, Step)}
                        name={LineInput::FIELDS.delta}
                        value="-1"
                        aria-label={t.page_decrease()}
                        disabled={l.quantity <= 1}
                    >
                        "\u{2212}"
                    </button>
                    <span class={Count} data-quantity>{l.quantity}</span>
                    <button
                        type="submit"
                        class={(Button, Step)}
                        name={LineInput::FIELDS.delta}
                        value="1"
                        aria-label={t.page_increase()}
                    >
                        "+"
                    </button>
                </LineForm>
                <div class={Actions}>
                    <LineForm action={url::CartRemove} line={line} paused={paused} label="">
                        <button type="submit" class={Button} data-write="remove">{t.page_remove()}</button>
                    </LineForm>
                    if let Some(preference) = preferred {
                        <LineForm action={url::CartLock} line={line} paused={paused} label="">
                            <input type="hidden" name={LineInput::FIELDS.preference} value={preference}>
                            <button type="submit" class={Button} data-write="lock">{t.page_lock_this_listing()}</button>
                        </LineForm>
                    }
                    if !fulfillable {
                        <a class={Button} href={alternatives}>{t.page_find_alternatives()}</a>
                    }
                </div>
            </div>
        </li>
    }
}

/// A line write's form: a new attempt (`SubmitKey`), every line merged into the one shown, and
/// the controls, off while `paused`. A `data-patch` form: the runtime posts it and follows the
/// redirect to the cart, read after the write, in place (and reads it again while it is behind);
/// without the script the browser does the same. `label` names the controls when it is set.
#[component(css = CartItem)]
pub fn LineForm<'a, A: AttrValue, C: Render>(
    action: A,
    line: &'a Line,
    paused: bool,
    label: &'a str,
    children: C,
) -> impl Render {
    let f = LineInput::FIELDS;
    html! {
        <form class={(Post, (!label.is_empty()).then_some(Quantity))} method="post" action={action} data-patch>
            {SubmitKey::field(f.attempt)}
            for id in &line.line_ids {
                <input type="hidden" name={f.line_id} value={id}>
            }
            if !label.is_empty() {
                <span class={Label}>{label}</span>
            }
            <fieldset class={(Controls, (!label.is_empty()).then_some(Stepper))} disabled={paused}>{children}</fieldset>
        </form>
    }
}

/// A line write that did not fully apply (the cart page's attempt notice): what happened, the
/// lines not updated, and for a write not known to have applied, Send the same change again (the
/// same attempt, so it cannot apply twice) and Refresh cart.
#[component(css = CartItem)]
pub fn AttemptBanner<'a>(t: CartMsg, notice: &'a AttemptNotice) -> impl Render {
    let (title, description) = match notice.state {
        State::Partial => (t.page_attempt_partial_title(), t.page_attempt_partial_description()),
        State::Ambiguous => (t.page_attempt_ambiguous_title(), t.page_attempt_ambiguous_description()),
        State::FailedSafe | State::Succeeded => {
            (t.page_attempt_failed_safe_title(), notice.message.as_deref().unwrap_or(t.page_attempt_failed_safe_description()))
        }
    };
    let lines = if notice.state == State::Partial { notice.not_applied.as_slice() } else { &[] };
    let f = LineInput::FIELDS;
    let refresh = url::Cart::default().href();
    html! {
        <section class={(Notice, Attention)} aria-labelledby="cart-attempt" data-attempt={notice.state.as_str()}>
            <h2 class={NoticeTitle} id="cart-attempt" tabindex="-1" autofocus>{title}</h2>
            <p role="status">{description}</p>
            if !lines.is_empty() {
                <ul class={NotApplied}>
                    for message in lines {
                        <li>{message.as_deref().unwrap_or(t.page_attempt_line_not_applied())}</li>
                    }
                </ul>
            }
            if let Some((write, input)) = &notice.resend {
                <div class={Resend}>
                    <form class={Post} method="post" action={write_action(*write)} data-patch>
                        <input type="hidden" name={f.attempt} value={&input.attempt}>
                        for id in &input.line_id {
                            <input type="hidden" name={f.line_id} value={id}>
                        }
                        <input type="hidden" name={f.quantity} value={&input.quantity}>
                        <input type="hidden" name={f.delta} value={&input.delta}>
                        <input type="hidden" name={f.preference} value={&input.preference}>
                        <button type="submit" class={Button}>{t.page_attempt_resend()}</button>
                    </form>
                    <a class={Button} href={&refresh}>{t.page_refresh_cart()}</a>
                </div>
            }
        </section>
    }
}

/// Where a line write posts.
fn write_action(write: Write) -> String {
    match write {
        Write::Quantity => url::CartQuantity.href(),
        Write::Remove => url::CartRemove.href(),
        Write::Lock => url::CartLock.href(),
    }
}

/// A seller and its reviews (`AccountReputationSummary`): the rating and count, or "No reviews
/// yet".
#[component(css = CartItem)]
pub fn Reputation<'a>(t: CartMsg, seller: &'a Seller<'a>) -> impl Render {
    html! {
        <p class={Seller}>
            <span class={Name}>{seller.name}</span>
            match seller.rating {
                Some((rating, count)) => {
                    <span class={Rating} aria-label={t.page_seller_reputation_label()}>
                        <span aria-hidden="true">"\u{2605}"</span> " "
                        <strong>{format!("{rating:.1}")}</strong> " " {format!("({count})")}
                    </span>
                }
                None => { <span class={Rating}>{t.page_seller_reputation_empty()}</span> }
            }
        </p>
    }
}

/// The page's one notice (`CheckoutNoticeStack`): what needs attention, or the lower-price offer.
#[component(css = CartItem)]
pub fn CartNotice<'a, C: Render>(title: &'a str, warning: bool, children: C) -> impl Render {
    html! {
        <div class={(Notice, warning.then_some(Attention))} role="note">
            <p class={NoticeTitle}>{title}</p>
            {children}
        </div>
    }
}

/// Why checkout did not start (the cart page's "Checkout issue"): the API's reason.
#[component(css = CartItem)]
pub fn CartIssue<'a>(title: &'a str, text: &'a str) -> impl Render {
    html! {
        <div class={(Notice, Danger)} role="alert">
            <p class={NoticeTitle}>{title}</p>
            <p>{text}</p>
        </div>
    }
}

/// The items, shipping and the estimated total (`CheckoutTotals`).
#[component(css = CartItem)]
pub fn CartTotals<'a>(t: CartMsg, items: u64, total: &'a str, known: bool) -> impl Render {
    html! {
        <dl class={Totals}>
            <div class={Row}>
                <dt>{t.page_items()}</dt>
                <dd data-items>{items}</dd>
            </div>
            <div class={Row}>
                <dt class={Muted}>{t.page_shipping_and_tax()}</dt>
                <dd>{t.page_calculated_at_checkout()}</dd>
            </div>
            <div class={Total}>
                <dt>{t.page_estimated_total()}</dt>
                <dd class={(known.then_some(Amount), (!known).then_some(Quiet))} data-total>{total}</dd>
                <p class={Caption}>{t.page_final_total_confirmed()}</p>
            </div>
        </dl>
    }
}

/// The checkout bar (`StickyCtaBar`): the total, what checkout will add, and the actions.
#[component(css = CartItem)]
pub fn CheckoutBar<'a, A: Render, B: Render>(
    t: CartMsg,
    total: &'a str,
    context: &'a str,
    primary: A,
    secondary: B,
) -> impl Render {
    html! {
        <section class={Bar} aria-label={t.page_check_out()}>
            <div class={BarTotal}>
                <p class={Label}>{t.page_estimated_total()}</p>
                <p class={BarAmount}>{total}</p>
                <p class={Muted}>{context}</p>
                <p class={Secure}>{t.page_no_payment_until_checkout()}</p>
            </div>
            <div class={BarActions}>
                <div class={BarSecondary}>{secondary}</div>
                {primary}
            </div>
        </section>
    }
}

/// A link styled as a button, to a marketplace page: Keep shopping, and Continue to checkout for a
/// cart that is not ready (marketplace's `LinkButton`s).
#[component(css = CartItem)]
pub fn CheckoutLink<'a>(href: &'a str, label: &'a str, primary: bool) -> impl Render {
    html! { <a class={(Button, primary.then_some(Primary))} href={href}>{label}</a> }
}

/// Check out, or Use lower price (marketplace's `CheckoutForm`): posts the offer's decision as
/// `snapshot` was read with it. The pilot starts the checkout session and the browser follows the
/// redirect to marketplace's checkout, which the app's policy allows (`form_action`). A plain
/// form, so the browser leaves the page whether or not the script runs.
#[component(css = CartItem)]
pub fn CheckoutForm<'a>(snapshot: &'a Snapshot, label: &'a str, primary: bool) -> impl Render {
    let input = CheckoutInput::of(snapshot);
    let f = CheckoutInput::FIELDS;
    html! {
        <form class={Post} method="post" action={url::CartCheckout}>
            <input type="hidden" name={f.offer} value={&input.offer}>
            <input type="hidden" name={f.line} value={&input.line}>
            <input type="hidden" name={f.listing} value={&input.listing}>
            <button type="submit" class={(Button, primary.then_some(Primary))}>{label}</button>
        </form>
    }
}

/// No line in the cart (`MarketplaceEmptyState` with its trust cue).
#[component(css = CartItem)]
pub fn EmptyCart(t: CartMsg) -> impl Render {
    html! {
        <div class={Empty}>
            <p class={NoticeTitle}>{t.page_your_cart_is_empty()}</p>
            <p class={Muted}>{t.page_browse_the_marketplace_and_add_a()}</p>
            <div class={Cue}>
                <p class={NoticeTitle}>{t.page_empty_cart_protection_title()}</p>
                <p class={Muted}>{t.page_empty_cart_protection_description()}</p>
            </div>
            <p><CheckoutLink href={&link("/search")} label={t.page_keep_shopping()} primary /></p>
        </div>
    }
}

#[cfg(test)]
mod tests {
    /// Corten writes money as Chase Sets' `formatMoney` does in `en`: its own cases
    /// (contracts/localization/money.test.ts), and Intl's forms for other currencies.
    #[test]
    fn money_is_written_as_chase_sets_writes_it() {
        use corten::i18n::Messages as _;
        let t = crate::text::CartMsg::for_locale("en");
        let money = |amount: &str, currency: &str| super::money(t, amount, currency);
        assert_eq!(money("145.00", "USD"), "$145.00");
        assert_eq!(money("12.34", "usd"), "$12.34");
        assert_eq!(money("12.3", "USD"), "$12.30");
        assert_eq!(money("12", "USD"), "$12.00");
        assert_eq!(money("1234567.89", "USD"), "$1,234,567.89");
        assert_eq!(money("-42.50", "USD"), "-$42.50");
        assert_eq!(money("0.00", "USD"), "$0.00");
        assert_eq!(money("9999999999.99", "USD"), "$9,999,999,999.99");
        assert_eq!(money("pending", "USD"), "pending USD");
        assert_eq!(money("1234.5", "EUR"), "\u{20ac}1,234.50");
        assert_eq!(money("1234.5", "CAD"), "CA$1,234.50");
        assert_eq!(money("1234.5", "CHF"), "CHF\u{a0}1,234.50");
    }
}
