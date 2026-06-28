import fs from "node:fs";
import path from "node:path";

const binPath = path.join(process.cwd(), "dist", "apps", "cli", "bin", "devtask.js");
const templateSourceDir = path.join(process.cwd(), "scripts");
const templateTargetDir = path.join(process.cwd(), "dist", "templates", "scripts");
const smokeScripts = ["smoke-regular.sh", "smoke-polyrepo.sh"];

if (fs.existsSync(binPath)) {
  fs.chmodSync(binPath, 0o755);
}

fs.mkdirSync(templateTargetDir, { recursive: true });
for (const script of smokeScripts) {
  const source = path.join(templateSourceDir, script);
  const target = path.join(templateTargetDir, script);
  if (!fs.existsSync(source)) {
    continue;
  }

  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o755);
}
