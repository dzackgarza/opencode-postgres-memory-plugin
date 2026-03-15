#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "pyyaml",
#   "typer",
# ]
# ///
"""opencode-file-memory: YAML-headered markdown memory store for OpenCode agents.

Commands:
  remember    Save a memory to the file store
  recall      Search memories semantically (via semtools)
  list        List/filter memories by scope, project, or tag
  list-files  Output memory file paths for piping
  forget      Delete a memory by ID
"""
from __future__ import annotations

import json
import os
import re
import secrets
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Optional

import typer
import yaml

app = typer.Typer(no_args_is_help=True, add_completion=False)

BUG_REPORTING_URL = "https://github.com/dzackgarza/opencode-postgres-memory-plugin/issues/new?labels=bug"

# ---------------------------------------------------------------------------
# Git helpers
# ---------------------------------------------------------------------------


def detect_git_root(cwd: Optional[str] = None) -> Optional[str]:
    """Return the absolute git root path of cwd, or None if not in a git repo."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=cwd if cwd else os.getcwd(),
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        pass
    return None


def slug_from_path(path: str) -> str:
    """Convert an absolute path to a filesystem-safe lowercase slug.

    Takes the last 3 meaningful path components (skipping 'home' and usernames
    to avoid leaking PII into directory names when the path is under /home).
    """
    parts = [p for p in Path(path).parts if p not in ("", "/")]
    # Drop leading 'home' + one-component username to get meaningful parts
    if len(parts) >= 2 and parts[0] == "home":
        parts = parts[2:]
    relevant = parts[-3:] if len(parts) >= 3 else parts
    slug = "-".join(relevant)
    slug = re.sub(r"[^a-z0-9]", "-", slug.lower())
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug or "unknown"


def ensure_memory_repo(root: Path) -> None:
    """Initialize root as a git repo if it isn't already one."""
    root.mkdir(parents=True, exist_ok=True)
    if not (root / ".git").exists():
        subprocess.run(
            ["git", "init", "--quiet"],
            cwd=root,
            capture_output=True,
            check=False,
        )
        gitignore = root / ".gitignore"
        gitignore.write_text("*.tmp\n")
        _git_commit(root, "chore: initialize memory store", allow_empty=True)


def _git_commit(root: Path, message: str, allow_empty: bool = False) -> None:
    """Best-effort: stage all changes and commit. Swallows errors silently.

    Data integrity does not depend on this succeeding — the atomic file rename
    already ensures the write landed. This adds git history as a bonus.
    """
    try:
        subprocess.run(
            ["git", "add", "-A"],
            cwd=root,
            capture_output=True,
            timeout=10,
        )
        cmd = [
            "git",
            "-c", "user.email=memory@opencode",
            "-c", "user.name=opencode-memory",
            "commit",
            "-m", message,
        ]
        if allow_empty:
            cmd.append("--allow-empty")
        subprocess.run(cmd, cwd=root, capture_output=True, timeout=10)
    except Exception:
        pass  # best-effort — file write already succeeded


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------


def resolve_memory_root(memory_root_override: Optional[str] = None) -> Path:
    """Return the memory repo root directory.

    Priority: --memory-root arg > OPENCODE_MEMORY_ROOT env > XDG default.
    The default is ~/.local/share/opencode-memory (shared across all projects).
    """
    if memory_root_override:
        return Path(memory_root_override)
    env_root = os.environ.get("OPENCODE_MEMORY_ROOT")
    if env_root:
        return Path(env_root)
    xdg_data = os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local" / "share"))
    return Path(xdg_data) / "opencode-memory"


def resolve_project_slug(
    project: Optional[str],
    cwd: Optional[str],
) -> Optional[str]:
    """Return the project slug for directory routing.

    Priority: explicit --project > git root detection from --cwd > None.
    Returns None when neither is given and no git root is found; callers
    should fall back to global scope in that case.
    """
    if project:
        return project
    git_root = detect_git_root(cwd)
    if git_root:
        return slug_from_path(git_root)
    return None


