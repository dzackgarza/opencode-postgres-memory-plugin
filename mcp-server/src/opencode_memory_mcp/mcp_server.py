#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "fastmcp",
# ]
# ///
"""FastMCP wrapper for opencode-file-memory.

Exposes remember / list_memories / forget as MCP tools by shelling out to
the co-located cli.py for every call.
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Optional

from fastmcp import FastMCP

# Path to the canonical CLI relative to this script
CLI = Path(__file__).parent.parent.parent.parent / "src" / "cli.py"

mcp = FastMCP("opencode-memory")


def _run(args: list[str]) -> dict:
    """Run the canonical CLI and return the JSON result."""
    try:
        result = subprocess.run(
            ["uv", "run", str(CLI), *args],
            capture_output=True,
            text=True,
            env=os.environ,
        )
        text = result.stdout.strip()
        if not text:
            return {
                "ok": False,
                "stage": "cli",
                "message": result.stderr.strip() or "empty output",
            }
        return json.loads(text)
    except Exception as exc:
        return {"ok": False, "stage": "mcp-wrapper", "message": str(exc)}


@mcp.tool()
def remember(
    content: str,
    project: Optional[str] = None,
    session_id: Optional[str] = None,
    tags: Optional[list[str]] = None,
) -> str:
    """Use when you need to save a memory to the persistent store.

    Stores content as a YAML-headered markdown file.
    The memory is automatically committed to a git repository for versioning.
    """
    args = ["remember", "--content", content]
    if project:
        args += ["--project", project]
    if session_id:
        args += ["--session-id", session_id]
    for tag in tags or []:
        args += ["--tag", tag]

    result = _run(args)
    if not result.get("ok"):
        return f"TOOL FAILURE\n{json.dumps(result, indent=2)}"
    return f"Saved: {result['id']} → {result['path']}"


@mcp.tool()
def list_memories(sql: str) -> str:
    """Use when you need to query memory metadata using SQL.

    Schema:
      CREATE TABLE memories (
        id         TEXT,
        path       TEXT,
        project    TEXT,
        session_id TEXT,
        tags       TEXT,   -- JSON array
        mtime      TEXT    -- ISO 8601
      )

    Accepts any standard SQL SELECT. The table is read-only.
    """
    result = _run(["list", "--sql", sql])
    if not result.get("ok"):
        return f"TOOL FAILURE\n{json.dumps(result, indent=2)}"
    rows = result.get("results", [])
    if not rows:
        return "0 results"
    
    # Return a formatted string for better agent readability
    header = list(rows[0].keys())
    lines = [" | ".join(header)]
    for row in rows:
        lines.append(" | ".join(str(row.get(col)) for col in header))
    return "\n".join(lines)


@mcp.tool()
def forget(id: str) -> str:  # noqa: A002
    """Use when you need to delete a memory permanently by its ID.

    The deletion is committed to the git repository.
    """
    result = _run(["forget", "--id", id])
    if not result.get("ok"):
        return f"TOOL FAILURE\n{json.dumps(result, indent=2)}"
    return f"Deleted: {result.get('id')} ({result.get('path')})"


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
