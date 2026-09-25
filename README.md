# Web Platform Weekly Podcast

Local TypeScript MVP that turns JavaScript Weekly or This Week in React into a generated podcast episode and cover image.

## What it does

- Fetches a specific issue URL, JavaScript Weekly issue number, or the latest archive page.
- Extracts and fingerprints article links.
- Generates an original podcast script with OpenAI.
- Generates MP3 narration with ElevenLabs.
- Generates square cover art with OpenAI and adds deterministic episode text.
- Persists run history and artifacts under `data/`.
- Supports bypass runs with `bypass: true` or the CLI `--bypass` flag.

## Setup

```bash
npm install
cp .env.example .env
# Add the keys described below to .env
npm run dev
```

Open http://localhost:3000.

Required keys:

- `OPENAI_API_KEY`: script and cover-art generation.
- `ELEVENLABS_API_KEY`: narration generation.
- `ELEVENLABS_VOICE_ID`: the ElevenLabs voice to use.
- `ELEVENLABS_MODEL`: optional voice model; defaults to `eleven_multilingual_v2`. Scripts over that model's 10,000-character limit automatically fall back to `eleven_flash_v2_5` unless you explicitly set a different model.

Optional settings are documented in `.env.example`.

OpenAI transport settings:

- `OPENAI_TIMEOUT_MS` defaults to `120000` (two minutes).
- `OPENAI_MAX_RETRIES` defaults to `1`.

If a script run fails with an OpenAI connection error, inspect the `script.openai.failed` log event. It reports whether the failure was a timeout, DNS/TLS/transport error, or an API response error without printing the API key.

## Bypass testing

The bypass option deliberately ignores duplicate rejection while retaining the same input and artifact recording. Use the UI checkbox or:

```bash
npm run run -- --source javascript-weekly --issue 803 --bypass
npm run run -- --source this-week-in-react --url https://thisweekinreact.com/newsletter/298 --bypass
```

For an exact issue, prefer `--url`; issue-number URL formats can differ between newsletters.

## Docker

The app is intentionally file-backed for the first MVP, so it can run in a single container. Add a small Node 22 Alpine Dockerfile and Compose file once the provider flow is stable; the application itself has no external database requirement yet.

## Current publishing boundary

This MVP stops at local audio, cover art, script, and source metadata. Publishing should be added through a podcast host/RSS adapter after manual review. Spotify for Creators currently supports uploading through its creator interface, but a general public upload API should not be assumed.
