import copy
import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import workload_probe as probe


class WorkloadProbeTests(unittest.TestCase):
    def run_probe(self, scenario="complete"):
        identity = {
            "clientId": "11111111-1111-4111-8111-111111111111",
            "principalId": "22222222-2222-4222-8222-222222222222",
            "tenantId": "33333333-3333-4333-8333-333333333333",
        }
        configuration = {
            "identity": identity,
            "values": {"API_MCP_URL": "https://mcp.example.invalid/mcp",
                       "API_URL": "https://dab.example.invalid/graphql/",
                       "API_FUNCTIONS_URL": "https://functions.example.invalid",
                       "MCP_RESOURCE_IDENTIFIER": "https://resource.example.invalid/mcp"},
        }
        assertion = {
            "aud": "api://AzureADTokenExchange", "oid": identity["principalId"],
            "tid": identity["tenantId"], "appid": identity["clientId"],
        }
        issued = {
            "iss": "https://mcp.example.invalid/",
            "aud": configuration["values"]["MCP_RESOURCE_IDENTIFIER"],
            "sub": "service:" + identity["principalId"], "category": "service",
            "app": "adventureworks-agents", "scope": "products.read mcp.access", "exp": 9999999999,
        }
        if scenario == "wrong-identity":
            assertion["oid"] = identity["clientId"]
        if scenario == "normalized-exchange-audience":
            assertion["aud"] = "fb60f99c-7a34-4190-8149-302f77469936"
        if scenario == "wrong-exchange-audience":
            assertion["aud"] = "https://graph.microsoft.com"
        if scenario == "broad-token":
            issued["scope"] += " orders.read"
        if scenario == "consumer-token":
            issued["category"] = "consumer"
        if scenario == "wrong-audience":
            issued["aud"] = "https://other.example.invalid/mcp"
        if scenario == "expired":
            issued["exp"] = 1
        if scenario == "owner-claims":
            issued["customer_id"] = "42"
        scopes = []
        requests = []

        def get_token(scope):
            scopes.append(scope)
            return SimpleNamespace(token="secret-entra-assertion")

        def request(method, url, **kwargs):
            requests.append((method, url, copy.deepcopy(kwargs)))
            if url.endswith("/token"):
                form = kwargs["form"]
                self.assertEqual(form["assertion"], "secret-entra-assertion")
                self.assertNotIn("token", kwargs)
                if form["resource"] != configuration["values"]["MCP_RESOURCE_IDENTIFIER"]:
                    self.assertEqual(form["scope"], "mcp.access products.read")
                    if scenario == "wrong-target-allowed":
                        return 200, {}, b'{"access_token":"secret-unexpected-token"}'
                    return 400, {}, b'{"error":"invalid_target"}'
                if form["scope"] != "mcp.access products.read":
                    self.assertIn(form["scope"], ["mcp.access mcp.admin", "mcp.access manufacturing.write"])
                    if ((scenario == "admin-grant-allowed" and form["scope"].endswith("mcp.admin")) or
                            (scenario == "manufacturing-grant-allowed" and
                             form["scope"].endswith("manufacturing.write"))):
                        return 200, {}, b'{"access_token":"secret-unexpected-token"}'
                    return 400, {}, b'{"error":"invalid_scope"}'
                if scenario == "grant-denied":
                    return 400, {}, b'{"error":"invalid_grant","error_description":"secret-values"}'
                if scenario == "grant-malformed":
                    return 200, {}, b"invalid"
                return 200, {}, b'{"access_token":"secret-service-token","token_type":"Bearer"}'
            self.assertEqual(kwargs["token"], "secret-service-token")
            if url.endswith("/mcp"):
                payload = kwargs["data"]
                name = payload["params"]["name"]
                if name == "get_categories_with_products":
                    if scenario == "catalogue-http-failure":
                        return 403, {}, b'{"error":"secret-denied-values"}'
                    if scenario == "catalogue-malformed":
                        return 200, {}, b"invalid"
                    text = "AdventureWorks Product Catalogue\nProductID=1: Public product"
                    if scenario == "empty-catalogue":
                        text = "No products"
                    result = {"content": [{"type": "text", "text": text}]}
                    if scenario == "catalogue-invalid-error-type":
                        result["isError"] = 0
                elif name == "get_product_availability":
                    self.assertEqual(payload["params"]["arguments"], {"productId": 0})
                    if scenario == "profile-tool-malformed":
                        return 200, {}, b"invalid"
                    if scenario == "profile-tool-leak":
                        result = {"content": [{"type": "text", "text": "private values must not escape"}]}
                    elif scenario == "profile-task-created":
                        result = {"taskId": "unexpected-task"}
                    else:
                        result = {"isError": True, "content": [{"type": "text",
                            "text": "This service is not authorized to call this tool."}]}
                elif scenario == "scope-leak":
                    result = {"content": [{"type": "text", "text": "private values must not escape"}]}
                else:
                    scope = "orders.read" if name == "get_personalized_recommendations" else "sales.read"
                    result = {"isError": True, "content": [{"type": "text", "text":
                        f"This operation requires the '{scope}' scope, which your account does not have."}]}
                return 200, {}, json.dumps({"jsonrpc": "2.0", "id": payload["id"], "result": result}).encode()
            return (200 if scenario == "other-resource-allowed" else 401), {}, b""

        helper = SimpleNamespace(claims=lambda token: assertion if token == "secret-entra-assertion" else issued,
                                 AuthError=ValueError)
        credential = SimpleNamespace(get_token=get_token)
        with patch.object(probe.auth, "load_auth_helper", return_value=helper), \
                patch.object(probe.auth, "http", side_effect=request):
            document = probe.workload_checks(configuration, credential)
        self.assertNotIn("secret-", json.dumps(document))
        self.assertNotIn("private values", json.dumps(document))
        self.assertNotIn("Public product", json.dumps(document))
        return document, requests, scopes

    def test_real_identity_scope_and_resource_contract_uses_only_read_only_probes(self):
        document, requests, scopes = self.run_probe()
        self.assertEqual(scopes, ["api://AzureADTokenExchange/.default"])
        self.assertEqual(len(document["checks"]), 14)
        self.assertTrue(all(check["status"] == "PASS" for check in document["checks"]))
        self.assertEqual(len(requests), 13)
        self.assertEqual({request[1].split("/")[2] for request in requests},
                         {"mcp.example.invalid", "functions.example.invalid", "dab.example.invalid"})
        self.assertEqual({request[2]["data"]["params"]["name"] for request in requests
                          if request[1].endswith("/mcp")},
                         {"get_categories_with_products", "get_product_availability",
                          "get_personalized_recommendations", "get_business_stats"})
        self.assertIn("not proof", document["provenance"]["identityOrigin"])

    def test_wrong_identity_never_exchanges_and_wrong_grants_never_dispatch(self):
        for scenario, expected_requests in [("wrong-identity", 0), ("wrong-exchange-audience", 0), ("broad-token", 1),
                                            ("consumer-token", 1), ("wrong-audience", 1),
                                            ("expired", 1), ("owner-claims", 1),
                                            ("grant-denied", 1), ("grant-malformed", 1)]:
            with self.subTest(scenario=scenario):
                document, requests, _ = self.run_probe(scenario)
                self.assertEqual(len(requests), expected_requests)
                self.assertTrue(any(check["status"] == "FAIL" for check in document["checks"]))
                self.assertEqual(document["checks"][-1]["status"], "BLOCKED")

    def test_normalized_entra_exchange_application_id_is_accepted_without_broadening_scopes(self):
        document, requests, _ = self.run_probe("normalized-exchange-audience")
        self.assertEqual(len(requests), 13)
        self.assertTrue(all(check["status"] == "PASS" for check in document["checks"]))

    def test_empty_positive_scope_leaks_and_other_resource_acceptance_cannot_pass(self):
        for scenario in ["empty-catalogue", "scope-leak", "other-resource-allowed", "wrong-target-allowed",
                         "catalogue-http-failure", "catalogue-malformed", "catalogue-invalid-error-type",
                         "admin-grant-allowed", "manufacturing-grant-allowed", "profile-tool-leak",
                         "profile-tool-malformed", "profile-task-created"]:
            with self.subTest(scenario=scenario):
                document, _, _ = self.run_probe(scenario)
                self.assertTrue(any(check["status"] == "FAIL" for check in document["checks"]))


if __name__ == "__main__":
    unittest.main()
