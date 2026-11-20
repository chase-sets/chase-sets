//! The catalog's bulk previews: a `GET` of a list's bulk form, since a preview writes nothing.
//! It is still for the staff who may make the change it previews (the bar is theirs alone, and the
//! API asks for the same), so these routes are a module of their own in the catalog area, held to
//! `catalog.manage` whatever the method (`CatalogManage`) rather than the area's `CatalogAccess`,
//! which lets a `GET` through with `catalog.view`.

use corten::Area;

use crate::app::Shared;

/// The previews, each answered by its list's handler.
#[corten::routes(state = crate::app::Shared, area = crate::catalog::url::Catalog, caller = crate::auth::Staff<crate::auth::CatalogManage>)]
pub mod url {
    /// A bulk change of the dimensions: its preview, a `GET` of the bulk form since it writes
    /// nothing (without JavaScript the answer is the list, with the preview open, at this address).
    #[route("/catalog/dimensions/bulk", get = crate::catalog::preview_dimensions)]
    pub struct DimensionsBulk {
        #[route(query)]
        pub query: crate::catalog::url::DimensionQuery,
    }

    /// A bulk change of the fields: its preview.
    #[route("/catalog/fields/bulk", get = crate::catalog::preview_fields)]
    pub struct FieldsBulk {
        #[route(query)]
        pub query: crate::catalog::url::FieldQuery,
    }

    /// A bulk change's preview.
    #[route("/catalog/categories/bulk", get = crate::catalog::categories::preview_bulk)]
    pub struct CategoriesBulk {
        #[route(query)]
        pub query: crate::catalog::categories::url::CategoryQuery,
    }

    /// A bulk change's preview.
    #[route("/catalog/components/bulk", get = crate::catalog::components::preview_bulk)]
    pub struct ComponentsBulk {
        #[route(query)]
        pub query: crate::catalog::components::url::ComponentQuery,
    }

    /// A bulk change's preview.
    #[route("/catalog/blueprints/bulk", get = crate::catalog::blueprints::preview_bulk)]
    pub struct BlueprintsBulk {
        #[route(query)]
        pub query: crate::catalog::blueprints::url::BlueprintQuery,
    }

    /// A bulk change's preview.
    #[route("/catalog/reference-types/bulk", get = crate::catalog::reference_types::preview_bulk)]
    pub struct RefTypesBulk {
        #[route(query)]
        pub query: crate::catalog::reference_types::url::RefTypeQuery,
    }

    /// A bulk change's preview.
    #[route("/catalog/reference-records/bulk", get = crate::catalog::reference_records::preview_bulk)]
    pub struct RefRecordsBulk {
        #[route(query)]
        pub query: crate::catalog::reference_records::url::RefRecordQuery,
    }

    /// A bulk change's preview.
    #[route("/catalog/catalog-items/bulk", get = crate::catalog::items::preview)]
    pub struct ItemsBulk {
        #[route(query)]
        pub query: crate::catalog::items::url::ItemQuery,
    }

    /// The checked rows' removal: its preview.
    #[route("/catalog/catalog-items/drafts", get = crate::catalog::items::drafts)]
    pub struct ItemsDrafts {
        #[route(query)]
        pub query: crate::catalog::items::url::ItemQuery,
    }
}

/// The previews' routes, mounted in the catalog area.
pub fn area(area: Area<crate::catalog::url::Catalog>, shared: Shared) -> Area<crate::catalog::url::Catalog> {
    url::area(area, shared)
}
