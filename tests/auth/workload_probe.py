"""Read-only MCP service-grant proof from the private job's actual managed identity."""

import json
from pathlib import Path
import re
import time
from types import SimpleNamespace
import uuid

import validate as auth


def workload_checks(configuration, credential=None):
    report = auth.Report(Path("."))
    report.provenance["identityOrigin"] = (
        "Temporary private job using the shared runtime UAMI; not proof of an actual "
        "Functions, project, seed or hosted-agent instance invocation.")
    owned_credential = credential is None
    azure_errors = ()

    def verify():
        nonlocal credential, azure_errors
        identity = configuration.get("identity", {})
        try:
            client_id, principal_id, tenant_id = (
                str(uuid.UUID(identity[key])) for key in ["clientId", "principalId", "tenantId"])
        except (ValueError, TypeError, KeyError) as error:
            raise auth.EvidenceError("Private workload identity configuration is incomplete") from error
        values = configuration["values"]
        mcp = auth.origin(values["API_MCP_URL"])
        dab = auth.origin(values["API_URL"])
        functions = auth.origin(values["API_FUNCTIONS_URL"])
        resource = values.get("MCP_RESOURCE_IDENTIFIER", mcp + "/mcp")
        if not isinstance(resource, str) or not resource:
            raise auth.EvidenceError("Selected MCP resource identifier is invalid")
        helper = auth.load_auth_helper()
        if credential is None:
            from azure.core.exceptions import AzureError
            from azure.identity import ManagedIdentityCredential
            azure_errors = (AzureError,)
            credential = ManagedIdentityCredential(client_id=client_id)
        try:
            assertion = credential.get_token("api://AzureADTokenExchange/.default").token
        except azure_errors as error:
            raise auth.EvidenceError(
                f"Private managed-identity assertion unavailable ({type(error).__name__}); no user fallback") from error

        def claims(token):
            try:
                return helper.claims(token)
            except (helper.AuthError, ValueError, TypeError) as error:
                raise auth.EvidenceError("Workload token metadata is malformed; values withheld") from error

        def lower_claim(payload, key):
            value = payload.get(key)
            return value.lower() if isinstance(value, str) else None

        asserted = claims(assertion)
        valid = (
            # Entra can normalize the exchange URI to its well-known application ID.
            asserted.get("aud") in {"api://AzureADTokenExchange", "fb60f99c-7a34-4190-8149-302f77469936"} and
            lower_claim(asserted, "oid") == principal_id and
            lower_claim(asserted, "tid") == tenant_id and
            (lower_claim(asserted, "azp") if "azp" in asserted else
             lower_claim(asserted, "appid")) == client_id)
        report.check("workload:entra:configured-uami", "private-workload", valid,
                     "Private job's shared runtime UAMI matches selected client, principal, tenant and exchange audience; "
                     "not an actual Functions/project/seed/hosted-agent instance invocation.")
        if not valid:
            raise auth.EvidenceError("Managed identity does not match the selected runtime principal; no exchange attempted")
        form = {
            "grant_type": "urn:adventureworks:params:oauth:grant-type:managed-identity",
            "client_id": "adventureworks-agents", "assertion": assertion,
            "resource": resource, "scope": "mcp.access products.read",
        }
        status, _, raw = auth.http("POST", mcp + "/token", form=form)
        try:
            response = json.loads(raw)
            token = response["access_token"]
            token_type = response["token_type"]
        except (ValueError, TypeError, KeyError) as error:
            report.add("workload:mcp:catalogue-only-grant", "private-workload", "FAIL",
                       f"Expected service grant returned an incomplete response; HTTP {status}; values withheld.")
            raise auth.EvidenceError(
                f"Catalogue-only service grant returned no complete token; HTTP {status}; values withheld") from error
        if status != 200 or not isinstance(token, str) or token_type != "Bearer":
            report.add("workload:mcp:catalogue-only-grant", "private-workload", "FAIL",
                       f"Expected service grant was not accepted; HTTP {status}; values withheld.")
            raise auth.EvidenceError("Catalogue-only service grant failed; no user or broader-scope fallback")
        issued = claims(token)
        scope = issued.get("scope")
        valid = (
            issued.get("iss") == mcp + "/" and issued.get("aud") == resource and
            lower_claim(issued, "sub") == "service:" + principal_id and
            issued.get("category") == "service" and issued.get("app") == "adventureworks-agents" and
            isinstance(scope, str) and sorted(scope.split()) == ["mcp.access", "products.read"] and
            type(issued.get("exp")) is int and issued["exp"] > time.time() and
            "customer_id" not in issued and "business_entity_id" not in issued)
        report.check("workload:mcp:catalogue-only-grant", "private-workload", valid,
                     "Service grant preserves the actual principal, service category, MCP audience and exact two scopes; tokens withheld.")
        if not valid:
            raise auth.EvidenceError("Issued service token is broader or differently bound than requested")
        deployment = SimpleNamespace(required=values.__getitem__)
        status, _, raw = auth.http(
            "POST", mcp + "/mcp", token=token,
            data={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                  "params": {"name": "get_categories_with_products", "arguments": {"maxProductsPerSubcategory": 1}}})
        try:
            if status != 200:
                raise auth.EvidenceError("Catalogue request was not accepted")
            document = auth.mcp_document(raw)
        except auth.EvidenceError as error:
            report.add("workload:mcp:catalogue-read", "private-workload", "FAIL",
                       f"Catalogue positive control returned no valid MCP result; HTTP {status}; values withheld.")
            raise auth.EvidenceError("Workload catalogue positive control failed; output withheld") from error
        result = document.get("result")
        content = result.get("content") if isinstance(result, dict) else None
        valid = (
            status == 200 and document.get("jsonrpc") == "2.0" and
            type(document.get("id")) is int and document["id"] == 1 and
            "error" not in document and isinstance(result, dict) and
            (result.get("isError") is None or result.get("isError") is False) and
            isinstance(content, list) and len(content) == 1 and
            isinstance(content[0], dict) and content[0].get("type") == "text" and
            isinstance(content[0].get("text"), str) and
            content[0]["text"].startswith("AdventureWorks Product Catalogue") and
            re.search(r"\bProductID=[1-9][0-9]*:", content[0]["text"]) is not None)
        report.check("workload:mcp:catalogue-read", "private-workload", valid,
                     f"Catalogue-only real UAMI token reads SQL-backed catalogue output; HTTP {status}; records withheld.")
        if not valid:
            raise auth.EvidenceError("Workload catalogue positive control failed; output withheld")
        for tool, scope in [("get_personalized_recommendations", "orders.read"),
                            ("get_business_stats", "sales.read")]:
            for task in [False, True]:
                auth.mcp_task_scope_denial(
                    report, deployment, token, tool=tool, required_scope=scope, task=task,
                    check_id=f"workload:mcp:{tool}:scope-denial:{task}")
        for label, url, data in [
                ("functions", functions + "/api/addresses", None),
                ("dab", dab + "/graphql", {"query": "{ products(first: 1) { items { ProductID } } }"})]:
            status, _, _ = auth.http("GET" if data is None else "POST", url, token=token, data=data)
            report.check("workload:audience:" + label, "private-workload", status == 401,
                         f"MCP-only service token rejected by the other resource; HTTP {status}.")
        for label, target in [
                ("functions", values.get("FUNCTIONS_RESOURCE_IDENTIFIER", functions)),
                ("dab", values.get("DAB_RESOURCE_IDENTIFIER", dab))]:
            if not isinstance(target, str) or not target or target == resource:
                raise auth.EvidenceError("Other-resource grant denial requires distinct configured audiences")
            status, _, raw = auth.http("POST", mcp + "/token", form={**form, "resource": target})
            try:
                document = json.loads(raw)
            except ValueError:
                document = None
            report.check("workload:grant-target:" + label, "private-workload",
                         status == 400 and isinstance(document, dict) and
                         document.get("error") == "invalid_target" and "access_token" not in document,
                         f"Same real assertion cannot mint a service token for another resource; HTTP {status}; values withheld.")

    try:
        report.guarded("workload:preflight", "private-workload", verify)
    finally:
        if owned_credential and credential is not None:
            credential.close()
    return {"checks": report.checks, "provenance": report.provenance}
