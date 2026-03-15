#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "asyncpg>=0.29.0",
#   "typer>=0.12.3",
# ]
# ///

from __future__ import annotations

import asyncio
import json
import os
import urllib.parse
from typing import Any

import asyncpg
import typer

app = typer.Typer(
    add_completion=False,
    no_args_is_help=True,
    help=(
        "Postgres memory CLI for OpenCode memory storage.\n\n"
        "Start with `doctor` to verify configuration, then use `bootstrap` and `query`."
    ),
)

DATABASE_URL_ENV = "POSTGRES_MEMORY_DATABASE_URL"


class ToolFailureError(Exception):
    def __init__(
        self,
        *,
        stage: str,
        message: str,
        detail: str | None = None,
    ) -> None:
        super().__init__(message)
        self.stage = stage
        self.message = message
        self.detail = detail


def redact_url(database_url: str) -> str:
    if not database_url:
        return ""
    try:
        parsed = urllib.parse.urlsplit(database_url)
    except Exception:
        return database_url

    netloc = parsed.hostname or ""
    if parsed.username:
        username = urllib.parse.quote(parsed.username, safe="")
        if parsed.password is not None:
            netloc = f"{username}:***@{netloc}"
        else:
            netloc = f"{username}@{netloc}"
    if parsed.port is not None:
        netloc = f"{netloc}:{parsed.port}"
    return urllib.parse.urlunsplit(
        (
            parsed.scheme,
            netloc,
            parsed.path,
            parsed.query,
            parsed.fragment,
        )
    )


def build_postgres_url_from_env(env: dict[str, str]) -> str | None:
    host = env.get("PGHOST", "").strip()
    user = env.get("PGUSER", "").strip()
    database = env.get("PGDATABASE", "").strip()
    if not host or not user or not database:
        return None

    scheme = "postgresqls" if env.get("PGSSLMODE", "").strip() == "require" else "postgresql"
    url = urllib.parse.urlsplit(f"{scheme}://placeholder")

    password = env.get("PGPASSWORD", "")
    quoted_user = urllib.parse.quote(user, safe="")
    quoted_password = urllib.parse.quote(password, safe="")
    host_and_port = host
    port = env.get("PGPORT", "").strip()
    if port:
        host_and_port = f"{host}:{port}"

    netloc = (
        f"{quoted_user}:{quoted_password}@{host_and_port}"
        if password
        else f"{quoted_user}@{host_and_port}"
    )
    query = ""
    sslmode = env.get("PGSSLMODE", "").strip()
    if sslmode:
        query = urllib.parse.urlencode({"sslmode": sslmode})

    return urllib.parse.urlunsplit((url.scheme, netloc, f"/{database}", query, ""))


def resolve_database_url(explicit: str | None, env: dict[str, str]) -> str:
    value = (
        (explicit or "").strip()
        or env.get(DATABASE_URL_ENV, "").strip()
        or env.get("DATABASE_URL", "").strip()
    )
    if value:
        return value

    built = build_postgres_url_from_env(env)
    if built:
        return built

    raise ToolFailureError(
        stage="configuration",
        message=(
            f"No PostgreSQL connection details were configured. Set {DATABASE_URL_ENV}, "
            "DATABASE_URL, or PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE."
        ),
    )


def query_returns_rows(sql_input: str) -> bool:
    stripped = sql_input.lstrip()
    upper = stripped.upper()
    if " RETURNING " in upper:
        return True
    return upper.startswith(("SELECT", "WITH", "SHOW", "EXPLAIN", "VALUES"))


