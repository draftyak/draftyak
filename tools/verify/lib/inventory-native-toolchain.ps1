# Read-only installed Windows C++/SDK qualification. No install, compilation or environment setup script.
param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
function Require($condition){if(-not $condition){throw 'inventory toolchain qualification failed'}}
function Ordinary([string]$target,[bool]$directory){
  $item=Get-Item -LiteralPath $target -Force
  Require (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 -and $item.PSIsContainer -eq $directory)
  return $item
}
function SignedMicrosoft([string]$target){
  $item=Ordinary $target $false
  $before=(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
  $signature=Get-AuthenticodeSignature -LiteralPath $target
  Require ($signature.Status -eq 'Valid' -and $null -ne $signature.SignerCertificate)
  $certificate=$signature.SignerCertificate
  Require ($certificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false) -ceq 'Microsoft Corporation')
  $usage=@($certificate.Extensions|Where-Object {$_.Oid.Value -eq '2.5.29.37'})
  Require ($usage.Count -eq 1)
  $codeSigning=@($usage[0].EnhancedKeyUsages|Where-Object {$_.Value -eq '1.3.6.1.5.5.7.3.3'})
  Require ($codeSigning.Count -gt 0)
  Require ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $before)
  return [pscustomobject]@{path=$item.FullName;sha256=$before;signerThumbprint=$certificate.Thumbprint.ToLowerInvariant();fileVersion=$item.VersionInfo.FileVersion}
}
function ReadNative([string]$executable,[string[]]$arguments){
  # All argument strings below are fixed literals, not a shell command.
  $start=New-Object Diagnostics.ProcessStartInfo
  $start.FileName=$executable;$start.Arguments=($arguments -join ' ')
  $start.UseShellExecute=$false;$start.CreateNoWindow=$true
  $start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
  $start.StandardOutputEncoding=New-Object Text.UTF8Encoding($false,$true)
  $start.StandardErrorEncoding=New-Object Text.UTF8Encoding($false,$true)
  $process=New-Object Diagnostics.Process
  $process.StartInfo=$start
  $started=$false;$out=$null;$err=$null
  try{
    $script:queryFacts.outcome='start'
    $started=$process.Start();Require $started
    $script:queryFacts.outcome='pipe-start'
    $out=$process.StandardOutput.ReadToEndAsync();$err=$process.StandardError.ReadToEndAsync()
    $script:queryFacts.outcome='wait'
    if(-not $process.WaitForExit(15000)){$script:queryFacts.timedOut=$true;$script:queryFacts.outcome='timeout';$process.Kill();$process.WaitForExit();throw 'inventory toolchain discovery timeout'}
    $process.WaitForExit();$script:queryFacts.nativeExitCode=[int]$process.ExitCode
    $script:queryFacts.outcome='decode'
    $stdout=$out.GetAwaiter().GetResult();$stderr=$err.GetAwaiter().GetResult()
    $script:queryFacts.stdoutWithinLimit=[bool]($stdout.Length -le 1048576)
    $script:queryFacts.stderrWithinLimit=[bool]($stderr.Length -le 65536)
    $script:queryFacts.outcome=if($process.ExitCode -ne 0){'native-exit'}elseif(-not $script:queryFacts.stdoutWithinLimit -or -not $script:queryFacts.stderrWithinLimit){'output-limit'}else{'none'}
    Require ($process.ExitCode -eq 0 -and $stdout.Length -le 1048576 -and $stderr.Length -le 65536)
    return $stdout
  }finally{
    try{
      if($started){
        if(-not $process.HasExited){try{$process.Kill()}catch{}}
        $process.WaitForExit()
        if($null -ne $out){try{$null=$out.GetAwaiter().GetResult()}catch{}}
        if($null -ne $err){try{$null=$err.GetAwaiter().GetResult()}catch{}}
      }
      $process.Dispose()
    }catch{$script:queryFacts.outcome='cleanup';throw}
  }
}
function TreeFiles([string]$root,[string]$label){
  $base=Ordinary $root $true
  $todo=New-Object 'System.Collections.Generic.Stack[string]'
  $todo.Push($base.FullName)
  $rows=New-Object 'System.Collections.Generic.List[object]'
  while($todo.Count -gt 0){
    $directory=$todo.Pop()
    foreach($item in @(Get-ChildItem -LiteralPath $directory -Force)){
      Require (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)
      if($item.PSIsContainer){$todo.Push($item.FullName);continue}
      Require ($rows.Count -lt 100000)
      $relative=$item.FullName.Substring($base.FullName.Length).TrimStart('\').Replace('\','/')
      $rows.Add([pscustomobject]@{input=$label;relative=$relative;size=$item.Length;sha256=(Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()})
    }
  }
  return @($rows.ToArray()|Sort-Object input,relative)
}
function SignedRuntime([string]$root){
  $todo=New-Object 'System.Collections.Generic.Stack[string]'
  $todo.Push((Ordinary $root $true).FullName)
  $rows=New-Object 'System.Collections.Generic.List[object]'
  while($todo.Count -gt 0){
    foreach($item in @(Get-ChildItem -LiteralPath $todo.Pop() -Force)){
      Require (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)
      if($item.PSIsContainer){$todo.Push($item.FullName);continue}
      if($item.Extension -in @('.exe','.dll')){
        Require ($rows.Count -lt 10000)
        $rows.Add((SignedMicrosoft $item.FullName))
      }
    }
  }
  return @($rows.ToArray()|Sort-Object path)
}
$stage='host'
$queryFacts=[ordered]@{outcome='not-started';nativeExitCode=$null;timedOut=$false;stdoutWithinLimit=$null;stderrWithinLimit=$null;instanceCount=$null;parsedContainer=$null;candidateExists=$null;candidate=$null;isComplete=$null;isLaunchable=$null;completeCondition=$null;launchableCondition=$null}
$queryOutcomes=@('not-started','start','pipe-start','wait','timeout','decode','native-exit','output-limit','cleanup','none','json','cardinality','object','complete','launchable','accepted')
try{
  Require ([Environment]::Is64BitProcess)
  $stage='cache-output'
  $repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
  $cache=[IO.Path]::GetFullPath((Join-Path $repo 'tools/verify/.cache/inventory-native'))
  $output=[IO.Path]::GetFullPath($OutputDirectory)
  Require ($output.StartsWith($cache+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase))
  $null=Ordinary $output $true
  $stage='query-parser-source'
  . (Join-Path $PSScriptRoot 'inventory-native-query.ps1')
  $programFiles=[Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
  Require (-not [string]::IsNullOrWhiteSpace($programFiles))
  $locator=Join-Path $programFiles 'Microsoft Visual Studio/Installer/vswhere.exe'
  $stage='vswhere-signature'
  $locatorReceipt=SignedMicrosoft $locator
  $stage='vswhere-native'
  $queryText=ReadNative $locator @('-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-format','json','-utf8')
  $stage='vswhere-json';$queryFacts.outcome='json'
  $parsed=Read-InventoryNativeQuery $queryText
  foreach($name in @('outcome','instanceCount','parsedContainer','candidateExists','candidate','isComplete','isLaunchable','completeCondition','launchableCondition')){$queryFacts[$name]=$parsed.facts[$name]}
  $stage=$parsed.stage
  Require $parsed.accepted
  $stage='msvc-layout'
  $instance=$parsed.instance
  $install=(Ordinary $instance.installationPath $true).FullName
  $versionFile=Join-Path $install 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt'
  $null=Ordinary $versionFile $false
  $toolsetVersion=([IO.File]::ReadAllText($versionFile)).Trim()
  Require ($toolsetVersion -match '^\d+\.\d+\.\d+$')
  $toolset=(Ordinary (Join-Path $install "VC/Tools/MSVC/$toolsetVersion") $true).FullName
  $bin=(Ordinary (Join-Path $toolset 'bin/Hostx64/x64') $true).FullName
  $stage='compiler-signatures'
  $compiler=SignedMicrosoft (Join-Path $bin 'cl.exe')
  $linker=SignedMicrosoft (Join-Path $bin 'link.exe')
  $stage='compiler-runtime-signatures'
  $dlls=SignedRuntime $bin
  $stage='sdk-root'
  $kits=(Get-ItemProperty -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows Kits\Installed Roots' -Name KitsRoot10).KitsRoot10
  $sdk=(Ordinary $kits $true).FullName
  $stage='sdk-version'
  $versions=@(Get-ChildItem -LiteralPath (Join-Path $sdk 'Include') -Directory|Where-Object {$_.Name -match '^\d+\.\d+\.\d+\.\d+$'}|Sort-Object {[Version]$_.Name} -Descending)
  $selected=$null
  foreach($version in $versions){
    if((Test-Path -LiteralPath (Join-Path $version.FullName 'um/Windows.h')) -and
       (Test-Path -LiteralPath (Join-Path $version.FullName 'um/winternl.h')) -and
       (Test-Path -LiteralPath (Join-Path $sdk "Lib/$($version.Name)/um/x64/kernel32.lib"))){$selected=$version.Name;break}
  }
  Require ($null -ne $selected)
  $includes=@((Join-Path $toolset 'include'),(Join-Path $sdk "Include/$selected/ucrt"),(Join-Path $sdk "Include/$selected/shared"),(Join-Path $sdk "Include/$selected/um"))
  $libraries=@((Join-Path $toolset 'lib/x64'),(Join-Path $sdk "Lib/$selected/ucrt/x64"),(Join-Path $sdk "Lib/$selected/um/x64"))
  $stage='sdk-inputs'
  $inputs=New-Object 'System.Collections.Generic.List[object]'
  for($i=0;$i -lt $includes.Count;$i++){foreach($row in @(TreeFiles $includes[$i] "include$i")){$inputs.Add($row)}}
  for($i=0;$i -lt $libraries.Count;$i++){foreach($row in @(TreeFiles $libraries[$i] "library$i")){$inputs.Add($row)}}
  Require ($inputs.Count -gt 0 -and $inputs.Count -le 100000)
  $manifest=[pscustomobject]@{schema='inventory-windows-toolchain-v1';host='x64';target='x64';
    discovery=$locatorReceipt;installationId=$instance.instanceId;installationVersion=$instance.installationVersion;
    installationPath=$install;toolsetVersion=$toolsetVersion;sdkRoot=$sdk;sdkVersion=$selected;
    compiler=$compiler;linker=$linker;compilerRuntime=$dlls;includeDirectories=$includes;libraryDirectories=$libraries;
    windowsDirectory=[Environment]::GetFolderPath([Environment+SpecialFolder]::Windows);inputs=$inputs.ToArray()}
  $text=$manifest|ConvertTo-Json -Depth 8 -Compress
  Require ([Text.Encoding]::UTF8.GetByteCount($text) -le 16777216)
  $stage='receipt-write'
  $file=Join-Path $output 'windows-toolchain.json'
  $bytes=(New-Object Text.UTF8Encoding($false)).GetBytes($text)
  $stream=[IO.File]::Open($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
  [pscustomobject]@{status='verified-installed-windows-toolchain';receipt=$file;sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}|ConvertTo-Json -Compress
}catch{
  $failure=[ordered]@{status='unqualified-installed-windows-toolchain';stage=$stage}
  if($stage -in @('vswhere-native','vswhere-json','vswhere-cardinality','vswhere-object','vswhere-complete','vswhere-launchable')){
    if($queryFacts.outcome -cnotin $queryOutcomes){$queryFacts.outcome='unknown'}
    $failure.query=[pscustomobject]$queryFacts
  }
  [pscustomobject]$failure|ConvertTo-Json -Depth 3 -Compress
  exit 1
}