def scope_dir(root: Path, scope: Optional[str], project_slug: Optional[str]) -> Path:
    """Return the directory for a given scope and project slug.

    - scope='global': root/global/
    - scope=None (default) with project_slug: root/projects/{slug}/
    - scope=None with no slug (not in a git repo): root/global/ (fallback)
    """
    if scope == "global":
        return root / "global"
    if project_slug:
        return root / "projects" / project_slug
    # Not in a git repo and no explicit project → fall back to global
    return root / "global"


# ---------------------------------------------------------------------------
# File helpers
# ---------------------------------------------------------------------------


def gen_id() -> str:
    return "mem_" + secrets.token_urlsafe(8)


def make_filename(memory_id: str) -> str:
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{memory_id}-{ts}.md"


def write_memory_file(path: Path, frontmatter: dict, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    yaml_text = yaml.dump(
        frontmatter, default_flow_style=False, allow_unicode=True, sort_keys=True
    )
    body = f"---\n{yaml_text}---\n{content}\n"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(body, encoding="utf-8")
    tmp.replace(path)  # atomic on same filesystem (POSIX rename)


def parse_memory_file(path: Path) -> Optional[dict]:
    try:
        text = path.read_text(encoding="utf-8")
    except (IOError, OSError):
        return None
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---\n", 4)
    if end == -1:
        return None
    frontmatter_text = text[4:end]
    content = text[end + 5:]
    try:
        fm = yaml.safe_load(frontmatter_text)
    except yaml.YAMLError:
        return None
    if not isinstance(fm, dict):
        return None
    return {**fm, "content": content.strip(), "path": str(path)}


def all_memory_files(root: Path) -> list[Path]:
    if not root.exists():
        return []
    return [p for p in root.rglob("*.md") if not p.name.startswith(".")]


def scoped_memory_files(
    root: Path,
    scope: Optional[str],
    project_slug: Optional[str],
    session_id: Optional[str] = None,
) -> list[Path]:
    """Return memory files matching scope, project, and session_id filters.

    - scope='global': only root/global/*.md
    - project_slug set: only root/projects/{slug}/*.md
    - neither: all files under root
    Session_id filtering is applied as a frontmatter metadata filter on top.
    """
    if scope == "global":
        d = root / "global"
        files: list[Path] = list(d.glob("*.md")) if d.exists() else []
    elif project_slug:
        d = root / "projects" / project_slug
        files = list(d.glob("*.md")) if d.exists() else []
    else:
        files = all_memory_files(root)

    if session_id:
        filtered = []
        for f in files:
            m = parse_memory_file(f)
            if m and m.get("session_id") == session_id:
                filtered.append(f)
        return filtered
    return files


# ---------------------------------------------------------------------------
# Semtools integration
# ---------------------------------------------------------------------------


def run_semtools_search(query: str, files: list[str], top_k: int) -> list[dict]:
    """Run semtools search, trying direct binary first then npx fallback."""
    for cmd_prefix in (
        ["semtools"],
        ["npx", "--yes", "--package=@llamaindex/semtools", "semtools"],
    ):
        try:
            result = subprocess.run(
                [*cmd_prefix, "search", "--json", "--top-k", str(top_k), query, *files],
                capture_output=True,
                text=True,
                timeout=120,
            )
        except FileNotFoundError:
            continue
        if result.returncode != 0:
            stderr = result.stderr.strip()
            raise RuntimeError(
                f"semtools exited {result.returncode}: {stderr or '(no stderr)'}"
            )
        try:
            return json.loads(result.stdout).get("results", [])
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"semtools returned non-JSON: {result.stdout[:200]}") from exc

    raise RuntimeError(
        "semtools not found. Install with: cargo install semtools  or  npm install -g @llamaindex/semtools"
    )


# ---------------------------------------------------------------------------
# Output helper
# ---------------------------------------------------------------------------


def emit(payload: dict) -> None:
    print(json.dumps(payload, default=str))


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


