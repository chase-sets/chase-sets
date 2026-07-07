export const checkoutEnglishTranslations = {
  "checkout.features.cart.api.route.authentication.context.missing": "Authentication context missing.",
  "checkout.features.cart.api.route.authentication.context.missing.2": "Authentication context missing.",
  "checkout.features.cart.api.route.authentication.context.missing.3": "Authentication context missing.",
  "checkout.features.cart.api.route.authentication.required": "Authentication required.",
  "checkout.features.cart.api.route.anonymous.cart.limit.exceeded":
    "This device has {limit} Buy Cart lines saved. Remove an item before adding another.",
  "checkout.features.cart.api.route.anonymous.request.rate.limited":
    "Too many anonymous Buy Cart requests. Wait a few minutes and try again.",
  "checkout.features.cart.api.route.forbidden": "Forbidden.",
  "checkout.features.cart.api.route.request.failed": "Request failed.",
  "checkout.features.cart.integrations.catalog.catalogSchema.create.table.if.not.exists.checkout":
    "\nCREATE TABLE IF NOT EXISTS checkout_catalog_items (\n  catalog_item_id text PRIMARY KEY,\n  title text NOT NULL,\n  subtitle text NULL,\n  blueprint_id text NULL,\n  status text NOT NULL,\n  product_schema jsonb NULL,\n  updated_at timestamptz NOT NULL\n);\n\nCREATE INDEX IF NOT EXISTS checkout_catalog_items_blueprint_idx\n  ON checkout_catalog_items (blueprint_id);\n\nCREATE INDEX IF NOT EXISTS checkout_catalog_items_status_idx\n  ON checkout_catalog_items (status);\n\nCREATE TABLE IF NOT EXISTS checkout_catalog_blueprints (\n  blueprint_id text PRIMARY KEY,\n  name text NOT NULL,\n  status text NOT NULL,\n  dimension_rules jsonb NOT NULL DEFAULT '[]'::jsonb,\n  canonical_dimension_order jsonb NOT NULL DEFAULT '[]'::jsonb,\n  updated_at timestamptz NOT NULL\n);\n\nCREATE TABLE IF NOT EXISTS checkout_catalog_dimensions (\n  dimension_id text PRIMARY KEY,\n  name text NOT NULL,\n  updated_at timestamptz NOT NULL\n);\n\nCREATE TABLE IF NOT EXISTS checkout_catalog_dimension_options (\n  option_id text PRIMARY KEY,\n  dimension_id text NOT NULL,\n  code text NOT NULL,\n  labels jsonb NOT NULL DEFAULT '[]'::jsonb,\n  updated_at timestamptz NOT NULL\n);\n\nCREATE INDEX IF NOT EXISTS checkout_catalog_dimension_options_dimension_idx\n  ON checkout_catalog_dimension_options (dimension_id);\n",
  "checkout.features.cart.readModel.schema.create.table.if.not.exists.checkout":
    "\nCREATE TABLE IF NOT EXISTS checkout_cart_line_pages (\n  buyer_account_id text NOT NULL,\n  line_id text NOT NULL,\n  catalog_catalog_item_id text NOT NULL,\n  product_id text NOT NULL,\n  item_language_code text NULL,\n  item_title text NOT NULL,\n  item_subtitle text NULL,\n  item_image_url text NULL,\n  item_image_srcset text NULL,\n  item_image_loading_url text NULL,\n  item_image_loading_alt text NULL,\n  item_image_loading_srcset text NULL,\n  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,\n  product_summary text NULL,\n  quantity integer NOT NULL CHECK (quantity > 0),\n  fulfillment_mode text NOT NULL DEFAULT 'optimize',\n  locked_listing_id text NULL,\n  seller_preference_id text NULL,\n  availability_state text NOT NULL DEFAULT 'available',\n  created_at timestamptz NOT NULL DEFAULT now(),\n  updated_at timestamptz NOT NULL DEFAULT now(),\n  PRIMARY KEY (buyer_account_id, line_id)\n);\n\nCREATE INDEX IF NOT EXISTS checkout_cart_line_pages_buyer_idx\n  ON checkout_cart_line_pages (buyer_account_id, updated_at DESC, line_id ASC);\n\nCREATE INDEX IF NOT EXISTS checkout_cart_line_pages_catalog_version_idx\n  ON checkout_cart_line_pages (product_id);\n",
  "checkout.features.cart.ui.addToCartSection.add.to.cart": "Add To Buy Cart",
  "checkout.features.cart.ui.addToCartSection.add.to.cart.2": "Add to buy cart",
  "checkout.features.cart.ui.addToCartSection.cart.lines.capture.buyer.intent.exact":
    "Buy Cart lines capture buyer intent. Exact listing and inventory matching happens at checkout.",
  "checkout.features.cart.ui.addToCartSection.matching.visible.listings.right.now":
    "Matching visible listings right now: ",
  "checkout.features.cart.ui.addToCartSection.quantity": "Quantity",
  "checkout.features.cart.ui.addToCartSection.same.seller.cards.earn.five.percent.toward.shipping":
    "Same-seller cards earn 5% of item value toward shipping at checkout.",
  "checkout.features.cart.ui.addToCartSection.standard.product": "Standard product",
  "checkout.features.cart.ui.cartPage.browse.the.marketplace.and.add.a":
    "Browse the marketplace and add a product to start building a Buy Cart checkout.",
  "checkout.features.cart.ui.cartPage.buy.cart": "Buy cart",
  "checkout.features.cart.ui.cartPage.cart.update.pending": "Updating cart",
  "checkout.features.cart.ui.cartPage.cart.update.pending.title": "Your cart is catching up",
  "checkout.features.cart.ui.cartPage.cart.update.refreshing": "Refreshing cart",
  "checkout.features.cart.ui.cartPage.checkout.issue": "Checkout issue",
  "checkout.features.cart.ui.cartPage.decrease": "Decrease",
  "checkout.features.cart.ui.cartPage.empty.cart.protection.description":
    "When you add items, checkout will show final shipping, tax, and payment details before you pay.",
  "checkout.features.cart.ui.cartPage.empty.cart.protection.title": "Checkout protection stays visible",
  "checkout.features.cart.ui.cartPage.calculated.at.checkout": "Calculated at checkout",
  "checkout.features.cart.ui.cartPage.check.out": "Check out",
  "checkout.features.cart.ui.cartPage.estimated.total": "Estimated total",
  "checkout.features.cart.ui.cartPage.final.total.confirmed": "Final total confirmed at checkout",
  "checkout.features.cart.ui.cartPage.find.alternatives": "Find alternatives",
  "checkout.features.cart.ui.cartPage.from": "from",
  "checkout.features.cart.ui.cartPage.fulfillment.needs.review": "Some items need attention",
  "checkout.features.cart.ui.cartPage.fulfillment.needs.review.description.many":
    "{count} items need fulfillment, shipping measure, or availability resolved before checkout.",
  "checkout.features.cart.ui.cartPage.fulfillment.needs.review.description.one":
    "1 item needs fulfillment, shipping measure, or availability resolved before checkout.",
  "checkout.features.cart.ui.cartPage.items": "Items",
  "checkout.features.cart.ui.cartPage.increase": "Increase",
  "checkout.features.cart.ui.cartPage.lock.this.listing": "Lock this listing",
  "checkout.features.cart.ui.cartPage.locked.listing.summary":
    "{listing} is locked for checkout unless availability changes.",
  "checkout.features.cart.ui.cartPage.needs.fulfillment": "Needs fulfillment",
  "checkout.features.cart.ui.cartPage.needs.review": "Needs review",
  "checkout.features.cart.ui.cartPage.no.payment.until.checkout": "No payment until checkout.",
  "checkout.features.cart.ui.cartPage.optimization.available.description":
    "You can keep your current fulfillment or use the lower-cost option before checkout begins.",
  "checkout.features.cart.ui.cartPage.optimization.available.title": "Save ${savings} before checkout",
  "checkout.features.cart.ui.cartPage.optimization.switch.to.seller.title": "Save ${savings} by switching to {seller}",
  "checkout.features.cart.ui.cartPage.seller.reputation.empty": "No reviews yet",
  "checkout.features.cart.ui.cartPage.seller.reputation.label": "Seller account reputation",
  "checkout.features.cart.ui.cartPage.product.image.alt": "{title} product",
  "checkout.features.cart.ui.cartPage.quantity": "Quantity",
  "checkout.features.cart.ui.cartPage.priced.at.checkout": "Priced at checkout",
  "checkout.features.cart.ui.cartPage.preferred.listing": "Preferred listing",
  "checkout.features.cart.ui.cartPage.preferred.listing.summary":
    "{listing} is the starting preference. Smart Match may choose another available listing.",
  "checkout.features.cart.ui.cartPage.ready": "Ready",
  "checkout.features.cart.ui.cartPage.refresh.cart": "Refresh cart",
  "checkout.features.cart.ui.cartPage.remove": "Remove",
  "checkout.features.cart.ui.cartPage.resolve.before.payment": "Resolve item availability before payment starts.",
  "checkout.features.cart.ui.cartPage.resolve.fulfillment": "Continue to checkout",
  "checkout.features.cart.ui.cartPage.review.items.before.checkout":
    "Review quantities and remove anything you do not want before checkout.",
  "checkout.features.cart.ui.cartPage.shipping.and.tax": "Shipping and tax",
  "checkout.features.cart.ui.cartPage.shipping.measure.missing": "Shipping measure missing",
  "checkout.features.cart.ui.cartPage.selected.listing": "Selected listing",
  "checkout.features.cart.ui.cartPage.keep.shopping": "Keep shopping",
  "checkout.features.cart.ui.cartPage.standard": "Standard",
  "checkout.features.cart.ui.cartPage.use.lower.fulfillment": "Use lower price",
  "checkout.features.cart.ui.cartPage.simple.cart.description":
    "Review your items, then continue to checkout when everything is ready.",
  "checkout.features.cart.ui.cartPage.taxes.and.shipping.calculated": "Taxes and shipping are calculated at checkout.",
  "checkout.features.cart.ui.cartPage.unavailable": "Unavailable",
  "checkout.features.cart.ui.cartPage.waiting.for.supply": "Waiting for supply",
  "checkout.features.cart.ui.cartPage.your.cart": "Your cart",
  "checkout.features.cart.ui.cartPage.your.cart.is.empty": "Your buy cart is empty",
  "checkout.features.sessions.api.route.authentication.context.missing": "Authentication context missing.",
  "checkout.features.sessions.api.route.authentication.context.missing.2": "Authentication context missing.",
  "checkout.features.sessions.api.route.authentication.context.missing.3": "Authentication context missing.",
  "checkout.features.sessions.api.route.authentication.required": "Authentication required.",
  "checkout.features.sessions.api.route.address.standardization.suggested":
    "We found a standardized version of this address. Choose the suggested address or confirm the address as entered.",
  "checkout.features.sessions.api.route.checkout.session.not.found": "Checkout session not found.",
  "checkout.features.sessions.api.route.checkout.session.not.found.2": "Checkout session not found.",
  "checkout.features.sessions.api.route.checkout.reservation.unavailable":
    "One or more checkout items were just reserved by another buyer.",
  "checkout.features.sessions.api.route.forbidden": "Forbidden.",
  "checkout.features.sessions.api.route.payment.summary.not.found": "Payment summary not found.",
  "checkout.features.sessions.api.route.payment.quote.required":
    "Review the latest payable total before payment starts.",
  "checkout.features.sessions.api.route.payment.start.pending":
    "Payment setup is still catching up. Review checkout again before payment starts.",
  "checkout.features.sessions.api.route.register.or.sign.in.before.placing.purchase.intent":
    "Register or sign in before submitting an offer.",
  "checkout.features.sessions.api.route.request.failed": "Request failed.",
  "checkout.features.sessions.readModel.schema.create.table.if.not.exists.checkout":
    "\nCREATE TABLE IF NOT EXISTS checkout_session_pages (\n  session_id text PRIMARY KEY,\n  buyer_account_id text NOT NULL,\n  source_type text NOT NULL,\n  shipping_option text NOT NULL,\n  lines jsonb NOT NULL DEFAULT '[]'::jsonb,\n  order_ids jsonb NOT NULL DEFAULT '[]'::jsonb,\n  payment_id text NULL,\n  created_at timestamptz NOT NULL,\n  updated_at timestamptz NOT NULL\n);\n\nCREATE INDEX IF NOT EXISTS checkout_session_pages_buyer_idx\n  ON checkout_session_pages (buyer_account_id, updated_at DESC, session_id DESC);\n",
  "checkout.features.sessions.ui.checkoutPage.add.a.product.before.starting.checkout":
    "Add a product before starting checkout.",
  "checkout.features.sessions.ui.checkoutPage.address.line1": "Address line 1",
  "checkout.features.sessions.ui.checkoutPage.address.line2": "Address line 2",
  "checkout.features.sessions.ui.checkoutPage.apply.available.wallet.balance.to.this":
    "Apply available wallet balance to this checkout",
  "checkout.features.sessions.ui.checkoutPage.available.balance": "Available balance",
  "checkout.features.sessions.ui.checkoutPage.bank.account": "Bank account",
  "checkout.features.sessions.ui.checkoutPage.back.to.cart": "Back to buy cart",
  "checkout.features.sessions.ui.checkoutPage.browse.marketplace": "Browse marketplace",
  "checkout.features.sessions.ui.checkoutPage.buy.now": "Buy now",
  "checkout.features.sessions.ui.checkoutPage.buyer.protection": "Order Protection",
  "checkout.features.sessions.ui.checkoutPage.card": "Card",
  "checkout.features.sessions.ui.checkoutPage.cart": "Buy cart",
  "checkout.features.sessions.ui.checkoutPage.catalog.item": "Catalog item: ",
  "checkout.features.sessions.ui.checkoutPage.checkout": "Checkout",
  "checkout.features.sessions.ui.checkoutPage.checkout.issue": "Checkout issue",
  "checkout.features.sessions.ui.checkoutPage.checkout.status": "Checkout status",
  "checkout.features.sessions.ui.checkoutPage.checkout.summary": "Checkout Summary",
  "checkout.features.sessions.ui.checkoutPage.confirm.shipping.place.purchase.intent":
    "Confirm shipping details and submit an offer for sellers to review.",
  "checkout.features.sessions.ui.checkoutPage.continue.to.payment": "Continue to payment",
  "checkout.features.sessions.ui.checkoutPage.continue.to.payment.2": "Continue to payment",
  "checkout.features.sessions.ui.checkoutPage.contact": "Contact",
  "checkout.features.sessions.ui.checkoutPage.email.me.with.news": "Email me with news and offers",
  "checkout.features.sessions.ui.checkoutPage.delivery.estimate": "Delivery estimate",
  "checkout.features.sessions.ui.checkoutPage.delivery.estimate.summary":
    "{shippingOption}: {window}. {packageCount} package(s), {serviceLevel}.",
  "checkout.features.sessions.ui.checkoutPage.delivery": "Delivery",
  "checkout.features.sessions.ui.checkoutPage.delivery.basis": "Delivery basis",
  "checkout.features.sessions.ui.checkoutPage.delivery.promise": "Delivery promise",
  "checkout.features.sessions.ui.checkoutPage.delivery.promise.preview": "Delivery preview, carrier promise pending",
  "checkout.features.sessions.ui.checkoutPage.fulfillment.cutoff": "Fulfillment cutoff",
  "checkout.features.sessions.ui.checkoutPage.fulfillment.cutoff.value":
    "{cutoffTime} local cutoff; packing starts {packingStartDate}; carrier pickup {carrierHandoffDate}",
  "checkout.features.sessions.ui.checkoutPage.shipping.service": "Shipping service",
  "checkout.features.sessions.ui.checkoutPage.estimated.days.after.purchase":
    "Estimated delivery {minimumDays}-{maximumDays} days after purchase",
  "checkout.features.sessions.ui.checkoutPage.final.totals.before.payment": "Final totals are shown before payment.",
  "checkout.features.sessions.ui.checkoutPage.final.totals.before.payment.description":
    "This checkout total includes item subtotal, shipping, estimated tax, marketplace checkout fee, and wallet credit before payment starts.",
  "checkout.features.sessions.ui.checkoutPage.city": "City",
  "checkout.features.sessions.ui.checkoutPage.country": "Country",
  "checkout.features.sessions.ui.checkoutPage.destination.required.for.purchase.intent":
    "Delivery address is required so sellers know where the offer would ship if accepted.",
  "checkout.features.sessions.ui.checkoutPage.destination.required.for.sales.tax":
    "Delivery address is required before shipping, tax, and final totals can be confirmed.",
  "checkout.features.sessions.ui.checkoutPage.eligible.orders.are.protected.through.payment":
    "Eligible orders are protected through payment and fulfillment.",
  "checkout.features.sessions.ui.checkoutPage.expedited": "Expedited",
  "checkout.features.sessions.ui.checkoutPage.fast.checkout.ready": "Fast checkout ready",
  "checkout.features.sessions.ui.checkoutPage.fast.checkout.ready.description":
    "Using {addressLabel} with {paymentMethodCategory} pricing. Payment credentials stay on the secure payment step.",
  "checkout.features.sessions.ui.checkoutPage.saved.address.ready": "Saved address ready",
  "checkout.features.sessions.ui.checkoutPage.saved.address.ready.description":
    "Using {addressLabel} for fulfillment, shipping, and tax preview. Choose payment before placing the order.",
  "checkout.features.sessions.ui.checkoutPage.fulfillment.ready": "Fulfillment Ready",
  "checkout.features.sessions.ui.checkoutPage.fulfillment.changed": "Fulfillment changed since your last preview",
  "checkout.features.sessions.ui.checkoutPage.fulfillment.changed.description":
    "Review the latest checkout preview before continuing.",
  "checkout.features.sessions.ui.checkoutPage.fulfillment.resolved.before.checkout":
    "Cart review resolves fulfillment before checkout starts.",
  "checkout.features.sessions.ui.checkoutPage.items": "Items",
  "checkout.features.sessions.ui.checkoutPage.lines": "Lines",
  "checkout.features.sessions.ui.checkoutPage.marketplace.checkout.fee": "Checkout service fee",
  "checkout.features.sessions.ui.checkoutPage.marketplace.checkout.fee.description":
    "Covers secure payment and order protection, and may be reduced by eligible lower-cost payment methods.",
  "checkout.features.sessions.ui.checkoutPage.none": "none",
  "checkout.features.sessions.ui.checkoutPage.not.required": "not required",
  "checkout.features.sessions.ui.checkoutPage.order.totals.created": "Order totals created",
  "checkout.features.sessions.ui.checkoutPage.order.reference": "Order reference",
  "checkout.features.sessions.ui.checkoutPage.offer.submitted.after.review": "Offer submitted after review",
  "checkout.features.sessions.ui.checkoutPage.payment": "Payment",
  "checkout.features.sessions.ui.checkoutPage.payment.section.description":
    "Choose how the secure payment step should be prepared.",
  "checkout.features.sessions.ui.checkoutPage.payment.method": "Payment method",
  "checkout.features.sessions.ui.checkoutPage.payable.total": "Payable total",
  "checkout.features.sessions.ui.checkoutPage.payment.ready": "Payment ready",
  "checkout.features.sessions.ui.checkoutPage.payment.ready.2": "Payment ready",
  "checkout.features.sessions.ui.checkoutPage.payment.quote.required": "Review the latest payable total",
  "checkout.features.sessions.ui.checkoutPage.payment.quote.required.description":
    "Payment does not start until fees, credits, and the final payable total are visible on this page.",
  "checkout.features.sessions.ui.checkoutPage.payment.review.next": "Payment review comes next",
  "checkout.features.sessions.ui.checkoutPage.payment.review.next.description":
    "Review the latest total before payment starts.",
  "checkout.features.sessions.ui.checkoutPage.payment.review.next.with.wallet":
    "Up to {amount} {currency} wallet balance can be applied before payment starts.",
  "checkout.features.sessions.ui.checkoutPage.reserved.for.you": "Reserved for you - {time}",
  "checkout.features.sessions.ui.checkoutPage.reservation.expired": "Reservation expired",
  "checkout.features.sessions.ui.checkoutPage.reservation.expired.description":
    "Reserve again to continue checkout if the item is still available.",
  "checkout.features.sessions.ui.checkoutPage.reservation.unavailable.title": "Some items are already reserved",
  "checkout.features.sessions.ui.checkoutPage.reservation.unavailable.description.one":
    "{items} was just reserved by another buyer. Review your buy cart for seller options.",
  "checkout.features.sessions.ui.checkoutPage.reservation.unavailable.description.many":
    "{count} items were just reserved by another buyer. Review your buy cart for seller options.",
  "checkout.features.sessions.ui.checkoutPage.reserve.again": "Reserve again",
  "checkout.features.sessions.ui.checkoutPage.payment.starts.only.after.orders.are":
    "Payment starts only after final checkout review.",
  "checkout.features.sessions.ui.checkoutPage.guest.data.description":
    "Guest checkout contact and shipping details are used for this checkout, delivery, tax, security checks, and support. Card details stay in the secure payment step.",
  "checkout.features.sessions.ui.checkoutPage.platform.credit.only": "Platform credit only",
  "checkout.features.sessions.ui.checkoutPage.postal.code": "Postal code",
  "checkout.features.sessions.ui.checkoutPage.processing.payment": "Processing payment...",
  "checkout.features.sessions.ui.buyCheckoutConfirmationPage.eyebrow": "Secure checkout",
  "checkout.features.sessions.ui.buyCheckoutConfirmationPage.title": "Checkout received",
  "checkout.features.sessions.ui.buyCheckoutConfirmationPage.description":
    "Your checkout is ready for secure payment. Delivery and receipt updates appear after payment is complete.",
  "checkout.features.sessions.ui.buyCheckoutConfirmationPage.order.status": "Order status",
  "checkout.features.sessions.ui.buyCheckoutConfirmationPage.order.status.created": "Ready for payment",
  "checkout.features.sessions.ui.buyCheckoutConfirmationPage.order.status.pending": "Pending",
  "checkout.features.sessions.ui.buyCheckoutConfirmationPage.payment.handoff": "Secure payment",
  "checkout.features.sessions.ui.buyCheckoutConfirmationPage.payment.reference": "Payment reference",
  "checkout.features.sessions.ui.buyCheckoutConfirmationPage.payment.status": "Payment status",
  "checkout.features.sessions.ui.buyCheckoutConfirmationPage.payment.status.cancelled": "Payment cancelled",
  "checkout.features.sessions.ui.buyCheckoutConfirmationPage.payment.status.failed": "Payment needs attention",
  "checkout.features.sessions.ui.buyCheckoutConfirmationPage.payment.status.paid": "Paid",
  "checkout.features.sessions.ui.buyCheckoutConfirmationPage.payment.status.pending": "Payment pending",
  "checkout.features.sessions.ui.buyCheckoutConfirmationPage.payment.status.preparing": "Preparing payment",
  "checkout.features.sessions.ui.buyCheckoutConfirmationPage.payment.status.ready": "Payment ready",
  "checkout.features.sessions.ui.buyCheckoutConfirmationPage.payment.total": "Payment total",
  "checkout.features.sessions.ui.buyCheckoutConfirmationPage.payment.total.pending": "Pending",
  "checkout.features.sessions.ui.buyCheckoutConfirmationPage.summary": "Support summary",
  "checkout.features.sessions.ui.buyCheckoutConfirmationPage.summary.description":
    "These references help support find this checkout without exposing payment details.",
  "checkout.features.sessions.ui.checkoutPage.package.plan": "Package plan",
  "checkout.features.sessions.ui.checkoutPage.package.plan.value":
    "{packageCount} package{packagePlural} - {serviceLevel}",
  "checkout.features.sessions.ui.checkoutPage.preview.after.address": "Preview after address",
  "checkout.features.sessions.ui.checkoutPage.pricing": "Pricing",
  "checkout.features.sessions.ui.checkoutPage.priority": "Priority",
  "checkout.features.sessions.ui.checkoutPage.product": "Product",
  "checkout.features.sessions.ui.checkoutPage.purchase.intent": "Offer",
  "checkout.features.sessions.ui.checkoutPage.purchase.intent.review": "Offer review",
  "checkout.features.sessions.ui.checkoutPage.purchase.intent.review.description":
    "Your offer becomes marketplace-wide demand after you confirm shipping. No order or payment is created today.",
  "checkout.features.sessions.ui.checkoutPage.purchase.intent.review.items.description":
    "Review the product and quantity that will become marketplace-wide demand after shipping is confirmed.",
  "checkout.features.sessions.ui.checkoutPage.purchase.intent.shipping.notice.description":
    "Shipping is saved with the offer so sellers can evaluate fulfillment before accepting. No order, tax quote, or payment is created today.",
  "checkout.features.sessions.ui.checkoutPage.purchase.intent.saved": "Offer saved",
  "checkout.features.sessions.ui.checkoutPage.purchases.have.been.created.and.payment":
    "Your order is ready for payment. Delivery and receipt updates appear after payment is complete.",
  "checkout.features.sessions.ui.checkoutPage.quantity": "Quantity",
  "checkout.features.sessions.ui.checkoutPage.ready.to.place.purchase.intent": "Ready to submit offer",
  "checkout.features.sessions.ui.checkoutPage.ready.to.review.payment": "Ready to review payment",
  "checkout.features.sessions.ui.checkoutPage.recipient.name": "Recipient name",
  "checkout.features.sessions.ui.checkoutPage.recipient.placeholder": "Jane Smith",
  "checkout.features.sessions.ui.checkoutPage.refresh.totals": "Refresh totals",
  "checkout.features.sessions.ui.checkoutPage.required": "required",
  "checkout.features.sessions.ui.checkoutPage.reason.order.value": "order value",
  "checkout.features.sessions.ui.checkoutPage.reason.package.fit": "package fit",
  "checkout.features.sessions.ui.checkoutPage.reason.product.type": "product type",
  "checkout.features.sessions.ui.checkoutPage.reason.shipping.option": "shipping option",
  "checkout.features.sessions.ui.checkoutPage.review.latest.total": "Review latest total",
  "checkout.features.sessions.ui.checkoutPage.review.updated": "Review updated",
  "checkout.features.sessions.ui.checkoutPage.review.updated.description":
    "Your latest shipping, destination, and payment selections are reflected in this review.",
  "checkout.features.sessions.ui.checkoutPage.review.items": "Review Items",
  "checkout.features.sessions.ui.checkoutPage.review.buy.cart": "Review buy cart",
  "checkout.features.sessions.ui.checkoutPage.review.payment.total": "Review payment total",
  "checkout.features.sessions.ui.checkoutPage.reviewed.before.payment": "Reviewed before payment",
  "checkout.features.sessions.ui.checkoutPage.secure.checkout": "Secure Checkout",
  "checkout.features.sessions.ui.checkoutPage.secure.checkout.context": "Secure payment starts after this review.",
  "checkout.features.sessions.ui.checkoutPage.secure.payment": "Secure Payment",
  "checkout.features.sessions.ui.checkoutPage.payment.handoff.title": "Payment step",
  "checkout.features.sessions.ui.checkoutPage.payment.handoff.description":
    "Continue to secure payment without resubmitting checkout.",
  "checkout.features.sessions.ui.checkoutPage.account.fulfillment.pending.title": "Next steps pending",
  "checkout.features.sessions.ui.checkoutPage.account.fulfillment.pending.description":
    "Delivery and receipt updates appear after payment is complete.",
  "checkout.features.sessions.ui.checkoutPage.support.reference": "Support reference",
  "checkout.features.sessions.ui.checkoutPage.support.reference.ready.title": "Support reference ready",
  "checkout.features.sessions.ui.checkoutPage.support.reference.ready.description":
    "Share the support reference if payment or order details need help.",
  "checkout.features.sessions.ui.checkoutPage.sellers.can.accept.purchase.intent.before.order":
    "Sellers can accept your offer before an order and payment are created.",
  "checkout.features.sessions.ui.checkoutPage.shipping": "Shipping",
  "checkout.features.sessions.ui.checkoutPage.shipping.after.address": "Shipping updates after address",
  "checkout.features.sessions.ui.checkoutPage.shipping.after.address.description":
    "Enter a destination and update totals to review shipping, tax, and payment details.",
  "checkout.features.sessions.ui.checkoutPage.shipping.method": "Shipping method",
  "checkout.features.sessions.ui.checkoutPage.shipping.method.description":
    "Choose the delivery speed for this checkout.",
  "checkout.features.sessions.ui.checkoutPage.ships.from": "Ships from",
  "checkout.features.sessions.ui.checkoutPage.shipping.option": "Shipping option",
  "checkout.features.sessions.ui.checkoutPage.shipping.preference.is.captured.before.order":
    "Shipping preference is captured before order creation.",
  "checkout.features.sessions.ui.checkoutPage.shipping.preference.is.captured.for.purchase.intent":
    "Shipping preference is captured for seller acceptance.",
  "checkout.features.sessions.ui.checkoutPage.source": "Source",
  "checkout.features.sessions.ui.checkoutPage.standard": "Standard",
  "checkout.features.sessions.ui.checkoutPage.standard.insured": "Standard insured",
  "checkout.features.sessions.ui.checkoutPage.subtotal": "Subtotal",
  "checkout.features.sessions.ui.checkoutPage.state": "State",
  "checkout.features.sessions.ui.checkoutPage.use.balance": "Use balance",
  "checkout.features.sessions.ui.checkoutPage.wallet.credit": "Wallet credit",
  "checkout.features.sessions.ui.checkoutPage.transparent.totals": "Transparent totals before payment",
  "checkout.features.sessions.ui.checkoutPage.transparent.totals.description":
    "Shipping, taxes, service charges, and available balance credits are reviewed before the secure payment step.",
  "checkout.features.sessions.ui.checkoutPage.totals.need.refresh": "Totals need refresh",
  "checkout.features.sessions.ui.checkoutPage.totals.need.refresh.description":
    "Update totals to review the latest shipping, tax, fee, and payment details before payment starts.",
  "checkout.features.sessions.ui.checkoutPage.total": "Total",
  "checkout.features.sessions.ui.checkoutPage.no.payment.today": "No payment today",
  "checkout.features.sessions.ui.checkoutPage.no.available.supply": "No available supply",
  "checkout.features.sessions.ui.checkoutPage.place.purchase.intent": "Submit offer",
  "checkout.features.sessions.ui.checkoutPage.pay.now": "Pay now",
  "checkout.features.sessions.ui.checkoutPage.pay.now.with.saved.payment": "Pay now with {paymentMethodCategory}",
  "checkout.features.sessions.ui.checkoutPage.pending": "Pending",
  "checkout.features.sessions.ui.checkoutPage.placing.purchase.intent": "Submitting offer",
  "checkout.features.sessions.ui.checkoutPage.order.summary": "Order summary",
  "checkout.features.sessions.ui.checkoutPage.item.count": "{count} items",
  "checkout.features.sessions.ui.checkoutPage.quantity.summary": "Qty {quantity}",
  "checkout.features.sessions.ui.checkoutPage.not.applicable": "Not applicable",
  "checkout.features.sessions.ui.checkoutPage.calculated.before.payment": "Calculated before payment",
  "checkout.features.sessions.ui.checkoutPage.checkout.needs.cart.review": "Review your buy cart first",
  "checkout.features.sessions.ui.checkoutPage.checkout.needs.cart.review.description":
    "{count} item(s) changed fulfillment or availability. Resolve them in the cart before checkout continues.",
  "checkout.features.sessions.ui.checkoutPage.simple.checkout.description":
    "Enter contact, delivery, shipping, and payment details before secure payment starts.",
  "checkout.features.sessions.ui.checkoutPage.signed.in.checkout.description":
    "Review saved checkout details, edit anything needed, and pay securely.",
  "checkout.features.sessions.ui.checkoutPage.update.totals": "Update totals",
  "checkout.features.sessions.ui.checkoutPage.all.transactions.secure": "All transactions are secure and encrypted.",
  "checkout.features.sessions.ui.checkoutPage.saved.checkout.details": "Checkout details",
  "checkout.features.sessions.ui.checkoutPage.ready": "Ready",
  "checkout.features.sessions.ui.checkoutPage.review.required": "Review required",
  "checkout.features.sessions.ui.checkoutPage.ship.to": "Ship to",
  "checkout.features.sessions.ui.checkoutPage.edit.contact": "Edit contact",
  "checkout.features.sessions.ui.checkoutPage.edit.delivery": "Edit delivery",
  "checkout.features.sessions.ui.checkoutPage.edit.shipping": "Edit shipping",
  "checkout.features.sessions.ui.checkoutPage.edit.payment": "Edit payment",
  "checkout.features.sessions.ui.checkoutPage.contact.row.supporting": "Receipt and delivery updates",
  "checkout.features.sessions.ui.checkoutPage.contact.row.supporting.phone": "Receipt and delivery updates / {phone}",
  "checkout.features.sessions.ui.checkoutPage.saved.payment.row.supporting.fast": "Ready for secure one-step payment.",
  "checkout.features.sessions.ui.checkoutPage.saved.payment.row.supporting.secure.step":
    "Uses the secure payment step before authorization.",
  "checkout.features.sessions.ui.checkoutPage.saved.payment.step.ready": "Saved payment ready",
  "checkout.features.sessions.ui.checkoutPage.saved.payment.step.ready.description":
    "{addressLabel} and {paymentMethodCategory} are ready. This payment method still uses the secure payment step before authorization.",
  "checkout.features.sessions.ui.checkoutPage.saved.payment": "Saved payment",
  "checkout.features.sessions.ui.checkoutPage.default.saved.payment.option": "{label} (default)",
  "checkout.features.sessions.ui.checkoutPage.shipping.saved.for.seller.acceptance":
    "Shipping is saved for seller acceptance.",
  "checkout.features.sessions.ui.checkoutPage.your.cart.is.empty": "Your buy cart is empty",
  "checkout.features.sellList.api.route.sell.list.request.failed": "Sell List request failed.",
  "checkout.features.sellList.api.route.offer.match.not.found": "Offer match not found.",
  "checkout.features.sellList.api.route.sell.list.confirmation.not.found": "Sell List confirmation not found.",
  "checkout.features.sellList.api.route.sell.list.confirmation.evidence.required":
    "Sell List confirmation requires current readiness, seller, and reviewed sale details.",
  "checkout.features.sellList.api.route.sell.list.readiness.snapshot.required":
    "Sell List readiness snapshot is required.",
  "checkout.features.sellList.api.route.sell.list.review.requires.seller.account":
    "Sell List review requires a seller account.",
  "checkout.features.sellList.api.route.anonymous.sell.list.limit.exceeded":
    "This device has {limit} Sell List lines saved. Remove an item before adding another.",
  "checkout.features.sellList.api.route.anonymous.request.rate.limited":
    "Too many anonymous Sell List requests. Wait a few minutes and try again.",
  "checkout.features.sellList.ui.sellListPage.add.selected.offers.or.products":
    "Add selected offers or products from item pages before reviewing seller checkout.",
  "checkout.features.sellList.ui.sellListPage.browse.products": "Browse products",
  "checkout.features.sellList.ui.sellListPage.buyer": "Buyer",
  "checkout.features.sellList.ui.sellListPage.checkout": "Checkout",
  "checkout.features.sellList.ui.sellListPage.checkout.issue": "Sell List issue",
  "checkout.features.sellList.ui.sellListPage.choose.sale.action.before.checkout":
    "Choose a ready offer or listing action before seller checkout.",
  "checkout.features.sellList.ui.sellListPage.create.account": "Create account",
  "checkout.features.sellList.ui.sellListPage.create.listing": "Create listing",
  "checkout.features.sellList.ui.sellListPage.create.listing.for.remaining": "Create listing for remaining quantity",
  "checkout.features.sellList.ui.sellListPage.create.matching.listing": "Create matching listing",
  "checkout.features.sellList.ui.sellListPage.choose.inventory": "Choose inventory",
  "checkout.features.sellList.ui.sellListPage.add.inventory": "Add inventory",
  "checkout.features.sellList.ui.sellListPage.estimated.payout": "Estimated payout",
  "checkout.features.sellList.ui.sellListPage.estimated.payout.aria": "View estimated payout details",
  "checkout.features.sellList.ui.sellListPage.estimated.payout.facts": "Payout facts",
  "checkout.features.sellList.ui.sellListPage.estimated.payout.summary": "Estimated payout uses {source}.",
  "checkout.features.sellList.ui.sellListPage.final.registered.payout": "Final registered payout",
  "checkout.features.sellList.ui.sellListPage.final.terms.source": "Final terms source",
  "checkout.features.sellList.ui.sellListPage.expected.payout.before.checkout":
    "Expected payout before seller checkout",
  "checkout.features.sellList.ui.sellListPage.fallback.listing.ready.detail":
    "Inventory and listing price are ready for the remaining quantity.",
  "checkout.features.sellList.ui.sellListPage.fallback.listing.form.ready.detail":
    "Inventory is ready. Enter a listing price before continuing seller checkout.",
  "checkout.features.sellList.ui.sellListPage.inventory": "Inventory",
  "checkout.features.sellList.ui.sellListPage.inventory.option.label": "{location} / {shipFrom} ({quantity})",
  "checkout.features.sellList.ui.sellListPage.inventory.required": "Inventory required",
  "checkout.features.sellList.ui.sellListPage.items": "Items",
  "checkout.features.sellList.ui.sellListPage.keep.selling": "Keep selling",
  "checkout.features.sellList.ui.sellListPage.keep.in.sell.list": "Keep in Sell List",
  "checkout.features.sellList.ui.sellListPage.keep.remaining.in.sell.list": "Keep remaining quantity in Sell List",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.accepted.offers": "Accepted offers",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.action": "Action",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.line.outcomes": "Confirmed items",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.listings.published": "Listings published",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.notice.description":
    "Keep this reference while your sale, label, payout, and updates finish.",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.notice.title": "Seller confirmation saved",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.open.support": "Open support",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.quantity": "Quantity",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.recorded": "Recorded",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.reference": "Confirmation",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.reference.downstream":
    "Related sale references are available if support needs them.",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.reference.pending": "reference pending",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.remaining": "Remaining",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.side.effect.account.history": "Account history",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.side.effect.label": "Label",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.side.effect.notification": "Notification",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.side.effect.payout": "Payout",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.side.effect.sale": "Sale",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.side.effect.settlement": "Settlement",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.accepted.offer": "Accepted offer",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.accepted.smart.match": "Accepted Smart Match",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.completed": "Completed",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.failed": "Failed",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.handoff.recorded": "Sale review saved",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.kept.in.sell.list": "Kept in Sell List",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.mixed": "Mixed",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.not.attempted": "Not attempted",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.partial": "Partial",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.pending.downstream": "Next steps pending",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.published.listing": "Published listing",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.skipped": "Skipped",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.support.references": "Support references",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.title": "Latest seller confirmation",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.view.committed.sales": "View sales",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.view.sale.shipments": "View sale shipments",
  "checkout.features.sellList.ui.sellListPage.latest.confirmation.view.seller.activity": "View seller activity",
  "checkout.features.sellList.ui.sellListPage.line.readiness": "Line readiness",
  "checkout.features.sellList.ui.sellListPage.listing.price": "Listing price",
  "checkout.features.sellList.ui.sellListPage.matching.offers": "Matching offers",
  "checkout.features.sellList.ui.sellListPage.matching.offer.quantity": "{quantity} ready to accept",
  "checkout.features.sellList.ui.sellListPage.minimum.listing.price": "Minimum listing price",
  "checkout.features.sellList.ui.sellListPage.needs.refresh": "Needs refresh",
  "checkout.features.sellList.ui.sellListPage.needs.action": "Needs action",
  "checkout.features.sellList.ui.sellListPage.no.commitment.until.review":
    "No seller commitment starts until this review is continued.",
  "checkout.features.sellList.ui.sellListPage.no.ready.matching.offers": "No ready matching offers",
  "checkout.features.sellList.ui.sellListPage.no.smart.match.offers.available":
    "No ready Smart Match offers are available for this line.",
  "checkout.features.sellList.ui.sellListPage.payout.readiness": "Payout readiness",
  "checkout.features.sellList.ui.sellListPage.payout.setup.is.checked.before":
    "Payout setup and settlement readiness stay visible before accepting sale commitments.",
  "checkout.features.sellList.ui.sellListPage.payout.setup.required": "Payout setup required",
  "checkout.features.sellList.ui.sellListPage.set.up.payouts": "Set up payouts",
  "checkout.features.sellList.ui.sellListPage.setup.required": "Setup required",
  "checkout.features.sellList.ui.sellListPage.payout.setup.required.description":
    "Resolve payout requirements before accepting offers or creating fallback listings: {requirements}.",
  "checkout.features.sellList.ui.sellListPage.payout.readiness.unavailable.description":
    "Payout readiness could not be loaded. Refresh payout setup before accepting offers or creating fallback listings.",
  "checkout.features.sellList.ui.sellListPage.public.standard.offer.preview.ready.detail":
    "Estimated payout is ready using current standard seller terms. Create an account to review final terms before committing.",
  "checkout.features.sellList.ui.sellListPage.public.standard.terms.line1":
    "This estimate uses public standard seller terms because no seller account is attached yet.",
  "checkout.features.sellList.ui.sellListPage.public.standard.terms.line2":
    "After registration, Checkout refreshes seller-specific terms before any offer acceptance or sale commitment.",
  "checkout.features.sellList.ui.sellListPage.quantity": "Quantity",
  "checkout.features.sellList.ui.sellListPage.quote.time": "Quote time",
  "checkout.features.sellList.ui.sellListPage.offer": "Offer",
  "checkout.features.sellList.ui.sellListPage.offer.terms.need.refresh":
    "Refresh this line before seller checkout so the offer terms are current.",
  "checkout.features.sellList.ui.sellListPage.no.change": "No change",
  "checkout.features.sellList.ui.sellListPage.payout.change": "Payout change",
  "checkout.features.sellList.ui.sellListPage.registered.terms.line1":
    "Seller checkout revalidates the current fee quote before committing a sale.",
  "checkout.features.sellList.ui.sellListPage.refresh.needed": "Refresh needed",
  "checkout.features.sellList.ui.sellListPage.refresh.sell.list": "Refresh Sell List",
  "checkout.features.sellList.ui.sellListPage.ready": "Ready",
  "checkout.features.sellList.ui.sellListPage.ready.for.seller.checkout": "Ready for seller checkout",
  "checkout.features.sellList.ui.sellListPage.ready.for.seller.checkout.description":
    "Every line has a pre-checkout sale action and payout setup is ready.",
  "checkout.features.sellList.ui.sellListPage.review.sell.list": "Review Sell List",
  "checkout.features.sellList.ui.sellListPage.readiness.needs.action": "{count} need action",
  "checkout.features.sellList.ui.sellListPage.readiness.ready": "{count} ready",
  "checkout.features.sellList.ui.sellListPage.remaining.quantity.action": "Remaining quantity action",
  "checkout.features.sellList.ui.sellListPage.remove": "Remove",
  "checkout.features.sellList.ui.sellListPage.registration.return.merge.issue.title": "Sell List needs review",
  "checkout.features.sellList.ui.sellListPage.registration.return.merged.description":
    "{count} Sell List line(s) moved to your account. Review final seller terms, payout setup, and ship-from details before continuing.",
  "checkout.features.sellList.ui.sellListPage.registration.return.merged.title": "Sell List saved to your account",
  "checkout.features.sellList.ui.sellListPage.registration.return.review.description":
    "Your account is ready. Review final seller terms, payout setup, and ship-from details before continuing.",
  "checkout.features.sellList.ui.sellListPage.registration.return.review.title": "Review final seller details",
  "checkout.features.sellList.ui.sellListPage.resolve.before.seller.checkout":
    "Resolve {count} line(s) before seller checkout starts.",
  "checkout.features.sellList.ui.sellListPage.resolve.items": "Resolve items",
  "checkout.features.sellList.ui.sellListPage.review.items": "Review items",
  "checkout.features.sellList.ui.sellListPage.expected.seller.payout": "Expected seller payout",
  "checkout.features.sellList.ui.sellListPage.future.listing.gross": "Future listing gross",
  "checkout.features.sellList.ui.sellListPage.estimated.sales.fees": "Estimated sales fees",
  "checkout.features.sellList.ui.sellListPage.account.gate.description":
    "Your Sell List is saved on this device. Create an account before offer acceptance, listing publication, payout, or shipping label work starts.",
  "checkout.features.sellList.ui.sellListPage.account.gate.title": "Create an account to continue seller checkout",
  "checkout.features.sellList.ui.sellListPage.create.account.to.continue": "Create account to continue",
  "checkout.features.sellList.ui.sellListPage.simple.review.description":
    "Review cards, payout readiness, and pre-checkout sale actions before seller checkout.",
  "checkout.features.sellList.ui.sellListPage.sale.checkout.summary": "Sale checkout summary",
  "checkout.features.sellList.ui.sellListPage.sale.review.before.commitment":
    "Review sale value, payout readiness, and fulfillment before commitment.",
  "checkout.features.sellList.ui.sellListPage.saved.for.later.description":
    "Keep adding products while signed out. Create an account when you are ready to review sale checkout, accept offers, create listings, and set up payouts.",
  "checkout.features.sellList.ui.sellListPage.saved.for.later.title": "Sell List saved on this device",
  "checkout.features.sellList.ui.sellListPage.seller.checkout.readiness": "Seller checkout readiness",
  "checkout.features.sellList.ui.sellListPage.seller.checkout.readiness.description":
    "Checkout receives only ready Sell List lines. Item eligibility, sale action, payout, ship-from, and label readiness stay before seller checkout.",
  "checkout.features.sellList.ui.sellListPage.seller.specific.terms": "Seller-specific terms",
  "checkout.features.sellList.ui.sellListPage.selected.offer": "Selected offer",
  "checkout.features.sellList.ui.sellListPage.selected.offer.ready.detail":
    "Offer terms are current and ready for seller checkout.",
  "checkout.features.sellList.ui.sellListPage.selected.offer.gross": "Selected offer gross",
  "checkout.features.sellList.ui.sellListPage.sales.fee": "Sales fee",
  "checkout.features.sellList.ui.sellListPage.sell.list": "Sell List",
  "checkout.features.sellList.ui.sellListPage.sell.list.lines": "Sell List lines",
  "checkout.features.sellList.ui.sellListPage.sell.list.update.pending": "Updating Sell List",
  "checkout.features.sellList.ui.sellListPage.sell.list.update.pending.title": "Your Sell List is catching up",
  "checkout.features.sellList.ui.sellListPage.sell.list.update.refreshing": "Refreshing Sell List",
  "checkout.features.sellList.ui.sellListPage.sell.list.update.missing.title": "Sell List line not visible yet",
  "checkout.features.sellList.ui.sellListPage.seller.net": "Seller net",
  "checkout.features.sellList.ui.sellListPage.ship.from.inventory": "Ship-from inventory",
  "checkout.features.sellList.ui.sellListPage.shipping.allowance": "Shipping allowance",
  "checkout.features.sellList.ui.sellListPage.sign.in": "Sign in",
  "checkout.features.sellList.ui.sellListPage.sign.in.required": "Sign in required",
  "checkout.features.sellList.ui.sellListPage.sign.in.to.review.sale.checkout":
    "Create an account or sign in to review sale checkout, confirm inventory, accept offers, create listings, and continue payout setup.",
  "checkout.features.sellList.ui.sellListPage.smart.match.ready.detail":
    "{count} ready Smart Match offer(s) can be used before seller checkout.",
  "checkout.features.sellList.ui.sellListPage.smart.match.seller.net": "Smart Match seller net",
  "checkout.features.sellList.ui.sellListPage.some.items.need.action": "Some items need action",
  "checkout.features.sellList.ui.sellListPage.standard": "Standard",
  "checkout.features.sellList.ui.sellListPage.standard.estimate": "Standard estimate",
  "checkout.features.sellList.ui.sellListPage.standard.estimate.comparison": "Standard estimate comparison",
  "checkout.features.sellList.ui.sellListPage.standard.terms": "Standard terms",
  "checkout.features.sellList.ui.sellListPage.terms.source": "Terms source",
  "checkout.features.sellList.ui.sellListPage.terms.comparison.better.line":
    "Final registered payout is higher than the standard estimate. Review the difference before continuing.",
  "checkout.features.sellList.ui.sellListPage.terms.comparison.changed.inline":
    "Final terms changed from the standard estimate. Review payout details before continuing.",
  "checkout.features.sellList.ui.sellListPage.terms.comparison.changed.line":
    "Final registered terms changed from the standard estimate. Review the difference before continuing.",
  "checkout.features.sellList.ui.sellListPage.terms.comparison.final.unavailable.inline":
    "Final terms could not be refreshed. Refresh this line before continuing.",
  "checkout.features.sellList.ui.sellListPage.terms.comparison.final.unavailable.line":
    "Final registered terms could not be refreshed. Return to the Sell List and refresh before seller checkout.",
  "checkout.features.sellList.ui.sellListPage.terms.comparison.same.line":
    "Final registered terms match the standard estimate.",
  "checkout.features.sellList.ui.sellListPage.terms.comparison.standard.unavailable.line":
    "The standard estimate could not be rebuilt for comparison. Final registered terms are shown.",
  "checkout.features.sellList.ui.sellListPage.terms.comparison.worse.line":
    "Final registered payout is lower than the standard estimate. Review the difference before continuing.",
  "checkout.features.sellList.ui.sellListPage.just.now": "Just now",
  "checkout.features.sellList.ui.sellListPage.continue.to.seller.checkout": "Continue to seller checkout",
  "checkout.features.sellList.ui.sellListPage.pre.checkout.action": "Pre-checkout action",
  "checkout.features.sellList.ui.guestSellCheckoutPage.eyebrow": "Seller checkout",
  "checkout.features.sellList.ui.guestSellCheckoutPage.title": "Review sale checkout",
  "checkout.features.sellList.ui.guestSellCheckoutPage.description":
    "Confirm contact, ship-from, payout setup, and label preferences before the final sale step.",
  "checkout.features.sellList.ui.guestSellCheckoutPage.back.to.sell.list": "Back to Sell List",
  "checkout.features.sellList.ui.guestSellCheckoutPage.back": "Back",
  "checkout.features.sellList.ui.guestSellCheckoutPage.review.sell.list": "Review Sell List",
  "checkout.features.sellList.ui.guestSellCheckoutPage.review.sale": "Continue to account setup",
  "checkout.features.sellList.ui.guestSellCheckoutPage.fix.details": "Fix seller checkout details",
  "checkout.features.sellList.ui.guestSellCheckoutPage.standard": "Standard",
  "checkout.features.sellList.ui.guestSellCheckoutPage.summary.title": "Sale summary",
  "checkout.features.sellList.ui.guestSellCheckoutPage.summary.subtitle": "{count} ready line(s)",
  "checkout.features.sellList.ui.guestSellCheckoutPage.summary.status": "Ready",
  "checkout.features.sellList.ui.guestSellCheckoutPage.summary.selected.offer": "Selected offer",
  "checkout.features.sellList.ui.guestSellCheckoutPage.summary.product.line": "Product line",
  "checkout.features.sellList.ui.guestSellCheckoutPage.summary.items": "Items",
  "checkout.features.sellList.ui.guestSellCheckoutPage.summary.lines": "Lines",
  "checkout.features.sellList.ui.guestSellCheckoutPage.summary.readiness": "Readiness",
  "checkout.features.sellList.ui.guestSellCheckoutPage.summary.ready": "Ready",
  "checkout.features.sellList.ui.guestSellCheckoutPage.summary.needs.review": "Needs review",
  "checkout.features.sellList.ui.guestSellCheckoutPage.summary.estimated.payout": "Estimated payout",
  "checkout.features.sellList.ui.guestSellCheckoutPage.summary.reassurance":
    "Offers, listings, labels, payout, notifications, and seller history wait until account setup is complete.",
  "checkout.features.sellList.ui.guestSellCheckoutPage.mobile.summary": "Sale summary",
  "checkout.features.sellList.ui.guestSellCheckoutPage.mobile.summary.collapsed": "{count} ready line(s)",
  "checkout.features.sellList.ui.guestSellCheckoutPage.sticky.context": "Final sale steps come after account setup.",
  "checkout.features.sellList.ui.guestSellCheckoutPage.contact.title": "Contact",
  "checkout.features.sellList.ui.guestSellCheckoutPage.contact.description":
    "Use the contact details you want attached to this sale review.",
  "checkout.features.sellList.ui.guestSellCheckoutPage.seller.name": "Seller name",
  "checkout.features.sellList.ui.guestSellCheckoutPage.email": "Email",
  "checkout.features.sellList.ui.guestSellCheckoutPage.phone": "Phone",
  "checkout.features.sellList.ui.guestSellCheckoutPage.ship.from.title": "Ship from",
  "checkout.features.sellList.ui.guestSellCheckoutPage.ship.from.description":
    "This address is checked before labels or sale commitments are prepared.",
  "checkout.features.sellList.ui.guestSellCheckoutPage.ship.from.name": "Ship-from name",
  "checkout.features.sellList.ui.guestSellCheckoutPage.company": "Company",
  "checkout.features.sellList.ui.guestSellCheckoutPage.address.line1": "Address line 1",
  "checkout.features.sellList.ui.guestSellCheckoutPage.address.line2": "Address line 2",
  "checkout.features.sellList.ui.guestSellCheckoutPage.city": "City",
  "checkout.features.sellList.ui.guestSellCheckoutPage.state": "State",
  "checkout.features.sellList.ui.guestSellCheckoutPage.postal.code": "Postal code",
  "checkout.features.sellList.ui.guestSellCheckoutPage.country": "Country",
  "checkout.features.sellList.ui.guestSellCheckoutPage.payout.title": "Payout",
  "checkout.features.sellList.ui.guestSellCheckoutPage.payout.description":
    "Guest sellers finish account and payout setup before money movement is enabled.",
  "checkout.features.sellList.ui.guestSellCheckoutPage.payout.method": "Payout setup",
  "checkout.features.sellList.ui.guestSellCheckoutPage.payout.create.account": "Create account and set up payout",
  "checkout.features.sellList.ui.guestSellCheckoutPage.label.title": "Label",
  "checkout.features.sellList.ui.guestSellCheckoutPage.label.description":
    "Choose how label preparation should be handled after account setup.",
  "checkout.features.sellList.ui.guestSellCheckoutPage.label.preference": "Label preference",
  "checkout.features.sellList.ui.guestSellCheckoutPage.label.prepaid": "Prepare a prepaid label after account setup",
  "checkout.features.sellList.ui.guestSellCheckoutPage.label.later": "Review label after account setup",
  "checkout.features.sellList.ui.guestSellCheckoutPage.terms.title": "Review",
  "checkout.features.sellList.ui.guestSellCheckoutPage.terms.description":
    "Confirm the sale facts before continuing to account setup.",
  "checkout.features.sellList.ui.guestSellCheckoutPage.terms.accept": "I reviewed the seller checkout details",
  "checkout.features.sellList.ui.guestSellCheckoutPage.terms.accept.description":
    "Final sale, labels, payout setup, and settlement are confirmed only after account setup.",
  "checkout.features.sellList.ui.guestSellCheckoutPage.side.effect.boundary":
    "You are only reviewing these sale details. Offers, listings, labels, payout, notifications, and seller history wait until account setup is complete.",
  "checkout.features.sellList.ui.guestSellCheckoutPage.guest.data.description":
    "Guest seller contact and ship-from details are used for this review, serviceability, account setup, and support. Sale, payout, and label steps wait for account setup.",
  "checkout.features.sellList.ui.guestSellCheckoutPage.recovery.missing.sell.list": "Sell List access expired",
  "checkout.features.sellList.ui.guestSellCheckoutPage.recovery.missing.sell.list.description":
    "Return to your Sell List to start seller checkout again.",
  "checkout.features.sellList.ui.guestSellCheckoutPage.recovery.empty.sell.list": "Your Sell List is empty",
  "checkout.features.sellList.ui.guestSellCheckoutPage.recovery.empty.sell.list.description":
    "Add a selected offer or product before seller checkout.",
  "checkout.features.sellList.ui.guestSellCheckoutPage.recovery.readiness.required": "Review Sell List first",
  "checkout.features.sellList.ui.guestSellCheckoutPage.recovery.readiness.required.description":
    "Seller checkout starts only from a current Sell List readiness snapshot.",
  "checkout.features.sellList.ui.guestSellCheckoutPage.recovery.readiness.stale": "Sell List changed",
  "checkout.features.sellList.ui.guestSellCheckoutPage.recovery.readiness.stale.description":
    "Refresh the Sell List review so payout and sale facts are current.",
  "checkout.features.sellList.ui.guestSellCheckoutPage.recovery.readiness.blocked": "Some items need attention",
  "checkout.features.sellList.ui.guestSellCheckoutPage.recovery.readiness.blocked.description":
    "Resolve item eligibility, sale action, ship-from, label, or payout readiness before seller checkout.",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.eyebrow": "Seller checkout",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.title": "Review sale checkout",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.description":
    "Confirm saved seller details before the final sale step.",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.back.to.sell.list": "Back to Sell List",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.back": "Back",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.review.sell.list": "Review Sell List",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.review.sale": "Review sale details",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.fix.details": "Fix seller checkout details",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.ready": "Ready",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.review.required": "Review required",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.standard": "Standard",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.saved.title": "Seller checkout details",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.edit.section": "Edit {section}",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.edit.contact": "Edit contact",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.edit.ship.from": "Edit ship-from",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.edit.payout": "Edit payout",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.edit.label": "Edit label",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.summary.title": "Sale summary",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.summary.subtitle": "{count} ready line(s)",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.summary.status": "Ready",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.summary.selected.offer": "Selected offer",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.summary.product.line": "Product line",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.summary.items": "Items",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.summary.lines": "Lines",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.summary.readiness": "Readiness",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.summary.ready": "Ready",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.summary.needs.review": "Needs review",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.summary.estimated.payout": "Estimated payout",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.summary.reassurance":
    "{quantity} item(s). Offers, listings, labels, payout, notifications, and seller history wait until you confirm.",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.view.committed.sales": "View sales",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.view.seller.activity": "View seller activity",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.mobile.summary": "Sale summary",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.mobile.summary.collapsed": "{count} ready line(s)",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.sticky.context": "Final sale steps come after this review.",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.contact.title": "Contact",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.contact.description":
    "Use the seller contact details attached to this sale review.",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.contact.supporting": "Sale and label updates",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.contact.supporting.phone": "Sale and label updates / {phone}",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.seller.name": "Seller name",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.email": "Email",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.phone": "Phone",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.ship.from.title": "Ship from",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.ship.from.description":
    "Choose the saved address used for label and serviceability review.",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.saved.ship.from": "Saved ship-from address",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.enter.new.ship.from": "Enter a new ship-from address",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.default.ship.from.option": "{label} (default)",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.ship.from.name": "Ship-from name",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.company": "Company",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.address.line1": "Address line 1",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.address.line2": "Address line 2",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.city": "City",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.state": "State",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.postal.code": "Postal code",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.country": "Country",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.payout.title": "Payout",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.payout.description":
    "Use the saved payout setup for this seller account.",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.payout.method": "Payout method",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.payout.saved": "Saved payout setup",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.payout.setup": "Update payout setup",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.payout.ready": "Saved payout setup",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.payout.ready.description":
    "Ready for seller payout after sale verification.",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.payout.needs.setup": "Payout setup needs attention",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.payout.needs.setup.description":
    "Resolve payout setup before the final sale step: {requirements}.",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.payout.unavailable": "Payout setup unavailable",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.payout.unavailable.description":
    "Payout readiness could not be loaded. Refresh payout setup before seller checkout.",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.seller.readiness.title": "Seller readiness",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.seller.readiness.ready": "Seller account ready",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.seller.readiness.needs.review": "Seller account needs review",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.seller.readiness.detail":
    "Risk and account status are checked before the final sale step.",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.label.title": "Label",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.label.description":
    "Choose how label preparation should be handled after review.",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.label.row.supporting":
    "Label serviceability is checked before purchase.",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.label.preference": "Label preference",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.label.prepaid": "Prepare a prepaid label",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.label.later": "Review label later",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.terms.title": "Review",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.terms.description":
    "Confirm the sale facts before continuing.",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.terms.accept":
    "I reviewed the final seller terms, payout, ship-from, and sale details",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.terms.accept.description":
    "Offer acceptance, listing publication, labels, payout, settlement, and notifications start only after you confirm this review.",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.side.effect.boundary":
    "You are only reviewing sale details. Offers, listings, labels, payout, notifications, and seller history wait until confirmation.",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.confirmation.title": "Sale review saved",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.confirmation.description":
    "Your reviewed sale actions are saved. We will update labels, payout, and sales activity as they finish.",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.confirmation.reference": "Confirmation reference",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.confirmation.support.reference": "Support reference",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.confirmation.sale.title": "Sale actions",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.confirmation.sale.description":
    "Accepted offers and reviewed fallback listings use the Sell List plan you confirmed.",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.confirmation.label.title": "Next steps",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.confirmation.label.description":
    "We will update labels, payout, and sales activity as they finish.",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.confirmation.side.effects.title": "Support reference ready",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.confirmation.side.effects.description":
    "Use this reference if any next step needs help.",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.recovery.access.required": "Sign in required",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.recovery.access.required.description":
    "Sign in with the seller account that started this checkout.",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.recovery.missing.sell.list": "Sell List access expired",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.recovery.missing.sell.list.description":
    "Return to your Sell List to start seller checkout again.",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.recovery.empty.sell.list": "Your Sell List is empty",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.recovery.empty.sell.list.description":
    "Add a selected offer or product before seller checkout.",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.recovery.readiness.required": "Review Sell List first",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.recovery.readiness.required.description":
    "Seller checkout starts only from a current Sell List readiness snapshot.",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.recovery.readiness.stale": "Sell List changed",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.recovery.readiness.stale.description":
    "Refresh the Sell List review so payout and sale facts are current.",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.recovery.readiness.blocked": "Some items need attention",
  "checkout.features.sellList.ui.signedInSellCheckoutPage.recovery.readiness.blocked.description":
    "Resolve item eligibility, sale action, ship-from, label, or payout readiness before seller checkout.",
  "checkout.features.sellList.ui.sellListPage.product.line": "Product",
  "checkout.features.sellList.ui.sellListPage.use.smart.match.offer": "Use {buyer} offer",
  "checkout.features.sellList.ui.sellListPage.use.smart.match.offer.description":
    "{quantity} item(s), estimated seller payout {sellerNet}.",
  "checkout.features.sellList.ui.sellListPage.sales.fee.change": "Sales fee change",
  "checkout.features.sellList.ui.sellListPage.shipping.allowance.change": "Shipping allowance change",
  "checkout.features.sellList.ui.sellListPage.unavailable": "Unavailable",
  "checkout.features.sellList.ui.sellListPage.your.sell.list.is.empty": "Your Sell List is empty",
  "checkout.routes.accountCart.cart.marketplace": "Buy Cart | Marketplace",
  "checkout.routes.accountCart.adding.item.description":
    "Your item was added. The Buy Cart is catching up before checkout continues.",
  "checkout.routes.accountCart.cart.missing.after.fresh.write":
    "The cart change was saved, but this cart view did not catch up in time. Refresh the cart or add the item again if it is still missing.",
  "checkout.routes.accountCart.cart.pending.fresh.write":
    "We saved your cart change and are refreshing the cart view. Your items will appear here as soon as checkout catches up.",
  "checkout.routes.accountCart.preferred.listing.missing": "Choose a preferred listing before locking this cart line.",
  "checkout.routes.accountCart.request.failed": "Request failed.",
  "checkout.routes.accountCart.review.cart.lines.adjust.quantity.and":
    "Review Buy Cart lines, adjust quantity, and start checkout.",
  "checkout.routes.accountSellList.review.selected.offers.and.product.level":
    "Review selected offers and product-level seller intent before checkout creates sale commitments.",
  "checkout.routes.accountSellList.sell.list.chase.sets": "Sell List | Chase Sets",
  "checkout.routes.accountSellList.sell.list.pending.fresh.write":
    "Your Sell List is updating. Refresh in a moment if the new line is not visible yet.",
  "checkout.routes.accountSellList.seller.confirmation.pending.fresh.write":
    "Your seller confirmation is still being saved. Refresh while Chase Sets finishes saving the current sale review.",
  "checkout.routes.accountSellList.sell.list.missing.after.fresh.write":
    "We saved the Sell List request, but the new line is still not visible. Refresh the Sell List or add the offer or product again from the marketplace.",
  "checkout.routes.accountSellList.sell.list.request.failed": "Sell List request failed.",
  "checkout.routes.accountSellList.sell.list.readiness.must.be.resolved":
    "Resolve Sell List readiness before seller checkout starts.",
  "checkout.routes.accountSellList.matching.offers.do.not.cover.quantity.detail":
    "{itemTitle}: matching offers do not cover the requested quantity.",
  "checkout.routes.accountSellList.no.sale.action.completed.detail": "{itemTitle}: no sale action completed.",
  "checkout.routes.accountSellList.offer.accept.failed": "offer accept failed",
  "checkout.routes.accountSellList.offer.accept.failed.detail": "{itemTitle}: {message}",
  "checkout.routes.accountSellList.offer.terms.need.refresh.detail": "{itemTitle}: offer terms need refresh.",
  "checkout.routes.accountSellList.sale.action.completed.detail":
    "{itemTitle}: {acceptedQuantity} matched offer quantity and {listingQuantity} fallback listing quantity completed.",
  "checkout.routes.accountSellList.sale.action.partial.detail":
    "{itemTitle}: {executedQuantity} quantity confirmed; {remainingQuantity} remains in the Sell List.",
  "checkout.routes.accountSellList.selected.offer.accepted.detail": "{itemTitle}: selected offer accepted.",
  "checkout.routes.accountSellList.selected.offer.missing.detail": "{itemTitle}: selected offer is missing.",
  "checkout.routes.sellCheckoutSession.meta.title": "Seller Checkout | Chase Sets",
  "checkout.routes.sellCheckoutSession.meta.description":
    "Review guest seller contact, ship-from, payout setup, label preference, and sale readiness.",
  "checkout.routes.sellCheckoutSession.readiness.unavailable":
    "Sell List readiness could not be refreshed. Return to the Sell List and try again.",
  "checkout.routes.sellCheckoutSession.validation.seller.name.required": "Enter the seller name.",
  "checkout.routes.sellCheckoutSession.validation.email.required": "Enter a valid email address.",
  "checkout.routes.sellCheckoutSession.validation.ship.from.name.required": "Enter the ship-from name.",
  "checkout.routes.sellCheckoutSession.validation.address.line1.required": "Enter address line 1.",
  "checkout.routes.sellCheckoutSession.validation.city.required": "Enter the ship-from city.",
  "checkout.routes.sellCheckoutSession.validation.state.required": "Enter the ship-from state.",
  "checkout.routes.sellCheckoutSession.validation.state.unsupported":
    "This ship-from region is not supported for guest seller checkout yet.",
  "checkout.routes.sellCheckoutSession.validation.postal.code.required": "Enter the ship-from postal code.",
  "checkout.routes.sellCheckoutSession.validation.country.unsupported":
    "Guest seller checkout currently supports US ship-from addresses.",
  "checkout.routes.sellCheckoutSession.validation.signed.in.state.unsupported":
    "This ship-from region is not supported for seller checkout yet.",
  "checkout.routes.sellCheckoutSession.validation.signed.in.country.unsupported":
    "Seller checkout currently supports US ship-from addresses.",
  "checkout.routes.sellCheckoutSession.validation.payout.handoff.required":
    "Create account and payout setup is required before the final sale step.",
  "checkout.routes.sellCheckoutSession.validation.payout.method.required": "Choose a payout method.",
  "checkout.routes.sellCheckoutSession.validation.label.preference.required": "Choose a label preference.",
  "checkout.routes.sellCheckoutSession.validation.terms.required":
    "Confirm that you reviewed the final seller terms and sale details.",
  "checkout.routes.sellCheckoutSession.validation.payout.setup.required":
    "Payout setup is required before seller checkout can continue.",
  "checkout.routes.sellCheckoutSession.validation.payout.failed":
    "Payout setup is temporarily unavailable. Try again after payout setup is ready.",
  "checkout.routes.sellCheckoutSession.validation.payout.changed":
    "The payout estimate changed. Return to the Sell List and refresh the review.",
  "checkout.routes.sellCheckoutSession.validation.risk.hold":
    "This sale review needs support review. Return to the Sell List for next steps.",
  "checkout.routes.sellCheckoutSession.validation.risk.block":
    "This sale review cannot continue. Return to the Sell List for support-safe recovery.",
  "checkout.routes.sellCheckoutSession.validation.label.failed":
    "Label readiness is unavailable. Refresh the Sell List before seller checkout.",
  "checkout.routes.sellCheckoutSession.validation.seller.readiness.failed":
    "Seller readiness needs review. Return to the Sell List before seller checkout.",
  "checkout.routes.sellCheckoutSession.validation.readiness.recovery":
    "Seller checkout readiness is no longer current.",
  "checkout.routes.sellCheckoutSession.validation.review.plan.required":
    "Return to the Sell List and refresh the reviewed sale plan before confirming.",
  "checkout.routes.sellCheckoutSession.confirmation.line.completed": "{itemTitle}: sale review recorded.",
  "checkout.routes.sellCheckoutSession.confirmation.line.partial":
    "{itemTitle}: sale review recorded for part of the line; remaining quantity stays in the Sell List.",
  "checkout.routes.checkoutSession.checkout.marketplace": "Checkout | Marketplace",
  "checkout.routes.checkoutSession.checkout.session.not.found": "Checkout session not found.",
  "checkout.routes.checkoutSession.checkout.session.not.found.2": "Checkout session not found.",
  "checkout.routes.checkoutSession.checkout.session.not.found.description": "We could not find this checkout session.",
  "checkout.routes.checkoutSession.checkout.access.required": "Checkout access required",
  "checkout.routes.checkoutSession.checkout.access.required.description":
    "We could not open this checkout because checkout access is not active in this browser.",
  "checkout.routes.checkoutSession.guest.checkout.access.expired": "Guest checkout access expired",
  "checkout.routes.checkoutSession.guest.checkout.access.expired.description":
    "This guest checkout link is no longer active.",
  "checkout.routes.checkoutSession.checkout.belongs.to.another.account": "Checkout belongs to another account",
  "checkout.routes.checkoutSession.checkout.belongs.to.another.account.description":
    "Sign in with the account that started this checkout, or start checkout again.",
  "checkout.routes.checkoutSession.checkout.unavailable": "Checkout unavailable",
  "checkout.routes.checkoutSession.checkout.unavailable.description": "We could not open this checkout.",
  "checkout.routes.checkoutSession.enter.contact.delivery.shipping.payment":
    "Enter contact, delivery, shipping, and payment details before secure payment starts.",
  "checkout.routes.checkoutSession.delivery.address.required": "Enter a shipping address before continuing to payment.",
  "checkout.routes.checkoutSession.delivery.address.unsupported":
    "Use a supported US delivery address before continuing to payment.",
  "checkout.routes.checkoutSession.delivery.address.restricted":
    "Use a street address before continuing to payment. PO boxes are not supported for this shipping service.",
  "checkout.routes.checkoutSession.shipping.option.unavailable":
    "Choose an available shipping method before continuing.",
  "checkout.routes.checkoutSession.fulfillment.preview.temporarily.unavailable":
    "Checkout totals are temporarily unavailable. Refresh before confirming payment.",
  "checkout.routes.checkoutSession.payment.has.not.started": "Your payment has not started.",
  "checkout.routes.checkoutSession.request.failed": "Request failed.",
  "checkout.routes.checkoutSession.secure.checkout": "Secure checkout",
  "checkout.routes.checkoutSession.sign.in.to.continue": "Sign in to continue",
  "checkout.routes.checkoutSession.start.checkout.again": "Start checkout again",
  "checkout.routes.buyCheckoutConfirmation.title": "Checkout received | Marketplace",
  "checkout.routes.buyCheckoutConfirmation.description": "Continue to the secure payment step for this checkout.",
  "checkout.routes.checkoutRecovery.browse.marketplace": "Browse marketplace",
  "checkout.routes.checkoutRecovery.buy.cart.empty": "Your Buy Cart is empty",
  "checkout.routes.checkoutRecovery.buy.cart.empty.description": "Add items to your Buy Cart before starting checkout.",
  "checkout.routes.checkoutRecovery.checkout.preparing": "Preparing checkout",
  "checkout.routes.checkoutRecovery.checkout.preparing.description":
    "We are getting your checkout ready. Refresh this page in a moment to continue.",
  "checkout.routes.checkoutRecovery.checkout.preparing.auto.description":
    "We are getting your checkout ready. This page checks again automatically and opens checkout as soon as it is ready.",
  "checkout.routes.checkoutRecovery.checkout.needs.attention": "Checkout needs attention",
  "checkout.routes.checkoutRecovery.checkout.needs.attention.description":
    "We could not start checkout from the current cart or item. Review your Buy Cart or browse for another item.",
  "checkout.routes.checkoutRecovery.checkout.handoff.expired": "Checkout needs a fresh start",
  "checkout.routes.checkoutRecovery.checkout.handoff.expired.description":
    "This checkout took longer than expected to become available. Review your Buy Cart or start checkout again from the item.",
  "checkout.routes.checkoutRecovery.refresh.checkout": "Refresh checkout",
  "checkout.routes.checkoutRecovery.view.buy.cart": "View Buy Cart",
  "checkout.features.sessions.ui.checkoutPage.wallet.available.description":
    "{amount} {currency} available for platform purchases",
  "checkout.routes.checkoutStart.account": "Account",
  "checkout.routes.checkoutStart.account.checkout": "Account checkout",
  "checkout.routes.checkoutStart.account.choice": "Account choice",
  "checkout.routes.checkoutStart.account.keeps.purchase.intent.traceable":
    "Your account keeps the offer and seller response traceable.",
  "checkout.routes.checkoutStart.buy.now": "Buy Now",
  "checkout.routes.checkoutStart.cart": "Buy cart",
  "checkout.routes.checkoutStart.cart.needs.review": "Buy Cart needs review",
  "checkout.routes.checkoutStart.cart.needs.review.description": "Review your Buy Cart before starting checkout.",
  "checkout.routes.checkoutStart.checkout.status": "Checkout status",
  "checkout.routes.checkoutStart.checkout.summary": "Checkout summary",
  "checkout.routes.checkoutStart.confirm.shipping.so.the.seller.can.review":
    "Confirm shipping so sellers can review your offer. No payment today.",
  "checkout.routes.checkoutStart.contact.name": "Contact name",
  "checkout.routes.checkoutStart.continue.as.guest": "Continue as guest",
  "checkout.routes.checkoutStart.continue.as.guest.only.if.you.do":
    "Continue as guest only if you do not already have an account. We will use this email for your receipt and order recovery.",
  "checkout.routes.checkoutStart.continue.as.guest.fast.path":
    "Use the fast checkout path. We will use this email for your receipt, order recovery, and payment step.",
  "checkout.routes.checkoutStart.continue.checkout": "Continue checkout",
  "checkout.routes.checkoutStart.continue.to.checkout": "Continue to checkout",
  "checkout.routes.checkoutStart.continue.with.your.account.any.saved.guest":
    "Continue with your account. Any saved guest Buy Cart items will be moved into your account Buy Cart before checkout starts.",
  "checkout.routes.checkoutStart.continue.with.your.account.so.purchases.payments":
    "Continue with your account so purchases, payments, and order history stay together.",
  "checkout.routes.checkoutStart.email": "Email",
  "checkout.routes.checkoutStart.guest.checkout": "Guest checkout",
  "checkout.routes.checkoutStart.guest.checkout.active": "Guest checkout",
  "checkout.routes.checkoutStart.continue.with.guest.checkout":
    "Continue as a guest buyer. We will keep checkout tied to this browser until you sign in or claim the purchase.",
  "checkout.routes.checkoutStart.guest.receipts.and.signed.in.order.history":
    "Guest receipts and signed-in order history keep purchases traceable.",
  "checkout.routes.checkoutStart.availability.confirmed.before.payment": "Availability confirmed before payment",
  "checkout.routes.checkoutStart.buyer.protection.included": "Order protection included",
  "checkout.routes.checkoutStart.fulfillment.confirmed.before.payment": "Fulfillment confirmed before payment",
  "checkout.routes.checkoutStart.item": "item",
  "checkout.routes.checkoutStart.item.count": "{count} {itemLabel}",
  "checkout.routes.checkoutStart.items": "items",
  "checkout.routes.checkoutStart.marketplace.seller": "Marketplace seller",
  "checkout.routes.checkoutStart.needs.review": "Needs review",
  "checkout.routes.checkoutStart.not.charged.yet": "Not charged yet",
  "checkout.routes.checkoutStart.no.payment.today": "No payment today",
  "checkout.routes.checkoutStart.payment": "Payment",
  "checkout.routes.checkoutStart.payment.begins.only.after.the.checkout.session":
    "Payment begins only after the checkout session is created.",
  "checkout.routes.checkoutStart.payment.collected.only.after.seller.accepts":
    "Payment is collected only if a seller accepts and you complete checkout.",
  "checkout.routes.checkoutStart.place.purchase.intent": "Submit offer",
  "checkout.routes.checkoutStart.protected.payment": "Protected payment",
  "checkout.routes.checkoutStart.price": "Price",
  "checkout.routes.checkoutStart.price.confirmed.before.payment": "Price confirmed before payment",
  "checkout.routes.checkoutStart.quantity": "Quantity",
  "checkout.routes.checkoutStart.quantity.confirmed.before.payment": "Quantity confirmed before payment",
  "checkout.routes.checkoutStart.ready": "Ready",
  "checkout.routes.checkoutStart.register.or.sign.in": "Register or sign in",
  "checkout.routes.checkoutStart.register.or.sign.in.purchase.intent.copy":
    "Register or sign in to submit your offer. Sellers review it before any payment is collected.",
  "checkout.routes.checkoutStart.register.or.sign.in.to.place.purchase.intent":
    "Register or sign in to submit an offer.",
  "checkout.routes.checkoutStart.register.to.place.purchase.intent": "Register to submit an offer",
  "checkout.routes.checkoutStart.register.with.passkey": "Register with passkey",
  "checkout.routes.checkoutStart.registration.purchase.intent.copy":
    "Create an account with a passkey, or switch to magic link, so sellers can trust the offer and your reputation can follow the purchase.",
  "checkout.routes.checkoutStart.recoverable.checkout": "Recoverable checkout",
  "checkout.routes.checkoutStart.review.buy.cart": "Review Buy Cart",
  "checkout.routes.checkoutStart.secure.checkout": "Secure checkout",
  "checkout.routes.checkoutStart.secure.payment": "Secure payment",
  "checkout.routes.checkoutStart.sellers.review.purchase.intent.before.payment":
    "Sellers review the offer before payment or shipment starts.",
  "checkout.routes.checkoutStart.shipping.fees.and.final.totals.are.shown":
    "Shipping, fees, and final totals are shown before payment.",
  "checkout.routes.checkoutStart.sign.in": "Sign in",
  "checkout.routes.checkoutStart.sign.in.or.continue.as.guest": "Sign in or continue as guest",
  "checkout.routes.checkoutStart.sign.in.or.guest": "Sign in or guest",
  "checkout.routes.checkoutStart.sign.in.required": "Sign in required",
  "checkout.routes.checkoutStart.email.already.has.account":
    "This email already has an account. Sign in, or use a different email to continue as guest.",
  "checkout.routes.checkoutStart.sign.in.to.continue.checkout.with.this.email.your.cart":
    "Sign in to continue checkout with this email. Your Buy Cart will stay ready.",
  "checkout.routes.checkoutStart.sign.in.to.keep.orders.with.your.account":
    "Sign in to keep orders with your account, or continue as guest with an email receipt.",
  "checkout.routes.checkoutStart.sign.in.to.keep.purchases.payments":
    "Sign in to keep purchases, payments, and order history under your account.",
  "checkout.routes.checkoutStart.signed.in": "Signed in",
  "checkout.routes.checkoutStart.seller": "Seller",
  "checkout.routes.checkoutStart.source": "Source",
  "checkout.routes.checkoutStart.transparent.next.step": "Transparent next step",
  "checkout.routes.checkoutStart.waiting.for.seller.acceptance": "Waiting for seller acceptance",
  "checkout.routes.checkoutStart.offer.submitted.after.registration": "Offer submitted after registration",
  "checkout.features.sessions.api.route.fulfillment.preview.stale":
    "Fulfillment changed. Review the latest checkout preview before continuing.",
  "checkout.features.sessions.ui.checkoutPage.estimated.tax": "Estimated tax",
  "checkout.features.sessions.ui.checkoutPage.estimated.total": "Estimated total",
  "checkout.features.sessions.ui.checkoutPage.estimate": "Estimate",
  "checkout.features.sessions.ui.checkoutPage.checkout.steps": "Checkout steps",
  "checkout.features.sessions.ui.checkoutPage.step.contact": "Contact",
  "checkout.features.sessions.ui.checkoutPage.step.contact.description": "Where receipts and updates go",
  "checkout.features.sessions.ui.checkoutPage.step.delivery": "Delivery",
  "checkout.features.sessions.ui.checkoutPage.step.delivery.description": "Where it ships",
  "checkout.features.sessions.ui.checkoutPage.step.shipping": "Shipping",
  "checkout.features.sessions.ui.checkoutPage.step.shipping.description": "Speed and delivery estimate",
  "checkout.features.sessions.ui.checkoutPage.step.payment": "Payment",
  "checkout.features.sessions.ui.checkoutPage.step.payment.description": "How you pay",
  "checkout.features.sessions.ui.checkoutPage.step.review": "Review",
  "checkout.features.sessions.ui.checkoutPage.step.review.description": "Confirm and pay",
  "checkout.features.sessions.ui.checkoutPage.secure.payment.confirmed.caption":
    "Final total confirmed before secure payment.",
  "checkout.features.sessions.ui.checkoutPage.shipping.2": "Shipping",
  "checkout.features.sessions.ui.checkoutPage.company": "Company",
  "checkout.features.sessions.ui.checkoutPage.phone": "Phone",
  "checkout.features.sessions.ui.checkoutPage.email": "Email",
  "checkout.features.sessions.ui.checkoutPage.address.preferences": "Address preferences",
  "checkout.features.sessions.ui.checkoutPage.address.book.preference": "Address book preference",
  "checkout.features.sessions.ui.checkoutPage.default.address": "Default address",
  "checkout.features.sessions.ui.checkoutPage.default.address.option": "{label} (default)",
  "checkout.features.sessions.ui.checkoutPage.do.not.change.default": "Do not change default",
  "checkout.features.sessions.ui.checkoutPage.enter.a.new.address": "Enter a new address",
  "checkout.features.sessions.ui.checkoutPage.make.this.default": "Make this the default",
  "checkout.features.sessions.ui.checkoutPage.save.as.new.address": "Save as new address",
  "checkout.features.sessions.ui.checkoutPage.save.payment.method": "Save this payment method",
  "checkout.features.sessions.ui.checkoutPage.save.payment.method.description":
    "Use it for future Chase Sets checkout after this payment succeeds.",
  "checkout.features.sessions.ui.checkoutPage.saved.shipping.address": "Saved shipping address",
  "checkout.features.sessions.ui.checkoutPage.update.selected.address": "Update selected saved address",
  "checkout.features.sessions.ui.checkoutPage.use.for.this.checkout": "Use once for this checkout",
  "checkout.shared.policyLinks.description": "Review checkout policies before continuing.",
  "checkout.shared.policyLinks.label": "Checkout policies",
  "checkout.shared.policyLinks.privacy": "Privacy policy",
  "checkout.shared.policyLinks.refunds": "Refunds and returns",
  "checkout.shared.policyLinks.terms": "Terms of service",
} as const;
