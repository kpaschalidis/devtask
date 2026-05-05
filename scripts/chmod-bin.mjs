import fs from "node:fs";
import path from "node:path";

const binPath = path.join(process.cwd(), "dist", "bin", "devtask.js");

if (fs.existsSync(binPath)) {
  fs.chmodSync(binPath, 0o755);
}
