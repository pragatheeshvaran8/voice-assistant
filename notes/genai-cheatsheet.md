# GenAI cheat sheet

## LLM basics

### Tokens
A token is a piece of text the model reads and writes, often part of a word. In English one token is about 4 characters, or about three quarters of a word.

### Tokenization
The tokenizer splits text into tokens from a fixed vocabulary, usually with byte pair encoding (BPE). Common words are one token. Rare words, numbers and non-English text often take several tokens.

### Context window
The context window is the maximum number of tokens the model can see at once. The system prompt, the history, the notes and the answer all share it. This assistant sends only the last 6 turns to stay fast and cheap.

### Temperature
Temperature scales the next-token probabilities before one is picked. Low temperature (0 to 0.3) gives focused, repeatable answers. High temperature (above 1) gives varied answers with more mistakes.

### Top-p sampling
Top-p, also called nucleus sampling, keeps only the most likely tokens whose probabilities add up to p, then picks from them. With top-p 0.9 the long tail of unlikely tokens is never picked.

### How LLMs generate text
The model gives a probability to every token in its vocabulary, picks one, adds it to the input, and repeats. This loop is called autoregressive generation. It stops at an end token or at the max tokens limit.

### Why LLMs hallucinate
The model is trained to write likely text, not true text. When it lacks a fact, it still writes a fluent guess. Grounding with sources, low temperature and allowing "I don't know" all reduce hallucination.

### System prompt
The system prompt is the instruction block sent before the conversation. It sets the role, the style and the rules. In this assistant it forces short spoken answers with no markdown.

### Prompt design for spoken answers
Ask for one to three short sentences with the most useful fact first. Ban lists, symbols and links, and ask for numbers the way people say them. Tell the model the words came from speech recognition and may be wrong.

## Model internals

### Transformer
The transformer is the network design behind modern LLMs. It is a stack of layers. Each layer has self-attention followed by a small feed-forward network.

### Attention
For each token, attention scores how much every other visible token matters, then mixes their information by those scores. This is how "it" finds the noun it refers to.

### Encoder vs decoder
An encoder reads the whole input in both directions and builds a representation, like BERT for classification and embeddings. A decoder writes one token at a time and only sees earlier tokens, like GPT, Llama and Gemini. Encoder-decoder models such as T5 and Whisper do both.

## Running models

### Local vs cloud LLMs
A local model is free per request, private and works offline, but your RAM and CPU limit it to small, slower models. A cloud model is large, fast and strong, but costs money per token, needs internet, and your data leaves the laptop.

### Quantization
Quantization stores model weights with fewer bits. Going from 16-bit to 8-bit halves the memory, and 4-bit quarters it. A 3B model drops from about 6 GB to about 2 GB at 4-bit, with a small loss in quality.

### 4-bit vs 8-bit
8-bit is almost the same quality as 16-bit. 4-bit, such as Q4_K_M, loses a little quality but fits on a laptop. It is also faster on CPU, because less memory moves for each token.

### GGUF
GGUF is the model file format used by llama.cpp. One file holds the quantized weights, the tokenizer and the settings. A name like Q4_K_M tells you the quantization type.

### KV cache
During generation the model saves the attention keys and values of every earlier token. Each new token then only computes its own part instead of redoing the whole prompt. It makes generation fast, but its memory grows with the context length.

## Speed

### Streaming
With streaming, the server sends tokens as they are made instead of waiting for the full answer. This assistant speaks the first sentence while the model is still writing the rest.

### Time to first token
Time to first token (TTFT) is the time from sending the request to getting the first token. It covers the network, the queue and the prefill, which means reading the whole prompt. A longer prompt means a longer TTFT.

### Tokens per second
Tokens per second is the generation speed after the first token, also called decode speed. Answer time is about TTFT plus answer tokens divided by tokens per second.

### Latency budget
A latency budget lists where each part of the delay comes from. For this assistant: waiting to be sure you stopped talking, speech to text, network, time to first token, waiting for a full sentence, and starting the voice.

## Speech

### How speech recognition works
Speech recognition turns audio into text. Classic engines like Windows speech recognition combine an acoustic model for sounds, a pronunciation dictionary and a language model for likely word sequences, then search for the best match.

### How Whisper differs
Whisper is OpenAI's open speech model. It is one encoder-decoder transformer trained on 680,000 hours of audio: audio goes in as a spectrogram and text comes out as tokens. It handles accents and noise better than classic engines, but needs much more compute.

### Text to speech
Text to speech first normalizes the text, for example numbers and short forms. It then turns words into sounds called phonemes, and the sounds into a waveform. Windows Zira is an older non-neural voice. Neural voices sound more natural.

## RAG

### Embeddings
An embedding is a list of numbers that stands for the meaning of a text. Texts with similar meaning get vectors that point in similar directions.

### Chunking
Chunking splits documents into small pieces before indexing, so search returns only the relevant part. Chunks that are too big add noise and cost. Chunks that are too small lose context.

### Vector search
Vector search turns the question into a vector and finds the chunk vectors closest to it, usually by cosine similarity. This assistant uses TF-IDF word vectors, which match on words, instead of learned embeddings, which match on meaning.

### Grounding
Grounding means putting retrieved source text into the prompt and telling the model to answer from it. The answer can then be checked against a source.

### RAG
RAG means retrieval-augmented generation. The system searches first, then the model writes the answer with the found text in its prompt.
