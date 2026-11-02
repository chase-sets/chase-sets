//! What the layout shows beside the page that needs a read of its own: the cart's count on the
//! nav's Buy Cart entry (marketplace's root loader, `resolveCartCount`).
//!
//! The count is started as the request arrives (`Chrome`, an extractor every page that draws the
//! layout takes), so a full load reads it beside the page's own reads and waits for the longer of
//! the two. It is read only when the layout is drawn: a client navigation or a `data-patch`
//! answer keeps the header the full load drew, so they start nothing. A page without JavaScript
//! has the count in its HTML.
use std::{convert::Infallible, sync::Mutex};

use corten::{
    Ahead, Mode,
    axum::{
        extract::FromRequestParts,
        http::{HeaderMap, Uri, request::Parts},
    },
};

use crate::{
    api::Checkout as _,
    app::Shared,
    auth::{Found, Lookup, after_write},
    cart::anonymous_cart,
};

/// The item page's parameter after Add to cart: the add's receipt (`items::After::added`).
const ADDED: &str = "added";

/// The layout's own reads, started for a request that draws it. A handler lends it to whatever
/// draws the page, and each branch that draws the layout awaits it there. Corten has no read the
/// app starts once for the layout, nor an `Ahead` awaited from several branches, so every handler
/// takes this and the cell keeps the one answer (todd-skelton/corten#580).
pub struct Chrome {
    cart: Mutex<Option<Ahead<Option<u64>>>>,
    read: tokio::sync::OnceCell<Option<u64>>,
}

impl Chrome {
    fn new(cart: Ahead<Option<u64>>) -> Chrome {
        Chrome { cart: Mutex::new(Some(cart)), read: tokio::sync::OnceCell::new() }
    }

    /// The cart's count, for the layout: `None` when the layout is not drawn. Awaited once; a
    /// second draw (a refused form drawn after a failed one) has the same count.
    pub async fn cart(&self) -> Option<u64> {
        *self
            .read
            .get_or_init(|| async {
                let started = self.cart.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
                match started {
                    Some(started) => started.await,
                    None => None,
                }
            })
            .await
    }
}

impl FromRequestParts<Shared> for Chrome {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, config: &Shared) -> Result<Self, Infallible> {
        // The runtime keeps the header for a navigation and a `data-patch` answer.
        if Mode::of(&parts.headers).swaps() {
            return Ok(Chrome::new(Ahead::ready(None)));
        }
        let (lookup, headers, uri, config) = (Lookup::kept(parts), parts.headers.clone(), parts.uri.clone(), config.clone());
        Ok(Chrome::new(Ahead::start(async move { Some(count(&lookup, &headers, &uri, &config).await) })))
    }
}

/// The cart's item count (`resolveCartCount`): an account's cart, or for a visitor or a guest
/// checkout the guest cart the browser carries; 0 when there is none or it cannot be read. Read
/// after the write the address names, as the page is, and as it stands if that read fails: a
/// page's own write (`after_write`), or the item page's Add to cart (`added`), so the count after
/// an add has the line the add put in.
async fn count(lookup: &Lookup, headers: &HeaderMap, uri: &Uri, config: &Shared) -> u64 {
    let account = matches!(lookup.found(headers, uri, config).await, Found::Account(viewer) if !viewer.guest());
    let read = |receipt| async move {
        let caller = config.platform.caller(headers, config.proto, receipt);
        if account { caller.cart().await } else { caller.guest_cart(anonymous_cart(headers)).await }
    };
    let receipt = after_write(uri).or_else(|| crate::auth::receipt_named(uri, ADDED));
    let read = match receipt.as_ref() {
        Some(receipt) => match read(Some(receipt)).await {
            Ok(cart) => Ok(cart),
            Err(_) => read(None).await,
        },
        None => read(None).await,
    };
    read.map_or_else(
        |error| {
            tracing::warn!("the cart count was not read: {error}");
            0
        },
        |cart| cart.count,
    )
}
