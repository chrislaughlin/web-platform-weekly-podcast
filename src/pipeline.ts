import "dotenv/config";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import * as cheerio from "cheerio";
import OpenAI from "openai";
import sharp from "sharp";
import { causeDetails, errorDetails, loggedStage, logger } from "./logger.js";
import { listRuns, saveRun } from "./store.js";
import type { Article, GeneratedEpisode, GeneratedEpisodesFile, NewsletterIssue, PodcastScript, Run, RunSource, SourceId } from "./types.js";

const artifactDir = path.resolve(process.env.DATA_DIR ?? "./data", "artifacts");
const generatedEpisodesPath = path.resolve(process.env.GENERATED_EPISODES_PATH ?? "./generated-episodes.json");
const execFileAsync = promisify(execFile);
const openai = process.env.OPENAI_API_KEY ? new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: Number(process.env.OPENAI_TIMEOUT_MS ?? 120000),
  maxRetries: Number(process.env.OPENAI_MAX_RETRIES ?? 1)
}) : undefined;

const defaults: Record<SourceId, string> = {
  "javascript-weekly": "https://javascriptweekly.com/",
  "this-week-in-react": "https://thisweekinreact.com/newsletter"
};

const storyStopWords = new Set("a an and are as at by for from in into is it of on or the their this to with".split(" "));
const configuredMinimumScriptWords = Number(process.env.MIN_SCRIPT_WORDS ?? 2250);
const minimumScriptWords = Number.isFinite(configuredMinimumScriptWords) && configuredMinimumScriptWords > 0
  ? Math.round(configuredMinimumScriptWords)
  : 2250;

export type StoryGroup = {
  id: string;
  title: string;
  summary: string;
  urls: string[];
  sources: SourceId[];
  occurrences: number;
};

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) url.searchParams.delete(key);
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.trim();
  }
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function storyTitleKey(value: string): string {
  return clean(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !storyStopWords.has(word) && !/^\d+$/.test(word))
    .join(" ");
}

function storyTitleSimilarity(left: string, right: string): number {
  const leftWords = new Set(storyTitleKey(left).split(" ").filter(Boolean));
  const rightWords = new Set(storyTitleKey(right).split(" ").filter(Boolean));
  if (!leftWords.size || !rightWords.size) return 0;
  const intersection = [...leftWords].filter((word) => rightWords.has(word)).length;
  return intersection / new Set([...leftWords, ...rightWords]).size;
}

function sameStory(left: Article, right: StoryGroup): boolean {
  if (right.urls.some((url) => canonicalUrl(url) === canonicalUrl(left.url))) return true;
  const similarity = storyTitleSimilarity(left.title, right.title);
  return similarity >= 0.75 && Math.min(storyTitleKey(left.title).split(" ").length, storyTitleKey(right.title).split(" ").length) >= 3;
}

export function groupStories(issues: NewsletterIssue[]): StoryGroup[] {
  const groups: StoryGroup[] = [];
  for (const issue of issues) {
    for (const article of issue.articles) {
      const existing = groups.find((group) => sameStory(article, group));
      if (existing) {
        if (!existing.urls.some((url) => canonicalUrl(url) === canonicalUrl(article.url))) existing.urls.push(article.url);
        if (!existing.sources.includes(issue.source)) existing.sources.push(issue.source);
        existing.occurrences += 1;
        if (article.summary.length > existing.summary.length) existing.summary = article.summary;
        continue;
      }
      groups.push({
        id: `story-${groups.length + 1}`,
        title: article.title,
        summary: article.summary,
        urls: [article.url],
        sources: [issue.source],
        occurrences: 1
      });
    }
  }
  return groups;
}

