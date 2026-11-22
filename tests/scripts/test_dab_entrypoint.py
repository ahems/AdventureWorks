"""Offline tests for the DAB container startup retry in api/entrypoint.sh."""

import os
import subprocess
from pathlib import Path

ENTRYPOINT = Path(__file__).resolve().parents[2] / "api" / "entrypoint.sh"

FAKE_DAB = """#!/bin/sh
count=$(cat "$COUNTER" 2>/dev/null || echo 0)
count=$((count + 1))
echo "$count" > "$COUNTER"
[ "$count" -ge "$SUCCEED_ON" ] && exit 0
exit 3
"""


def run_entrypoint(tmp_path: Path, succeed_on: int, deadline: int) -> tuple[subprocess.CompletedProcess, int]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake = bin_dir / "dab"
    fake.write_text(FAKE_DAB)
    fake.chmod(0o755)
    counter = tmp_path / "count"
    env = {
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "DAB_APP_DIR": str(tmp_path),
        "COUNTER": str(counter),
        "SUCCEED_ON": str(succeed_on),
        "DB_RETRY_INITIAL_SECONDS": "1",
        "DB_RETRY_MAX_SECONDS": "2",
        "DB_START_DEADLINE_SECONDS": str(deadline),
    }
    result = subprocess.run(["sh", str(ENTRYPOINT)], env=env, capture_output=True, text=True, timeout=60)
    return result, int(counter.read_text())


def test_retries_with_backoff_until_dab_starts(tmp_path):
    result, attempts = run_entrypoint(tmp_path, succeed_on=3, deadline=30)
    assert result.returncode == 0, result.stdout + result.stderr
    assert attempts == 3
    assert "retrying in 1s" in result.stdout
    assert "retrying in 2s" in result.stdout


def test_exits_non_zero_when_never_ready(tmp_path):
    result, attempts = run_entrypoint(tmp_path, succeed_on=1000, deadline=4)
    assert result.returncode == 3, result.stdout + result.stderr
    assert 1 < attempts < 5
    assert "not retrying" in result.stdout
