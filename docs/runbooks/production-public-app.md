# Production Public App

`chasesets.com` and `www.chasesets.com` are served by public-web unless the `production` environment variable `PRODUCTION_PUBLIC_APP` says otherwise. The Corten public app (`public-corten`) takes over both hosts together; there is no separate Corten public host in production, and `/api`, `/ucp`, `/mcp` and `/.well-known` on both hosts go to platform-api at the ingress whichever app serves them. `marketplace.chasesets.com` and `admin.chasesets.com` are unaffected (see [Production Marketplace App](./production-marketplace-app.md) and [Production Admin App](./production-admin-app.md)).

## The switch

`PRODUCTION_PUBLIC_APP` selects the app behind `chasesets.com` and `www.chasesets.com`:

1. Unset or `public-web`: public-web serves them, and the Corten public app is not deployed, whatever image staging built. Nothing about the pilot can fail or hold a production release in this mode.
2. `public-corten`: the Corten public app serves them, running the image digest that Deploy Staging deployed and smoked for the same release (`needs.deploy-staging.outputs.corten_public_image`). The deploy's `helm upgrade --wait --atomic` is the gate: the Corten public app must become ready, then the Smoke check's landing smoke walks the public routes on `chasesets.com` (`smoke:public-web-routes --mode healthy`), as staging's does on `www.staging`.

Any other value fails the deploy before Helm runs. Every Deploy Production run names the app in the step summary ("Production public app"), in the `production_kubernetes_deploy` step's and the job's `public_app` output, and in the deploy record's `productionPublicApp`, whose `publicCorten` field says `deployed` or `not-deployed`.

A failed switch shows as a red Deploy Production that rolled back to public-web. The response is to fix forward on staging, not to retry production.

## Gates before setting the variable

Set `PRODUCTION_PUBLIC_APP=public-corten` only when all of these hold, and record each one on the switch issue:

1. Order: production already serves admin from the Corten admin and marketplace from the Corten marketplace, each through at least one verified production deploy.
2. A green staging deploy whose Smoke check walked the public routes on `www.staging` served by the Corten public app (see [Staging Public App](./staging-public-app.md)).
3. Waitlist: a signup through the home page form on `www.staging`, served by the Corten public app, reaches its welcome page and shows in the admin waitlist. Production's landing runtime profile makes the waitlist the public site's main job.

## Switch to the Corten public app

1. `gh variable set PRODUCTION_PUBLIC_APP --repo chase-sets/chase-sets --env production --body public-corten`
2. Deploy: `gh workflow run platform-production.yml --repo chase-sets/chase-sets --ref main -f release_ref=main -f dispatch_source=manual -f force_deploy=true -f reason="Serve chasesets.com from the Corten public app"`.
3. Check the run: the "Production public app" summary says public-corten via `PRODUCTION_PUBLIC_APP=public-corten`, the deploy record's `productionPublicApp.publicCorten` is `deployed`, and the live-host wait, the Smoke check and the Stage 1 canary passed against `chasesets.com` and `www.chasesets.com`.
4. Check crawlers: production indexes the public site with either app (`CHASE_SETS_PUBLIC_INDEXING=true`), which staging never does. `https://chasesets.com/robots.txt` must allow crawling and name the sitemap, `https://chasesets.com/sitemap.xml` must list the home page, and the home page must carry no `noindex`. If any fails, roll back.

## Roll back to public-web

1. `gh variable delete PRODUCTION_PUBLIC_APP --repo chase-sets/chase-sets --env production` (or set it to `public-web`).
2. Deploy as in step 2 above, with the reason "Serve chasesets.com from public-web".
3. Check the run: the summary says public-web and that public-corten is not deployed, and the Smoke check passed against `chasesets.com`.

## When Deploy Production refuses before Helm

These refusals change nothing in production, but they hold every later production release until someone acts. Both apply only under `PRODUCTION_PUBLIC_APP=public-corten`.

1. "corten-public-image is required on production": Deploy Staging deployed no Corten public image for this release, because staging serves public-web (`STAGING_PUBLIC_APP=public-web`) or the image was not built. Recover by setting `PRODUCTION_PUBLIC_APP=public-web` (or deleting it) and re-running, or by returning staging to the Corten public app and deploying again.
2. "PROXIES is required on production": the ingress pod CIDRs could not be read, and the Corten public app would take every request as coming from the ingress. Recover by setting `PRODUCTION_PUBLIC_APP=public-web` (or deleting it) and re-running, or by fixing the ingress pod CIDR discovery in the deploy step and deploying again.