async function readGeneratedEpisodes(): Promise<GeneratedEpisode[]> {
  try {
    const parsed = JSON.parse(await readFile(generatedEpisodesPath, "utf8")) as GeneratedEpisodesFile | GeneratedEpisode[];
    if (Array.isArray(parsed)) return parsed;
    if (parsed?.version === 1 && Array.isArray(parsed.episodes)) return parsed.episodes;
    throw new Error(`Invalid generated episode manifest: ${generatedEpisodesPath}`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

function issueContentHashKey(issues: NewsletterIssue[]): string {
  return issues.map((issue) => issue.contentHash).sort().join("|");
}

function generatedEpisodeMatchesIssues(episode: GeneratedEpisode, issues: NewsletterIssue[]): boolean {
  return episode.issueContentHashes.length === issues.length && episode.issueContentHashes.slice().sort().join("|") === issueContentHashKey(issues);
}

async function recordGeneratedEpisode(run: Run, issues: NewsletterIssue[], script: PodcastScript): Promise<void> {
  const episodes = await readGeneratedEpisodes();
  const entry: GeneratedEpisode = {
    id: run.id,
    source: run.source,
    issueContentHashes: issues.map((issue) => issue.contentHash),
    issueUrls: issues.map((issue) => issue.url),
    issueNumbers: issues.map((issue) => issue.issueNumber).filter((issueNumber): issueNumber is string => Boolean(issueNumber)),
    title: script.title,
    artifactFolder: run.artifactFolder ?? "",
    generatedAt: run.updatedAt
  };
  const document: GeneratedEpisodesFile = { version: 1, episodes: [entry, ...episodes] };
  await writeFile(generatedEpisodesPath, `${JSON.stringify(document, null, 2)}\n`);
}

function parsePublicationDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const dateOnly = value.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,|\s)\s*(\d{4})$/);
  if (dateOnly) {
    const month = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].indexOf(dateOnly[1]);
    return new Date(Date.UTC(Number(dateOnly[3]), month, Number(dateOnly[2])));
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed;
}

function resolveUrl(source: SourceId, requestedUrl?: string, issueNumber?: string): string {
  if (requestedUrl) return requestedUrl;
  if (source === "javascript-weekly" && issueNumber) return `https://javascriptweekly.com/issues/${issueNumber}`;
  return defaults[source];
}

function runArtifactDir(folderName: string): string {
  return path.join(artifactDir, folderName);
}

