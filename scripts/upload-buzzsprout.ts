import "dotenv/config";
import { createBuzzsproutClient, readGeneratedEpisode } from "../src/buzzsprout.js";

// The week of August 11–19 was uploaded manually and is intentionally not here.
const TARGET_WEEKS = [
  "week-august-25-2026-september-2-2026",
  "week-september-1-9-2026",
  "week-september-15-23-2026",
  "week-september-22-23-2026",
  "week-september-8-16-2026"
] as const;

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) {
    for (const week of TARGET_WEEKS) {
      const episode = await readGeneratedEpisode(week);
      console.log(`[dry-run] ${episode.week}: ${episode.title}`);
    }
    return;
  }

  const client = await createBuzzsproutClient();
  for (const week of TARGET_WEEKS) {
    const result = await client.publishGeneratedEpisode(week);
    console.log(result.skipped
      ? `Skipping already-uploaded episode: ${result.title}`
      : `Published ${result.week} as Buzzsprout episode ${result.episodeId}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
