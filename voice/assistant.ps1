<#
.SYNOPSIS
  Voice assistant: you speak, the brain (LLM) answers, Windows speaks the reply.

.DESCRIPTION
  Ears:  Windows speech recognition (offline, System.Speech dictation)
  Brain: Node server in brain/ (started for you if it is not running)
  Mouth: Windows text to speech, sentence by sentence as the answer streams in

.EXAMPLE
  .\start.cmd                      # voice mode
  .\start.cmd -Typed               # type questions, hear the answers
  .\start.cmd -Typed -NoSpeak      # text only
  .\start.cmd -Culture en-GB       # use the UK English recognizer
#>
param(
    # Type questions instead of speaking them.
    [switch]$Typed,
    # Print answers only, do not speak them.
    [switch]$NoSpeak,
    # Recognize one WAV file instead of the microphone, answer, and exit (for testing).
    [string]$InputWav,
    # Speech recognizer language. Installed: en-US, en-GB.
    [string]$Culture = 'en-US',
    # Ignore what was heard when the recognizer is less sure than this (0 to 1).
    [double]$MinConfidence = 0.3,
    # Silence (ms) that ends your question. 0 = Windows default. Lower = faster, but may cut you off.
    [int]$EndSilenceMs = 0,
    # Seconds to wait for you to start talking before listening again.
    [int]$ListenSec = 10,
    # Part of the voice name: Zira, David, Hazel.
    [string]$Voice = 'Zira',
    # Speaking speed, -10 to 10.
    [int]$Rate = 1,
    # Do not search the notes folder.
    [switch]$NoNotes
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'VoiceLib.ps1')

$mode = if ($InputWav) { 'wav' } elseif ($Typed) { 'typed' } else { 'voice' }
$url = Get-BrainUrl
$sessionId = 'ps-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$useNotes = -not $NoNotes
$brainProcess = $null
$mouth = $null
$ears = $null

function Say([string]$Text) {
    Write-Host "  $Text" -ForegroundColor Green
    if ($mouth) { [void]$mouth.Speak($Text) }
}

