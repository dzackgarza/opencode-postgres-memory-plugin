#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "fastmcp",
# ]
# ///
"""MCP server wrapper for opencode-file-memory.

Exposes remember / list_memories / forget as MCP tools by shelling out to
the co-located cli.py for every call.  Run with:

    uv run src/mcp_server.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional

from fastmcp import FastMCP

CLI = Path(__file__).with_name("cli.py")

mcp = FastMCP("opencode-memory")


def _run(args: list[str]) -> dict:
    result = subprocess.run(
        ["uv", "run", str(CLI), *args],
        capture_output=True,
        text=True,
        env=os.environ,
    )
    text = result.stdout.strip()
    if not text:
        return {"ok": False, "stage": "cli", "message": result.stderr.strip() or "empty output"}
    return json.loads(text)


@mcp.tool()
def remember(
    content: str,
    project: Optional[str] = None,
    session_id: Optional[str] = None,
    tags: Optional[list[str]] = None,
) -> str:
    """Write a memory to the file store.

    Stores content as a YAML-headered markdown file under
    $OPENCODE_MEMORY_ROOT/{project}/{id}-{timestamp}.md and commits it to
    the memory git repo.

    Search stored memories with:
      semtools: npx -y -p @llamaindex/semtools semtools search "query" {root}/**/*.md
      keyword:  grep -rl "nginx" {root}/
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
    """Query memory metadata using SQL against an in-memory SQLite table.

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
    lines = [" | ".join(str(v) for v in row.values()) for row in rows]
    header = " | ".join(rows[0].keys())
    return "\n".join([header, *lines])


@mcp.tool()
def forget(id: str) -> str:  # noqa: A002
    """Delete a memory permanently by its ID and commit the deletion.

    Obtain the ID from list_memories or from the file frontmatter.
    Use this instead of direct file deletion to keep the git history intact.
    """
    result = _run(["forget", "--id", id])
    if not result.get("ok"):
        return f"TOOL FAILURE\n{json.dumps(result, indent=2)}"
    return f"Deleted: {result.get('id')} ({result.get('path')})"


if __name__ == "__main__":
    mcp.run()
