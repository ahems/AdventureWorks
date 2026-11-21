#!/usr/bin/env python3
"""Renew Azure CLI federation for the GitHub deployment workflow."""

import base64
import binascii
import fcntl
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib import error, parse, request


AUDIENCE = "api://AzureADTokenExchange"
RENEW_AFTER_SECONDS = 120
MIN_ASSERTION_LIFETIME_SECONDS = 90
LOGIN_TIMEOUT_SECONDS = 120


class RenewalError(Exception):
    pass


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def github_assertion(environ, now):
    request_url = environ.get("ACTIONS_ID_TOKEN_REQUEST_URL")
    request_token = environ.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
    if not request_url or not request_token:
        raise RenewalError("GitHub OIDC request variables are missing; id-token: write is required.")

    try:
        url = parse.urlsplit(request_url)
        hostname = (url.hostname or "").lower()
        valid_url = (
            url.scheme == "https"
            and bool(hostname)
            and url.username is None
            and url.password is None
            and (url.port is None or 1 <= url.port <= 65535)
            and not url.fragment
            and not any(
                key.lower() == "audience"
                for key, _ in parse.parse_qsl(url.query, keep_blank_values=True)
            )
        )
    except ValueError:
        valid_url = False
    if not valid_url:
        raise RenewalError("GitHub supplied an invalid OIDC request URL.")

    separator = "&" if "?" in request_url else "?"
    oidc_url = request_url + separator + parse.urlencode({"audience": AUDIENCE})
    oidc_request = request.Request(
        oidc_url,
        headers={"Authorization": f"Bearer {request_token}", "Accept": "application/json"},
    )
    opener = request.build_opener(NoRedirect())
    for attempt in range(3):
        try:
            with opener.open(oidc_request, timeout=15) as response:
                body = response.read(65537)
            break
        except error.HTTPError as exc:
            if (exc.code == 429 or 500 <= exc.code < 600) and attempt < 2:
                time.sleep(2**attempt)
                continue
            raise RenewalError(f"GitHub OIDC token request failed (HTTP {exc.code}).") from None
        except (error.URLError, TimeoutError, OSError, http.client.HTTPException):
            if attempt < 2:
                time.sleep(2**attempt)
                continue
            raise RenewalError("GitHub OIDC token request failed; check runner connectivity.") from None

    try:
        if len(body) > 65536:
            raise ValueError("OIDC response is too large")
        assertion = json.loads(body)["value"]
        if not isinstance(assertion, str):
            raise ValueError("OIDC response is not a JWT")
        parts = assertion.split(".")
        if len(parts) != 3 or not all(re.fullmatch(r"[A-Za-z0-9_-]+", part) for part in parts):
            raise ValueError("OIDC response is not a JWT")
        payload = base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4))
        expires = json.loads(payload)["exp"]
        if isinstance(expires, bool) or not isinstance(expires, int):
            raise ValueError("JWT expiry is invalid")
    except (ValueError, KeyError, TypeError, UnicodeDecodeError, binascii.Error):
        raise RenewalError("GitHub returned an invalid OIDC assertion.") from None
    if expires - now < MIN_ASSERTION_LIFETIME_SECONDS:
        raise RenewalError("GitHub returned an OIDC assertion that expires too soon.")
    return assertion, expires


