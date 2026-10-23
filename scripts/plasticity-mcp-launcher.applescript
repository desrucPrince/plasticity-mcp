-- Opens Plasticity with loopback CDP via plasticity-mcp's launcher. Never quits or restarts Plasticity.
set nodeBin to (POSIX path of (path to home folder)) & ".nvm/versions/node/v24.21.0/bin/node"
set repo to (POSIX path of (path to home folder)) & "Projects/plasticity-mcp"
try
	do shell script "cd " & quoted form of repo & " && " & quoted form of nodeBin & " scripts/start-plasticity.ts 2>&1"
	tell application "Plasticity" to activate
on error errMsg
	if errMsg contains "running without MCP access" then
		display dialog "Plasticity is already open without MCP access." & return & return & "Save your work, quit Plasticity, then open Plasticity MCP again." buttons {"OK"} default button "OK" with title "Plasticity MCP" with icon caution
	else
		display dialog "Could not start Plasticity with MCP access:" & return & return & errMsg buttons {"OK"} default button "OK" with title "Plasticity MCP" with icon stop
	end if
end try
