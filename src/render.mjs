// html-carousel-renderer: JSON + HTML templates → 4:5 carousel JPEGs (1080×1350), an optional 9:16 video, and manifest.json.
// Every page is checked in the browser before it is captured. Any problem stops the render and no output folder is created.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const VERSION = "0.1.0";
export const PAGE = { width: 1080, height: 1350 };
export const STORY = { width: 1080, height: 1920 };
/** Seconds per page and per transition accepted from a post (keeps a post from asking for millions of frames). */
export const VIDEO_LIMITS = { hold: [0.5, 10], slide: [0, 1] };
/** Temporary folders of renders in progress, so a CLI signal handler can remove them (see cleanupTemp). */
const activeTmp = new Set();
const removeTmp = (dir) => { if (existsSync(dir)) { for (const f of readdirSync(dir)) unlinkSync(join(dir, f)); rmdirSync(dir); } activeTmp.delete(dir); };
/** Remove temporary folders left by renders that were interrupted (call from a SIGINT/SIGTERM handler). */
export function cleanupTemp() { for (const d of [...activeTmp]) { try { removeTmp(d); } catch { /* best effort */ } } }

export class RenderStop extends Error {
  constructor(code, detail) { super(`${code}: ${detail}`); this.code = code; this.detail = detail; }
}

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/** Load playwright-core from the normal module path, or from CR_PLAYWRIGHT_CORE_DIR (a folder that contains playwright-core). */
async function loadPlaywright(dir) {
  if (dir) return createRequire(join(resolve(dir), "noop.js"))("playwright-core");
  return import("playwright-core");
}

