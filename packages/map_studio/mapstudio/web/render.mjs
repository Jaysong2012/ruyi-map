#!/usr/bin/env node
// Map Studio v2 逐帧确定性渲染：renderer.html + __setT(t) → PNG 序列 / 单帧预览。
//
// 用法:
//   node render.mjs --url http://127.0.0.1:PORT --out <dir> --duration 24 --fps 30 \
//       [--width 1280] [--height 720] [--scale 1] [--at 12.5] [--report report.json] \
//       [--from 0] [--to 24] [--resume] [--maxRetries 3]
//
// --at 给单帧预览（慢速热瓦片后截图）；否则渲染 duration*fps 帧序列。
// report.json 记录帧数、__ERR、每秒 overlay 安全区快照、崩溃重试，供 qa-render 判定。
//
// 崩溃自愈（2026-09-12，EP3 d2 t=15s 瓦片解码内存尖峰判例）：
// 长跟拍累积瓦片缓存会在固定时刻撑爆 tab（60fps 900/1020 与 30fps 450/510 同比例死亡）。
// __setT 确定性（同 t 必同帧）保证可以安全续渲：任一帧截图抛错→关浏览器→冷启动→
// 热瓦片→重试同帧（冷启动后累积缓存清零，工作集最小）。--resume 跳过已存在帧，
// 配合 --from/--to 也可手工分段。
import { launchChromium } from '../../../render_core/node/chromium.mjs';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const URL_ = opt('url', null), OUT = opt('out', null);
const W = +opt('width', 1280), H = +opt('height', 720), SCALE = +opt('scale', 1);
const DUR = +opt('duration', 0), FPS = +opt('fps', 30), AT = opt('at', null);
const FROM = +opt('from', 0), TO = +opt('to', DUR);
const RESUME = args.includes('--resume');
const MAXR = +opt('maxRetries', 3);
const REPORT = opt('report', join(OUT ?? '.', 'render_report.json'));
const Q = opt('q', '');   // 透传给 renderer.html 的 query string（氛围扫参：gsat/gcon/gmax/vig/warm/hsx）
if (!URL_ || !OUT) { console.error('need --url and --out'); process.exit(2) }
mkdirSync(OUT, { recursive: true });

const report = { url: URL_, width: W * SCALE, height: H * SCALE, fps: FPS, duration: DUR, frames: 0, errors: '', idleTimeouts: [], overlays: [], crashes: [], relaunches: 0 };

let browser = null, page = null;
function attach() {
  page.on('pageerror', (e) => { report.errors += ';pageerror:' + e.message; });
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) report.errors += ';console:' + m.text().slice(0, 200); });
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('favicon')) report.errors += `;http${r.status()}:${r.url().slice(0, 160)}`; });
}
async function launch() {
  browser = await launchChromium({ headless: true });
  page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE });
  attach();
  await page.goto(URL_ + '/renderer.html' + (Q ? '?' + Q : ''));
  await page.waitForFunction('window.__LOADED===true', undefined, { timeout: 60000 });
}

async function setT(t, slow) {
  await page.evaluate((tt) => window.__setT(tt), t);
  // 慢速路径（热瓦片）：固定 1800ms 后必须重等 idle——第二次 __setT 的 setData 走 worker 是异步的，
  // 裸等 300ms 截图会在 symbol 层未就绪时丢 icon（t=8 720p 车 icon 消失判例：数据层完好、屏幕内、idle 后必现）
  if (slow) { await page.waitForTimeout(1800); await page.evaluate((tt) => window.__setT(tt), t); }
  try { await page.waitForFunction('window.__IDLE===true', undefined, { timeout: slow ? 8000 : 2500 }); }
  catch { report.idleTimeouts.push(+t.toFixed(3)); }
  await page.waitForTimeout(40);
}
async function overlays(t) {
  const items = await page.evaluate(() => window.__qaOverlays());
  report.overlays.push({ t: +t.toFixed(2), items });
}
async function warm() {
  // 热瓦片缓存：全局五点裁剪到 [FROM,TO] 窗口（段外瓦片不预载=工作集最小化）
  const pts = [0, DUR * .25, DUR * .5, DUR * .75, DUR].filter((t) => t >= FROM - 1 && t <= TO + 1);
  if (!pts.includes(FROM)) pts.unshift(FROM);
  for (const t of pts) await setT(t, true);
}

try {
await launch();
if (AT !== null) {
  await setT(+AT, true);
  const p = join(OUT, `preview-${AT}.png`);
  await page.screenshot({ path: p });
  report.frames = 1;
  await overlays(+AT);
  console.log(p);
} else {
  await warm();
  const i0 = Math.max(0, Math.round(FROM * FPS)), i1 = Math.min(Math.round(DUR * FPS), Math.round(TO * FPS));
  for (let i = i0; i < i1; i++) {
    const t = i / FPS;
    const png = join(OUT, `f${String(i).padStart(4, '0')}.png`);
    if (RESUME && existsSync(png)) { report.frames++; continue; }
    let ok = false;
    for (let attempt = 0; attempt <= MAXR && !ok; attempt++) {
      try {
        if (attempt > 0) {   // 崩溃后冷启动重试：慢速路径热该帧瓦片
          await browser.close().catch(() => {});
          report.relaunches++;
          await launch();
          await warm();
        }
        await setT(t, attempt > 0);
        await page.screenshot({ path: png });
        ok = true;
      } catch (e) {
        report.crashes.push({ frame: i, t: +t.toFixed(3), attempt, err: String(e).slice(0, 160) });
        console.log(`[crash] frame ${i} @${t.toFixed(2)}s attempt ${attempt}: ${String(e).slice(0, 80)}`);
      }
    }
    if (!ok) throw new Error(`frame ${i} @${t}s 崩溃 ${MAXR + 1} 次仍失败，终止（已渲帧保留，可用 --resume 续渲）`);
    report.frames++;
    if (i % FPS === 0) {
      try { await overlays(t); } catch { /* overlay 快照失败不致命 */ }
      if (i % (FPS * 5) === 0) console.log(`frame ${i}/${i1}`);
    }
  }
}
} finally {
report.errors += (page ? await page.evaluate('window.__ERR||""').catch(() => '') : '');
writeFileSync(REPORT, JSON.stringify(report, null, 2));
if (browser) await browser.close().catch(() => {});
}
