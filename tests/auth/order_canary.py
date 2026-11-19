"""Opt-in bounded order canary: one storefront and one store order, each cancelled by an admin.

Only the normal API paths are used. Every create is a single request recorded as a residual before it
is sent; nothing is retried after an uncertain result. Orders stay cancelled (Status 6) until the
disposable demo environment is recreated. AI, simulator and agent order paths are not exercised; MCP is used
only for read-only two-owner order tools after cancellation.
"""

import itertools
import json
from pathlib import Path
import re
import time
from urllib.parse import quote, urlencode

import validate as auth
from mutation_suite import Mutations

CANCELLED = 6
IN_PROCESS = 1
EMAIL_SETTING = "ORDER_NOTIFICATIONS_EMAIL_ENABLED"
CANCEL_MUTATION = ("mutation CancelOrder($id: Int!) { updateSalesOrderHeader(SalesOrderID: $id, "
                   "item: { Status: 6 }) { SalesOrderID Status } }")
TELEMETRY_ATTEMPTS = 10
TELEMETRY_INTERVAL_SECONDS = 60
STORE_SCAN_LIMIT = 25
MCP_OWNER_TOOLS = ["get_customer_orders", "get_order_details", "get_personalized_recommendations"]
MCP_MALFORMED_OWNERS = [("zero", 0), ("malformed-string", "invalid"),
                        ("malformed-array", [0]), ("malformed-object", {"id": 0})]
MCP_OWNERSHIP_DENIAL = ["You can only access your own records."]
MCP_POLICY_SOURCE = "api-mcp/AdventureWorks/Auth/ToolAuthorizationPolicy.cs"
RECOMMENDATION_MISSING_OWNER = "get_personalized_recommendations requires a valid existing customer ID"


def mcp_owner_tools(root=None):
    source = ((root or auth.ROOT) / MCP_POLICY_SOURCE).read_text()
    return sorted(re.findall(r'new\("([a-z_]+)",\s*OAuthScopes\.\w+,\s*ToolAccessMode\.SelfOrInternal\b', source))


def preflight_blockers(email_setting_values, pipeline, promotion, simulator, agent):
    """Return reasons that make a live order unsafe; an empty list means the gates pass."""
    blockers = []
    if not isinstance(email_setting_values, list) or len(email_setting_values) > 1:
        blockers.append("Order-notification email setting could not be read unambiguously.")
    elif email_setting_values and str(email_setting_values[0]).strip().lower() == "true":
        blockers.append("Order-notification email is enabled.")
    minimum = pipeline.get("processingToApprovedMinMinutes") if isinstance(pipeline, dict) else None
    if type(minimum) is not int or minimum < 1:
        blockers.append("Pipeline approval minimum is missing or below one minute.")
    if not isinstance(promotion, dict) or type(promotion.get("isEnabled")) is not bool:
        blockers.append("Auto-promotion configuration is unavailable.")
    elif promotion["isEnabled"]:
        blockers.append("Auto-promotion is enabled.")
    if not isinstance(simulator, dict) or type(simulator.get("isRunning")) is not bool:
        blockers.append("Shopping simulator status is unavailable.")
    elif simulator["isRunning"] or simulator.get("queueDepth") not in (0, None):
        blockers.append("Shopping simulator is running or has queued work.")
    if not isinstance(agent, dict) or agent.get("mode") != 0 or agent.get("isAgentActive") is not False:
        blockers.append("Manufacturing agent is not confirmed Off.")
    return blockers


def within_window(elapsed_seconds, minimum_minutes):
    return (isinstance(elapsed_seconds, (int, float)) and elapsed_seconds >= 0 and
            type(minimum_minutes) is int and elapsed_seconds < minimum_minutes * 60)


def safe_store(customers, addresses):
    """A store is safe when it has a person-free Customer row set and an existing address link."""
    return (isinstance(customers, list) and bool(customers) and isinstance(addresses, list) and bool(addresses) and
            all(isinstance(row, dict) and row.get("PersonID") is None and type(row.get("CustomerID")) is int
                for row in customers))


def telemetry_outcome(suppressed, sent):
    if type(suppressed) is not int or type(sent) is not int or suppressed < 0 or sent < 0:
        return "BLOCKED"
    if sent:
        return "FAIL"
    return "PASS" if suppressed else "BLOCKED"


