// HiDPI 适配共享库（2026-09-01 升级 monkey-patch 版：无时序依赖、幂等）
// 两路生效：①render_html.mjs spec.dpr>1 时 addInitScript 自动注入（新 HTML 零手写零引用，
//           spec 给 "hidpi": false 可显式关闭）；②老用法 HTML 主 script 前引用本文件（幂等）。
// 原理：devicePixelRatio≠1 时拦截 getContext('2d')——canvas 后备存储 ×DPR、CSS 尺寸钉死
//       逻辑值、transform 预置 DPR；DOM/文字/图片由 deviceScaleFactor 原生放大无需处理。
//       three.js/WebGL 不受影响（只拦 2d；three.js 走 setPixelRatio(devicePixelRatio) 天然正确）。
// 纪律：禁止 documentElement.style.zoom（zoom 幽灵 bug 判例）；禁止手写 SC4K 自适配拷贝
//       （5 天 5 变体连环坑，PLAYBOOK §三十三——setTransform 是覆盖语义，手写块与 patch
//       重复执行结果一致，但拷贝本身是会漂移的负债，见到就删）。
// 判例（2026-09-04 EP5 空 overlay 两小时排查）：hud.js begin() 用 ctx.scale(S,S) 是【累乘】
// 语义——与 patch 的预置 ×DPR 叠成 ×DPR²，全部绘制飞出画布=产物全透明空帧。
// 凡 HUD 系 HTML（begin 自带 S=cv.width/1280 补偿）：render_html 必须 spec "hidpi": false，
// canvas 直接给目标分辨率（HUD 库原生 4K 适配，不需要 patch）。
(function () {
  if (window.__hidpi_patched) return;
  window.__hidpi_patched = true;
  var DPR = window.devicePixelRatio || 1;
  if (Math.abs(DPR - 1) < 0.01) return;
  var orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, opts) {
    var ctx = orig.call(this, type, opts);
    if (type === '2d' && ctx && !this.__hidpi_done) {
      this.__hidpi_done = true;
      var w = this.width, h = this.height;
      this.style.width = w + 'px'; this.style.height = h + 'px';
      this.width = Math.round(w * DPR); this.height = Math.round(h * DPR);
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    return ctx;
  };
})();
