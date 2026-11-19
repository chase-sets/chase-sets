param(
  [Parameter(Mandatory)][ValidateSet('Create', 'VerifyRoot', 'Verify')][string]$Action,
  [Parameter(Mandatory)][string]$Path
)

$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ($Action -eq 'Create') {
  if (Test-Path -LiteralPath $Path) { throw 'Run directory already exists.' }
  $security = [Security.AccessControl.DirectorySecurity]::new()
  $security.SetOwner($sid)
  $security.SetAccessRuleProtection($true, $false)
  $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
    $sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'
  ))
  [IO.Directory]::CreateDirectory($Path, $security) | Out-Null
}

$attributes = [IO.File]::GetAttributes($Path)
if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point refused.' }
$acl = if ($attributes -band [IO.FileAttributes]::Directory) {
  [IO.Directory]::GetAccessControl($Path)
} else {
  if ($Action -ne 'Verify') { throw 'Run root must be a directory.' }
  [IO.File]::GetAccessControl($Path)
}
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if (
  $acl.GetOwner([Security.Principal.SecurityIdentifier]) -ne $sid -or
  $rules.Count -ne 1 -or $rules[0].IdentityReference -ne $sid -or
  $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne 'FullControl'
) { throw 'Only the current Windows user may access the run.' }

if ($Action -ne 'Verify' -and (
  -not $acl.AreAccessRulesProtected -or
  $rules[0].InheritanceFlags -ne 'ContainerInherit,ObjectInherit' -or
  $rules[0].PropagationFlags -ne 'None'
)) { throw 'Run directory inheritance refused.' }
