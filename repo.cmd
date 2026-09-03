@echo off
setlocal EnableExtensions DisableDelayedExpansion

if not exist "%~dp0repo.py" (
    >&2 echo ERROR: repo.py is missing next to repo.cmd. Repeat the verified manual installation from the Manifest Repository README.
    exit /b 2
)

call python --version >nul 2>&1
if errorlevel 1 (
    >&2 echo ERROR: Python 3 is required on PATH before repo.cmd can run.
    exit /b 2
)

if /I "%~1"=="init" goto default_worktree
if /I "%~1"=="sync" goto default_verify
goto run_repo

:default_worktree
set "repo_default=--worktree"
for %%A in (%*) do if /I "%%~A"=="--worktree" set "repo_default="
for %%A in (%*) do if /I "%%~A"=="--no-repo-verify" goto reject_no_repo_verify
goto run_repo

:default_verify
set "repo_default=--verify"
for %%A in (%*) do if /I "%%~A"=="--verify" set "repo_default="
for %%A in (%*) do if /I "%%~A"=="--no-verify" goto reject_no_verify
for %%A in (%*) do if /I "%%~A"=="--no-repo-verify" goto reject_no_repo_verify
goto run_repo

:reject_no_verify
>&2 echo ERROR: The tsfg bootstrap wrapper refuses --no-verify; the normative sync flow requires verification.
exit /b 2

:reject_no_repo_verify
>&2 echo ERROR: The tsfg bootstrap wrapper refuses --no-repo-verify; launcher source verification is required.
exit /b 2

:run_repo
call python "%~dp0repo.py" %* %repo_default%

exit /b %errorlevel%
