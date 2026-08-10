$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$nativeRoot = Join-Path $projectRoot 'native'
$buildRoot = Join-Path $nativeRoot 'build'
$resolvedNativeRoot = [System.IO.Path]::GetFullPath($nativeRoot).TrimEnd('\')
$resolvedBuildRoot = [System.IO.Path]::GetFullPath($buildRoot).TrimEnd('\')
if (-not $resolvedBuildRoot.StartsWith("$resolvedNativeRoot\", [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Native build path nằm ngoài thư mục native.'
}

$compilers = @(where.exe g++ 2>$null) | Where-Object { Test-Path -LiteralPath $_ }
if (-not $compilers) {
  throw 'Không tìm thấy C++ compiler (g++).'
}

$selected = $compilers |
  ForEach-Object {
    $versionLine = & $_ --version | Select-Object -First 1
    $match = [regex]::Match($versionLine, '(\d+)\.(\d+)\.(\d+)')
    [pscustomobject]@{
      Path = $_
      Version = if ($match.Success) { [version]$match.Value } else { [version]'0.0.0' }
    }
  } |
  Sort-Object Version -Descending |
  Select-Object -First 1

if ($selected.Version.Major -lt 10) {
  throw "C++ compiler quá cũ: $($selected.Version). Cần GCC 10 trở lên."
}

$ninja = Get-Command ninja -ErrorAction SilentlyContinue
$generator = if ($ninja) { 'Ninja' } else { 'MinGW Makefiles' }
$compilerDirectory = Split-Path -Parent $selected.Path
$resourceCompiler = Join-Path $compilerDirectory 'windres.exe'
$cmakeCompiler = $selected.Path.Replace('\', '/')
$cmakeResourceCompiler = $resourceCompiler.Replace('\', '/')

$configure = @(
  '--fresh',
  '-S', $nativeRoot,
  '-B', $buildRoot,
  '-G', $generator,
  "-DCMAKE_CXX_COMPILER=$cmakeCompiler"
)
if (Test-Path -LiteralPath $resourceCompiler) {
  $configure += "-DCMAKE_RC_COMPILER=$cmakeResourceCompiler"
}

Write-Host "[Native] GCC $($selected.Version) · $generator" -ForegroundColor Cyan
$needsClean = $false
if (Test-Path -LiteralPath $resolvedBuildRoot) {
  $cacheFiles = Get-ChildItem -LiteralPath $resolvedBuildRoot -Recurse -Filter 'CMakeCache.txt' -File -ErrorAction SilentlyContinue
  foreach ($cacheFile in $cacheFiles) {
    $cache = Get-Content -Raw -LiteralPath $cacheFile.FullName
    if ($cache -match 'CMAKE_GENERATOR:INTERNAL=([^\r\n]+)' -and $Matches[1] -ne $generator) {
      $needsClean = $true
      break
    }
  }
}
if ($needsClean) {
  Remove-Item -LiteralPath $resolvedBuildRoot -Recurse -Force
}
& cmake @configure
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& cmake --build $buildRoot --config Release
exit $LASTEXITCODE
