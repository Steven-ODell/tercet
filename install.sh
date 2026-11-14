#!/bin/sh
# Installs tercet. Two methods:
#
#   sh install.sh                   download the prebuilt binary for this machine (no Bun needed),
#                                   check it against the release's SHA256SUMS, put it in
#                                   ~/.local/bin
#   sh install.sh --bun             install with Bun instead (`bun install -g github:...`)
#
# Options (or the environment variable in brackets):
#   --version vX.Y.Z   a release other than the newest         [TERCET_VERSION]
#   --dir DIR          where the binary goes (default ~/.local/bin)  [TERCET_INSTALL_DIR]
#   --bun / --binary   pick the method                          [TERCET_METHOD=bun|binary]
#
# Bun method only: TERCET_SOURCE=<spec> installs another spec, e.g. a tag:
#   TERCET_SOURCE=github:Steven-ODell/tercet#v0.1.0 sh install.sh --bun
#
# The binary method changes nothing but the one file; the Bun method changes nothing outside
# Bun's global install. A third way, from a clone, is in docs/install.md.
set -eu

repo=Steven-ODell/tercet
method=${TERCET_METHOD:-binary}
version=${TERCET_VERSION:-}
dir=${TERCET_INSTALL_DIR:-$HOME/.local/bin}
# Where release files live; a test points this at a local server.
base=${TERCET_BASE_URL:-https://github.com/$repo/releases}

usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case $1 in
    --bun) method=bun ;;
    --binary) method=binary ;;
    --version) [ $# -ge 2 ] || { echo "install: --version needs a value" >&2; exit 2; }; version=$2; shift ;;
    --dir) [ $# -ge 2 ] || { echo "install: --dir needs a value" >&2; exit 2; }; dir=$2; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install: unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done
case $method in bun|binary) ;; *) echo "install: TERCET_METHOD must be bun or binary" >&2; exit 2 ;; esac

path_note() {
  case ":$PATH:" in
    *":$1:"*)
      found=$(command -v tercet || true)
      if [ -n "$found" ] && [ "$found" != "$1/tercet" ]; then
        echo "Note: \`tercet\` on PATH is $found, which comes before $1."
      fi
      ;;
    *)
      echo "$1 is not on PATH. Add this line to your shell's rc file:"
      echo
      echo "  export PATH=\"$1:\$PATH\""
      echo
      ;;
  esac
}

fetch() { # fetch URL OUTFILE
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -q "$1" -O "$2"
  else echo "install: needs curl or wget" >&2; return 1; fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else echo "install: needs sha256sum or shasum to verify the download" >&2; return 1; fi
}

install_binary() {
  case $(uname -s) in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) echo "install: no prebuilt binary for $(uname -s); try --bun, or see docs/install.md" >&2; exit 1 ;;
  esac
  case $(uname -m) in
    x86_64|amd64) cpu=x64 ;;
    aarch64|arm64) cpu=arm64 ;;
    *) echo "install: no prebuilt binary for $(uname -m); try --bun, or see docs/install.md" >&2; exit 1 ;;
  esac
  name=tercet-$os-$cpu
  if [ -n "$version" ]; then
    case $version in v*) ;; *) version=v$version ;; esac
    url=$base/download/$version
  else
    url=$base/latest/download
  fi
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/tercet-install.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  echo "Downloading $name from $url"
  if ! fetch "$url/$name" "$tmp/$name" || ! fetch "$url/SHA256SUMS" "$tmp/SHA256SUMS"; then
    echo "install: could not download the release files." >&2
    echo "There may be no release yet or none for this platform. Use --bun, or build from a clone (docs/install.md)." >&2
    exit 1
  fi
  want=$(awk -v n="$name" '$2 == n || $2 == "*" n { print $1; exit }' "$tmp/SHA256SUMS")
  [ -n "$want" ] || { echo "install: SHA256SUMS has no line for $name" >&2; exit 1; }
  got=$(sha256_of "$tmp/$name")
  if [ "$got" != "$want" ]; then
    echo "install: checksum mismatch for $name (expected $want, got $got); nothing was installed" >&2
    exit 1
  fi
  mkdir -p "$dir"
  chmod +x "$tmp/$name"
  # Rename within the target directory so a running tercet is replaced, never half-written.
  cp "$tmp/$name" "$dir/.tercet.new"
  mv -f "$dir/.tercet.new" "$dir/tercet"
  echo
  "$dir/tercet" --version
  echo
  path_note "$dir"
  echo "Next: \`tercet doctor\` checks your server, settings and terminal; \`tercet\` starts it."
  echo "Update later with \`tercet upgrade\`."
}

install_bun() {
  source=${TERCET_SOURCE:-}
  if [ -z "$source" ]; then
    if [ -n "$version" ]; then
      case $version in v*) ;; *) version=v$version ;; esac
      source=github:$repo#$version
    else
      # Bun keeps the commit a spec first resolved to, so installing github:$repo again leaves an
      # old tercet in place. Naming main's current commit makes every run install the newest one.
      sha=$(git ls-remote "https://github.com/$repo.git" refs/heads/main 2>/dev/null | cut -f1 || true)
      if [ -z "$sha" ] && command -v curl >/dev/null 2>&1; then
        sha=$(curl -fsSL "https://api.github.com/repos/$repo/commits/main" 2>/dev/null |
          sed -n 's/^  "sha": "\([0-9a-f]\{40\}\)".*/\1/p' | head -n 1 || true)
      fi
      source=github:$repo${sha:+#$sha}
    fi
  fi

  if ! command -v bun >/dev/null 2>&1; then
    cat >&2 <<'EOF'
tercet needs Bun (https://bun.com) for this method, and `bun` is not on PATH.
Install it with:

  curl -fsSL https://bun.com/install | bash

then open a new shell (or run `exec $SHELL`) and run this script again. On macOS, Homebrew
works too: `brew install oven-sh/bun/bun`. Or skip Bun and install the binary: drop --bun.
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
  path_note "$bin_dir"
  echo "Next: \`tercet doctor\` checks your server, settings and terminal; \`tercet\` starts it."
}

if [ "$method" = bun ]; then install_bun; else install_binary; fi
