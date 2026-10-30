Option Explicit
Dim shell, files, directory, node, command
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
directory = files.GetParentFolderName(WScript.ScriptFullName)
node = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
shell.CurrentDirectory = directory
command = Chr(34) & node & Chr(34) & " " & Chr(34) & directory & "\server.js" & Chr(34) & " --open"
' Hide the service console; server.js opens the graphical Tmux window.
shell.Run command, 0, False
