# [corten-run/corten#1462 A patches route's handler whose part needs its own read cannot answer its page without building a patch it will not send: only patch_or turns a page into HtmlResult<Patches>, and it takes the patch already built](https://github.com/corten-run/corten/issues/1462)

Closed, still cited as the change the pilot relies on or the decision that left part of the workaround to the app.

What the pilot does now: closed by Corten's `Req::patch_or_with` (pinned since `27c29d7d`): the notification center's address answers the runtime's read of the alerts section and its page from one handler, each side lazy, and no unsent patch is built ([marketplace/src/notifications.rs](../../marketplace/src/notifications.rs))
