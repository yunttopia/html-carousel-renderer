// Run: npm test   (needs a Chromium build and playwright-core — see README "Running the tests")
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "src", "cli.mjs");
const BASIC = readFileSync(join(ROOT, "templates", "basic.html"), "utf8");
const EN = JSON.parse(readFileSync(join(ROOT, "examples", "habits-en.json"), "utf8"));
const KO = JSON.parse(readFileSync(join(ROOT, "examples", "routine-ko.json"), "utf8"));
const work = mkdtempSync(join(tmpdir(), "html-carousel-renderer-test-"));
let n = 0;

/** Render a post (object) with optional template HTML and extra CLI args. */
function run(post, { templates, args = [] } = {}) {
  const id = String(++n).padStart(2, "0");
  const input = join(work, `in-${id}.json`); writeFileSync(input, JSON.stringify(post));
  const extra = [];
  if (templates) { const t = join(work, `tpl-${id}.html`); writeFileSync(t, templates); extra.push("--templates", t); }
  const out = join(work, `out-${id}`);
  const r = spawnSync(process.execPath, [CLI, input, out, ...extra, ...args], { encoding: "utf8" });
  const manifest = r.status === 0 ? JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) : null;
  return { ...r, out, manifest };
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const stopped = (r, code) => { assert.equal(r.status, 2, r.stderr); assert.match(r.stderr, new RegExp(`RENDER_STOP ${code}`)); assert.equal(existsSync(r.out), false, "no output folder after a stop"); };

for (const [name, post] of [["English", EN], ["Korean", KO]]) {
  test(`${name} example renders 3 pages with matching hashes`, () => {
    const r = run(post);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.manifest.images.map((p) => p.template), ["cover", "list", "quote"]);
    for (const p of r.manifest.images) {
      const b = readFileSync(join(r.out, p.file));
      assert.equal(createHash("sha256").update(b).digest("hex"), p.sha256);
      assert.equal(b[0], 0xff); assert.equal(b[1], 0xd8);   // JPEG
      assert.equal(b.readUInt16BE(b.indexOf(Buffer.from([0xff, 0xc0])) + 5), 1350);
    }
    if (r.manifest.video) { assert.ok(existsSync(join(r.out, r.manifest.video.file))); assert.equal(r.manifest.video.height, 1920); }
  });
}

test("long list is split; the last page keeps at least 4 lines (and 1 line when the rule is off)", () => {
  const post = { cards: [EN.cards[0], { template: "list", items: Array.from({ length: 14 }, (_, i) => `Line ${i + 1}`).join("\n") }] };
  const on = run(post), off = run(post, { args: ["--min-tail-lines", "0"] });
  assert.equal(on.status, 0, on.stderr); assert.equal(off.status, 0, off.stderr);
  const lines = (m) => m.images.filter((p) => p.template === "list").map((p) => p.split_lines);
  assert.equal(lines(on.manifest).length, 2, JSON.stringify(lines(on.manifest)));
  assert.ok(lines(on.manifest).at(-1) >= 4, JSON.stringify(lines(on.manifest)));
  assert.equal(lines(off.manifest).at(-1), 1, JSON.stringify(lines(off.manifest)));
});

test("title taller than its box stops with OVERFLOW", () => {
  const p = clone(EN); p.cards[0].title = "One\nTwo\nThree\nFour"; stopped(run(p), "OVERFLOW");
});

test("an unbreakable long word overflows sideways and stops", () => {
  const p = clone(EN); p.cards[2].quote = "Supercalifragilisticexpialidocious-and-even-longer-than-that"; stopped(run(p), "OVERFLOW");
});

test("a word broken across lines stops with KEEP_ALL (template that allows breaking anywhere)", () => {
  const p = clone(EN); p.cards[2].quote = "Supercalifragilisticexpialidocious-and-even-longer-than-that";
  stopped(run(p, { templates: BASIC.replace("overflow-wrap: normal;", "overflow-wrap: anywhere;") }), "KEEP_ALL");
});

test("overlapping text boxes stop with OVERLAP", () => {
  stopped(run(EN, { templates: BASIC.replace(".cover .subtitle { position: absolute; left: 80px; top: 930px;", ".cover .subtitle { position: absolute; left: 80px; top: 600px;") }), "OVERLAP");
});

test("unknown field, unknown template and missing required field stop with BAD_JSON", () => {
  const a = clone(EN); a.cards[0].color = "red"; stopped(run(a), "BAD_JSON");
  const b = clone(EN); b.cards[1].template = "poll"; stopped(run(b), "BAD_JSON");
  const c = clone(EN); delete c.cards[0].title; stopped(run(c), "BAD_JSON");
});

test("page count outside the allowed range stops with PAGE_COUNT", () => {
  stopped(run({ cards: [EN.cards[0]] }), "PAGE_COUNT");
});

test("an existing output folder is never overwritten", () => {
  const first = run(EN); assert.equal(first.status, 0, first.stderr);
  const input = join(work, "again.json"); writeFileSync(input, JSON.stringify(EN));
  const r = spawnSync(process.execPath, [CLI, input, first.out], { encoding: "utf8" });
  assert.equal(r.status, 2); assert.match(r.stderr, /OUT_EXISTS/);
});

test("HTML in the post is drawn as text and makes no request", () => {
  const p = clone(EN); p.cards[2].quote = 'An image <img src="http://a.b/c"> in text'; p.cards[2].by = "<img src=http://a.b/d>";
  const r = run(p); assert.equal(r.status, 0, r.stderr); assert.equal(r.manifest.checks.network_blocked, 0);
});

