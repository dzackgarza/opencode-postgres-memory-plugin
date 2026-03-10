
# Setup npm trusted publisher (one-time manual setup)
setup-npm-trust:
    npm trust github --repository dzackgarza/{{file_stem(justfile_directory())}} --file publish.yml

# Manual publish from local (requires 2FA)
publish:
    npm publish
