# 編出 dev / prod 兩個 release APK，放進前端的 public/app/，
# ⚠️ 這支檔案要存成「UTF-8 含 BOM」：Windows PowerShell 5.1 讀沒有 BOM 的檔會當成 ANSI，中文字串整支解析失敗。
# 之後照一般流程部署前端，兩個 Pages 站台就各自有得下載、App 也各自收得到更新。
#
#   powershell -ExecutionPolicy Bypass -File apps/android/publish-apk.ps1
#
# ⚠️ 發版前先把 version.properties 的 versionCode +1，不然已經裝了的 App 不會認為有新版。
# ⚠️ public/app/ 在 .gitignore 裡：換一台電腦部署前端之前要先跑一次這支，
#    不然 Pages 上的 APK 會被那一次部署整個蓋掉（direct upload 是整站覆寫）。
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $here '..\frontend\public\app'

if (-not $env:JAVA_HOME) {
  $jdk = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Android\jdk') -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($jdk) { $env:JAVA_HOME = $jdk.FullName }
}
if (-not (Test-Path (Join-Path $here 'keystore.properties'))) {
  throw 'apps/android/keystore.properties 不存在，release APK 會是沒簽章的（裝不起來）'
}

# 明寫 UTF8：5.1 的 Get-Content 預設當 ANSI 讀，註解裡的中文會把整份解壞
$text = [IO.File]::ReadAllText((Join-Path $here 'version.properties'), [Text.Encoding]::UTF8)
$props = @{}
foreach ($m in [regex]::Matches($text, '(?m)^\s*(version\w+)\s*=\s*(\S+)\s*$')) { $props[$m.Groups[1].Value] = $m.Groups[2].Value }
if (-not $props['versionCode']) { throw 'version.properties 裡讀不到 versionCode' }
$code = [int]$props['versionCode']
$name = $props['versionName']

Push-Location $here
try {
  & .\gradlew.bat assembleDevRelease assembleProdRelease --console=plain -q --no-daemon
  if ($LASTEXITCODE -ne 0) { throw "gradle 失敗（$LASTEXITCODE）" }
} finally { Pop-Location }

New-Item -ItemType Directory -Force $out | Out-Null
foreach ($flavor in 'dev', 'prod') {
  $apk = Join-Path $here "app\build\outputs\apk\$flavor\release\app-$flavor-release.apk"
  Copy-Item $apk (Join-Path $out "didadida-$flavor.apk") -Force
  $vn = if ($flavor -eq 'dev') { "$name-dev" } else { $name }
  $json = @{ versionCode = $code; versionName = $vn; apk = "didadida-$flavor.apk" } | ConvertTo-Json -Compress
  # 不帶 BOM：Updater 用 JSONObject 解，BOM 會讓它整個解不開
  [IO.File]::WriteAllText((Join-Path $out "version-$flavor.json"), $json, (New-Object Text.UTF8Encoding $false))
}
Get-ChildItem $out | Format-Table Name, Length
Write-Host "版本 $name（$code）已放進 apps/frontend/public/app/，接著照 CLAUDE.md 部署前端。"
