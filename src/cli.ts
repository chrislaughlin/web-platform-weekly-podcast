import "dotenv/config";
import { executeRun } from "./pipeline.js";
import type { RunSource } from "./types.js";

const args = new Map<string, string[]>();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index].replace(/^--/, "");
  const value = process.argv[index + 1]?.startsWith("--") ? undefined : process.argv[++index];
  args.set(key, [...(args.get(key) ?? []), ...(value ? [value] : [])]);
}
const first = (key: string) => args.get(key)?.[0];
const source = first("source") as RunSource | undefined;
if (!source || !["javascript-weekly", "this-week-in-react", "both"].includes(source)) throw new Error("Use --source javascript-weekly|this-week-in-react|both");
const urls = args.get("url") ?? [];
const run = await executeRun({ source, requestedUrls: urls.length ? urls : undefined, issueNumber: first("issue"), bypass: args.has("bypass"), publishToBuzzsprout: !args.has("skip-upload") });
console.log(JSON.stringify(run, null, 2));
if (run.status === "failed") process.exitCode = 1;
