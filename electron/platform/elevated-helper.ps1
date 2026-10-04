param(
  [Parameter(Mandatory = $true)][ValidateSet('read-env', 'read-state', 'write-state', 'path-change', 'env-change', 'restore-env', 'commit-directory', 'remove-directory', 'manager-update', 'manager-install', 'manager-uninstall', 'run-installer', 'maven-settings')][string]$Action,
  [Parameter(Mandatory = $true)][string]$Payload,
  [Parameter(Mandatory = $true)][string]$ResultFile
)

$ErrorActionPreference = 'Stop'

function Write-Result($success, $value, $message) {
  $result = @{ ok = $success; value = $value; error = $message } | ConvertTo-Json -Depth 12 -Compress
  [System.IO.File]::WriteAllText($ResultFile, $result, [System.Text.UTF8Encoding]::new($false))
}

function Get-RegistryKey([string]$scope, [bool]$writable = $true) {
  if ($scope -eq 'user') {
    return [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $writable)
  }
  if ($scope -eq 'system') {
    return [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment', $writable)
  }
  throw 'Invalid environment scope'
}

function Read-Value($key, [string]$name) {
  $exists = $key.GetValueNames() -contains $name
  if (!$exists) { return @{ exists = $false; value = ''; kind = 'ExpandString' } }
  $value = [string]$key.GetValue($name, '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  return @{ exists = $true; value = $value; kind = [string]$key.GetValueKind($name) }
}

function Set-Value($key, [string]$name, $record) {
  if (!$record.exists) { $key.DeleteValue($name, $false); return }
  $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
  if ($record.kind -eq 'String') { $kind = [Microsoft.Win32.RegistryValueKind]::String }
  $key.SetValue($name, [string]$record.value, $kind)
}

function Save-Backup($data, $previous) {
  [System.IO.Directory]::CreateDirectory([string]$data.backupDir) | Out-Null
  $file = Join-Path ([string]$data.backupDir) (([guid]::NewGuid().ToString()) + '.json')
  $record = @{ scope = [string]$data.scope; name = [string]$data.name; previous = $previous }
  [System.IO.File]::WriteAllText($file, ($record | ConvertTo-Json -Depth 8), [System.Text.UTF8Encoding]::new($false))
  return $file
}

function Broadcast-Environment {
  if (-not ('EnvironmentChange' -as [type])) {
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class EnvironmentChange {
  [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr wParam, string lParam, uint flags, uint timeout, out IntPtr result);
}

'@
  }
  $result = [IntPtr]::Zero
  [EnvironmentChange]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [IntPtr]::Zero, 'Environment', 0x2, 3000, [ref]$result) | Out-Null
}

function Assert-StateFile([string]$file) {
  $root = [System.IO.Path]::GetFullPath((Join-Path ($env:ProgramData) 'DevEnvManager')).TrimEnd('\')
  $full = [System.IO.Path]::GetFullPath($file)
  if (!$full.StartsWith($root + '\', [System.StringComparison]::OrdinalIgnoreCase) -or !$full.EndsWith('.json', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'State file is outside the managed ProgramData directory'
  }
  return $full
}

function Read-State($data) {
  $file = Assert-StateFile ([string]$data.file)
  if (![System.IO.File]::Exists($file)) { return $null }
  return [System.IO.File]::ReadAllText($file) | ConvertFrom-Json
}

function Write-State($data) {
  $file = Assert-StateFile ([string]$data.file)
  $parent = [System.IO.Path]::GetDirectoryName($file)
  [System.IO.Directory]::CreateDirectory($parent) | Out-Null
  $temporary = $file + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  $json = $data.value | ConvertTo-Json -Depth 12
  [System.IO.File]::WriteAllText($temporary, $json, [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $file -Force
  return @{ written = $true }
}

function Normalize-PathItem([string]$item) {
  return $item.Trim().Trim('"').Replace('/', '\').TrimEnd('\').ToLowerInvariant()
}

function Change-Path($data) {
  $key = Get-RegistryKey ([string]$data.scope)
  try {
    $previous = Read-Value $key 'Path'
    $remove = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($item in @($data.remove)) { [void]$remove.Add((Normalize-PathItem ([string]$item))) }
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $items = [System.Collections.Generic.List[string]]::new()
    foreach ($item in @(([string]$previous.value -split ';') + @($data.add))) {
      $entry = [string]$item
      $normalized = Normalize-PathItem $entry
      if ($normalized -and !$remove.Contains($normalized) -and $seen.Add($normalized)) { $items.Add($entry.Trim()) }
    }
    $next = $items -join ';'
    if ($next.Length -gt 32767) { throw 'PATH exceeds the Windows environment limit' }
    $data | Add-Member -NotePropertyName name -NotePropertyValue 'Path' -Force
    $backup = Save-Backup $data $previous
    if ($next -ne [string]$previous.value) {
      try {
        $kind = if ($previous.exists) { $previous.kind } else { 'ExpandString' }
        Set-Value $key 'Path' @{ exists = $true; value = $next; kind = $kind }
        Broadcast-Environment
      } catch {
        Set-Value $key 'Path' $previous
        Broadcast-Environment
        throw
      }
    }
    return @{ previous = $previous.value; next = $next; backupFile = $backup }
  } finally { $key.Dispose() }
}

function Change-Environment($data) {
  if ([string]$data.name -notin @('JAVA_HOME','GOROOT','GOPATH','DOTNET_ROOT','R_HOME','CARGO_HOME','RUSTUP_HOME','DART_SDK','MAVEN_HOME','PIP_INDEX_URL','NPM_CONFIG_REGISTRY','CARGO_REGISTRIES_CRATES_IO_INDEX','GOPROXY','MAVEN_ARGS')) {
    throw 'Environment variable is not allowed'
  }
  $key = Get-RegistryKey ([string]$data.scope)
  try {
    $previous = Read-Value $key ([string]$data.name)
    $backup = Save-Backup $data $previous
    try {
      if ($null -eq $data.value) { $key.DeleteValue([string]$data.name, $false) }
      else { Set-Value $key ([string]$data.name) @{ exists = $true; value = [string]$data.value; kind = 'ExpandString' } }
      Broadcast-Environment
    } catch {
      Set-Value $key ([string]$data.name) $previous
      Broadcast-Environment
      throw
    }
    return @{ previous = $previous.value; next = $data.value; backupFile = $backup }
  } finally { $key.Dispose() }
}

function Restore-Environment($data) {
  $record = Get-Content -LiteralPath ([string]$data.backupFile) -Raw | ConvertFrom-Json
  if ($record.scope -ne $data.scope -or $record.name -ne $data.name) { throw 'Backup does not match environment variable' }
  $key = Get-RegistryKey ([string]$data.scope)
  try {
    Set-Value $key ([string]$data.name) $record.previous
    Broadcast-Environment
  } finally { $key.Dispose() }
  return @{ restored = $true }
}

function Assert-ManagedPath([string]$target, [string]$root) {
  $full = [System.IO.Path]::GetFullPath($target).TrimEnd('\')
  if ($root) {
    $parent = [System.IO.Path]::GetFullPath($root).TrimEnd('\')
    if (!$full.StartsWith($parent + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
      throw 'Path is outside the managed system directory'
    }
  }
  if ($full -match '^[A-Za-z]:\\?$') { throw 'Drive root is not a managed installation' }
  return $full
}

function Assert-NoReparseParent([string]$target) {
  $part = [System.IO.Path]::GetPathRoot($target)
  foreach ($segment in ($target.Substring($part.Length) -split '\\')) {
    if (!$segment) { continue }
    $part = Join-Path $part $segment
    if ([System.IO.Directory]::Exists($part)) {
      $attributes = [System.IO.File]::GetAttributes($part)
      if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Managed path contains a junction or symbolic link' }
    }
  }
}

function Commit-Directory($data) {
  $source = [System.IO.Path]::GetFullPath([string]$data.source)
  $target = Assert-ManagedPath ([string]$data.destination) ([string]$data.root)
  if (![System.IO.Directory]::Exists($source)) { throw 'Staging directory does not exist' }
  Assert-NoReparseParent $target
  $parent = [System.IO.Path]::GetDirectoryName($target)
  [System.IO.Directory]::CreateDirectory($parent) | Out-Null
  $temporary = $target + '.pending-' + [guid]::NewGuid().ToString('N')
  $backup = $target + '.rollback-' + [guid]::NewGuid().ToString('N')
  try {
    Copy-Item -LiteralPath $source -Destination $temporary -Recurse -Force
    if ([System.IO.Directory]::Exists($target)) { [System.IO.Directory]::Move($target, $backup) }
    [System.IO.Directory]::Move($temporary, $target)
    if ([System.IO.Directory]::Exists($backup)) { Remove-Item -LiteralPath $backup -Recurse -Force }
    return @{ destination = $target }
  } catch {
    if ([System.IO.Directory]::Exists($temporary)) { Remove-Item -LiteralPath $temporary -Recurse -Force }
    if ([System.IO.Directory]::Exists($backup)) {
      if ([System.IO.Directory]::Exists($target)) { Remove-Item -LiteralPath $target -Recurse -Force }
      [System.IO.Directory]::Move($backup, $target)
    }
    throw
  }
}

function Remove-Directory($data) {
  $target = Assert-ManagedPath ([string]$data.target) ([string]$data.root)
  Assert-NoReparseParent $target
  if (![System.IO.Directory]::Exists($target)) { return @{ removed = $false } }
  $pending = $target + '.removing-' + [guid]::NewGuid().ToString('N')
  [System.IO.Directory]::Move($target, $pending)
  try {
    Remove-Item -LiteralPath $pending -Recurse -Force
  } catch {
    if ([System.IO.Directory]::Exists($pending)) { [System.IO.Directory]::Move($pending, $target) }
    throw
  }
  return @{ removed = $true }
}

function Run-ManagerUpdate($data) {
  $packageId = [string]$data.packageId
  if ($packageId -notmatch '^[A-Za-z0-9_.+-]+$') { throw 'Invalid package ID' }
  switch ([string]$data.manager) {
    'winget' { & winget upgrade --id $packageId --exact --accept-package-agreements --accept-source-agreements --disable-interactivity }
    'choco' { & choco upgrade $packageId --yes --no-progress }
    'scoop' { & scoop update $packageId }
    default { throw 'Unsupported package manager' }
  }
  if ($LASTEXITCODE -ne 0) { throw "Package manager exited with $LASTEXITCODE" }
  return @{ updated = $true; packageId = $packageId }
}

function Run-ManagerInstall($data) {
  $packageId = [string]$data.packageId
  if ([string]$data.manager -ne 'winget' -or $packageId -notmatch '^[A-Za-z0-9_.-]+$') { throw 'Unsupported package manager request' }
  & winget install --id $packageId --exact --accept-package-agreements --accept-source-agreements --disable-interactivity
  if ($LASTEXITCODE -ne 0) { throw "WinGet exited with $LASTEXITCODE" }
  return @{ installed = $true; packageId = $packageId }
}

function Run-ManagerUninstall($data) {
  $packageId = [string]$data.packageId
  if ([string]$data.manager -ne 'winget' -or $packageId -notmatch '^[A-Za-z0-9_.-]+$') { throw 'Unsupported package manager request' }
  & winget uninstall --id $packageId --exact --disable-interactivity
  if ($LASTEXITCODE -ne 0) { throw "WinGet exited with $LASTEXITCODE" }
  return @{ uninstalled = $true; packageId = $packageId }
}

function Write-MavenSettings($data) {
  $namespace = 'http://maven.apache.org/SETTINGS/1.2.0'
  $source = [string]$data.source
  $target = [string]$data.target
  $document = [System.Xml.XmlDocument]::new()
  if ($source -and [System.IO.File]::Exists($source)) {
    $document.Load($source)
  } else {
    $declaration = $document.CreateXmlDeclaration('1.0', 'UTF-8', $null)
    [void]$document.AppendChild($declaration)
    $settings = $document.CreateElement('settings', $namespace)
    [void]$document.AppendChild($settings)
  }
  $root = $document.DocumentElement
  if ($root.LocalName -ne 'settings') { throw 'Maven settings XML has an unexpected root' }
  $ns = $root.NamespaceURI
  $mirrors = $root.SelectSingleNode("*[local-name()='mirrors']")
  if (!$mirrors) {
    $mirrors = $document.CreateElement('mirrors', $ns)
    [void]$root.AppendChild($mirrors)
  }
  foreach ($existing in @($mirrors.SelectNodes("*[local-name()='mirror']"))) {
    $id = $existing.SelectSingleNode("*[local-name()='id']")
    if ($id -and $id.InnerText -eq 'dev-env-manager-cn') { [void]$mirrors.RemoveChild($existing) }
  }
  $mirror = $document.CreateElement('mirror', $ns)
  foreach ($pair in @(@('id','dev-env-manager-cn'), @('name','DevEnvManager China mirror'), @('url','https://maven.aliyun.com/repository/public'), @('mirrorOf','central'))) {
    $child = $document.CreateElement($pair[0], $ns)
    $child.InnerText = $pair[1]
    [void]$mirror.AppendChild($child)
  }
  [void]$mirrors.AppendChild($mirror)
  [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target)) | Out-Null
  $document.Save($target)
  return @{ target = $target }
}

function Run-Installer($data) {
  $file = [System.IO.Path]::GetFullPath([string]$data.file)
  if (![System.IO.File]::Exists($file) -or $file -notmatch '\.(exe|msi|msix)$') { throw 'Installer file is invalid' }
  $arguments = @($data.args | ForEach-Object { [string]$_ })
  if ($file.EndsWith('.msi', [System.StringComparison]::OrdinalIgnoreCase)) {
    $arguments = @('/i', $file) + $arguments
    $file = 'msiexec.exe'
  }
  $process = Start-Process -FilePath $file -ArgumentList $arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Installer exited with $($process.ExitCode)" }
  return @{ exitCode = $process.ExitCode }
}

try {
  $data = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
  switch ($Action) {
    'read-env' {
      $key = Get-RegistryKey ([string]$data.scope) $false
      try { $value = Read-Value $key ([string]$data.name) }
      finally { $key.Dispose() }
    }
    'read-state' { $value = Read-State $data }
    'write-state' { $value = Write-State $data }
    'path-change' { $value = Change-Path $data }
    'env-change' { $value = Change-Environment $data }
    'restore-env' { $value = Restore-Environment $data }
    'commit-directory' { $value = Commit-Directory $data }
    'remove-directory' { $value = Remove-Directory $data }
    'manager-update' { $value = Run-ManagerUpdate $data }
    'manager-install' { $value = Run-ManagerInstall $data }
    'manager-uninstall' { $value = Run-ManagerUninstall $data }
    'run-installer' { $value = Run-Installer $data }
    'maven-settings' { $value = Write-MavenSettings $data }
  }
  Write-Result $true $value $null
  exit 0
} catch {
  Write-Result $false $null $_.Exception.Message
  exit 1
}
