# Voice Assistant

You speak a question. An LLM answers. The laptop speaks the answer back, one sentence at a time.

| Part | Job | Tool | Runs in |
|---|---|---|---|
| Ears | Speech to text | Windows speech recognition (`System.Speech` dictation, offline) | PowerShell |
| Brain | Understands and answers | Gemini 2.5 Flash through OpenRouter, with free fallback models | Node.js |
| Mouth | Text to speech | Windows voice Microsoft Zira (offline) | PowerShell |

No npm packages. No extra apps. Everything except the LLM call runs on the laptop.

```
 you speak                                                    you hear
    |                                                             ^
    v                                                             |
 [Ears] Windows speech recognition                       [Mouth] Windows Zira voice
    |  text                                                       ^  one sentence at a time
    v                                                             |
 voice/assistant.ps1  --- POST /ask --->  brain/server.js  --- streamed lines --->
                                              |
                                              |  notes search (RAG), prompt, history
                                              v
                                        LLM (streaming tokens)
```

## What you need

- Windows 10 or 11 with an English speech recognizer (en-US or en-GB) and a microphone.
- Node.js 20.12 or newer.
- An OpenRouter API key in `.env`.

## Setup

1. Copy `.env.example` to `.env`.
2. Put your key in `OPENROUTER_API_KEY`.
3. Run `start.cmd`.

On this laptop, `.env` is already set up with the key from your other apps.

## How to use it

| Command | What it does |
|---|---|
| `start.cmd` | Voice mode. Speak after "Listening...". |
| `start.cmd -Typed` | Type questions, hear the answers. Good fallback demo. |
| `start.cmd -Typed -NoSpeak` | Text only. |
| `npm run chat` | Chat with the brain in the terminal. Shows tokens live, timings, and `/temp`, `/show` commands. |
| `npm run selftest` | Silent end-to-end check with WAV files. No mic or speakers needed. |
| `npm run report` | Latency table from all your questions so far. |
| `npm test` | 27 unit and API tests. No API calls. |
| `npm run brain` | Start only the brain (the voice client starts it for you anyway). |

While it speaks, press any key to cut the answer short.

### Voice commands

These run on the laptop. They never reach the LLM.

| Say | It does |
|---|---|
| "what time is it" | Says the time |
| "what day is it" | Says the date |
| "open notepad" / "open calculator" | Opens the app |
| "new conversation" | Forgets the chat history |
| "notes on" / "notes off" | Searches your notes, or not |
| "goodbye" | Stops |

### Options for `start.cmd`

| Option | Default | Meaning |
|---|---|---|
| `-Culture en-GB` | `en-US` | Speech recognizer language. Try en-GB if en-US mishears your accent. |
| `-MinConfidence 0.2` | `0.3` | Ignore what was heard below this confidence. Lower it if good questions get ignored. |
| `-EndSilenceMs 600` | Windows default | Silence that ends your question. Lower is faster but can cut you off. |
| `-Voice David` | `Zira` | Voice for answers. |
| `-Rate 2` | `1` | Speaking speed, -10 to 10. |
| `-NoNotes` | off | Do not search the notes folder. |

## Gemini credits: read this first

On 21 Nov 2026 the OpenRouter account had **no credits left**. It could pay for only 72 more output tokens. Gemini returns HTTP 402 for every normal answer.

The app handles this by itself:

- The brain tries Gemini first.
- On a 402 it switches to `nvidia/nemotron-3.5-lightning:free`, then `openrouter/free`.
- It skips Gemini for 10 minutes after a 402, so you do not pay the failed call every time.
- Every answer prints which model answered.

Free models allow about 50 requests a day in total. To get Gemini back, pick one:

| Option | What to do |
|---|---|
| Top up OpenRouter | Add credits at openrouter.ai. Nothing else changes. One answer costs about $0.0001. |
| Free Gemini from Google | Get a key at aistudio.google.com. In `.env` set `LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai`, `LLM_MODEL=gemini-2.5-flash`, `GEMINI_API_KEY=...`, and empty `LLM_FALLBACK_MODELS=`. |
| Fully offline | Run a llama.cpp server with a 4-bit GGUF model and set `LLM_BASE_URL=http://127.0.0.1:8080/v1`. This is the original plan. |

