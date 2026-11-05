#!/usr/bin/env python3
"""Authenticate seeded internal users against the selected azd deployment."""

import argparse
import base64
import hashlib
import http.cookiejar
import json
import math
import os
from pathlib import Path
import secrets
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request


ROOT = Path(__file__).resolve().parents[2]
IDENTITIES = {
    "admin": ("ken0@adventure-works.com", "Admin1234!",
              "adventureworks-admin", "http://localhost:5174/oauth/callback",
              "executive-admin"),
    "manufacturing": ("peter0@adventure-works.com", "Factory1234!",
                      "adventureworks-manufacturing", "http://localhost:5175/oauth/callback",
                      "manufacturing-engineer"),
}
SCOPES = {
    "admin": "mcp.access products.read sales.read customers.read customers.write "
             "inventory.read orders.read orders.write manufacturing.read "
             "manufacturing.write admin.read admin.write mcp.admin",
    "manufacturing": "mcp.access products.read inventory.read manufacturing.read manufacturing.write",
}


class AuthError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Capture OAuth callbacks; never forward credentials/tokens to redirects.
        return None


def azd_value(key, environment, required=True):
    command = ["azd", "env", "get-value", key, "--no-prompt", "--cwd", str(ROOT)]
    if environment:
        command += ["--environment", environment]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode:
        diagnostic = (result.stdout + result.stderr).lower()
        if not required and "key not found in environment values:" in diagnostic:
            return ""
        raise AuthError(f"Cannot read {key} from azd. Select a deployed environment with 'azd env select'.")
    value = result.stdout.strip()
    if required and not value:
        raise AuthError(f"azd environment value {key} is empty.")
    return value


def https_url(value):
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username
            or parsed.password or parsed.query or parsed.fragment):
        raise AuthError("Deployment endpoints must be absolute HTTPS URLs without credentials/query/fragment.")
    return value.rstrip("/")


def deployment(environment, resource):
    mcp = https_url(azd_value("API_MCP_URL", environment))
    base = mcp[:-4] if mcp.endswith("/mcp") else mcp
    override = azd_value(f"{resource.upper()}_RESOURCE_IDENTIFIER", environment, required=False)
    audience = override.rstrip("/") if override else f"{base}/{resource}"
    return base, audience


def send_http(opener, url, timeout, form=None, data=None, headers=None, method=None):
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        headers = {"Content-Type": "application/x-www-form-urlencoded"}
    request = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as error:
        with error:
            return error.code, error.headers, error.read()
    except (urllib.error.URLError, TimeoutError) as error:
        raise AuthError(f"Network request failed for {urllib.parse.urlsplit(url).path}: {error}") from error


def token_response(status, body):
    if status != 200:
        # Only OAuth error fields are surfaced: never dump a token response.
        try:
            error = json.loads(body)
            detail = f"{error.get('error', 'unknown_error')}: {error.get('error_description', '')}"
        except (ValueError, AttributeError):
            detail = "non-JSON response"
        raise AuthError(f"Token exchange failed (HTTP {status}): {detail}")
    result = json.loads(body)
    if not isinstance(result, dict) or not isinstance(result.get("access_token"), str):
        raise AuthError("Token response is missing an access_token.")
    if result.get("token_type", "").lower() != "bearer":
        raise AuthError("Token response is not a Bearer token.")
    return result


def claims(token):
    # Inspection only. Signature/lifetime enforcement belongs to the resource server.
    try:
        payload = token.split(".")[1]
        result = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        if not isinstance(result, dict):
            raise ValueError("not an object")
        return result
    except (IndexError, ValueError) as error:
        raise AuthError("Access token has an invalid JWT payload.") from error


