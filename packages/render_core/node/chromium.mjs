// render_core/node/chromium.mjs — chromium 启动统一入口
// 解析策略：① PLAYWRIGHT_CHROMIUM_PATH 环境变量显式覆盖；
//          ② playwright-core 默认注册表（npx playwright-core install chromium 安装）；
//          ③ 缓存目录里最高版本号 chromium-*（playwright-core browsers.json pin 版本优先）。
// 跨平台：macOS (arm64/x64) / Linux / Windows 缓存布局均按 playwright 官方 ms-playwright 结构解析。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = join(dirname(fileURLToPath(import.meta.url)), '../../..');

export async function loadPlaywright() {
  // 正式依赖：repo 根 package.json 的 playwright-core
  try {
    return await import('playwright-core');
  } catch {
    throw new Error('playwright-core 未安装：请在 ruyi-map 根目录执行 npm install && npm run setup');
  }
}

function cacheBase() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  const home = homedir();
  if (platform() === 'darwin') return join(home, 'Library/Caches/ms-playwright');
  if (platform() === 'win32') return join(process.env.LOCALAPPDATA || join(home, 'AppData/Local'), 'ms-playwright');
  return join(home, '.cache/ms-playwright');
}

function exeRel() {
  if (platform() === 'darwin') return 'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
  if (platform() === 'win32') return 'chrome-win/chrome.exe';
  return 'chrome-linux/chrome';
}

function pinnedRevision(coreIndexPath) {
  try {
    const bj = JSON.parse(readFileSync(join(dirname(coreIndexPath), 'browsers.json'), 'utf8'));
    return bj.browsers.find((b) => b.name === 'chromium')?.revision || null;
  } catch { return null; }
}

export function chromiumPath() {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH && existsSync(process.env.PLAYWRIGHT_CHROMIUM_PATH)) {
    return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }
  const base = cacheBase();
  let dirs = [];
  try { dirs = readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)); } catch { return undefined; }
  if (!dirs.length) return undefined;
  let pinned = null;
  try {
    const coreIdx = join(CORE, 'node_modules/playwright-core/index.mjs');
    if (existsSync(coreIdx)) pinned = pinnedRevision(coreIdx);
  } catch { /* 无 pin 也能活 */ }
  // macOS arm64 旧布局是 chrome-mac-arm64/，新布局 chrome-mac/；两种都探测
  const exeRels = platform() === 'darwin'
    ? [exeRel(), 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing']
    : [exeRel()];
  dirs.sort((a, b) => {
    const ra = a.split('-')[1], rb = b.split('-')[1];
    if (ra === pinned) return -1;
    if (rb === pinned) return 1;
    return +rb - +ra;
  });
  for (const d of dirs) {
    for (const rel of exeRels) {
      const p = join(base, d, rel);
      if (existsSync(p)) return p;
    }
  }
  return undefined; // 交给 playwright 默认解析
}

export async function launchChromium(options = {}) {
  const { chromium } = await loadPlaywright();
  const executablePath = chromiumPath();
  return chromium.launch({
    args: ['--use-angle=metal', '--force-device-scale-factor=1', ...(options.args || [])],
    ...(executablePath ? { executablePath } : {}),
    ...options,
  });
}
