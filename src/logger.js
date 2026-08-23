import { randomUUID } from "node:crypto";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LOG_DIRECTORY = path.join(sourceDirectory, "..", "logs");

export async function writeCodexLog(
  result,
  logDirectory = DEFAULT_LOG_DIRECTORY
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

export async function clearCodexLogs(logDirectory = DEFAULT_LOG_DIRECTORY) {
  let entries;
  try {
    entries = await readdir(logDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return { deleted: 0 };
    throw error;
  }

  const logFiles = entries.filter(
    (entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".json"
  );
  await Promise.all(logFiles.map((entry) => unlink(path.join(logDirectory, entry.name))));
  return { deleted: logFiles.length };
}
