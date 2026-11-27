# Windows のインストーラー (NSIS) を実際に入れて確かめる (.github/workflows/desktop.yml から呼ぶ)。
#   pwsh apps/desktop/scripts/check-windows-installer.ps1 -Setup <Orbit_x.y.z_x64-setup.exe> -Legacy <Orbit-Mail_0.2.0_x64-setup.exe> -Out <画像の書き出し先>
# 1. 旧名 (Orbit Mail) の版を入れてから、自動更新と同じ引数 (/P /UPDATE) で新しい版を入れ、置き換わったことを確かめる。
# 2. アンインストール (/S) で、ショートカットや登録が消えることを確かめる。
# 3. 何も入っていない状態から、画面を出して入れる (ユーザーがダブルクリックしたとき)。画面を撮っておく。
# 4. アンインストールの確認の画面を撮る。
param(
  [Parameter(Mandatory = $true)][string]$Setup,
  [string]$Legacy = "",
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $Out | Out-Null

$uninstallRoot = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall"
$installDir = Join-Path $env:LOCALAPPDATA "Orbit"
$legacyDir = Join-Path $env:LOCALAPPDATA "Orbit Mail"
$programs = [Environment]::GetFolderPath("Programs")
$desktop = [Environment]::GetFolderPath("Desktop")
$shell = New-Object -ComObject WScript.Shell
$failures = @()

function Check([bool]$ok, [string]$what) {
  if ($ok) { Write-Host "OK: $what" } else { Write-Host "NG: $what"; $script:failures += $what }
}

function Stop-Orbit {
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq "orbit-desktop" -or $_.Name -eq "Un" -or $_.Name -like "Un_*" } |
    Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}

function Run([string]$file, [string[]]$arguments) {
  $process = if ($arguments.Count -gt 0) {
    Start-Process -FilePath $file -ArgumentList $arguments -PassThru
  } else {
    Start-Process -FilePath $file -PassThru
  }
  if (-not $process.WaitForExit(180000)) { throw "$file が終わりません" }
  return $process.ExitCode
}

# NSIS のアンインストーラーは一時フォルダーへ自分を写して動くので、その終わりを待つ。
function Wait-Uninstaller {
  Start-Sleep -Seconds 1
  for ($i = 0; $i -lt 120; $i++) {
    if (-not (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq "Un" -or $_.Name -like "Un_*" })) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "アンインストーラーが終わりません"
}

