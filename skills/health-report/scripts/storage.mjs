import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT" && fallback !== undefined) return fallback;
    throw e;
  }
}
export async function writePrivate(file, value) {
  await fs.mkdir(path.dirname(path.resolve(file)), {
    recursive: true,
    mode: 0o700,
  });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(
    tmp,
    typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  await fs.rename(tmp, file);
}
export async function withLock(file, fn) {
  await fs.mkdir(path.dirname(path.resolve(file)), {
    recursive: true,
    mode: 0o700,
  });
  let h;
  try {
    h = await fs.open(file, "wx", 0o600);
  } catch (e) {
    if (e.code === "EEXIST")
      throw new Error(
        "Another run holds this state lock. If a run crashed, inspect it before removing the lock.",
      );
    throw e;
  }
  try {
    await h.writeFile(
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
    );
    return await fn();
  } finally {
    await h.close();
    await fs.unlink(file);
  }
}
