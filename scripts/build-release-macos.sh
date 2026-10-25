#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[release] Build the macOS executable on macOS." >&2
  exit 1
fi

case "$(uname -m)" in
  arm64)
    arch="arm64"
    node_checksum="c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428"
    ;;
  x86_64)
    arch="x64"
    node_checksum="efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819"
    ;;
  *)
    echo "[release] Unsupported macOS architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

for tool in curl shasum tar codesign otool; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "[release] Required tool not found: $tool" >&2
    exit 1
  fi
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root_dir="$(cd "${script_dir}/.." && pwd)"
release_root="${root_dir}/release"
cache_dir="${release_root}/.cache"
node_version="v22.23.4"
node_name="node-${node_version}-darwin-${arch}"
node_archive="${cache_dir}/${node_name}.tar.gz"
runtime_dir="${cache_dir}/${node_name}"

mkdir -p "$cache_dir"
if [[ ! -f "$node_archive" ]]; then
  echo "[release] Downloading the official Node.js ${node_version} runtime..."
  curl --fail --location --retry 3 \
    "https://nodejs.org/dist/${node_version}/${node_name}.tar.gz" \
    --output "${node_archive}.part"
  mv "${node_archive}.part" "$node_archive"
fi
printf '%s  %s\n' "$node_checksum" "$node_archive" | shasum -a 256 -c -
tar -xzf "$node_archive" -C "$cache_dir"
export PATH="${runtime_dir}/bin:${PATH}"

if otool -L "${runtime_dir}/bin/node" | tail -n +2 | awk '{print $1}' | grep -Ev '^(/usr/lib/|/System/Library/)' ; then
  echo "[release] Node.js has non-system dynamic library dependencies." >&2
  exit 1
fi

cd "$root_dir"
echo "[release] Installing locked dependencies with Node.js $(node --version)..."
npm_config_nodedir="$runtime_dir" npm ci --cache "${cache_dir}/npm" --no-audit --no-fund
npm run release:obfuscated

release_dir="${release_root}/plumber-macos-${arch}"
codesign --verify --strict "${release_dir}/plumber"
cp "${runtime_dir}/LICENSE" "${release_dir}/NODE-LICENSE.txt"
archive_name="plumber-macos-${arch}.tar.gz"
tar -czf "${release_root}/${archive_name}" -C "$release_root" "plumber-macos-${arch}"
(cd "$release_root" && shasum -a 256 "$archive_name" > "${archive_name}.sha256")

echo "[release] Executable: release/plumber-macos-${arch}/plumber"
echo "[release] Portable archive: release/${archive_name}"
echo "[release] Configure .env or WEBTERM_PASSWORD, then run ./plumber. No installation required."
