#!/usr/bin/env node
// render_core/node/render_html.mjs — 通用 HTML 动画渲染器
// 任意暴露 window.__render(t)（秒，纯函数：同 t 同帧）与 window.__DONE__ 的 HTML
// → 逐帧截图 → ffmpeg 出 mp4（或 qtrle 透明 mov）。
//
// 用法: node packages/render_core/node/render_html.mjs <spec.json>
//
// spec.json:
// {
//   "out": ".work/anim.mp4",          // 相对 spec 文件目录
//   "html": "viz/anim.html",          // 相对 spec 文件目录；页面必须暴露 __render/__DONE__
//   "root": ".",                      // 静态服务器根（相对 spec 目录，默认 html 所在目录）；
//                                     // 仓内字体/脚本经 /__ruyi_assets__/ 前缀访问
//   "canvas": [1920, 1080], "fps": 30, "durationMs": 36000, "crf": 18,
//   "dpr": 1,                          // 4K 档：viewport 逻辑 1920×1080，dpr=2 截 3840×2160
//   "hidpi": true,                     // dpr>1 时自动注入 2d canvas 高清 patch（false 关闭）
//   "keepFrames": false,
//   "sample": 5,                       // 样张模式：只渲前 N 秒（durationMs 保持全片值）
//   "transparent": false,              // true → omitBackground + qtrle(argb) 透明 mov；
//                                     // body/html 背景必须 transparent（不透明底色直接拒绝）
//   "motionBlur": {"samples": 5, "shutter": 0.5},
//                                     // 子帧运动模糊：快门窗均匀采样子帧算术平均，
//                                     // 消除快速元素频闪；要求页面含 canvas；确定性保持
//   "qaTimes": [1.5, 3.0]              // QA 模式：只抽指定秒出 PNG 不出整片
// }
import { launchChromium } from './chromium.mjs';
import { startFrameServer } from './frame_server.mjs';
import { readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '../..'); // ruyi-map 仓根
const ASSETS = join(PKG, 'assets');

const specPath = resolve(process.argv[2]);
const specDir = dirname(specPath);
const spec = JSON.parse(readFileSync(specPath, 'utf-8'));
const [W, H] = spec.canvas ?? [1920, 1080];
const DPR = spec.dpr ?? 1;
const FPS = spec.fps ?? 30;
const DURATION = Math.min(spec.durationMs / 1000, spec.sample ?? Infinity);
if (spec.sample) console.error(`sample 模式：只渲前 ${DURATION}s`);
const FRAMES = Math.round(DURATION * FPS);
const OUT = isAbsolute(spec.out) ? spec.out : join(specDir, spec.out);
const htmlAbs = join(specDir, spec.html);
if (!existsSync(htmlAbs)) { console.error('html 不存在: ' + spec.html); process.exit(1); }
const outDir = dirname(OUT);
const framesDir = join(outDir, `_frames_${spec.html.split('/').pop().replace('.html', '')}`);
mkdirSync(framesDir, { recursive: true });

const staticRoot = resolve(specDir, spec.root ?? dirname(spec.html));
const srv = await startFrameServer(staticRoot, {
  startPort: Number(process.env.RENDER_PORT ?? 8792),
  routes: {}, // /__ruyi_assets__/ 走 onMissing
  onMissing: (url) => url.startsWith('/__ruyi_assets__/')
    ? join(ASSETS, url.slice('/__ruyi_assets__/'.length)) : null,
});
const htmlUrlPath = '/' + spec.html.split('/').pop();

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
const shotOpts = spec.transparent ? { omitBackground: true } : {};
if (DPR > 1 && spec.hidpi !== false) {
  await page.addInitScript(readFileSync(join(ASSETS, 'viz/hidpi.js'), 'utf-8'));
}
await page.goto(srv.url + htmlUrlPath);
await page.waitForFunction('window.__DONE__ === true', { timeout: 120000 });

