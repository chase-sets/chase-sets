//! The screens' text. `Msg` (storage locations) and `Restock` (restock decisions) are the
//! Inventory context's own catalogs for each screen, `ItemMsg` the Discovery context's item page's,
//! `SearchMsg` the Discovery context's search page's, and `CartMsg` the Checkout context's cart page's (exported from contracts/localization by
//! scripts/export.mjs, so the copy cannot drift); `Pilot` is the pilot's shell, input checks and
//! the routes' own messages. `messages!` checks every call against the catalogs when the crate
//! compiles.
pub use cart::CartMsg;
pub use inventory::Msg;
pub use item::ItemMsg;
pub use pilot::Pilot;
pub use restock::Restock;
pub use search::SearchMsg;

mod inventory {
    corten::i18n::messages! {
        pub struct Msg { "en" => "locales/en.json" }
    }
}

mod restock {
    corten::i18n::messages! {
        pub struct Restock { "en" => "locales/restock.en.json" }
    }
}

mod cart {
    corten::i18n::messages! {
        pub struct CartMsg { "en" => "locales/cart.en.json" }
    }
}

mod item {
    corten::i18n::messages! {
        pub struct ItemMsg { "en" => "locales/item.en.json" }
    }
}

mod search {
    corten::i18n::messages! {
        pub struct SearchMsg { "en" => "locales/search.en.json" }
    }
}

mod pilot {
    corten::i18n::messages! {
        pub struct Pilot { "en" => "locales/pilot.en.json" }
    }
}
