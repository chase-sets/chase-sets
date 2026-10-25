//! The cart page's parts, after marketplace's design-system ones: a line (`MarketplaceCartLineItem`),
//! the page's one notice (`CheckoutNoticeStack`), the totals (`CheckoutTotals`), the checkout bar
//! (`StickyCtaBar`) and the empty cart (`MarketplaceEmptyState`).
use corten::prelude::*;

use super::marketplace;
use crate::{
    api::segment,
    cart::{Line, Price, Reason, Seller},
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
fn options(summary: Option<&str>) -> Vec<&str> {
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

/// One line: its picture, item, badges, options, listing, seller and price, and its quantity.
#[component(css)]
pub fn CartItem<'a>(t: CartMsg, line: &'a Line) -> impl Render {
    let l = &line.line;
    let image = l.item_image_url.clone().unwrap_or_else(|| link(FALLBACK_IMAGE));
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
                    srcset={l.item_image_srcset.as_deref()}
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
                    Price::Exact(text) => { <p class={Price} data-price>{text}</p> }
                    Price::From(text) => { <p class={Price} data-price><span class={From}>{t.page_from()}</span> " " {text}</p> }
                    Price::Deferred => { <p class={Muted} data-price>{t.page_priced_at_checkout()}</p> }
                }
            </div>
            <div class={Foot}>
                <p class={Quantity}>
                    <span class={Label}>{t.page_quantity()}</span>
                    <span class={Count} data-quantity>{l.quantity}</span>
                </p>
                if !fulfillable {
                    <a class={Button} href={alternatives}>{t.page_find_alternatives()}</a>
                }
            </div>
        </li>
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

/// A link styled as a button, to a marketplace page: Keep shopping, and Check out and Use lower
/// price. marketplace's Check out and Use lower price are forms that post the readiness snapshot
/// and the optimization choice to its `/checkout/buy/readiness`, but a Corten page cannot send a
/// form to another origin (todd-skelton/corten#64). So Check out links to that page, which reads
/// the readiness again, and Use lower price to marketplace's own cart, where the offer is chosen.
/// Make them the forms again when that issue lands.
#[component(css = CartItem)]
pub fn CheckoutLink<'a>(href: &'a str, label: &'a str, primary: bool) -> impl Render {
    html! { <a class={(Button, primary.then_some(Primary))} href={href}>{label}</a> }
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
