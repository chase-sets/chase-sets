# [corten-run/corten#2137 NavLinks does not say which entry it marked current, so a trail or phone bar re-derives the rule](https://github.com/corten-run/corten/issues/2137)

The admin's section navigation ([admin_nav.rs](../../admin/src/views/admin_nav.rs)) finds the current page for the Sections trail and the phone bar with its own `current()`, the deepest served entry `req.is_current` holds, instead of reading it from `req.nav_of`. Replace it with the `NavLinks` read once Corten has one, and before any admin nav entry takes other addresses.
