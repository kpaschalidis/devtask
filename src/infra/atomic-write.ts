import fs from "node:fs";
import path from "node:path";

export function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  // Temp file in same directory guarantees same filesystem → rename is atomic
  const tmp = path.join(dir, `.devtask-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    fs.writeFileSync(filePath, content);
  }
}