@app.command()
def remember(
    content: Annotated[str, typer.Option("--content", help="Memory content (markdown)")],
    scope: Annotated[
        Optional[str],
        typer.Option("--scope", help="'global' to force global scope. Omit to auto-detect project from --cwd."),
    ] = None,
    project: Annotated[
        Optional[str],
        typer.Option("--project", help="Explicit project slug (overrides --cwd git detection)"),
    ] = None,
    cwd: Annotated[
        Optional[str],
        typer.Option("--cwd", help="Working directory for git root detection (default: process cwd)"),
    ] = None,
    session_id: Annotated[
        Optional[str],
        typer.Option("--session-id", help="Session ID stored as metadata for later filtering"),
    ] = None,
    tag: Annotated[
        Optional[list[str]],
        typer.Option("--tag", help="Tag (repeatable: --tag foo --tag bar)"),
    ] = None,
    metadata: Annotated[
        Optional[str],
        typer.Option("--metadata", help="JSON object for arbitrary key-value metadata"),
    ] = None,
    memory_root: Annotated[
        Optional[str],
        typer.Option("--memory-root", help="Override the memory root directory"),
    ] = None,
) -> None:
    """Write a new memory to the file store."""
    root = resolve_memory_root(memory_root)
    ensure_memory_repo(root)

    meta: dict = {}
    if metadata:
        try:
            meta = json.loads(metadata)
        except json.JSONDecodeError as exc:
            emit({"ok": False, "stage": "configuration", "message": f"Invalid --metadata JSON: {exc}"})
            raise typer.Exit(1)

    slug = resolve_project_slug(project, cwd)
    sdir = scope_dir(root, scope, slug)

    memory_id = gen_id()
    path = sdir / make_filename(memory_id)
    now = datetime.now(timezone.utc).isoformat()

    # Effective scope: global if explicitly requested or no project detected
    effective_scope = "global" if (scope == "global" or slug is None) else "project"

    frontmatter = {
        "created_at": now,
        "id": memory_id,
        "metadata": meta,
        "project": slug,
        "scope": effective_scope,
        "session_id": session_id,
        "tags": tag or [],
        "updated_at": now,
    }

    try:
        write_memory_file(path, frontmatter, content)
    except OSError as exc:
        emit({"ok": False, "stage": "write_file", "message": str(exc), "path": str(path)})
        raise typer.Exit(1)

    _git_commit(root, f"remember: add memory {memory_id}")

    emit({
        "ok": True,
        "kind": "remember",
        "id": memory_id,
        "path": str(path),
        "scope": effective_scope,
        "project": slug,
    })


@app.command()
def recall(
    query: Annotated[str, typer.Argument(help="Search query")],
    scope: Annotated[
        Optional[str],
        typer.Option("--scope", help="'global' to restrict to global memories. Omit to search project (or all)."),
    ] = None,
    project: Annotated[
        Optional[str],
        typer.Option("--project", help="Explicit project slug"),
    ] = None,
    cwd: Annotated[
        Optional[str],
        typer.Option("--cwd", help="Working directory for git root detection"),
    ] = None,
    session_id: Annotated[
        Optional[str],
        typer.Option("--session-id", help="Filter to memories with this session ID"),
    ] = None,
    limit: Annotated[int, typer.Option("--limit", help="Maximum number of results")] = 5,
    memory_root: Annotated[
        Optional[str],
        typer.Option("--memory-root", help="Override the memory root directory"),
    ] = None,
) -> None:
    """Search memories semantically using semtools."""
    root = resolve_memory_root(memory_root)
    # For reads: only derive slug when caller explicitly provides a hint.
    # Omitting both means "search all" — do not silently auto-detect from process cwd.
    slug = resolve_project_slug(project, cwd) if (project or cwd) else None
    files = scoped_memory_files(root, scope, slug, session_id)

    if not files:
        emit({"ok": True, "kind": "recall", "results": [], "count": 0})
        return

    file_strs = [str(f) for f in files]

    try:
        hits = run_semtools_search(query, file_strs, top_k=limit * 3)
    except RuntimeError as exc:
        emit({"ok": False, "stage": "semtools", "message": str(exc)})
        raise typer.Exit(1)

    best_distance: dict[str, float] = {}
    for hit in hits:
        fname = hit["filename"]
        dist = float(hit["distance"])
        if fname not in best_distance or dist < best_distance[fname]:
            best_distance[fname] = dist

    ranked = sorted(best_distance.items(), key=lambda kv: kv[1])[:limit]

    results = []
    for fname, distance in ranked:
        memory = parse_memory_file(Path(fname))
        if memory:
            results.append({**memory, "distance": distance})

    emit({"ok": True, "kind": "recall", "results": results, "count": len(results)})


