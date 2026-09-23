import { copyFile, mkdir } from "node:fs/promises";
const files = ["sharedCodexAppServerProxy.mjs", "sharedCodexRetryPolicy.mjs"];

await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
for (const filename of files) {
  await copyFile(
    new URL(`../src/provider/Layers/${filename}`, import.meta.url),
    new URL(`../dist/${filename}`, import.meta.url),
  );
}