function weekArtifactFolder(issues: NewsletterIssue[]): { folderName: string; label: string } {
  const dates = issues
    .map((issue) => issue.publishedAt ? new Date(issue.publishedAt) : undefined)
    .filter((date): date is Date => Boolean(date && !Number.isNaN(date.valueOf())))
    .sort((a, b) => a.valueOf() - b.valueOf());
  const first = dates[0] ?? new Date();
  const last = dates.at(-1) ?? first;
  const sameMonthAndYear = first.getUTCMonth() === last.getUTCMonth() && first.getUTCFullYear() === last.getUTCFullYear();
  const label = sameMonthAndYear
    ? `week ${first.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" })} ${first.getUTCDate()}-${last.getUTCDate()}, ${last.getUTCFullYear()}`
    : `week ${first.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}-${last.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
  return { label, folderName: label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") };
}

export async function fetchIssue(source: SourceId, requestedUrl?: string, issueNumber?: string): Promise<NewsletterIssue> {
  const url = resolveUrl(source, requestedUrl, issueNumber);
  logger.info("issue.fetch.requested", { source, url, issueNumber });
  const response = await fetch(url, { headers: { "user-agent": "web-platform-weekly-podcast/0.1" } });
  logger.info("issue.fetch.responded", { source, url, status: response.status, contentType: response.headers.get("content-type") });
  if (!response.ok) throw new Error(`Could not fetch newsletter (${response.status}): ${url}`);
  const html = await response.text();
  const $ = cheerio.load(html);
  const title = clean($("h1").first().text() || $("title").text() || source);
  const issueText = url.match(/\/issues\/(\d+)/)?.[1] ?? url.match(/\/newsletter\/(\d+)/)?.[1] ?? clean($("body").text()).match(/#(\d{2,4})/)?.[1] ?? issueNumber;
  const visibleDate = clean($("time").first().attr("datetime") || $("time").first().text()) || clean($("body").text()).match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?(?:,|\s)\s*\d{4}\b/)?.[0];
  const publishedAt = parsePublicationDate(visibleDate)?.toISOString();
  const articles: Article[] = [];
  const seen = new Set<string>();
  $(".mainlink a, p.desc a, h2 a, h3 a, article a").each((_, element) => {
    const node = $(element);
    const heading = clean(node.is("a") ? node.text() : node.find("a").first().text() || node.text());
    const href = node.is("a") ? node.attr("href") : node.find("a").first().attr("href");
    if (!heading || heading.length < 12 || !href) return;
    let absolute: string;
    try { absolute = new URL(href, url).toString(); } catch { return; }
    const normalized = canonicalUrl(absolute);
    if (normalized.includes("javascriptweekly.com/issues") || normalized.includes("thisweekinreact.com/newsletter")) return;
    const fingerprint = hash(`${heading.toLowerCase()}|${normalized}`);
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    articles.push({ title: heading, url: absolute, summary: clean(node.parent().text()).slice(0, 500), fingerprint });
  });
  if (!articles.length) throw new Error(`No articles found at ${url}`);
  const issue = { source, issueNumber: issueText, title, publishedAt, url, contentHash: hash(html), articles: articles.slice(0, 40) };
  logger.info("issue.parsed", { source, url, issueNumber: issueText, articleCount: issue.articles.length, contentHash: issue.contentHash });
  return issue;
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  return (fenced ?? text).trim();
}

export function renderPodcastNarration(script: PodcastScript): string {
  const opening = script.narration.trim();
  const segments = script.segments
    .map(renderSegmentNarration)
    .filter(Boolean)
    .join("\n\n");
  return [opening, segments].filter(Boolean).join("\n\n");
}

function renderSegmentNarration(segment: PodcastScript["segments"][number]): string {
  return [
    segment.title.trim(),
    segment.description.trim(),
    segment.whyItMatters.trim() ? `Why it matters: ${segment.whyItMatters.trim()}` : "",
    segment.followUps.trim() ? `Follow-ups: ${segment.followUps.trim()}` : "",
    segment.narration.trim()
  ].filter(Boolean).join("\n\n");
}

function spokenWordCount(script: PodcastScript): number {
  return renderPodcastNarration(script).match(/\b[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)?\b/gu)?.length ?? 0;
}

function hasSpokenClosing(scriptNarration: string, finalNarration: string): boolean {
  return /(thanks for listening|thank you for listening|until next time|signing off|goodbye|we(?:'|’)ll be back|we will be back|that(?:'|’)s all for this episode)/i.test(`${scriptNarration} ${finalNarration}`.slice(-1200));
}

function appendPodcastClosing(narration: string, mainTopics: string[] | undefined, segments: PodcastScript["segments"]): string {
  const topics = (mainTopics?.length ? mainTopics : segments.slice(0, 3).map((segment) => segment.title)).slice(0, 3);
  const topicSummary = topics.length === 1
    ? topics[0]
    : topics.length === 2
      ? `${topics[0]} and ${topics[1]}`
      : `${topics.slice(0, -1).join(", ")}, and ${topics.at(-1) ?? "the week’s strongest stories"}`;
  const closing = `To wrap up, we covered ${topicSummary}. Thanks for listening to Web Platform Weekly. Until next time, keep building, keep testing, and keep the web moving forward.`;
  return [narration.trim(), closing].filter(Boolean).join("\n\n");
}

function normalizeScript(value: PodcastScript, storyGroups: StoryGroup[]): PodcastScript {
  const rawSegments = Array.isArray(value.segments) ? value.segments : [];
  const seenGroups = new Set<string>();
  const seenTitles: string[] = [];
  const segments = rawSegments.map((segment) => {
    const title = clean(String(segment.title ?? ""));
    const sourceUrls = [...new Set([
      ...(Array.isArray(segment.sourceUrls) ? segment.sourceUrls : []),
      ...(segment.sourceUrl ? [String(segment.sourceUrl)] : [])
    ].map(String).filter(Boolean))];
    const matchingGroup = storyGroups.find((group) =>
      (segment.storyId && group.id === segment.storyId) ||
      sourceUrls.some((url) => group.urls.some((groupUrl) => canonicalUrl(groupUrl) === canonicalUrl(url))) ||
      storyTitleSimilarity(title, group.title) >= 0.75
    );
    const storyId = matchingGroup?.id ?? segment.storyId;
    const duplicate = storyId ? seenGroups.has(storyId) : seenTitles.some((seenTitle) => storyTitleSimilarity(seenTitle, title) >= 0.75);
    if (duplicate) return undefined;
    if (storyId) seenGroups.add(storyId);
    seenTitles.push(title);
    const resolvedUrls = matchingGroup?.urls ?? sourceUrls;
    return {
      storyId,
      title,
      sourceUrl: resolvedUrls[0] ?? "",
      sourceUrls: resolvedUrls,
      description: clean(String(segment.description ?? "")),
      whyItMatters: clean(String(segment.whyItMatters ?? "")),
      followUps: clean(String(segment.followUps ?? "")),
      narration: clean(String(segment.narration ?? ""))
    };
  }).filter((segment): segment is NonNullable<typeof segment> => Boolean(segment?.title && segment.sourceUrl && segment.narration));
  const narration = String(value.narration ?? "").trim();
  const mainTopics = Array.isArray(value.mainTopics) ? value.mainTopics.map((topic) => clean(String(topic))).filter(Boolean) : undefined;
  if (segments.length && !hasSpokenClosing(narration, segments.at(-1)?.narration ?? "")) {
    const finalSegment = segments.at(-1);
    if (finalSegment) finalSegment.narration = appendPodcastClosing(finalSegment.narration, mainTopics, segments);
  }
  return {
    title: clean(String(value.title ?? "")),
    description: clean(String(value.description ?? "")),
    narration,
    mainTopics,
    segments
  };
}

export function renderPodcastDescription(script: PodcastScript, issues: NewsletterIssue[]): string {
  const storyGroups = groupStories(issues);
  const links = new Map<string, string>();
  for (const segment of script.segments) {
    const group = storyGroups.find((candidate) => candidate.id === segment.storyId || candidate.urls.some((url) => canonicalUrl(url) === canonicalUrl(segment.sourceUrl)));
    const urls = group?.urls ?? segment.sourceUrls ?? [segment.sourceUrl];
    for (const url of urls) {
      const article = issues.flatMap((issue) => issue.articles).find((candidate) => canonicalUrl(candidate.url) === canonicalUrl(url));
      links.set(canonicalUrl(url), `${article?.title ?? segment.title} — ${url}`);
    }
  }
  const oneLineDescription = clean(script.description) || clean(script.title);
  return [oneLineDescription, "", "Articles covered:", ...[...links.values()].map((link) => `- ${link}`), ""].join("\n");
}

function splitText(text: string, maxCharacters: number): string[] {
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (paragraph.length > maxCharacters) {
      if (current) chunks.push(current), current = "";
      let remaining = paragraph;
      while (remaining.length > maxCharacters) {
        const boundary = remaining.lastIndexOf(" ", maxCharacters);
        const cut = boundary > Math.floor(maxCharacters * 0.6) ? boundary : maxCharacters;
        chunks.push(remaining.slice(0, cut).trim());
        remaining = remaining.slice(cut).trim();
      }
      if (remaining) chunks.push(remaining);
      continue;
    }
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > maxCharacters) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function speechChunks(script: PodcastScript, maxCharacters: number): string[] {
  const addSentencePauses = (text: string): string => text.replace(/([.!?])\s+(?=[A-Z0-9])/g, "$1\n");
  return [script.narration, ...script.segments.map(renderSegmentNarration)]
    .map(addSentencePauses)
    .flatMap((text) => splitText(text, maxCharacters));
}

async function generateScript(issues: NewsletterIssue[]): Promise<PodcastScript> {
  if (!openai) throw new Error("OPENAI_API_KEY is required to generate a script");
  const model = process.env.OPENAI_TEXT_MODEL ?? "gpt-5";
  const storyGroups = groupStories(issues);
  logger.info("script.requested", { model, issueCount: issues.length, articleCount: issues.reduce((total, issue) => total + issue.articles.length, 0), distinctStoryCount: storyGroups.length, duplicateStoryCount: issues.reduce((total, issue) => total + issue.articles.length, 0) - storyGroups.length, minimumScriptWords });
  const input = `You are the editor and host of a thoughtful weekly podcast for JavaScript and React developers.
Create one original, flowing episode that is at least 15 minutes long when spoken at a measured pace. Aim for 2,400-2,800 spoken words and never return fewer than ${minimumScriptWords} spoken words. Cover 8-12 of the strongest distinct story groups below with enough context and analysis to make the episode useful, not padded. Use short sentences and put each sentence on its own line inside narration so the voice has natural pauses.

The episode flow is mandatory:
1. The opening narration must be an inviting intro that explicitly lists the main topics listeners will hear.
2. Every segment must state the post's title, describe what it is about, explain why it is valuable to developers, and give concrete follow-ups or what to watch next. Use natural transitions between sections.
3. End the final segment or narration with a light summary and an actual sign-off. The final sentence must contain the recap and farewell. Do not end with a promise such as "we'll summarize next" or "then a quick summary" without immediately delivering that summary and sign-off.

The input has already been grouped for duplicate detection. A story group with occurrences greater than one was covered by more than one newsletter. Mention that cross-newsletter signal once when useful, but create only one segment for that group. Never create two segments for the same group or repeat the same story under a different title. Do not treat each newsletter as a separate episode. Do not invent facts or copy newsletter prose. Preserve the supplied source URLs in sourceUrls.

Return JSON only with keys title, description, mainTopics, narration, segments. description must be a one-sentence episode description. mainTopics must be a concise array of the topics named in the intro. Each segment must have storyId, title, sourceUrl, sourceUrls, description, whyItMatters, followUps, narration. sourceUrl must be the first URL in sourceUrls. The segment narration should be natural spoken detail that complements the three structured fields rather than repeating them verbatim.

Story groups: ${JSON.stringify(storyGroups)}`;

  const requestScript = async (requestInput: string): Promise<PodcastScript> => {
    let response;
    try {
      response = await openai.responses.create({ model, input: requestInput });
    } catch (error) {
      logger.error("script.openai.failed", { model, ...errorDetails(error), ...causeDetails(error) });
      if (error instanceof OpenAI.APIConnectionError) {
        const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
        throw new Error(`OpenAI connection failed${cause}. Check network, proxy, TLS, or firewall settings.`);
      }
      if (error instanceof OpenAI.APIError) {
        throw new Error(`OpenAI API failed (${error.status ?? "unknown status"}): ${error.message}`);
      }
      throw error;
    }
    return normalizeScript(JSON.parse(extractJson(response.output_text)) as PodcastScript, storyGroups);
  };

  let script = await requestScript(input);
  let wordCount = spokenWordCount(script);
  if (wordCount < minimumScriptWords) {
    logger.warn("script.too-short", { model, wordCount, minimumScriptWords });
    script = await requestScript(`${input}\n\nThe previous draft was only ${wordCount} spoken words after duplicate removal. Expand the section explanations, developer value, examples, and follow-ups while keeping the exact one-segment-per-story-group rule. Return a complete replacement JSON document, not an outline.`);
    wordCount = spokenWordCount(script);
  }
  if (wordCount < minimumScriptWords) throw new Error(`Generated script is too short (${wordCount} spoken words; minimum is ${minimumScriptWords}). Try again or lower MIN_SCRIPT_WORDS intentionally.`);
  logger.info("script.generated", { model, title: script.title, segmentCount: script.segments.length, wordCount, openingCharacters: script.narration.length, renderedNarrationCharacters: renderPodcastNarration(script).length });
  return script;
}

async function generateAudio(runId: string, folderName: string, script: PodcastScript): Promise<string> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!apiKey || !voiceId) throw new Error("ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID are required to generate audio");
  const configuredModel = process.env.ELEVENLABS_MODEL;
  const model = configuredModel ?? "eleven_multilingual_v2";
  const modelLimit = speechModelLimits[model] ?? 10000;
  const maxChunkCharacters = Math.max(1000, modelLimit - 500);
  const configuredSpeed = Number(process.env.ELEVENLABS_SPEED ?? "1.0");
  const speed = Number.isFinite(configuredSpeed) ? Math.min(1.1, Math.max(0.7, configuredSpeed)) : 1.0;
  const configuredGap = Number(process.env.ELEVENLABS_CHUNK_GAP_SECONDS ?? "0.45");
  const chunkGapSeconds = Number.isFinite(configuredGap) ? Math.min(2, Math.max(0, configuredGap)) : 0.45;
  const chunks = speechChunks(script, maxChunkCharacters);
  const temporaryDir = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "web-platform-weekly-audio-"));
  const chunkPaths: string[] = [];
  logger.info("audio.requested", { runId, provider: "elevenlabs", model, speed, chunkGapSeconds, voiceConfigured: Boolean(voiceId), narrationCharacters: renderPodcastNarration(script).length, segmentCount: script.segments.length, chunkCount: chunks.length, maxChunkCharacters });
  try {
    for (const [index, text] of chunks.entries()) {
      const previousText = chunks[index - 1]?.slice(-500);
      const nextText = chunks[index + 1]?.slice(0, 500);
      logger.info("audio.chunk.requested", { runId, chunkIndex: index, chunkCount: chunks.length, model, characters: text.length });
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          text,
          model_id: model,
          previous_text: previousText,
          next_text: nextText,
          voice_settings: { speed }
        })
      });
      logger.info("audio.chunk.responded", { runId, chunkIndex: index, chunkCount: chunks.length, provider: "elevenlabs", status: response.status, contentType: response.headers.get("content-type") });
      if (!response.ok) {
        const errorBody = await response.text();
        let providerMessage = errorBody.slice(0, 500);
        try {
          const parsed = JSON.parse(errorBody) as { detail?: { status?: string; message?: string } };
          providerMessage = parsed.detail?.message || parsed.detail?.status || providerMessage;
        } catch {
          // Preserve the HTTP error even if the provider sends a non-JSON response.
        }
        logger.error("audio.provider-failed", { runId, chunkIndex: index, chunkCount: chunks.length, provider: "elevenlabs", status: response.status, model, providerMessage });
        throw new Error(`ElevenLabs failed on chunk ${index + 1}/${chunks.length} (${response.status}): ${providerMessage}`);
      }
      const chunkPath = path.join(temporaryDir, `chunk-${String(index).padStart(3, "0")}.mp3`);
      const audio = Buffer.from(await response.arrayBuffer());
      await writeFile(chunkPath, audio);
      chunkPaths.push(chunkPath);
      logger.info("audio.chunk.saved", { runId, chunkIndex: index, chunkCount: chunks.length, bytes: audio.byteLength });
    }
    const concatList = path.join(temporaryDir, "concat.txt");
    const ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg";
    const concatEntries = chunkPaths.map((chunkPath) => `file '${chunkPath.replaceAll("'", "'\\''")}'`);
    if (chunkGapSeconds > 0 && chunkPaths.length > 1) {
      const silencePath = path.join(temporaryDir, "chunk-gap.mp3");
      await execFileAsync(ffmpegPath, ["-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", String(chunkGapSeconds), "-q:a", "9", silencePath]);
      const silenceEntry = `file '${silencePath.replaceAll("'", "'\\''")}'`;
      const entriesWithGaps: string[] = [];
      for (const [index, entry] of concatEntries.entries()) {
        entriesWithGaps.push(entry);
        if (index < concatEntries.length - 1) entriesWithGaps.push(silenceEntry);
      }
      await writeFile(concatList, entriesWithGaps.join("\n"));
    } else {
      await writeFile(concatList, concatEntries.join("\n"));
    }
    const filePath = path.join(runArtifactDir(folderName), "audio", "audio.mp3");
    await execFileAsync(ffmpegPath, ["-y", "-f", "concat", "-safe", "0", "-i", concatList, "-ar", "44100", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "128k", filePath]);
    logger.info("audio.saved", { runId, filePath, chunkCount: chunks.length });
    return filePath;
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

const speechModelLimits: Record<string, number> = {
  eleven_v3: 5000,
  eleven_multilingual_v1: 10000,
  eleven_multilingual_v2: 10000,
  eleven_flash_v2: 30000,
  eleven_flash_v2_5: 40000
};

export function selectElevenLabsModel(configuredModel: string | undefined, narrationCharacters: number): string {
  const requestedModel = configuredModel ?? "eleven_multilingual_v2";
  const requestedLimit = speechModelLimits[requestedModel];
  if (requestedLimit && narrationCharacters > requestedLimit) {
    if (configuredModel) {
      throw new Error(`ElevenLabs model ${requestedModel} supports ${requestedLimit} characters, but this script has ${narrationCharacters}. Set ELEVENLABS_MODEL=eleven_flash_v2_5 or shorten the script.`);
    }
    return "eleven_flash_v2_5";
  }
  return requestedModel;
}

function extractCoverKeywords(script: PodcastScript): string {
  const text = `${script.title} ${script.description} ${script.narration} ${script.segments.map((segment) => `${segment.title} ${segment.narration}`).join(" ")}`.toLowerCase();
  const stopWords = new Set("about after again against all also and are been being between both but can create from have into its more most other our over should that their these they this through using were what when where which with would your".split(" "));
  const words = text.match(/[a-z][a-z-]{4,}/g) ?? [];
  const counts = new Map<string, number>();
  for (const word of words) if (!stopWords.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([word]) => word).join(", ") || "web platform, developer tools, software architecture";
}

async function applyDotsStyle(image: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const spacing = 8;
  const circles: string[] = [];

  for (let y = Math.floor(spacing / 2); y < info.height; y += spacing) {
    for (let x = Math.floor(spacing / 2); x < info.width; x += spacing) {
      const offset = (y * info.width + x) * info.channels;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
      const radius = 0.75 + luminance * 2.35;
      const opacity = 0.28 + luminance * 0.65;
      circles.push(`<circle cx="${x}" cy="${y}" r="${radius.toFixed(2)}" fill="rgb(${red},${green},${blue})" opacity="${opacity.toFixed(2)}"/>`);
    }
  }

  const dots = Buffer.from(`<svg width="${info.width}" height="${info.height}" viewBox="0 0 ${info.width} ${info.height}" xmlns="http://www.w3.org/2000/svg">${circles.join("")}</svg>`);
  return sharp(image)
    .modulate({ saturation: 0.92 })
    .composite([{ input: dots, blend: "over" }])
    .png()
    .toBuffer();
}

async function generateCover(runId: string, folderName: string, script: PodcastScript): Promise<string> {
  if (!openai) throw new Error("OPENAI_API_KEY is required to generate cover art");
  const model = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2.5-flare";
  const keywords = extractCoverKeywords(script);
  logger.info("cover.requested", { runId, model, keywords });
  const basePrompt = `Square podcast cover art inspired by these script keywords: ${keywords}. Stylized architectural illustration, mid-century editorial aesthetic, cinematic golden-hour lighting, semi-realistic digital painting. Evoke interconnected web platforms, software systems, and ideas through an elegant architectural scene. No words, letters, logos, or brand marks.`;
  const result = await openai.images.generate({
    model,
    prompt: `${basePrompt} Generate the clean base artwork first; a separate post-processing pass will apply the final ASCII Magic-inspired dots treatment, so do not render a dot pattern yourself. Keep broad tonal shapes and architectural silhouettes clear enough to remain legible through that treatment.`,
    size: "1024x1024",
    output_format: "png"
  });
  const encoded = result.data?.[0]?.b64_json;
  if (!encoded) throw new Error("OpenAI returned no cover image");
  const filePath = path.join(runArtifactDir(folderName), "cover-art", "cover.png");
  const styled = await applyDotsStyle(Buffer.from(encoded, "base64"));
  await writeFile(filePath, styled);
  logger.info("cover.saved", { runId, filePath, model, style: "dots" });
  return filePath;
}

export async function executeRun(input: { source: RunSource; requestedUrl?: string; requestedUrls?: string[]; requestedUrlsBySource?: Partial<Record<SourceId, string[]>>; issueNumber?: string; bypass?: boolean }): Promise<Run> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const sources: SourceId[] = input.source === "both" ? ["javascript-weekly", "this-week-in-react"] : [input.source];
  const requestedUrls = input.requestedUrls?.length ? input.requestedUrls : input.requestedUrl ? [input.requestedUrl] : undefined;
  const runRequestedUrls = sources.flatMap((source, index) => input.requestedUrlsBySource?.[source] ?? (sources.length === 1 ? requestedUrls ?? [] : requestedUrls?.[index] ? [requestedUrls[index]] : []));
  const run: Run = { id, source: input.source, requestedUrl: runRequestedUrls[0] ?? requestedUrls?.[0], requestedUrls: runRequestedUrls.length ? runRequestedUrls : undefined, requestedIssueNumber: input.issueNumber, bypass: input.bypass === true, status: "running", createdAt: now, updatedAt: now };
  const runStartedAt = Date.now();
  logger.info("run.started", { runId: id, source: input.source, sources, requestedUrls: run.requestedUrls, issueNumber: input.issueNumber, bypass: run.bypass });
  await saveRun(run);
  try {
    await loggedStage(id, "artifact-directory", () => mkdir(artifactDir, { recursive: true }));
    const issueRequests = sources.flatMap((source, index) => {
      const sourceUrls = input.requestedUrlsBySource?.[source];
      if (sourceUrls?.length) return sourceUrls.map((url) => ({ source, url }));
      if (sources.length === 1 && requestedUrls?.length) return requestedUrls.map((url) => ({ source, url }));
      if (sources.length > 1 && requestedUrls?.[index]) return [{ source, url: requestedUrls[index] }];
      return [{ source, url: resolveUrl(source, undefined, source === "javascript-weekly" ? input.issueNumber : undefined) }];
    });
    const issues = await loggedStage(id, "fetch-and-parse-issues", async () => Promise.all(issueRequests.map(({ source, url }) => fetchIssue(source, url))), { source: input.source, sourceCount: sources.length, urlCount: issueRequests.length });
    run.issues = issues;
    run.issue = issues[0];
    const week = weekArtifactFolder(issues);
    run.artifactFolder = week.folderName;
    run.weekLabel = week.label;
    await mkdir(runArtifactDir(week.folderName), { recursive: true });
    await Promise.all(["script", "sources", "audio", "cover-art"].map((folder) => mkdir(path.join(runArtifactDir(week.folderName), folder), { recursive: true })));
    const generatedEpisodes = await loggedStage(id, "generated-episode-check", readGeneratedEpisodes, { bypass: run.bypass, manifestPath: generatedEpisodesPath });
    const previous = await loggedStage(id, "duplicate-check", () => listRuns(), { bypass: run.bypass });
    const contentHashes = new Set(issues.map((issue) => issue.contentHash));
    const manifestDuplicate = generatedEpisodes.find((episode) => episode.id !== id && generatedEpisodeMatchesIssues(episode, issues));
    const runDuplicate = previous.find((item) => item.id !== id && item.status === "completed" && (item.issues ?? (item.issue ? [item.issue] : [])).length === issues.length && (item.issues ?? (item.issue ? [item.issue] : [])).every((issue) => contentHashes.has(issue.contentHash)));
    const duplicateId = manifestDuplicate?.id ?? runDuplicate?.id;
    logger.info("duplicate-check.completed", { runId: id, bypass: run.bypass, manifestPath: generatedEpisodesPath, manifestDuplicateFound: Boolean(manifestDuplicate), runHistoryDuplicateFound: Boolean(runDuplicate), duplicateRunId: duplicateId });
    if (duplicateId && !run.bypass) throw new Error(`This issue was already processed in run ${duplicateId}. Re-run with bypass enabled for testing.`);
    const script = await loggedStage(id, "script-generation", () => generateScript(issues), { source: input.source, issueCount: issues.length });
    run.script = script;
    await writeFile(path.join(runArtifactDir(week.folderName), "script", "script.json"), JSON.stringify(script, null, 2));
    await writeFile(path.join(runArtifactDir(week.folderName), "script", "narration.txt"), renderPodcastNarration(script));
    await writeFile(path.join(runArtifactDir(week.folderName), "sources", "sources.json"), JSON.stringify(issues, null, 2));
    await writeFile(path.join(runArtifactDir(week.folderName), "podcast-title.txt"), `${script.title.trim()}\n`);
    await writeFile(path.join(runArtifactDir(week.folderName), "description.txt"), renderPodcastDescription(script, issues));
    run.audioPath = await loggedStage(id, "audio-generation", () => generateAudio(id, week.folderName, script));
    run.coverPath = await loggedStage(id, "cover-generation", () => generateCover(id, week.folderName, script));
    run.status = "completed";
    run.updatedAt = new Date().toISOString();
    await loggedStage(id, "generated-episode-record", () => recordGeneratedEpisode(run, issues, script), { manifestPath: generatedEpisodesPath });
    await saveRun(run);
    logger.info("run.completed", { runId: id, status: run.status, durationMs: Date.now() - runStartedAt, audioPath: run.audioPath, coverPath: run.coverPath });
    return run;
  } catch (error) {
    run.status = "failed";
    run.error = error instanceof Error ? error.message : String(error);
    run.updatedAt = new Date().toISOString();
    await saveRun(run);
    logger.error("run.failed", { runId: id, status: run.status, durationMs: Date.now() - runStartedAt, ...errorDetails(error) });
    return run;
  }
}
