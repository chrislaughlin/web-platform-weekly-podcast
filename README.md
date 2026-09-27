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
- Generates an original 15-minute-plus podcast script with OpenAI. When both feeds are supplied, overlapping stories are grouped before generation so they are discussed once while retaining every covered source link.
- Generates measured MP3 narration with ElevenLabs, sentence line breaks, configurable voice speed, and short gaps between generated audio chunks.
- Generates square cover art with OpenAI using keywords extracted from the finished script.
- Saves a tidy, inspectable week-named folder under `data/artifacts/`: `script/`, `sources/`, `audio/`, `cover-art/`, `podcast-title.txt`, and `description.txt` (one episode line followed by the covered article links).
- Records completed generations in the committed `generated-episodes.json` manifest and checks issue content hashes against it before spending time on another generation.
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
- `ELEVENLABS_SPEED`: optional measured delivery speed from `0.7` to `1.1`; defaults to `0.9`.
- `ELEVENLABS_CHUNK_GAP_SECONDS`: optional silence inserted between generated audio chunks; defaults to `0.45`.
- `FFMPEG_PATH`: optional FFmpeg executable path; defaults to `ffmpeg`. Audio is generated in chunks and joined locally to keep voice delivery consistent across longer episodes.
- `MIN_SCRIPT_WORDS`: optional minimum spoken-word count; defaults to `2250`, which targets at least 15 minutes at a measured speaking pace.

Optional settings are documented in `.env.example`.

## Make an episode from the terminal

```bash
npm run run -- --source javascript-weekly --issue 803
npm run run -- --source this-week-in-react --url https://thisweekinreact.com/newsletter/298
npm run run -- --source both
```

For `--source both`, repeated `--url` values are assigned in feed order: the first to JavaScript Weekly and the second to This Week in React. Omit them to use the latest issue from each feed.

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

`generated-episodes.json` is updated after a complete episode has finished. Commit and push that manifest update with the generated episode if future runs should be prevented on other machines too. Use `--bypass` only when intentionally regenerating the same issue.

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

## Upload the September 2026 episodes to Buzzsprout

The one-off uploader reads `BUZZ_SPROUT_API_KEY` from `.env` and publishes the five target folders. It uses `podcast-title.txt` for the title, the first line of `description.txt` for the description, and `cover-art/cover.png` as episode artwork. It discovers the podcast ID when the API token belongs to one podcast; set `BUZZSPROUT_PODCAST_ID` in `.env` if the account has more than one.

It skips an episode when its title already exists, so it is safe to rerun after an interrupted upload:

```bash
npm run upload:buzzsprout -- --dry-run
npm run upload:buzzsprout
```
