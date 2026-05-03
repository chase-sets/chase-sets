# Payments Domain Glossary

This glossary defines the canonical terminology for the Payments bounded context.

## Payment

A **Payment** is the external charge workflow associated with one or more orders.

## Payment Intent

A **Payment Intent** is the buyer-facing authorization attempt created before capture.

## Capture

A **Capture** is the successful completion of a previously authorized charge.

## Refund

A **Refund** is the reversal of captured buyer funds through an external payment rail.

## Payment Processor Reference

A **Payment Processor Reference** is the external identifier returned by the payment service provider.

## Marketplace Checkout Fee

A **Marketplace Checkout Fee** is the zero-value marketplace checkout fee amount Payments carries until buyer marketplace checkout fee policy is introduced.

## Shipping Rebate Calculation

A **Shipping Rebate Calculation** is the payment-time computation used to reduce the buyer's effective shipping cost under marketplace rules.
