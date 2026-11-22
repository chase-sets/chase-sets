# [corten-run/corten#1065 Kit Stack and Cluster always print a literal gap, so an app on its own token spacing scale cannot use them with its gap utility](https://github.com/corten-run/corten/issues/1065)

Closed, still cited as the change the pilot relies on or the decision that left part of the workaround to the app.

What the pilot does now: closed by Corten's `Gap::App` (pinned since `f4f37f95`). Every page column is the kit's `Stack { gap: Gap::App }` with the theme's `gap_N()`: the five whose children keep their own width (support requests, command center, order, packing, shipment) are `StackStart { gap: Gap::App }` in its place. A page's own `.stack` keeps only what the kit's does not set (`min-width: 0` in a grid track, a padding or margin)
