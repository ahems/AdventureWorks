import importlib.util
import base64
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.error
import xml.etree.ElementTree as ET

SPEC = importlib.util.spec_from_file_location("validate_auth", Path(__file__).with_name("validate.py"))
auth = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(auth)


class ContractTests(unittest.TestCase):
    def test_email_management_exception_is_exact_not_a_name_only_allowlist(self):
        scope = "/subscriptions/test/resourceGroups/demo/providers/Microsoft.Communication/communicationServices/comms"
        definition = {"roleName": "AdventureWorks Email Sender demo", "assignableScopes": [scope],
                      "permissions": [{"actions": ["Microsoft.Communication/communicationServices/read",
                                                   "Microsoft.Communication/communicationServices/write"],
                                       "dataActions": [], "notActions": [], "notDataActions": []}]}
        assignment = {"scope": scope, "principalId": "runtime"}
        self.assertTrue(auth.reviewed_email_sender(definition, assignment, scope, "runtime"))
        for key, value in [("scope", scope.rsplit("/providers/", 1)[0]), ("principalId", "other"),
                           ("condition", "unknown"), ("conditionVersion", "2.0")]:
            with self.subTest(key=key):
                self.assertFalse(auth.reviewed_email_sender(definition, {**assignment, key: value}, scope, "runtime"))
        for block in [{"actions": ["Microsoft.Communication/*"]},
                      {"actions": definition["permissions"][0]["actions"] + ["Microsoft.Communication/communicationServices/listKeys/action"]},
                      {**definition["permissions"][0], "dataActions": ["*"]},
                      {**definition["permissions"][0], "notActions": ["*/delete"]},
                      {"actions": "*"}]:
            with self.subTest(block=block):
                self.assertFalse(auth.reviewed_email_sender({**definition, "permissions": [block]}, assignment, scope, "runtime"))
        self.assertFalse(auth.reviewed_email_sender({**definition, "assignableScopes": [scope, "/subscriptions/test"]},
                                                   assignment, scope, "runtime"))

    def test_role_permissions_detect_custom_wildcards_and_case_insensitive_key_access(self):
        grants = auth.sensitive_management_grants({"permissions": [{
            "actions": ["microsoft.storage/storageaccounts/*"], "notActions": ["*/delete"]}]})
        self.assertIn("Microsoft.Storage/storageAccounts/listKeys/action", grants)
        self.assertIn("Microsoft.Storage/storageAccounts/write", grants)
        self.assertNotIn("Microsoft.Storage/storageAccounts/delete", grants)
        self.assertEqual(auth.sensitive_management_grants({"permissions": [{
            "actions": ["Microsoft.ContainerRegistry/registries/pull/read"], "notActions": []}]}), [])

    def test_not_actions_are_not_global_denies_across_role_permission_blocks(self):
        operation = "Microsoft.Storage/storageAccounts/listKeys/action"
        self.assertEqual(auth.sensitive_management_grants({"permissions": [
            {"actions": ["Microsoft.Storage/storageAccounts/*"], "notActions": ["*"]},
            {"actions": [operation], "notActions": []}]}), [operation])
        for definition in [{}, {"permissions": []}, {"permissions": [None]},
                           {"permissions": [{"actions": "*"}]},
                           {"permissions": [{"actions": [None]}]},
                           {"permissions": [{"actions": [], "notActions": "*"}]}]:
            with self.subTest(definition=definition), self.assertRaises(auth.EvidenceError):
                auth.sensitive_management_grants(definition)

    def test_role_management_checks_respect_resource_scope_and_extension_roles(self):
        definition = {"permissions": [{"actions": ["*"], "notActions": ["Microsoft.Authorization/*/write"]}]}
        root = "/subscriptions/test/resourceGroups/demo"
        acr = root + "/providers/Microsoft.ContainerRegistry/registries/registry"
        grants = auth.sensitive_management_grants(definition, acr)
        self.assertIn("Microsoft.ContainerRegistry/registries/listCredentials/action", grants)
        self.assertNotIn("Microsoft.Storage/storageAccounts/listKeys/action", grants)
        self.assertNotIn("Microsoft.Resources/deployments/write", grants)
        self.assertNotIn("Microsoft.Authorization/roleAssignments/write", grants)
        self.assertIn("Microsoft.Authorization/roleAssignments/delete", grants)
        project = root + "/providers/Microsoft.CognitiveServices/accounts/account/projects/project"
        self.assertNotIn("Microsoft.CognitiveServices/accounts/write",
                         auth.sensitive_management_grants(definition, project))
        for scope in [root, "/subscriptions/test", "/providers/Microsoft.Management/managementGroups/demo", "/"]:
            self.assertIn("Microsoft.Storage/storageAccounts/listKeys/action",
                          auth.sensitive_management_grants(definition, scope))
        for scope in [7, "unknown", root + "/providers/Microsoft.Storage/storageAccounts"]:
            with self.subTest(scope=scope), self.assertRaises(auth.EvidenceError):
                auth.sensitive_management_grants(definition, scope)

    def test_oauth_form_is_encoded_without_json_and_rejects_mixed_bodies(self):
        requests = []
        form = {"scope": "orders.read orders.write", "username": "fixture+test@example.invalid",
                "password": "test&only=value"}
        response = io.BytesIO(b'{"ok":true}')
        response.status, response.headers = 200, {}

        def open_request(request, **kwargs):
            requests.append(request)
            return response

        with patch.object(auth.urllib.request, "build_opener",
                          return_value=SimpleNamespace(open=open_request)):
            status, _, _ = auth.http("POST", "https://issuer.example.test/token", form=form)
            with self.assertRaises(auth.EvidenceError):
                auth.http("POST", "https://issuer.example.test/token", form=form, data={})
        self.assertEqual(status, 200)
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0].get_header("Content-type"), "application/x-www-form-urlencoded")
        self.assertEqual(auth.urllib.parse.parse_qs(requests[0].data.decode()),
                         {key: [value] for key, value in form.items()})

    def test_consumer_scenario_preserves_existing_rows_after_partial_mutation_failure(self):
        snapshots = {"7": [{"ShoppingCartItemID": 88, "ShoppingCartID": "7", "ProductID": 99, "Quantity": 1}],
                     "8": [{"ShoppingCartItemID": 89, "ShoppingCartID": "8", "ProductID": 98, "Quantity": 4}]}
        carts = {owner: list(items) for owner, items in snapshots.items()}
        deletes = []
        users = [SimpleNamespace(label=label, business_id=owner, token=lambda *args: "test-consumer-token")
                 for label, owner in [("A", 7), ("B", 8)]]
        deployment = SimpleNamespace(required=lambda key: {
            "API_FUNCTIONS_URL": "https://functions.example.test",
            "API_URL": "https://dab.example.test/graphql/"}[key])

        def fake_http(method, url, **kwargs):
            parsed = auth.urllib.parse.urlsplit(url)
            owner = auth.urllib.parse.parse_qs(parsed.query).get("cartId", [None])[0]
            status = 200
            if parsed.path == "/api/Product":
                body = {"value": [{"ProductID": 1}]}
            elif method == "GET":
                body = carts[owner]
            elif method == "POST" and owner == "7":
                body = {"ShoppingCartItemID": 90, "ShoppingCartID": "7", "ProductID": 1, "Quantity": 2}
                carts[owner].append(body)
            elif method == "POST":
                status, body = 503, {"error": "unavailable"}
            elif method == "DELETE":
                deletes.append((owner, parsed.path))
                self.assertEqual((owner, parsed.path), ("7", "/api/cart/items/90"))
                carts[owner] = [row for row in carts[owner] if row["ShoppingCartItemID"] != 90]
                body = {"deleted": True}
            else:
                self.fail("Unexpected scenario request")
            return status, {}, json.dumps(body).encode()

        with tempfile.TemporaryDirectory() as directory:
            report = auth.Report(Path(directory))
            with patch.object(auth, "http", side_effect=fake_http), self.assertRaises(auth.EvidenceError):
                auth.consumer_cart_live(report, deployment, users)
            ledger = json.loads((Path(directory) / "consumer-cart-ledger.json").read_text())
        self.assertEqual(carts, snapshots)
        self.assertEqual(len(deletes), 1)
        self.assertEqual(ledger["productId"], 1)
        self.assertTrue(any(check["id"] == "consumer-cart:add-B" and check["status"] == "FAIL"
                            for check in report.checks))
        for label in ["A", "B"]:
            self.assertTrue(any(check["id"] == "consumer-cart:cleanup:" + label and check["status"] == "PASS"
                                for check in report.checks))

    def test_reusable_consumers_are_created_once_and_never_serialize_credentials(self):
        accounts = {}
        signup_calls = []
        values = {"API_MCP_URL": "https://issuer.example.test/mcp",
                  "API_FUNCTIONS_URL": "https://functions.example.test"}
        deployment = SimpleNamespace(values=values, environment=None, required=lambda key: values[key])

        def fake_http(method, url, **kwargs):
            if url.endswith("/signup"):
                email = kwargs["data"]["email"]
                signup_calls.append(email)
                self.assertTrue(email.endswith("@example.invalid"))
                self.assertLessEqual(len(email), 50)
                accounts[email] = len(accounts) + 7
                return 201, {}, json.dumps({"businessEntityId": accounts[email]}).encode()
            form = kwargs["form"]
            if form["username"] not in accounts:
                return 400, {}, b'{"error":"invalid_grant"}'
            payload = base64.urlsafe_b64encode(json.dumps({
                "category": "consumer", "business_entity_id": str(accounts[form["username"]])}).encode()).decode().rstrip("=")
            return 200, {}, json.dumps({"access_token": "header." + payload + ".signature", "expires_in": 600}).encode()

        def persist(d, updated):
            d.values.update({key: str(value) for key, value in updated.items()})

        with patch.object(auth, "http", side_effect=fake_http), patch.object(auth, "persist_fixture_values", side_effect=persist):
            first_report, second_report = auth.Report(Path(".")), auth.Report(Path("."))
            first = auth.consumer_fixtures(first_report, deployment)
            second = auth.consumer_fixtures(second_report, deployment)
        self.assertEqual(len(signup_calls), 2)
        self.assertEqual([item.business_id for item in first], [7, 8])
        self.assertEqual([item.business_id for item in second], [7, 8])
        for item in first:
            serialized = json.dumps({"checks": first_report.checks, "inventory": first_report.inventory})
            self.assertNotIn(item.password, serialized)
            self.assertNotIn(item.email, serialized)

    def test_fixture_persistence_uses_private_file_not_secret_command_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / ".azure" / "test" / ".env"
            path.parent.mkdir(parents=True)
            path.write_text("")
            calls, content = [], []

            def fake_command(args, **kwargs):
                calls.append(args)
                if "--file" in args:
                    temporary = Path(args[args.index("--file") + 1])
                    self.assertEqual(temporary.stat().st_mode & 0o777, 0o600)
                    content.append(temporary.read_text())
                return ""

            deployment = SimpleNamespace(environment=None, values={})
            with patch.object(auth, "ROOT", root), patch.object(auth, "json_command", return_value=[
                    {"Name": "test", "IsDefault": True, "HasLocal": True, "DotEnvPath": str(path)}]), \
                    patch.object(auth, "command", side_effect=fake_command):
                auth.persist_fixture_values(deployment, {"AUTH_TEST_CONSUMER_A_PASSWORD": "private-fixture-value"})
            self.assertIn("private-fixture-value", content[0])
            self.assertNotIn("private-fixture-value", json.dumps(calls))
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertFalse(Path(calls[-1][calls[-1].index("--file") + 1]).exists())

    def test_guest_expiry_accepts_dotnet_precision_and_requires_timezone(self):
        self.assertEqual(auth.guest_expiry("2026-11-10T18:02:07.1644355+00:00"),
                         auth.guest_expiry("2026-11-10T18:02:07.164435Z"))
        for value in [None, "invalid", "2026-11-10T18:02:07", "2026-99-10T18:02:07Z"]:
            with self.subTest(value=value), self.assertRaises(auth.EvidenceError):
                auth.guest_expiry(value)

    def test_guest_scenario_retires_known_fixture_after_later_bootstrap_failure(self):
        proof = "A" * 64
        cart = "guest-" + "a" * 32
        expiry = auth.datetime.fromtimestamp(
            auth.datetime.now(auth.timezone.utc).timestamp() + 86400, auth.timezone.utc).isoformat()
        calls = []

        def fake_http(method, url, **kwargs):
            calls.append((method, url, kwargs))
            if "/api/Product?" in url:
                return 200, {}, b'{"value":[{"ProductID":1}]}'
            if method == "POST":
                if sum(item[0] == "POST" for item in calls) > 1:
                    raise auth.EvidenceError("Network/TLS/timeout failure; not an authorization denial")
                return 200, {}, json.dumps({"token": proof, "cartId": cart, "expiresAt": expiry}).encode()
            if method == "DELETE":
                self.assertEqual(kwargs["headers"]["X-Guest-Cart-Session"], proof)
                return 200, {}, b'{"retired":true}'
            if not any(item[0] == "DELETE" for item in calls):
                return 200, {}, b'[]'
            return 401, {}, b'{"error":"guest_session_expired_or_invalid"}'

        with tempfile.TemporaryDirectory() as directory:
            report = auth.Report(Path(directory))
            deployment = SimpleNamespace(required=lambda key: {
                "API_FUNCTIONS_URL": "https://functions.example.test",
                "API_URL": "https://dab.example.test/graphql/"}[key])
            with patch.object(auth, "http", side_effect=fake_http), self.assertRaises(auth.EvidenceError):
                auth.guest_cart_live(report, deployment)
            ledger = (Path(directory) / "guest-cart-ledger.json").read_text()
            self.assertNotIn(proof, ledger)
            self.assertTrue(json.loads(ledger)["sessions"][0]["retired"])
            self.assertEqual(sum(call[0] == "DELETE" for call in calls), 1)
            self.assertTrue(any(check["id"] == "guest-cart:retired-proof:0" and check["status"] == "PASS"
                                for check in report.checks))

    def test_browser_gate_requires_exact_assertions_and_distinguishes_missing_prerequisites(self):
        names = ["guest-add-persists", "guest-cart-survives-reload", "checkout-requires-signin",
                 "no-non-cart-function-mutations", "exact-browser-fixture-retired"]
        consumer = SimpleNamespace(tokens={}, email="fixture@example.invalid", password="private-fixture-password",
                                   business_id=7, token=lambda *args: "private-fixture-token")
        consumer_names = names + ["consumer-auto-merge", "merged-guest-proof-denied", "consumer-cart-reload",
                                  "exact-consumer-fixture-removed"]
        for checks, command_failed, expected, fixture in [
                ([{"name": name, "status": "PASS"} for name in names], False, "PASS", None),
                ([{"name": name, "status": "PASS"} for name in names + [names[0]]], False, "FAIL", None),
                ([], False, "FAIL", None),
                ([{"name": "browser-prerequisites", "status": "BLOCKED"}], True, "BLOCKED", None),
                ([{"name": name, "status": "PASS"} for name in names], True, "FAIL", None),
                ([{"name": name, "status": "PASS"} for name in names], False, "FAIL", consumer),
                ([{"name": name, "status": "PASS"} for name in consumer_names], False, "PASS", consumer)]:
            with self.subTest(expected=expected), tempfile.TemporaryDirectory() as directory:
                report = auth.Report(Path(directory))
                deployment = SimpleNamespace(
                    required=lambda key: {"SERVICE_APP_NAME": "site", "AZURE_RESOURCE_GROUP": "group",
                                          "API_FUNCTIONS_URL": "https://functions.example.test"}[key],
                    azure=lambda *args: {"defaultHostname": "site.example.test"})

                def fake_command(*args, **kwargs):
                    if fixture:
                        self.assertEqual(kwargs["environment"]["AUTH_BROWSER_CONSUMER_PASSWORD"], fixture.password)
                        self.assertNotIn(fixture.password, json.dumps(args))
                        self.assertNotIn("private-fixture-token", json.dumps(args))
                    else:
                        self.assertFalse(any(key.startswith("AUTH_BROWSER_CONSUMER_")
                                             for key in kwargs["environment"]))
                    (Path(directory) / "guest-cart-browser.json").write_text(json.dumps({"checks": checks}))
                    if command_failed:
                        raise auth.EvidenceError("Browser command failed")
                    return ""

                with patch.object(auth, "command", side_effect=fake_command), \
                        patch.dict(auth.os.environ, {"AUTH_BROWSER_CONSUMER_ID": "unintended"}):
                    auth.guest_cart_browser(report, deployment, fixture)
                self.assertEqual(report.checks[-1]["status"], expected)

    def test_https_rejects_credentials_queries_fragments_and_insecure_urls(self):
        for value in ["http://example.test", "", "/relative", "https://user:pw@example.test",
                      "https://example.test/?token=secret", "https://example.test/#secret"]:
            with self.subTest(value=value), self.assertRaises(auth.EvidenceError):
                auth.https_url(value)
        self.assertEqual(auth.https_url("https://example.test/"), "https://example.test")

    def test_origin_drops_paths_not_hostname_suffixes(self):
        self.assertEqual(auth.origin("https://example.test/mcp"), "https://example.test")
        self.assertEqual(auth.origin("https://example.test.attacker.test/mcp"),
                         "https://example.test.attacker.test")

    def test_routes_replace_every_parameter_and_preserve_constraints(self):
        self.assertEqual(auth.route_path("orders/{id:int}/lines/{line:long}"), "orders/1/lines/1")
        self.assertEqual(auth.route_path("jobs/{id:guid}"),
                         "jobs/11111111-1111-1111-1111-111111111111")
        self.assertEqual(auth.route_path("runs/{id}/steps/{*rest}"),
                         "runs/auth-validation/steps/auth-validation")

    def test_dab_inventory_preserves_field_and_database_policy(self):
        permission = {"role": "consumer", "actions": [
            {"action": "read", "policy": {"database": "@item.ID eq @claims.customer_id"},
             "fields": {"include": ["ID"], "exclude": ["Password"]}}]}
        result = auth.dab_inventory({"entities": {"Order": {
            "source": {"object": "Sales.Order", "type": "table"}, "permissions": [permission]}}})
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["permission"], permission)
        self.assertEqual(result[0]["entity"], "Order")

    def test_dab_rejects_empty_discovery_and_unsupported_actions(self):
        for config in [{}, {"entities": {}}, {"entities": {"Order": {"permissions": []}}},
                       {"entities": {"Order": {"permissions": [{"role": "anonymous", "actions": ["magic"]}]}}}]:
            with self.subTest(config=config), self.assertRaises(auth.EvidenceError):
                auth.dab_inventory(config)

    def test_dab_policy_columns_must_be_accessible_without_broadening_write_fields(self):
        for fields in [{"include": ["HelpfulVotes"]}, {"include": ["*"], "exclude": ["UserID"]}]:
            config = {"entities": {"ProductReview": {"source": "Production.ProductReview", "permissions": [{
                "role": "consumer", "actions": [{"action": "update", "fields": fields,
                    "policy": {"database": "@item.UserID ne @claims.business_entity_id"}}]}]}}}
            with self.subTest(fields=fields), self.assertRaisesRegex(auth.EvidenceError, "inaccessible fields: UserID"):
                auth.dab_inventory(config)

    def test_passwordless_sql_checks_auth_not_connection_string_variable_name(self):
        self.assertTrue(auth.passwordless_sql(
            "Server=tcp:server;Database=demo;Authentication=Active Directory Default;"))
        self.assertTrue(auth.passwordless_sql(
            "Server=server;Authentication=Active Directory Managed Identity;"))
        for value in [None, "", "Server=server;User ID=admin;Password=secret;",
                      "Authentication=Active Directory Default;Pwd=secret;",
                      "Authentication=Active Directory Default;Authentication=SqlPassword;",
                      "Server=server;BrokenField"]:
            with self.subTest(value=value):
                self.assertFalse(auth.passwordless_sql(value))

    def test_review_denial_uses_complete_shape_and_requires_absent_product(self):
        with patch.object(auth, "http", return_value=(200, {}, b'{"value":[]}')):
            body = auth.review_denial_body("https://dab.example.test")
            self.assertEqual(body["ProductID"], 0)
            self.assertEqual(body["UserID"], 0)
            self.assertEqual(set(body), {
                "ProductID", "ReviewerName", "ReviewDate", "EmailAddress", "Rating", "Comments", "UserID"})
        for response in [(200, {}, b'{"value":[{"ProductID":0}]}'),
                         (403, {}, b'{}'), (200, {}, b'invalid')]:
            with patch.object(auth, "http", return_value=response), self.assertRaises(auth.EvidenceError):
                auth.review_denial_body("https://dab.example.test")

    def test_contract_names_are_unique_and_chat_is_not_an_anonymous_business_exception(self):
        contract = json.loads(auth.CONTRACTS.read_text())
        self.assertEqual(len(contract["anonymousDabReads"]), len(set(contract["anonymousDabReads"])))
        self.assertEqual(contract["publicFunctions"]["AIAgentChat"], "alternate-mcp-enforcement")
        self.assertNotIn("ShoppingCartItem", contract["anonymousDabReads"])
        self.assertNotIn("ShoppingCartItem", contract["unreviewedAnonymousDabOperations"])

    def test_cart_contract_requires_owned_read_only_dab_and_rejects_anonymous_regressions(self):
        config = json.loads((auth.ROOT / "api/dab-config.json").read_text())
        report = auth.Report(Path("."))
        auth.cart_contract(report, config)
        self.assertTrue(all(check["status"] == "PASS" for check in report.checks))
        config["entities"]["ShoppingCartItem"]["permissions"].append({"role": "anonymous", "actions": ["read"]})
        report = auth.Report(Path("."))
        auth.cart_contract(report, config)
        self.assertTrue(all(check["status"] == "FAIL" for check in report.checks))

    def test_review_contract_preserves_public_reads_and_authenticates_all_mutations(self):
        config = json.loads((auth.ROOT / "api/dab-config.json").read_text())
        report = auth.Report(Path("."))
        auth.review_contract(report, config)
        self.assertEqual(len(report.checks), 5)
        self.assertTrue(all(check["status"] == "PASS" for check in report.checks))
        config["entities"]["ProductReview"]["permissions"][0]["actions"].append("create")
        report = auth.Report(Path("."))
        auth.review_contract(report, config)
        self.assertEqual(report.checks[0]["status"], "FAIL")

    def test_review_contract_rejects_unscoped_or_privileged_authenticated_writes(self):
        for role in ["authenticated", "consumer"]:
            for defect in ["author", "moderation", "vote"]:
                config = json.loads((auth.ROOT / "api/dab-config.json").read_text())
                permission = next(item for item in config["entities"]["ProductReview"]["permissions"]
                                  if item["role"] == role)
                create, _, update = permission["actions"]
                if defect == "author":
                    create.pop("policy")
                elif defect == "moderation":
                    create["fields"]["include"].append("IsModerated")
                else:
                    update["fields"]["include"].append("Comments")
                report = auth.Report(Path("."))
                auth.review_contract(report, config)
                self.assertTrue(any(check["status"] == "FAIL" for check in report.checks))

    def test_mcp_unwraps_json_and_sse_and_does_not_confuse_transport_with_success(self):
        result = {"jsonrpc": "2.0", "id": 1, "result": {"isError": True}}
        for body in [json.dumps(result).encode(), ("event: message\ndata: " + json.dumps(result) + "\n\n").encode()]:
            self.assertTrue(auth.mcp_document(body)["result"]["isError"])
        for body in [b"{}", b"event: ping\n\n", b"data: invalid\n\n"]:
            if body == b"{}":
                self.assertEqual(auth.mcp_document(body), {})
            else:
                with self.assertRaises(auth.EvidenceError):
                    auth.mcp_document(body)

    def test_agent_discovery_follows_all_pages(self):
        deployment = SimpleNamespace(required=lambda key: "https://foundry.example.test/api/projects/project")
        with patch.object(auth, "https_url", wraps=auth.https_url):
            deployment.azure = unittest.mock.Mock(side_effect=[
                {"data": [{"name": "one"}], "has_more": True, "last_id": "cursor"},
                {"data": [{"name": "two"}], "has_more": False}])
            self.assertEqual(set(auth.fetch_agents(deployment)), {"one", "two"})
        self.assertIn("after=cursor", deployment.azure.call_args.args[-1])

    def test_agent_discovery_rejects_repeated_cursor_empty_and_duplicate_names(self):
        for pages in [
                [{"data": [], "has_more": False}],
                [{"data": [{"name": "one"}], "has_more": True, "last_id": "same"},
                 {"data": [{"name": "two"}], "has_more": True, "last_id": "same"}],
                [{"data": [{"name": "one"}], "has_more": True, "last_id": "cursor"},
                 {"data": [{"name": "one"}], "has_more": False}]]:
            deployment = SimpleNamespace(required=lambda key: "https://foundry.example.test")
            deployment.azure = unittest.mock.Mock(side_effect=pages)
            with self.assertRaises(auth.EvidenceError):
                auth.fetch_agents(deployment)


