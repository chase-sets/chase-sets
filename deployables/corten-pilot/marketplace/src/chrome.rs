//! What the layout shows beside the page that needs a read of its own: the cart's count on the
//! nav's Buy Cart entry (marketplace's root loader, `resolveCartCount`).
//!
//! `CartCount` is the app's one layout read (`App::layout_read`). Corten starts it beside the
//! page's own reads for a whole document (a first load, a reload, the page a write redirects to)
//! and draws its view where the shell put `later::<CartCount>()` (`views::market_nav`), so no
//! handler takes or passes it. A client navigation or a `data-patch` answer keeps the header, so
//! nothing is started for them. A page without JavaScript has the count in its HTML. The cart page
//! reads the cart itself and gives the count it found (`cart::render`), so its `GET` starts none.
use std::future::Future;

use corten::{LayoutRead, axum::http::request::Parts, prelude::*};

use crate::{
    api::Checkout as _,
    app::{Shared, url},
    auth::{Found, after_write},
    cart::anonymous_cart,
    views::CartBadge,
};

/// The item page's parameter after Add to cart: the add's receipt (`items::After::added`).
const ADDED: &str = "added";

/// The cart's count in the shell: `None` while the cart page's own read is still catching up
/// with a write (drawn as the badge at 0), and nothing at all where the read was not drawn (it
/// failed, or the page is the same for everyone), which hides a visitor's cart entry.
pub struct CartCount(pub Shared);

impl LayoutRead for CartCount {
    type Value = Option<u64>;

    fn start(&self, parts: &Parts) -> Option<impl Future<Output = Option<u64>> + Send + 'static> {
        // The cart page gives the count its own read found.
        if parts.uri.path() == url::Cart::default().href() {
            return None;
        }
        let (config, head) = (self.0.clone(), parts.clone());
        Some(async move { Some(count(&head, &config).await) })
    }

    fn view(count: &Option<u64>) -> impl Render + '_ {
        html! { <CartBadge count={*count} /> }
    }
}

/// The cart's item count (`resolveCartCount`): an account's cart, or for a visitor or a guest
/// checkout the guest cart the browser carries; 0 when there is none or it cannot be read. Read
/// after the write the address names, as the page is, and as it stands if that read fails: a
/// page's own write (`after_write`), or the item page's Add to cart (`added`), so the count after
/// an add has the line the add put in.
async fn count(head: &Parts, config: &Shared) -> u64 {
    let (headers, uri) = (&head.headers, &head.uri);
    let account = matches!(crate::auth::find(head, config).await, Found::Account(viewer) if !viewer.guest());
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
