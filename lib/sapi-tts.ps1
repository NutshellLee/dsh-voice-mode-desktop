param(
  [Parameter(Mandatory=$true)][string]$TextFile,
  [Parameter(Mandatory=$true)][string]$OutWav,
  [double]$Rate = 1.0
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = @($s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name })
$isChinese = $text -match '[\u4e00-\u9fff]'
$pick = $null
if ($isChinese) {
  foreach ($name in @('Microsoft Yaoyao', 'Microsoft Huihui Desktop', 'Microsoft Huihui')) {
    if ($voices -contains $name) { $pick = $name; break }
  }
} else {
  foreach ($name in @('Microsoft Zira Desktop', 'Microsoft Zira')) {
    if ($voices -contains $name) { $pick = $name; break }
  }
}
if (-not $pick) { $pick = $voices[0] }
$s.SelectVoice($pick)
$r = [int][math]::Round(($Rate - 1.0) * 4)
if ($r -lt -10) { $r = -10 }
if ($r -gt 10) { $r = 10 }
$s.Rate = $r
$s.SetOutputToWaveFile($OutWav)
$s.Speak($text)
$s.Dispose()
