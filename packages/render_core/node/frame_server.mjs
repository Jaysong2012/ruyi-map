// render_core/node/frame_server.mjs — 静态文件服务器：端口扫描 + 哨兵防串台
// 历史判例：渲染脚本曾固定端口（8791/8792/8377），并行渲染即串台。
// 正解：起始端口起扫描空闲端口 + 落地 .sentinel 文件校验服务身份。
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.mp4': 'video/mp4', '.f32': 'application/octet-stream', '.bin': 'application/octet-stream',
  '.geojson': 'application/geo+json',
};

/**
 * 起一个带哨兵的静态服务器。
 * @param {string} root 静态根目录
 * @param {object} opts { startPort=8377, routes={path:absFile} 精确路由覆盖, onMissing=(url)=>absPath|null }
 * @returns {Promise<{port:number, url:string, close:()=>void, sentinel:string}>}
 */
export async function startFrameServer(root, opts = {}) {
  const { startPort = 8377, routes = {}, onMissing = null } = opts;
  const sentinel = randomBytes(6).toString('hex');
  const rootAbs = resolve(root);
  const server = createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    if (url === '/__sentinel__') { res.writeHead(200); res.end(sentinel); return; }
    let file = routes[url] || null;
    if (!file) {
      const rel = url.replace(/^\/+/, '') || 'index.html';
      const cand = join(rootAbs, rel);
      if (cand.startsWith(rootAbs) && existsSync(cand)) file = cand;
    }
    if (!file && onMissing) file = onMissing(url);
    if (!file || !existsSync(file)) { res.writeHead(404); res.end('not found: ' + url); return; }
    try {
      const body = readFileSync(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(body);
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  for (let port = startPort; port < startPort + 50; port++) {
    try {
      await new Promise((ok, bad) => {
        server.once('error', bad);
        server.listen(port, '127.0.0.1', ok);
      });
      return { port, url: `http://127.0.0.1:${port}`, sentinel, close: () => server.close() };
    } catch { /* 端口被占，扫下一个 */ }
  }
  throw new Error(`startPort=${startPort} 起 50 个端口全被占用`);
}
