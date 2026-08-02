import { chmod, cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "src/generated");
const targetDir = path.join(root, "dist/generated");

await mkdir(targetDir, { recursive: true });

// Runtime policy + types only. tool-name-abbreviations.json is generation/verification-only.
for (const fileName of ["operations.manifest.json", "openapi.d.ts"]) {
  await cp(path.join(sourceDir, fileName), path.join(targetDir, fileName));
}

const binFiles = [
  path.join(root, "dist/transport/stdio.js"),
  path.join(root, "dist/transport/http.js"),
];

for (const binFile of binFiles) {
  try {
    await chmod(binFile, 0o755);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      continue;
    }
    throw error;
  }
}

console.log("Copied runtime JSON/type artifacts to dist/generated");
