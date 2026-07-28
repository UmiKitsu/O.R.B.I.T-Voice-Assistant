Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-OrbitJson {
  param([Parameter(Mandatory = $true)] [object] $Value)
  [Console]::Out.Write(($Value | ConvertTo-Json -Compress -Depth 8))
  exit 0
}

function Assert-ExactProperties {
  param(
    [Parameter(Mandatory = $true)] [object] $Object,
    [Parameter(Mandatory = $true)] [AllowEmptyCollection()] [string[]] $Names
  )
  $actual = @($Object.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object)
  $expected = @($Names | Sort-Object)
  if (($actual -join "`n") -ne ($expected -join "`n")) {
    throw 'The fixed-operation parameters are invalid.'
  }
}

function Get-BlockedProcessNames {
  return @(
    'system', 'idle', 'registry', 'smss', 'csrss', 'wininit', 'services', 'lsass',
    'winlogon', 'fontdrvhost', 'dwm', 'securityhealthservice', 'securityhealthsystray',
    'msmpeng', 'nissrv', 'audiodg', 'spoolsv', 'svchost', 'runtimebroker',
    'orbit voice assistant', 'orbit-voice-assistant', 'electron', 'ollama', 'ollama app',
    'powershell', 'pwsh', 'cmd', 'windowsterminal', 'conhost', 'explorer', 'taskmgr',
    'startmenuexperiencehost', 'shellexperiencehost', 'searchhost', 'searchapp',
    'textinputhost', 'applicationframehost', 'lockapp', 'logonui', 'sihost'
  )
}

function Initialize-OrbitUiAutomation {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
}

function Test-OrbitRuntimeId {
  param([int[]] $Actual, [object[]] $Expected)
  if ($Actual.Count -ne $Expected.Count) { return $false }
  for ($index = 0; $index -lt $Actual.Count; $index += 1) {
    if ([int] $Actual[$index] -ne [int] $Expected[$index]) { return $false }
  }
  return $true
}

function Test-OrbitAutomationWindowFocused {
  param([System.Windows.Automation.AutomationElement] $Root)
  try {
    $rootId = @($Root.GetRuntimeId())
    $current = [System.Windows.Automation.AutomationElement]::FocusedElement
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    for ($depth = 0; $depth -lt 64 -and $null -ne $current; $depth += 1) {
      if (Test-OrbitRuntimeId @($current.GetRuntimeId()) $rootId) { return $true }
      $current = $walker.GetParent($current)
    }
  } catch {
    return $false
  }
  return $false
}

function Get-OrbitAutomationPatterns {
  param([System.Windows.Automation.AutomationElement] $Element)
  $patterns = New-Object System.Collections.Generic.List[string]
  $patternObject = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref] $patternObject)) { $patterns.Add('invoke') }
  $patternObject = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref] $patternObject)) { $patterns.Add('toggle') }
  $patternObject = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref] $patternObject)) { $patterns.Add('select') }
  $patternObject = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref] $patternObject)) { $patterns.Add('value') }
  $patternObject = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref] $patternObject)) { $patterns.Add('scroll') }
  return @($patterns)
}

function Get-OrbitAutomationRecord {
  param([System.Windows.Automation.AutomationElement] $Element, [int] $Depth)
  try {
    $current = $Element.Current
    if ($current.IsPassword) { return $null }
    $name = [string] $current.Name
    if ($name.Length -gt 300) { $name = $name.Substring(0, 300) }
    $role = ([string] $current.ControlType.ProgrammaticName) -replace '^ControlType\.', ''
    $bounds = $current.BoundingRectangle
    return @{
      runtimeId = @($Element.GetRuntimeId() | ForEach-Object { [int] $_ })
      role = $role.Substring(0, [Math]::Min(80, $role.Length))
      name = $name
      enabled = [bool] $current.IsEnabled
      offscreen = [bool] $current.IsOffscreen
      isPassword = [bool] $current.IsPassword
      depth = $Depth
      bounds = @{
        x = [int] [Math]::Round($bounds.X)
        y = [int] [Math]::Round($bounds.Y)
        width = [int] [Math]::Max(0, [Math]::Round($bounds.Width))
        height = [int] [Math]::Max(0, [Math]::Round($bounds.Height))
      }
      patterns = @(Get-OrbitAutomationPatterns $Element)
    }
  } catch {
    return $null
  }
}

