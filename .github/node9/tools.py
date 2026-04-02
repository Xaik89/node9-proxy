import subprocess
import shlex
import os
from node9 import protect

# In CI, GITHUB_WORKSPACE is the repo root; fall back to local "workspace/" for dev
WORKSPACE_DIR = os.environ.get("GITHUB_WORKSPACE") or os.path.abspath("workspace")

@protect("bash")
def run_bash(command: str):
    """Executes a bash command (tests, ls, etc) in the workspace."""
    try:
        result = subprocess.check_output(
            shlex.split(command),
            stderr=subprocess.STDOUT,
            cwd=WORKSPACE_DIR,
        )
        return result.decode()
    except subprocess.CalledProcessError as e:
        return f"Error: {e.output.decode()}"

@protect("filesystem")
def write_code(filename: str, content: str):
    """Overwrites a file with a fix. Node9 takes a Shadow Snapshot first."""
    path = os.path.join(WORKSPACE_DIR, filename)
    with open(path, "w") as f:
        f.write(content)
    return f"Successfully updated {filename}"

def _run_unprotected(command: str) -> str:
    """Run a bash command without node9 interception (for git setup, staging, etc.)."""
    try:
        result = subprocess.check_output(
            shlex.split(command),
            stderr=subprocess.STDOUT,
            cwd=WORKSPACE_DIR,
        )
        return result.decode()
    except subprocess.CalledProcessError as e:
        return f"Error: {e.output.decode()}"


@protect("filesystem")
def read_code(filename: str):
    """Reads the content of a file for Claude to analyze."""
    path = os.path.join(WORKSPACE_DIR, filename)
    if not os.path.exists(path):
        return "Error: File not found."
    with open(path, "r") as f:
        return f.read()
