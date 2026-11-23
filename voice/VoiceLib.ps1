# Shared helpers for the voice client. Dot-source this file:  . "$PSScriptRoot\VoiceLib.ps1"
#
#   Ears   New-Ears, Receive-Speech      Windows speech recognition (System.Speech, offline)
#   Mouth  New-Mouth, Wait-Speech        Windows text to speech (Microsoft Zira)
#   Brain  Start-Brain, Invoke-Brain     the Node server, streamed one sentence at a time
#
# Keep this file ASCII only. Windows PowerShell 5.1 misreads UTF-8 without a BOM.

Add-Type -AssemblyName System.Speech
Add-Type -AssemblyName System.Net.Http

$script:VaRoot = Split-Path -Parent $PSScriptRoot
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:SeenInfo = @{}

# ---------------------------------------------------------------- settings

function Read-DotEnv {
    $values = @{}
    $file = Join-Path $script:VaRoot '.env'
    if (-not (Test-Path $file)) { return $values }
    foreach ($line in [IO.File]::ReadAllLines($file)) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
            $key = $Matches[1]
            $value = $Matches[2]
            if ($value.Length -ge 2 -and ($value[0] -eq '"' -or $value[0] -eq "'") -and $value[-1] -eq $value[0]) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            $values[$key] = $value
        }
    }
    return $values
}

function Get-BrainUrl {
    $port = $env:BRAIN_PORT
    if (-not $port) { $port = (Read-DotEnv)['BRAIN_PORT'] }
    if (-not $port) { $port = '47800' }
    return "http://127.0.0.1:$port"
}

# ---------------------------------------------------------------- brain

function New-HttpClient([int]$TimeoutSec = 90) {
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.UseProxy = $false   # the brain is on this laptop; never route it through a proxy
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)
    return $client
}

function Test-Brain([string]$Url) {
    $client = New-HttpClient -TimeoutSec 2
    try {
        $json = $client.GetStringAsync("$Url/health").GetAwaiter().GetResult()
        $health = $json | ConvertFrom-Json
        # Make sure it is our brain, not some other program on the same port.
        if ($health.service -ne 'voice-assistant-brain') { return $null }
        return $health
    } catch {
        return $null
    } finally {
        $client.Dispose()
    }
}

