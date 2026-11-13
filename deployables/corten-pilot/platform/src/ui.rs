// corten ui 0.1.0
//! The UI kit's components, which `corten ui add` copied into `src/ui/`, styled by the design
//! system's tokens: the kit's theme names (`tokens/ui.tokens.json`, written by
//! scripts/export.mjs) are references to the design system's, in the one resolver
//! [`crate::theme`] reads, so the dark theme reaches them too. They are the pilot's to change;
//! `corten ui diff` shows how they differ from the kit.

use corten::Component;

pub mod accordion;
pub mod alert;
pub mod avatar;
pub mod badge;
pub mod breadcrumb;
pub mod button;
pub mod card;
pub mod checkbox;
pub mod checkboxes;
pub mod combobox;
pub mod dialog;
pub mod dropdown_menu;
pub mod field;
pub mod icon;
pub mod input;
pub mod input_group;
pub mod meter;
pub mod nav_bar;
pub mod pagination;
pub mod popover;
pub mod progress;
pub mod radio_group;
pub mod segmented;
pub mod select;
pub mod separator;
pub mod sheet;
pub mod skeleton;
pub mod slider;
pub mod stack;
pub mod stats;
pub mod status_dot;
pub mod stepper;
pub mod steps;
pub mod switch;
pub mod table;
pub mod tabs;
pub mod textarea;
pub mod toasts;
pub mod visually_hidden;

/// Each component with a stylesheet, after [`crate::theme::TOKENS`]: `App::components(ui::COMPONENTS)`.
pub const COMPONENTS: &[Component] = &[
    accordion::Accordion,
    alert::Alert,
    avatar::Avatar,
    badge::Badge,
    breadcrumb::Breadcrumb,
    button::Button,
    card::Card,
    checkbox::Checkbox,
    checkboxes::Checkboxes,
    combobox::Combobox,
    dialog::Dialog,
    dropdown_menu::DropdownMenu,
    field::Field,
    icon::Icon,
    input::Input,
    input_group::InputGroup,
    meter::Meter,
    nav_bar::NavBar,
    pagination::Pagination,
    popover::Popover,
    progress::Progress,
    radio_group::RadioGroup,
    segmented::Segmented,
    select::Select,
    separator::Separator,
    sheet::Sheet,
    skeleton::Skeleton,
    slider::Slider,
    stack::Stack,
    stats::Stats,
    status_dot::StatusDot,
    stepper::Stepper,
    steps::Steps,
    switch::Switch,
    table::Table,
    tabs::Tabs,
    textarea::Textarea,
    toasts::Toasts,
    visually_hidden::VisuallyHidden,
];