async def ensure_schema(conn: asyncpg.Connection) -> None:
    try:
        await conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
    except asyncpg.PostgresError as error:
        raise ToolFailureError(
            stage="extension_bootstrap",
            message=(
                "The PostgreSQL server does not have a working pgvector extension. "
                "Install or enable pgvector before continuing."
            ),
            detail=f"{error}\nSQLSTATE: {getattr(error, 'sqlstate', None)}",
        ) from error

    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS memories (
            id BIGSERIAL PRIMARY KEY,
            scope TEXT NOT NULL DEFAULT 'session',
            session_id TEXT,
            content TEXT NOT NULL,
            embedding VECTOR(1536),
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            project_name TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )

    await conn.execute("ALTER TABLE memories ADD COLUMN IF NOT EXISTS scope TEXT DEFAULT 'session'")
    await conn.execute("ALTER TABLE memories ADD COLUMN IF NOT EXISTS session_id TEXT")
    await conn.execute("ALTER TABLE memories ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb")
    await conn.execute("ALTER TABLE memories ADD COLUMN IF NOT EXISTS project_name TEXT")
    await conn.execute(
        "ALTER TABLE memories ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP"
    )
    await conn.execute(
        "ALTER TABLE memories ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP"
    )

    embedding_info = await conn.fetchrow(
        """
        SELECT data_type, udt_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'memories'
          AND column_name = 'embedding'
        """
    )
    if embedding_info is None:
        await conn.execute("ALTER TABLE memories ADD COLUMN embedding VECTOR(1536)")
    elif embedding_info["udt_name"] != "vector":
        raise ToolFailureError(
            stage="schema_bootstrap",
            message=(
                "Existing memories.embedding column is not pgvector. "
                "Manual migration is required before this CLI can run."
            ),
            detail=f"Found {embedding_info['udt_name']!r}; expected 'vector'.",
        )

    await conn.execute("UPDATE memories SET scope = 'session' WHERE scope IS NULL")
    await conn.execute("ALTER TABLE memories ALTER COLUMN scope SET DEFAULT 'session'")
    await conn.execute("ALTER TABLE memories ALTER COLUMN scope SET NOT NULL")

    await conn.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM pg_constraint
                WHERE conname = 'memories_scope_check'
            ) THEN
                ALTER TABLE memories
                ADD CONSTRAINT memories_scope_check
                CHECK (scope IN ('session', 'global'));
            END IF;
        END
        $$;
        """
    )
    await conn.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM pg_constraint
                WHERE conname = 'memories_scope_session_check'
            ) THEN
                ALTER TABLE memories
                ADD CONSTRAINT memories_scope_session_check
                CHECK (
                    (scope = 'global' AND session_id IS NULL)
                    OR (scope = 'session' AND session_id IS NOT NULL)
                );
            END IF;
        END
        $$;
        """
    )

    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_memories_project_scope_session ON memories (project_name, scope, session_id)"
    )
    await conn.execute("CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories (created_at DESC)")
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_memories_embedding_hnsw ON memories USING hnsw (embedding vector_l2_ops)"
    )


def classify_runtime_stage(detail: str) -> str:
    lowered = detail.lower()
    if "password authentication failed" in lowered or "peer authentication failed" in lowered:
        return "database_authentication"
    if "does not exist" in lowered or "connection refused" in lowered or "connect call failed" in lowered:
        return "database_connection"
    if "memories.embedding" in lowered and "type" in lowered:
        return "schema_bootstrap"
    return "database_runtime"


def emit_json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, default=str))


def render_text(payload: dict[str, Any]) -> str:
    if payload.get("ok"):
        if payload.get("kind") == "rows":
            return json.dumps(payload.get("rows", []), indent=2, default=str)
        if payload.get("kind") == "command":
            return str(payload.get("commandTag", ""))
        if payload.get("kind") == "bootstrap":
            return str(payload.get("message", "Schema bootstrap complete."))
        if payload.get("kind") == "doctor":
            checks = payload.get("checks", {})
            lines = ["DOCTOR REPORT", f"database_url: {payload.get('databaseUrl', '')}"]
            for name, state in checks.items():
                lines.append(f"{name}: {state}")
            return "\n".join(lines)
        return json.dumps(payload, indent=2, default=str)

    failure_kind = payload.get("failureKind")
    if failure_kind == "query_failure":
        lines = [
            "QUERY FAILURE",
            f"message: {payload.get('message', '')}",
            f"sql: {payload.get('sql', '')}",
        ]
        for key in ("code", "detail", "hint", "position", "where"):
            if payload.get(key) not in (None, ""):
                lines.append(f"{key}: {payload[key]}")
        return "\n".join(lines)

    lines = [
        "TOOL FAILURE",
        f"stage: {payload.get('stage', '')}",
        f"message: {payload.get('message', '')}",
        f"database_url: {payload.get('databaseUrl', '')}",
    ]
    if payload.get("sql"):
        lines.append(f"sql: {payload['sql']}")
    if payload.get("detail"):
        lines.append(f"detail: {payload['detail']}")
    return "\n".join(lines)


