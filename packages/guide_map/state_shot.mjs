#!/usr/bin/env node
// guide_map 状态截图驱动：一个浏览器会话跑完整 job（render_core chromium）。
// 用法: node state_shot.mjs <job.json>
// job: { baseUrl, items: [{ page, out, zoomJs?, js? }] }
//   page=相对 baseUrl 的页面路径；out=截图绝对路径；zoomJs/js=页面内执行的 JS 表达式字符串
// 判例继承：大 inset 异步加载未竟→黑框——截图前必须等全部 img.complete（兜底 3s）。
import { launchChromium } from '../render_core/node/chromium.mjs';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const job = JSON.parse(readFileSync(process.argv[2], 'utf-8'));
const browser = await launchChromium();
const vp = job.viewport ?? [2560, 1440];
const page = await browser.newPage({ viewport: { width: vp[0], height: vp[1] } });
page.on('pageerror', (e) => console.error('[pageerror]', String(e).slice(0, 500)));

const WAIT_IMGS = `() => new Promise(r => { const imgs=[...document.querySelectorAll('img')];
  if (imgs.every(i=>i.complete)) return r(1); let n=0;
  const t=setInterval(()=>{ n+=200; if(imgs.every(i=>i.complete)||n>=3000){clearInterval(t);r(1);} },200); })`;

for (const it of job.items) {
  await page.goto(job.baseUrl + '/' + it.page, { waitUntil: 'load' });
  if (it.zoomJs) await page.evaluate(it.zoomJs);
  if (it.js) await page.evaluate('() => { ' + it.js + ' }');
  await page.evaluate(WAIT_IMGS);
  mkdirSync(dirname(it.out), { recursive: true });
  await page.screenshot({ path: it.out, fullPage: true });
  console.log(it.out.split('/').pop(), 'ok');
}
await browser.close();
