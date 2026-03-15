# Install JavaScript dependencies
install:
    bun install

# Show standalone CLI help
cli-help:
    direnv exec {{justfile_directory()}} uv run --script src/postgres_memory_cli.py --help

# Run standalone CLI diagnostics
cli-doctor:
    direnv exec {{justfile_directory()}} uv run --script src/postgres_memory_cli.py doctor

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
