import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Run } from "./types.js";

const dataDir = process.env.DATA_DIR ?? "./data";
const statePath = path.resolve(dataDir, "runs.json");

async function readRuns(): Promise<Run[]> {
  try {
    return JSON.parse(await readFile(statePath, "utf8")) as Run[];
  } catch {
    return [];
  }
}

export async function listRuns(): Promise<Run[]> {
  return readRuns();
}

export async function getRun(id: string): Promise<Run | undefined> {
  return (await readRuns()).find((run) => run.id === id);
}

export async function saveRun(run: Run): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const runs = await readRuns();
  const index = runs.findIndex((item) => item.id === run.id);
  if (index === -1) runs.unshift(run);
  else runs[index] = run;
  await writeFile(statePath, JSON.stringify(runs, null, 2));
}
