//! Packing slips to print, after Fulfillment's `packing-slip-page.tsx` and the design system's
//! `PackingSlipPrintDocument`: the toolbar (Seller, Packing slips, how many are ready, the format
//! chooser and Print), then a slip per shipment: its order and shipment references, Ship to and
//! Ship from, and its items with no prices.
//!
//! On screen each slip is a sheet the shape of its paper; on a phone it is one column whose rows
//! stack, each with its quantity labelled. Printed, the top bar and the toolbar are left out and
//! each slip is a page of its own size (`@page packing-slips-page-letter` or
//! `@page packing-slips-page-thermal`). Print is corten-ui's `PrintButton`, in the toolbar, which
//! print hides.
use corten::prelude::*;
use corten_ui::PrintButton;

use super::{order_page::display_reference, packing_page::address_lines};
use crate::{
    api::ShipmentDetail,
    app::url,
    packing_slips::{Format, SlipsScreen},
    text::ShipmentsMsg,
};

/// The page.
#[component(css)]
pub fn PackingSlipsPage<'a>(t: ShipmentsMsg, screen: &'a SlipsScreen) -> impl Render {
    let ids: Vec<&str> = screen.slips.iter().map(|s| s.shipment_id.as_str()).collect();
    let action = url::PackingSlips { shipment_ids: &[], format: None };
    html! {
        <div class={Page}>
            <div class={Toolbar}>
                <div class={Copy}>
                    <p class={Eyebrow}>{t.slip_seller()}</p>
                    <h1 class={Title}>{t.slip_packing_slips()}</h1>
                    <p class={Muted}>{t.slip_ready_to_print(screen.slips.len())}</p>
                </div>
                <div class={Actions}>
                    <form class={Chooser} method="get" action={action}>
                        for id in &ids {
                            <input type="hidden" name="shipmentIds" value={*id}>
                        }
                        <label class={Field}>
                            <span class={Label}>{t.slip_format()}</span>
                            <select name="format">
                                <option value="letter" selected={screen.format == Format::Letter}>{t.slip_letter()}</option>
                                <option value="thermal-4x6" selected={screen.format == Format::Thermal}>
                                    {t.slip_thermal_4x6()}
                                </option>
                            </select>
                        </label>
                        <button type="submit" class={Button} data-tone="secondary">{t.slip_change_format()}</button>
                    </form>
                    <span class={Print}>
                        <PrintButton label={t.slip_print()} />
                    </span>
                </div>
            </div>
            <div class={Sheets} data-format={screen.format.as_str()}>
                for slip in &screen.slips {
                    <Slip t={t} slip={slip} format={screen.format} />
                }
            </div>
        </div>
    }
}

/// One shipment's slip.
#[component(css = PackingSlipsPage)]
fn Slip<'a>(t: ShipmentsMsg, slip: &'a ShipmentDetail, format: Format) -> impl Render {
    let thermal = format == Format::Thermal;
    let to = slip.shipping_destination_snapshot.as_ref().map(address_lines).unwrap_or_default();
    let from = slip.shipping_origin_snapshot.as_ref().map(address_lines);
    html! {
        <article class={(Sheet, (!thermal).then_some(Letter), thermal.then_some(Thermal))} data-packing-slip-page>
            <header class={SheetHeader}>
                <div>
                    <h2 class={SheetTitle}>{t.slip_packing_slip()}</h2>
                    <div class={Line}>{t.slip_order()}": "{display_reference(&slip.order_id)}</div>
                </div>
                <div class={Reference}>
                    <div>{t.slip_shipment()}</div>
                    <div>{&slip.display_reference}</div>
                </div>
            </header>
            <section class={Addresses}>
                <div>
                    <h3 class={SectionTitle}>{t.slip_ship_to()}</h3>
                    for line in &to {
                        <div class={Line}>{line}</div>
                    }
                </div>
                if let Some(from) = &from {
                    <div>
                        <h3 class={SectionTitle}>{t.slip_ship_from()}</h3>
                        for line in from {
                            <div class={Line}>{line}</div>
                        }
                    </div>
                }
            </section>
            <section>
                <h3 class={SectionTitle}>{t.slip_items()}</h3>
                <table class={Items}>
                    <thead>
                        <tr>
                            <th scope="col">{t.slip_item()}</th>
                            <th scope="col">{t.slip_product()}</th>
                            <th scope="col" class={Qty}>{t.slip_qty()}</th>
                        </tr>
                    </thead>
                    <tbody>
                        for line in &slip.lines {
                            <tr>
                                <td>
                                    <strong>{&line.item_title}</strong>
                                    if let Some(subtitle) = &line.item_subtitle {
                                        <div>{subtitle}</div>
                                    }
                                </td>
                                <td>{line.product_summary.as_deref().unwrap_or(t.slip_standard())}</td>
                                <td class={Qty}><span class={QtyLabel}>{t.slip_qty()}": "</span>{line.quantity}</td>
                            </tr>
                        }
                    </tbody>
                </table>
            </section>
            <footer>
                <p class={Footer}>{t.slip_no_prices()}</p>
            </footer>
        </article>
    }
}