try {
    # ------------------------------------------------------------ brain
    $health = Test-Brain $url
    if (-not $health) {
        Write-Host 'Starting the brain...' -ForegroundColor DarkGray
        $brainProcess = Start-Brain $url
        $health = Test-Brain $url
    }
    $notesText = if ($health.notes.enabled -and $useNotes) { "$($health.notes.files) files, $($health.notes.chunks) chunks" } else { 'off' }
    $fallback = if ($health.fallbackModels) { " (fallback: $($health.fallbackModels -join ', '))" } else { '' }
    Write-Host ''
    Write-Host "Voice assistant | brain: $($health.model)$fallback | notes: $notesText" -ForegroundColor Cyan

    # ------------------------------------------------------------ mouth and ears
    if (-not $NoSpeak) { $mouth = New-Mouth -Voice $Voice -Rate $Rate }
    if ($mode -eq 'voice') { $ears = New-Ears -Culture $Culture -EndSilenceMs $EndSilenceMs }
    if ($mode -eq 'wav') { $ears = New-Ears -Culture $Culture -EndSilenceMs $EndSilenceMs -WavPath $InputWav }

    if ($mode -eq 'voice') {
        Write-Host 'Speak after "Listening...". Say "goodbye" to stop. Press any key to cut an answer short.' -ForegroundColor DarkGray
        Say 'Hi. I am listening.'
    } elseif ($mode -eq 'typed') {
        Write-Host 'Type a question and press Enter. Type "goodbye" or press Ctrl+C to stop.' -ForegroundColor DarkGray
    }

    # ------------------------------------------------------------ loop
    while ($true) {
        $heard = $null
        if ($mode -eq 'typed') {
            Write-Host 'you> ' -NoNewline -ForegroundColor Yellow
            $line = [Console]::In.ReadLine()
            if ($null -eq $line) { break }      # end of piped input
            if (-not $line.Trim()) { continue }
            if ([Console]::IsInputRedirected) { Write-Host $line }
            $heard = [pscustomobject]@{ Text = $line.Trim(); Confidence = 1.0; SpeechMs = $null; SttMs = $null }
        } else {
            if ($mode -eq 'voice') {
                Clear-KeyBuffer
                Write-Host 'Listening...' -ForegroundColor DarkGray
            }
            $heard = Receive-Speech $ears $ListenSec
            if ($null -eq $heard) {
                if ($mode -eq 'wav') { Write-Host 'Nothing recognized in the WAV file.' -ForegroundColor Red; break }
                continue                          # nobody spoke; listen again
            }
            if ($mode -eq 'wav') { $heard.SttMs = $null }   # a file is read faster than real time
            if ($heard.Confidence -lt $MinConfidence) {
                Write-Host ("  (ignored ""{0}"", confidence {1})" -f $heard.Text, $heard.Confidence) -ForegroundColor DarkGray
                # Room noise comes back as junk with confidence near 0. Ignore it quietly.
                # Only apologise when it was close, so it was probably you talking.
                if ($heard.Confidence -ge ($MinConfidence / 2) -and $heard.SpeechMs -gt 600) { Say 'Sorry, I did not catch that.' }
                if ($mode -eq 'wav') { break }
                continue
            }
            Write-Host ("you> {0}" -f $heard.Text) -ForegroundColor Yellow -NoNewline
            $timing = if ($null -ne $heard.SttMs) { ", text ready $(Format-Seconds $heard.SttMs) after you stopped" } else { '' }
            Write-Host ("   (confidence {0}{1})" -f $heard.Confidence, $timing) -ForegroundColor DarkGray
        }
        $afterHearing = [Diagnostics.Stopwatch]::StartNew()

        # ---- things the laptop does by itself
        $local = Get-LocalCommand $heard.Text
        if ($local) {
            switch ($local.Kind) {
                'run'   { Start-Process $local.Exe }
                'reset' { Reset-Brain $url $sessionId }
                'notes' { $useNotes = $local.On }
            }
            Say $local.Say
            if ($local.Kind -eq 'exit' -or $mode -eq 'wav') { break }
            continue
        }

        # ---- ask the brain, speak each sentence the moment it arrives
        $prompts = New-Object System.Collections.ArrayList
        $script:firstAudioMs = $null
        $onSentence = {
            param($sentence)
            if ($null -eq $script:firstAudioMs) { $script:firstAudioMs = $afterHearing.ElapsedMilliseconds }
            Write-Host "  $sentence" -ForegroundColor Green
            if ($mouth) { [void]$prompts.Add($mouth.SpeakAsync($sentence)) }
        }
        $reply = Invoke-Brain -Url $url -Question $heard.Text -SessionId $sessionId -UseNotes $useNotes -OnSentence $onSentence

        if ($reply.Error) {
            Write-Host "  [error] $($reply.Error.detail)" -ForegroundColor Red
            Say $reply.Error.message
        }
        $cut = Wait-Speech $mouth $prompts
        if ($cut) { Write-Host '  (stopped)' -ForegroundColor DarkGray }

        # ---- timings
        $row = [ordered]@{
            ts                       = (Get-Date).ToUniversalTime().ToString('o')
            mode                     = $mode
            question                 = $heard.Text
            confidence               = $heard.Confidence
            speech_ms                = $heard.SpeechMs
            stt_ms                   = $heard.SttMs
            client_first_sentence_ms = $reply.FirstSentenceMs
            client_total_ms          = $reply.TotalMs
            voice_to_voice_ms        = $null
            error                    = $(if ($reply.Error) { $reply.Error.detail } else { $null })
        }
        if ($mode -eq 'voice' -and $null -ne $heard.SttMs -and $null -ne $script:firstAudioMs) {
            # You stop talking -> the assistant starts talking.
            $row.voice_to_voice_ms = $heard.SttMs + $script:firstAudioMs
        }
        Add-BrainStats $row $reply.Done
        Write-TurnLog $row

        if ($reply.Done) {
            $s = $reply.Done.stats
            $parts = @("first sentence $(Format-Seconds $reply.FirstSentenceMs)", "full answer $(Format-Seconds $reply.TotalMs)")
            if ($null -ne $row.voice_to_voice_ms) { $parts = @("you stopped -> it spoke $(Format-Seconds $row.voice_to_voice_ms)") + $parts }
            if ($s.tokens_per_sec) { $parts += "$($s.tokens_per_sec) tok/s" }
            $parts += $s.model
            Write-Host ("  [{0}]" -f ($parts -join ' | ')) -ForegroundColor DarkGray
            if ($reply.Done.sources -and $reply.Done.sources.Count -gt 0) {
                $names = ($reply.Done.sources | ForEach-Object { "$($_.file) > $($_.heading)" }) -join '; '
                Write-Host "  [notes: $names]" -ForegroundColor DarkGray
            }
        }
        if ($mode -eq 'wav') { break }
    }
} finally {
    if ($mouth) { $mouth.Dispose() }
    if ($ears) { $ears.Dispose() }
    Stop-Brain $brainProcess
}
