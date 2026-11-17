#!/usr/bin/env python3
"""Opt-in private, run-owned address fixtures and real-host ownership probes."""

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlencode
import urllib.request

import validate as auth
from ephemeral_storage import MutationRunLedger


def address_audit(report):
    log = report.output / "address-audit.log"
    try:
        with log.open("wb") as stream:
            result = subprocess.run([
                "dotnet", "tests/auth/private/bin/Debug/net10.0/PrivateProbe.dll",
                "--address-audit",
            ], cwd=auth.ROOT, stdout=stream, stderr=subprocess.STDOUT, timeout=300)
    except subprocess.TimeoutExpired as error:
        raise auth.EvidenceError("Read-only address audit timed out") from error
    except OSError as error:
        raise auth.EvidenceError("Read-only address audit could not execute") from error
    try:
        documents = [json.loads(line) for line in log.read_text().splitlines() if line.startswith('{"addressAudit":')]
    except (ValueError, UnicodeError) as error:
        raise auth.EvidenceError("Read-only address audit returned malformed evidence") from error
    if result.returncode != 0 or len(documents) != 1:
        raise auth.EvidenceError("Read-only address audit has no confirmed structured result")
    audit = documents[0].get("addressAudit")
    if (not isinstance(audit, dict) or set(audit) != {"ownersMatch", "ownerLinks", "addresses", "links"} or
            type(audit["ownersMatch"]) is not bool or not isinstance(audit["ownerLinks"], list) or
            len(audit["ownerLinks"]) != 2 or any(type(count) is not int or count < 0 for count in audit["ownerLinks"]) or
            not isinstance(audit["addresses"], list) or not isinstance(audit["links"], list)):
        raise auth.EvidenceError("Read-only address audit returned incomplete evidence")
    for row in audit["addresses"]:
        if (not isinstance(row, dict) or set(row) != {
                "id", "marker", "line2", "city", "state", "postal", "rowGuid", "modified",
                "foreignLinks", "orderReferences"} or
                any(type(row[key]) is not int or row[key] < 0
                    for key in ["id", "state", "foreignLinks", "orderReferences"]) or
                row["id"] == 0 or row["state"] == 0):
            raise auth.EvidenceError("Read-only address audit returned invalid address evidence")
    for row in audit["links"]:
        if (not isinstance(row, dict) or set(row) != {"addressId", "owner", "type", "rowGuid", "modified"} or
                any(type(row[key]) is not int or row[key] <= 0 for key in ["addressId", "owner", "type"])):
            raise auth.EvidenceError("Read-only address audit returned invalid link evidence")
    return audit


def fixture_ledger(configuration):
    storage = configuration.get("storage", {})
    endpoint, name = storage.get("tableEndpoint"), storage.get("mutationTableName")
    if not endpoint or not name:
        raise auth.EvidenceError("A private temporary mutation ledger is required before address fixture writes")
    from azure.core.exceptions import AzureError
    from azure.data.tables import TableClient
    from azure.identity import ManagedIdentityCredential
    try:
        credential = ManagedIdentityCredential(client_id=configuration["identity"]["clientId"])
        ledger = MutationRunLedger(TableClient(endpoint=endpoint, table_name=name, credential=credential),
                                   configuration["runId"])
    except AzureError as error:
        raise auth.EvidenceError("The temporary address fixture ledger could not be initialized") from error
    return ledger, AzureError


def ledger_write(ledger, azure_error, residual, *, record=False):
    try:
        (ledger.record if record else ledger.update)(residual)
    except azure_error as error:
        raise auth.EvidenceError("The temporary address fixture ledger write failed; no write retried") from error


def admin_dab_token(deployment):
    helper = auth.load_auth_helper()
    try:
        base, audience = auth.internal_token_target(deployment, "dab")
        opener = urllib.request.build_opener(helper.NoRedirect(), urllib.request.HTTPCookieProcessor())
        session = helper.session(opener, argparse.Namespace(identity="admin", command="token", timeout=120),
                                 base, audience)
        return session["access_token"]
    except (helper.AuthError, ValueError, OSError, KeyError) as error:
        raise auth.EvidenceError("Administrative DAB control could not authenticate; no fixture writes sent") from error


