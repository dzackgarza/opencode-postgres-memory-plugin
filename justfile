set fallback := true

# Install JavaScript dependencies
install:
    bun install

# Setup npm trusted publisher (one-time manual setup)
setup-npm-trust:
    #!/usr/bin/env bash
    set -euo pipefail
    npm trust github --repository "dzackgarza/$(basename "{{justfile_directory()}}")" --file publish.yml

# Manual publish from local (requires 2FA)
publish:
    npm publish

# Run the Bun integration suite
test *ARGS:
    #!/usr/bin/env bash
    set -euo pipefail
    rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/opencode"
    exec direnv exec {{justfile_directory()}} bun test {{ARGS}}

# Run TypeScript typecheck
typecheck:
    direnv exec {{justfile_directory()}} bunx tsc --noEmit

# Run the preferred local verification workflow
check:
    just typecheck
    just test

# Bump patch version, commit, and tag
bump-patch:
    npm version patch --no-git-tag-version
    git add package.json
    git commit -m "chore: bump version to v$(node -p 'require("./package.json").version')"
    git tag "v$(node -p 'require("./package.json").version')"

# Bump minor version, commit, and tag
bump-minor:
    npm version minor --no-git-tag-version
    git add package.json
    git commit -m "chore: bump version to v$(node -p 'require("./package.json").version')"
    git tag "v$(node -p 'require("./package.json").version')"

# Push commits and tags to trigger CI release
release: check
    git push && git push --tags

# Run the MCP server tests
mcp-test:
    uv run python -m pytest

# Run the MCP server locally
mcp-run:
    uv run opencode-memory mcp
