#!/bin/sh
# Installs tercet with Bun: checks that Bun is there (and says how to get it if not), runs
# `bun install -g`, then checks that `tercet` is on PATH and prints its version.
#
#   sh install.sh                        install the latest tercet from GitHub
#   TERCET_SOURCE=<spec> sh install.sh   install another spec, e.g. a tag:
#                                        github:Steven-ODell/tercet#v0.1.0
#
# It changes nothing outside Bun's global install (`bun pm bin -g` holds the tercet link).
set -eu

source=${TERCET_SOURCE:-github:Steven-ODell/tercet}

if ! command -v bun >/dev/null 2>&1; then
  cat >&2 <<'EOF'
tercet needs Bun (https://bun.com), and `bun` is not on PATH.
Install it with:

  curl -fsSL https://bun.com/install | bash

then open a new shell (or run `exec $SHELL`) and run this script again.
On macOS, Homebrew works too: `brew install oven-sh/bun/bun`.
EOF
  exit 1
fi

echo "Installing tercet from $source with $(command -v bun) (Bun $(bun --version))"
bun install -g "$source"

bin_dir=$(bun pm bin -g 2>/dev/null || echo "${BUN_INSTALL:-$HOME/.bun}/bin")
if [ ! -x "$bin_dir/tercet" ]; then
  echo "bun install finished but there is no tercet in $bin_dir" >&2
  exit 1
fi
echo
"$bin_dir/tercet" --version
echo
case ":$PATH:" in
  *":$bin_dir:"*)
    found=$(command -v tercet || true)
    if [ "$found" != "$bin_dir/tercet" ]; then
      echo "Note: \`tercet\` on PATH is $found, which comes before $bin_dir."
    fi
    ;;
  *)
    echo "$bin_dir is not on PATH. Add this line to your shell's rc file:"
    echo
    echo "  export PATH=\"$bin_dir:\$PATH\""
    echo
    ;;
esac
echo "Next: \`tercet doctor\` checks your server, settings and terminal; \`tercet\` starts it."
