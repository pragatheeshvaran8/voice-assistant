<#
.SYNOPSIS
  Silent end-to-end test. No microphone or speakers needed.

.DESCRIPTION
  For each test question:
    1. A Windows voice speaks the question into a 16 kHz WAV file (a fake person).
    2. Windows speech recognition turns that WAV back into text (the ears).
    3. The text goes to the brain, which streams the answer (the brain).
    4. The Zira voice speaks each sentence into another WAV file (the mouth).
  Then it prints how many words were heard right and how long each part took.
  WAV files are kept in logs/selftest so you can play them.

.EXAMPLE
  npm run selftest
  powershell -File voice\selftest.ps1 -NoBrain     # ears and mouth only, no LLM call
#>
param(
    [string[]]$Questions = @(
        'How many words did my speech test get right?',
        'What is a KV cache in a language model?',
        'Why do language models make things up?'
    ),
    [string]$Culture = 'en-US',
    # The voice that plays the person asking.
    [string]$PersonVoice = 'Zira',
    [switch]$NoBrain
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'VoiceLib.ps1')

function Split-Words([string]$Text) {
    return @(($Text.ToLowerInvariant() -replace "[^a-z0-9 ]", ' ').Split(' ', [StringSplitOptions]::RemoveEmptyEntries))
}

# Longest common subsequence of words = how many words were heard right, in order.
function Get-WordsRight([string]$Expected, [string]$Heard) {
    $a = Split-Words $Expected
    $b = Split-Words $Heard
    $dp = New-Object 'int[,]' ($a.Count + 1), ($b.Count + 1)
    for ($i = 1; $i -le $a.Count; $i++) {
        for ($j = 1; $j -le $b.Count; $j++) {
            $pi = $i - 1
            $pj = $j - 1
            if ($a[$pi] -eq $b[$pj]) {
                $dp[$i, $j] = $dp[$pi, $pj] + 1
            } else {
                $up = $dp[$pi, $j]
                $left = $dp[$i, $pj]
                $dp[$i, $j] = [Math]::Max($up, $left)
            }
        }
    }
    return @{ Right = $dp[$a.Count, $b.Count]; Total = $a.Count }
}

function Get-WavSeconds([string]$Path) {
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 44) { return 0 }
    $byteRate = [BitConverter]::ToInt32($bytes, 28)
    if ($byteRate -le 0) { return 0 }
    return [Math]::Round(($bytes.Length - 44) / $byteRate, 1)
}

$dir = Join-Path $script:VaRoot 'logs\selftest'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$failures = 0
$rows = @()
$brainProcess = $null

Write-Host 'Self-test: speech in a WAV file -> text -> brain -> speech in a WAV file' -ForegroundColor Cyan

# ---- 1. what is installed
$recognizers = ([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | ForEach-Object { $_.Culture.Name }) -join ', '
$probe = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = ($probe.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name }) -join ', '
$probe.Dispose()
$mic = 'not found'
try {
    $test = New-Ears -Culture $Culture
    $mic = 'OK'
    $test.Dispose()
} catch { $mic = "not available ($($_.Exception.Message))" }
Write-Host "  Recognizers: $recognizers"
Write-Host "  Voices:      $voices"
Write-Host "  Microphone:  $mic"

