# [corten-run/corten#1370 A write that answers its own result with JavaScript (a patch, or its page) cannot bring a layout read up to date: only a redirect redraws the shell, so a partial result must choose between its detail and the shell's count](https://github.com/corten-run/corten/issues/1370)

Closed, still cited as the change the pilot relies on or the decision that left part of the workaround to the app.

What the pilot does now: closed by Corten's whole-page write answer (pinned since `229b1e92`): with JavaScript a write's own page is drawn whole, its layout reads included. A bulk add from a search that adds only some lines answers the search's page with its sheet open and gives the cart count it read after the write, with JavaScript as without ([marketplace/src/bulk_cart.rs](../../marketplace/src/bulk_cart.rs), `commit`)
