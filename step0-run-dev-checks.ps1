$ErrorActionPreference = "Stop"

Write-Host "== STEP 0: Roo Code dev sanity checks ==" -ForegroundColor Cyan

# 1) Toolchain sanity
node -v
pnpm -v

# 2) Install dependencies (workspace root)
pnpm install

# 3) Build extension bundle once (fast sanity before launching host)
pnpm -C src bundle

# 4) Start watch tasks in separate terminals manually:
#    Terminal A: pnpm --filter @roo-code/vscode-webview dev
#    Terminal B: npx turbo watch:bundle
#    Terminal C: npx turbo watch:tsc
Write-Host "Start watchers in 3 terminals (see comments in this script)." -ForegroundColor Yellow

# 5) Open extension development host window
if (Get-Command code -ErrorAction SilentlyContinue) {
	code --extensionDevelopmentPath "$PWD/src"
} else {
	Write-Host "'code' CLI not found. Open this workspace in VS Code/Cursor and press F5 (Run Extension)." -ForegroundColor Red
}

Write-Host "If Extension Host opens and Roo icon appears, STEP 0 runtime sanity is successful." -ForegroundColor Green