## Settings (`.env`)

| Setting | Default | Meaning |
|---|---|---|
| `LLM_MODEL` | `google/gemini-2.5-flash` | Main model |
| `LLM_FALLBACK_MODELS` | two free models | Tried in order when the main model fails |
| `LLM_REASONING` | `off` | Hidden "thinking" before answering. Off is fastest. |
| `LLM_TEMPERATURE` | `0.4` | Randomness of the answer |
| `LLM_MAX_TOKENS` | `220` | Hard cap on answer length |
| `USER_CONTEXT` | GenAI topics | Your topics. Helps the model fix misheard words like "KB cache". |
| `HISTORY_TURNS` | `6` | Past question and answer pairs sent with each question |
| `NOTES_DIR` | `notes` | Folder with your `.md` and `.txt` notes |
| `NOTES_MIN_SCORE` | `0.2` | How close a note must match to be used |
| `LLM_PROVIDER` | `openrouter` | `fake` gives canned answers with no API call |
| `BRAIN_PORT` | `47800` | Port 8765 is taken by another app on this laptop |

## Measuring latency

Every question adds one line to `logs/turns.jsonl`. Run `npm run report` to get a table with median and p90 for each stage. It also saves the table to `results/latency.md`.

| Stage | What it measures |
|---|---|
| Ears | You stop talking, the text is ready. Mostly the wait to be sure you stopped. |
| Notes search | Finding matching notes. Under 2 ms. |
| Time to first token | Question sent, first token from the model. |
| First whole sentence | First sentence ready to speak. This is when the voice starts. |
| Voice to voice | You stop talking, the assistant starts talking. The number a user feels. |
| Full answer | Last token received. |

## Your notes (RAG)

Put `.md` or `.txt` files in `notes/`. The brain re-reads the folder when a file changes. Two sample files are included:

- `genai-cheatsheet.md`: two-line answers for every interview topic.
- `project-log.md`: facts only you know, like your 32 of 34 words pre-check. Ask "how many words did my speech test get right?" to see RAG work.

## Files

| File | Job |
|---|---|
| `voice/assistant.ps1` | The voice loop: listen, ask, speak, log |
| `voice/VoiceLib.ps1` | Ears, mouth, streaming HTTP client, local commands |
| `voice/selftest.ps1` | Silent end-to-end test with WAV files |
| `brain/server.js`, `brain/app.js` | HTTP server: `/health`, `/ask` (streamed), `/reset` |
| `brain/assistant.js` | One question in, answer and timings out |
| `brain/llm.js` | Streaming LLM client, fallback, cooldown, fake provider |
| `brain/sentences.js` | Turns the token stream into speakable sentences |
| `brain/prompt.js` | System prompt, history trimming, note passages |
| `brain/notes.js` | Chunking, TF-IDF vectors, cosine search |
| `brain/chat.js` | Terminal chat |
| `scripts/report.js` | Latency table |
| `LEARN.md` | Study guide: what to read, what to try, interview questions |

## Troubleshooting

| Problem | Fix |
|---|---|
| "No speech recognizer for en-US" | Settings > Time & language > Speech. Add the English speech pack. |
| It ignores what you said | Lower `-MinConfidence`, for example `0.2`. The ignored text is printed in grey. |
| Grey "(ignored ...)" lines when nobody spoke | Background sound (TV, people talking). It is heard as junk with confidence near 0 and skipped. A headset mic helps. |
| It cuts you off mid-question | Raise `-EndSilenceMs`, for example `900`. |
| "The model account has run out of credits" | See "Gemini credits" above. |
| "Port ... is already used by another program" | Change `BRAIN_PORT` in `.env`. |
| Script blocked by execution policy | Use `start.cmd`. It passes `-ExecutionPolicy Bypass` for this script only. |
| Brain errors | Read `logs/brain.log` and `logs/brain-error.log`. |
