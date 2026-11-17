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
function SignedMicrosoft([string]$target,[bool]$runtime=$false){
  if($runtime){$script:runtimeCondition='file-ordinary';$script:runtimeSignatureStatus=$null}
  $item=Ordinary $target $false
  if($runtime){$script:runtimeCondition='hash-before'}
  $before=(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
  if($runtime -and $null -ne $script:runtimeResource){$script:runtimeResource.sha256Before=$before}
  if($runtime){$script:runtimeCondition='authenticode-query'}
  $signature=Get-AuthenticodeSignature -LiteralPath $target
  if($runtime){
    $script:runtimeCondition='signature-status'
    if($signature.Status -is [System.Management.Automation.SignatureStatus]){
      $script:runtimeSignatureStatus=switch([int]$signature.Status){
        0{'valid'} 1{'unknown-error'} 2{'not-signed'} 3{'hash-mismatch'}
        4{'not-trusted'} 5{'not-supported-file-format'} 6{'incompatible'} default{$null}
      }
    }
  }
  Require ($signature.Status -eq 'Valid')
  if($runtime){$script:runtimeCondition='signer-certificate'}
  Require ($null -ne $signature.SignerCertificate)
  $certificate=$signature.SignerCertificate
  if($runtime){$script:runtimeCondition='microsoft-signer'}
  if($runtime -and $null -ne $script:runtimeResource){$script:runtimeResource.signerNameRead=$false}
  $microsoftSigner=($certificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false) -ceq 'Microsoft Corporation')
  if($runtime -and $null -ne $script:runtimeResource){
    $script:runtimeResource.signerNameRead=$true
    $script:runtimeResource.signerNameMatches=$microsoftSigner
  }
  Require $microsoftSigner
  if($runtime){$script:runtimeCondition='eku-cardinality'}
  $usage=@($certificate.Extensions|Where-Object {$_.Oid.Value -eq '2.5.29.37'})
  Require ($usage.Count -eq 1)
  if($runtime){$script:runtimeCondition='code-signing-usage'}
  $codeSigning=@($usage[0].EnhancedKeyUsages|Where-Object {$_.Value -eq '1.3.6.1.5.5.7.3.3'})
  Require ($codeSigning.Count -gt 0)
  if($runtime){$script:runtimeCondition='hash-after'}
  $after=(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
  if($runtime){$script:runtimeCondition='byte-stability'}
  Require ($after -ceq $before)
  if($runtime){$script:runtimeCondition='file-receipt'}
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
  $script:runtimeResource=$null;$script:runtimeFailureResource=$null
  $script:runtimeCondition='root-ordinary'
  $todo=New-Object 'System.Collections.Generic.Stack[string]'
  $todo.Push((Ordinary $root $true).FullName)
  $rows=New-Object 'System.Collections.Generic.List[object]'
  while($todo.Count -gt 0){
    $script:runtimeResource=$null;$script:runtimeFailureResource=$null
    $script:runtimeCondition='enumerate'
    foreach($item in @(Get-ChildItem -LiteralPath $todo.Pop() -Force)){
      $script:runtimeResource=$null;$script:runtimeFailureResource=$null
      $script:runtimeCondition='entry-no-reparse'
      Require (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)
      if($item.PSIsContainer){$todo.Push($item.FullName);continue}
      if($item.Extension -in @('.exe','.dll')){
        $script:runtimeCondition='row-bound'
        Require ($rows.Count -lt 10000)
        $kind=if($item.Extension -ieq '.exe'){'exe'}else{'dll'}
        $role=if($kind -ceq 'dll'){'runtime-dll'}elseif($item.Name -ieq 'cl.exe'){'compiler'}elseif($item.Name -ieq 'link.exe'){'linker'}else{'other-exe'}
        $script:runtimeResource=[ordered]@{ordinal=[int]($rows.Count+1);kind=$kind;role=$role;sha256Before=$null;signerNameRead=$null;signerNameMatches=$null}
        try{
          $rows.Add((SignedMicrosoft $item.FullName $true))
        }catch{
          $script:runtimeFailureResource=[pscustomobject][ordered]@{
            ordinal=$script:runtimeResource.ordinal;kind=$script:runtimeResource.kind;role=$script:runtimeResource.role
            sha256Before=$script:runtimeResource.sha256Before;signerNameRead=$script:runtimeResource.signerNameRead;signerNameMatches=$script:runtimeResource.signerNameMatches
          }
          throw
        }finally{$script:runtimeResource=$null}
      }
    }
  }
  $script:runtimeCondition='result'
  return @($rows.ToArray()|Sort-Object path)
}
$stage='host'
$runtimeCondition=$null
$runtimeSignatureStatus=$null
$runtimeResource=$null
$runtimeFailureResource=$null
$runtimeConditions=@('root-ordinary','enumerate','entry-no-reparse','row-bound','file-ordinary','hash-before','authenticode-query','signature-status','signer-certificate','microsoft-signer','eku-cardinality','code-signing-usage','hash-after','byte-stability','file-receipt','result')
$runtimeSignatureStatuses=@('valid','unknown-error','not-signed','hash-mismatch','not-trusted','not-supported-file-format','incompatible')
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
  if($stage -ceq 'compiler-runtime-signatures' -and $runtimeCondition -cin $runtimeConditions){
    $failure.runtimeCondition=$runtimeCondition
    if($runtimeCondition -ceq 'signature-status' -and $runtimeSignatureStatus -cin $runtimeSignatureStatuses){$failure.signatureStatus=$runtimeSignatureStatus}
    $resource=$runtimeFailureResource
    $resourceValid=$null -ne $resource
    if($resourceValid){
      $resourceValid=($resource.ordinal -is [int] -and $resource.ordinal -ge 1 -and $resource.ordinal -le 10000 -and
        $resource.kind -is [string] -and $resource.role -is [string] -and
        (($resource.kind -ceq 'exe' -and $resource.role -cin @('compiler','linker','other-exe')) -or ($resource.kind -ceq 'dll' -and $resource.role -ceq 'runtime-dll')) -and
        ($null -eq $resource.sha256Before -or ($resource.sha256Before -is [string] -and $resource.sha256Before -cmatch '^[0-9a-f]{64}$')) -and
        ($null -eq $resource.signerNameRead -or $resource.signerNameRead -is [bool]) -and
        ($null -eq $resource.signerNameMatches -or $resource.signerNameMatches -is [bool]))
    }
    if($resourceValid -and $null -ne $resource.signerNameRead){$resourceValid=$resource.sha256Before -is [string]}
    if($resourceValid){
      if($resource.signerNameRead){$resourceValid=$resource.signerNameMatches -is [bool]}
      else{$resourceValid=$null -eq $resource.signerNameMatches}
    }
    if($resourceValid){
      $failure.runtimeResource=[pscustomobject][ordered]@{
        ordinal=$resource.ordinal;kind=$resource.kind;role=$resource.role;sha256Before=$resource.sha256Before
        signerNameRead=$resource.signerNameRead;signerNameMatches=$resource.signerNameMatches
      }
    }
  }
  if($stage -in @('vswhere-native','vswhere-json','vswhere-cardinality','vswhere-object','vswhere-complete','vswhere-launchable')){
    if($queryFacts.outcome -cnotin $queryOutcomes){$queryFacts.outcome='unknown'}
    $failure.query=[pscustomobject]$queryFacts
  }
  [pscustomobject]$failure|ConvertTo-Json -Depth 3 -Compress
  exit 1
}