def emit(payload: dict[str, Any], output: str) -> None:
    if output == "json":
        emit_json(payload)
    else:
        print(render_text(payload))


def tool_failure_payload(
    stage: str,
    message: str,
    database_url: str,
    sql: str,
    detail: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "ok": False,
        "failureKind": "tool_failure",
        "stage": stage,
        "message": message,
        "databaseUrl": redact_url(database_url),
        "sql": sql,
    }
    if detail:
        payload["detail"] = detail
    return payload


async def run_query(sql: str, database_url: str) -> dict[str, Any]:
    conn: asyncpg.Connection | None = None
    try:
        conn = await asyncpg.connect(database_url)
        await ensure_schema(conn)

        try:
            if query_returns_rows(sql):
                rows = await conn.fetch(sql)
                return {
                    "ok": True,
                    "kind": "rows",
                    "rowCount": len(rows),
                    "rows": [dict(row) for row in rows],
                }

            return {
                "ok": True,
                "kind": "command",
                "commandTag": await conn.execute(sql),
            }
        except asyncpg.PostgresError as error:
            return {
                "ok": False,
                "failureKind": "query_failure",
                "message": str(error),
                "code": getattr(error, "sqlstate", None),
                "detail": getattr(error, "detail", None),
                "hint": getattr(error, "hint", None),
                "position": getattr(error, "position", None),
                "where": getattr(error, "where", None),
                "sql": sql,
            }
    except ToolFailureError as error:
        return tool_failure_payload(error.stage, error.message, database_url, sql, error.detail)
    except Exception as error:  # noqa: BLE001
        detail = str(error)
        return tool_failure_payload(classify_runtime_stage(detail), detail, database_url, sql, detail)
    finally:
        if conn is not None:
            await conn.close()


@app.command(
    help=(
        "Run a raw SQL statement against the canonical memories table.\n\n"
        "This command bootstraps schema/indexes before execution."
    )
)
def query(
    sql: str = typer.Option(..., "--sql", help="Raw PostgreSQL SQL to execute."),
    database_url: str | None = typer.Option(
        None,
        "--database-url",
        help=(
            f"Database URL override. Defaults to {DATABASE_URL_ENV}, DATABASE_URL, "
            "or PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE."
        ),
    ),
    output: str = typer.Option("text", "--output", help="Output format: text or json."),
) -> None:
    if output not in {"text", "json"}:
        raise typer.BadParameter("--output must be one of: text, json")

    if not sql.strip():
        payload = tool_failure_payload("request_parse", "SQL must be a non-empty string.", "", "")
        emit(payload, output)
        raise typer.Exit(code=1)

    try:
        resolved_database_url = resolve_database_url(database_url, dict(os.environ))
    except ToolFailureError as error:
        payload = tool_failure_payload(error.stage, error.message, "", sql, error.detail)
        emit(payload, output)
        raise typer.Exit(code=1)

    payload = _run_async(run_query(sql=sql, database_url=resolved_database_url))
    emit(payload, output)
    if not payload.get("ok", False):
        raise typer.Exit(code=1)


