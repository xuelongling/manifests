@rem SPDX-License-Identifier: MIT
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

if /I "%~1"=="init" (
    set "repo_operation=init"
    goto default_worktree
)
if /I "%~1"=="sync" (
    set "repo_operation=sync"
    goto default_verify
)
goto run_repo

:default_worktree
set "repo_default=--worktree"
for %%A in (%*) do if /I "%%~A"=="--worktree" set "repo_default="
goto check_no_repo_verify

:default_verify
set "repo_default=--verify"
for %%A in (%*) do if /I "%%~A"=="--verify" set "repo_default="
for %%A in (%*) do for %%U in (--no-v --no-ve --no-ver --no-veri --no-verif --no-verify) do if /I "%%~A"=="%%U" goto reject_no_verify

:check_no_repo_verify
for %%A in (%*) do for %%U in (--no-r --no-re --no-rep --no-repo --no-repo- --no-repo-v --no-repo-ve --no-repo-ver --no-repo-veri --no-repo-verif --no-repo-verify) do if /I "%%~A"=="%%U" goto reject_no_repo_verify
if /I "%repo_operation%"=="sync" goto run_sync
goto run_repo

:reject_no_verify
>&2 echo ERROR: The tsfg bootstrap wrapper refuses --no-verify; the normative sync flow requires verification.
exit /b 2

:reject_no_repo_verify
>&2 echo ERROR: The tsfg bootstrap wrapper refuses --no-repo-verify; launcher source verification is required.
exit /b 2

:run_sync
if not exist "%CD%\.repo\manifests\bootstrap\r00.xml" goto run_repo
if not exist "%CD%\.repo\manifests\tools\verify-agent-activation.ps1" (
    >&2 echo ERROR: Agent Activation Surface verifier is missing from the selected manifest commit.
    exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CD%\.repo\manifests\tools\verify-agent-activation.ps1" -Phase pre -WorkspaceRoot "%CD%"
if errorlevel 1 exit /b 1

call python "%~dp0repo.py" %* %repo_default%
if errorlevel 1 exit /b %errorlevel%

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CD%\.repo\manifests\tools\verify-agent-activation.ps1" -Phase post -WorkspaceRoot "%CD%"
exit /b %errorlevel%

:run_repo
call python "%~dp0repo.py" %* %repo_default%

exit /b %errorlevel%