def verify_cleanup_scope(audit, consumers, known_ids, marker):
    ids = [row["id"] for row in audit["addresses"]]
    owner_ids = {caller.business_id for caller in consumers}
    pairs = [(row["addressId"], row["owner"]) for row in audit["links"]]
    if (not audit["ownersMatch"] or len(ids) != len(set(ids)) or set(ids) != set(known_ids) or
            len(pairs) != len(set(pairs)) or
            any(row["marker"] != marker or row["foreignLinks"] or row["orderReferences"]
                for row in audit["addresses"]) or
            any(row["addressId"] not in ids or row["owner"] not in owner_ids for row in audit["links"]) or
            audit["ownerLinks"] != [sum(row["owner"] == caller.business_id for row in audit["links"])
                                    for caller in consumers]):
        raise auth.EvidenceError("Fixture scope, owner identity or reference check failed; cleanup refused")


def cleanup_fixtures(report, deployment, consumers, known, residuals, ledger, azure_error, marker):
    if any(item["state"] == "creation-requested" for item in residuals):
        raise auth.EvidenceError("A fixture write has an uncertain outcome; cleanup cannot safely race it")
    audit = address_audit(report)
    verify_cleanup_scope(audit, consumers, [item["id"] for item in known], marker)
    by_owner = {caller.business_id: caller for caller in consumers}
    base = auth.https_url(deployment.required("API_FUNCTIONS_URL")) + "/api/addresses/"
    for link in audit["links"]:
        caller = by_owner[link["owner"]]
        status, _ = response_json("DELETE", base + str(link["addressId"]), caller.token("functions"))
        if status != 204:
            raise auth.EvidenceError("Run-owned address deletion was not confirmed; remaining cleanup stopped")
    after = address_audit(report)
    verify_cleanup_scope(after, consumers, [], marker)
    for residual in residuals:
        residual["state"] = "deleted"
        ledger_write(ledger, azure_error, residual)
    report.add("address-fixtures-cleanup", "ownership", "PASS",
               "Application APIs removed the exact run-owned owner links; read-only SQL verifies no fixture rows remain.")


def response_json(method, url, token, data=None):
    status, _, raw = auth.http(method, url, token=token, data=data)
    if status == 204:
        return status, None
    try:
        return status, json.loads(raw)
    except ValueError as error:
        raise auth.EvidenceError("Address host probe returned invalid JSON") from error