/** Pick an ffmpeg output: mp4 (libx264) if available, else webm (libvpx-vp9), else null. */
export function detectFfmpeg(bin) {
  if (!bin) return null;
  const r = spawnSync(bin, ["-hide_banner", "-encoders"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  if (/\blibx264\b/.test(r.stdout)) return { bin, ext: "mp4", args: ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20", "-movflags", "+faststart"] };
  if (/\blibvpx-vp9\b/.test(r.stdout)) return { bin, ext: "webm", args: ["-c:v", "libvpx-vp9", "-b:v", "2M", "-deadline", "realtime", "-cpu-used", "8"] };
  return null;
}

/** Validate the post against the template's declared slots. Templates declare slots with data-slot, required ones with data-required. */
export function validate(post, templates) {
  if (!post || typeof post !== "object" || !Array.isArray(post.cards) || post.cards.length === 0) throw new RenderStop("BAD_JSON", "cards must be a non-empty array");
  if (post.footer !== undefined && typeof post.footer !== "string") throw new RenderStop("BAD_JSON", "footer must be a string");
  if (post.video !== undefined) {
    const v = post.video;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new RenderStop("BAD_JSON", "video must be an object");
    for (const k of Object.keys(v)) if (!["hold", "slide", "background"].includes(k)) throw new RenderStop("BAD_JSON", `video: unknown field ${k}`);
    const num = (k, lo, hi) => { if (v[k] !== undefined && !(typeof v[k] === "number" && Number.isFinite(v[k]) && v[k] >= lo && v[k] <= hi)) throw new RenderStop("BAD_JSON", `video.${k} must be a number from ${lo} to ${hi}`); };
    num("hold", VIDEO_LIMITS.hold[0], VIDEO_LIMITS.hold[1]); num("slide", VIDEO_LIMITS.slide[0], VIDEO_LIMITS.slide[1]);
    if (v.background !== undefined && !(typeof v.background === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v.background))) throw new RenderStop("BAD_JSON", "video.background must be a hex colour like #101114");
    if ((v.slide ?? 0.3) >= (v.hold ?? 2.5)) throw new RenderStop("BAD_JSON", "video.slide must be shorter than video.hold");
  }
  post.cards.forEach((c, i) => {
    const t = typeof c?.template === "string" && Object.hasOwn(templates, c.template) ? templates[c.template] : null;
    if (!t) throw new RenderStop("BAD_JSON", `cards[${i}]: unknown template ${JSON.stringify(c?.template)}`);
    for (const k of Object.keys(c)) {
      if (k === "template") continue;
      if (!t.slots.includes(k)) throw new RenderStop("BAD_JSON", `cards[${i}]: unknown field ${k} for template ${c.template}`);
      if (typeof c[k] !== "string") throw new RenderStop("BAD_JSON", `cards[${i}].${k} must be a string`);
    }
    for (const k of t.required) if (typeof c[k] !== "string" || !c[k].trim()) throw new RenderStop("BAD_JSON", `cards[${i}]: missing ${k}`);
  });
}

// Runs inside the page: build a card, check it, split long slots into pages.
const PAGE_JS = String.raw`
window.__cr = {
  make(name, slots) {
    const t = document.getElementById("tpl-" + name);
    const node = t.content.firstElementChild.cloneNode(true);
    for (const el of node.querySelectorAll("[data-slot]")) el.textContent = slots[el.dataset.slot] ?? "";
    document.getElementById("stage").replaceChildren(node);
    return node;
  },
  /** Problems on the current card: overflow (y/x), a word broken across lines, two text boxes overlapping. */
  check(node) {
    const bad = [];
    const slots = [...node.querySelectorAll("[data-slot]")].filter((el) => el.textContent);
    for (const el of slots) {
      const name = el.dataset.slot;
      if (el.scrollHeight > el.clientHeight + 1) bad.push({ code: "OVERFLOW", slot: name, why: "text taller than its box" });
      if (el.scrollWidth > el.clientWidth + 1) bad.push({ code: "OVERFLOW", slot: name, why: "text wider than its box" });
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const re = /\S+/g; let m;
        while ((m = re.exec(n.data))) {
          const r = document.createRange(); r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length);
          const tops = new Set([...r.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top)));
          if (tops.size > 1) bad.push({ code: "KEEP_ALL", slot: name, why: "word broken across lines: " + m[0].slice(0, 40) });
        }
      }
    }
    const texts = [...node.querySelectorAll("[data-slot], [data-text]")].filter((el) => el.textContent.trim() && el.getAttribute("aria-hidden") !== "true");
    const rects = (el) => { const r = document.createRange(); r.selectNodeContents(el); return [...r.getClientRects()].filter((x) => x.width > 0 && x.height > 0); };
    for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i], b = texts[j];
      if (a.contains(b) || b.contains(a)) continue;
      if (rects(a).some((x) => rects(b).some((y) => x.left < y.right - 1 && y.left < x.right - 1 && x.top < y.bottom - 1 && y.top < x.bottom - 1)))
        bad.push({ code: "OVERLAP", slot: (a.dataset.slot || "text") + "+" + (b.dataset.slot || "text"), why: "text boxes overlap" });
    }
    return bad;
  },
  /** Rendered text lines in a box (from the text's own line boxes, not the box height). */
  lines(el) {
    if (!el.textContent) return 0;
    const r = document.createRange(); r.selectNodeContents(el);
    const rs = [...r.getClientRects()].filter((x) => x.height > 0);
    if (!rs.length) return 0;
    const lh = parseFloat(getComputedStyle(el).lineHeight);
    return Math.round((Math.max(...rs.map((x) => x.bottom)) - Math.min(...rs.map((x) => x.top))) / lh);
  },
  /** Fill the template's data-split slot line by line; move lines forward so the last page keeps at least minTail lines. */
  split(name, slots, minTail) {
    const el = this.make(name, slots).querySelector("[data-split]");
    if (!el) return { pages: [slots] };
    const key = el.dataset.slot, units = String(slots[key] ?? "").split("\n");
    const fits = (txt) => { const s = this.make(name, { ...slots, [key]: txt }).querySelector("[data-split]"); return s.scrollHeight <= s.clientHeight + 1 && s.scrollWidth <= s.clientWidth + 1; };
    const count = (txt) => this.lines(this.make(name, { ...slots, [key]: txt }).querySelector("[data-split]"));
    const pages = []; let cur = [];
    for (const u of units) {
      if (!cur.length && !u.trim()) continue;
      if (fits([...cur, u].join("\n"))) { cur.push(u); continue; }
      if (!cur.length) return { error: { slot: key, line: u } };
      pages.push(cur); cur = u.trim() ? [u] : [];
    }
    if (cur.length) pages.push(cur);
    while (pages.length > 1) {
      const last = pages.at(-1), prev = pages.at(-2);
      if (count(last.join("\n")) >= minTail) break;
      const nextPrev = prev.slice(0, -1), nextLast = [prev.at(-1), ...last];
      while (nextPrev.length && !nextPrev.at(-1).trim()) nextPrev.pop();
      if (!nextPrev.length || count(nextPrev.join("\n")) < minTail || !fits(nextLast.join("\n"))) break;
      pages[pages.length - 2] = nextPrev; pages[pages.length - 1] = nextLast.filter((x, i) => i > 0 || x.trim());
    }
    return { pages: pages.map((p) => ({ ...slots, [key]: p.join("\n") })) };
  },
};`;

/** Read <template id="tpl-NAME"> blocks: slot names, required slots. */
async function readTemplates(page) {
  return page.evaluate(() => Object.fromEntries([...document.querySelectorAll("template[id^='tpl-']")].map((t) => {
    const els = [...t.content.querySelectorAll("[data-slot]")];
    return [t.id.slice(4), { slots: els.map((e) => e.dataset.slot).filter((s) => s !== "page" && s !== "footer"), required: els.filter((e) => e.hasAttribute("data-required")).map((e) => e.dataset.slot) }];
  })));
}

/**
 * Render a post. Returns the manifest. Throws RenderStop on any problem (nothing is written to outDir then).
 * @param {object} o { post, templatesHtml, outDir, chrome?, playwrightDir?, ffmpeg?, minPages=2, maxPages=20, minTailLines=4, video=true }
 */
export async function render(o) {
  const { post, templatesHtml, outDir } = o;
  const minPages = o.minPages ?? 2, maxPages = o.maxPages ?? 20, minTail = o.minTailLines ?? 4;
  if (existsSync(outDir)) throw new RenderStop("OUT_EXISTS", "output folder already exists");
  const { chromium } = await loadPlaywright(o.playwrightDir);
  const t0 = Date.now();
  // The temporary folder is made before the browser starts, so a missing parent folder fails without leaving a browser behind.
  const tmp = mkdtempSync(join(dirname(resolve(outDir)), ".tmp-"));
  activeTmp.add(tmp);
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true, ...(o.chrome ? { executablePath: o.chrome } : {}) });
    // Templates are HTML/CSS only: page JavaScript is disabled (the renderer's own code runs through page.evaluate),
    // the context is offline, WebSockets are refused, and every request other than data: is aborted. Any blocked request stops the render.
    const ctx = await browser.newContext({ viewport: STORY, deviceScaleFactor: 1, serviceWorkers: "block", javaScriptEnabled: false, offline: true });
    const blocked = [];
    await ctx.route("**/*", (route) => { const u = route.request().url(); if (u.startsWith("data:")) return route.continue(); blocked.push(u); return route.abort("blockedbyclient"); });
    await ctx.routeWebSocket(/.*/, (ws) => { blocked.push(ws.url()); ws.close(); });
    const netCheck = (where) => { if (blocked.length) throw new RenderStop("NET_BLOCKED", `${where}: ${blocked.length} request(s) blocked, first ${blocked[0].slice(0, 80)}`); };

    const page = await ctx.newPage();
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${templatesHtml}<div id="stage"></div></body></html>`);
    await page.evaluate(PAGE_JS);
    const templates = await readTemplates(page);
    validate(post, templates);

    const sheets = [];
    for (const [i, c] of post.cards.entries()) {
      const slots = { ...c, footer: post.footer ?? "" }; delete slots.template;
      const r = await page.evaluate(([n, s, m]) => window.__cr.split(n, s, m), [c.template, slots, minTail]);
      if (r.error) throw new RenderStop("OVERFLOW", `cards[${i}].${r.error.slot}: one line does not fit on a page: ${r.error.line.slice(0, 40)}`);
      for (const s of r.pages) sheets.push({ template: c.template, card: i, slots: s });
    }
    if (sheets.length < minPages || sheets.length > maxPages) throw new RenderStop("PAGE_COUNT", `${sheets.length} pages (allowed ${minPages}..${maxPages})`);

    const pages = [];
    for (let i = 0; i < sheets.length; i++) {
      const s = { ...sheets[i].slots, page: `${i + 1}/${sheets.length}` };
      const { bad, lines } = await page.evaluate(([n, v]) => { const node = window.__cr.make(n, v); const sp = node.querySelector("[data-split]"); return { bad: window.__cr.check(node), lines: sp ? window.__cr.lines(sp) : null }; }, [sheets[i].template, s]);
      if (bad.length) throw new RenderStop(bad[0].code, `page ${i + 1} (${sheets[i].template}).${bad[0].slot}: ${bad[0].why}`);
      const buf = await page.locator("#stage > *").first().screenshot({ type: "jpeg", quality: 92 });
      const file = `page-${String(i + 1).padStart(2, "0")}.jpg`;
      writeFileSync(join(tmp, file), buf);
      pages.push({ file, template: sheets[i].template, card: sheets[i].card, width: PAGE.width, height: PAGE.height, ...(lines !== null ? { split_lines: lines } : {}), sha256: sha256(buf) });
    }
    netCheck("pages");

    const ff = o.video === false ? null : detectFfmpeg(o.ffmpeg ?? "ffmpeg");
    const video = ff ? await renderVideo(ctx, tmp, pages, post.video ?? {}, ff) : null;
    netCheck("video");

    const manifest = { tool: "html-carousel-renderer", version: VERSION, pages: pages.length, images: pages, video,
      checks: { overflow: 0, keep_all: 0, overlap: 0, network_blocked: 0, page_count: `${minPages}..${maxPages}`, min_tail_lines: minTail }, ms: Date.now() - t0 };
    writeFileSync(join(tmp, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
    renameSync(tmp, outDir);
    activeTmp.delete(tmp);
    return manifest;
  } finally {
    if (browser) await browser.close();
    removeTmp(tmp);
  }
}

/** 9:16 video: each 4:5 page centered on a dark background with a progress bar, held `hold` seconds, eased slide between pages. */
async function renderVideo(ctx, tmp, pages, opt, ff) {
  const fps = 30, hold = opt.hold ?? 2.5, slide = opt.slide ?? 0.3, bg = opt.background ?? "#101114";   // checked in validate()
  const v = await ctx.newPage();
  const imgs = pages.map((p) => "data:image/jpeg;base64," + readFileSync(join(tmp, p.file)).toString("base64"));
  await v.setContent(`<!doctype html><html><body style="margin:0;width:1080px;height:1920px;overflow:hidden;background:${bg}">
    <div id="prog" style="position:absolute;left:60px;right:60px;top:200px;height:8px;display:flex;gap:10px"></div>
    <div id="track" style="position:absolute;left:0;top:285px;width:1080px;height:1350px;overflow:hidden"></div></body></html>`);
  await v.evaluate(([srcs]) => {
    const track = document.getElementById("track"), prog = document.getElementById("prog");
    srcs.forEach((s, i) => {
      const im = new Image(); im.src = s; im.style.cssText = `position:absolute;top:0;left:${i * 1080}px;width:1080px;height:1350px`; track.append(im);
      const b = document.createElement("i"); b.style.cssText = "flex:1;border-radius:4px;background:rgba(255,255,255,.3)"; prog.append(b);
    });
    window.__at = (x, on) => { for (const im of track.children) im.style.transform = `translateX(${-x}px)`; [...prog.children].forEach((b, i) => { b.style.background = i <= on ? "#fff" : "rgba(255,255,255,.3)"; }); };
  }, [imgs]);
  await v.waitForFunction(() => [...document.images].every((i) => i.complete));
  const file = `story.${ff.ext}`;
  const proc = spawn(ff.bin, ["-y", "-loglevel", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-r", String(fps), "-i", "pipe:0", ...ff.args, join(tmp, file)], { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((res) => proc.on("close", res));
  const shot = async (x, on) => { await v.evaluate(([a, b]) => window.__at(a, b), [x, on]); return v.screenshot({ type: "jpeg", quality: 88 }); };
  const steps = Math.round(slide * fps);
  let frames = 0;
  for (let i = 0; i < pages.length; i++) {
    const still = await shot(i * 1080, i);
    const n = Math.round((hold - (i < pages.length - 1 ? slide : 0)) * fps);
    for (let k = 0; k < n; k++) { proc.stdin.write(still); frames++; }
    if (i < pages.length - 1) for (let s = 1; s <= steps; s++) { const e = 1 - Math.pow(1 - s / steps, 3); proc.stdin.write(await shot((i + e) * 1080, i)); frames++; }
  }
  proc.stdin.end();
  const code = await done;
  await v.close();
  if (code !== 0) throw new RenderStop("VIDEO", `ffmpeg exited with ${code}`);
  return { file, width: STORY.width, height: STORY.height, fps, frames, seconds: +(frames / fps).toFixed(2), format: ff.ext, audio: null, sha256: sha256(readFileSync(join(tmp, file))) };
}
