$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$nativeRoot = Join-Path $projectRoot 'native'
$buildRoot = Join-Path $nativeRoot 'build'
$resolvedNativeRoot = [System.IO.Path]::GetFullPath($nativeRoot).TrimEnd('\')
$resolvedBuildRoot = [System.IO.Path]::GetFullPath($buildRoot).TrimEnd('\')
if (-not $resolvedBuildRoot.StartsWith("$resolvedNativeRoot\", [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Native build path nằm ngoài thư mục native.'
}

$compilers = @()
try {
  $compilers += @(where.exe g++ 2>$null) | Where-Object { Test-Path -LiteralPath $_ }
} catch {
  # `where.exe` returns exit code 1 when g++ is not in PATH. Continue with
  # well-known MSYS2 locations so a normal Windows terminal still works.
}
$msysCompilers = @(
  'C:\msys64\ucrt64\bin\g++.exe',
  'C:\msys64\mingw64\bin\g++.exe',
  'C:\msys64\clang64\bin\g++.exe'
) | Where-Object { Test-Path -LiteralPath $_ }
$compilers = @($compilers + $msysCompilers | Select-Object -Unique)
if (-not $compilers) {
  throw 'Không tìm thấy C++ compiler (g++). Cài MSYS2 UCRT64 hoặc thêm thư mục chứa g++.exe vào PATH.'
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

$cmakeCommand = Get-Command cmake -ErrorAction SilentlyContinue
$cmakePath = if ($cmakeCommand) { $cmakeCommand.Source } else { $null }
if (-not $cmakePath) {
  $cmakeFallback = @(
    'C:\Program Files\CMake\bin\cmake.exe',
    'C:\msys64\ucrt64\bin\cmake.exe',
    'C:\msys64\mingw64\bin\cmake.exe'
  ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if ($cmakeFallback) { $cmakePath = $cmakeFallback }
}
if (-not $cmakePath) {
  throw 'Không tìm thấy CMake. Cài CMake hoặc MSYS2 UCRT64 CMake.'
}
$ninjaCommand = Get-Command ninja -ErrorAction SilentlyContinue
$ninjaPath = if ($ninjaCommand) { $ninjaCommand.Source } else { $null }
if (-not $ninjaPath) {
  $ninjaFallback = @(
    'C:\msys64\ucrt64\bin\ninja.exe',
    'C:\msys64\mingw64\bin\ninja.exe',
    'C:\Program Files\CMake\bin\ninja.exe'
  ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if ($ninjaFallback) { $ninjaPath = $ninjaFallback }
}
$generator = if ($ninjaPath) { 'Ninja' } else { 'MinGW Makefiles' }
$compilerDirectory = Split-Path -Parent $selected.Path
# MSYS2's compiler driver needs its own bin directory to locate cc1plus and
# runtime tools. Keep this change scoped to this build process only.
$env:Path = "$compilerDirectory;$env:Path"
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
if ($ninjaPath) {
  $configure += "-DCMAKE_MAKE_PROGRAM=$($ninjaPath.Replace('\', '/'))"
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
& $cmakePath @configure
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $cmakePath --build $buildRoot --config Release
exit $LASTEXITCODE
