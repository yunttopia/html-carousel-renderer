#!/usr/bin/env node
// html-carousel-renderer <post.json> <new-output-folder> [--templates file.html] [--min-pages n] [--max-pages n] [--min-tail-lines n] [--no-video]
// Env: CR_CHROME (browser executable), CR_PLAYWRIGHT_CORE_DIR (folder containing playwright-core), CR_FFMPEG (ffmpeg binary, default "ffmpeg").
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupTemp, render, RenderStop } from "./render.mjs";

// Ctrl-C / kill: remove the temporary folder next to the output folder before exiting.
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { cleanupTemp(); process.exit(130); });

const args = process.argv.slice(2);
const take = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : def; };
const flag = (name) => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0; };
const templates = take("--templates", join(dirname(fileURLToPath(import.meta.url)), "..", "templates", "basic.html"));
const minPages = Number(take("--min-pages", "2")), maxPages = Number(take("--max-pages", "20")), minTailLines = Number(take("--min-tail-lines", "4"));
const noVideo = flag("--no-video");
const [input, outDir] = args;

try {
  if (!input || !outDir) throw new RenderStop("USAGE", "html-carousel-renderer <post.json> <new-output-folder> [--templates file.html] [--no-video]");
  let post;
  try { post = JSON.parse(readFileSync(input, "utf8")); } catch { throw new RenderStop("BAD_JSON", "input is not readable JSON"); }
  const m = await render({ post, templatesHtml: readFileSync(templates, "utf8"), outDir, chrome: process.env.CR_CHROME, playwrightDir: process.env.CR_PLAYWRIGHT_CORE_DIR,
    ffmpeg: process.env.CR_FFMPEG ?? "ffmpeg", minPages, maxPages, minTailLines, video: !noVideo });
  process.stdout.write(`RENDER_OK pages=${m.pages} video=${m.video ? m.video.file : "none"} ms=${m.ms}\n`);
} catch (e) {
  process.stderr.write(`RENDER_STOP ${e instanceof RenderStop ? e.message : "ERROR " + (e?.message ?? e)}\n`);
  process.exit(e instanceof RenderStop ? 2 : 1);
}
