"""Remotely built services upload only their project folder, so project files must not escape it.

ACR remote builds (remoteBuild: true) and hosted-agent code packages (host: azure.ai.agent)
both build from the uploaded service folder.
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INCLUDE = re.compile(r'<(?:Compile|Content|None|ProjectReference)\s[^>]*Include="([^"]+)"')
AGENT = ROOT / "manufacturing-agent/mcp-tools/src/mcp-tools"
SHARED_TELEMETRY = ("TelemetryPrivacyProcessor.cs", "ExporterDiagnostics.cs", "SafeConsoleFormatter.cs")


def remote_build_projects():
    projects, current = [], None
    for line in (ROOT / "azure.yaml").read_text().splitlines():
        if match := re.match(r"\s+project:\s*(\S+)", line):
            current = ROOT / match.group(1)
        elif re.match(r"\s+(remoteBuild:\s*true|host:\s*azure\.ai\.agent)\s*$", line) and current:
            projects.append(current.resolve())
    return projects


class RemoteBuildContextTests(unittest.TestCase):
    def test_remote_build_projects_reference_only_files_inside_their_context(self):
        projects = remote_build_projects()
        self.assertIn((ROOT / "api-mcp").resolve(), projects)
        self.assertIn(AGENT.resolve(), projects)
        escapes = []
        for project in projects:
            for csproj in project.rglob("*.csproj"):
                if {"bin", "obj"} & set(csproj.relative_to(project).parts) or csproj.parent.name.endswith(".Tests"):
                    continue
                for include in INCLUDE.findall(csproj.read_text()):
                    target = (csproj.parent / include.replace("\\", "/")).resolve()
                    if not target.is_relative_to(project):
                        escapes.append(f"{csproj.relative_to(ROOT)} -> {include}")
        self.assertEqual(escapes, [])

    def test_hosted_agent_telemetry_copies_match_api_mcp(self):
        # Both projects are built in isolation, so the agent keeps copies that must not drift.
        for name in SHARED_TELEMETRY:
            with self.subTest(name=name):
                self.assertEqual(
                    (AGENT / "Telemetry" / name).read_bytes(),
                    (ROOT / "api-mcp/AdventureWorks/Telemetry" / name).read_bytes(),
                )


if __name__ == "__main__":
    unittest.main()
