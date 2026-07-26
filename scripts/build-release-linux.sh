#!/usr/bin/env bash
# Build the obfuscated Plumber Linux release inside a container and copy the
# result to ./release on the host. Works from any host with Docker (including
# macOS), producing a glibc-2.31-baseline linux/amd64 binary.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root_dir="$(cd "${script_dir}/.." && pwd)"

image_tag="plumber-release:linux"
platform="linux/amd64"
out_dir="${root_dir}/release"

if ! command -v docker >/dev/null 2>&1; then
  echo "[release] docker is required but was not found on PATH." >&2
  exit 1
fi

echo "[release] building image ${image_tag} for ${platform}..."
docker build \
  --platform "${platform}" \
  -f "${root_dir}/Dockerfile.release" \
  -t "${image_tag}" \
  "${root_dir}"

mkdir -p "${out_dir}"

echo "[release] extracting release tree to ${out_dir}..."
docker run --rm \
  --platform "${platform}" \
  -v "${out_dir}:/out" \
  "${image_tag}"

echo "[release] done. Linux release available under: ${out_dir}/plumber-linux-x64"
