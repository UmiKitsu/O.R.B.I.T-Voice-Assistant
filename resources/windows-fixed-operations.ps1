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