def settings(environ):
    names = (
        "AW_GITHUB_AZ_CLI",
        "AW_GITHUB_AZ_STATE",
        "AW_GITHUB_AZ_CLIENT_ID",
        "AW_GITHUB_AZ_TENANT_ID",
        "AW_GITHUB_AZ_SUBSCRIPTION_ID",
        "RUNNER_TEMP",
        "ACTIONS_ID_TOKEN_REQUEST_URL",
        "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    )
    if environ.get("GITHUB_ACTIONS") != "true" or any(not environ.get(name) for name in names):
        raise RenewalError("GitHub Azure CLI renewal is not configured or OIDC permission is missing.")
    cli = Path(environ["AW_GITHUB_AZ_CLI"])
    state = Path(environ["AW_GITHUB_AZ_STATE"])
    runner_temp = Path(environ["RUNNER_TEMP"])
    if (
        not cli.is_absolute()
        or not os.access(cli, os.X_OK)
        or not state.is_absolute()
        or not runner_temp.is_absolute()
    ):
        raise RenewalError("The GitHub Azure CLI executable or session directory is invalid.")
    state = state.resolve()
    if (
        state.parent != runner_temp.resolve()
        or not state.name.startswith("adventureworks-az-oidc.")
        or not state.is_dir()
        or state.stat().st_mode & 0o077
    ):
        raise RenewalError("The GitHub Azure CLI session directory is not private or is unexpected.")
    if os.path.samefile(cli, __file__):
        raise RenewalError("The Azure CLI executable points back to the OIDC wrapper.")
    return cli, state


def store_metadata(path, metadata):
    fd, temporary = tempfile.mkstemp(prefix=".metadata-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            json.dump(metadata, file)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def cli_environment(environ, profile):
    return {
        **environ,
        "AZURE_CONFIG_DIR": str(profile),
        "AZURE_CORE_COLLECT_TELEMETRY": "no",
    }


def renew_if_needed(cli, state, environ):
    base = state / "profile"
    metadata_file = state / "metadata.json"
    identity = {
        "client": environ["AW_GITHUB_AZ_CLIENT_ID"],
        "tenant": environ["AW_GITHUB_AZ_TENANT_ID"],
        "subscription": environ["AW_GITHUB_AZ_SUBSCRIPTION_ID"],
    }
    if metadata_file.exists():
        try:
            metadata = json.loads(metadata_file.read_text(encoding="utf-8"))
            refresh_after = metadata["refresh_after"]
            if (
                not isinstance(metadata, dict)
                or isinstance(refresh_after, bool)
                or not isinstance(refresh_after, (int, float))
                or metadata["identity"] != identity
                or not base.is_dir()
            ):
                raise ValueError("Invalid renewal state")
        except (ValueError, KeyError, TypeError, UnicodeDecodeError):
            raise RenewalError("The GitHub Azure CLI renewal state is invalid.") from None
        if time.time() < refresh_after:
            return base
        metadata_file.unlink()

    assertion, expires = github_assertion(environ, time.time())
    # Do not let a long-running command inherit a nearly expired cached ARM token.
    if base.exists():
        shutil.rmtree(base)
    base.mkdir(mode=0o700)
    login_env = cli_environment(environ, base)
    try:
        result = subprocess.run(
            [
                str(cli), "login", "--service-principal",
                "--username", identity["client"], "--tenant", identity["tenant"],
                "--subscription", identity["subscription"],
                "--federated-token", assertion, "--output", "none", "--only-show-errors",
            ],
            env=login_env,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=LOGIN_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise RenewalError("Azure CLI OIDC renewal timed out.") from None
    except OSError:
        raise RenewalError("Could not start Azure CLI for OIDC renewal.") from None
    if result.returncode:
        codes = sorted(set(re.findall(r"\bAADSTS\d+\b", result.stderr)))
        detail = f" ({', '.join(codes)})" if codes else ""
        raise RenewalError(
            f"Azure CLI OIDC renewal failed{detail}; check the federated credential and subscription."
        )

    now = time.time()
    if expires - now < MIN_ASSERTION_LIFETIME_SECONDS:
        raise RenewalError("The GitHub OIDC assertion expired too soon during Azure CLI renewal.")
    store_metadata(metadata_file, {
        "identity": identity,
        "refresh_after": min(now + RENEW_AFTER_SECONDS, expires - MIN_ASSERTION_LIFETIME_SECONDS),
    })
    return base


def run_az(arguments, environ):
    cli, state = settings(environ)
    with tempfile.TemporaryDirectory(prefix="az-command-", dir=state) as snapshot:
        with (state / "lock").open("a", encoding="utf-8") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            base = renew_if_needed(cli, state, environ)
            shutil.copytree(
                base, snapshot, dirs_exist_ok=True,
                ignore=shutil.ignore_patterns("commands", "logs", "telemetry", "*.lockfile"),
            )
        command_env = cli_environment(environ, snapshot)
        try:
            result = subprocess.run([str(cli), *arguments], env=command_env, check=False)
        except OSError:
            raise RenewalError("Could not start the Azure CLI command.") from None
        return result.returncode if result.returncode >= 0 else 128 - result.returncode


def cleanup(environ):
    state = Path(environ["AW_GITHUB_AZ_STATE"]).resolve()
    runner_temp = Path(environ["RUNNER_TEMP"]).resolve()
    if state.parent != runner_temp or not state.name.startswith("adventureworks-az-oidc."):
        raise RenewalError("Refusing to remove an unexpected Azure CLI session directory.")
    shutil.rmtree(state)


def main(arguments):
    try:
        if arguments == ["--cleanup"]:
            cleanup(os.environ)
            return 0
        return run_az(arguments, os.environ)
    except RenewalError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    except (OSError, KeyError) as exc:
        print(f"ERROR: Azure CLI OIDC session error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
