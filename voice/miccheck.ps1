<#
.SYNOPSIS
  Microphone check. Finds out why the assistant does not hear you.

.DESCRIPTION
  For each microphone on the laptop:
    1. Records 3 seconds of the quiet room (how loud the room is).
    2. Records you reading one sentence (how loud you are).
    3. Runs Windows speech recognition on that recording, in US and UK English.
  Then it says which mic works best and what to change.
  The recordings are kept in logs\miccheck. Play them to hear what the assistant hears.

.EXAMPLE
  npm run miccheck
  powershell -File voice\miccheck.ps1 -Mic 1          # test only mic 1
#>
param(
    # The sentence you read out loud.
    [string]$Sentence = 'How many words did my speech test get right?',
    # Seconds to record you.
    [int]$Seconds = 6,
    # Test only this mic (number from the list). 0 = all mics.
    [int]$Mic = 0,
    # Start each recording at once, without waiting for Enter.
    [switch]$NoWait
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'VoiceLib.ps1')

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// Records from one microphone with the old Windows "waveIn" API, and measures loudness.
public static class VaMic {
    [StructLayout(LayoutKind.Sequential)]
    struct WaveFormat { public ushort Tag; public ushort Channels; public uint Rate; public uint BytesPerSec; public ushort BlockAlign; public ushort Bits; public ushort Extra; }

    [StructLayout(LayoutKind.Sequential)]
    struct WaveHdr { public IntPtr Data; public uint Length; public uint Recorded; public IntPtr User; public uint Flags; public uint Loops; public IntPtr Next; public IntPtr Reserved; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WaveInCaps { public ushort Mid; public ushort Pid; public uint DriverVersion; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Name; public uint Formats; public ushort Channels; public ushort Reserved; }

