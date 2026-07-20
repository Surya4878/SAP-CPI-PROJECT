# Register the Windows Task Scheduler Job for SAP-CPI-Healer
# Run this script as Administrator. It will prompt for your Windows credentials
# so the task can run in the background whether you are logged in or not.

$taskName = "SAP-CPI-Healer"
$projectRoot = "C:\Users\Surya.Prakash\Documents\SAP-CPI-AI"
$wrapperScript = Join-Path $projectRoot "orchestrator\run-scheduled.cmd"

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction -Execute $wrapperScript -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -Daily -At "08:00AM"
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew -StartWhenAvailable

Write-Host "Registering task '$taskName'..."
Write-Host "A secure credential prompt will appear."
Write-Host "Enter your Windows credentials to grant the task 'Run whether user is logged on or not' rights."

# Use Get-Credential for a secure Windows-native prompt.
$cred = Get-Credential -UserName $env:USERNAME -Message "Credentials for SAP-CPI-Healer scheduled task"
$plainPassword = $cred.GetNetworkCredential().Password

Register-ScheduledTask `
  -TaskName $taskName `
  -Description "Unattended SAP-CPI healing cycle. Exits 1 on red/urgent failures." `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -User $cred.UserName `
  -Password $plainPassword | Out-Null

# Explicitly clear the plaintext password string from memory
$plainPassword = $null
$cred = $null

Write-Host "Done. You can test it by running: Start-ScheduledTask -TaskName '$taskName'"
