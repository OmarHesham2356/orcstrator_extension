import esbuild from "esbuild";
import { mkdir, cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const isWatch = process.argv.includes("--watch");
const chromeDir = "dist/extension";
const firefoxDir = "dist/extension-firefox";

await mkdir(chromeDir, { recursive: true });
await mkdir(firefoxDir, { recursive: true });

const files = [
  "extension/popup.html",
  "extension/popup.js",
  "extension/background.js",
  "extension/content.js",
  "extension/injected.js",
];

for (const f of files) {
  await cp(f, path.join(chromeDir, path.basename(f)), { recursive: true });
  await cp(f, path.join(firefoxDir, path.basename(f)), { recursive: true });
}

// Manifest strategy:
// - Source manifest.json is cross-browser (background.scripts + service_worker,
//   browser_specific_settings.gecko). Chrome ignores `scripts`+gecko keys.
// - Firefox (strict validation / AMO) gets a variant with only `scripts`.
// Both are generated at build time so `extension/` stays the single source.
const raw = JSON.parse(await readFile("extension/manifest.json", "utf8"));

const chromeManifest = { ...raw };
delete chromeManifest.browser_specific_settings;
if (chromeManifest.background) {
  const { scripts: _drop, ...rest } = chromeManifest.background;
  chromeManifest.background = { service_worker: rest.service_worker, type: rest.type };
}

const firefoxManifest = { ...raw };
if (firefoxManifest.background) {
  const { service_worker: _drop, ...rest } = firefoxManifest.background;
  firefoxManifest.background = rest; // { scripts, type? } -> event page
}

await writeFile(path.join(chromeDir, "manifest.json"), JSON.stringify(chromeManifest, null, 2));
await writeFile(path.join(firefoxDir, "manifest.json"), JSON.stringify(firefoxManifest, null, 2));

for (const outDir of [chromeDir, firefoxDir]) {
  const ctx = await esbuild.context({
    entryPoints: [
      `${outDir}/popup.js`,
      `${outDir}/background.js`,
      `${outDir}/content.js`,
      `${outDir}/injected.js`,
    ],
    bundle: true,
    format: "esm",
    outdir: outDir,
    platform: "browser",
    target: ["chrome120", "firefox121"],
    sourcemap: true,
    allowOverwrite: true,
  });

  if (isWatch) {
    await ctx.watch();
    console.log(`watching ${outDir}...`);
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    console.log(`built extension -> ${outDir}`);
  }
}