test("a template that loads a remote resource stops with NET_BLOCKED (request is aborted inside the browser)", () => {
  stopped(run(EN, { templates: BASIC.replace("</style>", ".card { background-image: url(http://192.0.2.1/bg.png); }\n</style>") }), "NET_BLOCKED");
});

/** Async variant of run() so a local test server can answer while the renderer runs. */
function runAsync(post, templates) {
  const id = String(++n).padStart(2, "0");
  const input = join(work, `in-${id}.json`); writeFileSync(input, JSON.stringify(post));
  const t = join(work, `tpl-${id}.html`); writeFileSync(t, templates);
  const out = join(work, `out-${id}`);
  return new Promise((res) => {
    const p = spawn(process.execPath, [CLI, input, out, "--templates", t, "--no-video"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; p.stdout.on("data", (d) => { stdout += d; }); p.stderr.on("data", (d) => { stderr += d; });
    p.on("close", (status) => res({ status, stdout, stderr, out }));
  });
}

test("template scripts cannot reach the network: WebSocket, sendBeacon and fetch to a local server arrive 0 times", async () => {
  let hits = 0;
  const server = createServer((req, res) => { hits++; res.end("x"); });
  server.on("upgrade", (req, sock) => { hits++; sock.destroy(); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const script = `<script>try { new WebSocket("ws://127.0.0.1:${port}/ws"); } catch (e) {}
    try { navigator.sendBeacon("http://127.0.0.1:${port}/beacon", "x"); } catch (e) {}
    try { fetch("http://127.0.0.1:${port}/fetch"); } catch (e) {}</script>`;
  // once at the top of the template file, once inside a card template
  const tpl = script + BASIC.replace('<div class="card cover">', '<div class="card cover">' + script);
  const r = await runAsync(EN, tpl);
  await new Promise((res) => setTimeout(res, 300));
  server.close();
  assert.equal(hits, 0, "requests reached the local server");
  assert.ok(r.status === 0 || /RENDER_STOP NET_BLOCKED/.test(r.stderr), r.stderr);
});

test("a value that is not a string stops with BAD_JSON", () => {
  const p = clone(EN); p.cards[0].subtitle = 42; stopped(run(p), "BAD_JSON");   // optional field, so only the string check can catch it
});

test("one line that does not fit on an empty page stops with OVERFLOW", () => {
  const long = Array.from({ length: 40 }, () => "word").join(" ");   // wraps to more lines than one page holds
  const r = run({ cards: [EN.cards[0], { template: "list", items: long + " " + long + " " + long + " " + long }] });
  stopped(r, "OVERFLOW"); assert.match(r.stderr, /one line does not fit/);
});

test("video settings outside their limits stop with BAD_JSON", () => {
  for (const video of [{ hold: 100000 }, { hold: -1 }, { slide: 5 }, { hold: 1, slide: 1 }, { background: "red;}" }, { fps: 60 }]) {
    const p = clone(EN); p.video = video; stopped(run(p), "BAD_JSON");
  }
});

test("template names that are object built-ins stop with BAD_JSON", () => {
  for (const name of ["__proto__", "constructor", "toString"]) { const p = clone(EN); p.cards[1].template = name; stopped(run(p), "BAD_JSON"); }
});

test("a missing parent folder fails before a browser starts (library call settles)", async () => {
  const { render } = await import(pathToFileURL(join(ROOT, "src", "render.mjs")).href);
  await assert.rejects(render({ post: EN, templatesHtml: BASIC, outDir: join(work, "no-such-parent", "out"), chrome: process.env.CR_CHROME, playwrightDir: process.env.CR_PLAYWRIGHT_CORE_DIR, video: false }), /ENOENT/);
});

test("page JavaScript does not run (a template script that would add overlapping text has no effect)", () => {
  const add = `<script>document.querySelectorAll(".card.cover").forEach((c) => c.insertAdjacentHTML("beforeend", '<div data-text style="position:absolute;left:80px;top:580px;width:900px;height:200px;font-size:96px">OVERLAP</div>'));</script>`;
  const inCard = `<script>document.currentScript.parentElement.insertAdjacentHTML("beforeend", '<div data-text style="position:absolute;left:80px;top:580px;width:900px;height:200px;font-size:96px">OVERLAP</div>');</script>`;
  const r = run(EN, { templates: BASIC.replace('<div class="card cover">', '<div class="card cover">' + inCard) + add });
  assert.equal(r.status, 0, r.stderr);
});

test("a template cannot load local files: a file: background is not drawn (pages are identical to the plain render)", () => {
  // 1×1 red PNG on disk; if it were loaded as the cover background, page 1 would differ from the plain render.
  const png = join(work, "red.png");
  writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64"));
  const plain = run(EN, { args: ["--no-video"] });
  const withFile = run(EN, { templates: BASIC.replace("</style>", `.cover { background-image: url(${pathToFileURL(png).href}); background-size: cover; }\n</style>`), args: ["--no-video"] });
  assert.equal(plain.status, 0, plain.stderr);
  assert.ok(withFile.status === 0 || /RENDER_STOP NET_BLOCKED/.test(withFile.stderr), withFile.stderr);
  if (withFile.status === 0) assert.equal(withFile.manifest.images[0].sha256, plain.manifest.images[0].sha256);
  // control: the same picture as a data: URL (allowed) does change page 1, so the comparison above can see a drawn background
  const dataUrl = "data:image/png;base64," + readFileSync(png).toString("base64");
  const withData = run(EN, { templates: BASIC.replace("</style>", `.cover { background-image: url(${dataUrl}); background-size: cover; }\n</style>`), args: ["--no-video"] });
  assert.equal(withData.status, 0, withData.stderr);
  assert.notEqual(withData.manifest.images[0].sha256, plain.manifest.images[0].sha256);
});
