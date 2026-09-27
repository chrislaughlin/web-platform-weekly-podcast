import "dotenv/config";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const API_ORIGIN = "https://www.buzzsprout.com";
const USER_AGENT = "WebPlatformWeeklyPodcast/1.0";
const artifactRoot = path.resolve(process.env.DATA_DIR ?? "./data", "artifacts");

// The week of August 11–19 was uploaded manually and is intentionally not here.
const TARGET_WEEKS = [
  "week-august-25-2026-september-2-2026",
  "week-september-1-9-2026",
  "week-september-15-23-2026",
  "week-september-22-23-2026",
  "week-september-8-16-2026"
] as const;

type Episode = { id: number; title: string };
type Upload = { id: string; upload_url: string };

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function apiHeaders(token: string): Record<string, string> {
  return { Accept: "application/json", Authorization: `Token token=${token}`, "User-Agent": USER_AGENT };
}

async function responseMessage(response: Response): Promise<string> {
  const body = await response.text();
  if (!body) return `${response.status} ${response.statusText}`;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed.error?.message ?? body;
  } catch {
    return body;
  }
}

async function request(token: string, url: string, init: RequestInit = {}, retries = 3): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, { ...init, headers: { ...apiHeaders(token), ...init.headers } });
    if (response.ok) return response;
    if (attempt >= retries || (response.status < 500 && response.status !== 429)) {
      throw new Error(`${init.method ?? "GET"} ${url} failed: ${await responseMessage(response)}`);
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

async function jsonRequest<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const response = await request(token, url, {
    ...init,
    headers: { "Content-Type": "application/json; charset=utf-8", ...init.headers }
  });
  return (await response.json()) as T;
}

async function findPodcastId(token: string): Promise<string> {
  const configuredId = process.env.BUZZSPROUT_PODCAST_ID?.trim();
  if (configuredId) return configuredId;
  const podcasts = await jsonRequest<Array<{ id: number }>>(token, `${API_ORIGIN}/api/podcasts`);
  if (podcasts.length !== 1) {
    throw new Error(podcasts.length === 0
      ? "No Buzzsprout podcasts were found. Set BUZZSPROUT_PODCAST_ID in .env."
      : "More than one Buzzsprout podcast was found. Set BUZZSPROUT_PODCAST_ID in .env.");
  }
  return String(podcasts[0].id);
}

function firstNarrationParagraph(narration: string): string {
  const paragraphs = narration.split(/\r?\n\s*\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  return (paragraphs[0]?.toLowerCase() === "intro" ? paragraphs[1] : paragraphs[0]) ?? "";
}

function descriptionFromFile(description: string): string {
  return description.split(/\r?\n\s*\r?\n/)[0]?.trim() ?? "";
}

async function readEpisode(week: string) {
  const folder = path.join(artifactRoot, week);
  const audioPath = path.join(folder, "audio", "audio.mp3");
  const artworkPath = path.join(folder, "cover-art", "cover.png");
  const [audioStats, artworkStats, title, descriptionFile, narration] = await Promise.all([
    stat(audioPath), stat(artworkPath), readFile(path.join(folder, "podcast-title.txt"), "utf8"),
    readFile(path.join(folder, "description.txt"), "utf8").catch(() => ""),
    readFile(path.join(folder, "script", "narration.txt"), "utf8")
  ]);
  if (audioStats.size === 0 || artworkStats.size === 0) throw new Error(`${week} has an empty audio or artwork file`);
  const cleanedTitle = title.trim();
  const description = descriptionFromFile(descriptionFile) || firstNarrationParagraph(narration);
  if (!cleanedTitle) throw new Error(`${week} has an empty podcast-title.txt`);
  if (!description) throw new Error(`${week} has no narration paragraph`);
  return { week, audioPath, artworkPath, title: cleanedTitle, description };
}

async function createEpisode(token: string, podcastId: string, title: string, description: string): Promise<Episode> {
  return jsonRequest<Episode>(token, `${API_ORIGIN}/api/${podcastId}/episodes`, {
    method: "POST",
    body: JSON.stringify({ title, description, private: true, episode_type: "full", explicit: false })
  });
}

async function uploadAudio(token: string, podcastId: string, episodeId: number, audioPath: string): Promise<void> {
  const audio = await readFile(audioPath);
  const uploadStart = await jsonRequest<{ upload: Upload }>(token, `${API_ORIGIN}/api/${podcastId}/episodes/${episodeId}/uploads`, {
    method: "POST",
    body: JSON.stringify({ filename: path.basename(audioPath), type: "audio/mpeg", byte_size: audio.byteLength })
  });
  const upload = uploadStart.upload;
  const putResponse = await fetch(upload.upload_url, {
    method: "PUT", headers: { "Content-Length": String(audio.byteLength), "User-Agent": USER_AGENT }, body: audio
  });
  if (!putResponse.ok) throw new Error(`Audio upload failed: ${await responseMessage(putResponse)}`);
  await request(token, `${API_ORIGIN}/api/${podcastId}/episodes/${episodeId}/uploads/${encodeURIComponent(upload.id)}/complete`, { method: "POST" });
}

async function uploadArtwork(token: string, podcastId: string, episodeId: number, artworkPath: string): Promise<void> {
  const artwork = await readFile(artworkPath);
  const form = new FormData();
  form.append("artwork_file", new Blob([artwork], { type: "image/png" }), path.basename(artworkPath));
  await request(token, `${API_ORIGIN}/api/${podcastId}/episodes/${episodeId}`, { method: "PATCH", body: form });
}

async function publishEpisode(token: string, podcastId: string, episodeId: number): Promise<void> {
  await jsonRequest<Episode>(token, `${API_ORIGIN}/api/${podcastId}/episodes/${episodeId}`, {
    method: "PATCH", body: JSON.stringify({ private: false })
  });
}

async function main(): Promise<void> {
  const token = requiredEnv("BUZZ_SPROUT_API_KEY");
  const dryRun = process.argv.includes("--dry-run");
  const episodes = await Promise.all(TARGET_WEEKS.map(readEpisode));
  if (dryRun) {
    for (const episode of episodes) console.log(`[dry-run] ${episode.week}: ${episode.title}`);
    return;
  }
  const podcastId = await findPodcastId(token);
  const existingEpisodes = await jsonRequest<Episode[]>(token, `${API_ORIGIN}/api/${podcastId}/episodes`);
  const existingTitles = new Set(existingEpisodes.map((episode) => episode.title.trim()));
  for (const episode of episodes) {
    if (existingTitles.has(episode.title)) {
      console.log(`Skipping already-uploaded episode: ${episode.title}`);
      continue;
    }
    console.log(`Creating episode: ${episode.title}`);
    const created = await createEpisode(token, podcastId, episode.title, episode.description);
    await uploadAudio(token, podcastId, created.id, episode.audioPath);
    await uploadArtwork(token, podcastId, created.id, episode.artworkPath);
    await publishEpisode(token, podcastId, created.id);
    existingTitles.add(episode.title);
    console.log(`Published ${episode.week} as Buzzsprout episode ${created.id}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