class OrderCanary(Mutations):
    def __init__(self, report, deployment, run_id):
        super().__init__(report, deployment, run_id)
        self.residuals = []
        report.inventory.pop("mutationResiduals", None)
        report.inventory["orderCanaryResiduals"] = self.residuals
        policy = json.loads(Path(__file__).with_name("browser-policy.json").read_text())
        self.login_interval = policy["internalLoginMinimumIntervalMs"] / 1000
        self.tokens = {}

    def require(self, name, condition, detail):
        self.report.check("order:" + name, "orders", condition, detail)
        if not condition:
            raise auth.EvidenceError("Order canary stopped after assertion " + name)

    def internal(self, identity, resource):
        key = (identity, resource)
        if key not in self.tokens:
            if self.tokens:
                time.sleep(self.login_interval)
            self.tokens[key] = auth.internal_token(self.deployment, identity, resource)
        return self.tokens[key]

    def call(self, method, url, token=None, data=None, role=None):
        headers = {"X-MS-API-ROLE": role} if role and token else None
        try:
            status, _, raw = auth.http(method, url, token=token, data=data, headers=headers)
        except auth.EvidenceError as error:
            raise auth.EvidenceError(f"{method} order canary request failed: {error}") from error
        try:
            return status, json.loads(raw) if raw else None
        except ValueError:
            return status, None

    def admin_rows(self, entity, suffix):
        status, body = self.call("GET", self.dab + "/api/" + entity + suffix,
                                 self.internal("admin", "dab"), role="executive-admin")
        if status != 200 or not isinstance(body, dict) or not isinstance(body.get("value"), list):
            raise auth.EvidenceError("Admin DAB prerequisite read failed; no order was sent.")
        return body["value"], body.get("nextLink")

    def admin_order(self, order_id):
        rows, _ = self.admin_rows("SalesOrderHeader/SalesOrderID/" + str(order_id), "")
        if len(rows) != 1 or not isinstance(rows[0], dict):
            raise auth.EvidenceError("Admin order read did not return exactly one order.")
        return rows[0]

    def function_get(self, route):
        status, body = self.call("GET", self.functions + "/api/" + route, self.internal("admin", "functions"))
        if status != 200 or not isinstance(body, dict):
            raise auth.EvidenceError(f"Preflight read {route} returned HTTP {status}; no order was sent.")
        return body

    def preflight(self):
        settings = self.deployment.azure(
            "functionapp", "config", "appsettings", "list",
            "--name", self.deployment.required("SERVICE_API_FUNCTIONS_NAME"),
            "--resource-group", self.deployment.group, "--query", f"[?name=='{EMAIL_SETTING}'].value")
        pipeline = self.function_get("orders/pipeline/config")
        promotion = self.function_get("auto-promotion/config")
        simulator = self.function_get("shopping-simulator/status")
        # Side-effecting GET: it can only switch an expired agent Off, which is the safe direction.
        agent = self.function_get("manufacturing/agent-config")
        blockers = preflight_blockers(settings, pipeline, promotion, simulator, agent)
        self.report.inventory["orderCanaryPreflight"] = {
            "emailSettingPresent": bool(settings), "approvalMinimumMinutes": pipeline.get(
                "processingToApprovedMinMinutes"), "autoPromotionEnabled": promotion.get("isEnabled"),
            "simulatorRunning": simulator.get("isRunning"), "agentMode": agent.get("mode")}
        if blockers:
            self.report.add("order:preflight", "orders", "BLOCKED", " ".join(blockers) + " No order was sent.")
            return None
        self.report.add("order:preflight", "orders", "PASS",
                        "Email notifications off, auto-promotion off, simulator idle, manufacturing agent Off "
                        "and a positive approval delay were read before any order was sent.")
        return pipeline["processingToApprovedMinMinutes"]

    def catalog_product(self):
        offers = self.rows("SpecialOfferProduct", None,
                           "?" + urlencode({"$filter": "SpecialOfferID eq 1", "$first": "25"}))
        for offer in offers:
            product = offer.get("ProductID") if isinstance(offer, dict) else None
            if type(product) is not int or product <= 0:
                continue
            inventory, _ = self.admin_rows("ProductInventory", "?" + urlencode(
                {"$filter": f"ProductID eq {product}", "$first": "20"}))
            stock = sum(row.get("Quantity", 0) for row in inventory if type(row.get("Quantity")) is int)
            if stock >= 10:
                return product, stock
        raise auth.EvidenceError("No special-offer product with at least ten units in stock; no order was sent.")

    def bind_customer(self, caller, territory):
        residual = {"kind": "order-canary-customer", "owner": caller.business_id, "state": "creation-requested"}
        self.record_residual(residual)
        status, body = self.request("POST", self.dab + "/api/Customer", caller,
                                    {"PersonID": caller.business_id, "TerritoryID": territory}, dab=True)
        rows = body.get("value") if isinstance(body, dict) else None
        customer = rows[0].get("CustomerID") if isinstance(rows, list) and len(rows) == 1 and \
            isinstance(rows[0], dict) else None
        self.require("customer-bind-" + caller.label, status == 201 and type(customer) is int and customer > 0,
                     "The disposable consumer must create exactly its own Customer row through DAB.")
        self.update_residual(residual, id=customer, state="retained")
        caller.tokens.clear()
        self.require("customer-claim-" + caller.label,
                     self.customer_claim_matches(caller.token("functions"), customer) and
                     self.customer_claim_matches(caller.token("dab"), customer),
                     "Refreshed Functions and DAB tokens must carry the server-derived customer_id claim.")
        caller.customer_id = customer

    def own_address(self, caller, state):
        residual = {"kind": "order-canary-address", "owner": caller.business_id, "state": "creation-requested"}
        self.record_residual(residual)
        status, body = self.request("POST", self.functions + "/api/addresses", caller, {
            "addressLine1": "AuthOrderCanary-" + self.run_id, "city": "Auth assurance", "stateProvinceID": state,
            "postalCode": "00000", "businessEntityID": caller.business_id, "addressTypeID": 2})
        address = body.get("addressID") if isinstance(body, dict) else None
        self.require("address-" + caller.label, status == 201 and type(address) is int and address > 0,
                     "The order owner must create one owned address.")
        self.update_residual(residual, id=address, state="retained")
        return address

    def cancel_denials(self, order_id, owner, prefix):
        url = self.dab + "/api/SalesOrderHeader/SalesOrderID/" + str(order_id)
        attempts = [("consumer-self-cancel", owner.token("dab") if owner else None, "consumer"),
                    ("manufacturing-cancel", self.internal("manufacturing", "dab"), "manufacturing-engineer")]
        if owner is None:
            attempts = attempts[1:]
        for label, token, role in attempts:
            status, _ = self.call("PATCH", url, token, {"Status": CANCELLED}, role)
            self.report.check(f"order:{prefix}-{label}-denied", "live-denials", status == 403,
                              f"A {role} DAB cancellation must be denied with HTTP 403; got {status}.")
        current = self.admin_order(order_id).get("Status")
        self.report.check(f"order:{prefix}-cancel-denials-unchanged", "orders", current == IN_PROCESS,
                          f"Denied cancellations must leave the order in process; status is {current}.")

    def admin_cancel(self, order_id, prefix, started, minimum):
        status, body = self.call("POST", self.graphql, self.internal("admin", "dab"),
                                 {"query": CANCEL_MUTATION, "variables": {"id": order_id}}, "executive-admin")
        result = body.get("data", {}).get("updateSalesOrderHeader") if isinstance(body, dict) and \
            isinstance(body.get("data"), dict) else None
        self.require(prefix + "-admin-cancel", status == 200 and isinstance(body, dict) and not body.get("errors") and
                     isinstance(result, dict) and result.get("SalesOrderID") == order_id and
                     result.get("Status") == CANCELLED,
                     "The admin UI's DAB cancellation mutation must set Status 6.")
        elapsed = time.monotonic() - started
        persisted = self.admin_order(order_id).get("Status")
        self.report.check(f"order:{prefix}-cancelled-persisted", "orders", persisted == CANCELLED,
                          f"A separate admin read must find Status 6; found {persisted}.")
        self.report.check(f"order:{prefix}-cancel-before-approval", "orders", within_window(elapsed, minimum),
                          f"Cancellation was confirmed {elapsed:.0f}s after creation; the pipeline cannot approve "
                          f"before {minimum} minutes and refuses to overwrite a cancelled order.")
        return elapsed

    def storefront(self, minimum, product):
        territories = self.rows("SalesTerritory")
        states = self.rows("StateProvince")
        methods = self.rows("ShipMethod")
        territory, state, ship = (rows[0].get(key) if rows and isinstance(rows[0], dict) else None for rows, key in [
            (territories, "TerritoryID"), (states, "StateProvinceID"), (methods, "ShipMethodID")])
        if any(type(value) is not int or value <= 0 for value in [territory, state, ship]):
            raise auth.EvidenceError("Storefront order prerequisites are unavailable; no order was sent.")
        owner, foreign = self.create_account("O"), self.create_account("F")
        for caller in [owner, foreign]:
            self.bind_customer(caller, territory)
        address = self.own_address(owner, state)
        header = {"billToAddressId": address, "shipToAddressId": address, "shipMethodId": ship,
                  "subTotal": 1.0, "taxAmt": 0.0, "freight": 0.0}
        detail = {"productId": product, "orderQty": 1, "unitPrice": 1.0, "unitPriceDiscount": 0}
        status, _ = self.call("POST", self.functions + "/api/orders", None, header)
        self.report.check("order:storefront-anonymous-create-denied", "live-denials", status == 401,
                          f"Anonymous order creation must be rejected before the handler; got HTTP {status}.")
        # Admin tokens are issued before the order exists so cancellation is not delayed by login pacing.
        self.internal("admin", "dab")
        self.internal("manufacturing", "dab")

        residual = {"kind": "storefront-order", "owner": owner.customer_id, "state": "creation-requested"}
        self.record_residual(residual)
        status, body = self.request("POST", self.functions + "/api/orders", owner, header)
        started = time.monotonic()
        order_id = body.get("salesOrderId") if isinstance(body, dict) else None
        self.require("storefront-create", status == 201 and type(order_id) is int and order_id > 0,
                     "The bound consumer must create one order header through the storefront API.")
        self.update_residual(residual, id=order_id, state="retained-in-process")
        self.guarded_then_cancel("storefront", order_id, started, minimum,
                                 lambda: self.storefront_order_checks(order_id, owner, foreign, detail))
        self.update_residual(residual, state="cancelled")
        self.report.guarded("order:storefront-reads", "orders",
                            lambda: self.storefront_reads(order_id, owner, foreign, product))
        self.report.guarded("order:mcp-ownership", "orders",
                            lambda: self.mcp_ownership(order_id, owner, foreign))
        self.report.guarded("order:dab-customer-owner-rows", "orders",
                            lambda: self.customer_owner_rows(owner, foreign))
        return owner.customer_id, order_id

    def customer_owner_rows(self, owner, foreign):
        """Retained fixtures have no Customer rows; these two real Customers close the customer_id DAB policies."""
        entities = json.loads((auth.ROOT / "api/dab-config.json").read_text())["entities"]
        selectors, _ = auth.dab_graphql_selectors(self.graphql, self.internal("admin", "dab"), entities)
        auth.dab_owner_row_isolation(self.report, self.graphql, entities, selectors, [owner, foreign],
                                     only=auth.dab_owner_policy_entities(entities, "customer_id"),
                                     prefix="dab:owner-rows-customer", inventory="dabCustomerOwnerRows")

    def guarded_then_cancel(self, prefix, order_id, started, minimum, work):
        try:
            work()
        except auth.EvidenceError as error:
            self.report.add(f"order:{prefix}-post-create", "orders", "BLOCKED", str(error))
        self.admin_cancel(order_id, prefix, started, minimum)

    def storefront_order_checks(self, order_id, owner, foreign, detail):
        line = {"kind": "storefront-order-line", "order": order_id, "state": "creation-requested"}
        self.record_residual(line)
        status, body = self.request("POST", self.functions + f"/api/orders/{order_id}/details", owner, detail)
        self.report.check("order:storefront-detail-create", "orders",
                          status == 201 and isinstance(body, dict) and body.get("success") is True,
                          f"The owner must add one order line; got HTTP {status}.")
        self.update_residual(line, state="retained" if status == 201 else "uncertain")
        foreign_line = {"kind": "storefront-foreign-line-denial", "order": order_id, "state": "creation-requested"}
        self.record_residual(foreign_line)
        status, _ = self.request("POST", self.functions + f"/api/orders/{order_id}/details", foreign, detail)
        self.report.check("order:storefront-foreign-detail-denied", "live-denials", status == 403,
                          f"Another bound customer must not add a line to the order; got HTTP {status}.")
        self.update_residual(foreign_line, state="denied" if status == 403 else "unexpected-response")
        self.cancel_denials(order_id, owner, "storefront")

    def storefront_reads(self, order_id, owner, foreign, product):
        query = "?" + urlencode({"$filter": f"SalesOrderID eq {order_id}", "$first": "1"})
        own = self.rows("SalesOrderHeader", owner, query)
        self.report.check("order:storefront-owner-read", "live-allows",
                          len(own) == 1 and own[0].get("CustomerID") == owner.customer_id,
                          "The owner's consumer DAB read must return the order under the customer_id policy.")
        other = self.rows("SalesOrderHeader", foreign, query)
        self.report.check("order:storefront-foreign-read-empty", "live-denials", other == [],
                          "Another bound customer's DAB read must not return the order.")
        status, _ = self.call("GET", self.dab + "/api/SalesOrderHeader" + query)
        self.report.check("order:storefront-anonymous-read-denied", "live-denials", status in {401, 403},
                          f"Anonymous DAB order reads must be denied; got HTTP {status}.")
        details_url = self.functions + "/api/orders/details?orderIds=" + quote(str(order_id))
        status, lines = self.request("GET", details_url, owner)
        self.report.check("order:storefront-owner-lines", "live-allows",
                          status == 200 and isinstance(lines, list) and len(lines) == 1 and
                          lines[0].get("productId") == product,
                          f"The owner must read exactly its single order line; got HTTP {status}.")
        status, _ = self.request("GET", details_url, foreign)
        self.report.check("order:storefront-foreign-lines-denied", "live-denials", status in {403, 404},
                          f"Another customer must not read the order lines; got HTTP {status}.")

    def mcp_ownership(self, order_id, owner, foreign):
        """Read-only MCP order tools for two consumers with real Customer rows and one nonempty order."""
        url = auth.origin(self.deployment.required("API_MCP_URL")) + "/mcp"
        ids = itertools.count(1)
        listed = re.compile(r"^Order #%d$" % order_id, re.MULTILINE)
        registered = mcp_owner_tools()
        self.report.check("order:mcp:owner-tool-closure", "contracts", registered == sorted(MCP_OWNER_TOOLS),
                          "Every SelfOrInternal MCP tool in the authorization registry must be exercised by this "
                          "two-owner phase; registered: " + ", ".join(registered))

        def call(caller, tool, arguments):
            return auth.consumer_mcp_tool_call(url, tool, caller.token("mcp"), arguments, next(ids))

        for name, caller, other in [("owner", owner, foreign), ("foreign", foreign, owner)]:
            prefix = f"order:mcp:{name}"
            mine = caller is owner
            for variant, arguments in [("implicit", {}), ("explicit", {"customerId": caller.customer_id})]:
                denied, text = call(caller, "get_customer_orders", arguments)
                body = text[0]
                valid = (not denied and f"\nCustomerID: {caller.customer_id}\n" in body and listed.search(body)
                         if mine else
                         not denied and body == f"No orders found for customer #{caller.customer_id}.")
                self.report.check(f"{prefix}:get_customer_orders:{variant}", "live-allows", bool(valid),
                                  "Customer order history is scoped to the signed caller's own CustomerID: the "
                                  "owner lists the canary order and the other customer lists no orders.")
            denied, text = call(caller, "get_order_details", {"orderId": order_id})
            body = text[0]
            valid = (not denied and body.startswith(f"\U0001F4E6 Order Details - Order #{order_id}\n") and
                     f"\nCustomerID: {owner.customer_id}\n" in body
                     if mine else
                     not denied and body == f"Order #{order_id} does not belong to customer #{caller.customer_id}.")
            self.report.check(f"{prefix}:get_order_details:implicit", "live-allows" if mine else "live-denials",
                              bool(valid), "Order details are injected with the caller's CustomerID: the owner "
                              "reads the order and the other customer receives the non-ownership result.")
            denied, text = call(caller, "get_personalized_recommendations", {})
            self.report.check(f"{prefix}:get_personalized_recommendations:implicit", "live-allows",
                              not denied and not text[0].startswith(RECOMMENDATION_MISSING_OWNER),
                              "An omitted owner is injected from the signed caller's Customer profile.")
            for tool in MCP_OWNER_TOOLS:
                base = {"orderId": order_id} if tool == "get_order_details" else {}
                for label, value in [("other-owner", other.customer_id)] + MCP_MALFORMED_OWNERS:
                    denied, text = call(caller, tool, {**base, "customerId": value})
                    self.report.check(f"{prefix}:{tool}:{label}", "live-denials",
                                      denied and text == MCP_OWNERSHIP_DENIAL,
                                      "A consumer with a real Customer profile is denied another customer's or a "
                                      "malformed owner argument with the exact ownership decision.")

    def store_target(self):
        stores, _ = self.admin_rows("Store", "?" + urlencode({"$first": str(STORE_SCAN_LIMIT)}))
        for store in stores:
            store_id = store.get("BusinessEntityID") if isinstance(store, dict) else None
            if type(store_id) is not int:
                continue
            customers, more = self.admin_rows("Customer", "?" + urlencode(
                {"$filter": f"StoreID eq {store_id}", "$first": "20"}))
            addresses, _ = self.admin_rows("BusinessEntityAddress", "?" + urlencode(
                {"$filter": f"BusinessEntityID eq {store_id}", "$first": "1"}))
            if more is None and safe_store(customers, addresses):
                return store_id
        raise auth.EvidenceError("No scanned store has only person-free Customer rows and an address; "
                                 "no store order was sent.")

    def store(self, minimum, product, stock):
        store_id = self.store_target()
        self.internal("admin", "functions")
        residual = {"kind": "store-order", "store": store_id, "product": product, "quantity": 1,
                    "state": "creation-requested",
                    "irreversible": "ProductInventory decremented by 1 and one TransactionHistory row written"}
        self.record_residual(residual)
        status, body = self.call("POST", self.functions + "/api/store-orders", self.internal("admin", "functions"), {
            "storeBusinessEntityId": store_id, "shipMethodId": 0,
            "purchaseOrderNumber": "AUTHCANARY-" + self.run_id[:12],
            "comment": "Authentication assurance canary; cancelled immediately.",
            "items": [{"productId": product, "quantity": 1, "unitPrice": 0, "discountPct": 0}]})
        started = time.monotonic()
        order_id = body.get("salesOrderId") if isinstance(body, dict) else None
        self.require("store-create", status == 201 and type(order_id) is int and order_id > 0,
                     "The admin must create one single-unit store order through the admin API.")
        self.update_residual(residual, id=order_id, state="retained-in-process")
        self.guarded_then_cancel("store", order_id, started, minimum,
                                 lambda: self.cancel_denials(order_id, None, "store"))
        self.update_residual(residual, state="cancelled", stockBefore=stock)
        return order_id

    def email_telemetry(self, customer_id):
        resources = self.deployment.azure("resource", "list", "--resource-group", self.deployment.group,
                                          "--resource-type", "Microsoft.Insights/components", "--query", "[].id")
        if not isinstance(resources, list) or len(resources) != 1 or not isinstance(resources[0], str):
            raise auth.EvidenceError("A unique selected-environment telemetry resource is required.")
        query = ("traces | where timestamp > ago(2h) | summarize "
                 f"suppressed=countif(message == '[EmailSuppressed] Reserved non-deliverable recipient domain for "
                 f"customer {customer_id}; no email sent.'), "
                 f"sent=countif(message startswith 'Email sent to customer {customer_id}.')")
        suppressed = sent = None
        for attempt in range(TELEMETRY_ATTEMPTS):
            if attempt:
                time.sleep(TELEMETRY_INTERVAL_SECONDS)
            result = self.deployment.azure("monitor", "app-insights", "query", "--app", resources[0],
                                           "--analytics-query", query)
            try:
                (table,) = result["tables"]
                ((suppressed, sent),) = table["rows"]
            except (KeyError, TypeError, ValueError) as error:
                raise auth.EvidenceError("Email telemetry has an unsupported aggregate shape.") from error
            if telemetry_outcome(suppressed, sent) != "BLOCKED":
                break
        outcome = telemetry_outcome(suppressed, sent)
        self.report.add("order:storefront-email-suppressed", "orders", outcome,
                        f"Receipt email telemetry for the canary customer: suppressed={suppressed}, sent={sent}. "
                        "A sent email fails; absent telemetry is unverified.")

    def run(self, allow_orders):
        minimum = self.preflight()
        if minimum is None:
            return
        if not allow_orders:
            self.report.add("order:creation", "orders", "BLOCKED",
                            "Preflight passed; pass --order-cancellation-canary to create and cancel orders.")
            return
        product, stock = self.catalog_product()
        customer = None
        try:
            customer, _ = self.storefront(minimum, product)
        except auth.EvidenceError as error:
            self.report.add("order:storefront", "orders", "BLOCKED", str(error))
        self.report.guarded("order:store", "orders", lambda: self.store(minimum, product, stock))
        if customer:
            self.report.guarded("order:storefront-email", "orders", lambda: self.email_telemetry(customer))
        self.report.add("order:residuals", "residuals", "ACCEPTED_EXCEPTION",
                        "Cancelled canary orders, disposable consumers, Customers, addresses and the store order's "
                        "single-unit inventory decrement remain until environment recreation. IDs are inventoried; "
                        "credentials and emails are not exported.")
