# Pure JSON regression cases. Import only the shared parser; never discover installed tools.
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$failures=New-Object 'Collections.Generic.List[object]'
$count=0
try{
  . (Join-Path $PSScriptRoot '../lib/inventory-native-query.ps1')
  $cases=@(
    @{name='empty-array';json='[]';accepted=$false;stage='vswhere-cardinality';count=0},
    @{name='single-valid';json='[{"isComplete":true,"isLaunchable":true}]';accepted=$true;stage='vswhere-accepted';count=1},
    @{name='two-valid';json='[{"isComplete":true,"isLaunchable":true},{"isComplete":true,"isLaunchable":true}]';accepted=$false;stage='vswhere-cardinality';count=2},
    @{name='object-root';json='{"isComplete":true,"isLaunchable":true}';accepted=$true;stage='vswhere-accepted';count=1},
    @{name='null-root';json='null';accepted=$false},
    @{name='string-root';json='"synthetic"';accepted=$false},
    @{name='number-root';json='1';accepted=$false},
    @{name='bool-root';json='true';accepted=$false},
    @{name='null-member';json='[null]';accepted=$false},
    @{name='null-before-valid';json='[null,{"isComplete":true,"isLaunchable":true}]';accepted=$false;stage='vswhere-cardinality';count=2},
    @{name='null-after-valid';json='[{"isComplete":true,"isLaunchable":true},null]';accepted=$false;stage='vswhere-cardinality';count=2},
    @{name='nested-array';json='[[{"isComplete":true,"isLaunchable":true}]]';accepted=$false;stage='vswhere-object';count=1},
    @{name='scalar-member';json='[true]';accepted=$false;stage='vswhere-object';count=1},
    @{name='complete-false';json='[{"isComplete":false,"isLaunchable":true}]';accepted=$false;stage='vswhere-complete'},
    @{name='launchable-false';json='[{"isComplete":true,"isLaunchable":false}]';accepted=$false;stage='vswhere-launchable'},
    @{name='complete-string';json='[{"isComplete":"true","isLaunchable":true}]';accepted=$false;stage='vswhere-complete'},
    @{name='launchable-string';json='[{"isComplete":true,"isLaunchable":"true"}]';accepted=$false;stage='vswhere-launchable'},
    @{name='complete-number';json='[{"isComplete":1,"isLaunchable":true}]';accepted=$false;stage='vswhere-complete'},
    @{name='launchable-number';json='[{"isComplete":true,"isLaunchable":1}]';accepted=$false;stage='vswhere-launchable'},
    @{name='complete-null';json='[{"isComplete":null,"isLaunchable":true}]';accepted=$false;stage='vswhere-complete'},
    @{name='launchable-null';json='[{"isComplete":true,"isLaunchable":null}]';accepted=$false;stage='vswhere-launchable'},
    @{name='complete-missing';json='[{"isLaunchable":true,"unused":"QUERY_VALUE_NOT_FOR_OUTPUT"}]';accepted=$false;stage='vswhere-complete'},
    @{name='launchable-missing';json='[{"isComplete":true}]';accepted=$false;stage='vswhere-launchable'},
    @{name='complete-array';json='[{"isComplete":[true],"isLaunchable":true}]';accepted=$false;stage='vswhere-complete'},
    @{name='launchable-array';json='[{"isComplete":true,"isLaunchable":[true]}]';accepted=$false;stage='vswhere-launchable'},
    @{name='empty-object';json='{}';accepted=$false;stage='vswhere-complete'},
    @{name='malformed';json='{"unused":"QUERY_VALUE_NOT_FOR_OUTPUT",';accepted=$false;stage='vswhere-json'},
    @{name='extra-data';json='{"isComplete":true,"isLaunchable":true,"unused":"QUERY_VALUE_NOT_FOR_OUTPUT"}';accepted=$true;stage='vswhere-accepted';count=1}
  )
  $stages=@('vswhere-json','vswhere-cardinality','vswhere-object','vswhere-complete','vswhere-launchable','vswhere-accepted')
  foreach($case in $cases){
    $count++
    try{
      $result=Read-InventoryNativeQuery $case.json
      $matches=$result.accepted -is [bool] -and $result.accepted -eq $case.accepted -and $result.stage -in $stages
      if($case.ContainsKey('stage')){$matches=$matches -and $result.stage -ceq $case.stage}
      if($case.ContainsKey('count')){$matches=$matches -and $result.facts.instanceCount -eq $case.count}
      if($result.accepted){
        $matches=$matches -and $result.instance -is [Management.Automation.PSCustomObject] -and
          $result.facts.instanceCount -eq 1 -and $result.facts.candidate.kind -ceq 'object' -and
          $result.facts.isComplete -is [bool] -and $result.facts.isComplete -and
          $result.facts.isLaunchable -is [bool] -and $result.facts.isLaunchable -and
          $result.facts.completeCondition -and $result.facts.launchableCondition
      }else{$matches=$matches -and $null -eq $result.instance}
      $safe=$result.facts|ConvertTo-Json -Depth 4 -Compress
      if($safe.Contains('QUERY_VALUE_NOT_FOR_OUTPUT')){$matches=$false}
      if(-not $matches){$failures.Add([pscustomobject]@{case=$case.name;reason='result-mismatch'})}
    }catch{$failures.Add([pscustomobject]@{case=$case.name;reason='unexpected-throw'})}
  }
}catch{$failures.Add([pscustomobject]@{case='parser-import';reason='unexpected-throw'})}
$status=if($failures.Count -eq 0 -and $count -eq 28){'inventory-query-tests-passed'}else{'inventory-query-tests-failed'}
[pscustomobject]@{status=$status;cases=$count;failed=$failures.Count;failures=$failures.ToArray()}|ConvertTo-Json -Depth 3 -Compress
if($failures.Count -ne 0 -or $count -ne 28){exit 1}
