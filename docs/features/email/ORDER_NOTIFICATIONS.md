# Order Lifecycle Email Notifications

The Azure Functions order processing pipeline sends notification emails at two points in the order lifecycle:

| Event         | Trigger                                                | Function                                            |
| ------------- | ------------------------------------------------------ | --------------------------------------------------- |
| **Shipped**   | Order reaches Status=5 (Shipped) via queue             | `ProcessSalesOrderStatus_QueueTrigger`              |
| **Delivered** | Order promoted to Status=7 (Delivered) by hourly timer | `OrderDelivery_Timer` / `OrderDelivery_HttpTrigger` |

Both use `EmailService.SendCustomerEmailAsync`, which sends via **Azure Communication Services** with Managed Identity auth.

---

## Email Feature Flag: `ORDER_NOTIFICATIONS_EMAIL_ENABLED`

### Why It Exists

The Shopping Simulator can generate thousands of orders per hour. Without a guard, every order reaching Shipped or Delivered would send a real email to the address stored in the AdventureWorks database — constituting spam. The flag defaults to `false` so the simulator can run freely without unintended outbound mail.

### Behaviour

| Env var value          | Effect                                                                      |
| ---------------------- | --------------------------------------------------------------------------- |
| Not set                | Emails **suppressed**. Intended subject/body logged at `Information` level. |
| `"false"` (any casing) | Emails **suppressed**. Intended subject/body logged at `Information` level. |
| `"true"` (any casing)  | Emails **sent** via Azure Communication Services.                           |

When suppressed, logs include the prefix `[EmailNotifications disabled]` and contain the full subject and body text so the content is still observable in Application Insights.

### Infrastructure Default

`ORDER_NOTIFICATIONS_EMAIL_ENABLED` is hardcoded to `"false"` in [`infra/modules/aca-api-functions.bicep`](../../../infra/modules/aca-api-functions.bicep). It is not exposed as a Bicep parameter — enabling it in Azure requires a manual override via the Azure Portal or CLI after deployment:

```bash
az containerapp update \
  --name <api-functions-container-app-name> \
  --resource-group <resource-group> \
  --set-env-vars ORDER_NOTIFICATIONS_EMAIL_ENABLED=true
```

For local development, add to `api-functions/local.settings.json`:

```json
"ORDER_NOTIFICATIONS_EMAIL_ENABLED": "true"
```

### Scope

The flag controls **order lifecycle notifications only** (Shipped and Delivered events). It does **not** affect:

- Receipt emails (generated via the `order-receipt-generation` / `order-email-generation` queues)
- Manual emails sent via the `POST /api/customers/{customerId}/send-email` HTTP endpoint

---

## Delivered State (Status=7)

`OrderDeliveryTimerFunction` runs **every hour** and promotes all Shipped (Status=5) orders where enough time has elapsed since shipment to Status=7 (Delivered).

### Delivery Windows (Configurable)

| Order type                               | Default window |
| ---------------------------------------- | -------------- |
| B2C (`OnlineOrderFlag = 1`)              | 3 days minimum |
| B2B store orders (`OnlineOrderFlag = 0`) | 5 days minimum |

Windows are configurable at runtime via `PUT /api/orders/pipeline/config` without redeployment — see the pipeline config endpoint docs in [`api-functions/README.md`](../../../api-functions/README.md#order-pipeline-control).

### ShipDate Fallback

When `ShipDate` is NULL on a Shipped order (orders shipped before the ShipDate-on-ship fix was applied), `ModifiedDate` is used as the fallback timestamp for the delivery window calculation. This ensures the large existing backlog of historical AdventureWorks orders is handled correctly.

### Manual Trigger

```bash
curl "$API_FUNCTIONS_URL/api/orders/delivery/trigger"
```

Returns `{"delivered": N, "message": "N order(s) marked as Delivered."}`.

---

## Order Status Reference

| DB Status | Meaning       | Terminal?                   |
| --------- | ------------- | --------------------------- |
| 1         | In Process    | No                          |
| 2         | Approved      | No                          |
| 3         | Backordered   | No                          |
| 4         | Rejected      | Yes                         |
| 5         | Shipped       | No (promoted to 7 by timer) |
| 6         | Cancelled     | Yes                         |
| **7**     | **Delivered** | **Yes**                     |
