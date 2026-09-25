import "dotenv/config";
import { executeRun } from "./pipeline.js";
import type { SourceId } from "./types.js";

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index].replace(/^--/, ""), process.argv[index + 1]);
const source = args.get("source") as SourceId | undefined;
if (!source || !["javascript-weekly", "this-week-in-react"].includes(source)) throw new Error("Use --source javascript-weekly|this-week-in-react");
const run = await executeRun({ source, requestedUrl: args.get("url"), issueNumber: args.get("issue"), bypass: args.has("bypass") });
console.log(JSON.stringify(run, null, 2));
