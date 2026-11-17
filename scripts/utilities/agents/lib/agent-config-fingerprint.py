#!/usr/bin/env python3
"""Fingerprint the Foundry prompt-agent provisioning sources."""

import hashlib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]


def configuration_files(root):
    agents = root / "scripts/utilities/agents"
    files = [root / "scripts/utilities/create-foundry-agents.sh"]
    files.extend(path for path in agents.rglob("*")
                 if path.is_file() and path.suffix in {".py", ".sh"})
    return sorted(files, key=lambda path: path.relative_to(root).as_posix())


def fingerprint(root, files=None):
    digest = hashlib.sha256()
    paths = files if files is not None else configuration_files(root)
    for path in sorted(paths, key=lambda item: item.relative_to(root).as_posix()):
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


if __name__ == "__main__":
    print(fingerprint(ROOT))