def address_link_denials(report, deployment, consumers, records):
    graphql = auth.https_url(deployment.required("API_URL"))
    endpoint = auth.origin(graphql) + "/api/BusinessEntityAddress"
    for caller, other in [(consumers[0], consumers[1]), (consumers[1], consumers[0])]:
        owned, foreign = records[caller.label][0], records[other.label][0]
        token = caller.token("dab")
        for role in ["consumer", "authenticated"]:
            headers = {"X-MS-API-ROLE": role}

            def read(address):
                query = urlencode({
                    "$filter": f"BusinessEntityID eq {caller.business_id} and AddressID eq {address}",
                    "$select": "BusinessEntityID,AddressID,AddressTypeID", "$first": 10,
                })
                status, _, raw = auth.http("GET", endpoint + "?" + query, token=token, headers=headers)
                try:
                    body = json.loads(raw)
                except ValueError as error:
                    raise auth.EvidenceError("Address-link control returned invalid JSON; payload withheld") from error
                if (status != 200 or not isinstance(body, dict) or not isinstance(body.get("value"), list) or
                        body.get("nextLink") is not None):
                    raise auth.EvidenceError("Address-link control was incomplete; no link write probes sent")
                return body["value"]

            own_rows, foreign_rows = read(owned), read(foreign)
            valid = (len(own_rows) == 1 and isinstance(own_rows[0], dict) and
                     set(own_rows[0]) == {"BusinessEntityID", "AddressID", "AddressTypeID"} and
                     own_rows[0]["BusinessEntityID"] == caller.business_id and
                     own_rows[0]["AddressID"] == owned and
                     type(own_rows[0]["AddressTypeID"]) is int and own_rows[0]["AddressTypeID"] > 0 and
                     foreign_rows == [])
            report.check(f"address-links:{caller.label}:{role}:controls", "ownership", valid,
                         "The run-owned duplicate link exists and the other owner's address is not linked.")
            if not valid:
                raise auth.EvidenceError("Address-link controls failed; no link write probes sent")

            duplicate = own_rows[0]
            address_type = duplicate["AddressTypeID"]
            missing_path = (f"{endpoint}/BusinessEntityID/{caller.business_id}/"
                            f"AddressID/{foreign}/AddressTypeID/{address_type}")
            keys = (f"BusinessEntityID: {caller.business_id}, AddressID: {foreign}, "
                    f"AddressTypeID: {address_type}")
            fields = "BusinessEntityID AddressID AddressTypeID"
            cases = [
                ("rest-create", "POST", endpoint, duplicate),
                ("rest-update", "PATCH", missing_path, {"ModifiedDate": "2000-01-01T00:00:00Z"}),
                ("rest-delete", "DELETE", missing_path, None),
                ("graphql-create", "POST", graphql, {"query":
                    f"mutation {{ createBusinessEntityAddress(item: {{ BusinessEntityID: {caller.business_id}, "
                    f"AddressID: {owned}, AddressTypeID: {address_type} }}) {{ {fields} }} }}"}),
                ("graphql-update", "POST", graphql, {"query":
                    f'mutation {{ updateBusinessEntityAddress({keys}, item: {{ ModifiedDate: "2000-01-01T00:00:00Z" }}) '
                    f"{{ {fields} }} }}"}),
                ("graphql-delete", "POST", graphql, {"query":
                    f"mutation {{ deleteBusinessEntityAddress({keys}) {{ {fields} }} }}"}),
            ]
            for name, method, url, payload in cases:
                status, _, raw = auth.http(method, url, token=token, headers=headers, data=payload)
                try:
                    body = json.loads(raw)
                except ValueError:
                    body = None
                if name.startswith("rest-"):
                    denied = (status == 403 and isinstance(body, dict) and
                              set(body) <= {"error", "errors"} and bool(body.get("error") or body.get("errors")))
                else:
                    errors = body.get("errors") if isinstance(body, dict) else None
                    result = body.get("data") if isinstance(body, dict) else None
                    denied = (status == 200 and (result is None or
                              isinstance(result, dict) and all(value is None for value in result.values())) and
                              isinstance(errors, list) and bool(errors) and
                              all(isinstance(error, dict) and isinstance(error.get("extensions"), dict) and
                                  error["extensions"].get("code") == "AUTH_NOT_AUTHORIZED" for error in errors))
                check = f"address-links:{caller.label}:{role}:{name}"
                report.check(check, "live-denials", denied,
                             f"Direct address-link {name} must return an authorization denial; HTTP {status}.")
                unchanged = read(owned) == own_rows and read(foreign) == []
                report.check(check + ":unchanged", "ownership", unchanged,
                             "Independent owner reads must show the fixture link unchanged and foreign link absent.")
                if not denied or not unchanged:
                    raise auth.EvidenceError("Address-link denial or unchanged-state assertion failed")


