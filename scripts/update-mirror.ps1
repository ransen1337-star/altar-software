param(
  [Parameter(Mandatory = $true)] [string] $MirrorRepository,
  [switch] $Push
)

$arguments = @("scripts/update-mirror.mjs", "--mirror-dir", $MirrorRepository)
if ($Push) { $arguments += "--push" }
& node @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
