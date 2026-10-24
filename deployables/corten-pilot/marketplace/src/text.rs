//! The screen's text. `Msg` is the Inventory context's own catalog for the screen (exported from
//! contracts/localization by scripts/export.mjs, so the copy cannot drift); `Pilot` is the pilot's
//! shell, input checks and the route's own messages. `messages!` checks every call against the
//! catalogs when the crate compiles.
pub use inventory::Msg;
pub use pilot::Pilot;

mod inventory {
    corten::i18n::messages! {
        pub struct Msg { "en" => "locales/en.json" }
    }
}

mod pilot {
    corten::i18n::messages! {
        pub struct Pilot { "en" => "locales/pilot.en.json" }
    }
}
