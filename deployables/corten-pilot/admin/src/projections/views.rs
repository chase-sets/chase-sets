//! The console's views. Each component's stylesheet (and the sheet's script) is next to it in
//! `views/`; together they are the area's stylesheet.
use corten::Component;

mod console_page;
mod detail_sheet;
mod reference_page;

pub use console_page::{ConsolePage, Pill, live_parts};
pub use detail_sheet::detail_sheet;
pub use reference_page::ReferencePage;

/// The area's components: its stylesheet and the sheet's script. Its live status is the app's
/// (`views::LIVE`).
pub const COMPONENTS: &[Component] = &[ConsolePage, ReferencePage, detail_sheet::DetailSheet, corten_ui::dialog::COMPONENT];

pub mod ids {
    use corten::prelude::*;

    /// The element that follows the running operations.
    #[derive(Id, Clone, Copy)]
    pub struct ProjectionsLiveId;
    pub const LIVE: ProjectionsLiveId = ProjectionsLiveId;

    /// The console's health: its status, attention items and counts.
    #[derive(Id, Clone, Copy)]
    pub struct ProjectionsHealthId;
    pub const HEALTH: ProjectionsHealthId = ProjectionsHealthId;

    #[derive(Id, Clone, Copy)]
    pub struct ProjectionsRepairId;
    pub const REPAIR: ProjectionsRepairId = ProjectionsRepairId;

    #[derive(Id, Clone, Copy)]
    pub struct ProjectionsOperationsId;
    pub const OPERATIONS: ProjectionsOperationsId = ProjectionsOperationsId;
}
