# Study guide

The app is built. This guide is how you learn it. Do the steps in order.

## Step 1. Learn the words (about 1 hour)

Read [notes/genai-cheatsheet.md](notes/genai-cheatsheet.md). It has a two-line answer for every topic in your plan. Close the file and explain each one out loud. If you get stuck, read it again.

You can also ask the assistant. The cheat sheet is in its notes, so "what is top p sampling?" gets answered from your own notes.

## Step 2. Follow one question through the code (about 1 hour)

Read these in order. Each file starts with a comment that says what it does.

| # | What happens | Where |
|---|---|---|
| 1 | Wispr Flow turns your speech into text and types it after `you>`. The script reads the line. With `-Ears windows`, Windows does this instead. | `voice/assistant.ps1`: `ReadLine()`. Windows ears: `New-Ears`, `Receive-Speech` in `VoiceLib.ps1` |
| 2 | Local commands run on the laptop. With the Windows ears, low-confidence text is ignored first. | `voice/assistant.ps1` main loop, `Get-LocalCommand` |
| 3 | The text is sent to the brain. The reply is read line by line as it streams. | `VoiceLib.ps1`: `Invoke-Brain` |
| 4 | The brain receives the question for this session. | `brain/app.js`: `ask()` |
| 5 | The notes are searched. | `brain/notes.js`: `NotesIndex.search()` |
| 6 | The prompt is built: system prompt, history, notes, question. | `brain/prompt.js`: `buildMessages()` |
| 7 | The model streams tokens back. | `brain/llm.js`: `openAiStream()` |
| 8 | Tokens are glued into whole sentences. | `brain/sentences.js`: `SentenceSplitter` |
| 9 | Each sentence is sent to PowerShell the moment it is complete. | `app.js`: `send({ type: 'sentence' })` |
| 10 | PowerShell queues each sentence on the voice. | `assistant.ps1`: `$mouth.SpeakAsync()` |
| 11 | The timings are saved. | `Write-TurnLog`, then `npm run report` |

## Step 3. Try things (the real learning)

Use `npm run chat` for most of these. It shows the tokens as they arrive and the timings after each answer.

### Tokens and the context window

- Ask a question, then type `/show`. You see every message sent to the model, with a token estimate for each.
- Compare the estimate (characters divided by 4) with the real `prompt N tokens` in the stats line.
- Ask 8 questions in a row, then `/show` again. Only the last 6 pairs are there. That is `HISTORY_TURNS` and `trimHistory()` at work.

### Temperature and top-p

- `/temp 0`, then ask "give me a name for a cat" three times. Answers repeat.
- `/temp 1.5`, ask again three times. Answers change, and get stranger.
- `/temp 1.5` with `/topp 0.3`. The variety drops again, because top-p cuts the unlikely tokens.

### Hallucination and grounding

- `/notes off`, then ask "how many words did my speech pre-check get right?". The model cannot know. Does it admit it or guess?
- `/notes on`, ask again. Now it answers "32 of 34" from `notes/project-log.md`. That is grounding.

### System prompt and spoken style

- Open `brain/prompt.js`. Delete the rule "No markdown, lists...". Restart `npm run chat` and ask "how do I make tea?".
- You get a numbered list. A voice reads that badly. Put the rule back.
- `brain/sentences.js` `cleanForSpeech()` is the safety net that strips markdown when the model ignores the rule.

### Streaming, time to first token, tokens per second

- In the stats line, compare `first sentence` with `total`. The voice starts at `first sentence`, not at `total`. That gap is what streaming saves you.
- `tok/s` is generation speed after the first token. It is measured from network chunks, so it is "delivery speed".
- Set `LLM_REASONING=medium` in `.env` and ask again. Time to first token usually goes up, because the model "thinks" before it writes. The stats line shows `reasoning N tokens`. Set it back to `off`.

### Speech recognition