class ReportTests(unittest.TestCase):
    def report(self, root):
        return auth.Report(Path(root))

    def test_blocked_assertions_prevent_success_and_do_not_inflate_coverage(self):
        with tempfile.TemporaryDirectory() as root:
            report = self.report(root)
            report.add("allow", "live", "PASS", "data returned")
            report.add("missing", "live", "BLOCKED", "identity unavailable")
            report.add("exception", "live", "ACCEPTED_EXCEPTION", "bounded public discovery")
            with patch("sys.stdout", new=io.StringIO()):
                self.assertEqual(report.save(), 2)
            document = json.loads((Path(root) / "report.json").read_text())
            self.assertEqual(document["outcome"], "BLOCKED")
            self.assertEqual(document["groups"]["live"]["applicable"], 2)
            self.assertEqual(document["groups"]["live"]["completed"], 1)
            tree = ET.parse(Path(root) / "junit.xml")
            self.assertEqual(len(tree.findall(".//error")), 1)
            self.assertEqual(len(tree.findall(".//skipped")), 1)

    def test_failure_dominates_blocked_and_uses_nonzero_exit(self):
        with tempfile.TemporaryDirectory() as root:
            report = self.report(root)
            report.add("denial", "live", "FAIL", "expected 401 received 200")
            report.add("missing", "live", "BLOCKED", "unavailable")
            with patch("sys.stdout", new=io.StringIO()):
                self.assertEqual(report.save(), 1)

    def test_duplicate_ids_and_invalid_status_fail_loudly(self):
        report = self.report(".")
        report.add("one", "offline", "PASS", "done")
        with self.assertRaises(ValueError):
            report.add("one", "offline", "PASS", "duplicate")
        with self.assertRaises(ValueError):
            report.add("two", "offline", "UNKNOWN", "invalid")

    def test_guard_does_not_swallow_programming_errors(self):
        report = self.report(".")
        with self.assertRaises(ZeroDivisionError):
            report.guarded("bug", "offline", lambda: 1 / 0)

    def test_guard_records_unavailable_evidence_not_pass(self):
        report = self.report(".")
        def unavailable():
            raise auth.EvidenceError("private endpoint unavailable")
        report.guarded("network", "infra", unavailable)
        self.assertEqual(report.checks[0]["status"], "BLOCKED")


