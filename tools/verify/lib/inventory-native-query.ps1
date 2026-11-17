# Pure locator JSON parsing. Import defines functions only; no discovery or filesystem access.
function Get-InventoryNativeQueryShape($Value){
  $kind='scalar';$arrayLength=$null
  if($null -eq $Value){$kind='null'}
  elseif($Value -is [Array]){$kind='array';$arrayLength=[int]$Value.Length}
  elseif($Value -is [Management.Automation.PSCustomObject] -or $Value -is [Collections.IDictionary]){$kind='object'}
  return [pscustomobject]@{kind=$kind;arrayLength=$arrayLength;
    hasIsComplete=[bool]($null -ne $Value -and $null -ne $Value.PSObject.Properties['isComplete']);
    hasIsLaunchable=[bool]($null -ne $Value -and $null -ne $Value.PSObject.Properties['isLaunchable'])}
}
function Read-InventoryNativeQuery([string]$Json){
  $facts=[ordered]@{outcome='json';instanceCount=$null;parsedContainer=$null;candidateExists=$null;candidate=$null;isComplete=$null;isLaunchable=$null;completeCondition=$null;launchableCondition=$null}
  $result=[ordered]@{accepted=$false;stage='vswhere-json';facts=$facts;instance=$null}
  try{$root=ConvertFrom-Json -InputObject $Json -ErrorAction Stop}catch{return [pscustomobject]$result}
  # Capture the direct conversion before normalizing. A pipeline array capture counts
  # the whole JSON array as one item in Windows PowerShell 5.1.
  $instances=,$root
  if($null -eq $root){$instances=@()}elseif($root -is [Array]){$instances=$root}
  $facts.instanceCount=[int]$instances.Count
  $facts.parsedContainer=Get-InventoryNativeQueryShape $instances
  $facts.candidateExists=[bool]($instances.Count -gt 0)
  $facts.candidate=if($instances.Count -gt 0){Get-InventoryNativeQueryShape $instances[0]}else{Get-InventoryNativeQueryShape $null}
  $result.stage='vswhere-cardinality';$facts.outcome='cardinality'
  if($instances.Count -ne 1){return [pscustomobject]$result}
  $candidate=$instances[0]
  $result.stage='vswhere-object';$facts.outcome='object'
  if($null -eq $candidate -or $candidate -isnot [Management.Automation.PSCustomObject]){return [pscustomobject]$result}
  $properties=$candidate.PSObject.Properties
  $complete=$properties['isComplete'];$launchable=$properties['isLaunchable']
  if($null -ne $complete -and $complete.Value -is [bool]){$facts.isComplete=[bool]$complete.Value}
  if($null -ne $launchable -and $launchable.Value -is [bool]){$facts.isLaunchable=[bool]$launchable.Value}
  $facts.completeCondition=[bool]($null -ne $complete -and $complete.Value -is [bool] -and $complete.Value)
  $facts.launchableCondition=[bool]($null -ne $launchable -and $launchable.Value -is [bool] -and $launchable.Value)
  $result.stage='vswhere-complete';$facts.outcome='complete'
  if(-not $facts.completeCondition){return [pscustomobject]$result}
  $result.stage='vswhere-launchable';$facts.outcome='launchable'
  if(-not $facts.launchableCondition){return [pscustomobject]$result}
  $facts.outcome='accepted';$result.stage='vswhere-accepted';$result.accepted=$true;$result.instance=$candidate
  return [pscustomobject]$result
}
