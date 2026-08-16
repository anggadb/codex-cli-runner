import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));

export async function writeCodexLog(
  result,
  logDirectory = path.join(sourceDirectory, "..", "logs")
) {
  const timestamp = new Date().toISOString();
  const filename = `${timestamp.replace(/[:.]/g, "-")}-${randomUUID()}.json`;
  await mkdir(logDirectory, { recursive: true });
  await writeFile(
    path.join(logDirectory, filename),
    `${JSON.stringify({ timestamp, ...result }, null, 2)}\n`,
    "utf8"
  );
}
