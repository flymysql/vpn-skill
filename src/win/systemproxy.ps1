# vpn-skill :: src/win/systemproxy.ps1
# Windows 系统代理开关。只改 HKCU（当前用户），不动 HKLM，不需要管理员。
# 关键点：写注册表后必须调 InternetSetOption 通知 WinINET，否则浏览器不会立刻生效。
param(
  [Parameter(Mandatory = $true)][ValidateSet('get', 'set', 'clear')][string]$Action,
  [string]$ProxyServer = '127.0.0.1:7890',
  [string]$Bypass = '<local>;localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*',
  [string]$BackupPath = ''
)

$ErrorActionPreference = 'Stop'
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'

$wininet = Add-Type -MemberDefinition @'
[DllImport("wininet.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
'@ -Name 'VpnSkillWinInet' -Namespace 'VpnSkill' -PassThru

function Sync-WinInet {
  # 39 = INTERNET_OPTION_SETTINGS_CHANGED, 37 = INTERNET_OPTION_REFRESH
  [void]$wininet::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
  [void]$wininet::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)
}

function Read-Current {
  $p = Get-ItemProperty -Path $key
  [pscustomobject]@{
    ProxyEnable     = [int]($p.ProxyEnable)
    ProxyServer     = [string]($p.ProxyServer)
    ProxyOverride   = [string]($p.ProxyOverride)
    AutoConfigURL   = [string]($p.AutoConfigURL)
    DefaultConnectionSettings = $null
  }
}

switch ($Action) {
  'get' {
    (Read-Current) | ConvertTo-Json -Compress
  }
  'set' {
    if ($BackupPath) {
      $dir = Split-Path -Parent $BackupPath
      if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
      if (-not (Test-Path $BackupPath)) {
        (Read-Current) | ConvertTo-Json -Depth 4 | Set-Content -Path $BackupPath -Encoding UTF8
      }
    }
    New-ItemProperty -Path $key -Name 'ProxyEnable' -Value 1 -PropertyType DWord -Force | Out-Null
    New-ItemProperty -Path $key -Name 'ProxyServer' -Value $ProxyServer -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $key -Name 'ProxyOverride' -Value $Bypass -PropertyType String -Force | Out-Null
    if ((Get-ItemProperty -Path $key).AutoConfigURL) {
      Remove-ItemProperty -Path $key -Name 'AutoConfigURL' -ErrorAction SilentlyContinue
    }
    Sync-WinInet
    (Read-Current) | ConvertTo-Json -Compress
  }
  'clear' {
    if ($BackupPath -and (Test-Path $BackupPath)) {
      $b = Get-Content -Path $BackupPath -Raw | ConvertFrom-Json
      New-ItemProperty -Path $key -Name 'ProxyEnable' -Value ([int]$b.ProxyEnable) -PropertyType DWord -Force | Out-Null
      New-ItemProperty -Path $key -Name 'ProxyServer' -Value ([string]$b.ProxyServer) -PropertyType String -Force | Out-Null
      New-ItemProperty -Path $key -Name 'ProxyOverride' -Value ([string]$b.ProxyOverride) -PropertyType String -Force | Out-Null
      if ($b.AutoConfigURL) {
        New-ItemProperty -Path $key -Name 'AutoConfigURL' -Value ([string]$b.AutoConfigURL) -PropertyType String -Force | Out-Null
      }
      Remove-Item -Path $BackupPath -Force -ErrorAction SilentlyContinue
    }
    else {
      New-ItemProperty -Path $key -Name 'ProxyEnable' -Value 0 -PropertyType DWord -Force | Out-Null
    }
    Sync-WinInet
    (Read-Current) | ConvertTo-Json -Compress
  }
}