@app.command(
    help=(
        "Create/repair the canonical memories schema and indexes without running a query.\n\n"
        "Use this during environment setup or CI smoke checks."
    )
)
def bootstrap(
    database_url: str | None = typer.Option(
        None,
        "--database-url",
        help="Database URL override. Uses the same environment fallback as other commands.",
    ),
    output: str = typer.Option("text", "--output", help="Output format: text or json."),
) -> None:
    if output not in {"text", "json"}:
        raise typer.BadParameter("--output must be one of: text, json")

    sql = "-- bootstrap --"

    try:
        resolved_database_url = resolve_database_url(database_url, dict(os.environ))
    except ToolFailureError as error:
        payload = tool_failure_payload(error.stage, error.message, "", sql, error.detail)
        emit(payload, output)
        raise typer.Exit(code=1)

    async def bootstrap_impl() -> dict[str, Any]:
        conn: asyncpg.Connection | None = None
        try:
            conn = await asyncpg.connect(resolved_database_url)
            await ensure_schema(conn)
            return {
                "ok": True,
                "kind": "bootstrap",
                "message": "Schema and indexes are ready.",
                "databaseUrl": redact_url(resolved_database_url),
            }
        except ToolFailureError as error:
            return tool_failure_payload(error.stage, error.message, resolved_database_url, sql, error.detail)
        except Exception as error:  # noqa: BLE001
            detail = str(error)
            return tool_failure_payload(classify_runtime_stage(detail), detail, resolved_database_url, sql, detail)
        finally:
            if conn is not None:
                await conn.close()

    payload = _run_async(bootstrap_impl())
    emit(payload, output)
    if not payload.get("ok", False):
        raise typer.Exit(code=1)


@app.command(
    help=(
        "Run environment diagnostics for database connectivity and schema assumptions.\n\n"
        "Use this first when setup fails."
    )
)
def doctor(
    database_url: str | None = typer.Option(
        None,
        "--database-url",
        help="Database URL override. Uses the same environment fallback as other commands.",
    ),
    output: str = typer.Option("text", "--output", help="Output format: text or json."),
) -> None:
    if output not in {"text", "json"}:
        raise typer.BadParameter("--output must be one of: text, json")

    try:
        resolved_database_url = resolve_database_url(database_url, dict(os.environ))
    except ToolFailureError as error:
        payload = tool_failure_payload(error.stage, error.message, "", "-- doctor --", error.detail)
        emit(payload, output)
        raise typer.Exit(code=1)

    async def doctor_impl() -> dict[str, Any]:
        conn: asyncpg.Connection | None = None
        checks: dict[str, str] = {
            "connect": "pending",
            "pgvector_extension": "pending",
            "memories_table": "pending",
            "embedding_column": "pending",
        }

        try:
            conn = await asyncpg.connect(resolved_database_url)
            checks["connect"] = "ok"

            extension = await conn.fetchrow(
                "SELECT extname FROM pg_extension WHERE extname = 'vector'"
            )
            checks["pgvector_extension"] = "ok" if extension else "missing"

            table_exists = await conn.fetchval("SELECT to_regclass('public.memories') IS NOT NULL")
            checks["memories_table"] = "ok" if table_exists else "missing"

            if table_exists:
                embedding_info = await conn.fetchrow(
                    """
                    SELECT udt_name
                    FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = 'memories'
                      AND column_name = 'embedding'
                    """
                )
                if embedding_info is None:
                    checks["embedding_column"] = "missing"
                elif embedding_info["udt_name"] == "vector":
                    checks["embedding_column"] = "ok"
                else:
                    checks["embedding_column"] = f"unexpected:{embedding_info['udt_name']}"
            else:
                checks["embedding_column"] = "skipped"

            ok = all(state == "ok" for state in checks.values())
            return {
                "ok": ok,
                "kind": "doctor",
                "databaseUrl": redact_url(resolved_database_url),
                "checks": checks,
                "message": "healthy" if ok else "doctor found setup issues",
            }
        except Exception as error:  # noqa: BLE001
            detail = str(error)
            payload = tool_failure_payload(
                classify_runtime_stage(detail),
                detail,
                resolved_database_url,
                "-- doctor --",
                detail,
            )
            payload["checks"] = checks
            return payload
        finally:
            if conn is not None:
                await conn.close()

    payload = _run_async(doctor_impl())
    emit(payload, output)
    if not payload.get("ok", False):
        raise typer.Exit(code=1)


def _run_async(awaitable: Any) -> Any:
    return asyncio.run(awaitable)


def main() -> None:
    app()


if __name__ == "__main__":
    main()
