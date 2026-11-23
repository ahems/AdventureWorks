"""Foundry agent setup must tolerate a newly provisioned endpoint's transient failures."""
import http.server
import re
import subprocess
import threading
import unittest
from pathlib import Path

COMMON = Path(__file__).resolve().parents[2] / "scripts/utilities/agents/lib/common.sh"


def curl_options_line():
    return next(line for line in COMMON.read_text().splitlines() if line.startswith("FOUNDRY_CURL_OPTS="))


def run_curl(url, *extra):
    script = f'{curl_options_line()}\ncurl "${{FOUNDRY_CURL_OPTS[@]}}" {" ".join(extra)} -s -o /dev/null -w "%{{http_code}}" "$1"'
    return subprocess.run(["bash", "-c", script, "_", url], capture_output=True, text=True, timeout=90)


class FoundryCurlRetryTests(unittest.TestCase):
    def test_every_foundry_request_uses_retry_options(self):
        calls = re.findall(r"\$\(curl\b[^\n]*", COMMON.read_text())
        self.assertGreaterEqual(len(calls), 5)
        self.assertTrue(all('"${FOUNDRY_CURL_OPTS[@]}"' in call for call in calls), calls)

    def test_transient_server_errors_are_retried_but_client_errors_are_not(self):
        responses = {"/transient": [503, 503, 201], "/denied": [403, 201]}
        hits = {path: 0 for path in responses}

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                codes = responses[self.path]
                self.send_response(codes[min(hits[self.path], len(codes) - 1)])
                hits[self.path] += 1
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            base = f"http://127.0.0.1:{server.server_port}"
            # A zero delay keeps the test fast; curl then uses short exponential backoff.
            transient = run_curl(base + "/transient", "--retry-delay", "0", "-X", "POST", "-d", "{}")
            denied = run_curl(base + "/denied", "--retry-delay", "0", "-X", "POST", "-d", "{}")
        finally:
            server.shutdown()
        self.assertEqual((transient.stdout, hits["/transient"]), ("201", 3))
        self.assertEqual((denied.stdout, hits["/denied"]), ("403", 1))

    def test_refused_connections_are_retried(self):
        result = run_curl("http://127.0.0.1:9/", "--retry-delay", "1", "--retry", "1", "-v")
        self.assertEqual(result.stdout, "000")
        self.assertEqual(result.stderr.count("Failed to connect"), 2)


if __name__ == "__main__":
    unittest.main()
