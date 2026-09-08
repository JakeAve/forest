#!/bin/sh
# Regenerates png/ and forest.icns from icon.svg. macOS only (iconutil).
set -e
cd "$(dirname "$0")"
CHROME=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
[ -x "$CHROME" ] || { echo "set CHROME to a Chrome binary" >&2; exit 1; }

rm -rf png forest.iconset && mkdir -p png forest.iconset
trap 'rm -f .render.html' EXIT
for s in 16 32 64 128 256 512 1024; do
  printf '<!doctype html><meta charset=utf-8><style>html,body{margin:0}img{display:block;width:%spx;height:%spx}</style><img src="icon.svg">' "$s" "$s" > .render.html
  "$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --default-background-color=00000000 --window-size=$s,$s \
    --screenshot="png/icon-$s.png" "file://$PWD/.render.html" 2>/dev/null
done

for pair in "16 16x16" "32 16x16@2x" "32 32x32" "64 32x32@2x" \
            "128 128x128" "256 128x128@2x" "256 256x256" "512 256x256@2x" \
            "512 512x512" "1024 512x512@2x"; do
  set -- $pair
  cp "png/icon-$1.png" "forest.iconset/icon_$2.png"
done
iconutil -c icns -o forest.icns forest.iconset
rm -rf forest.iconset
echo "icons: $(ls png | tr '\n' ' ')forest.icns"