    [DllImport("winmm.dll")] static extern uint waveInGetNumDevs();
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)] static extern int waveInGetDevCaps(UIntPtr id, ref WaveInCaps caps, int size);
    [DllImport("winmm.dll")] static extern int waveInOpen(out IntPtr h, uint id, ref WaveFormat fmt, IntPtr cb, IntPtr inst, uint flags);
    [DllImport("winmm.dll")] static extern int waveInPrepareHeader(IntPtr h, IntPtr hdr, int size);
    [DllImport("winmm.dll")] static extern int waveInUnprepareHeader(IntPtr h, IntPtr hdr, int size);
    [DllImport("winmm.dll")] static extern int waveInAddBuffer(IntPtr h, IntPtr hdr, int size);
    [DllImport("winmm.dll")] static extern int waveInStart(IntPtr h);
    [DllImport("winmm.dll")] static extern int waveInReset(IntPtr h);
    [DllImport("winmm.dll")] static extern int waveInClose(IntPtr h);

    public static string[] Devices() {
        uint n = waveInGetNumDevs();
        var names = new string[n];
        for (uint i = 0; i < n; i++) {
            var caps = new WaveInCaps();
            waveInGetDevCaps(new UIntPtr(i), ref caps, Marshal.SizeOf(typeof(WaveInCaps)));
            names[i] = caps.Name;
        }
        return names;
    }

    static void Check(int rc, string what) {
        if (rc != 0) throw new Exception(what + " failed (code " + rc + "). Is the mic in use by another app?");
    }

    // Records 16 kHz, 16-bit, mono from device 'id' and saves it as a WAV file.
    public static void Record(int id, double seconds, string path) {
        var fmt = new WaveFormat { Tag = 1, Channels = 1, Rate = 16000, BytesPerSec = 32000, BlockAlign = 2, Bits = 16, Extra = 0 };
        int bytes = ((int)(seconds * 32000)) & ~1;
        int hsize = Marshal.SizeOf(typeof(WaveHdr));
        IntPtr h;
        Check(waveInOpen(out h, (uint)id, ref fmt, IntPtr.Zero, IntPtr.Zero, 0), "Opening the mic");
        IntPtr data = Marshal.AllocHGlobal(bytes);
        IntPtr hdr = Marshal.AllocHGlobal(hsize);
        bool prepared = false;
        try {
            var wh = new WaveHdr { Data = data, Length = (uint)bytes };
            Marshal.StructureToPtr(wh, hdr, false);
            Check(waveInPrepareHeader(h, hdr, hsize), "Preparing the recording");
            prepared = true;
            Check(waveInAddBuffer(h, hdr, hsize), "Adding the buffer");
            Check(waveInStart(h), "Starting the recording");
            DateTime deadline = DateTime.UtcNow.AddSeconds(seconds + 3);
            while (DateTime.UtcNow < deadline) {
                wh = (WaveHdr)Marshal.PtrToStructure(hdr, typeof(WaveHdr));
                if ((wh.Flags & 1) != 0) break;   // WHDR_DONE: the buffer is full
                Thread.Sleep(50);
            }
            waveInReset(h);
            wh = (WaveHdr)Marshal.PtrToStructure(hdr, typeof(WaveHdr));
            var pcm = new byte[wh.Recorded];
            Marshal.Copy(data, pcm, 0, pcm.Length);
            WriteWav(path, pcm);
        } finally {
            if (prepared) waveInUnprepareHeader(h, hdr, hsize);
            waveInClose(h);
            Marshal.FreeHGlobal(hdr);
            Marshal.FreeHGlobal(data);
        }
    }

    static void WriteWav(string path, byte[] pcm) {
        using (var f = new BinaryWriter(File.Create(path))) {
            f.Write(Encoding.ASCII.GetBytes("RIFF")); f.Write(36 + pcm.Length); f.Write(Encoding.ASCII.GetBytes("WAVE"));
            f.Write(Encoding.ASCII.GetBytes("fmt ")); f.Write(16); f.Write((short)1); f.Write((short)1);
            f.Write(16000); f.Write(32000); f.Write((short)2); f.Write((short)16);
            f.Write(Encoding.ASCII.GetBytes("data")); f.Write(pcm.Length); f.Write(pcm);
        }
    }

    // Loudness of a WAV written by Record, in dB (0 = the loudest possible, -90 = silence).
    // Returns: peak, then the quiet (10%), typical (50%) and loud (90%) level of 50 ms slices.
    public static double[] Levels(string path) {
        byte[] b = File.ReadAllBytes(path);
        int n = (b.Length - 44) / 2;
        const int win = 800;
        var rms = new List<double>();
        double peak = 0;
        for (int w = 0; w + win <= n; w += win) {
            double sum = 0;
            for (int i = w; i < w + win; i++) {
                double s = BitConverter.ToInt16(b, 44 + i * 2) / 32768.0;
                sum += s * s;
                if (Math.Abs(s) > peak) peak = Math.Abs(s);
            }
            rms.Add(Math.Sqrt(sum / win));
        }
        if (rms.Count == 0) return new double[] { -90, -90, -90, -90 };
        rms.Sort();
        return new double[] { Db(peak), Db(rms[rms.Count / 10]), Db(rms[rms.Count / 2]), Db(rms[rms.Count * 9 / 10]) };
    }

    static double Db(double x) { return Math.Round(20 * Math.Log10(Math.Max(x, 0.00003)), 1); }
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
}
[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int Item(int index, out IMMDevice device);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    [PreserveSig] int OpenPropertyStore(int access, out IntPtr store);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetState(out int state);
}
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    [PreserveSig] int RegisterControlChangeNotify(IntPtr n);
    [PreserveSig] int UnregisterControlChangeNotify(IntPtr n);
    [PreserveSig] int GetChannelCount(out int c);
    [PreserveSig] int SetMasterVolumeLevel(float l, ref Guid g);
    [PreserveSig] int SetMasterVolumeLevelScalar(float l, ref Guid g);
    [PreserveSig] int GetMasterVolumeLevel(out float l);
    [PreserveSig] int GetMasterVolumeLevelScalar(out float l);
    [PreserveSig] int SetChannelVolumeLevel(int c, float l, ref Guid g);
    [PreserveSig] int SetChannelVolumeLevelScalar(int c, float l, ref Guid g);
    [PreserveSig] int GetChannelVolumeLevel(int c, out float l);
    [PreserveSig] int GetChannelVolumeLevelScalar(int c, out float l);
    [PreserveSig] int SetMute(bool m, ref Guid g);
    [PreserveSig] int GetMute(out bool m);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class VaMMDeviceEnumerator {}

// Reads (never changes) each mic's volume, mute and "default" state from Windows.
public class VaEndpoint {
    public string Id; public bool IsDefault; public int Volume; public bool Muted;