try {
    # ---- 2. the brain
    $url = Get-BrainUrl
    if (-not $NoBrain) {
        $health = Test-Brain $url
        if (-not $health) {
            Write-Host '  Starting the brain...' -ForegroundColor DarkGray
            $brainProcess = Start-Brain $url
            $health = Test-Brain $url
        }
        Write-Host "  Brain:       $($health.model) at $url, notes $($health.notes.files) files"
    }
    Write-Host ''

    $session = 'selftest-' + (Get-Date -Format 'HHmmss')
    for ($n = 0; $n -lt $Questions.Count; $n++) {
        $question = $Questions[$n]
        $qWav = Join-Path $dir ("q{0}.wav" -f ($n + 1))
        $aWav = Join-Path $dir ("a{0}.wav" -f ($n + 1))

        # Fake person says the question into a 16 kHz file.
        # (Zira is heard far better than David by the Windows recognizer.)
        $person = New-Mouth -Voice $PersonVoice -Rate 0 -WavPath $qWav -SampleRate 16000
        $person.Speak($question)
        $person.Dispose()

        # Ears: recognize the file.
        $ears = New-Ears -Culture $Culture -WavPath $qWav
        $watch = [Diagnostics.Stopwatch]::StartNew()
        $result = $ears.Recognize()
        $recognizeMs = $watch.ElapsedMilliseconds
        $ears.Dispose()
        $heard = if ($result) { $result.Text } else { '' }
        $confidence = if ($result) { [Math]::Round($result.Confidence, 2) } else { 0 }
        $words = Get-WordsRight $question $heard

        Write-Host ("Q{0} said:  {1}" -f ($n + 1), $question)
        Write-Host ("   heard:  {0}   ({1} of {2} words, confidence {3})" -f $heard, $words.Right, $words.Total, $confidence) -ForegroundColor Yellow

        $row = [ordered]@{
            ts = (Get-Date).ToUniversalTime().ToString('o'); mode = 'selftest'; question = $question; heard = $heard
            words_right = $words.Right; words_total = $words.Total; confidence = $confidence
            recognize_file_ms = $recognizeMs
        }
        if (-not $heard) { $failures++; Write-Host '   FAIL: nothing recognized' -ForegroundColor Red; continue }

        if (-not $NoBrain) {
            # Mouth: Zira speaks each streamed sentence into a file.
            $mouth = New-Mouth -Voice 'Zira' -Rate 1 -WavPath $aWav
            $prompts = New-Object System.Collections.ArrayList
            $reply = Invoke-Brain -Url $url -Question $heard -SessionId $session -UseNotes $true -OnSentence {
                param($sentence)
                [void]$prompts.Add($mouth.SpeakAsync($sentence))
            }
            $speakWatch = [Diagnostics.Stopwatch]::StartNew()
            [void](Wait-Speech $mouth $prompts)
            $row.tts_wait_after_stream_ms = $speakWatch.ElapsedMilliseconds
            $mouth.Dispose()

            if ($reply.Error) {
                $failures++
                Write-Host "   FAIL: $($reply.Error.message) $($reply.Error.detail)" -ForegroundColor Red
            } else {
                $audio = Get-WavSeconds $aWav
                Write-Host "  answer:  $($reply.Done.text)" -ForegroundColor Green
                $s = $reply.Done.stats
                Write-Host ("   [first sentence {0} | full answer {1} | {2} sentences, {3} s of audio | {4}]" -f (Format-Seconds $reply.FirstSentenceMs), (Format-Seconds $reply.TotalMs), $prompts.Count, $audio, $s.model) -ForegroundColor DarkGray
                if ($reply.Done.sources.Count -gt 0) {
                    Write-Host ("   [notes: {0}]" -f (($reply.Done.sources | ForEach-Object { "$($_.file) > $($_.heading)" }) -join '; ')) -ForegroundColor DarkGray
                }
                $row.client_first_sentence_ms = $reply.FirstSentenceMs
                $row.client_total_ms = $reply.TotalMs
                $row.answer_audio_sec = $audio
                Add-BrainStats $row $reply.Done
                if ($audio -le 0) { $failures++; Write-Host '   FAIL: the answer WAV is empty' -ForegroundColor Red }
            }
        }
        Write-TurnLog $row
        $rows += [pscustomobject]$row
        Write-Host ''
    }
} finally {
    Stop-Brain $brainProcess
}

$right = ($rows | Measure-Object -Property words_right -Sum).Sum
$total = ($rows | Measure-Object -Property words_total -Sum).Sum
Write-Host ("Ears heard {0} of {1} words right. WAV files: {2}" -f $right, $total, $dir) -ForegroundColor Cyan
if ($failures -gt 0) {
    Write-Host "SELF-TEST FAILED: $failures problem(s)" -ForegroundColor Red
    exit 1
}
Write-Host 'SELF-TEST PASSED' -ForegroundColor Green
exit 0
