$WshShell = New-Object -ComObject WScript.Shell
$ProjectDirectory = $PSScriptRoot
$DesktopDirectory = [Environment]::GetFolderPath('Desktop')

$Shortcut = $WshShell.CreateShortcut((Join-Path $DesktopDirectory 'MiMo Session Manager.lnk'))
$Shortcut.TargetPath = 'cmd.exe'
$Shortcut.Arguments = "/c cd /d `"$ProjectDirectory`" && start `"`" http://127.0.0.1:3456 && node server.js"
$Shortcut.WorkingDirectory = $ProjectDirectory
$Shortcut.Description = "MiMo Code Session Manager"
$Shortcut.WindowStyle = 1
$Shortcut.Save()

Write-Host "Desktop shortcut created: MiMo Session Manager.lnk" -ForegroundColor Green