@app.command(name="list")
def list_memories(
    scope: Annotated[
        Optional[str],
        typer.Option("--scope", help="'global' to list only global memories. Omit to list all or use --project."),
    ] = None,
    project: Annotated[
        Optional[str],
        typer.Option("--project", help="Restrict to memories for this project slug"),
    ] = None,
    cwd: Annotated[
        Optional[str],
        typer.Option("--cwd", help="Working directory for git root detection"),
    ] = None,
    session_id: Annotated[
        Optional[str],
        typer.Option("--session-id", help="Filter by session ID metadata"),
    ] = None,
    tag: Annotated[
        Optional[str],
        typer.Option("--tag", help="Filter by tag"),
    ] = None,
    limit: Annotated[int, typer.Option("--limit", help="Maximum results")] = 50,
    memory_root: Annotated[
        Optional[str],
        typer.Option("--memory-root", help="Override the memory root directory"),
    ] = None,
) -> None:
    """List memories with optional scope and tag filters."""
    root = resolve_memory_root(memory_root)
    # For reads: only derive slug when caller explicitly provides a hint.
    # Omitting both means "list all" — do not silently auto-detect from process cwd.
    slug = resolve_project_slug(project, cwd) if (project or cwd) else None
    files = scoped_memory_files(root, scope, slug, session_id)

    results = []
    for path in sorted(files, key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True):
        memory = parse_memory_file(path)
        if memory is None:
            continue
        if tag and tag not in (memory.get("tags") or []):
            continue
        results.append(memory)
        if len(results) >= limit:
            break

    emit({"ok": True, "kind": "list", "results": results, "count": len(results)})


@app.command(name="list-files")
def list_files(
    scope: Annotated[
        Optional[str],
        typer.Option("--scope", help="'global' to restrict to global memories"),
    ] = None,
    project: Annotated[
        Optional[str],
        typer.Option("--project", help="Restrict to a project slug"),
    ] = None,
    cwd: Annotated[
        Optional[str],
        typer.Option("--cwd", help="Working directory for git root detection"),
    ] = None,
    session_id: Annotated[
        Optional[str],
        typer.Option("--session-id", help="Filter by session ID metadata"),
    ] = None,
    tag: Annotated[
        Optional[str],
        typer.Option("--tag", help="Filter by tag"),
    ] = None,
    limit: Annotated[int, typer.Option("--limit", help="Maximum results")] = 50,
    memory_root: Annotated[
        Optional[str],
        typer.Option("--memory-root", help="Override the memory root directory"),
    ] = None,
) -> None:
    """Output memory file paths one per line for piping to other tools.

    Example: list-files --project my-app | xargs grep 'nginx'
    Example: list-files --cwd . | head -20 | xargs cat
    """
    root = resolve_memory_root(memory_root)
    slug = resolve_project_slug(project, cwd) if (project or cwd) else None
    files = scoped_memory_files(root, scope, slug, session_id)

    count = 0
    for path in sorted(files, key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True):
        if tag:
            memory = parse_memory_file(path)
            if not memory or tag not in (memory.get("tags") or []):
                continue
        print(path)
        count += 1
        if count >= limit:
            break


@app.command()
def forget(
    memory_id: Annotated[str, typer.Option("--id", help="Memory ID to delete (mem_xxx)")],
    memory_root: Annotated[
        Optional[str],
        typer.Option("--memory-root", help="Override the memory root directory"),
    ] = None,
) -> None:
    """Delete a memory by ID. Scans all memories — no project flag needed."""
    root = resolve_memory_root(memory_root)

    for path in all_memory_files(root):
        memory = parse_memory_file(path)
        if memory and memory.get("id") == memory_id:
            try:
                path.unlink()
            except OSError as exc:
                emit({
                    "ok": False,
                    "stage": "delete_file",
                    "message": str(exc),
                    "id": memory_id,
                })
                raise typer.Exit(1)
            _git_commit(root, f"forget: delete memory {memory_id}")
            emit({"ok": True, "kind": "forget", "id": memory_id, "message": f"Deleted {memory_id}"})
            return

    emit({
        "ok": False,
        "stage": "not_found",
        "message": f"No memory found with id {memory_id!r}",
        "id": memory_id,
    })
    raise typer.Exit(1)


if __name__ == "__main__":
    app()
