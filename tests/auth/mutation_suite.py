"""Repeatable disposable-demo API mutations; no pristine seed state or external effects."""

import argparse
import base64
import binascii
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import secrets
import subprocess
import sys
import uuid
from urllib.parse import urlencode, urlsplit

import validate as auth
import reporting
from ephemeral_storage import MutationRunLedger
import runtime_config


class Mutations:
    def __init__(self, report, deployment, run_id, ledger=None):
        self.report, self.deployment, self.run_id = report, deployment, run_id
        self.functions = auth.https_url(deployment.required("API_FUNCTIONS_URL"))
        self.graphql = auth.https_url(deployment.required("API_URL"))
        self.dab = auth.origin(self.graphql)
        self.metadata = auth.origin(deployment.required("API_MCP_URL")) + "/.well-known/oauth-protected-resource"
        self.ledger = ledger
        self.residuals = []
        report.inventory["mutationResiduals"] = self.residuals

    def record_residual(self, residual):
        self.residuals.append(residual)
        if self.ledger is not None:
            self.ledger.record(residual)

    def update_residual(self, residual, **values):
        residual.update(values)
        if self.ledger is not None:
            self.ledger.update(residual)

    def confirm_denied_absence(self, check, denied, absent, detail, residual):
        if absent and not denied:
            self.report.add("mutation:" + check + "-unchanged", "mutations", "BLOCKED",
                            detail + " The write outcome is unconfirmed; an immediate read is not final evidence.")
        else:
            self.report.check("mutation:" + check + "-unchanged", "mutations", absent, detail)
        if denied and absent:
            self.update_residual(residual, state="verified-absent")

    def require(self, name, condition, detail):
        self.report.check("mutation:" + name, "mutations", condition, detail)
        if not condition:
            raise auth.EvidenceError("Mutation scenario stopped after assertion " + name)

    def request(self, method, url, caller=None, data=None, dab=False):
        token = caller.token("dab" if dab else "functions") if caller else None
        try:
            status, _, raw = auth.http(method, url, data=data, token=token,
                                       headers={"X-MS-API-ROLE": "consumer"} if dab and caller else None)
        except auth.EvidenceError as error:
            raise auth.EvidenceError(f"{method} {urlsplit(url).path}: {error}") from error
        if not raw:
            return status, None
        try:
            return status, json.loads(raw)
        except ValueError as error:
            raise auth.EvidenceError("Mutation API returned invalid JSON; payload withheld") from error

    def rows(self, entity, caller=None, suffix="?$first=1"):
        status, body = self.request("GET", self.dab + "/api/" + entity + suffix, caller, dab=True)
        if status != 200 or not isinstance(body, dict) or not isinstance(body.get("value"), list):
            raise auth.EvidenceError("Mutation prerequisite/persisted DAB read failed; no write retried")
        return body["value"]

    def review_marker_rows(self, marker):
        suffix = "?" + urlencode({"$filter": f"ReviewerName eq '{marker}'", "$first": "1"})
        status, body = self.request("GET", self.dab + "/api/ProductReview" + suffix, dab=True)
        if (status != 200 or not isinstance(body, dict) or not isinstance(body.get("value"), list) or
                (not body["value"] and body.get("nextLink") is not None)):
            raise auth.EvidenceError("Review marker read failed or returned incomplete pagination evidence.")
        return body["value"]

    def review_graphql_creates(self, callers, product, denial_product):
        query = ("mutation AuthReviewCreate($item: CreateProductReviewInput!) { "
                 "createProductReview(item: $item) { ProductReviewID UserID ReviewerName } }")
        for caller, other in [(callers[0], callers[1]), (callers[1], callers[0])]:
            marker = f"AuthGqlAllow-{self.run_id}-{caller.label}"
            self.require(f"review-graphql-create-{caller.label}-baseline", self.review_marker_rows(marker) == [],
                         "Unique GraphQL positive-control marker must be absent before creation.")
            item = {"ProductID": product, "ReviewerName": marker, "EmailAddress": caller.email,
                    "ReviewDate": datetime.now(timezone.utc).isoformat(), "Rating": 4,
                    "Comments": "Disposable GraphQL authorization control", "UserID": caller.business_id}
            residual = {"kind": "review-graphql", "owner": caller.business_id, "marker": marker,
                        "state": "creation-requested"}
            self.record_residual(residual)
            status, body = self.request("POST", self.graphql, caller, {"query": query, "variables": {"item": item}},
                                        dab=True)
            result = body.get("data", {}).get("createProductReview") if isinstance(body, dict) and \
                isinstance(body.get("data"), dict) else None
            valid = (status == 200 and isinstance(body, dict) and not body.get("errors") and
                     isinstance(result, dict) and type(result.get("ProductReviewID")) is int and
                     result["ProductReviewID"] > 0 and result.get("UserID") == caller.business_id and
                     result.get("ReviewerName") == marker)
            self.require(f"review-graphql-create-{caller.label}-allow", valid,
                         "Valid owner-bound GraphQL creation must return its ID, signed owner and marker.")
            self.update_residual(residual, id=result["ProductReviewID"], state="retained")
            persisted = self.review_marker_rows(marker)
            self.require(f"review-graphql-create-{caller.label}-persisted",
                         len(persisted) == 1 and persisted[0].get("ProductReviewID") == result["ProductReviewID"] and
                         persisted[0].get("UserID") == caller.business_id and
                         persisted[0].get("ProductID") == product and
                         persisted[0].get("Rating") == item["Rating"] and
                         persisted[0].get("Comments") == item["Comments"] and
                         "EmailAddress" not in persisted[0],
                         "Separate public filtered read must find the created review without reviewer email.")
            for label, token, role, owner in [
                ("anonymous", None, None, caller.business_id),
                ("forged", "invalid-auth-validation-token", "consumer", caller.business_id),
                ("functions-audience", caller.token("functions"), "consumer", caller.business_id),
                ("cross-owner", caller.token("dab"), "consumer", other.business_id),
            ]:
                marker = f"AuthGqlDeny-{self.run_id}-{caller.label}-{label}"
                check = f"review-graphql-create-{caller.label}-{label}"
                self.require(check + "-baseline", self.review_marker_rows(marker) == [],
                             "Unique denied GraphQL marker must be absent before the request.")
                payload = {"query": query, "variables": {"item": {
                    **item, "ProductID": denial_product, "ReviewerName": marker, "UserID": owner}}}
                residual = {"kind": "review-graphql-denial", "owner": owner, "marker": marker,
                            "state": "creation-requested"}
                self.record_residual(residual)
                status, _, raw = auth.http("POST", self.graphql, token=token, data=payload,
                                           headers={"X-MS-API-ROLE": role} if role else None)
                try:
                    body = json.loads(raw)
                except ValueError:
                    body = None
                errors = body.get("errors") if isinstance(body, dict) else None
                result = body.get("data") if isinstance(body, dict) else None
                if label in {"forged", "functions-audience"}:
                    denied = status == 401
                else:
                    message, code = (
                        ("The current user is not authorized to access this resource.", "AUTH_NOT_AUTHENTICATED")
                        if label == "anonymous" else ("Could not insert row with given values.", "DatabasePolicyFailure"))
                    denied = (status == 200 and isinstance(errors, list) and bool(errors) and
                              all(isinstance(error, dict) and error.get("message") == message and
                                  error.get("path") == ["createProductReview"] and
                                  isinstance(error.get("extensions"), dict) and
                                  error["extensions"].get("code") == code for error in errors) and
                              (result is None or isinstance(result, dict) and result.get("createProductReview") is None))
                self.report.check("mutation:" + check, "live-denials", denied,
                                  f"GraphQL {label} create must return a specific authorization denial; HTTP {status}.")
                absent = self.review_marker_rows(marker) == []
                self.confirm_denied_absence(check, denied, absent,
                                            "Independent public marker read must find no review after the denial.",
                                            residual)
                if not denied or not absent:
                    raise auth.EvidenceError("GraphQL review denial or unchanged-state assertion failed: " + check)

    def review_vote_denials(self, caller, suffix, snapshot):
        review_id = snapshot[0]["ProductReviewID"]
        votes = snapshot[0].get("HelpfulVotes")
        self.require("review-vote-denial-fixture-" + caller.label, type(votes) is int and votes >= 0,
                     "A run-owned review with an integer vote count is required.")
        query = ("mutation DeniedVote($id: Int!, $votes: Int!) { "
                 "updateProductReview(ProductReviewID: $id, item: { HelpfulVotes: $votes }) "
                 "{ ProductReviewID HelpfulVotes } }")
        payload = {"query": query, "variables": {"id": review_id, "votes": votes + 1}}
        for label, token, role in [("anonymous", None, None),
                                   ("forged", "invalid-auth-validation-token", "consumer"),
                                   ("functions-audience", caller.token("functions"), "consumer")]:
            check = "review-vote-denied-" + caller.label + "-" + label
            self.require(check + "-baseline", self.rows("ProductReview", caller, suffix) == snapshot,
                         "Independent read must match the run-owned review before the vote attempt.")
            status, _, raw = auth.http("POST", self.graphql, token=token, data=payload,
                                       headers={"X-MS-API-ROLE": role} if role else None)
            try:
                body = json.loads(raw)
            except ValueError:
                body = None
            errors = body.get("errors") if isinstance(body, dict) else None
            data = body.get("data") if isinstance(body, dict) else None
            if label == "anonymous":
                denied = (status == 200 and isinstance(errors, list) and bool(errors) and
                          all(isinstance(error, dict) and
                              error.get("message") == "The current user is not authorized to access this resource." and
                              error.get("path") == ["updateProductReview"] and
                              isinstance(error.get("extensions"), dict) and
                              error["extensions"].get("code") == "AUTH_NOT_AUTHENTICATED" for error in errors) and
                          (data is None or isinstance(data, dict) and data.get("updateProductReview") is None))
            else:
                denied = status == 401
            self.report.check("mutation:" + check, "live-denials", denied,
                              f"GraphQL vote must reject {label}; HTTP {status}.")
            unchanged = self.rows("ProductReview", caller, suffix) == snapshot
            self.report.check("mutation:" + check + "-unchanged", "mutations", unchanged,
                              "Independent read must show no review changes after the attempted vote.")
            if not denied or not unchanged:
                raise auth.EvidenceError("GraphQL vote denial or unchanged-state assertion failed: " + check)

    def host_denials(self, label, caller, method, url, data, unchanged):
        credentials = [("anonymous", None, "missing_token"),
                       ("forged", "invalid-auth-validation-token", "invalid_token"),
                       ("dab-audience", caller.token("dab"), "invalid_token")]
        for name, token, expected in credentials:
            status, headers, raw = auth.http(method, url, token=token, data=data)
            try:
                body = json.loads(raw)
            except ValueError:
                body = None
            challenge = headers.get("WWW-Authenticate", "")
            denied = (status == 401 and isinstance(body, dict) and body.get("error") == expected and
                      challenge.startswith("Bearer ") and
                      f'resource_metadata="{self.metadata}"' in challenge and f'error="{expected}"' in challenge)
            check = "host-denial-" + label + "-" + name
            self.report.check("mutation:" + check, "live-denials", denied,
                              f"Expected HTTP 401 and {expected} bearer challenge; received HTTP {status}.")
            state_ok = unchanged()
            self.report.check("mutation:" + check + "-unchanged", "mutations", state_ok,
                              "Independent owner reads must show the run-owned fixture remained unchanged.")
            if not denied or not state_ok:
                raise auth.EvidenceError("Mutation scenario stopped after assertion " + check)

    def address_marker_counts(self, marker):
        if not self.deployment.runtime:
            raise auth.EvidenceError("Private SQL is required to detect orphan address rows; no create probes sent.")
        try:
            result = subprocess.run(
                ["dotnet", "tests/auth/private/bin/Debug/net10.0/PrivateProbe.dll", "--address-marker", marker],
                cwd=auth.ROOT, capture_output=True, timeout=90, check=False)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise auth.EvidenceError("Private address marker read unavailable; SQL state is unverified.") from error
        try:
            documents = [json.loads(line) for line in result.stdout.splitlines()
                         if line.startswith(b'{"addresses":')]
        except ValueError as error:
            raise auth.EvidenceError("Private address marker read returned malformed evidence.") from error
        if (result.returncode != 0 or len(documents) != 1 or not isinstance(documents[0], dict) or
                set(documents[0]) != {"addresses", "links"} or
                any(type(documents[0][key]) is not int or documents[0][key] < 0
                    for key in ["addresses", "links"])):
            raise auth.EvidenceError("Private address marker read returned incomplete or contradictory evidence.")
        return documents[0]

    def address_create_denials(self, callers):
        if not getattr(self, "address_control", False):
            raise auth.EvidenceError("Successful run-owned address fixtures required before create denials.")
        control = self.address_marker_counts("AuthMutation-" + self.run_id)
        self.require("address-create-marker-control", control == {"addresses": 2, "links": 2},
                     "Private SQL must find both known run-owned addresses and their links.")
        state = self.address_state
        for caller in callers:
            for name, token, expected in [("anonymous", None, "missing_token"),
                                          ("forged", "invalid-auth-validation-token", "invalid_token"),
                                          ("dab-audience", caller.token("dab"), "invalid_token")]:
                marker = f"AuthDeny-{self.run_id}-{caller.label}-{name}"
                check = f"host-denial-address-create-{caller.label}-{name}"
                self.require(check + "-baseline", self.address_marker_counts(marker) == {"addresses": 0, "links": 0},
                             "Private SQL must find no address or linked row for the unique marker before the request.")
                payload = {"addressLine1": marker, "city": "Auth assurance", "stateProvinceID": state,
                           "postalCode": "00000", "businessEntityID": caller.business_id, "addressTypeID": 3}
                residual = {"kind": "address-denial-probe", "owner": caller.business_id, "marker": marker,
                            "state": "creation-requested"}
                self.record_residual(residual)
                status, headers, raw = auth.http("POST", self.functions + "/api/addresses", token=token, data=payload)
                try:
                    body = json.loads(raw)
                except ValueError:
                    body = None
                challenge = headers.get("WWW-Authenticate", "")
                denied = (status == 401 and isinstance(body, dict) and body.get("error") == expected and
                          challenge.startswith("Bearer ") and
                          f'resource_metadata="{self.metadata}"' in challenge and f'error="{expected}"' in challenge)
                self.report.check("mutation:" + check, "live-denials", denied,
                                  f"Expected HTTP 401 and {expected} bearer challenge; received HTTP {status}.")
                absent = self.address_marker_counts(marker) == {"addresses": 0, "links": 0}
                self.confirm_denied_absence(
                    check, denied, absent,
                    "Private SQL must find no marker address, including unlinked rows, or address link.", residual)
                if not denied or not absent:
                    raise auth.EvidenceError("Address create denial or unchanged-state assertion failed: " + check)

    def catalog_create_denials(self, callers, entity, operation):
        id_field = "ProductCategoryID" if entity == "ProductCategory" else "ProductSubcategoryID"
        rows = self.rows(entity)
        if not rows or not isinstance(rows[0], dict) or type(rows[0].get(id_field)) is not int or \
                rows[0][id_field] <= 0 or not isinstance(rows[0].get("Name"), str) or not rows[0]["Name"].strip():
            raise auth.EvidenceError("A valid current catalog record is required before denial probes.")
        known = rows[0]
        def find(name):
            escaped = name.replace("'", "''")
            suffix = "?" + urlencode({"$filter": f"Name eq '{escaped}'", "$first": "1"})
            status, body = self.request("GET", self.dab + "/api/" + entity + suffix, dab=True)
            if (status != 200 or not isinstance(body, dict) or not isinstance(body.get("value"), list) or
                    (not body["value"] and body.get("nextLink") is not None)):
                raise auth.EvidenceError("Catalog marker read failed or returned incomplete pagination evidence.")
            return body["value"]
        control = find(known["Name"].strip())
        self.require(operation + "-marker-control", bool(control) and
                     isinstance(control[0], dict) and isinstance(control[0].get("Name"), str) and
                     control[0]["Name"].strip() == known["Name"].strip(),
                     "Public filtered DAB read must find a known existing catalog name before denial probes.")
        if entity == "ProductSubcategory":
            parent = known.get("ProductCategoryID")
            if type(parent) is not int or parent <= 0:
                raise auth.EvidenceError("A valid existing parent category is required before subcategory probes.")
        for caller in callers:
            for label, token, status_expected, error in [
                ("anonymous", None, 401, "missing_token"),
                ("forged", "invalid-auth-validation-token", 401, "invalid_token"),
                ("dab-audience", caller.token("dab"), 401, "invalid_token"),
                ("consumer", caller.token("functions"), 403, "insufficient_scope"),
            ]:
                marker = f"Auth-{self.run_id}-{caller.label}-{'cat' if entity == 'ProductCategory' else 'sub'}-{label}"
                if len(marker) > 50:
                    raise auth.EvidenceError("Catalog marker exceeds the handler's 50-character limit.")
                check = f"host-denial-{operation}-{caller.label}-{label}"
                self.require(check + "-baseline", find(marker) == [],
                             "Unique catalog marker must not exist before the attempted create.")
                payload = {"englishName": marker}
                if entity == "ProductSubcategory":
                    payload["categoryId"] = parent
                residual = {"kind": "catalog-denial-probe", "entity": entity, "marker": marker,
                            "state": "creation-requested"}
                self.record_residual(residual)
                status, headers, raw = auth.http("POST", self.functions + "/api/" +
                                                 ("CreateCategory" if entity == "ProductCategory" else "CreateSubcategory"),
                                                 token=token, data=payload)
                try:
                    body = json.loads(raw)
                except ValueError:
                    body = None
                challenge = headers.get("WWW-Authenticate", "")
                denied = (status == status_expected and isinstance(body, dict) and body.get("error") == error and
                          challenge.startswith("Bearer ") and
                          f'resource_metadata="{self.metadata}"' in challenge and f'error="{error}"' in challenge)
                self.report.check("mutation:" + check, "live-denials", denied,
                                  f"Expected HTTP {status_expected} and {error} bearer challenge; received HTTP {status}.")
                absent = find(marker) == []
                self.confirm_denied_absence(
                    check, denied, absent,
                    "Independent public filtered DAB read must find no marker-matched catalog row.", residual)
                if not denied or not absent:
                    raise auth.EvidenceError("Catalog creation denial or unchanged-state assertion failed: " + check)

    def create_account(self, label):
        email = f"auth-mutation-{self.run_id}-{label.lower()}@example.invalid"
        password = secrets.token_urlsafe(32)
        # Record uncertain creates before sending: no blind signup retry on timeout.
        residual = {"kind": "consumer", "label": label, "state": "creation-requested"}
        self.record_residual(residual)
        status, body = self.request("POST", self.functions + "/api/signup", data={
            "email": email, "password": password, "firstName": "AuthMutation", "lastName": label})
        owner = body.get("businessEntityId") if isinstance(body, dict) else None
        self.require("signup-" + label, status == 201 and type(owner) is int and owner > 0,
                     "Run-owned consumer signup must return a positive owner ID; no email requested.")
        self.update_residual(residual, id=owner, state="retained")
        caller = auth.ConsumerSession(self.deployment, label, email, password, owner)
        caller.token("functions")
        return caller

    def accounts(self):
        products = self.rows("Product")
        self.require("catalog-prerequisite",
                     bool(products) and isinstance(products[0], dict) and
                     type(products[0].get("ProductID")) is int and products[0]["ProductID"] > 0,
                     "The public catalog must be reachable before creating run-owned consumers.")
        callers = [self.create_account(label) for label in ["A", "B"]]
        self.require("distinct-owners", callers[0].business_id != callers[1].business_id,
                     "Fresh consumers must resolve to distinct owners.")
        for caller in callers:
            products = self.rows("Product", caller)
            self.require("host-dab-token-control-" + caller.label,
                         bool(products) and isinstance(products[0], dict) and
                         type(products[0].get("ProductID")) is int and products[0]["ProductID"] > 0,
                         "The wrong-audience control token is accepted by DAB for a real product read.")
        return callers

    def customer_states(self, callers, territory):
        if not self.deployment.runtime or self.ledger is None:
            raise auth.EvidenceError("Private SQL and the temporary mutation ledger are required; no Customer probes sent.")
        owners = [caller.business_id for caller in callers]
        if (len(owners) != 2 or any(type(owner) is not int or owner <= 0 for owner in owners) or
                owners[0] == owners[1] or type(territory) is not int or territory <= 0):
            raise auth.EvidenceError("Customer state requires two distinct owners and a valid territory.")
        try:
            result = subprocess.run(
                ["dotnet", "tests/auth/private/bin/Debug/net10.0/PrivateProbe.dll",
                 "--customer-state", str(owners[0]), str(owners[1]), str(territory)],
                cwd=auth.ROOT, capture_output=True, timeout=90, check=False)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise auth.EvidenceError("Private Customer state read unavailable; SQL state is unverified.") from error
        try:
            documents = [json.loads(line) for line in result.stdout.splitlines()
                         if line.startswith(b'{"customers":')]
        except ValueError as error:
            raise auth.EvidenceError("Private Customer state read returned malformed evidence.") from error
        if (result.returncode != 0 or len(documents) != 1 or not isinstance(documents[0], dict) or
                set(documents[0]) != {"customers"} or not isinstance(documents[0]["customers"], list) or
                len(documents[0]["customers"]) != 2):
            raise auth.EvidenceError("Private Customer state read returned incomplete evidence.")
        states = documents[0]["customers"]
        for state in states:
            if (not isinstance(state, dict) or set(state) != {"count", "firstId", "matching"} or
                    type(state["count"]) is not int or type(state["matching"]) is not int or
                    state["count"] < 0 or not 0 <= state["matching"] <= state["count"] or
                    (state["count"] == 0 and state["firstId"] is not None) or
                    (state["count"] > 0 and (type(state["firstId"]) is not int or state["firstId"] <= 0))):
                raise auth.EvidenceError("Private Customer state read returned contradictory evidence.")
        return states

    @staticmethod
    def customer_claim_matches(token, expected):
        try:
            parts = token.split(".")
            if len(parts) != 3:
                return False
            payload = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
            value = payload.get("customer_id") if isinstance(payload, dict) else None
            return (type(value) is int and value == expected or
                    isinstance(value, str) and value == str(expected))
        except (ValueError, TypeError, binascii.Error):
            return False

    @staticmethod
    def mcp_subject_matches(mcp_token, functions_token):
        try:
            payloads = []
            for token in [mcp_token, functions_token]:
                parts = token.split(".")
                if len(parts) != 3:
                    return False
                payload = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
                if not isinstance(payload, dict):
                    return False
                payloads.append(payload)
            mcp, functions = payloads
            return (isinstance(mcp.get("sub"), str) and bool(mcp["sub"]) and
                    mcp["sub"] == functions.get("sub") and
                    "customer_id" not in mcp and "business_entity_id" not in mcp)
        except (ValueError, TypeError, binascii.Error):
            return False

    def customer_creates(self, callers):
        empty = {"count": 0, "firstId": None, "matching": 0}
        territories = self.rows("SalesTerritory")
        territory = territories[0].get("TerritoryID") if territories and isinstance(territories[0], dict) else None
        if type(territory) is not int or territory <= 0:
            raise auth.EvidenceError("A current sales territory is required for Customer create probes.")
        self.require("customer-initial-sql", self.customer_states(callers, territory) == [empty, empty],
                     "Private SQL must find no Customer rows for either fresh consumer.")
        for caller in callers:
            status, body = self.request("POST", self.functions + "/api/password/verify", caller, {
                "businessEntityID": caller.business_id, "password": caller.password})
            self.require("customer-functions-token-control-" + caller.label,
                         status == 200 and isinstance(body, dict) and body.get("isValid") is True,
                         "The wrong-audience token must be accepted by Functions for the signed consumer.")
            for resource in ["functions", "dab"]:
                self.require("customer-unbound-" + caller.label + "-" + resource,
                             self.customer_claim_matches(caller.token(resource), 0),
                             "The fresh consumer token must initially carry the unbound Customer sentinel.")

        query = ("mutation AuthCustomerCreate($item: CreateCustomerInput!) { "
                 "createCustomer(item: $item) { CustomerID PersonID TerritoryID } }")
        for protocol in ["rest", "graphql"]:
            for role in ["consumer", "authenticated"]:
                for caller, other in [(callers[0], callers[1]), (callers[1], callers[0])]:
                    credentials = [("cross-owner", caller.token("dab"), other)]
                    if role == "consumer":
                        credentials += [("anonymous", None, caller),
                                        ("forged", "invalid-auth-validation-token", caller),
                                        ("functions-audience", caller.token("functions"), caller)]
                    for label, token, target in credentials:
                        check = f"customer-create-{protocol}-{role}-{caller.label}-{label}"
                        self.require(check + "-baseline", self.customer_states(callers, territory) == [empty, empty],
                                     "Private SQL must find neither owner's Customer rows before the create attempt.")
                        item = {"PersonID": target.business_id, "TerritoryID": territory}
                        payload = item if protocol == "rest" else {"query": query, "variables": {"item": item}}
                        residual = {"kind": "customer-create-denial", "entity": "Customer",
                                    "owner": target.business_id, "label": check, "state": "creation-requested"}
                        self.record_residual(residual)
                        status, _, raw = auth.http(
                            "POST", self.dab + "/api/Customer" if protocol == "rest" else self.graphql,
                            token=token, data=payload,
                            headers={"X-MS-API-ROLE": role} if token else None)
                        try:
                            body = json.loads(raw)
                        except ValueError:
                            body = None
                        if label in {"forged", "functions-audience"}:
                            denied = status == 401
                        elif label == "anonymous" and protocol == "rest":
                            error = body.get("error") if isinstance(body, dict) else None
                            denied = (status == 403 and isinstance(error, dict) and error.get("status") == 403 and
                                      error.get("code") == "AuthorizationCheckFailed" and
                                      error.get("message") == "Authorization Failure: Access Not Allowed.")
                        elif protocol == "rest":
                            error = body.get("error") if isinstance(body, dict) else None
                            denied = (status == 403 and isinstance(error, dict) and error.get("status") == 403 and
                                      error.get("code") == "DatabasePolicyFailure" and
                                      error.get("message") == "Could not insert row with given values.")
                        else:
                            errors = body.get("errors") if isinstance(body, dict) else None
                            data = body.get("data") if isinstance(body, dict) else None
                            message, code = (
                                ("The current user is not authorized to access this resource.", "AUTH_NOT_AUTHENTICATED")
                                if label == "anonymous" else
                                ("Could not insert row with given values.", "DatabasePolicyFailure"))
                            denied = (status == 200 and isinstance(errors, list) and bool(errors) and
                                      all(isinstance(error, dict) and error.get("message") == message and
                                          error.get("path") == ["createCustomer"] and
                                          isinstance(error.get("extensions"), dict) and
                                          error["extensions"].get("code") == code for error in errors) and
                                      (data is None or isinstance(data, dict) and data.get("createCustomer") is None))
                        self.report.check("mutation:" + check, "live-denials", denied,
                                          f"Customer create must return the expected authorization denial; HTTP {status}.")
                        after = self.customer_states(callers, territory)
                        unchanged = after == [empty, empty]
                        self.confirm_denied_absence(
                            check, denied, unchanged,
                            "Private SQL must find no Customer row for either run-owned person.", residual)
                        if not unchanged:
                            present = [(owner.business_id, state) for owner, state in zip(callers, after)
                                       if state["count"] > 0]
                            if len(present) == 1 and present[0][1]["count"] == 1:
                                self.update_residual(residual, owner=present[0][0], id=present[0][1]["firstId"],
                                                     state="unexpected-present" if denied else "creation-requested")
                            elif denied:
                                self.update_residual(residual, state="unexpected-multiple")
                        if not denied or not unchanged:
                            raise auth.EvidenceError("Customer create denial or unchanged-state assertion failed: " + check)

        extra = [self.create_account(label) for label in ["C", "D"]]
        all_callers = callers + extra
        self.require("customer-distinct-controls", len({caller.business_id for caller in all_callers}) == 4,
                     "Four fresh distinct consumers are required for nonduplicating positive controls.")
        controls = [
            ("rest", "consumer", callers, 0), ("graphql", "consumer", callers, 1),
            ("rest", "authenticated", extra, 0), ("graphql", "authenticated", extra, 1),
        ]
        for protocol, role, pair, index in controls:
            caller = pair[index]
            check = f"customer-create-{protocol}-{role}-{caller.label}-allow"
            before = self.customer_states(pair, territory)
            self.require(check + "-baseline", before[index] == empty,
                         "The positive-control person must have no existing Customer row.")
            item = {"PersonID": caller.business_id, "TerritoryID": territory}
            payload = item if protocol == "rest" else {"query": query, "variables": {"item": item}}
            residual = {"kind": "customer-create-control", "entity": "Customer", "owner": caller.business_id,
                        "label": check, "state": "creation-requested"}
            self.record_residual(residual)
            status, _, raw = auth.http(
                "POST", self.dab + "/api/Customer" if protocol == "rest" else self.graphql,
                token=caller.token("dab"), data=payload, headers={"X-MS-API-ROLE": role})
            try:
                body = json.loads(raw)
            except ValueError:
                body = None
            result = (body.get("value", [None])[0] if protocol == "rest" and isinstance(body, dict) and
                      isinstance(body.get("value"), list) and len(body["value"]) == 1 else
                      body.get("data", {}).get("createCustomer") if protocol == "graphql" and
                      isinstance(body, dict) and isinstance(body.get("data"), dict) else None)
            valid = (status == (201 if protocol == "rest" else 200) and isinstance(body, dict) and
                     not body.get("errors") and isinstance(result, dict) and
                     type(result.get("CustomerID")) is int and result["CustomerID"] > 0 and
                     result.get("PersonID") == caller.business_id and result.get("TerritoryID") == territory)
            self.report.check("mutation:" + check, "mutations", valid,
                              f"Owner-bound Customer create must return its ID and requested fields; HTTP {status}.")
            after = self.customer_states(pair, territory)
            observed = after[index]
            if observed["count"] == 1:
                self.update_residual(residual, id=observed["firstId"], state="retained")
            persisted = (valid and observed == {"count": 1, "firstId": result["CustomerID"], "matching": 1} and
                         after[1 - index] == before[1 - index])
            self.report.check("mutation:" + check + "-persisted", "mutations", persisted,
                              "Independent private SQL must find exactly the requested person/territory, no store, "
                              "and no change to the other fixture.")
            if not valid or not persisted:
                raise auth.EvidenceError("Customer create positive control or persisted-state assertion failed: " + check)

            caller.tokens.clear()
            status, body = self.request("POST", self.functions + "/api/password/verify", caller, {
                "businessEntityID": caller.business_id, "password": caller.password})
            self.require(check + "-functions-token", status == 200 and isinstance(body, dict) and
                         body.get("isValid") is True,
                         "Functions must accept the freshly issued token for the same consumer.")
            owned = self.rows("Customer", caller, "/CustomerID/" + str(result["CustomerID"]))
            self.require(check + "-dab-token", len(owned) == 1 and isinstance(owned[0], dict) and
                         owned[0].get("CustomerID") == result["CustomerID"] and
                         owned[0].get("PersonID") == caller.business_id,
                         "DAB must accept the freshly issued token and return the owned Customer.")
            for resource in ["functions", "dab"]:
                self.require(check + "-refreshed-" + resource,
                             self.customer_claim_matches(caller.token(resource), result["CustomerID"]),
                             "The accepted fresh resource token must carry the new Customer ownership claim.")

    def customer_create_evidence(self):
        expected = {
            "mutation:customer-initial-sql": "mutations",
            "mutation:customer-distinct-controls": "mutations",
            "mutation:distinct-owners": "mutations",
        }
        for owner in ["A", "B", "C", "D"]:
            expected["mutation:signup-" + owner] = "mutations"
        for owner in ["A", "B"]:
            expected["mutation:host-dab-token-control-" + owner] = "mutations"
            expected["mutation:customer-functions-token-control-" + owner] = "mutations"
            for resource in ["functions", "dab"]:
                expected[f"mutation:customer-unbound-{owner}-{resource}"] = "mutations"
        denial_labels = {}
        for protocol in ["rest", "graphql"]:
            for role in ["consumer", "authenticated"]:
                for owner in ["A", "B"]:
                    labels = ["cross-owner"] + (
                        ["anonymous", "forged", "functions-audience"] if role == "consumer" else [])
                    for label in labels:
                        name = f"customer-create-{protocol}-{role}-{owner}-{label}"
                        denial_labels[name] = ("B" if owner == "A" else "A") if label == "cross-owner" else owner
                        expected["mutation:" + name] = "live-denials"
                        expected["mutation:" + name + "-baseline"] = "mutations"
                        expected["mutation:" + name + "-unchanged"] = "mutations"
        control_labels = {}
        for protocol, role, owner in [("rest", "consumer", "A"), ("graphql", "consumer", "B"),
                                      ("rest", "authenticated", "C"), ("graphql", "authenticated", "D")]:
            name = f"customer-create-{protocol}-{role}-{owner}-allow"
            control_labels[name] = owner
            for suffix in ["", "-baseline", "-persisted", "-functions-token", "-dab-token",
                           "-refreshed-functions", "-refreshed-dab"]:
                expected["mutation:" + name + suffix] = "mutations"

        checks = [check for check in self.report.checks if check["id"] in expected]
        complete = (len(checks) == len(expected) and {check["id"] for check in checks} == set(expected) and
                    all(check["status"] == "PASS" and check["group"] == expected[check["id"]] for check in checks))
        residuals = [item for item in self.residuals
                     if item.get("kind") in {"customer-create-denial", "customer-create-control"}]
        denials = [item for item in residuals if item["kind"] == "customer-create-denial"]
        controls = [item for item in residuals if item["kind"] == "customer-create-control"]
        accounts = [item for item in self.residuals if item.get("kind") == "consumer" and
                    item.get("label") in {"A", "B", "C", "D"}]
        account_ids = {item["label"]: item.get("id") for item in accounts}
        complete = (complete and self.ledger is not None and
                    len(accounts) == 4 and len(account_ids) == 4 and
                    all(item.get("state") == "retained" and type(item.get("id")) is int and item["id"] > 0
                        for item in accounts) and len(set(account_ids.values())) == 4 and
                    len(denials) == len(denial_labels) and
                    {item.get("label") for item in denials} == set(denial_labels) and
                    all(item.get("state") == "verified-absent" and item.get("entity") == "Customer" and
                        item.get("owner") == account_ids[denial_labels[item["label"]]] for item in denials) and
                    len(controls) == len(control_labels) and
                    {item.get("label") for item in controls} == set(control_labels) and
                    all(item.get("state") == "retained" and type(item.get("owner")) is int and
                        item.get("entity") == "Customer" and
                        item["owner"] == account_ids[control_labels[item["label"]]] and
                        type(item.get("id")) is int and item["id"] > 0 for item in controls) and
                    len({item["owner"] for item in controls}) == 4 and len({item["id"] for item in controls}) == 4)
        if complete:
            try:
                from azure.core.exceptions import AzureError
            except ImportError:
                azure_errors = ()
            else:
                azure_errors = (AzureError,)
            try:
                snapshot = self.ledger.snapshot()
            except azure_errors as error:
                raise auth.EvidenceError("Temporary Customer mutation ledger could not be read.") from error
            fields = set(MutationRunLedger._FIELDS)
            def normalized(items):
                if any(type(value) not in {str, int, bool} for item in items
                       for key, value in item.items() if key in fields):
                    return None
                return Counter(tuple(sorted((key, value) for key, value in item.items() if key in fields))
                               for item in items)
            if not isinstance(snapshot, list) or not all(isinstance(item, dict) for item in snapshot):
                complete = False
            else:
                kinds = {"consumer", "customer-create-denial", "customer-create-control"}
                observed = normalized([item for item in snapshot if item.get("kind") in kinds])
                complete = observed is not None and observed == normalized(accounts + residuals)
        self.report.add(
            "mutation:customer-create-evidence", "mutations", "PASS" if complete else "BLOCKED",
            "All exact Customer create denials, positive controls, SQL state, refreshed tokens and "
            "matching temporary-ledger entries are required in one private run; no order is created.")

    def customer_mcp_owner_controls(self, callers):
        gates = [item for item in self.report.checks if item["id"] == "mutation:customer-create-evidence"]
        if (len(gates) != 1 or gates[0]["group"] != "mutations" or gates[0]["status"] != "PASS" or
                len(callers) != 2 or [caller.label for caller in callers] != ["A", "B"]):
            raise auth.EvidenceError("Verified Customer creation and two distinct owners are required for MCP checks.")
        expected = {
            "A": "customer-create-rest-consumer-A-allow",
            "B": "customer-create-graphql-consumer-B-allow",
        }
        ids = {}
        for caller in callers:
            controls = [item for item in self.residuals if item.get("kind") == "customer-create-control" and
                        item.get("label") == expected[caller.label]]
            if (len(controls) != 1 or controls[0].get("state") != "retained" or
                    controls[0].get("owner") != caller.business_id or
                    type(controls[0].get("id")) is not int or controls[0]["id"] <= 0):
                raise auth.EvidenceError("Verified owner-bound Customer IDs are unavailable for MCP checks.")
            ids[caller.label] = controls[0]["id"]
        if ids["A"] == ids["B"]:
            raise auth.EvidenceError("MCP ownership controls require distinct Customer IDs.")

        url = auth.origin(self.deployment.required("API_MCP_URL")) + "/mcp"
        request_id = 0
        tools = [
            ("get_customer_orders", {}),
            ("get_order_details", {"orderId": 0}),
            ("get_personalized_recommendations", {}),
        ]
        for caller, other in [(callers[0], callers[1]), (callers[1], callers[0])]:
            own, foreign = ids[caller.label], ids[other.label]
            token = caller.token("mcp")
            functions_token = caller.token("functions")
            self.require("mcp-owner-" + caller.label + "-subject",
                         self.mcp_subject_matches(token, functions_token) and
                         self.customer_claim_matches(functions_token, own),
                         "The MCP and Functions tokens share the verified consumer subject; only the Functions "
                         "token carries the independently verified Customer ID.")
            for tool, base_arguments in tools:
                request_id += 1
                denied, text = auth.consumer_mcp_tool_call(
                    url, tool, token, {**base_arguments, "customerId": own}, request_id)
                response = text[0]
                if tool == "get_customer_orders":
                    valid = (response == f"No orders found for customer #{own}." or
                             f"Order History for Customer #{own}" in response and f"CustomerID: {own}" in response)
                elif tool == "get_order_details":
                    valid = response == f"Order #0 does not belong to customer #{own}."
                else:
                    valid = (response == f"No purchase history found for customer #{own} to generate recommendations." or
                             f"Personalized Recommendations for Customer #{own}" in response)
                self.require(f"mcp-owner-{caller.label}-{tool}-own", not denied and valid,
                             "The same Customer's authenticated tool call returned its expected read-only response.")
                for label, value in [
                    ("other-owner", foreign), ("zero", 0), ("malformed-string", "invalid"),
                    ("malformed-array", [0]), ("malformed-object", {"id": 0}),
                ]:
                    request_id += 1
                    denied, text = auth.consumer_mcp_tool_call(
                        url, tool, token, {**base_arguments, "customerId": value}, request_id)
                    self.require(f"mcp-owner-{caller.label}-{tool}-{label}",
                                 denied and text == ["You can only access your own records."],
                                 "An actual foreign Customer ID or malformed owner is denied by MCP authorization.")

    def passwords(self, callers):
        for caller, other in [(callers[0], callers[1]), (callers[1], callers[0])]:
            attempted = secrets.token_urlsafe(32)
            def password_unchanged():
                for password, expected in [(caller.password, True), (attempted, False)]:
                    status, body = self.request("POST", self.functions + "/api/password/verify", caller, {
                        "businessEntityID": caller.business_id, "password": password})
                    if status != 200 or not isinstance(body, dict) or type(body.get("isValid")) is not bool or \
                            body["isValid"] is not expected:
                        return False
                return True
            for name, path in [("password-set", "/api/password"), ("password-verify", "/api/password/verify")]:
                self.host_denials(name + "-" + caller.label, caller, "POST", self.functions + path,
                                  {"businessEntityID": caller.business_id, "password": attempted},
                                  password_unchanged)
            status, body = self.request("POST", self.functions + "/api/password", other, {
                "businessEntityID": caller.business_id, "password": attempted})
            self.require("password-cross-denied-" + caller.label, status == 403 and isinstance(body, dict) and
                         body.get("error") == "forbidden" and
                         body.get("error_description") == "You can only change your own password.",
                         "Distinct consumer cannot overwrite the run-owned target password.")
            for name, password, expected in [("unchanged", caller.password, True), ("not-overwritten", attempted, False)]:
                status, body = self.request("POST", self.functions + "/api/password/verify", caller, {
                    "businessEntityID": caller.business_id, "password": password})
                self.require("password-" + name + "-" + caller.label, status == 200 and isinstance(body, dict) and
                             type(body.get("isValid")) is bool and body["isValid"] is expected,
                             "Persisted credential state after denied write matches the original value.")
            old = caller.password
            updated = secrets.token_urlsafe(32)
            status, body = self.request("POST", self.functions + "/api/password", caller, {
                "businessEntityID": caller.business_id, "password": updated})
            self.require("password-own-write-" + caller.label, status == 200 and isinstance(body, dict) and
                         body.get("businessEntityID") == caller.business_id,
                         "Owner password change must succeed; only disposable run-owned credentials are changed.")
            caller.password = updated
            caller.tokens.clear()
            caller.token("functions")
            self.report.add("mutation:password-new-login-" + caller.label, "mutations", "PASS",
                            "Fresh OAuth credential exchange succeeded with changed password and matching signed owner.")
            previous = auth.ConsumerSession(self.deployment, caller.label, caller.email, old, caller.business_id)
            status, _, raw = previous.exchange("functions")
            try:
                denial = json.loads(raw)
            except ValueError as error:
                raise auth.EvidenceError("Old-credential exchange returned invalid JSON; payload withheld") from error
            self.require("password-old-login-denied-" + caller.label, status == 400 and isinstance(denial, dict) and
                         denial.get("error") == "invalid_grant",
                         "Previous password must no longer issue OAuth tokens; existing token revocation is not claimed.")

    def addresses(self, callers):
        states = self.rows("StateProvince")
        state = states[0].get("StateProvinceID") if states and isinstance(states[0], dict) else None
        if type(state) is not int or state <= 0:
            raise auth.EvidenceError("No current valid state/province for address fixtures")
        fixtures = []
        for caller, other in [(callers[0], callers[1]), (callers[1], callers[0])]:
            marker = "AuthMutation-" + self.run_id
            residual = {"kind": "address", "owner": caller.business_id, "state": "creation-requested"}
            self.record_residual(residual)
            status, body = self.request("POST", self.functions + "/api/addresses", caller, {
                "addressLine1": marker, "city": "Auth assurance", "stateProvinceID": state, "postalCode": "00000",
                "businessEntityID": other.business_id, "addressTypeID": 3})
            address = body.get("addressID") if isinstance(body, dict) else None
            self.require("address-create-" + caller.label, status == 201 and type(address) is int and address > 0,
                         "Consumer address create must persist a positive address ID.")
            self.update_residual(residual, id=address, state="retained")
            url = self.functions + "/api/addresses/" + str(address)
            status, snapshot = self.request("GET", url, caller)
            self.require("address-own-read-" + caller.label, status == 200 and isinstance(snapshot, dict) and
                         snapshot.get("addressID") == address and snapshot.get("addressLine1") == marker,
                         "Owner reads actual newly persisted address despite supplied foreign owner.")
            fixtures.append((caller, other, url, snapshot, residual))
        for caller, other, url, snapshot, _ in fixtures:
            link_suffix = f"?$filter=AddressID%20eq%20{snapshot['addressID']}&$first=10"
            original_links = self.rows("BusinessEntityAddress", caller, link_suffix)
            self.require("address-created-link-" + caller.label, len(original_links) == 1 and
                         original_links[0].get("BusinessEntityID") == caller.business_id and
                         original_links[0].get("AddressTypeID") == 2,
                         "Initial persisted link belongs only to signed owner, overriding supplied foreign owner.")
            def address_unchanged():
                status, current = self.request("GET", url, caller)
                links = self.rows("BusinessEntityAddress", caller, link_suffix)
                return status == 200 and current == snapshot and links == original_links
            for name, method, suffix, data in [
                ("address-update", "PUT", "", {"city": "Unauthorized host probe"}),
                ("address-type", "PUT", "/type", {"addressTypeID": 2, "businessEntityID": caller.business_id}),
                ("address-delete", "DELETE", "", None),
            ]:
                self.host_denials(name + "-" + caller.label, caller, method, url + suffix, data, address_unchanged)
            for method, suffix, data in [("PUT", "", {"city": "Unauthorized"}),
                                         ("PUT", "/type", {"addressTypeID": 2, "businessEntityID": caller.business_id}),
                                         ("DELETE", "", None)]:
                status, body = self.request(method, url + suffix, other, data)
                self.require("address-denied-" + caller.label + "-" + method + ("-type" if suffix else ""),
                             status == 403 and isinstance(body, dict) and
                             body.get("error") == f"Address {snapshot['addressID']} is not owned by the current user.",
                             "Cross-owner address mutation must return the exact ownership denial.")
                status, current = self.request("GET", url, caller)
                self.require("address-unchanged-" + caller.label + "-" + method + ("-type" if suffix else ""),
                             status == 200 and current == snapshot,
                             "All persisted address fields remain unchanged after denied mutation.")
                current_links = self.rows("BusinessEntityAddress", caller, link_suffix)
                self.require("address-link-unchanged-" + caller.label + "-" + method + ("-type" if suffix else ""),
                             current_links == original_links,
                             "Owner/type link remains unchanged after denied mutation, including type and delete.")
            status, body = self.request("PUT", url, caller, {"city": "Verified mutation"})
            self.require("address-update-" + caller.label, status == 200 and isinstance(body, dict) and
                         body.get("city") == "Verified mutation",
                         "Owner update succeeds through the actual API.")
            status, body = self.request("GET", url, caller)
            self.require("address-update-persisted-" + caller.label, status == 200 and isinstance(body, dict) and
                         body.get("city") == "Verified mutation" and body.get("addressID") == snapshot["addressID"],
                         "A separate owned read proves the update persisted.")
            status, _ = self.request("PUT", url + "/type", caller, {
                "addressTypeID": 2, "businessEntityID": other.business_id})
            self.require("address-own-type-" + caller.label, status == 204,
                         "Owner type update accepts signed owner, not foreign owner supplied in payload.")
            links = self.rows("BusinessEntityAddress", caller, link_suffix)
            self.require("address-link-owner-" + caller.label, len(links) == 1 and
                         links[0].get("BusinessEntityID") == caller.business_id and links[0].get("AddressTypeID") == 2,
                         "Independent DAB link read proves signed owner and persisted default type.")
        self.address_state = state
        self.address_control = True
        self.address_fixtures = fixtures

    def address_removal(self):
        if not getattr(self, "address_control", False) or len(getattr(self, "address_fixtures", [])) != 2:
            raise auth.EvidenceError("Two confirmed run-owned address fixtures are required before deletion.")
        if any(item.get("kind") in {"address", "address-denial-probe"} and
               item.get("state") in {"creation-requested", "deletion-requested"} for item in self.residuals):
            raise auth.EvidenceError("An address write may still be in flight; fixture cleanup was not raced.")
        marker = "AuthMutation-" + self.run_id
        if self.deployment.runtime:
            self.require("address-delete-sql-control", self.address_marker_counts(marker) ==
                         {"addresses": 2, "links": 2},
                         "Private SQL must confirm both isolated address fixtures before deletion.")
        for index, (caller, _, url, snapshot, residual) in enumerate(self.address_fixtures):
            address = snapshot["addressID"]
            suffix = f"?$filter=AddressID%20eq%20{address}&$first=10"
            self.update_residual(residual, state="deletion-requested")
            status, _ = self.request("DELETE", url, caller)
            self.report.check("mutation:address-delete-" + caller.label, "mutations", status == 204,
                              f"Owner deletion must return HTTP 204; received {status}.")
            links = self.rows("BusinessEntityAddress", caller, suffix)
            read_status, body = self.request("GET", url, caller)
            unlinked = (links == [] and read_status == 403 and isinstance(body, dict) and
                        body.get("error") == f"Address {address} is not owned by the current user.")
            self.report.check("mutation:address-delete-unlinked-" + caller.label, "mutations", unlinked,
                              "Independent DAB and Functions reads must show the owner link was removed.")
            sql_absent = None
            if self.deployment.runtime:
                remaining = 1 - index
                sql_absent = self.address_marker_counts(marker) == {"addresses": remaining, "links": remaining}
                self.report.check("mutation:address-delete-sql-" + caller.label, "mutations", sql_absent,
                                  "Private SQL verifies only the unreferenced run-owned address and link were removed.")
            else:
                self.report.add("mutation:address-delete-sql-" + caller.label, "mutations", "BLOCKED",
                                "Private SQL is required to prove physical deletion; only unlinking was checked.")
            if unlinked:
                self.update_residual(residual, state="verified-absent" if sql_absent else "unlinked")
            if status != 204 or not unlinked or sql_absent is False:
                raise auth.EvidenceError("Address deletion was not fully confirmed; no deletion is retried.")

    def reviews(self, callers):
        products = self.rows("Product", suffix="?$first=3")
        product_ids = [item.get("ProductID") for item in products if isinstance(item, dict)]
        if (len(product_ids) != 3 or any(type(value) is not int or value <= 0 for value in product_ids) or
                len(set(product_ids)) != 3):
            raise auth.EvidenceError("Three distinct current products are required for review fixtures")
        product, graphql_product, denial_product = product_ids
        for caller in callers:
            status, body = self.request("POST", self.functions + "/api/password/verify", caller, {
                "businessEntityID": caller.business_id, "password": caller.password})
            self.require("review-functions-token-control-" + caller.label,
                         status == 200 and isinstance(body, dict) and body.get("isValid") is True,
                         "The wrong-audience token must be accepted by Functions for the signed owner.")
        fixtures = []
        for caller in callers:
            payload = {"ProductID": product, "ReviewerName": "AuthMutation-" + self.run_id,
                       "ReviewDate": datetime.now(timezone.utc).isoformat(),
                       "EmailAddress": caller.email, "Rating": 4,
                       "Comments": "Disposable authentication mutation " + self.run_id, "UserID": caller.business_id}
            residual = {"kind": "review", "owner": caller.business_id, "state": "creation-requested"}
            self.record_residual(residual)
            status, body = self.request("POST", self.dab + "/api/ProductReview", caller, payload, dab=True)
            rows = body.get("value") if isinstance(body, dict) else None
            review = rows[0].get("ProductReviewID") if isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0], dict) else None
            self.require("review-create-" + caller.label, status == 201 and type(review) is int and review > 0,
                         "DAB owner-bound consumer review creation must return 201 and a positive ID; HTTP " + str(status))
            self.update_residual(residual, id=review, state="retained")
            self.require("review-create-redacted-" + caller.label, "EmailAddress" not in rows[0],
                         "The create response must not disclose reviewer email through read permissions.")
            suffix = "/ProductReviewID/" + str(review)
            snapshot = self.rows("ProductReview", caller, suffix)
            self.require("review-persisted-" + caller.label, len(snapshot) == 1 and
                         snapshot[0].get("UserID") == caller.business_id and
                         snapshot[0].get("Comments") == payload["Comments"] and
                         "EmailAddress" not in snapshot[0],
                         "Separate persisted read confirms ownership and content without reviewer email.")
            fixtures.append((caller, suffix, snapshot))
        control_marker = "AuthMutation-" + self.run_id
        control_suffix = "?" + urlencode({"$filter": f"ReviewerName eq '{control_marker}'", "$first": "1"})
        control = self.rows("ProductReview", None, control_suffix)
        self.require("review-marker-read-control", len(control) == 1 and
                     control[0].get("ReviewerName") == control_marker and
                     "EmailAddress" not in control[0] and
                     control[0].get("ProductReviewID") in
                     {snapshot[0]["ProductReviewID"] for _, _, snapshot in fixtures},
                     "Anonymous marker-filtered read must find a known run-owned review.")
        self.review_graphql_creates(callers, graphql_product, denial_product)
        for caller, other in [(callers[0], callers[1]), (callers[1], callers[0])]:
            for label, token, role, owner in [
                ("anonymous", None, None, caller.business_id),
                ("forged", "invalid-auth-validation-token", "consumer", caller.business_id),
                ("functions-audience", caller.token("functions"), "consumer", caller.business_id),
                ("cross-owner", caller.token("dab"), "consumer", other.business_id),
            ]:
                marker = f"AuthDeny-{self.run_id}-{caller.label}-{label}"
                self.require(f"review-create-denied-{caller.label}-{label}-baseline",
                             self.review_marker_rows(marker) == [],
                             "Unique run-marker review must not exist before the attempted create.")
                payload = {"ProductID": denial_product, "ReviewerName": marker,
                           "ReviewDate": datetime.now(timezone.utc).isoformat(),
                           "EmailAddress": caller.email, "Rating": 4,
                           "Comments": "Denied disposable review creation", "UserID": owner}
                residual = {"kind": "review-denial-probe", "owner": owner, "marker": marker,
                            "state": "creation-requested"}
                self.record_residual(residual)
                status, _, _ = auth.http("POST", self.dab + "/api/ProductReview", token=token, data=payload,
                                         headers={"X-MS-API-ROLE": role} if role else None)
                expected = {401, 403} if label == "anonymous" else {401} if label in {
                    "forged", "functions-audience"} else {403}
                check = f"review-create-denied-{caller.label}-{label}"
                self.report.check("mutation:" + check, "live-denials", status in expected,
                                  f"Valid review create must be denied for {label}; HTTP {status}.")
                absent = self.review_marker_rows(marker) == []
                self.confirm_denied_absence(
                    check, status in expected, absent,
                    "Independent public marker-filtered read must find no created review.", residual)
                if status not in expected or not absent:
                    raise auth.EvidenceError("Review create denial or unchanged-state assertion failed: " + check)
        for caller, suffix, snapshot in fixtures:
            url = self.dab + "/api/ProductReview" + suffix
            for label, method, data in [("content", "PATCH", {"Comments": "Unauthorized rewrite"}),
                                         ("owner", "PATCH", {"UserID": callers[1 if caller is callers[0] else 0].business_id}),
                                         ("delete", "DELETE", None)]:
                status, _ = self.request(method, url, caller, data, dab=True)
                self.require("review-denied-" + caller.label + "-" + label, status == 403,
                             "Consumer cannot change review content/owner or delete via vote-only permission.")
                current = self.rows("ProductReview", caller, suffix)
                self.require("review-unchanged-" + caller.label + "-" + label, current == snapshot,
                             "Persisted review remains unchanged after denied operation.")
            for label, item in [("content", {"Comments": "Unauthorized rewrite"}),
                                ("owner", {"UserID": callers[1 if caller is callers[0] else 0].business_id})]:
                query = ("mutation Denied($id: Int!, $item: UpdateProductReviewInput!) { "
                         "updateProductReview(ProductReviewID: $id, item: $item) { ProductReviewID } }")
                status, body = self.request("POST", self.graphql, caller, {
                    "query": query, "variables": {"id": snapshot[0]["ProductReviewID"], "item": item}
                }, dab=True)
                data = body.get("data") if isinstance(body, dict) else None
                errors = body.get("errors") if isinstance(body, dict) else None
                self.require("review-graphql-denied-" + caller.label + "-" + label,
                             status == 200 and isinstance(errors, list) and len(errors) > 0 and
                             all(isinstance(error, dict) and error.get("message") ==
                                 "Unauthorized due to one or more fields in this mutation." for error in errors) and
                             (data is None or isinstance(data, dict) and data.get("updateProductReview") is None),
                             "GraphQL cannot change review content or owner.")
                current = self.rows("ProductReview", caller, suffix)
                self.require("review-graphql-unchanged-" + caller.label + "-" + label, current == snapshot,
                             "Persisted review remains unchanged after denied GraphQL operation.")
            query = ("mutation DeniedDelete($id: Int!) { "
                     "deleteProductReview(ProductReviewID: $id) { ProductReviewID } }")
            status, body = self.request("POST", self.graphql, caller, {
                "query": query, "variables": {"id": snapshot[0]["ProductReviewID"]}
            }, dab=True)
            data = body.get("data") if isinstance(body, dict) else None
            errors = body.get("errors") if isinstance(body, dict) else None
            self.require("review-graphql-denied-" + caller.label + "-delete",
                         status == 200 and isinstance(errors, list) and len(errors) > 0 and
                         all(isinstance(error, dict) and error.get("message") ==
                             "The current user is not authorized to access this resource." for error in errors) and
                         (data is None or isinstance(data, dict) and data.get("deleteProductReview") is None),
                         "GraphQL cannot delete a review.")
            current = self.rows("ProductReview", caller, suffix)
            self.require("review-graphql-unchanged-" + caller.label + "-delete", current == snapshot,
                         "Persisted review remains unchanged after denied GraphQL delete.")
            self.review_vote_denials(caller, suffix, snapshot)
            votes = snapshot[0].get("HelpfulVotes")
            self.require("review-vote-fixture-" + caller.label, type(votes) is int and votes >= 0,
                         "Persisted vote count must be an integer before increment.")
            voter = callers[1 if caller is callers[0] else 0]
            query = ("mutation Vote($id: Int!, $votes: Int!) { "
                     "updateProductReview(ProductReviewID: $id, item: { HelpfulVotes: $votes }) "
                     "{ ProductReviewID HelpfulVotes } }")
            status, body = self.request("POST", self.graphql, voter, {
                "query": query, "variables": {"id": snapshot[0]["ProductReviewID"], "votes": votes + 1}
            }, dab=True)
            result = body.get("data", {}).get("updateProductReview") if isinstance(body, dict) and \
                isinstance(body.get("data"), dict) else None
            self.require("review-vote-" + caller.label, status == 200 and isinstance(body, dict) and
                         not body.get("errors") and result == {
                             "ProductReviewID": snapshot[0]["ProductReviewID"], "HelpfulVotes": votes + 1},
                         "Other authenticated consumer can update only the vote count via GraphQL; HTTP " + str(status))
            current = self.rows("ProductReview", caller, suffix)
            expected = {**snapshot[0], "HelpfulVotes": votes + 1}
            self.require("review-vote-persisted-" + caller.label, current == [expected],
                         "Separate read proves only the allowed vote field changed.")

    def run(self):
        callers = self.accounts()
        for name, scenario in [("passwords", lambda: self.passwords(callers)),
                               ("addresses", lambda: self.addresses(callers)),
                               ("address-create-denials", lambda: self.address_create_denials(callers)),
                               ("address-removal", self.address_removal),
                               ("category-create-denials", lambda: self.catalog_create_denials(
                                   callers, "ProductCategory", "category-create")),
                               ("subcategory-create-denials", lambda: self.catalog_create_denials(
                                   callers, "ProductSubcategory", "subcategory-create")),
                               ("reviews", lambda: self.reviews(callers)),
                               ("customer-creates", lambda: self.customer_creates(callers))]:
            self.report.guarded("mutation:" + name, "mutations", scenario)
        self.report.guarded("mutation:customer-create-evidence", "mutations", self.customer_create_evidence)
        self.report.guarded("mutation:customer-mcp-owner", "mutations",
                            lambda: self.customer_mcp_owner_controls(callers))
        self.report.add("mutation:residuals", "residuals", "ACCEPTED_EXCEPTION",
                        "Disposable run-owned consumers, Customers, reviews and uncertain fixtures are inventoried. "
                        "Confirmed unreferenced address fixtures are removed when the private SQL check is available. "
                        "IDs and uncertain-create states are inventoried; passwords/emails/tokens are not exported. "
                        "No seed reset or shared-data restoration required.")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    run_id = uuid.uuid4().hex[:16]
    output = (args.output or auth.ROOT / ".auth-results" / ("mutations-" + run_id)).resolve()
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    report = auth.Report(output)
    deployment = None
    table_client = None
    credential = None
    try:
        deployment = auth.Deployment(args.environment)
        if deployment.runtime:
            run_id = deployment.runtime["runId"][-36:].replace("-", "")[:16]
            configuration = runtime_config.load()
            if configuration is None:
                raise auth.EvidenceError("Private mutation run is missing its restricted configuration.")
            storage = configuration.get("storage", {})
            if not storage.get("tableEndpoint") or not storage.get("mutationTableName"):
                raise auth.EvidenceError("Private mutation run is missing its temporary ledger table.")
            from azure.data.tables import TableClient
            from azure.identity import ManagedIdentityCredential
            credential = ManagedIdentityCredential(client_id=configuration["identity"]["clientId"])
            table_client = TableClient(storage["tableEndpoint"], storage["mutationTableName"],
                                       credential=credential)
            ledger = MutationRunLedger(table_client, configuration["runId"])
        else:
            ledger = None
        report.provenance.update({"profile": "disposable-mutations", "runId": run_id,
                                  "azdEnvironment": deployment.values.get("AZURE_ENV_NAME"),
                                  "baseline": "Self-arranged; no unused/pristine seed prerequisite",
                                  "sourceSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()})
        report.guarded("mutation:setup", "mutations",
                       lambda: Mutations(report, deployment, run_id, ledger).run())
    except auth.EvidenceError as error:
        report.add("mutation:discovery", "mutations", "BLOCKED", str(error))
    finally:
        if table_client is not None:
            table_client.close()
        if credential is not None:
            credential.close()
    code = report.save()
    # Keep residual IDs in the portable private report, not only the raw suite inventory.
    provenance = {**report.provenance, "residuals": report.inventory.get("mutationResiduals", [])}
    reporting.render(reporting.combine([("suite", {"checks": report.checks})], provenance), output / "published")
    if deployment is None or not deployment.runtime:
        reporting.pdf(output / "published")
    return code


if __name__ == "__main__":
    sys.exit(main())
