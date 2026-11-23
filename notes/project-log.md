# Voice assistant project log

Sample notes. Replace or add your own files in this folder. The assistant picks up changes by itself.

## Speech pre-check

Windows speech recognition works offline on my laptop. On 5 test questions it got 32 of 34 words right. The command version, with "what time is it" and "open notepad", also works.

## Build day

The build day is Saturday 21 November 2026. The goal is to ask a question by voice and hear the answer.

The ears are Wispr Flow. The brain is Gemini 2.5 Flash through OpenRouter. The mouth is the Windows voice Microsoft Zira.

The first plan used a local Llama 3.2 3B model. I changed the brain to Gemini because I already use it in my other apps.

## Why I switched the ears to Wispr Flow

On 22 November I ran a mic check. My voice on the laptop mic was 37 to 40 dB louder than the room, so the sound was clean. Windows speech recognition still got only 2 or 3 of 9 words right. It cannot follow my accent. Wispr Flow can, so it is now the default ears. The webcam mic was also a problem: it picks up the whole room.

## Team plans

My teammates are building an AI Mock Interviewer and an HR Helper. My project covers LLM inference, streaming, latency and speech, so together we cover more ground.
