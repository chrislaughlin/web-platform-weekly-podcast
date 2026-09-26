# Web Platform Weekly Podcast 🎙️✨

Turn a stack of web-dev newsletters into a ready-to-review podcast episode — complete with a script, smooth narration, and fresh cover art.

This is a local TypeScript MVP for transforming JavaScript Weekly or This Week in React into something you can listen to instead of merely bookmarking.

## The vibe

```text
newsletter links → article fingerprints → podcast script → MP3 + cover art
```

The pipeline:

- Fetches one or more specific issue URLs, a JavaScript Weekly issue number, or the latest archive page.
- Extracts and fingerprints article links so repeat runs can be spotted.
- Generates an original podcast script with OpenAI.
- Generates MP3 narration with ElevenLabs.
- Generates square cover art with OpenAI using keywords extracted from the finished script.
- Saves a tidy, inspectable run history under `data/artifacts/<run-id>/`: `script/`, `sources/`, `audio/`, and `cover-art/`.
- Supports bypass runs with `bypass: true` or the CLI `--bypass` flag when you want to rerun the same ingredients.

No mystery meat, no external database, no giant platform to wrestle: just articles in, audio out.

## Get it humming

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
- `FFMPEG_PATH`: optional FFmpeg executable path; defaults to `ffmpeg`. Audio is generated in chunks and joined locally to keep voice delivery consistent across longer episodes.

Optional settings are documented in `.env.example`.

## Make an episode from the terminal

```bash
npm run run -- --source javascript-weekly --issue 803
npm run run -- --source this-week-in-react --url https://thisweekinreact.com/newsletter/298
```

For an exact issue, prefer `--url`; newsletter URL formats can change. You can also feed in multiple issues in one run:

```bash
npm run run -- \
  --source javascript-weekly \
  --url https://javascriptweekly.com/issues/803 \
  --url https://javascriptweekly.com/issues/802 \
  --bypass
```

OpenAI transport settings:

- `OPENAI_TIMEOUT_MS` defaults to `120000` (two minutes).
- `OPENAI_MAX_RETRIES` defaults to `1`.

If a script run fails with an OpenAI connection error, inspect the `script.openai.failed` log event. It reports whether the failure was a timeout, DNS/TLS/transport error, or an API response error without printing the API key.

## Bypass mode: second takes welcome

The bypass option deliberately ignores duplicate rejection while retaining the same input and artifact recording. Use the UI checkbox or:

```bash
npm run run -- --source javascript-weekly --issue 803 --bypass
npm run run -- --source this-week-in-react --url https://thisweekinreact.com/newsletter/298 --bypass
npm run run -- --source javascript-weekly --url https://javascriptweekly.com/issues/803 --url https://javascriptweekly.com/issues/802 --bypass
```

## Docker

The app is intentionally file-backed, so it can run in a single container. The included Docker files are ready for the next step once the provider flow is stable; the application itself has no external database requirement.

## Where the beat stops

This MVP stops at local audio, cover art, script, and source metadata. Publishing belongs behind a podcast-host/RSS adapter and a manual review step. For now: make the episode, give it a listen, then decide where it should go.