function Get-OrbitAutomationTree {
  param([long] $WindowHandle, [int] $MaxElements, [int] $MaxDepth)
  Initialize-OrbitUiAutomation
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr] $WindowHandle)
  if ($null -eq $root) { throw 'The active window does not expose Windows UI Automation.' }
  if (-not (Test-OrbitAutomationWindowFocused $root)) { throw 'The foreground window changed before UI Automation inspection.' }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = New-Object System.Collections.ArrayList
  [void] $queue.Add([pscustomobject] @{ element = $root; depth = 0 })
  $records = New-Object System.Collections.ArrayList
  $truncated = $false
  while ($queue.Count -gt 0) {
    $item = $queue[0]
    $queue.RemoveAt(0)
    $record = Get-OrbitAutomationRecord $item.element $item.depth
    if ($null -ne $record) { [void] $records.Add($record) }
    if ($records.Count -ge $MaxElements) { $truncated = $queue.Count -gt 0; break }
    if ($item.depth -ge $MaxDepth) { continue }
    try {
      $child = $walker.GetFirstChild($item.element)
      while ($null -ne $child) {
        [void] $queue.Add([pscustomobject] @{ element = $child; depth = $item.depth + 1 })
        $child = $walker.GetNextSibling($child)
      }
    } catch {
      # Ignore a provider subtree that disappears while the snapshot is being read.
    }
  }
  return @{ elements = @($records); truncated = [bool] $truncated }
}

function Find-OrbitAutomationElement {
  param([long] $WindowHandle, [object[]] $RuntimeId)
  Initialize-OrbitUiAutomation
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr] $WindowHandle)
  if ($null -eq $root) { return $null }
  if (-not (Test-OrbitAutomationWindowFocused $root)) { throw 'The foreground window changed before the UI Automation action.' }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = New-Object System.Collections.ArrayList
  [void] $queue.Add([pscustomobject] @{ element = $root; depth = 0 })
  $visited = 0
  while ($queue.Count -gt 0 -and $visited -lt 1200) {
    $item = $queue[0]
    $queue.RemoveAt(0)
    $visited += 1
    try {
      if (Test-OrbitRuntimeId @($item.element.GetRuntimeId()) $RuntimeId) { return $item.element }
      if ($item.depth -ge 20) { continue }
      $child = $walker.GetFirstChild($item.element)
      while ($null -ne $child) {
        [void] $queue.Add([pscustomobject] @{ element = $child; depth = $item.depth + 1 })
        $child = $walker.GetNextSibling($child)
      }
    } catch {
      # Continue past elements invalidated by an application update.
    }
  }
  return $null
}