class TransportTests(unittest.TestCase):
    def test_cli_failure_does_not_expose_stdout_stderr_or_credentials(self):
        result = SimpleNamespace(returncode=1, stdout="access_token=secret", stderr="password=secret")
        with patch.object(auth.subprocess, "run", return_value=result) as run:
            with self.assertRaises(auth.EvidenceError) as error:
                auth.command(["az", "rest", "--url", "https://example.test"])
        self.assertNotIn("secret", str(error.exception))
        self.assertFalse(run.call_args.kwargs.get("shell", False))

    def test_redirects_are_not_followed(self):
        redirect = auth.NoRedirect()
        self.assertIsNone(redirect.redirect_request(None, None, 302, "", {}, "https://foreign.test/"))

    def test_network_failure_is_not_auth_denial(self):
        opener = SimpleNamespace(open=lambda *args, **kwargs: self.raise_url_error())
        with patch.object(auth.urllib.request, "build_opener", return_value=opener):
            with self.assertRaisesRegex(auth.EvidenceError, "not an authorization denial"):
                auth.http("GET", "https://example.test")

    @staticmethod
    def raise_url_error():
        raise urllib.error.URLError("could not connect")

    def test_azd_environment_selection_is_explicit_and_never_uses_shell(self):
        with patch.object(auth, "json_command", return_value={
                "AZURE_SUBSCRIPTION_ID": "subscription", "AZURE_RESOURCE_GROUP": "group"}) as run:
            deployment = auth.Deployment("selected-env")
        self.assertEqual(deployment.group, "group")
        self.assertIn("--environment", run.call_args.args[0])
        self.assertIn("selected-env", run.call_args.args[0])

    def test_missing_azd_values_are_errors_not_fallback_hostnames(self):
        with patch.object(auth, "json_command", return_value={}):
            with self.assertRaisesRegex(auth.EvidenceError, "AZURE_SUBSCRIPTION_ID"):
                auth.Deployment(None)


if __name__ == "__main__":
    unittest.main()
