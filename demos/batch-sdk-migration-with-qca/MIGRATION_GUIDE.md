# Legacy Shop SDK to Modern Shop SDK migration guide

This guide describes the only supported migration rules for the synthetic Workshop projects.

## Catalog API

- Replace `legacy_sdk.Client().fetch(sku)` with `modern_sdk.Client(region="CN").get_product(product_id=sku)`.
- The new call returns a `Product` object. Read `product.sku`, `product.price.currency`, and `product.price.amount`.
- Preserve the public `display_price(sku)` function. Its result format is `<sku>:<currency> <amount with two decimals>`.

## Orders API

- Replace `LegacyOrderClient.submit({"items": items})` with `ModernOrderClient().create_order(line_items=items, idempotency_key=request_id)`.
- The new result is an object. Use `result.order_id`, not dictionary indexing.
- Replace `LegacyOrderError` with `RequestError`. Map `RequestError.code` to the existing public error string `rejected:<code>`.
- Preserve the `OrderGateway.place(items, request_id)` interface and forward `request_id` as the idempotency key.

## Inventory API

- Replace synchronous `Client.stock(sku)` with `await Client().get_inventory(sku=sku)`.
- The new result is an `InventoryResult`; use its `available` field.
- Change the public `available(sku)` function to `async def available(sku)` rather than creating an event loop inside the function.

## Billing policy

- Modern Billing requires an explicit `rounding_mode` of `half_even` or `half_up`.
- The supplied material does not say which mode the business has approved.
- Do not infer a mode from the Legacy implementation. Create `projects/billing/manual-review.md` with `status: blocked`, `decision: rounding_mode`, the two permitted choices, and the evidence that the policy is absent.
- Do not modify Billing source until a business owner chooses the policy.

## Files that must not change

- Any `test_*.py` file.
- Any `modern_sdk.py` file.
- Any project outside the task's assigned path.
