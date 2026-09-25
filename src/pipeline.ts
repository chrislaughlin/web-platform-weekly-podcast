import "dotenv/config";
import crypto from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import OpenAI from "openai";
import sharp from "sharp";
import { causeDetails, errorDetails, loggedStage, logger } from "./logger.js";
import { listRuns, saveRun } from "./store.js";
import type { Article, NewsletterIssue, PodcastScript, Run, SourceId } from "./types.js";

const artifactDir = path.resolve(process.env.DATA_DIR ?? "./data", "artifacts");
const openai = process.env.OPENAI_API_KEY ? new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: Number(process.env.OPENAI_TIMEOUT_MS ?? 120000),
  maxRetries: Number(process.env.OPENAI_MAX_RETRIES ?? 1)
}) : undefined;

const defaults: Record<SourceId, string> = {
  "javascript-weekly": "https://javascriptweekly.com/",
  "this-week-in-react": "https://thisweekinreact.com/newsletter"
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

function resolveUrl(source: SourceId, requestedUrl?: string, issueNumber?: string): string {
  if (requestedUrl) return requestedUrl;
  if (source === "javascript-weekly" && issueNumber) return `https://javascriptweekly.com/issues/${issueNumber}`;
  return defaults[source];
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
  const issueText = clean($("body").text()).match(/#(\d{2,4})/)?.[1] ?? issueNumber;
  const publishedAt = clean($("time").first().attr("datetime") || $("time").first().text()) || undefined;
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
    .map((segment) => `${segment.title.trim()}\n\n${segment.narration.trim()}`)
    .filter(Boolean)
    .join("\n\n");
  return [opening, segments].filter(Boolean).join("\n\n");
}

async function generateScript(issue: NewsletterIssue): Promise<PodcastScript> {
  if (!openai) throw new Error("OPENAI_API_KEY is required to generate a script");
  const model = process.env.OPENAI_TEXT_MODEL ?? "gpt-5";
  logger.info("script.requested", { model, articleCount: issue.articles.length, issueNumber: issue.issueNumber });
  const input = `You are the editor and host of a concise weekly podcast for JavaScript and React developers.
Create an original, flowing 8-12 minute episode from this newsletter issue. Select the strongest stories, explain why they matter, and use natural transitions. Do not invent facts or copy newsletter prose. Preserve source URLs in the JSON. Return JSON only with keys title, description, narration, segments; each segment has title, sourceUrl, narration.

Issue: ${JSON.stringify(issue)}`;
  let response;
  try {
    response = await openai.responses.create({ model, input });
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
  const script = JSON.parse(extractJson(response.output_text)) as PodcastScript;
  const renderedNarration = renderPodcastNarration(script);
  logger.info("script.generated", { model, title: script.title, segmentCount: script.segments.length, openingCharacters: script.narration.length, renderedNarrationCharacters: renderedNarration.length });
  return script;
}

async function generateAudio(runId: string, script: PodcastScript): Promise<string> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!apiKey || !voiceId) throw new Error("ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID are required to generate audio");
  const narration = renderPodcastNarration(script);
  logger.info("audio.requested", { runId, provider: "elevenlabs", model: "eleven_multilingual_v2", voiceConfigured: Boolean(voiceId), narrationCharacters: narration.length, segmentCount: script.segments.length });
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ text: narration, model_id: "eleven_multilingual_v2" })
  });
  logger.info("audio.responded", { runId, provider: "elevenlabs", status: response.status, contentType: response.headers.get("content-type") });
  if (!response.ok) throw new Error(`ElevenLabs failed (${response.status})`);
  const filePath = path.join(artifactDir, `${runId}.mp3`);
  const audio = Buffer.from(await response.arrayBuffer());
  await writeFile(filePath, audio);
  logger.info("audio.saved", { runId, filePath, bytes: audio.byteLength });
  return filePath;
}

async function generateCover(runId: string, issue: NewsletterIssue): Promise<string> {
  if (!openai) throw new Error("OPENAI_API_KEY is required to generate cover art");
  const model = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2.5-flare";
  const headlineList = issue.articles.slice(0, 8).map((article) => article.title).join("; ");
  logger.info("cover.requested", { runId, model, headlineCount: Math.min(issue.articles.length, 8) });
  const result = await openai.images.generate({
    model,
    prompt: `Square editorial podcast cover art about JavaScript, React, web engineering, and developer tools. Use an energetic modern illustration with browser windows, component graphs, and signal waves. No words, letters, logos, or brand marks. Themes from this week's headlines: ${headlineList}`,
    size: "1024x1024",
    output_format: "png"
  });
  const encoded = result.data?.[0]?.b64_json;
  if (!encoded) throw new Error("OpenAI returned no cover image");
  const label = `<svg width="1024" height="1024"><style>text{font-family:Arial,sans-serif;fill:white} .small{font-size:34px;font-weight:bold;letter-spacing:4px} .large{font-size:74px;font-weight:800}</style><text x="64" y="860" class="small">THE WEB PLATFORM WEEKLY</text><text x="64" y="940" class="large">${escapeXml(issue.issueNumber ? `ISSUE ${issue.issueNumber}` : "WEEKLY")}</text></svg>`;
  const filePath = path.join(artifactDir, `${runId}.png`);
  await sharp(Buffer.from(encoded, "base64")).composite([{ input: Buffer.from(label), blend: "over" }]).png().toFile(filePath);
  logger.info("cover.saved", { runId, filePath, model });
  return filePath;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'\"]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[character] ?? character));
}

export async function executeRun(input: { source: SourceId; requestedUrl?: string; issueNumber?: string; bypass?: boolean }): Promise<Run> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const run: Run = { id, source: input.source, requestedUrl: input.requestedUrl, requestedIssueNumber: input.issueNumber, bypass: input.bypass === true, status: "running", createdAt: now, updatedAt: now };
  const runStartedAt = Date.now();
  logger.info("run.started", { runId: id, source: input.source, requestedUrl: input.requestedUrl, issueNumber: input.issueNumber, bypass: run.bypass });
  await saveRun(run);
  try {
    await loggedStage(id, "artifact-directory", () => mkdir(artifactDir, { recursive: true }));
    const issue = await loggedStage(id, "fetch-and-parse-issue", () => fetchIssue(input.source, input.requestedUrl, input.issueNumber), { source: input.source });
    run.issue = issue;
    const previous = await loggedStage(id, "duplicate-check", () => listRuns(), { bypass: run.bypass });
    const duplicate = previous.find((item) => item.id !== id && item.status === "completed" && item.issue?.contentHash === issue.contentHash);
    logger.info("duplicate-check.completed", { runId: id, bypass: run.bypass, duplicateFound: Boolean(duplicate), duplicateRunId: duplicate?.id });
    if (duplicate && !run.bypass) throw new Error(`This issue was already processed in run ${duplicate.id}. Re-run with bypass enabled for testing.`);
    const script = await loggedStage(id, "script-generation", () => generateScript(issue), { source: input.source });
    run.script = script;
    run.audioPath = await loggedStage(id, "audio-generation", () => generateAudio(id, script));
    run.coverPath = await loggedStage(id, "cover-generation", () => generateCover(id, issue));
    run.status = "completed";
    run.updatedAt = new Date().toISOString();
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
