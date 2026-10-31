//! Commerce's views. Each component's stylesheet and script are next to it in `views/`.
use corten::Component;

mod intake_page;
mod recovered_page;

pub use intake_page::IntakePage;
pub use recovered_page::RecoveredPage;

/// Return Intake's components: its stylesheet and script.
pub const INTAKE: &[Component] = &[IntakePage];
/// Recovered Returns' components: its stylesheet.
pub const RECOVERED: &[Component] = &[RecoveredPage];
