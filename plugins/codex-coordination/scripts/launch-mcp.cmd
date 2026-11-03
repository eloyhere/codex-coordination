@echo off
rem ---------------------------------------------------------------------------
rem codex-coordination MCP launcher (Windows).
rem
rem Codex starts the server through cmd.exe because Node is not guaranteed to be
rem on PATH. Resolution order:
rem   1. an explicit NODE_EXE environment variable,
rem   2. `node` on PATH,
rem   3. the Node runtime bundled with the Codex desktop app,
rem   4. the standard Node.js install locations.
rem
rem Everything on stdout belongs to the MCP wire, so diagnostics go to stderr.
rem ---------------------------------------------------------------------------
setlocal EnableExtensions
set "HERE=%~dp0"
set "SERVER=%HERE%..\mcp\server.mjs"

if not exist "%SERVER%" (
  echo codex-coordination: server not found at "%SERVER%" 1>&2
  exit /b 1
)

if defined NODE_EXE if exist "%NODE_EXE%" goto run
set "NODE_EXE="

for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"

if not defined NODE_EXE if exist "%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node" (
  for /d %%D in ("%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\*") do (
    if not defined NODE_EXE if exist "%%~fD\bin\node.exe" set "NODE_EXE=%%~fD\bin\node.exe"
  )
)

if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramW6432%\nodejs\node.exe" set "NODE_EXE=%ProgramW6432%\nodejs\node.exe"

if defined NODE_EXE goto run
echo codex-coordination: node.exe not found. Install Node.js 24+ or set NODE_EXE. 1>&2
exit /b 1

:run
"%NODE_EXE%" "%SERVER%" %*
exit /b %ERRORLEVEL%
