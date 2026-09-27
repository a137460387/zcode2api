' Launch zcode2api in the background with no console window.
' Runs start-gateway.bat from this script's own directory, so the project can
' live anywhere. Used by the zcode2api-Gateway scheduled task at logon.
'
' Note: this hides the CONSOLE window only. In headed mode (the default) the
' service still opens a VISIBLE Chrome window for the captcha farm -- that one
' is spawned by the service, not by this script, and hiding it is not possible
' from here (headless mode gets rejected by the upstream risk control with
' F011; see README). Closing that Chrome window cuts off param production.
' Keep this file ASCII-only, same reason as start-gateway.bat.
Dim fso, here
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & here & "\start-gateway.bat""", 0, False
