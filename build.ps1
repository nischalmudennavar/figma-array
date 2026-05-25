# Build Script for Figma Array Plugin (Windows)

# 1. Compile TypeScript (src/code.ts -> dist/code.js)
echo "Compiling TypeScript..."
./node_modules/.bin/tsc

# 2. Copy UI (src/ui.html -> dist/ui.html)
echo "Copying UI..."
./node_modules/.bin/copyfiles -f src/ui.html dist/

echo "Build complete! Check the /dist folder."