# Starts "node brain/server.js" in the background and waits until /health answers.
# Returns the process, so the caller can stop it on exit.
function Start-Brain([string]$Url) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw 'Node.js was not found. Install Node 20 or newer from nodejs.org.' }
    $logs = Join-Path $script:VaRoot 'logs'
    New-Item -ItemType Directory -Force -Path $logs | Out-Null
    $outLog = Join-Path $logs 'brain.log'
    $errLog = Join-Path $logs 'brain-error.log'

    $proc = Start-Process -FilePath $node.Source -ArgumentList 'brain/server.js' -WorkingDirectory $script:VaRoot `
        -NoNewWindow -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog

    for ($i = 0; $i -lt 75; $i++) {
        Start-Sleep -Milliseconds 200
        $health = Test-Brain $Url
        if ($health) { return $proc }
        if ($proc.HasExited) { break }
    }
    $detail = ''
    if (Test-Path $errLog) { $detail = (Get-Content $errLog -Raw) }
    throw "The brain did not start. $detail"
}

function Stop-Brain($Process) {
    if ($Process -and -not $Process.HasExited) {
        try { $Process.Kill() } catch { }
    }
}

function Reset-Brain([string]$Url, [string]$SessionId) {
    $client = New-HttpClient -TimeoutSec 5
    try {
        $body = @{ sessionId = $SessionId } | ConvertTo-Json -Compress
        $content = New-Object System.Net.Http.StringContent($body, [Text.Encoding]::UTF8, 'application/json')
        [void]$client.PostAsync("$Url/reset", $content).GetAwaiter().GetResult()
    } catch { } finally { $client.Dispose() }
}

# Sends the question and reads the answer as it streams in, one JSON line per event.
# $OnSentence runs for every sentence the moment it arrives (that is where we speak it).
# Returns: FirstSentenceMs, TotalMs (client side), Done (the final event), Error, Info.
function Invoke-Brain {
    param(
        [string]$Url,
        [string]$Question,
        [string]$SessionId = 'default',
        [bool]$UseNotes = $true,
        [scriptblock]$OnSentence
    )
    $result = [ordered]@{ FirstSentenceMs = $null; TotalMs = $null; Done = $null; Error = $null; Info = @() }
    $client = New-HttpClient
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
        $body = @{ question = $Question; sessionId = $SessionId; useNotes = $UseNotes } | ConvertTo-Json -Compress
        $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, "$Url/ask")
        $request.Content = New-Object System.Net.Http.StringContent($body, [Text.Encoding]::UTF8, 'application/json')
        # ResponseHeadersRead = start reading before the whole answer has arrived.
        $response = $client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) {
            $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            $result.Error = [pscustomobject]@{ message = 'The brain rejected the question.'; detail = "HTTP $([int]$response.StatusCode) $text" }
            return [pscustomobject]$result
        }
        $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $reader = New-Object System.IO.StreamReader($stream, [Text.Encoding]::UTF8)
        while ($null -ne ($line = $reader.ReadLine())) {
            if (-not $line.Trim()) { continue }
            $evt = $line | ConvertFrom-Json
            if ($evt.type -eq 'sentence') {
                if ($null -eq $result.FirstSentenceMs) { $result.FirstSentenceMs = $watch.ElapsedMilliseconds }
                if ($OnSentence) { & $OnSentence $evt.text }
            } elseif ($evt.type -eq 'done') {
                $result.Done = $evt
            } elseif ($evt.type -eq 'error') {
                $result.Error = $evt
            } elseif ($evt.type -eq 'info') {
                $result.Info += $evt.message
                # Show each message once per run, not on every question.
                if (-not $script:SeenInfo.ContainsKey($evt.message)) {
                    $script:SeenInfo[$evt.message] = $true
                    Write-Host "  ($($evt.message))" -ForegroundColor DarkGray
                }
            }
        }
        $reader.Dispose()
    } catch {
        $result.Error = [pscustomobject]@{ message = 'I could not reach the brain.'; detail = $_.Exception.GetBaseException().Message }
    } finally {
        $result.TotalMs = $watch.ElapsedMilliseconds
        $client.Dispose()
    }
    return [pscustomobject]$result
}

# ---------------------------------------------------------------- ears

# Dictation = free speech, not a fixed command list. Runs offline.
# EndSilenceMs: how long you must be quiet before it decides you finished.
# Lower is faster but can cut you off mid-sentence. 0 keeps the Windows defaults.
function New-Ears {
    param([string]$Culture = 'en-US', [int]$EndSilenceMs = 0, [string]$WavPath)
    $info = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() |
        Where-Object { $_.Culture.Name -eq $Culture } | Select-Object -First 1
    if (-not $info) {
        $have = ([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | ForEach-Object { $_.Culture.Name }) -join ', '
        throw "No speech recognizer for $Culture. Installed: $have"
    }
    $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)
    $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
    if ($WavPath) { $engine.SetInputToWaveFile($WavPath) } else { $engine.SetInputToDefaultAudioDevice() }
    if ($EndSilenceMs -gt 0) {
        $engine.EndSilenceTimeout = [TimeSpan]::FromMilliseconds($EndSilenceMs)
        $engine.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromMilliseconds($EndSilenceMs)
    }
    $engine.BabbleTimeout = [TimeSpan]::Zero
    return $engine
}

# Waits up to $TimeoutSec for speech. Returns $null when nobody spoke.
#   SpeechMs  how long you spoke
#   SttMs     from the end of your speech to the text being ready
#             (includes the end-of-silence wait, which is most of it)
function Receive-Speech($Ears, [int]$TimeoutSec = 10) {
    $r = $Ears.Recognize([TimeSpan]::FromSeconds($TimeoutSec))
    if ($null -eq $r) { return $null }
    $now = [DateTime]::Now
    $sttMs = $null
    $speechMs = $null
    if ($r.Audio) {
        $speechMs = [int]$r.Audio.Duration.TotalMilliseconds
        $end = $r.Audio.StartTime + $r.Audio.Duration
        $gap = [int]($now - $end).TotalMilliseconds
        if ($gap -ge 0 -and $gap -lt 20000) { $sttMs = $gap }
    }
    return [pscustomobject]@{
        Text       = $r.Text
        Confidence = [Math]::Round($r.Confidence, 2)
        SpeechMs   = $speechMs
        SttMs      = $sttMs
    }
}

# ---------------------------------------------------------------- mouth

# SampleRate only applies to WAV output. Recognizers are tuned for 16000 Hz,
# so use 16000 when the WAV will be fed back into the ears.
function New-Mouth {
    param([string]$Voice = 'Zira', [int]$Rate = 1, [string]$WavPath, [int]$SampleRate = 0)
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $match = $synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Name -like "*$Voice*" } | Select-Object -First 1
    if ($match) {
        $synth.SelectVoice($match.VoiceInfo.Name)
    } else {
        Write-Warning "Voice '$Voice' not found. Using $($synth.Voice.Name)."
    }
    $synth.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))
    if ($WavPath -and $SampleRate -gt 0) {
        $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo($SampleRate,
            [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
        $synth.SetOutputToWaveFile($WavPath, $format)
    } elseif ($WavPath) {
        $synth.SetOutputToWaveFile($WavPath)
    } else {
        $synth.SetOutputToDefaultAudioDevice()
    }
    return $synth
}

# Waits until every queued sentence has been spoken. Any key cuts it short.
function Wait-Speech($Mouth, [System.Collections.ArrayList]$Prompts) {
    if (-not $Mouth -or $Prompts.Count -eq 0) { return $false }
    $canReadKeys = -not [Console]::IsInputRedirected
    while (-not $Prompts[$Prompts.Count - 1].IsCompleted) {
        if ($canReadKeys -and [Console]::KeyAvailable) {
            # Leave the key in the buffer: it may be the first letter of your next
            # question, typed by you or by Wispr Flow. Voice mode clears it before listening.
            $Mouth.SpeakAsyncCancelAll()
            return $true
        }
        Start-Sleep -Milliseconds 40
    }
    return $false
}

function Clear-KeyBuffer {
    if ([Console]::IsInputRedirected) { return }
    while ([Console]::KeyAvailable) { [void][Console]::ReadKey($true) }
}

# ---------------------------------------------------------------- local commands

# Handled on the laptop, without the LLM. Returns $null for a normal question.
function Get-LocalCommand([string]$Text) {
    $t = ($Text.ToLowerInvariant() -replace "[^a-z0-9' ]", '' -replace "'", '' -replace '\s+', ' ').Trim()
    if ($t -match '^(stop|exit|quit|goodbye|good bye|bye|bye bye)( now)?$') {
        return @{ Kind = 'exit'; Say = 'Goodbye.' }
    }
    if ($t -match '^(what time is it|whats the time|what is the time|tell me the time)( now)?$') {
        return @{ Kind = 'say'; Say = 'It is ' + (Get-Date -Format 'h:mm tt') + '.' }
    }
    if ($t -match '^(whats the date|what is the date|what day is it|whats today|what is today)( today)?$') {
        return @{ Kind = 'say'; Say = 'Today is ' + (Get-Date -Format 'dddd, d MMMM yyyy') + '.' }
    }
    if ($t -match '^open (notepad|calculator|calc|paint|file explorer|explorer)$') {
        $apps = @{ 'notepad' = 'notepad.exe'; 'calculator' = 'calc.exe'; 'calc' = 'calc.exe'; 'paint' = 'mspaint.exe'; 'file explorer' = 'explorer.exe'; 'explorer' = 'explorer.exe' }
        return @{ Kind = 'run'; Exe = $apps[$Matches[1]]; Say = "Opening $($Matches[1])." }
    }
    if ($t -match '^(new conversation|start over|reset|forget everything|clear history|new chat)$') {
        return @{ Kind = 'reset'; Say = 'Okay. Fresh start.' }
    }
    if ($t -match '^(notes on|use my notes|turn notes on)$') {
        return @{ Kind = 'notes'; On = $true; Say = 'Notes on. I will search your notes.' }
    }
    if ($t -match '^(notes off|stop using my notes|turn notes off|dont use my notes)$') {
        return @{ Kind = 'notes'; On = $false; Say = 'Notes off.' }
    }
    return $null
}

# ---------------------------------------------------------------- latency log

function Write-TurnLog($Row) {
    $logs = Join-Path $script:VaRoot 'logs'
    New-Item -ItemType Directory -Force -Path $logs | Out-Null
    $json = ([pscustomobject]$Row | ConvertTo-Json -Compress -Depth 5)
    [IO.File]::AppendAllText((Join-Path $logs 'turns.jsonl'), $json + "`n", $script:Utf8NoBom)
}

# Copies the brain's stats (ttft_ms, total_ms, tokens_per_sec, ...) into the row.
function Add-BrainStats($Row, $Done) {
    if ($Done -and $Done.stats) {
        foreach ($p in $Done.stats.PSObject.Properties) { $Row[$p.Name] = $p.Value }
    }
}

function Format-Seconds($Ms) {
    if ($null -eq $Ms) { return '-' }
    return ('{0:0.00} s' -f ($Ms / 1000.0))
}

# ---------------------------------------------------------------- word match (tests)

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
