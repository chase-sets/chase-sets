# [corten-run/corten#1449 A Corten app writes no line per request, and an app's middleware cannot write a faithful one: it never sees a 421 or a cross-site refusal and logs a 200 where the client got a 304](https://github.com/corten-run/corten/issues/1449)

Closed, still cited as the change the pilot relies on or the decision that left part of the workaround to the app.

What the pilot does now: closed by Corten's `App::access_log` (pinned since `39ac3e96`): each app sets `access_log(true)`, which logs after every stage and layer, so a `421`, a cross-site refusal and a `304` are logged as the client got them; the pilot's tower layer is gone
