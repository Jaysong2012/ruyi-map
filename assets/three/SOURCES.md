# three-0.185.1.js

与 interactive-app 受控库同源同字节（`runner_contract.py` 的 `three@0.185.1`）：

- 来源：<https://rpu.oss-cn-beijing.aliyuncs.com/public-assets/interactive-app/libraries/three/0.185.1/cd656eaacc43d186.js>
- SRI：`sha384-HD30k0eOAqHW262h01p+m21wZaASPIwJ4Q5vVqUm6TEoisrOIeENf0+Sou5uuipq`
- 形态：IIFE，暴露全局 `window.DoppelThree`（经典 script 标签即可加载，无需 ESM/import map）

版本升级必须与 interactive-app 受控库同批进行（两侧共用同一 three 主版本，避免模型在两套
API 之间漂移）。校验：`openssl dgst -sha384 -binary three-0.185.1.js | base64` 应等于上面的 SRI。

渲染链路（render_animation / render.sh 的 file:// 页面）经
`<script src="file:///data/skills/_shared/three/three-0.185.1.js"></script>` 引用；
Interactive App 作品不写 script 标签，从 `window.doppel.libs.three` 取用。
