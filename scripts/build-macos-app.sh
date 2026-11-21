#!/usr/bin/env bash
set -euo pipefail

# Castora Pro — Repeatable macOS .app packaging & signing script
# Preserves bundle ID (com.pratyushsharma.castorapro) and embeds CastoraPro.entitlements.
# Defaults to ad-hoc local development signing ("-") unless CODESIGN_IDENTITY is provided.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MACOS_DIR="$REPO_ROOT/apps/macos"
RESOURCES_DIR="$MACOS_DIR/CastoraPro/Resources"
INFO_PLIST_SRC="$RESOURCES_DIR/Info.plist"
ENTITLEMENTS_SRC="$RESOURCES_DIR/CastoraPro.entitlements"
ASSETS_SRC="$RESOURCES_DIR/Assets.xcassets"

EXECUTABLE_NAME="CastoraPro"
BUNDLE_ID="${CASTORA_BUNDLE_ID:-com.pratyushsharma.castorapro}"
BUILD_CONFIGURATION="${BUILD_CONFIGURATION:-debug}"
CODESIGN_IDENTITY="${CODESIGN_IDENTITY:--}"
APP_BUNDLE="${OUTPUT_APP_PATH:-$MACOS_DIR/.build/CastoraPro.app}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: scripts/build-macos-app.sh must be run on macOS (detected $(uname -s))." >&2
  exit 1
fi

for required_cmd in swift codesign plutil sed; do
  if ! command -v "$required_cmd" >/dev/null 2>&1; then
    echo "Error: required macOS tool '$required_cmd' was not found in PATH." >&2
    exit 1
  fi
done

if [[ ! -f "$INFO_PLIST_SRC" ]]; then
  echo "Error: Info.plist not found at $INFO_PLIST_SRC" >&2
  exit 1
fi

if [[ ! -f "$ENTITLEMENTS_SRC" ]]; then
  echo "Error: entitlements file not found at $ENTITLEMENTS_SRC" >&2
  exit 1
fi

echo "==> Validating entitlements and source Info.plist..."
plutil -lint "$ENTITLEMENTS_SRC"
plutil -lint "$INFO_PLIST_SRC"

echo "==> Building Swift executable ($BUILD_CONFIGURATION)..."
swift build --package-path "$MACOS_DIR" -c "$BUILD_CONFIGURATION" --product "$EXECUTABLE_NAME"

BIN_DIR="$(swift build --package-path "$MACOS_DIR" -c "$BUILD_CONFIGURATION" --show-bin-path)"
BUILT_BINARY="$BIN_DIR/$EXECUTABLE_NAME"

if [[ ! -x "$BUILT_BINARY" ]]; then
  echo "Error: compiled executable not found at $BUILT_BINARY" >&2
  exit 1
fi

echo "==> Assembling app bundle at $APP_BUNDLE..."
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_BUNDLE/Contents/Resources"

cp "$BUILT_BINARY" "$APP_BUNDLE/Contents/MacOS/$EXECUTABLE_NAME"
chmod 755 "$APP_BUNDLE/Contents/MacOS/$EXECUTABLE_NAME"

printf 'APPL????' > "$APP_BUNDLE/Contents/PkgInfo"

# Substitute Xcode Info.plist build-setting variables for SwiftPM bundle packaging.
sed \
  -e 's/\$(DEVELOPMENT_LANGUAGE)/en/g' \
  -e "s/\$(EXECUTABLE_NAME)/$EXECUTABLE_NAME/g" \
  -e "s/\$(PRODUCT_BUNDLE_IDENTIFIER)/$BUNDLE_ID/g" \
  "$INFO_PLIST_SRC" > "$APP_BUNDLE/Contents/Info.plist"

plutil -lint "$APP_BUNDLE/Contents/Info.plist"

ACTUAL_BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP_BUNDLE/Contents/Info.plist")"
if [[ "$ACTUAL_BUNDLE_ID" != "$BUNDLE_ID" ]]; then
  echo "Error: CFBundleIdentifier mismatch ($ACTUAL_BUNDLE_ID != $BUNDLE_ID)" >&2
  exit 1
fi

if [[ -d "$ASSETS_SRC" ]]; then
  cp -R "$ASSETS_SRC" "$APP_BUNDLE/Contents/Resources/"
fi

echo "==> Signing $APP_BUNDLE with identity '$CODESIGN_IDENTITY' and entitlements..."
if [[ "$CODESIGN_IDENTITY" == "-" ]]; then
  echo "    Note: Using ad-hoc signing ('-') for local development."
  echo "    For stable TCC Screen Recording identity across rebuilds or distribution,"
  echo "    re-run with CODESIGN_IDENTITY='Apple Development: Your Name (TEAMID)'."
  codesign \
    --force \
    --sign - \
    --identifier "$BUNDLE_ID" \
    --entitlements "$ENTITLEMENTS_SRC" \
    --timestamp=none \
    "$APP_BUNDLE"
else
  codesign \
    --force \
    --sign "$CODESIGN_IDENTITY" \
    --identifier "$BUNDLE_ID" \
    --entitlements "$ENTITLEMENTS_SRC" \
    --options runtime \
    "$APP_BUNDLE"
fi

echo "==> Verifying code signature..."
codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"

echo "==> Inspecting bundle signature metadata..."
codesign -dv --verbose=2 "$APP_BUNDLE" 2>&1

echo "==> Inspecting embedded entitlements..."
EMBEDDED_ENTITLEMENTS="$(codesign -d --entitlements :- "$APP_BUNDLE" 2>&1)"
echo "$EMBEDDED_ENTITLEMENTS"

if ! grep -q "com.apple.security.app-sandbox" <<<"$EMBEDDED_ENTITLEMENTS"; then
  echo "Error: expected embedded entitlement com.apple.security.app-sandbox is missing!" >&2
  exit 1
fi

echo ""
echo "Packaged successfully: $APP_BUNDLE"
echo "Launch GUI app:        open \"$APP_BUNDLE\""
echo "Run with stdout logs:  \"$APP_BUNDLE/Contents/MacOS/$EXECUTABLE_NAME\""
