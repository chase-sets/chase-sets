# [chase-sets/chase-sets#10871 [public-presence] Promo Bar's start and end times are read in the API server's time zone and shown in UTC, not the operator's](https://github.com/chase-sets/chase-sets/issues/10871)

Closed, still cited as the decision or fix the code relies on; it leaves no workaround behind. The pilot reads and fills them in the operator's zone and sends the instant.

Cited in: [admin/src/growth/promo.rs](../../admin/src/growth/promo.rs)
