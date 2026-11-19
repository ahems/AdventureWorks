import base64
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit


sys.path.insert(0, str(Path(__file__).parent))
SPEC = importlib.util.spec_from_file_location("disposable_mutations", Path(__file__).with_name("mutation_suite.py"))
suite = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(suite)


class MutationTests(unittest.TestCase):
    def run_suite(self, defect=None):
        accounts, addresses, links, reviews, customers, calls = {}, {}, {}, {}, {}, []
        catalog = {
            "ProductCategory": [{"ProductCategoryID": 1, "Name": "Existing category"}],
            "ProductSubcategory": [{"ProductSubcategoryID": 1, "ProductCategoryID": 1, "Name": "Existing subcategory"}],
        }

        def public_review(review):
            return {key: value for key, value in review.items()
                    if key != "EmailAddress" or defect == "review-email-exposed"}

        class Session:
            def __init__(self, deployment, label, email, password, business_id):
                self.label, self.email, self.password, self.business_id = label, email, password, business_id
                self.tokens = {}

            def token(self, resource):
                if accounts[self.business_id]["password"] != self.password:
                    raise suite.auth.EvidenceError("Credential exchange failed")
                if resource not in self.tokens:
                    customer = min((value["CustomerID"] for value in customers.values()
                                    if value["PersonID"] == self.business_id), default=0)
                    if defect == "customer-stale-refresh":
                        customer = 0
                    claims = {"sub": "other-consumer" if defect == "mcp-subject-mismatch" and resource == "mcp"
                              else f"consumer-{self.business_id}"}
                    if resource != "mcp" or defect == "mcp-owner-claim" and resource == "mcp":
                        claims["customer_id"] = str(customer)
                    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
                    self.tokens[resource] = ("dab:" if resource == "dab" else "") + str(self.business_id) + \
                        "." + payload + ".signature"
                return self.tokens[resource]

            def exchange(self, resource):
                valid = accounts[self.business_id]["password"] == self.password or defect == "old-login-allowed"
                return (200 if valid else 400), {}, json.dumps(
                    {"access_token": "secret"} if valid else {"error": "invalid_grant"}).encode()

        def customer_create(item, token, owner, graphql, headers):
            self.assertEqual(mutations.residuals[-1]["state"], "creation-requested")
            self.assertEqual(ledger.events[-1], ("record", dict(mutations.residuals[-1])))
            if token is None:
                self.assertIsNone(headers)
            else:
                self.assertIn(headers, [{"X-MS-API-ROLE": "consumer"}, {"X-MS-API-ROLE": "authenticated"}])
            wrong_audience = token is not None and not str(token).startswith("dab:")
            forbidden_field = "StoreID" in item
            if forbidden_field:
                self.assertIsNone(item["StoreID"])
                self.assertEqual(item["PersonID"], owner)
            denied = (token is None or wrong_audience or item["PersonID"] != owner or
                      forbidden_field and defect != "customer-store-field-accepted" and
                      not (defect == "customer-store-field-graphql-accepted" and graphql))
            if defect == "customer-request-timeout":
                raise suite.auth.EvidenceError("Customer create transport failed; result is unknown")
            if defect in {"customer-accepted", "customer-accepted-but-written"} and denied:
                if defect == "customer-accepted-but-written":
                    customer = len(customers) + 300
                    customers[customer] = {**item, "CustomerID": customer, "StoreID": None}
                return 202, {}, b'{"accepted":true}'
            if denied:
                if defect == "customer-denied-but-written" and token and not wrong_audience:
                    customer = len(customers) + 300
                    customers[customer] = {**item, "CustomerID": customer, "StoreID": None}
                if defect == "customer-bad-denial-sql-fails":
                    return 200, {}, b'{"ok":true}'
                if wrong_audience:
                    return 401, {}, b'{"error":"invalid_token"}'
                if (token is None or forbidden_field) and not graphql:
                    error = {"status": 403, "code": "AuthorizationCheckFailed",
                             "message": "Authorization Failure: Access Not Allowed."}
                    if defect == "customer-anonymous-constraint-error" and token is None:
                        error["code"] = "DatabaseOperationFailed"
                    if defect == "customer-anonymous-malformed-error" and token is None:
                        error.pop("status")
                    if defect == "customer-store-field-constraint" and forbidden_field:
                        error["code"] = "DatabaseOperationFailed"
                    return 403, {}, json.dumps({"error": error}).encode()
                if not graphql:
                    error = {"status": 403, "code": "DatabasePolicyFailure",
                             "message": "Could not insert row with given values."}
                    if defect == "customer-constraint-error":
                        error["code"] = "DatabaseOperationFailed"
                    return 403, {}, json.dumps({"error": error}).encode()
                message, code = (
                    ("The current user is not authorized to access this resource.", "AUTH_NOT_AUTHENTICATED")
                    if token is None else
                    ("Unauthorized due to one or more fields in this mutation.", "AuthorizationCheckFailed")
                    if forbidden_field else ("Could not insert row with given values.", "DatabasePolicyFailure"))
                if defect == "customer-constraint-error" and token:
                    code = "DatabaseOperationFailed"
                if defect == "customer-store-field-graphql-constraint" and forbidden_field:
                    code = "DatabaseOperationFailed"
                return 200, {}, json.dumps({"data": {"createCustomer": None}, "errors": [{
                    "message": message, "path": ["createCustomer"], "extensions": {"code": code}}]}).encode()
            customer = len(customers) + 300
            row = {**item, "CustomerID": customer, "StoreID": None}
            if defect != "customer-positive-not-persisted":
                customers[customer] = row
            result = {key: row[key] for key in ["CustomerID", "PersonID", "TerritoryID"]}
            if defect == "customer-positive-wrong-id":
                result["CustomerID"] += 1
            body = {"data": {"createCustomer": result}} if graphql else {"value": [result]}
            return (200 if graphql else 201), {}, json.dumps(body).encode()

        def request(method, url, *, token=None, data=None, headers=None):
            path = urlsplit(url).path
            calls.append((method, path))
            if path in {"/api/CreateCategory", "/api/CreateSubcategory"} and method == "POST":
                entity = "ProductCategory" if path == "/api/CreateCategory" else "ProductSubcategory"
                if defect == "catalog-denied-but-written" or \
                        defect == "subcategory-denied-but-written" and entity == "ProductSubcategory":
                    catalog[entity].append({"Name": data["englishName"]})
                error = "missing_token" if token is None else (
                    "invalid_token" if token == "invalid-auth-validation-token" or
                    str(token).startswith("dab:") else "insufficient_scope")
                status = 403 if error == "insufficient_scope" else 401
                challenge = ('Bearer resource_metadata="https://mcp.example.invalid/.well-known/'
                             f'oauth-protected-resource", error="{error}"')
                if defect == "catalog-invalid-challenge":
                    challenge = "Bearer"
                if defect in {"catalog-false-denial", "catalog-false-denial-read-fails"}:
                    status = 200
                if defect == "catalog-accepted":
                    status = 202
                return status, {"WWW-Authenticate": challenge}, json.dumps({"error": error}).encode()
            if path in {"/api/ProductCategory", "/api/ProductSubcategory"} and method == "GET":
                entity = path.split("/")[-1]
                query = parse_qs(urlsplit(url).query)
                marker = query.get("$filter", [None])[0]
                if marker is not None:
                    marker = marker.removeprefix("Name eq '").removesuffix("'").replace("''", "'")
                    if defect == "catalog-false-denial-read-fails" and marker.startswith("Auth-") and any(
                            call[1] in {"/api/CreateCategory", "/api/CreateSubcategory"} for call in calls):
                        raise suite.auth.EvidenceError("Catalog read unavailable")
                    result = [item for item in catalog[entity] if item["Name"] == marker]
                    if defect == "catalog-positive-control-empty" and not marker.startswith("Auth-"):
                        result = []
                else:
                    result = catalog[entity]
                body = {"value": result[:1]}
                if defect == "catalog-empty-next-link" and marker and marker.startswith("Auth-"):
                    body["nextLink"] = "https://dab.example.invalid/next"
                if defect == "catalog-malformed-control" and marker and not marker.startswith("Auth-"):
                    body["value"] = [{"Name": 123}]
                return 200, {}, json.dumps(body).encode()
            host_probe = (path in {"/api/password", "/api/password/verify"} or
                          path == "/api/addresses" and method == "POST" or
                          path.startswith("/api/addresses/") and method in {"PUT", "DELETE"}) and (
                              token is None or token == "invalid-auth-validation-token" or
                              str(token).startswith("dab:"))
            if host_probe:
                error = "missing_token" if token is None else "invalid_token"
                if defect == "host-password-denied-but-written" and path == "/api/password":
                    accounts[data["businessEntityID"]]["password"] = data["password"]
                if defect == "host-address-denied-but-written" and method == "PUT" and not path.endswith("/type"):
                    addresses[int(path.split("/")[3])]["city"] = "Corrupted"
                if defect == "host-address-link-denied-but-written" and path.endswith("/type"):
                    links[int(path.split("/")[3])]["AddressTypeID"] = 3
                if defect in {"host-create-orphan-written", "host-create-linked-written"} and path == "/api/addresses":
                    address = len(addresses) + 100
                    addresses[address] = {"addressID": address, "addressLine1": data["addressLine1"]}
                    if defect == "host-create-linked-written":
                        links[address] = {"AddressID": address, "BusinessEntityID": data["businessEntityID"]}
                challenge = ('Bearer realm="adventureworks-functions", '
                             'resource_metadata="https://mcp.example.invalid/.well-known/oauth-protected-resource", '
                             f'error="{error}"')
                if defect == "host-invalid-challenge":
                    challenge = "Bearer"
                if defect == "host-false-denial" or defect == "host-create-false-denial-read-fails" and \
                        path == "/api/addresses":
                    return 200, {}, b'{"ok":true}'
                if defect == "host-create-accepted" and path == "/api/addresses":
                    return 202, {}, b'{"accepted":true}'
                return 401, {"WWW-Authenticate": challenge}, json.dumps({"error": error}).encode()
            owner = int(str(token).removeprefix("dab:").split(".", 1)[0]) \
                if token and token != "invalid-auth-validation-token" else None
            status, body = 200, None
            if path == "/api/signup":
                owner = len(accounts) + 7
                accounts[owner] = dict(data)
                status, body = 201, {"businessEntityId": owner}
                if defect == "signup-failed":
                    status = 500
            elif path == "/api/password":
                target = data["businessEntityID"]
                if target != owner:
                    if defect == "password-denied-but-written":
                        accounts[target]["password"] = data["password"]
                    status, body = 403, {"error": "forbidden",
                                         "error_description": "You can only change your own password."}
                else:
                    if defect != "password-write-not-persisted":
                        accounts[owner]["password"] = data["password"]
                    body = {"businessEntityID": owner}
            elif path == "/api/password/verify":
                body = {"isValid": accounts[owner]["password"] == data["password"]}
            elif path == "/api/StateProvince":
                body = {"value": [{"StateProvinceID": 1}]}
            elif path == "/api/SalesTerritory":
                body = {"value": [{"TerritoryID": 1}]}
            elif path == "/api/Customer" and method == "POST":
                return customer_create(data, token, owner, False, headers)
            elif path.startswith("/api/Customer/CustomerID/") and method == "GET":
                customer = int(path.rsplit("/", 1)[1])
                row = customers.get(customer)
                body = {"value": [row] if row and row["PersonID"] == owner else []}
            elif path == "/mcp":
                params = data["params"]
                customer = next(row["CustomerID"] for row in customers.values() if row["PersonID"] == owner)
                supplied = params["arguments"]["customerId"]
                own = type(supplied) is int and supplied == customer
                denied = not own
                if defect == "mcp-own-denied" and own:
                    denied = True
                elif defect == "mcp-cross-allowed" and not own:
                    denied = False
                if denied:
                    text = "You can only access your own records."
                elif params["name"] == "get_customer_orders":
                    text = f"No orders found for customer #{customer}."
                elif params["name"] == "get_order_details":
                    text = f"Order #0 does not belong to customer #{customer}."
                else:
                    text = f"No purchase history found for customer #{customer} to generate recommendations."
                body = {"jsonrpc": "2.0", "id": data["id"] + (1 if defect == "mcp-invalid-envelope" else 0),
                        "result": {"isError": denied, "content": [{"type": "text", "text": text}]}}
            elif path == "/api/Product":
                if defect == "catalog-preflight-timeout" and token is None:
                    raise suite.auth.EvidenceError("Catalog read unavailable")
                if defect == "host-invalid-dab-control" and token and str(token).startswith("dab:"):
                    status, body = 401, {"error": "invalid_token"}
                else:
                    body = {"value": [{"ProductID": 680}, {"ProductID": 681}, {"ProductID": 682}]}
            elif path == "/api/addresses" and method == "POST":
                address = len(addresses) + 100
                addresses[address] = {"addressID": address, "addressLine1": data["addressLine1"],
                                      "city": data["city"], "postalCode": data["postalCode"],
                                      "stateProvinceID": data["stateProvinceID"]}
                links[address] = {"BusinessEntityID": owner, "AddressTypeID": 2, "AddressID": address}
                status, body = 201, dict(addresses[address])
            elif path.startswith("/api/addresses/"):
                address = int(path.split("/")[3])
                if method == "GET":
                    if address in links and links[address]["BusinessEntityID"] == owner:
                        body = dict(addresses[address])
                    else:
                        status, body = 403, {"error": f"Address {address} is not owned by the current user."}
                elif address not in links or links[address]["BusinessEntityID"] != owner:
                    if defect == "address-denied-but-written" and method == "PUT" and not path.endswith("/type"):
                        addresses[address]["city"] = "Corrupted"
                    status, body = 403, {"error": f"Address {address} is not owned by the current user."}
                elif path.endswith("/type"):
                    status = 204
                elif method == "PUT":
                    if defect != "address-write-not-persisted":
                        addresses[address].update(data)
                    body = {**addresses[address], **data}
                elif method == "DELETE":
                    status = 204
                    if defect != "address-delete-not-persisted":
                        links.pop(address)
                        if defect != "address-delete-orphan":
                            addresses.pop(address)
            elif path == "/api/BusinessEntityAddress":
                if defect == "wrong-address-link":
                    body = {"value": [{"BusinessEntityID": 999, "AddressTypeID": 2}]}
                else:
                    body = {"value": [dict(value) for value in links.values() if value["BusinessEntityID"] == owner]}
            elif path == "/api/ProductReview" and method == "POST":
                if data["ReviewerName"].startswith("AuthDeny-"):
                    if any(item["ProductID"] == data["ProductID"] and item["UserID"] == data["UserID"]
                           for item in reviews.values()):
                        return 409, {}, b'{"error":"duplicate"}'
                    wrong_audience = token is not None and not str(token).startswith("dab:")
                    denied = token is None or wrong_audience or data["UserID"] != owner
                    if denied:
                        if defect == "review-create-denied-but-written":
                            review = len(reviews) + 200
                            reviews[review] = {**data, "ProductReviewID": review, "HelpfulVotes": 0}
                        status = 401 if token is None or wrong_audience else 403
                        if defect == "rest-wrong-audience-accepted" and wrong_audience and \
                                token != "invalid-auth-validation-token":
                            status = 201
                        body = {"error": "denied"}
                        if defect in {"review-create-false-denial", "review-denial-followup-fails"}:
                            status = 201
                        if defect == "review-create-accepted":
                            status = 202
                        return status, {}, json.dumps(body).encode()
                review = len(reviews) + 200
                reviews[review] = {**data, "ProductReviewID": review, "HelpfulVotes": 0}
                status, body = 201, {"value": [public_review(reviews[review])]}
            elif path == "/api/ProductReview" and method == "GET":
                query = parse_qs(urlsplit(url).query)
                marker = query["$filter"][0].removeprefix("ReviewerName eq '").removesuffix("'")
                if defect == "graphql-create-failed-read" and marker.startswith("AuthGqlDeny-") and any(
                        item["kind"] == "review-graphql-denial" for item in mutations.residuals):
                    return 503, {}, b'{"error":"unavailable"}'
                if defect == "review-denial-followup-fails" and marker.startswith("AuthDeny-") and \
                        sum(call == ("POST", "/api/ProductReview") for call in calls) >= 3:
                    return 503, {}, b'{"error":"unavailable"}'
                values = [public_review(review) for review in reviews.values()
                          if review["ReviewerName"] == marker][:1]
                body = {"value": [] if defect == "review-marker-control-empty" else values}
                if defect == "rest-review-empty-next-link" and marker.startswith("AuthDeny-"):
                    body["nextLink"] = "https://dab.example.invalid/next"
            elif path.rstrip("/") == "/graphql" and method == "POST":
                variables = data["variables"]
                if "AuthCustomerCreate" in data["query"]:
                    return customer_create(variables["item"], token, owner, True, headers)
                if "AuthReviewCreate" in data["query"]:
                    item = variables["item"]
                    self.assertIn("ReviewDate", item)
                    if any(value["ProductID"] == item["ProductID"] and value["UserID"] == item["UserID"]
                           for value in reviews.values()):
                        return 200, {}, b'{"errors":[{"message":"duplicate"}]}'
                    wrong_audience = token is not None and not str(token).startswith("dab:")
                    denied = token is None or wrong_audience or item["UserID"] != owner
                    if denied:
                        if defect == "graphql-create-denied-but-written":
                            review = len(reviews) + 200
                            reviews[review] = {**item, "ProductReviewID": review, "HelpfulVotes": 0}
                        if wrong_audience:
                            if defect == "graphql-wrong-audience-accepted" and token != "invalid-auth-validation-token":
                                return 200, {}, b'{"data":{"createProductReview":null}}'
                            return 401, {}, b'{"error":"invalid_token"}'
                        message, code = (
                            ("The current user is not authorized to access this resource.", "AUTH_NOT_AUTHENTICATED")
                            if token is None else ("Could not insert row with given values.", "DatabasePolicyFailure"))
                        if defect == "graphql-create-invalid-query":
                            message = "Unknown field"
                        if defect == "graphql-create-wrong-code":
                            code = "DatabaseOperationFailed"
                        if defect == "graphql-create-failed-read":
                            message = "Wrong denial"
                        return 200, {}, json.dumps({"errors": [{
                            "message": message, "path": ["createProductReview"], "extensions": {"code": code}}]}).encode()
                    review = len(reviews) + 200
                    if defect != "graphql-create-not-persisted":
                        reviews[review] = {**item, "ProductReviewID": review, "HelpfulVotes": 0}
                        if defect == "graphql-create-wrong-content":
                            reviews[review]["Comments"] = "Incorrect content"
                    result = {key: value for key, value in {
                        "ProductReviewID": review, "UserID": owner, "ReviewerName": item["ReviewerName"]}.items()}
                    return 200, {}, json.dumps({"data": {"createProductReview": result}}).encode()
                review = variables["id"]
                if "DeniedVote" in data["query"]:
                    if defect == "vote-denied-but-written":
                        reviews[review]["HelpfulVotes"] = variables["votes"]
                    if token is not None:
                        if defect == "vote-wrong-audience-accepted" and token != "invalid-auth-validation-token":
                            return 200, {}, b'{"data":{"updateProductReview":null}}'
                        return 401, {}, b''
                    message = ("Unknown field" if defect in {"vote-invalid-denial", "vote-invalid-denial-read-fails"}
                               else "The current user is not authorized to access this resource.")
                    return 200, {}, json.dumps({"errors": [{
                        "message": message, "path": ["updateProductReview"],
                        "extensions": {"code": "AUTH_NOT_AUTHENTICATED"}}]}).encode()
                if "DeniedDelete" in data["query"]:
                    if defect == "graphql-delete-denied-but-written":
                        del reviews[review]
                    message = ("Unknown field" if defect == "graphql-delete-invalid-query" else
                               "The current user is not authorized to access this resource.")
                    body = {"errors": [{"message": message}]}
                elif "item" in variables:
                    if defect == "graphql-review-denied-but-written":
                        reviews[review].update(variables["item"])
                    message = ("Unknown type" if defect == "graphql-invalid-query" else
                               "Unauthorized due to one or more fields in this mutation.")
                    body = {"errors": [{"message": message}]}
                else:
                    if defect != "vote-write-not-persisted":
                        reviews[review]["HelpfulVotes"] = variables["votes"]
                    result = {"ProductReviewID": review, "HelpfulVotes": variables["votes"]}
                    if defect == "graphql-vote-error":
                        body = {"errors": [{"message": "failed"}], "data": {"updateProductReview": result}}
                    elif defect == "graphql-vote-wrong-result":
                        body = {"data": {"updateProductReview": {**result, "ProductReviewID": review + 1}}}
                    else:
                        body = {"data": {"updateProductReview": result}}
            elif path.startswith("/api/ProductReview/ProductReviewID/"):
                review = int(path.rsplit("/", 1)[1])
                if method == "GET":
                    if defect == "vote-invalid-denial-read-fails" and any(
                            item["id"] == "mutation:review-vote-denied-A-anonymous" for item in report.checks):
                        return 503, {}, b'{"error":"unavailable"}'
                    body = {"value": [public_review(reviews[review])] if review in reviews else []}
                elif method == "PATCH" and set(data) == {"HelpfulVotes"}:
                    if defect != "vote-write-not-persisted":
                        reviews[review].update(data)
                    body = {"value": [public_review(reviews[review])]}
                else:
                    if defect == "review-denied-but-written" and method == "PATCH":
                        reviews[review].update(data)
                    status = 403
            else:
                self.fail("Unexpected method/path: " + repr((method, path)))
            if defect == "invalid-json" and path == "/api/signup":
                return status, {}, b"secret-invalid-json"
            return status, {}, json.dumps(body).encode() if body is not None else b""

        with tempfile.TemporaryDirectory() as directory:
            report = suite.auth.Report(Path(directory))
            class Ledger:
                def __init__(self):
                    self.events = []
                    self.entries = {}

                def record(self, residual):
                    self.events.append(("record", dict(residual)))
                    self.entries[id(residual)] = dict(residual)

                def update(self, residual):
                    self.events.append(("update", dict(residual)))
                    self.entries[id(residual)] = dict(residual)

                def snapshot(self):
                    rows = list(self.entries.values())
                    if defect == "customer-ledger-missing":
                        rows = [row for row in rows if row.get("label") != "customer-create-rest-consumer-A-allow"]
                    if defect == "customer-ledger-altered":
                        rows = [{**row, "state": "creation-requested"} if
                                row.get("label") == "customer-create-rest-consumer-A-allow" else row for row in rows]
                    return rows

            ledger = Ledger()
            deployment = SimpleNamespace(runtime={"runId": "private"}, required=lambda key: {
                "API_FUNCTIONS_URL": "https://functions.example.invalid",
                "API_URL": "https://dab.example.invalid/graphql/",
                "API_MCP_URL": "https://mcp.example.invalid/mcp"}[key])
            def marker_counts(instance, marker):
                matched = [item["addressID"] for item in addresses.values() if item["addressLine1"] == marker]
                if defect == "host-create-marker-control-empty" and marker.startswith("AuthMutation-"):
                    return {"addresses": 0, "links": 0}
                if defect in {"host-create-marker-read-failed", "host-create-false-denial-read-fails"} and \
                        marker.startswith("AuthDeny-") and any(
                        item["kind"] == "address-denial-probe" for item in instance.residuals):
                    raise suite.auth.EvidenceError("SQL read unavailable")
                return {"addresses": len(matched), "links": sum(address in links for address in matched)}
            def customer_states(instance, callers, territory):
                if not instance.deployment.runtime or instance.ledger is None:
                    raise suite.auth.EvidenceError("Private SQL and ledger required")
                if defect == "customer-bad-denial-sql-fails" and any(
                        item["kind"] == "customer-create-denial" for item in instance.residuals):
                    raise suite.auth.EvidenceError("Private Customer state unavailable")
                states = []
                for caller in callers:
                    rows = [row for row in customers.values() if row["PersonID"] == caller.business_id]
                    states.append({"count": len(rows),
                                   "firstId": min((row["CustomerID"] for row in rows), default=None),
                                   "matching": sum(row["StoreID"] is None and row["TerritoryID"] == territory
                                                   for row in rows)})
                return states
            original_customer_evidence = suite.Mutations.customer_create_evidence
            def customer_evidence(instance):
                check_id = "mutation:customer-create-rest-consumer-A-cross-owner"
                if defect == "customer-gate-missing":
                    instance.report.checks[:] = [check for check in instance.report.checks if check["id"] != check_id]
                elif defect == "customer-gate-duplicate":
                    instance.report.checks.append(dict(next(check for check in instance.report.checks
                                                            if check["id"] == check_id)))
                elif defect == "customer-gate-wrong-group":
                    next(check for check in instance.report.checks if check["id"] == check_id)["group"] = "mutations"
                elif defect == "customer-gate-blocked":
                    next(check for check in instance.report.checks if check["id"] == check_id)["status"] = "BLOCKED"
                return original_customer_evidence(instance)
            with patch.object(suite.auth, "ConsumerSession", Session), patch.object(suite.auth, "http", side_effect=request), \
                    patch.object(suite.Mutations, "address_marker_counts", marker_counts), \
                    patch.object(suite.Mutations, "customer_states", customer_states), \
                    patch.object(suite.Mutations, "customer_create_evidence", customer_evidence):
                mutations = suite.Mutations(report, deployment, "1234567890abcdef", ledger)
                report.guarded("setup", "mutations", mutations.run)
            for value in accounts.values():
                self.assertNotIn(value["password"], str(report.checks) + str(report.inventory))
                self.assertNotIn(value["email"], str(report.checks) + str(report.inventory))
            self.assertNotIn("secret-invalid-json", str(report.checks))
            return report, calls, accounts, addresses, reviews

    def test_repeatable_suite_arranges_fixtures_without_seed_or_existing_consumer_assumptions(self):
        for _ in range(2):
            report, calls, accounts, addresses, reviews = self.run_suite()
            self.assertFalse(any(item["status"] in {"FAIL", "BLOCKED"} for item in report.checks), report.checks)
            self.assertEqual(len(accounts), 4)
            self.assertEqual(len(addresses), 0)
            self.assertEqual(len(reviews), 4)
            self.assertEqual(len(report.inventory["mutationResiduals"]), 80)
            self.assertEqual(sum(item["state"] == "retained" for item in report.inventory["mutationResiduals"]), 12)
            self.assertEqual(sum(item["state"] == "verified-absent" for item in report.inventory["mutationResiduals"]), 68)
            self.assertEqual(sum(method == "POST" and path == "/api/signup" for method, path in calls), 4)
            self.assertTrue(all("orders" not in path and "simulator" not in path and "agent" not in path
                                and "email" not in path for _, path in calls))

    def test_unavailable_catalog_stops_before_creating_consumers(self):
        report, calls, accounts, addresses, reviews = self.run_suite("catalog-preflight-timeout")
        self.assertEqual(accounts, {})
        self.assertEqual(addresses, {})
        self.assertEqual(reviews, {})
        self.assertEqual(report.inventory["mutationResiduals"], [])
        self.assertNotIn(("POST", "/api/signup"), calls)
        self.assertEqual(report.checks[-1]["status"], "BLOCKED")

    def test_customer_create_checks_both_owners_protocols_roles_and_refreshed_tokens(self):
        report, _, _, _, _ = self.run_suite()
        checks = {item["id"]: item for item in report.checks}
        self.assertEqual(checks["mutation:customer-create-evidence"]["status"], "PASS")
        for protocol in ["rest", "graphql"]:
            for role in ["consumer", "authenticated"]:
                for owner in ["A", "B"]:
                    labels = ["cross-owner", "store-field"]
                    if role == "consumer":
                        labels += ["anonymous", "forged", "functions-audience"]
                    for label in labels:
                        name = f"mutation:customer-create-{protocol}-{role}-{owner}-{label}"
                        for suffix in ["-baseline", "", "-unchanged"]:
                            self.assertEqual(checks[name + suffix]["status"], "PASS")
        for protocol, role, owner in [("rest", "consumer", "A"), ("graphql", "consumer", "B"),
                                      ("rest", "authenticated", "C"), ("graphql", "authenticated", "D")]:
            name = f"mutation:customer-create-{protocol}-{role}-{owner}-allow"
            for suffix in ["-baseline", "", "-persisted", "-functions-token", "-dab-token",
                           "-refreshed-functions", "-refreshed-dab"]:
                self.assertEqual(checks[name + suffix]["status"], "PASS")
        controls = [item for item in report.inventory["mutationResiduals"]
                    if item["kind"] == "customer-create-control"]
        self.assertEqual(len(controls), 4)
        self.assertEqual(len({item["owner"] for item in controls}), 4)
        self.assertTrue(all(item["state"] == "retained" for item in controls))

    def test_customer_mcp_checks_verified_owners_and_rejects_foreign_or_malformed_ids(self):
        report, _, _, _, _ = self.run_suite()
        checks = {item["id"]: item for item in report.checks}
        for owner in ["A", "B"]:
            self.assertEqual(checks[f"mutation:mcp-owner-{owner}-subject"]["status"], "PASS")
            for tool in ["get_customer_orders", "get_order_details", "get_personalized_recommendations"]:
                for case in ["own", "other-owner", "zero", "malformed-string", "malformed-array", "malformed-object"]:
                    self.assertEqual(checks[f"mutation:mcp-owner-{owner}-{tool}-{case}"]["status"], "PASS")

    def test_customer_mcp_controls_fail_closed_on_bad_evidence_or_authorization(self):
        for defect in ["customer-gate-missing", "customer-ledger-altered", "mcp-subject-mismatch",
                       "mcp-owner-claim", "mcp-own-denied", "mcp-cross-allowed", "mcp-invalid-envelope"]:
            with self.subTest(defect=defect):
                report, calls, *_ = self.run_suite(defect)
                checks = {item["id"]: item for item in report.checks}
                self.assertEqual(checks["mutation:customer-mcp-owner"]["status"], "BLOCKED")
                if defect.startswith("customer-") or defect in {"mcp-subject-mismatch", "mcp-owner-claim"}:
                    self.assertFalse(any(path == "/mcp" for _, path in calls))
                if defect in {"mcp-subject-mismatch", "mcp-owner-claim", "mcp-own-denied", "mcp-cross-allowed"}:
                    self.assertTrue(any(check["id"].startswith("mutation:mcp-owner-") and check["status"] == "FAIL"
                                        for check in report.checks))

    def test_customer_create_gate_requires_the_complete_matching_durable_ledger(self):
        for defect in ["customer-ledger-missing", "customer-ledger-altered", "customer-gate-missing",
                       "customer-gate-duplicate", "customer-gate-wrong-group", "customer-gate-blocked"]:
            with self.subTest(defect=defect):
                report, *_ = self.run_suite(defect)
                check = next(item for item in report.checks if item["id"] == "mutation:customer-create-evidence")
                self.assertEqual(check["status"], "BLOCKED")

    def test_customer_timeout_is_never_retried_and_preserves_uncertain_create(self):
        report, calls, *_ = self.run_suite("customer-request-timeout")
        residual = next(item for item in report.inventory["mutationResiduals"]
                        if item["kind"] == "customer-create-denial")
        self.assertEqual(residual["state"], "creation-requested")
        self.assertEqual(sum(call == ("POST", "/api/Customer") for call in calls), 1)
        checks = {item["id"]: item for item in report.checks}
        self.assertEqual(checks["mutation:customer-creates"]["status"], "BLOCKED")
        self.assertEqual(checks["mutation:customer-create-evidence"]["status"], "BLOCKED")

    def test_unconfirmed_denials_do_not_claim_immediate_absence(self):
        cases = [
            ("customer-accepted", "customer-create-denial",
             "mutation:customer-create-rest-consumer-A-cross-owner-unchanged"),
            ("catalog-accepted", "catalog-denial-probe",
             "mutation:host-denial-category-create-A-anonymous-unchanged"),
            ("review-create-accepted", "review-denial-probe",
             "mutation:review-create-denied-A-anonymous-unchanged"),
            ("host-create-accepted", "address-denial-probe",
             "mutation:host-denial-address-create-A-anonymous-unchanged"),
        ]
        for defect, kind, check_id in cases:
            with self.subTest(defect=defect):
                report, _, _, addresses, _ = self.run_suite(defect)
                residual = next(item for item in report.inventory["mutationResiduals"] if item["kind"] == kind)
                self.assertEqual(residual["state"], "creation-requested")
                checks = {item["id"]: item for item in report.checks}
                self.assertEqual(checks[check_id]["status"], "BLOCKED")
                if defect == "host-create-accepted":
                    self.assertEqual(checks["mutation:address-removal"]["status"], "BLOCKED")
                    self.assertNotIn("mutation:address-delete-A", checks)
                    self.assertEqual(len(addresses), 2)

    def test_unconfirmed_customer_write_remains_pending_when_a_row_is_observed(self):
        report, *_ = self.run_suite("customer-accepted-but-written")
        residual = next(item for item in report.inventory["mutationResiduals"]
                        if item["kind"] == "customer-create-denial")
        self.assertEqual(residual["state"], "creation-requested")
        self.assertEqual(residual["owner"], 8)
        self.assertEqual(residual["id"], 300)

    def test_customer_create_never_accepts_constraint_errors_or_changed_state(self):
        for defect in ["customer-denied-but-written", "customer-constraint-error",
                       "customer-positive-not-persisted", "customer-positive-wrong-id",
                       "customer-stale-refresh"]:
            with self.subTest(defect=defect):
                report, *_ = self.run_suite(defect)
                self.assertTrue(any(item["status"] == "FAIL" and
                                    item["id"].startswith("mutation:customer-") for item in report.checks))

    def test_customer_anonymous_forbidden_requires_the_authorization_error(self):
        for defect in ["customer-anonymous-constraint-error", "customer-anonymous-malformed-error"]:
            with self.subTest(defect=defect):
                report, calls, *_ = self.run_suite(defect)
                checks = {item["id"]: item for item in report.checks}
                name = "mutation:customer-create-rest-consumer-A-anonymous"
                self.assertEqual(checks[name]["status"], "FAIL")
                self.assertEqual(checks[name + "-unchanged"]["status"], "BLOCKED")
                residual = next(item for item in report.inventory["mutationResiduals"]
                                if item.get("label") == name.removeprefix("mutation:"))
                self.assertEqual(residual["state"], "creation-requested")
                self.assertEqual(sum(call == ("POST", "/api/Customer") for call in calls), 3)

    def test_customer_store_field_requires_authorization_denial_and_no_row(self):
        for defect in ["customer-store-field-accepted", "customer-store-field-constraint",
                       "customer-store-field-graphql-accepted", "customer-store-field-graphql-constraint"]:
            with self.subTest(defect=defect):
                report, *_ = self.run_suite(defect)
                checks = {item["id"]: item for item in report.checks}
                protocol = "graphql" if "-graphql-" in defect else "rest"
                name = f"mutation:customer-create-{protocol}-consumer-A-store-field"
                self.assertEqual(checks[name]["status"], "FAIL")
                self.assertEqual(checks["mutation:customer-create-evidence"]["status"], "BLOCKED")
                residual = next(item for item in report.inventory["mutationResiduals"]
                                if item.get("label") == name.removeprefix("mutation:"))
                self.assertEqual(residual["state"], "creation-requested")

    def test_customer_denied_write_is_retained_with_its_observed_owner_and_id(self):
        report, *_ = self.run_suite("customer-denied-but-written")
        residual = next(item for item in report.inventory["mutationResiduals"]
                        if item["kind"] == "customer-create-denial")
        self.assertEqual(residual["state"], "unexpected-present")
        self.assertEqual(residual["owner"], 8)
        self.assertEqual(residual["id"], 300)

    def test_customer_failed_denial_is_retained_when_the_followup_sql_read_fails(self):
        report, *_ = self.run_suite("customer-bad-denial-sql-fails")
        checks = {item["id"]: item for item in report.checks}
        self.assertEqual(checks["mutation:customer-create-rest-consumer-A-cross-owner"]["status"], "FAIL")
        self.assertEqual(checks["mutation:customer-creates"]["status"], "BLOCKED")
        residual = next(item for item in report.inventory["mutationResiduals"]
                        if item["kind"] == "customer-create-denial")
        self.assertEqual(residual["state"], "creation-requested")

    def test_customer_sql_reader_requires_a_ledger_and_complete_consistent_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            report = suite.auth.Report(Path(directory))
            deployment = SimpleNamespace(runtime={"runId": "private"}, required=lambda key: {
                "API_FUNCTIONS_URL": "https://functions.example.invalid",
                "API_URL": "https://dab.example.invalid/graphql/",
                "API_MCP_URL": "https://mcp.example.invalid/mcp"}[key])
            callers = [SimpleNamespace(business_id=7), SimpleNamespace(business_id=8)]
            mutations = suite.Mutations(report, deployment, "1234567890abcdef", object())
            valid = b'{"customers":[{"count":0,"firstId":null,"matching":0},{"count":1,"firstId":42,"matching":1}]}'
            for output, code in [
                (b"", 0), (valid + b"\n" + valid, 0), (valid, 2),
                (b'{"customers":[{"count":0,"firstId":null,"matching":0}]}', 0),
                (b'{"customers":[{"count":true,"firstId":null,"matching":0},{"count":0,"firstId":null,"matching":0}]}', 0),
                (b'{"customers":[{"count":1,"firstId":null,"matching":0},{"count":0,"firstId":null,"matching":0}]}', 0),
                (b'{"customers":[{"count":0,"firstId":null,"matching":1},{"count":0,"firstId":null,"matching":0}]}', 0),
                (b'{"customers":broken}', 0),
            ]:
                with self.subTest(output=output, code=code), patch.object(
                        suite.subprocess, "run", return_value=SimpleNamespace(stdout=output, returncode=code)):
                    with self.assertRaises(suite.auth.EvidenceError):
                        mutations.customer_states(callers, 1)
            with patch.object(suite.subprocess, "run", return_value=SimpleNamespace(stdout=valid, returncode=0)):
                self.assertEqual(mutations.customer_states(callers, 1), [
                    {"count": 0, "firstId": None, "matching": 0},
                    {"count": 1, "firstId": 42, "matching": 1}])
            for runtime, ledger in [(None, object()), ({"runId": "private"}, None)]:
                deployment.runtime, mutations.ledger = runtime, ledger
                with patch.object(suite.subprocess, "run") as process:
                    with self.assertRaises(suite.auth.EvidenceError):
                        mutations.customer_states(callers, 1)
                    process.assert_not_called()

    def test_customer_direct_mode_stops_before_creating_accounts_or_customers(self):
        report = suite.auth.Report(Path("."))
        deployment = SimpleNamespace(runtime=None, required=lambda key: {
            "API_FUNCTIONS_URL": "https://functions.example.invalid",
            "API_URL": "https://dab.example.invalid/graphql/",
            "API_MCP_URL": "https://mcp.example.invalid/mcp"}[key])
        mutations = suite.Mutations(report, deployment, "1234567890abcdef")
        callers = [SimpleNamespace(business_id=7), SimpleNamespace(business_id=8)]
        with patch.object(mutations, "rows", return_value=[{"TerritoryID": 1}]), \
                patch.object(suite.auth, "http") as http:
            report.guarded("scenario", "mutations", lambda: mutations.customer_creates(callers))
        self.assertEqual(report.checks[0]["status"], "BLOCKED")
        http.assert_not_called()

    def test_owner_address_removal_requires_unlink_and_private_sql_confirmation(self):
        report, _, _, _, _ = self.run_suite()
        checks = {item["id"]: item for item in report.checks}
        for owner in ["A", "B"]:
            for suffix in ["", "-unlinked", "-sql"]:
                self.assertEqual(checks[f"mutation:address-delete{suffix}-{owner}"]["status"], "PASS")
        for defect, state in [("address-delete-not-persisted", "deletion-requested"),
                              ("address-delete-orphan", "unlinked")]:
            with self.subTest(defect=defect):
                report, _, _, _, _ = self.run_suite(defect)
                self.assertTrue(any(item["status"] == "FAIL" and
                                    item["id"].startswith("mutation:address-delete") for item in report.checks))
                residuals = [item for item in report.inventory["mutationResiduals"] if item["kind"] == "address"]
                self.assertEqual(residuals[0]["state"], state)
                self.assertEqual(residuals[1]["state"], "retained")

    def test_host_denials_cover_each_owner_method_and_credential_with_state_checks(self):
        report, _, _, _, _ = self.run_suite()
        checks = {item["id"]: item for item in report.checks}
        for owner in ["A", "B"]:
            for operation in ["password-set", "password-verify", "address-update", "address-type", "address-delete"]:
                for credential in ["anonymous", "forged", "dab-audience"]:
                    name = f"mutation:host-denial-{operation}-{owner}-{credential}"
                    self.assertEqual(checks[name]["status"], "PASS")
                    self.assertEqual(checks[name + "-unchanged"]["status"], "PASS")

    def test_review_create_denials_cover_both_owners_and_independent_reads(self):
        report, _, _, _, _ = self.run_suite()
        checks = {item["id"]: item for item in report.checks}
        self.assertEqual(checks["mutation:review-marker-read-control"]["status"], "PASS")
        for owner in ["A", "B"]:
            self.assertEqual(checks[f"mutation:review-functions-token-control-{owner}"]["status"], "PASS")
            self.assertEqual(checks[f"mutation:review-create-redacted-{owner}"]["status"], "PASS")
            for credential in ["anonymous", "forged", "functions-audience", "cross-owner"]:
                name = f"mutation:review-create-denied-{owner}-{credential}"
                for suffix in ["-baseline", "", "-unchanged"]:
                    self.assertEqual(checks[name + suffix]["status"], "PASS")

    def test_review_create_response_email_leak_fails_after_recording_the_fixture(self):
        report, _, _, _, reviews = self.run_suite("review-email-exposed")
        checks = {item["id"]: item for item in report.checks}
        self.assertEqual(checks["mutation:review-create-redacted-A"]["status"], "FAIL")
        self.assertEqual(len(reviews), 1)
        residual = next(item for item in report.inventory["mutationResiduals"] if item["kind"] == "review")
        self.assertEqual(residual["state"], "retained")
        self.assertIn(residual["id"], reviews)

    def test_graphql_review_create_checks_both_owners_and_all_denials(self):
        report, _, _, _, _ = self.run_suite()
        checks = {item["id"]: item for item in report.checks}
        for owner in ["A", "B"]:
            for suffix in ["baseline", "allow", "persisted"]:
                self.assertEqual(checks[f"mutation:review-graphql-create-{owner}-{suffix}"]["status"], "PASS")
            for credential in ["anonymous", "forged", "functions-audience", "cross-owner"]:
                for suffix in ["-baseline", "", "-unchanged"]:
                    self.assertEqual(checks[f"mutation:review-graphql-create-{owner}-{credential}{suffix}"]["status"], "PASS")

    def test_graphql_vote_denials_check_both_fixture_owners_and_unchanged_state(self):
        report, *_ = self.run_suite()
        checks = {item["id"]: item for item in report.checks}
        for owner in ["A", "B"]:
            for credential in ["anonymous", "forged", "functions-audience"]:
                for suffix in ["-baseline", "", "-unchanged"]:
                    self.assertEqual(checks[f"mutation:review-vote-denied-{owner}-{credential}{suffix}"]["status"], "PASS")
            self.assertEqual(checks[f"mutation:review-vote-persisted-{owner}"]["status"], "PASS")

    def test_vote_denial_failure_survives_failed_followup_read(self):
        report, *_ = self.run_suite("vote-invalid-denial-read-fails")
        checks = {item["id"]: item for item in report.checks}
        self.assertEqual(checks["mutation:review-vote-denied-A-anonymous"]["status"], "FAIL")
        self.assertEqual(checks["mutation:reviews"]["status"], "BLOCKED")

    def test_graphql_failed_denial_is_preserved_if_followup_read_fails(self):
        report, *_ = self.run_suite("graphql-create-failed-read")
        checks = {item["id"]: item for item in report.checks}
        self.assertEqual(checks["mutation:review-graphql-create-A-anonymous"]["status"], "FAIL")
        self.assertEqual(checks["mutation:reviews"]["status"], "BLOCKED")
        residual = next(item for item in report.inventory["mutationResiduals"]
                        if item["kind"] == "review-graphql-denial")
        self.assertEqual(residual["state"], "creation-requested")

    def test_address_create_denials_cover_both_owners_and_sql_reads(self):
        report, _, _, _, _ = self.run_suite()
        checks = {item["id"]: item for item in report.checks}
        self.assertEqual(checks["mutation:address-create-marker-control"]["status"], "PASS")
        for owner in ["A", "B"]:
            for credential in ["anonymous", "forged", "dab-audience"]:
                name = f"mutation:host-denial-address-create-{owner}-{credential}"
                for suffix in ["-baseline", "", "-unchanged"]:
                    self.assertEqual(checks[name + suffix]["status"], "PASS")

    def test_catalog_create_denials_cover_both_owners_and_persisted_reads(self):
        report, _, _, _, _ = self.run_suite()
        checks = {item["id"]: item for item in report.checks}
        for operation in ["category-create", "subcategory-create"]:
            self.assertEqual(checks[f"mutation:{operation}-marker-control"]["status"], "PASS")
            for owner in ["A", "B"]:
                for credential in ["anonymous", "forged", "dab-audience", "consumer"]:
                    name = f"mutation:host-denial-{operation}-{owner}-{credential}"
                    for suffix in ["-baseline", "", "-unchanged"]:
                        self.assertEqual(checks[name + suffix]["status"], "PASS")

    def test_catalog_denial_failure_and_uncertain_create_survive_failed_read(self):
        report, *_ = self.run_suite("catalog-false-denial-read-fails")
        checks = {item["id"]: item for item in report.checks}
        self.assertEqual(checks["mutation:host-denial-category-create-A-anonymous"]["status"], "FAIL")
        self.assertEqual(checks["mutation:category-create-denials"]["status"], "BLOCKED")
        self.assertEqual(next(item for item in report.inventory["mutationResiduals"]
                              if item["kind"] == "catalog-denial-probe")["state"], "creation-requested")

    def test_unavailable_private_sql_preserves_uncertain_create(self):
        report, *_ = self.run_suite("host-create-marker-read-failed")
        check = next(item for item in report.checks if item["id"] == "mutation:address-create-denials")
        self.assertEqual(check["status"], "BLOCKED")
        self.assertEqual(next(item for item in report.inventory["mutationResiduals"]
                              if item["kind"] == "address-denial-probe")["state"], "creation-requested")

    def test_failed_address_denial_survives_failed_sql_followup(self):
        report, *_ = self.run_suite("host-create-false-denial-read-fails")
        checks = {item["id"]: item for item in report.checks}
        self.assertEqual(checks["mutation:host-denial-address-create-A-anonymous"]["status"], "FAIL")
        self.assertEqual(checks["mutation:address-create-denials"]["status"], "BLOCKED")

    def test_private_marker_reader_rejects_missing_duplicate_and_bad_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            report = suite.auth.Report(Path(directory))
            deployment = SimpleNamespace(runtime={"runId": "private"}, required=lambda key: {
                "API_FUNCTIONS_URL": "https://functions.example.invalid",
                "API_URL": "https://dab.example.invalid/graphql/",
                "API_MCP_URL": "https://mcp.example.invalid/mcp"}[key])
            mutations = suite.Mutations(report, deployment, "1234567890abcdef")
            valid = b'{"addresses":0,"links":0}\n'
            for output, code in [(b"", 0), (valid + valid, 0), (valid, 2),
                                 (b'{"addresses":true,"links":0}\n', 0),
                                 (b'{"addresses":-1,"links":0}\n', 0),
                                 (b'{"addresses":0,"links":0,"extra":1}\n', 0),
                                 (b'{"addresses":broken}\n', 0)]:
                with self.subTest(output=output, code=code), patch.object(
                        suite.subprocess, "run", return_value=SimpleNamespace(stdout=output, returncode=code)):
                    with self.assertRaises(suite.auth.EvidenceError):
                        mutations.address_marker_counts("marker")
            with patch.object(suite.subprocess, "run", return_value=SimpleNamespace(stdout=valid, returncode=0)):
                self.assertEqual(mutations.address_marker_counts("marker"), {"addresses": 0, "links": 0})
            deployment.runtime = None
            with patch.object(suite.subprocess, "run") as process:
                with self.assertRaises(suite.auth.EvidenceError):
                    mutations.address_marker_counts("marker")
                process.assert_not_called()

    def test_direct_mode_blocks_before_any_address_create_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            report = suite.auth.Report(Path(directory))
            deployment = SimpleNamespace(runtime=None, required=lambda key: {
                "API_FUNCTIONS_URL": "https://functions.example.invalid",
                "API_URL": "https://dab.example.invalid/graphql/",
                "API_MCP_URL": "https://mcp.example.invalid/mcp"}[key])
            mutations = suite.Mutations(report, deployment, "1234567890abcdef")
            mutations.address_control = True
            with patch.object(suite.auth, "http") as http, patch.object(suite.subprocess, "run") as process:
                report.guarded("scenario", "mutations", lambda: mutations.address_create_denials([]))
            self.assertEqual(report.checks[0]["status"], "BLOCKED")
            http.assert_not_called()
            process.assert_not_called()

    def test_review_failed_response_remains_failed_if_followup_read_fails(self):
        report, *_ = self.run_suite("review-denial-followup-fails")
        checks = {item["id"]: item for item in report.checks}
        self.assertEqual(checks["mutation:review-create-denied-A-anonymous"]["status"], "FAIL")
        self.assertNotIn("mutation:review-create-denied-A-anonymous-unchanged", checks)
        residual = next(item for item in report.inventory["mutationResiduals"]
                        if item["kind"] == "review-denial-probe")
        self.assertEqual(residual["state"], "creation-requested")
        self.assertTrue(any(item["status"] == "BLOCKED" for item in report.checks))

    def test_rest_review_marker_fails_closed_on_incomplete_pagination(self):
        report, *_ = self.run_suite("rest-review-empty-next-link")
        checks = {item["id"]: item for item in report.checks}
        self.assertEqual(checks["mutation:reviews"]["status"], "BLOCKED")
        self.assertNotIn("mutation:review-create-denied-A-anonymous", checks)

    def test_failed_host_denial_is_not_lost_when_followup_read_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            report = suite.auth.Report(Path(directory))
            deployment = SimpleNamespace(required=lambda key: {
                "API_FUNCTIONS_URL": "https://functions.example.invalid",
                "API_URL": "https://dab.example.invalid/graphql/",
                "API_MCP_URL": "https://mcp.example.invalid/mcp"}[key])
            caller = SimpleNamespace(token=lambda resource: "wrong-audience")
            mutations = suite.Mutations(report, deployment, "1234567890abcdef")
            with patch.object(suite.auth, "http", return_value=(200, {}, b'{"ok":true}')):
                def unavailable():
                    raise suite.auth.EvidenceError("Follow-up read failed")
                report.guarded("scenario", "mutations", lambda: mutations.host_denials(
                    "password-set-A", caller, "POST", "https://functions.example.invalid/api/password",
                    {"password": "do-not-export"}, unavailable))
            self.assertEqual(report.checks[0]["id"], "mutation:host-denial-password-set-A-anonymous")
            self.assertEqual(report.checks[0]["status"], "FAIL")
            self.assertEqual(report.checks[1]["status"], "BLOCKED")
            self.assertNotIn("do-not-export", str(report.checks))

    def test_success_shaped_denials_and_nonpersisted_writes_fail(self):
        for defect in ["signup-failed", "invalid-json", "password-denied-but-written", "password-write-not-persisted",
                       "old-login-allowed", "address-denied-but-written", "address-write-not-persisted",
                       "wrong-address-link", "review-denied-but-written", "graphql-review-denied-but-written",
                       "graphql-delete-denied-but-written", "graphql-invalid-query", "graphql-delete-invalid-query",
                       "graphql-vote-error", "graphql-vote-wrong-result", "vote-write-not-persisted",
                       "host-password-denied-but-written", "host-address-denied-but-written",
                       "host-address-link-denied-but-written", "host-invalid-challenge", "host-false-denial",
                       "host-invalid-dab-control", "review-create-denied-but-written", "review-create-false-denial",
                       "review-marker-control-empty", "host-create-orphan-written", "host-create-linked-written",
                       "host-create-marker-control-empty", "host-create-marker-read-failed",
                       "catalog-denied-but-written", "catalog-invalid-challenge", "catalog-false-denial",
                       "catalog-positive-control-empty", "catalog-false-denial-read-fails",
                       "subcategory-denied-but-written", "catalog-empty-next-link", "catalog-malformed-control",
                       "graphql-create-denied-but-written", "graphql-create-invalid-query",
                       "graphql-create-not-persisted", "graphql-create-wrong-content", "graphql-create-wrong-code",
                       "graphql-create-failed-read", "graphql-wrong-audience-accepted",
                       "rest-wrong-audience-accepted", "rest-review-empty-next-link",
                       "vote-denied-but-written", "vote-invalid-denial", "vote-wrong-audience-accepted",
                       "vote-invalid-denial-read-fails"]:
            with self.subTest(defect=defect):
                report, *_ = self.run_suite(defect)
                self.assertTrue(any(item["status"] in {"FAIL", "BLOCKED"} for item in report.checks), report.checks)
                if defect in {"signup-failed", "invalid-json"}:
                    self.assertEqual(report.inventory["mutationResiduals"][0]["state"], "creation-requested")

    def test_mutation_residual_is_persisted_before_request_and_after_confirmation(self):
        events = []

        class Ledger:
            def record(self, residual):
                events.append(("record", dict(residual)))

            def update(self, residual):
                events.append(("update", dict(residual)))

        report = SimpleNamespace(inventory={})
        deployment = SimpleNamespace(required=lambda key: {
            "API_FUNCTIONS_URL": "https://functions.example.invalid",
            "API_URL": "https://dab.example.invalid/graphql/",
            "API_MCP_URL": "https://mcp.example.invalid/mcp",
        }[key])
        mutations = suite.Mutations(report, deployment, "1234567890abcdef", Ledger())
        residual = {"kind": "review", "state": "creation-requested", "owner": 42}

        mutations.record_residual(residual)
        mutations.update_residual(residual, state="retained", id=99)

        self.assertEqual(events, [
            ("record", {"kind": "review", "state": "creation-requested", "owner": 42}),
            ("update", {"kind": "review", "state": "retained", "owner": 42, "id": 99}),
        ])


if __name__ == "__main__":
    unittest.main()