def host_probes(report, deployment, consumers, marker):
    base = auth.https_url(deployment.required("API_FUNCTIONS_URL")) + "/api/addresses"
    pages = {}
    for caller in consumers:
        status, page = response_json("GET", base + "?limit=100&offset=0", caller.token("functions"))
        valid = (status == 200 and isinstance(page, list) and len(page) == 3 and
                 all(isinstance(item, dict) and type(item.get("addressID")) is int and
                     item["addressID"] > 0 and item.get("addressLine1") == marker for item in page) and
                 len({item["addressID"] for item in page}) == 3)
        report.check("address-fixtures:" + caller.label + ":fixture-records", "ownership", valid,
                     "Exactly three distinct run-marker addresses must belong to this isolated consumer.")
        if not valid:
            raise auth.EvidenceError("Address fixtures not established; no API mutations permitted")
        pages[caller.label] = [item["addressID"] for item in page]
    shared = set(pages[consumers[0].label]) & set(pages[consumers[1].label])
    report.check("address-fixtures:shared-identity", "ownership", len(shared) == 1,
                 "Exactly one run-owned address must be linked to both consumers.")
    if len(shared) != 1:
        raise auth.EvidenceError("Exactly one shared address is required; no API mutations permitted")
    shared_id = next(iter(shared))
    records = {caller.label: sorted(set(pages[caller.label]) - shared) for caller in consumers}
    exclusive = all(len(records[caller.label]) == 2 and pages[caller.label][0] in records[caller.label]
                    for caller in consumers)
    report.check("address-fixtures:exclusive-identities", "ownership", exclusive,
                 "Each consumer must also have two distinct, exclusive run-owned addresses.")
    if not exclusive:
        raise auth.EvidenceError("Exclusive address controls are invalid; no API mutations permitted")
    for caller, other in [(consumers[0], consumers[1]), (consumers[1], consumers[0])]:
        for offset, expected in enumerate(sorted(pages[caller.label])):
            status, page = response_json("GET", base + f"?limit=1&offset={offset}&businessEntityId={other.business_id}",
                                         caller.token("functions"))
            valid = (status == 200 and isinstance(page, list) and len(page) == 1 and
                     isinstance(page[0], dict) and type(page[0].get("addressID")) is int and
                     page[0]["addressID"] == expected)
            report.check(f"address-fixtures:{caller.label}:page:{offset}", "ownership", valid,
                         "SQL ownership precedes pagination despite supplied other-owner query")
            if not valid:
                raise auth.EvidenceError("Owned SQL pagination failed; no API mutations permitted")
    address_link_denials(report, deployment, consumers, records)
    auth.consumer_address_reads(report, deployment, consumers)
    if any(check["status"] != "PASS" for check in report.checks):
        raise auth.EvidenceError("Owner read isolation was not established; no API mutations permitted")
    for caller, other in [(consumers[0], consumers[1]), (consumers[1], consumers[0])]:
        address = records[other.label][0]
        for name, method, suffix, payload in [
            ("update", "PUT", "", {"city": "Denied auth mutation"}),
            ("delete", "DELETE", "", None),
            ("type", "PUT", "/type", {"addressTypeID": 2, "businessEntityID": other.business_id}),
        ]:
            status, denial = response_json(method, base + "/" + str(address) + suffix,
                                          caller.token("functions"), payload)
            valid = (status == 403 and isinstance(denial, dict) and
                     denial.get("error") == f"Address {address} is not owned by the current user.")
            report.check("address-fixtures:" + caller.label + ":other-" + name, "ownership", valid,
                         "Actual deployed cross-owner mutation must return exact ownership denial; HTTP " + str(status))
            if not valid:
                raise auth.EvidenceError("Cross-owner host mutation denial failed; further writes stopped")
    shared_address_probes(report, base, consumers, shared_id, marker)


def shared_address_probes(report, base, consumers, address_id, marker):
    url = base + "/" + str(address_id)

    def read(caller):
        status, body = response_json("GET", url, caller.token("functions"))
        if (status != 200 or not isinstance(body, dict) or body.get("addressID") != address_id or
                body.get("addressLine1") != marker or not isinstance(body.get("city"), str)):
            raise auth.EvidenceError("Shared address control could not establish unchanged owner-visible state")
        return body

    baseline = read(consumers[0])
    established = baseline.get("city") == "Auth assurance" and read(consumers[1]) == baseline
    report.check("address-fixtures:shared-controls", "ownership", established,
                 "Both verified owners must observe the same run-owned shared address.")
    if not established:
        raise auth.EvidenceError("Shared address views differ before mutation probes")
    for caller in consumers:
        for name, city, expected_status in [
            ("unchanged", "Auth assurance", 200),
            ("changed", "Denied shared mutation " + caller.label, 409),
        ]:
            status, body = response_json("PUT", url, caller.token("functions"), {"city": city})
            valid = (status == expected_status and isinstance(body, dict) and
                     (body == baseline if name == "unchanged" else
                      body.get("error") == "This address is shared. Add a new address instead."))
            report.check(f"address-fixtures:{caller.label}:shared-{name}", "ownership", valid,
                         "An unchanged shared address is saveable; physical changes must return HTTP 409.")
            if not valid:
                raise auth.EvidenceError("Shared address outcome was not established; further writes stopped")
            unchanged = all(read(owner) == baseline for owner in consumers)
            report.check(f"address-fixtures:{caller.label}:shared-{name}:unchanged", "ownership", unchanged,
                         "Both owners must observe the original shared address after the attempted write.")
            if not unchanged:
                raise auth.EvidenceError("Shared address changed unexpectedly; further writes stopped")