    public static List<VaEndpoint> List() {
        var en = (IMMDeviceEnumerator)(new VaMMDeviceEnumerator());
        IMMDevice def; string defId = null;
        if (en.GetDefaultAudioEndpoint(1, 0, out def) == 0) def.GetId(out defId);
        IMMDeviceCollection col;
        var list = new List<VaEndpoint>();
        if (en.EnumAudioEndpoints(1, 1, out col) != 0) return list;
        int n; col.GetCount(out n);
        for (int i = 0; i < n; i++) {
            IMMDevice d; col.Item(i, out d);
            var e = new VaEndpoint(); d.GetId(out e.Id);
            e.IsDefault = e.Id == defId;
            Guid iid = typeof(IAudioEndpointVolume).GUID; object o;
            if (d.Activate(ref iid, 23, IntPtr.Zero, out o) == 0) {
                var v = (IAudioEndpointVolume)o;
                float level; v.GetMasterVolumeLevelScalar(out level); e.Volume = (int)Math.Round(level * 100);
                v.GetMute(out e.Muted);
            }
            list.Add(e);
        }
        return list;
    }
}
'@

# ---------------------------------------------------------------- helpers

# Joins the waveIn list (what we record from) with Windows' own mic list (name, volume, default).
function Get-Mics {
    $endpoints = [VaEndpoint]::List()
    $names = @{}
    Get-PnpDevice -Class AudioEndpoint -ErrorAction SilentlyContinue | ForEach-Object { $names[$_.InstanceId.ToUpperInvariant()] = $_.FriendlyName }
    $wave = [VaMic]::Devices()
    for ($i = 0; $i -lt $wave.Count; $i++) {
        $name = $wave[$i]
        $match = $null
        foreach ($e in $endpoints) {
            $full = $names['SWD\MMDEVAPI\' + $e.Id.ToUpperInvariant()]
            if ($full -and $full.StartsWith($name)) { $match = $e; $name = $full; break }
        }
        [pscustomobject]@{
            Number  = $i + 1
            Index   = $i
            Name    = $name
            Default = [bool]($match -and $match.IsDefault)
            Volume  = $(if ($match) { $match.Volume } else { $null })
            Muted   = [bool]($match -and $match.Muted)
        }
    }
}

function Wait-Enter([string]$Message) {
    Write-Host "  $Message" -ForegroundColor Yellow
    if ($NoWait -or [Console]::IsInputRedirected) { return }
    Write-Host '  Press Enter when ready.' -ForegroundColor DarkGray -NoNewline
    [void][Console]::ReadLine()
}

# Every phrase Windows recognizes in a WAV file, joined.
function Get-WavText([string]$Path, [string]$Culture) {
    $ears = New-Ears -Culture $Culture -WavPath $Path
    $texts = @()
    $confidences = @()
    try {
        while ($true) {
            # At the end of the file Recognize() returns nothing, or throws "no audio input".
            try { $r = $ears.Recognize() } catch { break }
            if ($null -eq $r) { break }
            $texts += $r.Text
            $confidences += $r.Confidence
        }
    } finally { $ears.Dispose() }
    $confidence = 0
    if ($confidences.Count -gt 0) { $confidence = [Math]::Round(($confidences | Measure-Object -Average).Average, 2) }
    return [pscustomobject]@{ Text = ($texts -join ' '); Confidence = $confidence }
}

# ---------------------------------------------------------------- run

$dir = Join-Path $script:VaRoot 'logs\miccheck'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$cultures = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() |
    ForEach-Object { $_.Culture.Name } | Where-Object { $_ -like 'en-*' } | Sort-Object -Unique)

Write-Host 'Microphone check' -ForegroundColor Cyan
$mics = @(Get-Mics)
if ($mics.Count -eq 0) { Write-Host 'No microphone found. Plug one in and try again.' -ForegroundColor Red; exit 1 }
Write-Host '  Microphones (* = the one Windows and the assistant use):'
foreach ($m in $mics) {
    $mark = if ($m.Default) { '*' } else { ' ' }
    $extra = @()
    if ($null -ne $m.Volume) { $extra += "volume $($m.Volume)%" }
    if ($m.Muted) { $extra += 'MUTED' }
    Write-Host ("  {0} {1}. {2}   {3}" -f $mark, $m.Number, $m.Name, ($extra -join ', '))
}
Write-Host "  Speech recognizers: $($cultures -join ', ')"

$targets = if ($Mic -gt 0) { @($mics | Where-Object { $_.Number -eq $Mic }) } else { $mics }
if ($targets.Count -eq 0) { Write-Host "There is no mic $Mic." -ForegroundColor Red; exit 1 }

