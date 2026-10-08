// 缓动曲线共享库（ruyi-studio 跨项目复用，无模块，<script src> 直接引入）。
// 2026-09-02 入库：此前 easeOut 立方体被复制粘贴到 6+ 个 viz 页（还漂变出指数
// 2.2 等野生变体）、text_fx 一份、hud.js 一份 smoothstep、still_motion 全线性——
// 四套方言收敛到本注册表（学 OpenCut 属性注册表思想；数值正本 TEMPLATES §六）。
//
// 用法：
//   <script src="/assets/viz/easing.js"></script>
//   const k = EASE.apply('easeOutCubic', (t - at) / dur);   // 自动 clamp01
//   const s = EASE.easeOutBack(k, 1.9);                      // 直调（回弹可调 overshoot）
//
// 曲线语义（选型速查）：
//   linear        匀速——HUD 滚动/进度条/匀速漂移
//   smoothstep    平滑起停——面板展开/落定（hud.js ease 同款，保等价）
//   easeOutCubic  出场默认——信息层入场/数字弹出/字幕条（全厂使用最多）
//   easeOutQuint  更重落定——大数字/盖章（比 cubic 更「砸得住」）
//   easeInOutSine 正弦起停——ken-burns 推镜首选（呼吸感，无机械匀速感）
//   easeOutBack   回弹——花字砸落/术语盖章（s=overshoot，默认 1.70158）
//   easeOutExpo   急停强调——快闪/pop 锁定
//
// 纪律：新页面/新渲染器一律引本库，不许再内联手写缓动（指数漂变=风格失控温床）；
// 加新曲线先入 TEMPLATES §六 表，两份镜像（本文件 + scripts/easing.py）同步改。

const EASE = (() => {
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  return {
    clamp01,
    linear: (x) => clamp01(x),
    smoothstep: (x) => { x = clamp01(x); return x * x * (3 - 2 * x); },
    easeOutCubic: (x) => 1 - Math.pow(1 - clamp01(x), 3),
    easeOutQuint: (x) => 1 - Math.pow(1 - clamp01(x), 5),
    easeInOutSine: (x) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(x)),
    easeOutBack: (x, s = 1.70158) => {
      x = clamp01(x);
      return 1 + (s + 1) * Math.pow(x - 1, 3) + s * Math.pow(x - 1, 2);
    },
    easeOutExpo: (x) => { x = clamp01(x); return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x); },
    apply(name, x, opts) {
      const fn = this[name];
      if (typeof fn !== 'function') {
        throw new Error(`EASE: 未知缓动 '${name}'（正本表见 TEMPLATES §六）`);
      }
      return opts !== undefined ? fn(x, opts) : fn(x);
    },
  };
})();
