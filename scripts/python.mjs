// Shared helpers for the optional Python runtimes (model evaluation, trimsaw camera view, band saw
// calibration). They live outside any one skill so each plugin can ship without the others' skills.
import { spawn, spawnSync } from "node:child_process";

// A Python 3.10+ (or 3.minMinor+) to build a runtime from; the first that answers wins.
export function findPython(run = spawnSync, candidates = [process.env.ZIRA_PYTHON, "python3", "python3.12", "python3.13", "python3.11", "python3.14", "python3.10", "python"], { minMinor = 10 } = {}) {
  for (const cmd of candidates.filter(Boolean)) {
    const r = run(cmd, ["-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"], { encoding: "utf8" });
    const version = r.status === 0 ? r.stdout.trim() : "";
    const [major, minor] = version.split(".").map(Number);
    if (major === 3 && minor >= minMinor) return { command: cmd, version };
  }
  return null;
}

export function exec(cmd, args, { onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => {
      err += d;
      if (onLine) for (const line of String(d).split("\n").filter(Boolean)) onLine(line);
    });
    child.on("error", reject);
    child.on("close", code => resolve({ code, out, err }));
  });
}