def session(opener, args, base, audience):
    email, password, client, redirect, role = IDENTITIES[args.identity]
    if args.command == "refresh":
        previous = json.load(sys.stdin)
        if (not isinstance(previous, dict) or previous.get("_client_id") != client
                or previous.get("_issuer") != base + "/"):
            raise AuthError("Refresh session does not match the selected identity/deployment.")
        refresh = previous.get("refresh_token")
        if not isinstance(refresh, str) or not refresh:
            raise AuthError("Session has no refresh_token; obtain a new token with --json.")
        form = {"grant_type": "refresh_token", "client_id": client,
                "refresh_token": refresh, "resource": audience}
    else:
        password = os.environ.get("AZURE_AUTH_PASSWORD", password)
        status, headers, _ = send_http(opener, base + "/login", args.timeout, form={
            "username": email, "password": password, "returnUrl": "/",
        })
        if status != 302 or headers.get("Location") != "/":
            raise AuthError(f"Login failed for {args.identity} (HTTP {status}). Check seeding/password.")
        verifier = secrets.token_urlsafe(48)
        challenge = base64.urlsafe_b64encode(
            hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        state = secrets.token_urlsafe(24)
        status, headers, _ = send_http(opener, base + "/authorize", args.timeout, form={
            "client_id": client, "redirect_uri": redirect, "response_type": "code",
            "scope": SCOPES[args.identity] + " offline_access", "resource": audience,
            "code_challenge": challenge, "code_challenge_method": "S256", "state": state,
            "decision": "allow",
        })
        location = urllib.parse.urlsplit(headers.get("Location", ""))
        query = urllib.parse.parse_qs(location.query)
        expected = urllib.parse.urlsplit(redirect)
        if status != 302 or (location.scheme, location.netloc, location.path) != (
                expected.scheme, expected.netloc, expected.path):
            raise AuthError(f"Authorization failed (HTTP {status}); no registered callback returned.")
        if query.get("state") != [state]:
            raise AuthError("Authorization failed: state mismatch.")
        if "error" in query:
            raise AuthError(f"Authorization denied: {query['error'][0]}. Check portal category/scopes.")
        if len(query.get("code", [])) != 1:
            raise AuthError("Authorization failed: missing authorization code.")
        form = {"grant_type": "authorization_code", "client_id": client,
                "redirect_uri": redirect, "code": query["code"][0],
                "code_verifier": verifier, "resource": audience}
    status, _, body = send_http(opener, base + "/token", args.timeout, form=form)
    result = token_response(status, body)
    if not isinstance(result.get("refresh_token"), str) or not result["refresh_token"]:
        raise AuthError("Token response is missing the requested rotating refresh_token.")
    payload = claims(result["access_token"])
    audiences = payload.get("aud")
    roles = payload.get("roles", [])
    if isinstance(roles, str):
        roles = [roles]
    if isinstance(audiences, str):
        audiences = [audiences]
    if (not isinstance(audiences, list) or not isinstance(roles, list)
            or audience not in audiences
            or payload.get("iss") != base + "/" or not payload.get("sub") or role not in roles):
        raise AuthError("Issued token does not match the expected issuer, audience, subject, or seeded role.")
    result.update(_client_id=client, _issuer=base + "/")
    return result


def request_url(base, path):
    parsed = urllib.parse.urlsplit(path)
    if not path.startswith("/") or path.startswith("//") or parsed.scheme or parsed.netloc or parsed.fragment:
        raise AuthError("--path must be a deployment-relative path starting with / (no hostname/fragment).")
    return base + path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["token", "refresh", "request"])
    parser.add_argument("--identity", required=True, choices=IDENTITIES)
    parser.add_argument("--resource", required=True, choices=["dab", "functions", "mcp"])
    parser.add_argument("--environment", help="azd environment; default is the selected environment")
    parser.add_argument("--timeout", type=float, default=180, help="per-request seconds (default 180)")
    parser.add_argument("--json", action="store_true", help="emit full renewable session instead of access token")
    parser.add_argument("--path", help="request path; /graphql, /api/Product, /api/manufacturing/status, /mcp")
    parser.add_argument("--method", default="GET", choices=["GET", "POST", "PUT", "PATCH", "DELETE"])
    data = parser.add_mutually_exclusive_group()
    data.add_argument("--data", help="request body (JSON by default)")
    data.add_argument("--data-file", help="request body file, or - for stdin")
    parser.add_argument("--content-type", default="application/json")
    args = parser.parse_args()
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("--timeout must be finite and positive")
    if args.command == "request" and not args.path:
        parser.error("request requires --path")
    base, audience = deployment(args.environment, args.resource)
    target = None
    if args.command == "request":
        if args.resource == "dab":
            target = https_url(azd_value("API_URL", args.environment))
            if target.endswith("/graphql"):
                target = target[:-8]
        elif args.resource == "functions":
            target = https_url(azd_value("API_FUNCTIONS_URL", args.environment))
        else:
            target = base
        target = request_url(target, args.path)
    opener = urllib.request.build_opener(
        NoRedirect(), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    result = session(opener, args, base, audience)
    if args.command != "request":
        print(json.dumps(result) if args.json or args.command == "refresh" else result["access_token"])
        return 0
    body = args.data.encode() if args.data is not None else None
    if args.data_file:
        body = sys.stdin.buffer.read() if args.data_file == "-" else Path(args.data_file).read_bytes()
    headers = {"Authorization": "Bearer " + result["access_token"], "Content-Type": args.content_type}
    headers["Accept"] = "application/json, text/event-stream" if args.resource == "mcp" else "application/json"
    if args.resource == "dab":
        headers["X-MS-API-ROLE"] = IDENTITIES[args.identity][4]
    status, _, response = send_http(opener, target, args.timeout, data=body, headers=headers, method=args.method)
    sys.stdout.buffer.write(response)
    if not 200 <= status < 300:
        raise AuthError(f"API request failed (HTTP {status}). Response is on stdout.")
    if args.resource == "dab":
        try:
            document = json.loads(response)
        except ValueError:
            document = None
        if isinstance(document, dict) and document.get("errors"):
            raise AuthError("DAB returned GraphQL errors. Response is on stdout.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (AuthError, OSError, ValueError) as error:
        print(f"azure-auth: {error}", file=sys.stderr)
        sys.exit(1)