# 画面を一定の間隔で撮る (別のプロセスで)。
function Start-Recording([string]$prefix, [int]$seconds) {
  $script = @"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
`$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
`$end = (Get-Date).AddSeconds($seconds)
`$i = 0
while ((Get-Date) -lt `$end) {
  `$bitmap = New-Object System.Drawing.Bitmap `$bounds.Width, `$bounds.Height
  `$graphics = [System.Drawing.Graphics]::FromImage(`$bitmap)
  `$graphics.CopyFromScreen(`$bounds.Location, [System.Drawing.Point]::Empty, `$bounds.Size)
  `$bitmap.Save((Join-Path '$Out' ('$prefix-{0:D3}.png' -f `$i)), [System.Drawing.Imaging.ImageFormat]::Png)
  `$graphics.Dispose(); `$bitmap.Dispose()
  `$i++
  Start-Sleep -Milliseconds 150
}
"@
  return Start-Process -FilePath "powershell" -ArgumentList @("-NoProfile", "-Command", $script) -PassThru -WindowStyle Hidden
}

# 撮った画面から、画面の真ん中 (インストーラーの画面のあたり) を切り出し、変わったところだけを
# 小さな JPEG にしてログへ出す (成果物を開かなくても、ログから画面を確かめられるように)。
function Show-Frames([string]$prefix, [int]$max = 6) {
  Add-Type -AssemblyName System.Drawing
  $files = Get-ChildItem (Join-Path $Out "$prefix-*.png") | Sort-Object Name
  $md5 = [System.Security.Cryptography.MD5]::Create()
  $seen = @{}
  $picked = @()
  $first = $null
  foreach ($file in $files) {
    $image = [System.Drawing.Image]::FromFile($file.FullName)
    $w = [Math]::Min(600, $image.Width); $h = [Math]::Min(420, $image.Height)
    $rect = New-Object System.Drawing.Rectangle ([int](($image.Width - $w) / 2)), ([int](($image.Height - $h) / 2)), $w, $h
    $crop = ([System.Drawing.Bitmap]$image).Clone($rect, $image.PixelFormat)
    $image.Dispose()
    $stream = New-Object System.IO.MemoryStream
    $crop.Save($stream, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $hash = [Convert]::ToBase64String($md5.ComputeHash($stream.ToArray()))
    if ($null -eq $first) { $first = $hash }
    if ($hash -ne $first -and -not $seen.ContainsKey($hash)) {
      $seen[$hash] = $true
      $jpeg = New-Object System.IO.MemoryStream
      $crop.Save($jpeg, [System.Drawing.Imaging.ImageFormat]::Jpeg)
      $picked += ,@($file.Name, [Convert]::ToBase64String($jpeg.ToArray()))
    }
    $crop.Dispose()
  }
  if ($picked.Count -eq 0) { Write-Host "画面の変化なし: $prefix"; return }
  $step = [Math]::Max(1, [Math]::Ceiling($picked.Count / $max))
  for ($i = 0; $i -lt $picked.Count; $i += $step) {
    Write-Host ("ORBIT-SHOT {0} {1}" -f $picked[$i][0], $picked[$i][1])
  }
}

function Check-Installed([string]$label) {
  $key = Join-Path $uninstallRoot "Orbit"
  Check (Test-Path $key) "${label}: アプリと機能に Orbit がある"
  if (Test-Path $key) {
    $entry = Get-ItemProperty $key
    Check ($entry.DisplayName -eq "Orbit") "${label}: 表示名が Orbit"
    Check ($entry.Publisher -eq "Luna Project") "${label}: 発行元が Luna Project"
  }
  Check (-not (Test-Path (Join-Path $uninstallRoot "Orbit Mail"))) "${label}: 旧名 (Orbit Mail) の登録が無い"
  Check (Test-Path (Join-Path $installDir "orbit-desktop.exe")) "${label}: %LOCALAPPDATA%\Orbit に入っている"
  Check (Test-Path (Join-Path $installDir "icons\orbit-mail.ico")) "${label}: ショートカットのアイコンがある"
  Check (-not (Test-Path $legacyDir)) "${label}: 旧名のフォルダーが無い"
  $link = Join-Path $programs "Orbit Mail.lnk"
  Check (Test-Path $link) "${label}: スタートメニューに Orbit Mail がある"
  if (Test-Path $link) {
    $shortcut = $shell.CreateShortcut($link)
    Check ($shortcut.TargetPath -eq (Join-Path $installDir "orbit-desktop.exe")) "${label}: スタートメニューの Orbit Mail が新しい場所を指す"
    Check ($shortcut.Arguments -eq "--app=mail") "${label}: スタートメニューの Orbit Mail の引数が --app=mail"
  }
  Check (-not (Test-Path (Join-Path $programs "Orbit.lnk"))) "${label}: スタートメニューに「Orbit」だけの項目が無い"
  $command = (Get-ItemProperty "HKCU:\Software\Classes\jp.lunaproject.orbit.mail\shell\open\command" -ErrorAction SilentlyContinue)."(default)"
  Check ($command -like "*\Orbit\orbit-desktop.exe*") "${label}: ログインから戻る URL が新しい場所に登録されている ($command)"
}

function Check-Removed([string]$label) {
  Check (-not (Test-Path (Join-Path $uninstallRoot "Orbit"))) "${label}: アプリと機能から消えた"
  Check (-not (Test-Path (Join-Path $installDir "orbit-desktop.exe"))) "${label}: 実行ファイルが消えた"
  Check (-not (Test-Path (Join-Path $programs "Orbit Mail.lnk"))) "${label}: スタートメニューの Orbit Mail が消えた"
  Check (-not (Test-Path (Join-Path $desktop "Orbit Mail.lnk"))) "${label}: デスクトップの Orbit Mail が消えた"
  Check (-not (Test-Path "HKCU:\Software\Classes\jp.lunaproject.orbit.mail")) "${label}: ログインから戻る URL の登録が消えた"
}

# 1. 旧名からの自動更新
if ($Legacy -ne "") {
  Write-Host "== 旧名 (Orbit Mail) からの自動更新"
  Check ((Run $Legacy @("/S")) -eq 0) "旧版: 入った"
  Check (Test-Path (Join-Path $uninstallRoot "Orbit Mail")) "旧版: アプリと機能に Orbit Mail がある"
  $hadDesktop = Test-Path (Join-Path $desktop "Orbit Mail.lnk")
  # 自動更新は、終了する本体からインストーラーを /P /UPDATE (/R /ARGS) で起動する。
  $recording = Start-Recording "update" 20
  Check ((Run $Setup @("/P", "/UPDATE")) -eq 0) "更新: インストーラーが成功した"
  Stop-Orbit
  Check-Installed "更新"
  if ($hadDesktop) {
    Check (Test-Path (Join-Path $desktop "Orbit Mail.lnk")) "更新: デスクトップの Orbit Mail が作り直された"
  }
  $recording.WaitForExit() | Out-Null
  Show-Frames "update"

  Write-Host "== アンインストール (/S)"
  Check ((Run (Join-Path $installDir "uninstall.exe") @("/S")) -eq 0) "アンインストール: 成功した"
  Wait-Uninstaller
  Check-Removed "アンインストール"
}

# 2. 何も無い状態から、画面を出して入れる
Write-Host "== 新しく入れる (画面あり)"
$recording = Start-Recording "install" 25
Check ((Run $Setup @()) -eq 0) "新規: インストーラーが成功した"
Start-Sleep -Seconds 4
Check ($null -ne (Get-Process -Name "orbit-desktop" -ErrorAction SilentlyContinue)) "新規: 入れた後に Orbit が起動した"
Stop-Orbit
Check-Installed "新規"
Check (Test-Path (Join-Path $desktop "Orbit Mail.lnk")) "新規: デスクトップに Orbit Mail がある"
$recording.WaitForExit() | Out-Null
Show-Frames "install"

# 3. アンインストールの確認の画面
Write-Host "== アンインストールの確認の画面"
$recording = Start-Recording "uninstall" 8
Start-Process -FilePath (Join-Path $installDir "uninstall.exe") | Out-Null
$recording.WaitForExit() | Out-Null
Show-Frames "uninstall" 3
Stop-Orbit
Run (Join-Path $installDir "uninstall.exe") @("/S") | Out-Null
Wait-Uninstaller
Check-Removed "後片付け"

if ($failures.Count -gt 0) {
  Write-Host "確かめられなかったこと:"
  $failures | ForEach-Object { Write-Host " - $_" }
  exit 1
}
Write-Host "インストーラーの確認はすべて通りました。"