- Run `npm run miccheck`. It records each mic and shows how loud the room is and how loud you are.
- On 22 Nov your voice was 37 to 40 dB above the room on the Realtek mic. That is very clean sound.
- Windows still got only 2 or 3 of 9 words. The sound was fine. The old offline model could not follow the accent.
- That is why Wispr Flow is the default ears. A modern cloud model handles accents far better.
- Lesson: measure the sound first. Then you know if the mic or the model is the problem.
- Run `start.cmd -Ears windows` to see the old engine. Each line shows the confidence and how long after you stopped the text was ready.
- With the Windows ears, try `-EndSilenceMs 300`. It answers sooner but may cut you off. Try `900`.
- `npm run selftest` plays the role of a person with a Windows voice. It shows a real mistake: "KV cache" is heard as "KB cache".
- The fix is in the prompt. `USER_CONTEXT` lists your topics. The system prompt rule "Speech recognition often mishears words..." tells the model to repair misheard terms.
- On 21 Nov, `USER_CONTEXT` alone did not fix it. The rule plus `USER_CONTEXT` did. Remove both and the wrong "knowledge base cache" answer comes back.

### RAG

- Add a file to `notes/`, for example `my-cat.md` with "My cat is called Biscuit." Ask "what is my cat called?". No restart needed.
- Raise `NOTES_MIN_SCORE` to `0.5`. Fewer notes match. Lower it to `0.05`. Unrelated notes leak into the prompt. Check with `/show`.
- The vectors are TF-IDF word vectors. They match words, not meaning. Ask "what is my kitty called?". It may miss, because "kitty" is not "cat". Learned embeddings would fix that.

### Local vs cloud, quantization, KV cache

These are theory here, because the brain runs in the cloud. To try them for real:

1. Download llama.cpp and a 4-bit GGUF model, such as Qwen 2.5 3B Instruct Q4_K_M (about 2 GB).
2. Run `llama-server -m model.gguf --port 8080`.
3. In `.env` set `LLM_BASE_URL=http://127.0.0.1:8080/v1` and empty `LLM_FALLBACK_MODELS=`.
4. Run `npm run chat` and compare `tok/s` and `first token` with the cloud numbers.

No code changes are needed. llama.cpp speaks the same API as OpenRouter.

## Step 4. Fill your latency table

Ask about 10 questions with Wispr Flow. Then run `npm run report -- --mode wispr`. Copy the medians here:

| Stage | Median | p90 |
|---|---|---|
| Brain: time to first token | | |
| Brain: first whole sentence | | |
| Question in (Enter pressed), assistant starts talking | | |
| Brain: full answer | | |
| Tokens per second | | |

The ears time is missing with Wispr Flow. The app only sees the text when you press Enter. In an interview, say so. Then say what you would do: time the key press, or use a speech API that reports when you stopped talking.

Self-test numbers from 21 Nov 2026 for comparison. Free Nemotron model, 3 questions, typed into the brain from WAV files:

- First token: median 706 ms.
- First sentence: median 767 ms.
- Full answer: median 1127 ms.
- The slowest first token (1296 ms) was the first question. It paid for the failed Gemini call before the switch.

## Step 5. Practise the interview questions

Answer each one out loud in under a minute. The hint says where the answer is.

| Question | Hint |
|---|---|
| Walk me through what happens when you ask a question. | Step 2 table |
| Why stream sentence by sentence and not token by token? | A voice needs whole sentences to sound right. Whole answers are too slow. `sentences.js` |
| Where does the delay come from? Which part is biggest? | Your latency table |
| How do you decide where a sentence ends? What breaks it? | "3.14", "Dr.", "e.g.", list markers. `sentences.js` tests |
| What happens when the model API fails? | Fallback list, 10-minute cooldown after 402, spoken error. `llm.js` |
| How do you keep the context window small? | Last 6 turns, token budget, notes only when they match. `prompt.js` |
| How do you stop the model inventing facts? | Grounding with notes, "say you don't know", low temperature |
| Why TF-IDF and not embeddings? | Zero dependencies, offline, fast. Trade-off: no synonyms. |
| How would you make it fully offline? | llama.cpp with a 4-bit GGUF model, one setting change |
| How does 4-bit quantization change memory and speed? | Cheat sheet: Quantization, 4-bit vs 8-bit |
| What is the KV cache and why does it matter for a chat app? | Cheat sheet: KV cache |
| How is Whisper different from Windows speech recognition? | Cheat sheet: How Whisper differs |
| Speech recognition misheard a word. How did you handle it? | `USER_CONTEXT` and the prompt rule, plus the confidence cutoff |
| Why did you replace Windows speech recognition with Wispr Flow? | `npm run miccheck`: clean sound, 37 to 40 dB above the room, but only 2 or 3 of 9 words right |
| How did you test a voice app without talking to it? | `npm run selftest`: a Windows voice speaks into a WAV, and the ears read the WAV |