$results = @()
foreach ($m in $targets) {
    Write-Host ''
    Write-Host "Mic $($m.Number): $($m.Name)" -ForegroundColor Cyan
    $roomWav = Join-Path $dir "mic$($m.Number)-room.wav"
    $voiceWav = Join-Path $dir "mic$($m.Number)-voice.wav"

    Wait-Enter 'Step 1: stay quiet. I record the room for 3 seconds.'
    Write-Host '  Recording the room...' -ForegroundColor DarkGray
    [VaMic]::Record($m.Index, 3, $roomWav)
    $room = [VaMic]::Levels($roomWav)

    Wait-Enter "Step 2: sit where you normally sit. Read this out loud at your normal volume:`n      ""$Sentence"""
    Write-Host "  Recording for $Seconds seconds. Speak now." -ForegroundColor Green
    [VaMic]::Record($m.Index, $Seconds, $voiceWav)
    $voice = [VaMic]::Levels($voiceWav)

    $roomDb = $room[2]
    $voiceDb = $voice[3]
    $gap = [Math]::Round($voiceDb - $roomDb, 1)
    Write-Host ("  Room {0} dB | your voice {1} dB | voice is {2} dB above the room | loudest {3} dB" -f $roomDb, $voiceDb, $gap, $voice[0])

    $best = $null
    foreach ($c in $cultures) {
        $heard = Get-WavText $voiceWav $c
        $words = Get-WordsRight $Sentence $heard.Text
        Write-Host ("  {0} heard: ""{1}""   ({2} of {3} words, confidence {4})" -f $c, $heard.Text, $words.Right, $words.Total, $heard.Confidence)
        if (-not $best -or $words.Right -gt $best.Right -or ($words.Right -eq $best.Right -and $heard.Confidence -gt $best.Confidence)) {
            $best = [pscustomobject]@{ Culture = $c; Right = $words.Right; Total = $words.Total; Confidence = $heard.Confidence }
        }
    }
    $results += [pscustomobject]@{
        Mic = $m; RoomDb = $roomDb; VoiceDb = $voiceDb; Gap = $gap; PeakDb = $voice[0]
        Culture = $best.Culture; Right = $best.Right; Total = $best.Total; Confidence = $best.Confidence
    }
}

# ---------------------------------------------------------------- verdict

$top = $results | Sort-Object -Property @{ Expression = 'Right'; Descending = $true }, @{ Expression = 'Gap'; Descending = $true } | Select-Object -First 1
$m = $top.Mic
Write-Host ''
Write-Host 'Result' -ForegroundColor Cyan
Write-Host ("  Best mic: {0}. {1} ({2} of {3} words in {4}, confidence {5})" -f $m.Number, $m.Name, $top.Right, $top.Total, $top.Culture, $top.Confidence)

$advice = @()
if ($m.Muted) { $advice += 'This mic is muted. Unmute it: Settings > System > Sound > Input.' }
if ($top.PeakDb -ge -1) { $advice += 'Your voice is so loud that it distorts. Lower the mic volume a little.' }
if ($top.VoiceDb -lt -40) { $advice += 'Your voice is too quiet. Sit closer to the mic, or raise its volume to 100.' }
if ($top.Gap -lt 15) { $advice += 'The room is loud compared with your voice. Sit closer to the mic, or use a headset.' }

$ratio = if ($top.Total -gt 0) { $top.Right / $top.Total } else { 0 }
if ($ratio -ge 0.7) {
    $advice += 'This mic works with the Windows ears.'
    if (-not $m.Default) { $advice += 'Make it the Windows default: Settings > System > Sound > Input, then pick it.' }
    $options = @('-Ears windows')
    if ($top.Culture -ne 'en-US') { $options += "-Culture $($top.Culture)" }
    if ($top.Confidence -lt 0.3) {
        $min = [Math]::Max(0.05, [Math]::Floor(($top.Confidence - 0.05) * 20) / 20)
        $options += ('-MinConfidence {0}' -f $min.ToString([Globalization.CultureInfo]::InvariantCulture))
    }
    $advice += "Start the assistant with: .\start.cmd $($options -join ' ')"
} elseif ($top.VoiceDb -ge -40 -and $top.Gap -ge 15) {
    $advice += 'The sound is clear, but Windows speech recognition did not understand the words.'
    $advice += 'Read the sentence again, slowly. If it still fails, the offline recognizer cannot follow your accent.'
    $advice += 'Then use Wispr Flow as the ears. It is the default: .\start.cmd'
} else {
    $advice += 'Fix the sound first, then run this check again.'
}
foreach ($a in $advice) { Write-Host "  - $a" }
Write-Host "  Recordings: $dir" -ForegroundColor DarkGray
