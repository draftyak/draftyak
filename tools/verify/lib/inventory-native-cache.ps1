# Fixed-scope private cache access control. The result is control protocol, never diagnostic prose.
param([ValidateSet('Prepare','Check','PrepareAcquisition','CheckAcquisition')][string]$Mode='Check',[string]$ArtifactKey)
$ErrorActionPreference='Stop'
$stage='initialize'
$failureStages=@('initialize','resolve-cache','current-identity','validate-key','prepare-input','prepare-private-policy','prepare-protect-acl','prepare-remove-rule','prepare-build-rule','prepare-add-rule','prepare-write-acl','prepare-post-policy','check-item','check-kind','check-canonical','check-reparse','check-read-acl','check-owner-translate','check-owner-allowed','check-rule-translate','check-rule-allowed','acquisition-existing','acquisition-enumerate','acquisition-bound','acquisition-create','emit-success')
function Read-CheckedAcl([string]$Target,[bool]$Directory){
  $current=[IO.Path]::GetFullPath($Target)
  $leaf=$true
  while($current){
    $script:stage='check-item'
    $item=Get-Item -LiteralPath $current -Force
    $script:stage='check-kind'
    if([bool]$item.PSIsContainer -ne ($Directory -or -not $leaf)){throw 'cache refusal'}
    $script:stage='check-canonical'
    if(-not [string]::Equals($item.FullName,$current,[StringComparison]::OrdinalIgnoreCase)){throw 'cache refusal'}
    $script:stage='check-reparse'
    if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'cache refusal'}
    $leaf=$false
    $current=[IO.Path]::GetDirectoryName($current)
  }
  $script:stage='check-read-acl'
  $acl=Get-Acl -LiteralPath $Target
  $script:stage='check-owner-translate'
  $owner=New-Object Security.Principal.NTAccount($acl.Owner)
  $ownerSid=$owner.Translate([Security.Principal.SecurityIdentifier]).Value
  $script:stage='check-owner-allowed'
  if($ownerSid -notin $allowed){throw 'cache refusal'}
  return $acl
}
function Test-PreparedPrivateAcl($Acl){
  $script:stage='prepare-private-policy'
  $rules=@($Acl.Access)
  $required=@($allowed | Select-Object -Unique)
  $raw=[Security.AccessControl.RawSecurityDescriptor]::new($Acl.GetSecurityDescriptorBinaryForm(),0)
  if($null -eq $raw.DiscretionaryAcl -or $raw.DiscretionaryAcl.Count -ne $rules.Count){throw 'cache refusal'}
  $matches=$Acl.AreAccessRulesProtected -and $Acl.AreAccessRulesCanonical -and $rules.Count -eq $required.Count
  $seen=@()
  foreach($rule in $rules){
    if($rule.AccessControlType -ne 'Allow'){$matches=$false;continue}
    $script:stage='check-rule-translate'
    $sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    $script:stage='prepare-private-policy'
    if($sid -notin $allowed -or $sid -in $seen -or $rule.IsInherited -or
       $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
       $rule.InheritanceFlags -ne ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit) -or
       $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None){$matches=$false}
    $seen+=@($sid)
  }
  return ($matches -and $seen.Count -eq $required.Count)
}
function Assert-AllowedCacheAcl($Acl){
  foreach($rule in @($Acl.Access)){
    if($rule.AccessControlType -eq 'Allow'){
      $script:stage='check-rule-translate'
      $ruleSid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
      $script:stage='check-rule-allowed'
      if($ruleSid -notin $allowed){throw 'cache refusal'}
    }
  }
}
function Read-AcquisitionEntries([string]$Root){
  $rows=New-Object 'Collections.Generic.List[object]'
  $pending=New-Object 'Collections.Generic.Stack[string]'
  $pending.Push($Root)
  while($pending.Count -gt 0){
    $directory=$pending.Pop()
    $null=Read-CheckedAcl $directory $true
    $rows.Add([pscustomobject]@{path=$directory;directory=$true})
    $script:stage='acquisition-enumerate'
    foreach($item in @(Get-ChildItem -LiteralPath $directory -Force)){
      $script:stage='acquisition-bound'
      if($rows.Count+$pending.Count -ge 100000){throw 'cache refusal'}
      $null=Read-CheckedAcl $item.FullName ([bool]$item.PSIsContainer)
      if($item.PSIsContainer){$pending.Push($item.FullName)}
      else{$rows.Add([pscustomobject]@{path=$item.FullName;directory=$false})}
    }
  }
  return $rows.ToArray()
}
try{
  [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
  $stage='resolve-cache'
  $repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
  $cache=[IO.Path]::GetFullPath((Join-Path $repo 'tools/verify/.cache/inventory-native'))
  $stage='current-identity'
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  $allowed=@($identity.User.Value,'S-1-5-18','S-1-5-32-544')
  $acquisition=$Mode -in @('PrepareAcquisition','CheckAcquisition')
  $prepare=$Mode -in @('Prepare','PrepareAcquisition')
  $targets=@($cache)
  $directories=@($cache)
  $distribution=Join-Path $cache 'distribution'
  $distributionExists=$false
  if($acquisition){
    $stage='prepare-input'
    if($ArtifactKey){throw 'cache refusal'}
    # Canonical/nonlink/owner preflight ALL existing descendants before root ACL mutation.
    $null=Read-CheckedAcl $cache $true
    $stage='acquisition-existing'
    try{$null=Get-Item -LiteralPath $distribution -Force -ErrorAction Stop;$distributionExists=$true}
    catch{if($_.Exception -isnot [Management.Automation.ItemNotFoundException]){throw}}
    if($distributionExists){$null=@(Read-AcquisitionEntries $distribution)}
  }
  if($Mode -eq 'Check'){$targets+=@(Join-Path $cache 'current.json')}
  if($ArtifactKey){
    $stage='validate-key'
    if($ArtifactKey -cnotmatch '^[a-f0-9]{64}$'){throw 'cache refusal'}
    $directory=Join-Path $cache "artifacts/$ArtifactKey"
    $directories+=@($directory)
    $targets+=@($directory,(Join-Path $directory 'inventory-directory.node'),(Join-Path $directory 'build.json'),(Join-Path $directory 'toolchain.json'))
  }
  if($prepare){
    $stage='prepare-input'
    if($ArtifactKey){throw 'cache refusal'}
    $acl=Read-CheckedAcl $cache $true
    if(-not (Test-PreparedPrivateAcl $acl)){
      $stage='prepare-protect-acl'
      $acl.SetAccessRuleProtection($true,$false)
      $stage='prepare-remove-rule'
      foreach($rule in @($acl.Access)){$null=$acl.RemoveAccessRuleSpecific($rule)}
      foreach($sid in $allowed){
        $stage='prepare-build-rule'
        $account=New-Object Security.Principal.SecurityIdentifier($sid)
        $rule=New-Object Security.AccessControl.FileSystemAccessRule($account,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
        $stage='prepare-add-rule'
        $acl.AddAccessRule($rule)
      }
      $stage='prepare-write-acl'
      Set-Acl -LiteralPath $cache -AclObject $acl
    }
  }
  foreach($target in $targets){
    $acl=Read-CheckedAcl $target ($target -in $directories)
    Assert-AllowedCacheAcl $acl
    if(($prepare -or $acquisition) -and $target -eq $cache){
      $prepared=Test-PreparedPrivateAcl $acl
      $stage='prepare-post-policy'
      if(-not $prepared){throw 'cache refusal'}
    }
  }
  if($acquisition){
    if(-not $distributionExists){
      if(-not $prepare){$stage='acquisition-existing';throw 'cache refusal'}
      $acl=Read-CheckedAcl $cache $true
      if(-not (Test-PreparedPrivateAcl $acl)){throw 'cache refusal'}
      $stage='acquisition-create'
      $null=[IO.Directory]::CreateDirectory($distribution)
    }
    # No descendant ACL rewrite: existing explicit unsafe permissions simply refuse.
    foreach($entry in @(Read-AcquisitionEntries $distribution)){
      $acl=Read-CheckedAcl $entry.path ([bool]$entry.directory)
      Assert-AllowedCacheAcl $acl
    }
  }
  $stage='emit-success'
  [Console]::Out.Write("INVENTORY_PRIVATE_CACHE_V1`n")
}catch{
  $failureStage=if($failureStages -ccontains $stage){$stage}else{'unknown'}
  [Console]::Error.Write("INVENTORY_CACHE_FAILURE_STAGE_V1:${failureStage}`n")
  [Console]::Out.Write("INVENTORY_UNQUALIFIED_CACHE_V1`n")
  exit 1
}