function Invoke-OrbitAutomationAction {
  param([string] $Action, [long] $WindowHandle, [object[]] $RuntimeId, [string] $Text, [string] $Direction, [string] $Amount)
  $element = Find-OrbitAutomationElement $WindowHandle $RuntimeId
  if ($null -eq $element) { throw 'The selected control is no longer available.' }
  $current = $element.Current
  if ($current.IsPassword -or -not $current.IsEnabled -or $current.IsOffscreen) { throw 'The selected control is not safe and available.' }
  $patternObject = $null
  switch ($Action) {
    'invoke' {
      if (-not $element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref] $patternObject)) { throw 'That control cannot be invoked.' }
      ([System.Windows.Automation.InvokePattern] $patternObject).Invoke()
    }
    'toggle' {
      if (-not $element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref] $patternObject)) { throw 'That control cannot be toggled.' }
      ([System.Windows.Automation.TogglePattern] $patternObject).Toggle()
    }
    'select' {
      if (-not $element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref] $patternObject)) { throw 'That control cannot be selected.' }
      ([System.Windows.Automation.SelectionItemPattern] $patternObject).Select()
    }
    'setText' {
      if (-not $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref] $patternObject)) { throw 'That control does not accept safe text entry.' }
      $valuePattern = [System.Windows.Automation.ValuePattern] $patternObject
      if ($valuePattern.Current.IsReadOnly) { throw 'That control is read-only.' }
      $valuePattern.SetValue($Text)
    }
    'scroll' {
      if (-not $element.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref] $patternObject)) { throw 'That control cannot be scrolled.' }
      $scroll = [System.Windows.Automation.ScrollPattern] $patternObject
      $vertical = if ($Direction -eq 'up') { [System.Windows.Automation.ScrollAmount]::SmallDecrement } else { [System.Windows.Automation.ScrollAmount]::SmallIncrement }
      $repetitions = if ($Amount -eq 'small') { 1 } elseif ($Amount -eq 'medium') { 3 } else { 1 }
      if ($Amount -eq 'large') {
        $vertical = if ($Direction -eq 'up') { [System.Windows.Automation.ScrollAmount]::LargeDecrement } else { [System.Windows.Automation.ScrollAmount]::LargeIncrement }
      }
      for ($index = 0; $index -lt $repetitions; $index += 1) {
        $scroll.Scroll([System.Windows.Automation.ScrollAmount]::NoAmount, $vertical)
      }
    }
    default { throw 'The UI Automation action is not registered.' }
  }
  $record = Get-OrbitAutomationRecord $element 0
  if ($null -eq $record) { throw 'The control changed before Orbit could verify it.' }
  return @{ name = [string] $record.name; role = [string] $record.role; action = $Action }
}

