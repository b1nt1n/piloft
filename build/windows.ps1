$ErrorActionPreference = 'Stop'
$version = '22.22.2'
$checksum = '7C93E9D92BF68C07182B471AA187E35EE6CD08EF0F24AB060DFFF605FCC1C57C'
$distribution = "node-v$version-win-x64"
$runtime = Join-Path $PSScriptRoot 'node-runtime'
$marker = Join-Path $runtime '.archive-sha256'
if ((Test-Path -LiteralPath (Join-Path $runtime 'node.exe')) -and (Test-Path -LiteralPath (Join-Path $runtime 'node_modules/npm/bin/npx-cli.js')) -and
    (Test-Path -LiteralPath $marker) -and (Get-Content -LiteralPath $marker -Raw).Trim() -eq $checksum) {
    exit 0
}

$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("freepi-runtime-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging | Out-Null
try {
    $archive = Join-Path $staging "$distribution.zip"
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$version/$distribution.zip" -OutFile $archive
    $stream = [System.IO.File]::OpenRead($archive)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '')
    } finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
    if ($hash -ne $checksum) {
        throw "Unexpected Node.js archive checksum."
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($archive, $staging)
    $unpacked = Join-Path $staging $distribution
    New-Item -ItemType Directory -Path $runtime -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $unpacked 'node.exe'), (Join-Path $unpacked 'LICENSE') -Destination $runtime -Force
    $modules = Join-Path $runtime 'node_modules'
    New-Item -ItemType Directory -Path $modules -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $unpacked 'node_modules/npm') -Destination $modules -Recurse -Force
    & (Join-Path $runtime 'node.exe') (Join-Path $runtime 'node_modules/npm/bin/npx-cli.js') --version
    if ($LASTEXITCODE -ne 0) { throw "The staged npm runtime failed to start." }
    Set-Content -LiteralPath $marker -Value $checksum -Encoding ascii
} finally {
    $resolved = (Resolve-Path -LiteralPath $staging).Path
    $tempRoot = (Resolve-Path -LiteralPath ([System.IO.Path]::GetTempPath())).Path.TrimEnd('\')
    if ([System.IO.Path]::GetDirectoryName($resolved) -eq $tempRoot -and
        [System.IO.Path]::GetFileName($resolved) -like 'freepi-runtime-*') {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
