# How this app works

## Overview: how the app is built

The app has three parts: the ears, the brain and the mouth. The ears turn my speech into text. The brain sends the text to a language model and gets the answer back. The mouth speaks the answer one sentence at a time. The architecture is a PowerShell voice client that talks to a small Node.js server on my laptop. It was built in one day, on 21 November 2026, with no npm packages.

## Ears: speech to text

Wispr Flow is the default ears. I hold Control and Windows, speak, and Wispr Flow types my question into the terminal. Then I press Enter. Windows speech recognition is the other option. It works offline and hands-free, but it got only 2 or 3 of 9 words right with my accent.

## Voice client: the PowerShell script

The script assistant.ps1 runs the loop: get the question, send it to the brain, speak the answer, save the timings. It starts the brain by itself if it is not running. It sends each question to the brain over HTTP, on port 47800 of my own laptop.

## Brain: the Node.js server

For each question, the brain does four things. It searches my notes. It builds the prompt from the system prompt, the last 6 questions and answers, the matching notes and the new question. It calls the language model and streams the answer back. It cuts the stream into whole sentences and sends each one back the moment it is complete.

## The language model and fallback

The brain calls Gemini 2.5 Flash through OpenRouter first. When Gemini fails, for example with no credits, it switches to a free model, Nemotron Lightning. After a no-credits error it skips Gemini for 10 minutes, so I do not wait for a failed call every time.

## Streaming one sentence at a time

The model sends the answer as small pieces called tokens. A sentence splitter glues them into whole sentences and avoids false ends like "Dr." or "3.14". The voice starts on the first sentence while the rest is still arriving. That is why the answer starts in under a second.

## Mouth: text to speech

The Windows voice Microsoft Zira speaks each sentence. The script queues every sentence as it arrives, so the speech never stops between sentences. Pressing any key cuts the answer short.

## Notes search, the RAG part

My notes are Markdown files in the notes folder. The brain splits them into small pieces at each heading. It turns each piece into a TF-IDF word vector and finds the closest pieces with cosine similarity. Up to 3 matching pieces are added to the prompt. It matches words, not meaning, so "kitty" does not find "cat".

## Measuring latency

Every question saves its timings to a log file. The command npm run report shows the median and the slowest 1 in 10 for each step. The main numbers are time to first token, first whole sentence, and Enter to speech.

## Tests

There are 28 unit tests that run with a fake model, so they cost nothing. A self-test speaks questions into sound files and checks the whole loop without a microphone. A mic check records each microphone and shows if the sound or the speech model is the problem.

## Safety

The brain only listens on my own laptop. It only accepts JSON requests from local addresses, so a web page cannot use it to spend my model credits.