function Initialize-OrbitMediaControl {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [void] [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  [void] [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
}

function Wait-OrbitWinRtOperation {
  param([object] $Operation, [Type] $ResultType)
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
      $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } |
    Select-Object -First 1
  if ($null -eq $method) { throw 'The Windows media async bridge is unavailable.' }
  $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  return $task.GetAwaiter().GetResult()
}

function Get-OrbitMediaManager {
  Initialize-OrbitMediaControl
  $operation = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()
  return Wait-OrbitWinRtOperation $operation ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
}

function Get-OrbitMediaSession {
  param([object] $Manager, [string] $SourceApplication)
  if ([string]::IsNullOrWhiteSpace($SourceApplication)) { return $Manager.GetCurrentSession() }
  $requested = $SourceApplication.Trim().ToLowerInvariant()
  return @($Manager.GetSessions() | Where-Object {
    ([string] $_.SourceAppUserModelId).ToLowerInvariant().Contains($requested)
  } | Select-Object -First 1)[0]
}

function Get-OrbitMediaSessionRecord {
  param([object] $Session)
  if ($null -eq $Session) { return $null }
  $source = [string] $Session.SourceAppUserModelId
  $status = ([string] $Session.GetPlaybackInfo().PlaybackStatus).ToLowerInvariant()
  $result = @{ sourceApplication = $source.Substring(0, [Math]::Min(200, $source.Length)); playbackStatus = $status }
  try {
    $properties = Wait-OrbitWinRtOperation $Session.TryGetMediaPropertiesAsync() ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    foreach ($property in @('Title', 'Artist', 'AlbumTitle')) {
      $value = [string] $properties.$property
      if (-not [string]::IsNullOrWhiteSpace($value)) {
        $safeName = if ($property -eq 'AlbumTitle') { 'albumTitle' } else { $property.Substring(0, 1).ToLowerInvariant() + $property.Substring(1) }
        $result[$safeName] = $value.Substring(0, [Math]::Min(300, $value.Length))
      }
    }
  } catch {
    # Playback state remains useful when metadata is unavailable.
  }
  try {
    $timeline = $Session.GetTimelineProperties()
    if ($timeline.EndTime.TotalSeconds -ge 0) { $result.durationSeconds = [Math]::Round($timeline.EndTime.TotalSeconds, 3) }
    if ($timeline.Position.TotalSeconds -ge 0) { $result.positionSeconds = [Math]::Round($timeline.Position.TotalSeconds, 3) }
  } catch {
    # Some media providers omit timeline information.
  }
  return $result
}

function Invoke-OrbitMediaAction {
  param([string] $Action, [string] $SourceApplication)
  $manager = Get-OrbitMediaManager
  $session = Get-OrbitMediaSession $manager $SourceApplication
  if ($null -eq $session) { throw 'No matching Windows media session is available.' }
  $operation = switch ($Action) {
    'play' { $session.TryPlayAsync() }
    'pause' { $session.TryPauseAsync() }
    'nextTrack' { $session.TrySkipNextAsync() }
    'previousTrack' { $session.TrySkipPreviousAsync() }
    default { throw 'The media action is not registered.' }
  }
  $accepted = [bool] (Wait-OrbitWinRtOperation $operation ([bool]))
  if (-not $accepted) { throw 'The media application rejected that control request.' }
  Start-Sleep -Milliseconds 250
  return @{ accepted = $true; state = Get-OrbitMediaSessionRecord $session }
}

try {
  $raw = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($raw) -or $raw.Length -gt 32768) {
    throw 'The fixed-operation request is invalid.'
  }

  $request = $raw | ConvertFrom-Json
  Assert-ExactProperties $request @('operationId', 'parameters')
  if ($request.operationId -isnot [string] -or $request.parameters -eq $null) {
    throw 'The fixed-operation request is invalid.'
  }

  switch ($request.operationId) {
    'system.getBattery' {
      Assert-ExactProperties $request.parameters @()
      $batteries = @(Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue)
      if ($batteries.Count -eq 0) {
        Write-OrbitJson @{ ok = $true; data = @{ present = $false } }
      }
      $percentValues = @($batteries | ForEach-Object { [int] $_.EstimatedChargeRemaining })
      $percent = [Math]::Max(0, [Math]::Min(100, [int](($percentValues | Measure-Object -Average).Average)))
      $chargingCodes = @(2, 6, 7, 8, 9, 11)
      $charging = @($batteries | Where-Object { $chargingCodes -contains [int] $_.BatteryStatus }).Count -gt 0
      Write-OrbitJson @{ ok = $true; data = @{ present = $true; percent = $percent; charging = $charging } }
    }

    'system.getNetworkStatus' {
      Assert-ExactProperties $request.parameters @()
      $adapters = @(Get-NetAdapter -ErrorAction SilentlyContinue |
        Where-Object { $_.HardwareInterface -eq $true } |
        Sort-Object -Property Name |
        Select-Object -First 20)
      $safeAdapters = @($adapters | ForEach-Object {
        @{ name = [string] $_.Name; status = [string] $_.Status; linkSpeed = [string] $_.LinkSpeed }
      })
      $online = @($adapters | Where-Object { $_.Status -eq 'Up' }).Count -gt 0
      Write-OrbitJson @{ ok = $true; data = @{ online = $online; interfaces = $safeAdapters } }
    }

    'process.listUser' {
      Assert-ExactProperties $request.parameters @('limit')
      $limit = [int] $request.parameters.limit
      if ($limit -lt 1 -or $limit -gt 100) { throw 'The process result limit is invalid.' }
      $sessionId = (Get-Process -Id $PID).SessionId
      $blocked = Get-BlockedProcessNames
      $items = @(Get-Process -ErrorAction SilentlyContinue |
        Where-Object {
          $_.SessionId -eq $sessionId -and
          $_.MainWindowHandle -ne 0 -and
          $blocked -notcontains $_.ProcessName.ToLowerInvariant()
        } |
        Sort-Object -Property ProcessName, Id |
        Select-Object -First $limit |
        ForEach-Object {
          @{ pid = [int] $_.Id; name = [string] $_.ProcessName; windowTitle = ([string] $_.MainWindowTitle).Substring(0, [Math]::Min(200, ([string] $_.MainWindowTitle).Length)) }
        })
      Write-OrbitJson @{ ok = $true; data = @{ processes = $items; truncated = ($items.Count -ge $limit) } }
    }

    'process.stopUser' {
      Assert-ExactProperties $request.parameters @('pid', 'orbitPid')
      $targetPid = [int] $request.parameters.pid
      $orbitPid = [int] $request.parameters.orbitPid
      if ($targetPid -le 0 -or $targetPid -eq $orbitPid -or $targetPid -eq $PID) {
        throw 'That process is protected.'
      }
      $target = Get-Process -Id $targetPid -ErrorAction Stop
      $sessionId = (Get-Process -Id $PID).SessionId
      $blocked = Get-BlockedProcessNames
      if (
        $target.SessionId -ne $sessionId -or
        $target.MainWindowHandle -eq 0 -or
        $blocked -contains $target.ProcessName.ToLowerInvariant()
      ) {
        throw 'That process is not an ordinary current-user application.'
      }
      $name = [string] $target.ProcessName
      Stop-Process -Id $targetPid -ErrorAction Stop
      Write-OrbitJson @{ ok = $true; data = @{ pid = $targetPid; name = $name } }
    }

    'desktop.inspectActiveWindow' {
      Assert-ExactProperties $request.parameters @('windowHandle', 'maxElements', 'maxDepth')
      $windowHandle = [long] $request.parameters.windowHandle
      $maxElements = [int] $request.parameters.maxElements
      $maxDepth = [int] $request.parameters.maxDepth
      if ($windowHandle -le 0 -or $maxElements -lt 1 -or $maxElements -gt 150 -or $maxDepth -lt 1 -or $maxDepth -gt 12) {
        throw 'The UI Automation inspection parameters are invalid.'
      }
      $tree = Get-OrbitAutomationTree $windowHandle $maxElements $maxDepth
      Write-OrbitJson @{ ok = $true; data = @{ windowHandle = $windowHandle; elements = @($tree.elements); truncated = [bool] $tree.truncated } }
    }

    'desktop.invoke' {
      Assert-ExactProperties $request.parameters @('windowHandle', 'runtimeId')
      $data = Invoke-OrbitAutomationAction 'invoke' ([long] $request.parameters.windowHandle) @($request.parameters.runtimeId) '' '' ''
      Write-OrbitJson @{ ok = $true; data = $data }
    }

    'desktop.toggle' {
      Assert-ExactProperties $request.parameters @('windowHandle', 'runtimeId')
      $data = Invoke-OrbitAutomationAction 'toggle' ([long] $request.parameters.windowHandle) @($request.parameters.runtimeId) '' '' ''
      Write-OrbitJson @{ ok = $true; data = $data }
    }

    'desktop.select' {
      Assert-ExactProperties $request.parameters @('windowHandle', 'runtimeId')
      $data = Invoke-OrbitAutomationAction 'select' ([long] $request.parameters.windowHandle) @($request.parameters.runtimeId) '' '' ''
      Write-OrbitJson @{ ok = $true; data = $data }
    }

    'desktop.setText' {
      Assert-ExactProperties $request.parameters @('windowHandle', 'runtimeId', 'text')
      $text = [string] $request.parameters.text
      if ([string]::IsNullOrEmpty($text) -or $text.Length -gt 4000 -or $text.IndexOfAny([char[]] @(0, 9, 10, 13)) -ge 0) {
        throw 'The safe text input is invalid.'
      }
      $data = Invoke-OrbitAutomationAction 'setText' ([long] $request.parameters.windowHandle) @($request.parameters.runtimeId) $text '' ''
      Write-OrbitJson @{ ok = $true; data = $data }
    }

    'desktop.scroll' {
      Assert-ExactProperties $request.parameters @('windowHandle', 'runtimeId', 'direction', 'amount')
      $direction = [string] $request.parameters.direction
      $amount = [string] $request.parameters.amount
      if (@('up', 'down') -notcontains $direction -or @('small', 'medium', 'large') -notcontains $amount) { throw 'The scroll request is invalid.' }
      $data = Invoke-OrbitAutomationAction 'scroll' ([long] $request.parameters.windowHandle) @($request.parameters.runtimeId) '' $direction $amount
      Write-OrbitJson @{ ok = $true; data = $data }
    }

    'media.getSessions' {
      Assert-ExactProperties $request.parameters @()
      $manager = Get-OrbitMediaManager
      $sessions = @($manager.GetSessions() | ForEach-Object { Get-OrbitMediaSessionRecord $_ })
      Write-OrbitJson @{ ok = $true; data = @{ sessions = @($sessions) } }
    }

    'media.getPlaybackState' {
      Assert-ExactProperties $request.parameters @('sourceApplication')
      $source = [string] $request.parameters.sourceApplication
      if ($source.Length -gt 120) { throw 'The media source is invalid.' }
      $manager = Get-OrbitMediaManager
      $session = Get-OrbitMediaSession $manager $source
      if ($null -eq $session) { throw 'No matching Windows media session is available.' }
      Write-OrbitJson @{ ok = $true; data = Get-OrbitMediaSessionRecord $session }
    }

    'media.play' {
      Assert-ExactProperties $request.parameters @('sourceApplication')
      Write-OrbitJson @{ ok = $true; data = Invoke-OrbitMediaAction 'play' ([string] $request.parameters.sourceApplication) }
    }

    'media.pause' {
      Assert-ExactProperties $request.parameters @('sourceApplication')
      Write-OrbitJson @{ ok = $true; data = Invoke-OrbitMediaAction 'pause' ([string] $request.parameters.sourceApplication) }
    }

    'media.nextTrack' {
      Assert-ExactProperties $request.parameters @('sourceApplication')
      Write-OrbitJson @{ ok = $true; data = Invoke-OrbitMediaAction 'nextTrack' ([string] $request.parameters.sourceApplication) }
    }

    'media.previousTrack' {
      Assert-ExactProperties $request.parameters @('sourceApplication')
      Write-OrbitJson @{ ok = $true; data = Invoke-OrbitMediaAction 'previousTrack' ([string] $request.parameters.sourceApplication) }
    }

    'display.setBrightness' {
      Assert-ExactProperties $request.parameters @('percent')
      $percent = [int] $request.parameters.percent
      if ($percent -lt 0 -or $percent -gt 100) { throw 'The brightness percentage is invalid.' }
      $methods = @(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop)
      if ($methods.Count -eq 0) { throw 'This display does not expose software brightness control.' }
      foreach ($method in $methods) {
        Invoke-CimMethod -InputObject $method -MethodName WmiSetBrightness -Arguments @{ Timeout = 1; Brightness = [byte] $percent } -ErrorAction Stop | Out-Null
      }
      Write-OrbitJson @{ ok = $true; data = @{ percent = $percent } }
    }

    'system.lock' {
      Assert-ExactProperties $request.parameters @()
      Start-Process -FilePath 'rundll32.exe' -ArgumentList @('user32.dll,LockWorkStation') -WindowStyle Hidden
      Write-OrbitJson @{ ok = $true; data = @{ accepted = $true } }
    }

    'system.signOut' {
      Assert-ExactProperties $request.parameters @()
      Start-Process -FilePath 'shutdown.exe' -ArgumentList @('/l') -WindowStyle Hidden
      Write-OrbitJson @{ ok = $true; data = @{ accepted = $true } }
    }

    'system.restart' {
      Assert-ExactProperties $request.parameters @()
      Start-Process -FilePath 'shutdown.exe' -ArgumentList @('/r', '/t', '0') -WindowStyle Hidden
      Write-OrbitJson @{ ok = $true; data = @{ accepted = $true } }
    }

    'system.shutdown' {
      Assert-ExactProperties $request.parameters @()
      Start-Process -FilePath 'shutdown.exe' -ArgumentList @('/s', '/t', '0') -WindowStyle Hidden
      Write-OrbitJson @{ ok = $true; data = @{ accepted = $true } }
    }

    default {
      throw 'The fixed Windows operation is not registered.'
    }
  }
} catch {
  $message = [string] $_.Exception.Message
  if ($message.Length -gt 500) { $message = $message.Substring(0, 500) }
  Write-OrbitJson @{ ok = $false; code = 'WINDOWS_FIXED_OPERATION_FAILED'; message = $message }
}