// 防呆：transparent 模式下 body/html 带不透明底色 → omitBackground 救不了，直接拒绝
if (spec.transparent) {
  const bg = await page.evaluate(() => [
    getComputedStyle(document.body).backgroundColor,
    getComputedStyle(document.documentElement).backgroundColor,
  ]);
  const opaque = bg.filter((c) => c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c));
  if (opaque.length) {
    console.error(`FATAL: transparent:true 但页面带不透明底色 ${opaque.join(' / ')}——body/html 背景必须 transparent`);
    await browser.close(); srv.close(); process.exit(1);
  }
}

console.error(`rendering ${FRAMES} frames (${DURATION}s @${FPS}fps) → ${framesDir}`);
const t0 = Date.now();

// —— 子帧运动模糊（opt-in）——
const MB = spec.motionBlur ?? null;
if (MB) {
  const ok = await page.evaluate(() => {
    const main = document.querySelector('canvas');
    if (!main) return false;
    const acc = document.createElement('canvas');
    acc.width = main.width; acc.height = main.height;
    const r = main.getBoundingClientRect();
    acc.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;` +
      `width:${r.width}px;height:${r.height}px;z-index:9999;pointer-events:none`;
    document.body.appendChild(acc);
    window.__mbAcc = acc; window.__mbMain = main;
    return true;
  });
  if (!ok) {
    console.error('FATAL: motionBlur 需要页面含 canvas 元素');
    await browser.close(); srv.close(); process.exit(1);
  }
  console.error(`  motionBlur: samples=${MB.samples ?? 5} shutter=${MB.shutter ?? 0.5}`);
}
const renderBlurred = (t) => page.evaluate(({ t, n, dt }) => {
  const actx = window.__mbAcc.getContext('2d');
  actx.globalCompositeOperation = 'source-over';
  actx.globalAlpha = 1;
  actx.clearRect(0, 0, window.__mbAcc.width, window.__mbAcc.height);
  actx.globalCompositeOperation = 'lighter';
  actx.globalAlpha = 1 / n;
  for (let k = 0; k < n; k++) {
    window.__render(n === 1 ? t : t + (k / (n - 1) - 0.5) * dt);
    actx.drawImage(window.__mbMain, 0, 0);
  }
}, { t, n: MB.samples ?? 5, dt: (MB.shutter ?? 0.5) / FPS });

if (spec.qaTimes) {
  for (const t of spec.qaTimes) {
    if (MB) await renderBlurred(t);
    else await page.evaluate((tt) => window.__render(tt), t);
    const p = join(outDir, `qa_${spec.html.split('/').pop().replace('.html', '')}_${t}s.png`);
    await page.screenshot({ path: p, ...shotOpts });
    console.log(p);
  }
  await browser.close(); srv.close();
  process.exit(0);
}
for (let i = 0; i < FRAMES; i++) {
  if (MB) await renderBlurred(i / FPS);
  else await page.evaluate((t) => window.__render(t), i / FPS);
  await page.screenshot({ path: join(framesDir, `f${String(i).padStart(5, '0')}.png`), ...shotOpts });
  if (i % 150 === 0) {
    const per = (Date.now() - t0) / (i + 1);
    console.error(`  ${i}/${FRAMES}  ${per.toFixed(0)}ms/帧  预计剩 ${((FRAMES - i) * per / 1000).toFixed(0)}s`);
  }
}
await browser.close();
srv.close();

if (spec.transparent) {
  execFileSync('ffmpeg', ['-y', '-framerate', String(FPS), '-i', join(framesDir, 'f%05d.png'),
    '-c:v', 'qtrle', '-pix_fmt', 'argb', '-r', String(FPS), OUT], { stdio: 'inherit' });
} else {
  execFileSync('ffmpeg', ['-y', '-framerate', String(FPS), '-i', join(framesDir, 'f%05d.png'),
    '-c:v', 'libx264', '-crf', String(spec.crf ?? 18), '-preset', 'medium',
    '-pix_fmt', 'yuv420p', '-r', String(FPS), OUT], { stdio: 'inherit' });
}
if (!spec.keepFrames) rmSync(framesDir, { recursive: true, force: true });
console.log(OUT);