def run(report, deployment, configuration):
    run_id = configuration.get("runId", "")
    if (configuration.get("addressOnly") is not True or not deployment.runtime or
            not re.fullmatch(r"\d{8}T\d{6}Z-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", run_id)):
        raise auth.EvidenceError("Explicit private address-only mode with a valid run UUID is required")
    consumers = []
    for label in ["A", "B"]:
        prefix = "AUTH_TEST_CONSUMER_" + label + "_"
        if deployment.values.get(prefix + "STATE") != "ready":
            raise auth.EvidenceError("Pre-existing ready consumer fixtures required; no signups or resets performed")
        caller = auth.ConsumerSession(deployment, label, deployment.required(prefix + "EMAIL"),
                                      deployment.required(prefix + "PASSWORD"),
                                      int(deployment.required(prefix + "BUSINESS_ENTITY_ID")))
        caller.token("functions")
        consumers.append(caller)
    if consumers[0].business_id == consumers[1].business_id:
        raise auth.EvidenceError("Distinct authenticated consumers required")
    ledger, azure_error = fixture_ledger(configuration)
    admin = admin_dab_token(deployment)
    marker = "AuthAssurance-" + run_id[-36:].replace("-", "")
    before = address_audit(report)
    empty = before == {"ownersMatch": True, "ownerLinks": [0, 0], "addresses": [], "links": []}
    report.check("address-fixtures:empty-owners", "ownership", empty,
                 "Read-only SQL must verify both dedicated consumers and no existing links or run-marker addresses.")
    if not empty:
        raise auth.EvidenceError("Dedicated empty fixture owners were not established; no writes sent")
    graphql = auth.https_url(deployment.required("API_URL"))
    dab = auth.origin(graphql)
    status, _, raw = auth.http("GET", dab + "/api/StateProvince?$first=1&$select=StateProvinceID",
                               token=admin, headers={"X-MS-API-ROLE": "executive-admin"})
    try:
        rows = json.loads(raw).get("value", [])
    except (ValueError, AttributeError) as error:
        raise auth.EvidenceError("State/province prerequisite returned invalid JSON") from error
    if (status != 200 or not isinstance(rows, list) or not rows or not isinstance(rows[0], dict) or
            type(rows[0].get("StateProvinceID")) is not int or rows[0]["StateProvinceID"] <= 0):
        raise auth.EvidenceError("Valid state/province prerequisite unavailable; no writes sent")
    state_id = rows[0]["StateProvinceID"]
    base = auth.https_url(deployment.required("API_FUNCTIONS_URL")) + "/api/addresses"
    known, residuals = [], []
    report.inventory["addressFixtureResiduals"] = residuals
    baseline = None
    probes_started = probes_completed = False
    try:
        for caller in [consumers[0], consumers[0], consumers[1], consumers[1], consumers[0]]:
            residual = {"kind": "address-fixture", "owner": caller.business_id,
                        "marker": marker, "state": "creation-requested"}
            residuals.append(residual)
            ledger_write(ledger, azure_error, residual, record=True)
            status, body = response_json("POST", base, caller.token("functions"), {
                "addressLine1": marker, "city": "Auth assurance", "stateProvinceID": state_id,
                "postalCode": "00000", "addressTypeID": 3,
            })
            valid = (status == 201 and isinstance(body, dict) and type(body.get("addressID")) is int and
                     body["addressID"] > 0 and body.get("addressLine1") == marker and
                     body.get("city") == "Auth assurance" and
                     body["addressID"] not in {item["id"] for item in known})
            if not valid:
                raise auth.EvidenceError("Address creation not confirmed; no further fixture writes sent")
            known.append({"id": body["addressID"], "owner": caller.business_id, "residual": residual})
            residual.update(id=body["addressID"], state="created")
            ledger_write(ledger, azure_error, residual)
        shared = known[-1]["id"]
        link = {"kind": "address-fixture-link", "owner": consumers[1].business_id,
                "id": shared, "marker": marker, "state": "creation-requested"}
        residuals.append(link)
        ledger_write(ledger, azure_error, link, record=True)
        status, _, raw = auth.http("POST", dab + "/api/BusinessEntityAddress", token=admin,
                                   headers={"X-MS-API-ROLE": "executive-admin"}, data={
                                       "BusinessEntityID": consumers[1].business_id,
                                       "AddressID": shared, "AddressTypeID": 3,
                                   })
        try:
            response = json.loads(raw)
        except ValueError as error:
            raise auth.EvidenceError("Shared fixture link response is invalid; no further writes sent") from error
        rows = response.get("value") if isinstance(response, dict) else None
        valid = (status == 201 and isinstance(rows, list) and len(rows) == 1 and
                 isinstance(rows[0], dict) and rows[0].get("BusinessEntityID") == consumers[1].business_id and
                 rows[0].get("AddressID") == shared and rows[0].get("AddressTypeID") == 3)
        if not valid:
            raise auth.EvidenceError("Shared fixture link creation not confirmed; no further writes sent")
        link["state"] = "created"
        ledger_write(ledger, azure_error, link)
        baseline = address_audit(report)
        verify_cleanup_scope(baseline, consumers, [item["id"] for item in known], marker)
        expected = {(item["id"], item["owner"]) for item in known}
        expected.add((shared, consumers[1].business_id))
        valid = ({(row["addressId"], row["owner"]) for row in baseline["links"]} == expected and
                 baseline["ownerLinks"] == [3, 3])
        report.check("address-fixtures-setup", "ownership", valid,
                     "API-created fixture records and their exact exclusive/shared owner links are verified by read-only SQL.")
        if not valid:
            raise auth.EvidenceError("Fixture ownership could not be established; host writes stopped")
        probes_started = True
        host_probes(report, deployment, consumers, marker)
        probes_completed = True
    finally:
        try:
            if probes_started and not probes_completed:
                raise auth.EvidenceError("Host probes did not complete; a write may still be in flight")
            if baseline is not None:
                after = address_audit(report)
                report.check("address-fixtures-unchanged", "ownership", after == baseline,
                             "Read-only SQL must show all fixture address fields and owner links unchanged after host probes.")
            cleanup_fixtures(report, deployment, consumers, known, residuals, ledger, azure_error, marker)
        except auth.EvidenceError as error:
            report.add("address-fixtures:cleanup-unverified", "ownership", "FAIL",
                       str(error) + "; test records may remain. Do not retry uncertain writes or delete unrelated records.")
        for caller in consumers:
            try:
                status, page = response_json("GET", base + "?limit=1&offset=0", caller.token("functions"))
                report.check("address-fixtures:" + caller.label + ":empty-after-cleanup", "ownership",
                             status == 200 and page == [],
                             "Deployed owner listing must be empty after verified API fixture cleanup.")
            except auth.EvidenceError:
                report.add("address-fixtures:" + caller.label + ":empty-after-cleanup", "ownership", "FAIL",
                           "Final owner listing could not be read; fixture cleanup is unverified.")


if __name__ == "__main__":
    import runtime_config

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    report = auth.Report(args.output)
    configuration = runtime_config.load()
    report.guarded("address-fixtures:scenario", "ownership",
                   lambda: run(report, auth.Deployment(None), configuration or {}))
    sys.exit(report.save())
