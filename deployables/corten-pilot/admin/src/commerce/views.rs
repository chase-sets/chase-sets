//! Commerce's views. Each component's stylesheet and script are next to it in `views/`.
use corten::Component;

mod intake_page;

pub use intake_page::IntakePage;

/// Return Intake's components: its stylesheet and script.
pub const INTAKE: &[Component] = &[IntakePage];
