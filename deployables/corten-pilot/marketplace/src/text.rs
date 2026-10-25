//! The screens' text. `Msg` (storage locations) and `Restock` (restock decisions) are the
//! Inventory context's own catalogs for each screen (exported from contracts/localization by
//! scripts/export.mjs, so the copy cannot drift); `Pilot` is the pilot's shell, input checks and
//! the routes' own messages. `messages!` checks every call against the catalogs when the crate
//! compiles.
pub use inventory::Msg;
pub use pilot::Pilot;
pub use restock::Restock;

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

mod pilot {
    corten::i18n::messages! {
        pub struct Pilot { "en" => "locales/pilot.en.json" }
    }
}
