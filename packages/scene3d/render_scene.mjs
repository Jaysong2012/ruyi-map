#!/usr/bin/env node
// 3D 场景段落渲染器（跨项目复用）：three.js 场景程序 → 逐帧截图 → ffmpeg 出 mp4。
//
// 用法: node scripts/render_scene.mjs <scene.json>
//
// scene.json:
// {
//   "out": ".work/lights_out.mp4",   // 相对 spec 文件目录
//   "canvas": [1920, 1080], "fps": 60, "durationMs": 17000, "crf": 18,
//   "program": "lights_out",          // 内置场景程序，见下方 PROGRAMS 注释
//   "params": { ... }                  // 各程序自有的时间编排参数
// }
//
// 设计要点：
// - 纹理经内置静态服务器加载（repo 根为 server 根），规避 file:// CORS。
// - 页面暴露 window.__render(t)：确定性 hook——相同 t 相同帧，可逐帧 QA。
// - 浏览器用全量 chromium（--use-angle=metal 走 GPU），不是 headless shell 的软渲染。
//
// 内置程序：
//   lights_out      地球日照→熄灯→夜景灯光浮现（一镜到底「骤然漆黑→人类的光」）
//     params: { dimStartMs, dimMs, blackHoldMs, nightRiseMs, rotY0 }
//   wandering_earth 银河背景下冷暗地球缓漂+镜头缓拉（「流浪地球」）
//     params: { rotY0 }

import { launchChromium } from '../render_core/node/chromium.mjs';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');  // ruyi-map 仓根（assets/ 静态服务根）
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
               '.html': 'text/html', '.js': 'text/javascript' };

const specPath = resolve(process.argv[2]);
const spec = JSON.parse(readFileSync(specPath, 'utf-8'));
const [W, H] = spec.canvas ?? [1920, 1080];
const FPS = spec.fps ?? 60;
const DURATION = spec.durationMs / 1000;
const FRAMES = Math.round(DURATION * FPS);
const specDir = dirname(specPath);
const OUT = isAbsolute(spec.out) ? spec.out : join(specDir, spec.out);
const outDir = dirname(OUT);
const framesDir = join(outDir, `_frames_${spec.program}`);
rmSync(framesDir, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });

const LAYOUT = spec.layout;   // [bw,bh] 布局基准：4K 时 viewport=布局尺寸 + deviceScaleFactor=SC（DOM 文字 3x 栅格化锐利）
const SC = LAYOUT ? W / LAYOUT[0] : 1;
const FONT_FACE = ['RuyiSmiley:SmileySans-Oblique.ttf','RuyiZcool:ZCOOLQingKeHuangYou-Regular.ttf','RuyiGrotesk:SpaceGrotesk.ttf']
  .map((d) => { const [fam, fn] = d.split(':'); return `@font-face{font-family:'${fam}';src:url('/assets/fonts/${fn}') format('truetype')}`; }).join(';');
const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${FONT_FACE}
html,body{margin:0;width:${LAYOUT ? LAYOUT[0] : W}px;height:${LAYOUT ? LAYOUT[1] : H}px;overflow:hidden;background:#000}
canvas{display:block}
</style></head><body><script>${readFileSync(join(REPO, 'assets/three/three-0.185.1.js'), 'utf8')}<\/script>
<script>
const THREE = window.DoppelThree;
window.__SC__ = ${SC};
const CFG = ${JSON.stringify({ program: spec.program, params: spec.params ?? {}, duration: DURATION })};

const renderer = new THREE.WebGLRenderer({ antialias: ${JSON.stringify(spec.antialias !== false)}, preserveDrawingBuffer: true });
renderer.setSize(${W}, ${H}, ${LAYOUT ? false : true});${LAYOUT ? `
renderer.domElement.style.width = '${LAYOUT[0]}px'; renderer.domElement.style.height = '${LAYOUT[1]}px';` : ''}
renderer.setPixelRatio(1);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, ${W} / ${H}, 0.1, 100);

const loader = new THREE.TextureLoader();
async function tex(path, srgb = true) {
  const t = await loader.loadAsync('/' + path);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };

async function buildLightsOut(p) {
  const day = await tex('assets/space/textures/8k_earth_daymap.jpg');
  const cloudsT = await tex('assets/space/textures/2k_earth_clouds.jpg');
  const nightT = await tex('assets/space/textures/2k_earth_nightmap.jpg');
  const globe = new THREE.Mesh(new THREE.SphereGeometry(1, 256, 256),
    new THREE.MeshStandardMaterial({ map: day, roughness: 1, metalness: 0 }));
  scene.add(globe);
  const clouds = new THREE.Mesh(new THREE.SphereGeometry(1.012, 256, 256),
    new THREE.MeshStandardMaterial({ alphaMap: cloudsT, transparent: true,
      roughness: 1, metalness: 0, depthWrite: false }));
  scene.add(clouds);
  const night = new THREE.Mesh(new THREE.SphereGeometry(1.004, 256, 256),
    new THREE.MeshBasicMaterial({ map: nightT, blending: THREE.AdditiveBlending,
      transparent: true, opacity: 0.0, depthWrite: false }));
  scene.add(night);
  const sun = new THREE.DirectionalLight(0xfff2e0, 2.8);
  sun.position.set(-2.2, 1.2, 3.0);
  scene.add(sun);
  const ambient = new THREE.AmbientLight(0xffffff, 0.05);
  scene.add(ambient);
  const dimS = p.dimStartMs / 1000, dimD = p.dimMs / 1000;
  const riseS = dimS + dimD + p.blackHoldMs / 1000, riseD = p.nightRiseMs / 1000;
  return (t) => {
    const dark = smooth((t - dimS) / dimD);            // 熄灯进程 0→1
    const rise = smooth((t - riseS) / riseD);          // 夜景灯光浮现 0→1
    sun.intensity = 2.8 * (1 - dark);
    ambient.intensity = 0.05 * (1 - dark);
    night.material.opacity = 0.28 + 0.72 * rise;       // 熄灯后只剩城市灯光
    globe.rotation.y = (p.rotY0 ?? 4.2) + 0.02 * t;
    clouds.rotation.y = globe.rotation.y + 0.25;
    night.rotation.y = globe.rotation.y;
    camera.position.set(0, 0.12, 3.5 - 0.3 * clamp01(t / CFG.duration));
    camera.lookAt(0, 0, 0);
  };
}

async function buildWandering(p) {
  const sky = await tex('assets/space/textures/8k_stars_milky_way.jpg');
  sky.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = sky;
  const day = await tex('assets/space/textures/8k_earth_daymap.jpg');
  const nightT = await tex('assets/space/textures/2k_earth_nightmap.jpg');
  const globe = new THREE.Mesh(new THREE.SphereGeometry(1, 256, 256),
    new THREE.MeshStandardMaterial({ map: day, roughness: 1, metalness: 0 }));
  scene.add(globe);
  const night = new THREE.Mesh(new THREE.SphereGeometry(1.004, 256, 256),
    new THREE.MeshBasicMaterial({ map: nightT, blending: THREE.AdditiveBlending,
      transparent: true, opacity: p.nightOpacity ?? 0.5, depthWrite: false }));
  scene.add(night);
  const starlight = new THREE.DirectionalLight(0x8fa8e8, p.starlight ?? 0.5);   // 冷蓝星光
  starlight.position.set(-3, 1.5, 2.5);
  scene.add(starlight);
  return (t) => {
    const k = clamp01(t / CFG.duration);
    globe.rotation.y = (p.rotY0 ?? 4.2) + 0.03 * t;
    night.rotation.y = globe.rotation.y;
    globe.position.set(0.15 - 0.6 * k, 0.02 + 0.2 * k, 0);
    night.position.copy(globe.position);
    camera.position.set(0, 0.1 + 0.15 * k, 3.2 + 1.6 * k);       // 缓拉远
    camera.lookAt(globe.position.x * 0.4, globe.position.y * 0.4, 0);
  };
}

// pacific_dive  宇宙中的真实纹理地球 → 俯冲赤道太平洋 → 程序化海面与暖流。
// 地球纹理负责地理定位；近海水体是诚实的机制示意，不冒充卫星或实拍观测。
// params: { rotY0, diveEnd, oceanStart, warmStart }
async function buildPacificDive(p) {
  const sky = await tex('assets/space/textures/8k_stars_milky_way.jpg');
  sky.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = sky;

  const dayT = await tex('assets/space/textures/8k_earth_daymap.jpg');
  const cloudsT = await tex('assets/space/textures/2k_earth_clouds.jpg');
  const earthMat = new THREE.MeshStandardMaterial({
    map: dayT, roughness: 0.92, metalness: 0, transparent: true
  });
  const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 192, 192), earthMat);
  if (hasL('earth')) scene.add(earth);
  const cloudMat = new THREE.MeshStandardMaterial({
    alphaMap: cloudsT, color: 0xffffff, transparent: true,
    opacity: 0.72, roughness: 1, metalness: 0, depthWrite: false
  });
  const clouds = new THREE.Mesh(new THREE.SphereGeometry(1.012, 192, 192), cloudMat);
  scene.add(clouds);

  // 大气边缘只承担尺度与空间感，不做装饰性 HUD。
  const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(1.035, 160, 160),
    new THREE.ShaderMaterial({
      transparent: true, side: THREE.BackSide, depthWrite: false,
      uniforms: { uAlpha: { value: 1 } },
      vertexShader: 'varying vec3 vN; varying vec3 vV; ' +
        'void main(){ vec4 w=modelMatrix*vec4(position,1.0); vN=normalize(mat3(modelMatrix)*normal); ' +
        'vV=normalize(cameraPosition-w.xyz); gl_Position=projectionMatrix*viewMatrix*w; }',
      fragmentShader: 'uniform float uAlpha; varying vec3 vN; varying vec3 vV; ' +
        'void main(){ float f=pow(1.0-max(dot(vN,vV),0.0),2.5); ' +
        'gl_FragColor=vec4(0.18,0.55,1.0,f*0.38*uAlpha); }'
    }));
  scene.add(atmosphere);

  const sun = new THREE.DirectionalLight(0xfff4e8, 4.2);
  sun.position.set(-3.5, 2.2, 4.5); scene.add(sun);
  scene.add(new THREE.AmbientLight(0x7ea3d8, 0.42));

  // 屏幕空间海面：多层波纹生成法线、反光与泡沫；暖流只改变水体色泽和高光。
  const waterT = await tex('assets/viz/waternormals.jpg', false);
  waterT.wrapS = waterT.wrapT = THREE.RepeatWrapping;
  const oceanMat = new THREE.ShaderMaterial({
    transparent: true, depthTest: false, depthWrite: false,
    uniforms: {
      uTime: { value: 0 }, uAlpha: { value: 0 }, uWarm: { value: 0 },
      uWaterMap: { value: waterT },
      uResolution: { value: new THREE.Vector2(${W}, ${H}) }
    },
    vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}',
    fragmentShader: [
      'precision highp float;',
      'varying vec2 vUv; uniform float uTime,uAlpha,uWarm; uniform vec2 uResolution; uniform sampler2D uWaterMap;',
      'float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123);}',
      'float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);',
      'return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.)),f.x),f.y);}',
      'float waves(vec2 p,float t){',
      'float h=0.;',
      'h+=.48*sin(dot(p,vec2(1.15,.44))*7.2+t*1.15);',
      'h+=.27*sin(dot(p,vec2(-.35,1.32))*12.5-t*.72);',
      'h+=.15*sin(dot(p,vec2(.92,-1.08))*23.0+t*1.82);',
      'h+=.10*(noise(p*18.0+vec2(t*.42,-t*.18))*2.0-1.0);',
      'return h;}',
      'void main(){',
      'vec2 uv=vUv; vec2 p=(uv-.5)*vec2(uResolution.x/uResolution.y,1.0);',
      'float persp=mix(1.35,.72,uv.y); vec2 q=vec2(p.x*persp,p.y*1.3);',
      'float h=waves(q,uTime); float e=.0035;',
      'vec2 grad=vec2(waves(q+vec2(e,0.),uTime)-h,waves(q+vec2(0.,e),uTime)-h)/e;',
      'vec3 nm1=texture2D(uWaterMap,uv*2.8+vec2(uTime*.018,-uTime*.011)).xyz*2.0-1.0;',
      'vec3 nm2=texture2D(uWaterMap,uv*5.1+vec2(-uTime*.010,uTime*.016)).xyz*2.0-1.0;',
      'vec3 n=normalize(vec3((nm1.xy+nm2.xy)*.34-grad*.010,1.0));',
      'vec3 light=normalize(vec3(-.35,.7,.62));',
      'float diffuse=.38+.62*max(dot(n,light),0.0);',
      'float spec=pow(max(dot(reflect(-light,n),normalize(vec3(0.,.28,1.))),0.0),18.0);',
      'float sky=.16+.35*pow(1.0-uv.y,1.5);',
      'vec3 deep=vec3(.008,.075,.145), blue=vec3(.018,.26,.39);',
      'vec3 col=mix(deep,blue,clamp(diffuse+sky,0.,1.));',
      'col+=vec3(.65,.82,.92)*spec*.48;',
      'col*=.88+.16*clamp(n.z,0.0,1.0);',
      'float crest=smoothstep(.72,.94,h*.5+.5)*smoothstep(.25,.95,abs(grad.x+grad.y)*.045);',
      'col=mix(col,vec3(.48,.72,.82),crest*.14);',
      'float center=.48+.055*sin((uv.x+uTime*.055)*7.0)+.018*sin((uv.x-uTime*.09)*19.0);',
      'float plume=exp(-pow((uv.y-center)/.115,2.0));',
      'float advect=noise(vec2(uv.x*8.0-uTime*.38,uv.y*22.0+sin(uv.x*8.0)));',
      'plume*=smoothstep(.18,.78,uv.x+uWarm*.36)*(.58+.42*advect)*uWarm;',
      'vec3 warm=vec3(.36,.235,.105)+vec3(.20,.075,.012)*(0.45+spec);',
      'col=mix(col,warm,plume*.68);',
      'float warmLine=smoothstep(.82,.97,advect)*plume;',
      'float thread1=exp(-pow((uv.y-center-.026*sin(uv.x*28.0-uTime*2.2))/.022,2.0));',
      'float thread2=exp(-pow((uv.y-center+.052-.018*sin(uv.x*21.0-uTime*1.7))/.018,2.0));',
      'float streak=smoothstep(.72,.94,noise(vec2(uv.x*14.0-uTime*.55,uv.y*45.0)))*plume;',
      'col+=vec3(.34,.135,.025)*(warmLine*.16+(thread1+thread2)*plume*.15+streak*.18);',
      'float vign=1.0-.30*pow(length((uv-.5)*vec2(.9,1.1)),1.7);',
      'gl_FragColor=vec4(col*vign,uAlpha);}'
    ].join('\\n')
  });
  const ocean = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), oceanMat);
  ocean.frustumCulled = false; ocean.renderOrder = 20; scene.add(ocean);

  const diveEnd = p.diveEnd ?? 3.25;
  const oceanStart = p.oceanStart ?? 2.55;
  const warmStart = p.warmStart ?? 4.15;
  const rotY0 = p.rotY0 ?? 1.50;
  return (t) => {
    const dive = smooth(t / diveEnd);
    // 先看见完整地球，再加速冲向赤道太平洋；最后 0.7 秒让蓝色海域充满画面。
    const z = 4.55 - 3.28 * Math.pow(dive, 1.32);
    camera.position.set(0.0, 0.10 - 0.11*dive, z);
    camera.fov = 31 + 15*dive; camera.updateProjectionMatrix();
    camera.lookAt(0, -0.03*dive, 0);
    earth.rotation.y = rotY0 + .018*t;
    clouds.rotation.y = earth.rotation.y + .018 + .006*t;
    const oceanIn = smooth((t-oceanStart)/.82);
    earthMat.opacity = 1.0-oceanIn;
    cloudMat.opacity = .72*(1.0-oceanIn);
    atmosphere.material.uniforms.uAlpha.value = 1.0-oceanIn;
    oceanMat.uniforms.uTime.value = t;
    oceanMat.uniforms.uAlpha.value = oceanIn;
    oceanMat.uniforms.uWarm.value = smooth((t-warmStart)/2.15);
  };
}

// tidal_lock    地月系三幕：A「假如不自转」/ B「同步自转」/ C「潮汐锁定减速」
//   params: { act: "no_spin"|"sync"|"locking", revolutions, spinTurns }
//   视觉锚点：月球表面发光红标记点 + 地月视线——标记点相对视线的偏移即「哪面朝向地球」
async function buildTidalLock(p) {
  const act = p.act ?? 'sync';
  const sky = await tex('assets/space/textures/8k_stars_milky_way.jpg');
  sky.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = sky;

  // 地球（8k 日面 + 云 + 夜景灯光）
  const dayT = await tex('assets/space/textures/8k_earth_daymap.jpg');
  const cloudsT = await tex('assets/space/textures/2k_earth_clouds.jpg');
  const nightT = await tex('assets/space/textures/2k_earth_nightmap.jpg');
  const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 128),
    new THREE.MeshStandardMaterial({ map: dayT, roughness: 1, metalness: 0 }));
  if (hasL('earth')) scene.add(earth);
  const clouds = new THREE.Mesh(new THREE.SphereGeometry(1.012, 128, 128),
    new THREE.MeshStandardMaterial({ alphaMap: cloudsT, transparent: true,
      roughness: 1, metalness: 0, depthWrite: false }));
  scene.add(clouds);
  const night = new THREE.Mesh(new THREE.SphereGeometry(1.004, 128, 128),
    new THREE.MeshBasicMaterial({ map: nightT, blending: THREE.AdditiveBlending,
      transparent: true, opacity: 0.55, depthWrite: false }));
  scene.add(night);

  // 月球（2k LROC）+ 发光红标记点
  const moonT = await tex('assets/space/textures/2k_moon_lroc_2025.jpg');
  const R = p.orbitRadius ?? 3.4;                    // 轨道半径（科教压缩比例，非真实 60:1）
  const MR = p.moonRadius ?? 0.42;
  const moon = new THREE.Mesh(new THREE.SphereGeometry(MR, 96, 96),
    new THREE.MeshStandardMaterial({ map: moonT, roughness: 1, metalness: 0 }));
  scene.add(moon);
  const marker = new THREE.Mesh(new THREE.SphereGeometry(MR * 0.2, 24, 24),
    new THREE.MeshBasicMaterial({ color: 0xff2a1a }));
  marker.position.set(0, 0, MR * 1.02);              // 月球局部 +Z 即「正脸」方向
  moon.add(marker);
  // 标记点辉光（canvas 径向渐变 sprite）
  const glowCanvas = document.createElement('canvas');
  glowCanvas.width = glowCanvas.height = 128;
  const g2d = glowCanvas.getContext('2d');
  const grad = g2d.createRadialGradient(64, 64, 2, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,70,40,0.95)');
  grad.addColorStop(0.35, 'rgba(255,50,30,0.4)');
  grad.addColorStop(1, 'rgba(255,40,20,0)');
  g2d.fillStyle = grad; g2d.fillRect(0, 0, 128, 128);
  const glowTex = new THREE.CanvasTexture(glowCanvas);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex,
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  halo.scale.set(MR * 2.4, MR * 2.4, 1);
  marker.add(halo);

  // 轨道圆 + 地月视线
  const orbitPts = [];
  for (let i = 0; i <= 128; i++) {
    const a = (i / 128) * Math.PI * 2;
    orbitPts.push(new THREE.Vector3(Math.cos(a) * R, 0, Math.sin(a) * R));
  }
  const orbit = new THREE.Line(new THREE.BufferGeometry().setFromPoints(orbitPts),
    new THREE.LineBasicMaterial({ color: 0x4a6a9a, transparent: true, opacity: 0.35 }));
  scene.add(orbit);
  const sightGeo = new THREE.BufferGeometry().setFromPoints(
    [new THREE.Vector3(), new THREE.Vector3(R, 0, 0)]);
  const sight = new THREE.Line(sightGeo,
    new THREE.LineBasicMaterial({ color: 0x77d4ff, transparent: true, opacity: 0.6 }));
  scene.add(sight);

  const sun = new THREE.DirectionalLight(0xfff2e0, 4.5);
  sun.position.set(-5, 2.5, 3);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x6a86c8, 0.7);   // 冷蓝补光，夜面可读
  fill.position.set(4, -1, -3);
  scene.add(fill);
  scene.add(new THREE.AmbientLight(0x8fa8e8, 0.3));

  // 运动学：公转角 a(t)=a0+w·t；标记点朝向由 moon.rotation.y 控制
  const revs = p.revolutions ?? 1.3;
  const w = (Math.PI * 2 * revs) / CFG.duration;
  const a0 = p.a0 ?? 0.6;
  const rySync = (a) => Math.atan2(-Math.cos(a), -Math.sin(a));  // 正脸对地球的 rotation.y
  const ry0 = rySync(a0);
  // C 幕：自转误差角——开局飞快、被「拖」到 0（(1-smooth)² 归一化，总转 spinTurns 圈）
  const T = CFG.duration, SPIN_TURNS = p.spinTurns ?? 2;
  const NORM = 0.371;                              // ∫₀¹(1-3x²+2x³)²dx
  const integ = (x) =>                             // 上式的解析积分（展开 (1-3x²+2x³)² 逐项积）
    x - 2 * x ** 3 + x ** 4 + (9 / 5) * x ** 5 - 2 * x ** 6 + (4 / 7) * x ** 7;
  const extra = (t) =>
    SPIN_TURNS * Math.PI * 2 * integ(clamp01(t / T)) / NORM;
  const bulge = (t) => act === 'locking'
    ? 0.10 - 0.05 * smooth((t / T - 0.55) / 0.45)   // 椭球形变：随锁定略回收（夸张化科教表达）
    : 0.05;

  return (t) => {
    const a = a0 + w * t;
    const mx = Math.cos(a) * R, mz = Math.sin(a) * R;
    moon.position.set(mx, 0, mz);
    if (act === 'no_spin') moon.rotation.y = ry0;              // 相对星空不转
    else if (act === 'sync') moon.rotation.y = rySync(a);      // 永远正脸对地球
    else moon.rotation.y = ry0 - extra(t);                     // 误差自转 → 被拖到同步
    // 潮汐隆起：沿月球「正脸」轴（局部 +Z）拉长——同步态下即指向地球；
    // C 幕高速自转时隆起随月体飞转，正是「隆起被自转拖离连线」的视觉化
    const b = 1 + bulge(t);
    moon.scale.set(1 / Math.sqrt(b), 1 / Math.sqrt(b), b);
    sightGeo.setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(mx, 0, mz)]);
    earth.rotation.y = 4.2 + 0.03 * t;
    clouds.rotation.y = earth.rotation.y + 0.25;
    night.rotation.y = earth.rotation.y;
    // 相机：斜俯视缓推；C 幕锁定瞬间 push-in + 标记点亮度脉冲
    const k = clamp01(t / T);
    const push = act === 'locking' ? 1.2 * smooth((k - 0.8) / 0.2) : 0.4 * k;
    const camA = 0.35 + 0.05 * k;
    const dist = (p.camDist ?? 8.6) - push;
    camera.position.set(Math.cos(camA) * dist, (p.camElev ?? 3.4) - 0.5 * k,
      Math.sin(camA) * dist);
    camera.lookAt(0, 0, 0);
    if (act === 'locking') {
      const pulse = k > 0.85 ? 1 + 0.5 * Math.sin((k - 0.85) * 60) * (k - 0.85) : 1;
      halo.scale.set(MR * 2.4 * pulse, MR * 2.4 * pulse, 1);
    }
  };
}

// solar_system_map  太阳系俯视轨道图：太阳居中 + 八大行星贴图球 + 轨道圆，
//   相机高位斜俯视缓推/缓拉，可选聚焦行星（发光标记环 + 相机偏向）。
//   讲「位置/距离/轨道/谁和谁比邻」的万能底图（探测题/尺度题/家族题通吃）。
//   params: { focus:"earth"|行星英文名|null, push:-1(拉远)|0|1(推近),
//             orbitPace:公转速度系数(默认1), camElev, camDist, a0 }
//   比例纪律：轨道半径与球径均为科教压缩比（非真实），文案不得引用画面比例当事实。
async function buildSolarSystemMap(p) {
  const sky = await tex('assets/space/textures/8k_stars_milky_way.jpg');
  sky.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = sky;

  // 行星表：[名, 纹理, 轨道半径, 球径, 初始相位]
  const PLANETS = [
    ['mercury', '2k_mercury.jpg',        2.2, 0.18, 0.9],
    ['venus',   '2k_venus_surface.jpg',  3.0, 0.30, 2.4],
    ['earth',   '2k_earth_daymap.jpg',   3.8, 0.32, 4.1],
    ['mars',    '2k_mars.jpg',           4.6, 0.24, 1.2],
    ['jupiter', '2k_jupiter.jpg',        6.4, 0.88, 5.3],
    ['saturn',  '2k_saturn.jpg',         8.6, 0.76, 3.6],
    ['uranus',  '2k_uranus.jpg',        10.8, 0.50, 0.3],
    ['neptune', '2k_neptune.jpg',       13.0, 0.48, 4.8],
  ];
  const pace = p.orbitPace ?? 1;

  // 太阳（自发光 + 辉光 sprite）
  const sunT = await tex('assets/space/textures/2k_sun.jpg');
  const sun = new THREE.Mesh(new THREE.SphereGeometry(1.1, 96, 96),
    new THREE.MeshBasicMaterial({ map: sunT }));
  scene.add(sun);
  const glowCanvas = document.createElement('canvas');
  glowCanvas.width = glowCanvas.height = 256;
  const g2 = glowCanvas.getContext('2d');
  const grad = g2.createRadialGradient(128, 128, 8, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,220,150,0.9)');
  grad.addColorStop(0.35, 'rgba(255,180,80,0.28)');
  grad.addColorStop(0.7, 'rgba(255,160,60,0)');   // 收紧：日冕贴身，远端无模糊裙摆（主人 2026-08-27）
  g2.fillStyle = grad; g2.fillRect(0, 0, 256, 256);
  const sunHalo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(glowCanvas),
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  sunHalo.scale.set(p.sunHaloScale ?? 3.2, p.sunHaloScale ?? 3.2, 1);
  sun.add(sunHalo);

  const sunLight = new THREE.PointLight(0xfff2e0, 2.6, 0, 0.6);
  scene.add(sunLight);
  scene.add(new THREE.AmbientLight(0x8fa8e8, 0.55));   // 深空底光，夜面可读

  // 轨道圆
  for (const [, , r] of PLANETS) {
    const pts = [];
    for (let i = 0; i <= 160; i++) {
      const a = (i / 160) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
    }
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0x4a6a9a, transparent: true, opacity: 0.28 })));
  }

  // 行星
  const bodies = [];
  let focusBody = null;
  for (const [name, texFile, r, size, phase] of PLANETS) {
    const t = await tex('assets/space/textures/' + texFile);
    const m = new THREE.Mesh(new THREE.SphereGeometry(size, 64, 64),
      new THREE.MeshStandardMaterial({ map: t, roughness: 1, metalness: 0 }));
    scene.add(m);
    if (name === 'saturn') {
      const ringT = await tex('assets/space/textures/2k_saturn_ring_alpha.png', false);
      const ring = new THREE.Mesh(new THREE.RingGeometry(size * 1.25, size * 2.3, 96),
        new THREE.MeshBasicMaterial({ map: ringT, transparent: true,
          side: THREE.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2 + 0.28;
      m.add(ring);
    }
    // 角速度：外圈慢（开普勒气质，压缩表达）
    const w = (0.10 * pace) * Math.pow(3.8 / r, 1.5);
    const body = { name, mesh: m, r, phase, w };
    bodies.push(body);
    if (p.focus === name) focusBody = body;
  }

  // 聚焦行星标记环（暖金脉冲）
  let focusRing = null;
  if (focusBody) {
    const R0 = focusBody.mesh.geometry.parameters.radius;
    focusRing = new THREE.Mesh(new THREE.RingGeometry(R0 * 1.7, R0 * 1.85, 64),
      new THREE.MeshBasicMaterial({ color: 0xffc25e, transparent: true, opacity: 0.9,
        side: THREE.DoubleSide, depthWrite: false }));
    focusRing.rotation.x = -Math.PI / 2;
    scene.add(focusRing);
  }

  const T = CFG.duration;
  const push = p.push ?? 1;                    // 1 推近 / -1 拉远 / 0 定场
  const dist0 = p.camDist ?? 17.5;
  const elev0 = p.camElev ?? 9.5;
  const a0 = p.a0 ?? 0.5;
  return (t) => {
    const k = clamp01(t / T);
    for (const b of bodies) {
      const a = b.phase + b.w * t;
      b.mesh.position.set(Math.cos(a) * b.r, 0, Math.sin(a) * b.r);
      b.mesh.rotation.y = 4.2 + 0.05 * t;
    }
    sun.rotation.y = 0.02 * t;
    if (focusBody && focusRing) {
      focusRing.position.copy(focusBody.mesh.position);
      const pulse = 1 + 0.12 * Math.sin(t * 3.2);
      focusRing.scale.set(pulse, 1, pulse);
      focusRing.material.opacity = 0.65 + 0.3 * Math.sin(t * 3.2);
    }
    // 相机：高位斜俯视，推/拉；聚焦时视点向目标行星偏移 35%
    const dist = dist0 * (1 - 0.22 * push * smooth(k));
    const camA = a0 + 0.06 * k;
    const cx = Math.cos(camA) * dist, cz = Math.sin(camA) * dist;
    camera.position.set(cx, elev0 - 1.2 * smooth(k) * push, cz);
    const tx = focusBody ? focusBody.mesh.position.x * 0.35 : 0;
    const tz = focusBody ? focusBody.mesh.position.z * 0.35 : 0;
    camera.lookAt(tx, 0, tz);
  };
}

// jilong_flyover  吉隆沟 3D 地形飞行（地形片首个真实 DEM 场景）：
//   Terrarium DEM（SRTM 系）+ Esri 卫星影像贴图，垂直夸张 1.8x，
//   相机从东南高空俯瞰全沟 → 北端进沟 → 沿沟向南低飞 → 悬停吉隆口岸（红色光柱标记）。
//   数据：fetch_terrain_block.py 产物（heights.f32 + surface.jpg + meta.json），params.base 注入。
//   params: { exaggeration(默认1.8), step(DEM降采样,默认2), camFov(默认50) }
//   镜头纪律：相机高度全程 > 谷底 exaggerated 高度，防钻山；字幕承载数字，画面只给体感。
async function buildJilongFlyover(p) {
  const base = p.base;
  if (!base) throw new Error('jilong_flyover: params.base 必填（fetch_terrain_block 产物目录，服务器相对路径）');
  const meta = await (await fetch('/' + base + '/meta.json')).json();
  const buf = await (await fetch('/' + base + '/heights.f32')).arrayBuffer();
  const HG = new Float32Array(buf);
  const texT = await tex(base + '/texture.jpg');

  const KM_LAT = 110.6;
  const KM_LON = 111.3 * Math.cos(((meta.latNorth + meta.latSouth) / 2) * Math.PI / 180);
  const spanX = (meta.lonEast - meta.lonWest) * KM_LON;
  const spanZ = (meta.latNorth - meta.latSouth) * KM_LAT;
  const EXAG = p.exaggeration ?? 1.8;
  const STEP = p.step ?? 2;
  const gc = Math.floor(meta.cols / STEP), gr = Math.floor(meta.rows / STEP);

  const geo = new THREE.PlaneGeometry(spanX, spanZ, gc - 1, gr - 1);
  geo.rotateX(-Math.PI / 2);   // 躺平：+x 东，-z 北，+y 高
  const pos = geo.attributes.position;
  for (let r = 0; r < gr; r++)
    for (let c = 0; c < gc; c++)
      pos.setY(r * gc + c, HG[(r * STEP) * meta.cols + c * STEP] / 1000 * EXAG);
  geo.computeVertexNormals();
  scene.add(new THREE.Mesh(geo,
    new THREE.MeshStandardMaterial({ map: texT, roughness: 1, metalness: 0 })));

  // 地理坐标 → 场景坐标（北 = -z）
  const lonC = (meta.lonWest + meta.lonEast) / 2, latC = (meta.latNorth + meta.latSouth) / 2;
  const groundY = (lon, lat) => {
    const c = Math.min(meta.cols - 1, Math.max(0, Math.round(
      (lon - meta.lonWest) / (meta.lonEast - meta.lonWest) * (meta.cols - 1))));
    const r = Math.min(meta.rows - 1, Math.max(0, Math.round(
      (meta.latNorth - lat) / (meta.latNorth - meta.latSouth) * (meta.rows - 1))));
    return HG[r * meta.cols + c] / 1000 * EXAG;
  };
  const toScene = (lon, lat) => [
    (lon - lonC) * KM_LON, groundY(lon, lat), (latC - lat) * KM_LAT];

  // 口岸光柱标记（后段淡入）：「答案藏在地图上」的锚点
  const port = meta.landmarks.jilong_port;
  const [px, py, pz] = toScene(port.lon, port.lat);
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 7, 24, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xff3a26, transparent: true, opacity: 0,
      side: THREE.DoubleSide, depthWrite: false }));
  pillar.position.set(px, py + 3.5, pz);
  scene.add(pillar);
  const glowCv = document.createElement('canvas');
  glowCv.width = glowCv.height = 128;
  const g2 = glowCv.getContext('2d');
  const gr2 = g2.createRadialGradient(64, 64, 2, 64, 64, 64);
  gr2.addColorStop(0, 'rgba(255,70,40,0.9)');
  gr2.addColorStop(0.4, 'rgba(255,50,30,0.3)');
  gr2.addColorStop(1, 'rgba(255,40,20,0)');
  g2.fillStyle = gr2; g2.fillRect(0, 0, 128, 128);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(glowCv),
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
  halo.scale.set(6, 6, 1);
  halo.position.set(px, py + 0.6, pz);
  scene.add(halo);

  // 上午东南光 + 大气雾（纵深 + 罩住地形边缘断面，防「悬浮板」穿帮）
  const sun = new THREE.DirectionalLight(0xfff2e0, 2.6);
  sun.position.set(60, 80, 50);
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0xbfd4ea, 0.85));
  scene.fog = new THREE.Fog(0x9db8d2, 22, 130);
  scene.background = new THREE.Color(0x9db8d2);

  camera.fov = p.camFov ?? 50;
  camera.far = 600;
  camera.updateProjectionMatrix();

  // 沟线：宗嘎镇（北）→ 吉隆镇 → 口岸（南）
  const lm = meta.landmarks;
  const way = [lm.zongga, lm.jilong_town, lm.jilong_port].map(q => toScene(q.lon, q.lat));
  const lerp3 = (a, b, x) => [a[0] + (b[0] - a[0]) * x, a[1] + (b[1] - a[1]) * x,
                              a[2] + (b[2] - a[2]) * x];
  const pathAt = (s) => {                     // s∈[0,1] 沿沟线（北→南）
    s = clamp01(s);
    const seg = s < 0.62 ? 0 : 1;
    const ss = seg === 0 ? s / 0.62 : (s - 0.62) / 0.38;
    return lerp3(way[seg], way[seg + 1], ss);
  };
  const sceneY = (x, z) => {                  // 场景坐标处的 exaggerated 地面高
    const lon = x / KM_LON + lonC, lat = latC - z / KM_LAT;
    return groundY(lon, lat);
  };

  // —— 防抖设计（主人 2026-08-27：「3D 地形段抖动的不要不要的」）——
  // 根因：相机 y 踩在 34m DEM 网格的 round 采样上，山区逐帧阶梯跳变；
  //       三段拼接 + 折线 lookAt 在衔接处朝向突变。
  // 方案：相机/视线各一条 CatmullRom 连续样条（无拼接），密采样后 y 做
  //       box blur 平滑并 bake 成查找表（渲染时纯索引，保持确定性）。
  const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
  const alt = (s) => 14 - 8 * smooth(s);      // 沿程离地高度 14 → 6 渐降
  const camKeys = [
    [6, 32, 42], [4, 24, 30],                 // 全景两键（手布高度）
    ...[0.02, 0.22, 0.45, 0.68, 0.88].map(s => {
      const g = pathAt(s);
      return [g[0] + 3.6, g[1] + alt(s), g[2] - 7];
    }),
    [px + 1, py + 7, pz - 8], [px + 2, py + 6.5, pz - 4],   // 口岸悬停
  ].map(V);
  const lookKeys = [
    [-4, 4, 10], [-4, 4, 16],                 // 全景看沟中南段
    ...[0.2, 0.42, 0.65, 0.86].map(s => {
      const g = pathAt(s);
      return [g[0], g[1] - 0.5, g[2]];        // 俯看谷底，读出「裂缝」
    }),
    [px, py + 1, pz], [px, py + 1, pz],       // 收尾盯住口岸
  ].map(V);
  const camCurve = new THREE.CatmullRomCurve3(camKeys, false, 'centripetal');
  const lookCurve = new THREE.CatmullRomCurve3(lookKeys, false, 'centripetal');

  const N = 720;                              // 60fps × 12s 对齐帧网格
  const camPts = [];
  for (let i = 0; i <= N; i++) camPts.push(camCurve.getPointAt(i / N));
  for (const q of camPts) q.y = Math.max(q.y, sceneY(q.x, q.z) + 4.5);  // 离地保底
  const ys = camPts.map(q => q.y);            // y 滑动平均（窗 ±18 帧 ≈ ±0.3s）
  for (let i = 0; i <= N; i++) {
    let s = 0, c = 0;
    for (let j = -18; j <= 18; j++) {
      const q = Math.min(N, Math.max(0, i + j));
      s += ys[q]; c++;
    }
    camPts[i].y = s / c;
  }
  let maxStep = 0;                            // 平滑自检：帧间 y 跳变（米/帧）
  for (let i = 1; i <= N; i++)
    maxStep = Math.max(maxStep, Math.abs(camPts[i].y - camPts[i - 1].y));
  console.error('jilong_flyover: max camY step = ' + (maxStep * 1000).toFixed(1) + ' m/帧');

  const T = CFG.duration;
  return (t) => {
    const k = clamp01(t / T);
    const cp = camPts[Math.min(N, Math.round(k * N))];
    const lp = lookCurve.getPointAt(k);
    camera.position.copy(cp);
    camera.lookAt(lp);
    const mark = smooth((k - 0.45) / 0.1);    // 光柱中段起亮：远方红点→结尾揭晓
    pillar.material.opacity = 0.55 * mark;
    halo.material.opacity = 0.85 * mark * (0.75 + 0.25 * Math.sin(t * 4));
  };
}

// cme_storm  日冕物质抛射直击地球（电影级机制段，EP3 卡灵顿停电）：
//   2k 太阳贴图自发光球 + 辉光；8k 地球（日面+云+夜景灯光）；18 条发光偶极磁力线；
//   1200 粒子 CME 云团从日面喷出飞越日地空间；撞击瞬间弓形激波闪光 + 磁力线向日侧
//   压缩抖动衰减；随后地球夜景灯光波浪式增亮（= 电网被注入电流的直观化）。
//   params: { burstMs(喷发,默认3000), hitMs(撞击,默认12000) }
//   镜头纪律：CatmullRom 双样条（相机+视线），密采样烘焙，与 jilong_flyover 同法防抖。
async function buildCmeStorm(p) {
  const sky = await tex('assets/space/textures/8k_stars_milky_way.jpg');
  sky.mapping = THREE.EquirectangularReflectionMapping;
  sky.wrapS = THREE.RepeatWrapping;   // 等距柱状全景必须水平重复包裹——ClampToEdge 会把边缘亮星拉成贯穿全屏的竖线
  scene.background = sky;

  const SUN_X = -13, SUN_R = 5.5, EARTH_X = 13.5, EARTH_R = 1.6;
  const BURST = (p.burstMs ?? 3000) / 1000, HIT = (p.hitMs ?? 12000) / 1000;

  // 确定性 PRNG
  let seed = 20260828;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  // —— 太阳（贴图自发光 + 双层辉光）——
  const sunT = await tex('assets/space/textures/2k_sun.jpg');
  const sun = new THREE.Mesh(new THREE.SphereGeometry(SUN_R, 96, 96),
    new THREE.MeshBasicMaterial({ map: sunT }));
  sun.position.set(SUN_X, 0, 0);
  scene.add(sun);
  const mkGlow = (inner, outer, scale) => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 128;
    const g = cv.getContext('2d');
    const gr = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    gr.addColorStop(0, inner); gr.addColorStop(0.45, outer); gr.addColorStop(1, 'rgba(255,140,40,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv),
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    sp.scale.set(scale, scale, 1); sp.position.set(SUN_X, 0, 0); scene.add(sp);
    return sp;
  };
  mkGlow('rgba(255,220,150,0.55)', 'rgba(255,160,60,0.22)', SUN_R * 3.4);
  mkGlow('rgba(255,190,110,0.25)', 'rgba(255,120,40,0.10)', SUN_R * 5.6);

  // —— 地球（日面 + 云 + 夜景灯光层）——
  const dayT = await tex('assets/space/textures/8k_earth_daymap.jpg');
  const cloudsT = await tex('assets/space/textures/2k_earth_clouds.jpg');
  const nightT = await tex('assets/space/textures/2k_earth_nightmap.jpg');
  const earthG = new THREE.Group(); earthG.position.set(EARTH_X, 0, 0); scene.add(earthG);
  earthG.add(new THREE.Mesh(new THREE.SphereGeometry(EARTH_R, 96, 96),
    new THREE.MeshStandardMaterial({ map: dayT, roughness: 1, metalness: 0 })));
  // 夜景灯光：ShaderMaterial——灭灯扫描波（dark 波从夜面中心经度向两侧扩散，
  // 「一盏一盏灭掉」的体感）；uniforms.opacity=灯光总亮（浪涌用），sweep=灭灯进度 0..1
  const nightMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: nightT }, opacity: { value: 0.45 }, sweep: { value: 0 } },
    vertexShader: 'varying vec2 vUv;' +
      'void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform sampler2D map; uniform float opacity; uniform float sweep;' +
      'varying vec2 vUv;' +
      'void main(){' +
      '  vec3 c = texture2D(map, vUv).rgb;' +
      '  float d = abs(vUv.x - 0.5) * 2.0;' +              // 0=夜面中心经度 → 1=两侧
      '  float front = sweep * 1.4;' +                     // 灭灯波前（sweep=1 时越过边缘）
      '  float kill = 1.0 - 0.92 * (1.0 - smoothstep(front - 0.3, front, d));' +
      '  gl_FragColor = vec4(c * opacity * kill, 1.0);' +
      '}',
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const night = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R * 1.004, 96, 96), nightMat);
  earthG.add(night);
  earthG.add(new THREE.Mesh(new THREE.SphereGeometry(EARTH_R * 1.015, 96, 96),
    new THREE.MeshStandardMaterial({ alphaMap: cloudsT, transparent: true,
      roughness: 1, metalness: 0, depthWrite: false })));
  // 太阳方向主光 + 环境光
  const dl = new THREE.DirectionalLight(0xfff2d8, 2.2);
  dl.position.set(SUN_X, 3, 6); scene.add(dl);
  scene.add(new THREE.AmbientLight(0x33445e, 0.7));

  // —— 偶极磁力线（3 壳层 × 12 方位角，发光青）——
  // 磁场层挂在不随地球自转的 magG 上：磁层锚定太阳风方向（压缩/磁尾是日参照系现象），
  // 若挂 earthG 随自转，被压扁的环会绕极轴扫过，投影成贯穿两极的「细高竖线」假象。
  const magG = new THREE.Group(); magG.position.set(EARTH_X, 0, 0); scene.add(magG);
  const SHELLS = [2.3, 3.0, 3.8], AZIMUTHS = 12, LPTS = 48;
  const fieldMat = new THREE.LineBasicMaterial({ color: 0x6fc8ff, transparent: true,
    opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false });
  const fieldLines = [];
  for (const L of SHELLS) for (let a = 0; a < AZIMUTHS; a++) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(LPTS * 3), 3));
    const line = new THREE.Line(geo, fieldMat); line.frustumCulled = false;
    magG.add(line); fieldLines.push({ geo, L, az: a / AZIMUTHS * Math.PI * 2 });
  }
  // compress: 向日侧(-x)径向均匀内压（xyz 同步缩放，保持环的圆胖形状）；
  // wob: 撞击抖动；tail: 背日侧磁尾拉伸——每帧重建
  function updateField(compress, wob, tail = 0) {
    for (const { geo, L, az } of fieldLines) {
      const arr = geo.attributes.position.array;
      const R = L * EARTH_R;
      for (let i = 0; i < LPTS; i++) {
        const lam = (-65 + 130 * i / (LPTS - 1)) * Math.PI / 180;   // 磁纬
        const r = R * Math.cos(lam) * Math.cos(lam);                // 偶极 r=L·cos²λ
        const d = r * Math.cos(lam);                                // 轴距
        let x = d * Math.cos(az), y = r * Math.sin(lam), z = d * Math.sin(az);
        // 向日侧：各向同性径向内压（只缩 x 会把环拉成细高椭圆——竖线假象的根因）
        const sunW = clamp01(-x / R);
        const s = 1 - (compress - wob) * sunW;
        x *= s; y *= s; z *= s;
        // 背日侧：磁尾拉伸（只拉 x，按离轴距离平滑加权）
        x *= 1 + tail * clamp01(x / R);
        arr[i * 3] = x; arr[i * 3 + 1] = y; arr[i * 3 + 2] = z;
      }
      geo.attributes.position.needsUpdate = true;
    }
  }
  updateField(0, 0);

  // —— CME 粒子云（前锋 150 亮核 + 主体 1600，锥形扩散，软圆辉光贴图）——
  const puffCv = document.createElement('canvas'); puffCv.width = puffCv.height = 64;
  const pg = puffCv.getContext('2d');
  const pgr = pg.createRadialGradient(32, 32, 2, 32, 32, 32);
  pgr.addColorStop(0, 'rgba(255,250,230,1)'); pgr.addColorStop(0.35, 'rgba(255,205,110,0.8)');
  pgr.addColorStop(0.7, 'rgba(255,150,50,0.3)'); pgr.addColorStop(1, 'rgba(255,140,40,0)');
  pg.fillStyle = pgr; pg.fillRect(0, 0, 64, 64);
  const puffTex = new THREE.CanvasTexture(puffCv);
  const mkCloud = (n, size, color) => {
    const g = new THREE.BufferGeometry();
    const arr = new Float32Array(n * 3);
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const m = new THREE.PointsMaterial({ color, size, map: puffTex,
      transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthWrite: false, sizeAttenuation: true });
    const pts = new THREE.Points(g, m); pts.frustumCulled = false; scene.add(pts);
    return { g, arr, m, n };
  };
  const FRONT = mkCloud(150, 1.05, 0xfff3c4);
  const BODY = mkCloud(1600, 0.55, 0xffc25e);
  const mkParts = (n, lagScale) => {
    const a = [];
    for (let i = 0; i < n; i++) a.push({
      th: rnd() * Math.PI * 2, cone: Math.pow(rnd(), 0.6),
      spd: 0.8 + rnd() * 0.45, lag: rnd() * lagScale, sw: rnd() * Math.PI * 2 });
    return a;
  };
  const frontParts = mkParts(FRONT.n, 0.12), bodyParts = mkParts(BODY.n, 0.55);
  const START_X = SUN_X + SUN_R * 0.95, END_X = EARTH_X - EARTH_R * 1.35;

  // 撞击闪光（弓形激波位）
  const flash = mkGlow('rgba(255,240,200,0.9)', 'rgba(255,180,80,0.4)', 0.01);
  flash.position.set(EARTH_X - EARTH_R * 1.5, 0, 0);

  // —— 日面磁力拱（「磁场拧到极限」可视化：0–BURST 摆动加剧=拧紧，BURST 断裂甩出消散）——
  // 剂量纪律（§二十三-9）：additive 4 条 opacity ≤0.5；拱在 +x 半球（相机可见侧），
  // 超出日面边缘的部分靠球体深度自然遮挡。
  const ARCH_PTS = 40, arches = [];
  for (let a = 0; a < 4; a++) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((ARCH_PTS + 1) * 3), 3));
    const geo2 = new THREE.BufferGeometry();   // 微偏移平行线：WebGL 线宽恒 1px，双线模拟加粗
    geo2.setAttribute('position', new THREE.BufferAttribute(new Float32Array((ARCH_PTS + 1) * 3), 3));
    const mat = new THREE.LineBasicMaterial({ color: 0xffe6a8, transparent: true,
      opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const line = new THREE.Line(geo, mat); line.frustumCulled = false; scene.add(line);
    const line2 = new THREE.Line(geo2, mat); line2.frustumCulled = false; scene.add(line2);
    arches.push({ geo, geo2, mat, phase: a * 0.9 - 1.35, span: 0.55 + a * 0.16, lift: 0.32 + 0.1 * (a % 2) });
  }
  function updateArches(t) {
    const wind = clamp01(t / BURST);                     // 拧紧进度（BURST 时刻达 1）
    const out = smooth((t - BURST) / 1.15);              // 断裂甩出
    for (const { geo, geo2, mat, phase, span, lift } of arches) {
      const arr = geo.attributes.position.array, arr2 = geo2.attributes.position.array;
      for (let i = 0; i <= ARCH_PTS; i++) {
        const u = i / ARCH_PTS, th = phase - span / 2 + span * u;
        const top = Math.sin(u * Math.PI);               // 拱顶权重
        // 拧紧：拱顶摆动幅度与频率随 wind 增大（橡皮筋越拧越抖）
        const twist = top * (0.04 + 0.30 * wind) * SUN_R * 0.14
                    * Math.sin(t * (2.2 + 7.5 * wind) + phase * 3);
        const rr = SUN_R * (0.99 + top * lift)
                 * (1 + out * (0.9 + top * 1.6));        // 断裂：向外甩（拱顶甩更远）
        arr[i * 3] = SUN_X + rr * Math.cos(th);
        arr[i * 3 + 1] = rr * Math.sin(th) * 0.92 + twist;
        arr[i * 3 + 2] = rr * Math.sin(th * 0.6 + phase) * 0.4 + twist * 0.5;
        arr2[i * 3] = arr[i * 3]; arr2[i * 3 + 1] = arr[i * 3 + 1] + 0.055;
        arr2[i * 3 + 2] = arr[i * 3 + 2] + 0.04;
      }
      geo.attributes.position.needsUpdate = true;
      geo2.attributes.position.needsUpdate = true;
      mat.opacity = 0.85 * smooth(t / 0.7) * (1 - out);
    }
  }

  // —— 极光帘（两极，撞击后点亮）：每极 3 圈竖直光幕（三角带 ribbon，底亮顶渐隐）——
  const AURORA_RINGS = [67, 71, 75], RING_PTS = 72;
  const aurCv = document.createElement('canvas'); aurCv.width = 4; aurCv.height = 128;
  const ac2 = aurCv.getContext('2d');
  const aurGr = ac2.createLinearGradient(0, 128, 0, 0);   // v=0(帘底)→v=1(帘顶)
  aurGr.addColorStop(0, 'rgba(46,255,120,0.55)');
  aurGr.addColorStop(0.35, 'rgba(30,225,130,0.28)');
  aurGr.addColorStop(0.7, 'rgba(40,190,190,0.10)');
  aurGr.addColorStop(1, 'rgba(100,90,255,0)');
  ac2.fillStyle = aurGr; ac2.fillRect(0, 0, 4, 128);
  const auroraMat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(aurCv),
    transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide });
  const auroras = [];
  for (const pole of [1, -1]) {
    for (let ri = 0; ri < AURORA_RINGS.length; ri++) {
      const lat = AURORA_RINGS[ri] * Math.PI / 180;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((RING_PTS + 1) * 2 * 3), 3));
      const uv = new Float32Array((RING_PTS + 1) * 2 * 2);
      const idx = [];
      for (let i = 0; i <= RING_PTS; i++) {
        uv[(i * 2) * 2] = i / RING_PTS; uv[(i * 2) * 2 + 1] = 0;
        uv[(i * 2 + 1) * 2] = i / RING_PTS; uv[(i * 2 + 1) * 2 + 1] = 1;
        if (i < RING_PTS) {
          const a0 = i * 2, b0 = i * 2 + 1, a1 = i * 2 + 2, b1 = i * 2 + 3;
          idx.push(a0, a1, b0, b0, a1, b1);
        }
      }
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setIndex(idx);
      const m = new THREE.Mesh(geo, auroraMat); m.frustumCulled = false;
      earthG.add(m);
      auroras.push({ geo, pole, lat, ri });
    }
  }
  const auroraGlowCv = document.createElement('canvas'); auroraGlowCv.width = auroraGlowCv.height = 128;
  const ag = auroraGlowCv.getContext('2d');
  const agr = ag.createRadialGradient(64, 64, 6, 64, 64, 64);
  agr.addColorStop(0, 'rgba(80,255,170,0.5)'); agr.addColorStop(0.5, 'rgba(60,220,150,0.18)');
  agr.addColorStop(1, 'rgba(40,200,120,0)');
  ag.fillStyle = agr; ag.fillRect(0, 0, 128, 128);
  const auroraGlows = [1, -1].map(pole => {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(auroraGlowCv),
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
    sp.scale.set(EARTH_R * 3.0, EARTH_R * 2.0, 1);
    sp.position.set(0, pole * EARTH_R * 1.0, 0);
    earthG.add(sp); return sp;
  });
  function updateAurora(level, t) {
    auroraMat.opacity = 0.8 * level;
    for (const { geo, pole, lat, ri } of auroras) {
      const arr = geo.attributes.position.array;
      const ringR = EARTH_R * Math.sin(lat);
      const baseY = pole * EARTH_R * Math.cos(lat);
      for (let i = 0; i <= RING_PTS; i++) {
        const a = i / RING_PTS * Math.PI * 2;
        const wave = (0.06 * Math.sin(a * 3 + t * 1.8 + ri * 2)
                    + 0.04 * Math.sin(a * 5 - t * 2.6 + ri)) * EARTH_R * level;
        const rr = ringR * (1 + 0.04 * Math.sin(a * 4 + t * 1.3 + ri));
        const bx = rr * Math.cos(a), bz = rr * Math.sin(a);
        const by = baseY + pole * (0.04 * EARTH_R + wave * 0.3);
        const hh = (0.20 + 0.06 * Math.sin(a * 4 - t * 2.1 + ri * 1.7)) * EARTH_R * level + wave;
        arr[(i * 2) * 3] = bx; arr[(i * 2) * 3 + 1] = by; arr[(i * 2) * 3 + 2] = bz;
        arr[(i * 2 + 1) * 3] = bx; arr[(i * 2 + 1) * 3 + 1] = by + pole * hh; arr[(i * 2 + 1) * 3 + 2] = bz;
      }
      geo.attributes.position.needsUpdate = true;
    }
    for (const sp of auroraGlows)
      sp.material.opacity = 0.14 * level;   // 光幕本体承担体量，sprite 只补一层薄晕
  }

  // —— 相机双样条（日面中景 → 跟飞 → 撞击 → 夜面中景定格，地球全程在画内）——
  const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
  const camCurve = new THREE.CatmullRomCurve3([
    V([-5.5, 2.6, 21]), V([-3, 2.4, 21.5]), V([2, 2.0, 21]),
    V([6.5, 1.8, 19.5]), V([9, 1.8, 18]), V([9.5, 3.0, 17])], false, 'centripetal');
  // 视线目标按「秒」打点（不按弦长）：撞击前 1s 必须锁定地球——
  // 弦长参数化会让 look 在大跨段上迟到，撞击时刻镜头还在看空处（money shot 跑焦）。
  const LOOK_KEYS = [
    [0,   -9.5, 0,   0],   // 开场：日面
    [3.5, -8.0, 0,   0],   // 喷发前：日面边缘（CME 起点在画内）
    [6,   -4,   0.1, 0],   // 云团离日
    [9,    2,   0.1, 0],   // 中段跟飞
    [12,   8,   0.1, 0],   // 逼近：视线抢先移向地球
    [14,  13.5, 0.1, 0],   // 撞击前 1s：锁定地球
    [20,  13.5, 0.3, 0],   // 极光/浪涌
    [29,  13.5, 0.6, 0],   // 收尾：微抬
  ];
  const lookAt = (t) => {
    let i = 0;
    while (i < LOOK_KEYS.length - 2 && LOOK_KEYS[i + 1][0] <= t) i++;
    const a = LOOK_KEYS[i], b = LOOK_KEYS[i + 1];
    const u = smooth((t - a[0]) / (b[0] - a[0]));
    return new THREE.Vector3(a[1] + (b[1] - a[1]) * u,
      a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u);
  };
  const NPTS = 600, camPts = [];
  for (let i = 0; i <= NPTS; i++) camPts.push(camCurve.getPointAt(i / NPTS));

  const T = CFG.duration;
  return (t) => {
    const k = clamp01(t / T);
    camera.position.copy(camPts[Math.min(NPTS, Math.round(k * NPTS))]);
    camera.lookAt(lookAt(t));

    sun.rotation.y = t * 0.03;
    earthG.rotation.y = t * 0.05;
    updateArches(t);

    // CME 飞行：BURST 出发，HIT 抵达（前锋亮核 + 主体云）
    const fly = clamp01((t - BURST) / (HIT - BURST));
    const flyFade = (fly <= 0 ? 0 : Math.min(1, fly * 6)) * (1 - smooth((t - HIT) / 1.2));
    const drive = (cloud, plist, lagScale) => {
      for (let i = 0; i < cloud.n; i++) {
        const q = plist[i];
        const u = clamp01(fly * q.spd * 1.3 - q.lag * lagScale);
        const x = START_X + (END_X - START_X) * u;
        const spread = 0.5 + Math.pow(u, 1.3) * 4.5 * q.cone;
        cloud.arr[i * 3] = x;
        cloud.arr[i * 3 + 1] = Math.cos(q.th + u * 2 + q.sw) * spread;
        cloud.arr[i * 3 + 2] = Math.sin(q.th + u * 2 + q.sw) * spread;
      }
      cloud.g.attributes.position.needsUpdate = true;
      cloud.m.opacity = 0.95 * flyFade;
    };
    drive(FRONT, frontParts, 0.55);
    drive(BODY, bodyParts, 0.55);

    // 撞击：闪光 + 磁场压缩抖动+磁尾拉伸 → 极光点亮 → 灯光浪涌 → 成片熄灭
    const hit = smooth((t - HIT) / 0.4);
    const wob = hit * Math.exp(-(t - HIT) / 2.2) * Math.sin((t - HIT) * 7) * 0.12;
    updateField(0.34 * hit, wob, 0.22 * hit);
    fieldMat.opacity = 0.55 + 0.35 * hit;
    const fl = Math.exp(-(t - HIT) / 0.9);
    flash.material.opacity = t > HIT ? 0.9 * fl : 0;
    const fs = Math.min(1 + (t - HIT) * 5, 12);
    flash.scale.set(fs, fs, 1);
    if (t - HIT > 3) flash.material.opacity = 0;
    // 极光：撞击 1.5s 后点亮，摆动到片尾
    const aur = smooth((t - HIT - 1.5) / 1.8);
    updateAurora(aur, t);
    // 城市灯光：浪涌（hit→hit+4s）→ 扫描波成片熄灭（hit+5.5s 起 4s，中心向两侧）
    const surge = hit * Math.exp(-(t - HIT) / 4);
    const blackout = smooth((t - HIT - 5.5) / 4);
    const lights = 0.45 + surge * (0.85 + 0.3 * Math.sin(t * 8));
    nightMat.uniforms.opacity.value = lights;
    nightMat.uniforms.sweep.value = blackout;
    // 熄灯后地球整体沉入暗蓝（只剩极光在烧）
    dl.intensity = 2.2 * (1 - 0.55 * blackout);
  };
}

// eclipse_geometry  血月机制两幕一体（EP4 S2+S3）：A「日地月一线·影子罩月」/ B「大气掰弯阳光·红光入影」
//   params: { actBMs: 11200 }  A/B 幕切换时刻（毫秒）
async function buildEclipseGeometry(p) {
  const sky = await tex('assets/space/textures/8k_stars_milky_way.jpg');
  sky.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = sky;
  const actB = (p.actBMs ?? 11200) / 1000;

  function glowSprite(c0, c1, size) {
    const cv = document.createElement('canvas'); cv.width = cv.height = 256;
    const g = cv.getContext('2d');
    const grad = g.createRadialGradient(128, 128, 4, 128, 128, 128);
    grad.addColorStop(0, c0); grad.addColorStop(0.35, c1); grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv),
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    s.scale.set(size, size, 1); return s;
  }
  // 太阳（左外辉光 + 平行光）
  const sunGlow = glowSprite('rgba(255,244,214,1)', 'rgba(255,180,80,0.55)', 7.0);
  sunGlow.position.set(-13, 1.0, -1.5); scene.add(sunGlow);
  const sunLight = new THREE.DirectionalLight(0xfff2dc, 2.6);
  sunLight.position.set(-10, 1, 2); scene.add(sunLight);
  scene.add(new THREE.AmbientLight(0xffffff, 0.10));
  const fill = new THREE.DirectionalLight(0x5a7099, 0.35);   // 夜面微蓝灰补光（死黑→可读）
  fill.position.set(3, -1, 2); scene.add(fill);

  // 地球（8k 日面 + 云 + 菲涅尔大气边光）
  const dayT = await tex('assets/space/textures/8k_earth_daymap.jpg');
  const cloudsT = await tex('assets/space/textures/2k_earth_clouds.jpg');
  const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 128),
    new THREE.MeshStandardMaterial({ map: dayT, roughness: 1, metalness: 0 }));
  if (hasL('earth')) scene.add(earth);
  const clouds = new THREE.Mesh(new THREE.SphereGeometry(1.012, 128, 128),
    new THREE.MeshStandardMaterial({ alphaMap: cloudsT, transparent: true,
      roughness: 1, metalness: 0, depthWrite: false }));
  scene.add(clouds);
  const atmMat = new THREE.ShaderMaterial({
    vertexShader: 'varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal);' +
      ' gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'varying vec3 vN; uniform vec3 uColor; uniform float uMul;' +
      ' void main(){ float rim = pow(max(0.0, 0.68 - dot(vN, vec3(0.0, 0.0, 1.0))), 3.0);' +
      ' gl_FragColor = vec4(uColor, 1.0) * rim * uMul; }',
    uniforms: { uColor: { value: new THREE.Color(0x6fa8ff) }, uMul: { value: 1.5 } },
    side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(1.07, 96, 96), atmMat));

  // 月球（2k LROC），右侧 +X
  const moonT = await tex('assets/space/textures/2k_moon_lroc_2025.jpg');
  const moonMat = new THREE.MeshStandardMaterial({ map: moonT, roughness: 1, metalness: 0 });
  const moon = new THREE.Mesh(new THREE.SphereGeometry(0.42, 96, 96), moonMat);
  scene.add(moon);

  // 本影锥（地球背阳面 → +X 月球方向；openEnded 暗蓝灰半透——靠遮蔽星field读出体积）
  const coneLen = 4.9;
  const coneMat = new THREE.MeshBasicMaterial({ color: 0x0a1220, transparent: true,
    opacity: 0.0, side: THREE.DoubleSide, depthWrite: false });
  const cone = new THREE.Mesh(new THREE.CylinderGeometry(1.02, 0.70, coneLen, 64, 1, true), coneMat);
  cone.rotation.z = -Math.PI / 2;                    // +Y → +X（粗端在地球侧）
  cone.position.set(coneLen / 2 + 0.05, 0, 0);
  scene.add(cone);

  // 弯折光线（Act B）：14 条三次贝塞尔束（白→橙红顶点色，seed 确定性粗细/透明度起伏）
  // ——光幕式密集排布去「五线谱」感；核心管+宽晕管双层体积感 + 光子 sprite 沿曲线流动 + 弯折点大气辉光
  const rayGroup = new THREE.Group(); scene.add(rayGroup);
  let raySeed = 11;
  const rayRnd = () => (raySeed = (raySeed * 16807) % 2147483647) / 2147483647;
  const rayDefs = [];
  for (let i = 0; i < 14; i++) {
    const u = i / 13, sgn = i % 2 === 0 ? 1 : -1;
    const band = Math.ceil(i / 2) / 7;                       // 0 → 1 逐对向外
    rayDefs.push({
      y0: sgn * (1.02 + band * 0.62 + rayRnd() * 0.05),
      yb: sgn * (0.30 + (1 - band) * 0.34 + rayRnd() * 0.04),
      delay: u * 1.1 + rayRnd() * 0.25,
      coreR: 0.007 + rayRnd() * 0.008,
      haloR: 0.035 + rayRnd() * 0.035,
      gain: 0.55 + rayRnd() * 0.45,
    });
  }
  const rays = [];
  const moonPos = new THREE.Vector3(4.3, 0.08, 0);
  for (const d of rayDefs) {
    const curve = new THREE.CubicBezierCurve3(
      new THREE.Vector3(-9, d.y0, 0), new THREE.Vector3(-1.1, d.y0 * 0.99, 0),
      new THREE.Vector3(1.7, d.yb, 0), moonPos.clone());
    const nPts = 73 * 9, mkColors = () => {
      const colors = new Float32Array(nPts * 3);
      const cA = new THREE.Color(0xfff3dc), cB = new THREE.Color(0xff4a1e);
      for (let i = 0; i < nPts; i++) {
        const u = Math.floor(i / 9) / 72;
        const c = cA.clone().lerp(cB, smooth((u - 0.42) / 0.5));
        colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
      }
      return colors;
    };
    const coreGeo = new THREE.TubeGeometry(curve, 72, d.coreR, 8, false);
    coreGeo.setAttribute('color', new THREE.BufferAttribute(mkColors(), 3));
    const coreMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true,
      opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    rayGroup.add(new THREE.Mesh(coreGeo, coreMat));
    const haloGeo = new THREE.TubeGeometry(curve, 72, d.haloR, 8, false);
    haloGeo.setAttribute('color', new THREE.BufferAttribute(mkColors(), 3));
    const haloMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true,
      opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    rayGroup.add(new THREE.Mesh(haloGeo, haloMat));
    const photon = glowSprite('rgba(255,220,180,1)', 'rgba(255,120,50,0.6)', 0.16);
    photon.material.opacity = 0; rayGroup.add(photon);
    rays.push({ curve, coreMat, haloMat, photon, delay: d.delay, gain: d.gain });
  }

  // 弯折点大气辉光（地球晨昏线两极方向被日落光点亮——光幕的视觉落点）
  const bendGlows = [];
  for (const gy of [0.62, -0.62]) {
    const gl = glowSprite('rgba(255,190,120,0.9)', 'rgba(255,90,30,0.5)', 2.6);
    gl.position.set(0.95, gy, 0.4); gl.material.opacity = 0;
    scene.add(gl); bendGlows.push(gl);
  }

  const atmBlue = new THREE.Color(0x6fa8ff), atmWarm = new THREE.Color(0xffa050);
  return (t) => {
    const kB = smooth((t - actB) / 2.5);               // A→B 运镜插值
    // 月球：A 幕从锥外滑入锥内（4.95 → 4.3）
    const slide = smooth(t / Math.max(1, actB * 0.8));
    moon.position.set(4.95 - 0.65 * slide, 0.08, 0);
    // 本影锥：A 幕 2–6s 渐显（旁白「路过了地球的阴影」落点须可辨）
    coneMat.opacity = 0.55 * smooth((t - 2) / 4);
    // 光线与光子：B 幕后按 delay 依次点亮、流动（核心管实、晕管柔；gain 制造明暗层次）
    for (const r of rays) {
      const on = smooth((t - actB - r.delay) / 1.2);
      r.coreMat.opacity = 0.62 * r.gain * on;
      r.haloMat.opacity = 0.16 * r.gain * on;
      const ph = (t - actB - r.delay) / 3.0;
      if (ph > 0) {
        r.photon.material.opacity = 0.9 * on;
        r.photon.position.copy(r.curve.getPoint(ph % 1));
      }
    }
    // 弯折点辉光：B 幕 +1.5s 起渐亮，微呼吸（大气被点亮的视觉主角）
    for (let i = 0; i < bendGlows.length; i++) {
      const gOn = smooth((t - actB - 1.5 - i * 0.5) / 2.5);
      bendGlows[i].material.opacity = gOn * (0.5 + 0.1 * Math.sin(t * 1.1 + i * 2.1));
    }
    // 大气边光：B 幕转暖（被日落光点亮）+ 微光晕呼吸
    atmMat.uniforms.uColor.value = atmBlue.clone().lerp(atmWarm, kB);
    atmMat.uniforms.uMul.value = 1.5 + 0.3 * Math.sin(t * 1.3) * kB;
    // 月球染红：B 幕 +4s 起
    const tint = smooth((t - actB - 4) / 3);
    moonMat.color.setRGB(1, 1 - 0.45 * tint, 1 - 0.62 * tint);
    // 运镜：A 幕广角三体 → B 幕推近地球边缘看掰弯；B 幕到位后持续微推+微降（23s 不锁死）
    const creep = smooth((t - actB) / Math.max(1, CFG.duration - actB));
    const ax = 0.4 + 1.8 * kB + 0.25 * creep, ay = 1.15 + 0.5 * kB - 0.12 * creep, az = 8.4 - 4.7 * kB - 0.45 * creep;
    camera.position.set(ax, ay, az);
    camera.lookAt(1.0 - 0.2 * kB, 0.1 + 0.62 * kB + 0.05 * creep, 0);
    earth.rotation.y = 4.2 + 0.015 * t;
    clouds.rotation.y = earth.rotation.y + 0.25;
  };
}

// red_ring_earth  月面视角海报帧（EP4 S5）：黑盘地球镶一圈红环（全地球的日出日落），红光洒月面
//   params: {}  运镜内置：缓推 + 红环呼吸
async function buildRedRingEarth(p) {
  const sky = await tex('assets/space/textures/8k_stars_milky_way.jpg');
  sky.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = sky;

  // 月面前景（大球局部弧过画面下缘，LROC 纹理）
  const moonT = await tex('assets/space/textures/2k_moon_lroc_2025.jpg');
  const ground = new THREE.Mesh(new THREE.SphereGeometry(30, 64, 32),
    new THREE.MeshStandardMaterial({ map: moonT, roughness: 1, metalness: 0, color: 0x9a9a9a }));
  ground.position.set(0, -29.9, 4);   // 月面地平线进画面底部
  scene.add(ground);

  // 地球黑盘（夜景贴图压暗）
  const nightT = await tex('assets/space/textures/2k_earth_nightmap.jpg');
  const EPOS = new THREE.Vector3(0, 2.7, -9);
  const earth = new THREE.Mesh(new THREE.SphereGeometry(1.55, 96, 96),
    new THREE.MeshBasicMaterial({ map: nightT, color: 0x232838 }));
  earth.position.copy(EPOS);
  if (hasL('earth')) scene.add(earth);

  // 红环（逐像素径向环带 × 角向亮度起伏，固定 seed 确定性）
  function ringTexture() {
    const S = 512, cv = document.createElement('canvas'); cv.width = cv.height = S;
    const g = cv.getContext('2d');
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const bumps = [];
    for (let i = 0; i < 5; i++) bumps.push({ a: rnd() * Math.PI * 2, w: 0.35 + rnd() * 0.7, k: 0.5 + rnd() * 0.5 });
    const img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const dx = x - S / 2, dy = y - S / 2;
      const r = Math.sqrt(dx * dx + dy * dy) / (S / 2);
      const bandCore = Math.exp(-Math.pow((r - 0.74) / 0.035, 2));   // 亮核（窄）
      const bandHalo = Math.exp(-Math.pow((r - 0.74) / 0.11, 2));    // 外晕（宽，大气散射感）
      const band = Math.min(1.6, bandCore * 1.2 + bandHalo * 0.45);
      if (band < 0.004) continue;
      const ang = Math.atan2(dy, dx);
      let amp = 0.55;
      for (const b of bumps) {
        let da = Math.abs(ang - b.a); if (da > Math.PI) da = 2 * Math.PI - da;
        amp += b.k * 0.5 * Math.exp(-Math.pow(da / b.w, 2));
      }
      amp = Math.min(1.8, amp);
      // 径向混色：内核暖白橙（日落直射）→ 外晕深血红（散射边）
      const coreMix = bandCore / (bandCore + bandHalo * 0.45 + 1e-5);
      const ampK = 0.55 + 0.45 * amp / 1.8;
      const idx = (y * S + x) * 4;
      img.data[idx] = 255;
      img.data[idx + 1] = Math.floor((34 + 130 * coreMix) * ampK);
      img.data[idx + 2] = Math.floor((18 + 70 * coreMix) * ampK);
      img.data[idx + 3] = Math.min(255, Math.floor(band * 235 * amp));
    }
    g.putImageData(img, 0, 0);
    return new THREE.CanvasTexture(cv);
  }
  const ring = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 4.6),
    new THREE.MeshBasicMaterial({ map: ringTexture(), transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  ring.position.copy(EPOS);
  scene.add(ring);

  // 红光洒月面（地球方向红色平行光）+ 微环境
  const redLight = new THREE.DirectionalLight(0xff4a2a, 0.85);
  redLight.position.set(0, 5, -7); scene.add(redLight);
  scene.add(new THREE.AmbientLight(0x201428, 0.55));

  return (t) => {
    const k = clamp01(t / CFG.duration);
    camera.position.set(0, 0.3 + 0.08 * k, 4.4 - 1.2 * k);   // 缓推近
    camera.lookAt(EPOS.x, EPOS.y - 0.9, EPOS.z);
    ring.lookAt(camera.position);
    ring.material.opacity = 0.85 + 0.15 * Math.sin(t * 0.9);  // 红环呼吸
    redLight.intensity = 0.75 + 0.25 * Math.sin(t * 0.9 + 1.2);
    ground.rotation.y = 0.004 * t;
  };
}

// terminator_earth  晨昏线地球（EP4 S3）：侧光半明半暗，晨昏线一圈橙红晖光（「日落是红的」太空实证）
//   params: { rotY0: 3.6 }  地球初始经度（亚太对相机）；运镜内置缓推
async function buildTerminatorEarth(p) {
  const sky = await tex('assets/space/textures/8k_stars_milky_way.jpg');
  sky.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = sky;

  // 太阳在画面左侧（-X）平射：地球左昼右夜，晨昏线竖贯画面
  const sunDir = new THREE.Vector3(-1, 0.06, 0.12).normalize();
  const sunLight = new THREE.DirectionalLight(0xfff2dc, 2.5);
  sunLight.position.copy(sunDir.clone().multiplyScalar(10)); scene.add(sunLight);
  scene.add(new THREE.AmbientLight(0x1a2440, 0.6));            // 夜面不死黑

  // 地球（8k 日面 + 夜景灯光 emissive + 云）
  const dayT = await tex('assets/space/textures/8k_earth_daymap.jpg');
  const nightT = await tex('assets/space/textures/2k_earth_nightmap.jpg');
  const cloudsT = await tex('assets/space/textures/2k_earth_clouds.jpg');
  const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 128),
    new THREE.MeshStandardMaterial({ map: dayT, emissiveMap: nightT,
      emissive: new THREE.Color(0xffb060), emissiveIntensity: 0.55, roughness: 1, metalness: 0 }));
  if (hasL('earth')) scene.add(earth);
  const clouds = new THREE.Mesh(new THREE.SphereGeometry(1.012, 128, 128),
    new THREE.MeshStandardMaterial({ alphaMap: cloudsT, transparent: true,
      roughness: 1, metalness: 0, depthWrite: false }));
  scene.add(clouds);

  // 晨昏线大气辉光：dot(N,sun)≈0 处橙红发光，叠加视角边缘冷蓝 rim
  const atmMat = new THREE.ShaderMaterial({
    vertexShader: 'varying vec3 vWN; varying vec3 vWP;' +
      ' void main(){ vWN = normalize(mat3(modelMatrix) * normal);' +
      ' vWP = (modelMatrix * vec4(position, 1.0)).xyz;' +
      ' gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'varying vec3 vWN; varying vec3 vWP; uniform vec3 uSun; uniform vec3 uCam; uniform float uMul;' +
      ' void main(){ vec3 N = normalize(vWN); vec3 V = normalize(uCam - vWP);' +
      ' float sd = dot(N, uSun);' +
      ' float band = exp(-pow(sd / 0.15, 2.0));' +
      ' float facing = smoothstep(-0.2, 0.2, dot(N, V));' +
      ' float rim = pow(1.0 - max(dot(N, V), 0.0), 2.2);' +
      ' vec3 warm = vec3(1.0, 0.38, 0.12); vec3 cool = vec3(0.35, 0.55, 1.0);' +
      ' vec3 col = mix(cool, warm, clamp(band * 2.2, 0.0, 1.0));' +
      ' float a = (band * 0.5 + rim * 0.32) * facing * uMul;' +
      ' gl_FragColor = vec4(col * (band * 1.1 + rim * 0.45), a); }',
    uniforms: { uSun: { value: sunDir }, uCam: { value: new THREE.Vector3() }, uMul: { value: 1.0 } },
    side: THREE.FrontSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(1.08, 96, 96), atmMat));

  const rotY0 = p.rotY0 ?? 3.6;
  return (t) => {
    const k = clamp01(t / CFG.duration);
    camera.position.set(0, 0.34 - 0.06 * k, 4.7 - 0.6 * k);   // 缓推近
    camera.lookAt(0, 0.02, 0);
    atmMat.uniforms.uCam.value.copy(camera.position);
    atmMat.uniforms.uMul.value = 1.0 + 0.08 * Math.sin(t * 1.2);  // 晖光微呼吸
    earth.rotation.y = rotY0 + 0.012 * t;
    clouds.rotation.y = rotY0 + 0.05 + 0.014 * t;
  };
}


// epic_journey（别名 voyager_helio）  质感恒星系 + 探测器穿越边界膜（史诗航程/零帧王炸模板）
//   骨架=已验证工艺（勿轻动，判例见 SHOT_LIBRARY §一踩坑 11 条）：
//     Fresnel 边界膜+轨迹×膜数值求交事件点 / drawRange 生长轨迹 / 近景船模↔远景光点 camDist 互补 /
//     CAM_KEYS+五相 lookAt（相位边界连续=不闪）/ renderOrder 显式分层 / 打光基调
//   params（全部可覆盖，缺省=旅行者 1 号飞出日球层；传 membrane:null 得纯巡航场景）：
//     { sun:{r,tex,color,burn(0关燃烧shader)}, bodies:[{n,R,r,tex,tilt,a0,hero,heroTex,ring,
//       rot(自转rad/s,负=逆转), atm:[r,g,b,强度](菲涅尔大气壳), bump(岩质凹凸), sheen(气态高光)}],
//       launchBody:'earth', orbitGain(公转增益,缺省2.5), orbitPow(内外衰减指数,缺省1.2),
//       membrane:{R,scale:[x,y,z],color:[r,g,b]}|null, trajectory:[[x,y,z]...],
//       camKeys:[[k,[px,py,pz],[lx,ly,lz]]...], phaseK:[起飞,渐释,过渡带,混合锚,穿越锚],
//       lookout:[x,y,z](渐释终点), finalAnchor:[x,y,z](收尾锚),
//       speed:{pow,gain,slingshots:[{at,amp,width}]}, travelMs, camK(样张), showPlanets(掩码) }
//   2026-09-04 质感强化（主人裁决：太阳燃烧感/行星差速动起来/掠过行星近景高级感）：
//     太阳=域扭曲沸腾颗粒+临边昏暗+边缘火舌 shader、动态日冕壳、辉光呼吸、点光微闪烁；
//     行星=自转差速+菲涅尔大气壳+bump/高光+近距掠过大气增亮。轨迹/相机/相位骨架未动。
const EPIC_JOURNEY_DEFAULTS = {
  sun: { r: 2.2, tex: '2k_sun.jpg', color: 0xffe8d0, burn: 1 },
  bodies: [
    { n: 'mercury', R: 4.0,  r: 0.16,  tex: '2k_mercury.jpg', tilt: 0.03, a0: 1.2, rot: 0.05, bump: true },
    { n: 'venus',   R: 5.5,  r: 0.27,  tex: '2k_venus_surface.jpg', tilt: 3.1, a0: 3.9, rot: -0.03, bump: true, atm: [1.0, 0.85, 0.55, 0.55] },
    { n: 'earth',   R: 7.0,  r: 0.29,  tex: '2k_earth_daymap.jpg', heroTex: '8k_earth_daymap.jpg', tilt: 0.41, a0: 0.175, hero: true, rot: 0.22 },
    { n: 'mars',    R: 8.5,  r: 0.21,  tex: '2k_mars.jpg', tilt: 0.44, a0: 5.0, rot: 0.20, bump: true, atm: [1.0, 0.55, 0.38, 0.35] },
    { n: 'jupiter', R: 12.0, r: 1.04,  tex: '2k_jupiter.jpg', tilt: 0.05, a0: 0.328, rot: 0.55, sheen: true, atm: [1.0, 0.84, 0.58, 0.6] },
    { n: 'saturn',  R: 16.0, r: 0.88,  tex: '2k_saturn.jpg', tilt: 0.47, a0: 0.386, ring: true, rot: 0.48, sheen: true, atm: [1.0, 0.86, 0.58, 0.55] },
    { n: 'uranus',  R: 21.0, r: 0.54,  tex: '2k_uranus.jpg', tilt: 1.71, a0: 2.1, rot: 0.30, sheen: true, atm: [0.55, 0.85, 0.95, 0.65] },
    { n: 'neptune', R: 26.0, r: 0.53,  tex: '2k_neptune.jpg', tilt: 0.49, a0: 5.8, rot: 0.33, sheen: true, atm: [0.42, 0.62, 1.0, 0.7] },
  ],
  launchBody: 'earth', orbitGain: 2.5, orbitPow: 1.2,
  membrane: { R: 30.0, scale: [1.0, 0.86, 1.12], color: [0.55, 0.78, 1.0] },   // 日球层顶：+z 略拉长
  trajectory: [
    [6.8, 0.0, 1.2], [10.5, 0.0, 5.5], [12.2, 0.15, 9.0],      // 出发→木星借力
    [14.5, 0.5, 13.0], [16.3, 1.3, 16.2],                       // 土星借力·开始抬头
    [18.5, 3.4, 19.5], [21.5, 6.5, 23.0],                       // 北出黄道面
    [25.0, 10.0, 26.0], [28.5, 13.5, 28.5],                     // 接近气泡
    [31.0, 16.0, 31.0], [35.0, 19.5, 35.0],                     // 穿越点→星际空间
  ],
  camKeys: [
    [0.00, [8.4, 0.9, 3.4],    [6.8, 0.1, 1.2]],    // 近地：地球占半屏（起飞）
    [0.08, [10.5, 2.6, 8.0],   [6.9, 0.2, 1.4]],    // 离肩：地球开始缩小
    [0.18, [12.0, 7.0, 18.0],  [5.0, 0.8, 3.0]],    // 拉远：内太阳系展开
    [0.32, [7.0, 22.0, 40.0],  [0, 0.5, 4.0]],      // 全景：一眼太阳系
    [0.55, [4.0, 16.0, 36.0],  [6, 3.0, 12.0]],
    [0.78, [10.0, 16.0, 42.0], [16, 9.0, 22.0]],
    [1.00, [4.0, 24.0, 54.0],  [10, 6.0, 15.0]],
  ],
  phaseK: [0.10, 0.32, 0.38, 0.58, 0.80],   // 起飞锚 / 渐释 / 过渡带 / 混合锚 / 穿越锚→收尾
  lookout: [3, 2, 8],                       // 渐释终点（内太阳系上空）
  finalAnchor: [12, 7, 16],                 // 收尾锚（气泡里的家全景）
  speed: { pow: 1.25, gain: 1.02,           // 慢启动幂曲线 + 总增益
           slingshots: [ { at: 0.19, amp: 0.014, width: 0.06 },   // 木星借力提速
                         { at: 0.40, amp: 0.018, width: 0.06 } ] }, // 土星借力提速
};
async function buildEpicJourney(p) {
  const J = { ...EPIC_JOURNEY_DEFAULTS, ...p,
    sun: { ...EPIC_JOURNEY_DEFAULTS.sun, ...(p.sun ?? {}) },
    speed: { ...EPIC_JOURNEY_DEFAULTS.speed, ...(p.speed ?? {}) } };
  J.membrane = p.membrane === null ? null
             : { ...EPIC_JOURNEY_DEFAULTS.membrane, ...(p.membrane ?? {}) };
  const sky = await tex('assets/space/textures/8k_stars_milky_way.jpg');
  sky.mapping = THREE.EquirectangularReflectionMapping;
  sky.wrapS = THREE.RepeatWrapping;
  scene.background = sky;
  scene.backgroundIntensity = 0.55;

  let seed = 20260903;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  // —— 尺度系统（艺术化可读，非真实比例）——
  const SUN_R = J.sun.r;
  const PLANETS = J.bodies;
  const HELIO_R = J.membrane ? J.membrane.R : 30;

  // —— 太阳：燃烧感 shader（域扭曲沸腾颗粒 + 临边昏暗 + 边缘火舌）+ 动态日冕壳 + 呼吸辉光 ——
  const NOISE_GLSL =
    'float hash21(vec2 p){ p = fract(p * vec2(234.34, 435.345)); p += dot(p, p + 34.23); return fract(p.x * p.y); }' +
    'float vnoise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);' +
    '  float a = hash21(i); float b = hash21(i + vec2(1.0, 0.0));' +
    '  float c = hash21(i + vec2(0.0, 1.0)); float d = hash21(i + vec2(1.0, 1.0));' +
    '  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y); }' +
    'float fbm(vec2 p){ float v = 0.0; float a = 0.5;' +
    '  for (int i = 0; i < 4; i++) { v += a * vnoise(p); p *= 2.03; a *= 0.5; } return v; }';
  const VARY_GLSL =
    'varying vec2 vUv; varying vec3 vN; varying vec3 vW;' +
    'void main(){ vUv = uv; vN = normalize(normalMatrix * normal);' +
    '  vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;' +
    '  gl_Position = projectionMatrix * viewMatrix * w; }';
  const burn = J.sun.burn ?? 1;
  const sunT = await tex('assets/space/textures/' + J.sun.tex);
  let sun, sunMat = null;
  if (J.sun.legacy) {
    // 对照组：v6 旧光路（贴图自发光，无 shader）
    sun = new THREE.Mesh(new THREE.SphereGeometry(SUN_R, 96, 96),
      new THREE.MeshBasicMaterial({ map: sunT, color: J.sun.color }));
    scene.add(sun);
  } else {
  sunMat = new THREE.ShaderMaterial({
    uniforms: { uMap: { value: sunT }, uTime: { value: 0 },
                uColor: { value: new THREE.Color(J.sun.color) }, uBurn: { value: burn } },
    vertexShader: VARY_GLSL,
    fragmentShader:
      'uniform sampler2D uMap; uniform float uTime; uniform vec3 uColor; uniform float uBurn;' +
      'varying vec2 vUv; varying vec3 vN; varying vec3 vW;' + NOISE_GLSL +
      'void main(){' +
      '  float w1 = fbm(vUv * 5.0 + uTime * 0.045);' +
      '  float w2 = fbm(vUv * 11.0 - uTime * 0.03 + w1 * 1.7);' +
      '  vec2 warp = (vec2(w1, w2) - 0.5) * 0.045 * uBurn;' +       // 等离子体域扭曲（贴图缓缓流动）
      '  vec3 tx = texture2D(uMap, vUv + warp).rgb;' +
      '  float gran = 1.0 + (fbm(vUv * 26.0 + warp * 10.0 + uTime * 0.11) - 0.5) * 0.85 * uBurn;' +  // 沸腾米粒组织
      '  vec3 V = normalize(cameraPosition - vW);' +
      '  float ndv = abs(dot(normalize(vN), V));' +
      '  float limb = pow(ndv, 0.5);' +                              // 临边昏暗（真实测光感）
      '  vec3 col = tx * uColor * gran * (0.5 + 0.7 * limb);' +
      '  float rim = pow(1.0 - ndv, 2.0);' +                         // 边缘火舌
      '  col += vec3(1.0, 0.5, 0.16) * rim * (0.55 + 0.45 * w2) * (0.7 + 0.6 * uBurn);' +
      '  gl_FragColor = vec4(col, 1.0);\\n' +
      '#include <tonemapping_fragment>\\n' +
      '#include <colorspace_fragment>\\n' +
      '}' });
  sun = new THREE.Mesh(new THREE.SphereGeometry(SUN_R, 96, 96), sunMat);
  scene.add(sun);
  }   // （日冕壳按主人 2026-09-04 裁决移除：菲涅尔壳=气泡感，燃烧感由表面 shader+辉光承担）
  const mkGlow = (inner, outer, scale) => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 128;
    const g = cv.getContext('2d');
    const gr = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    gr.addColorStop(0, inner); gr.addColorStop(0.45, outer); gr.addColorStop(1, 'rgba(255,140,40,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv),
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    sp.scale.set(scale, scale, 1); scene.add(sp); return sp;
  };
  const glowA = mkGlow('rgba(255,220,150,0.62)', 'rgba(255,160,60,0.24)', SUN_R * 3.6);
  const glowB = mkGlow('rgba(255,190,110,0.26)', 'rgba(255,120,40,0.09)', SUN_R * 6.5);

  // —— 太阳点光（行星半球明暗=质感核心；燃烧感=强度微闪烁）——
  const sunLight = new THREE.PointLight(0xfff2d8, 4.2, 0, 0.3);
  scene.add(sunLight);
  scene.add(new THREE.AmbientLight(0x32405c, 0.95));

  // —— 行星轨道薄环 + 行星本体 ——
  const orbitMat = (op) => new THREE.MeshBasicMaterial({ color: 0xcfd8e8,
    transparent: true, opacity: op, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide });
  const planetMakers = [];
  const bodyGrps = {};
  for (const pl of PLANETS) {
    // 轨道：薄环带（退到背景层，不当主角）
    const ring = new THREE.Mesh(new THREE.RingGeometry(pl.R - 0.035, pl.R + 0.035, 256),
      orbitMat(0.42 - pl.R / 26 * 0.14));
    ring.rotation.x = -Math.PI / 2;
    scene.add(ring);
    if ((p.showPlanets ?? 255) & (1 << PLANETS.indexOf(pl))) {
      const pt = await tex('assets/space/textures/' + (pl.hero ? (pl.heroTex ?? pl.tex) : pl.tex));
      const bodyMat = new THREE.MeshStandardMaterial({ map: pt,
        roughness: pl.sheen ? 0.8 : 0.95, metalness: 0,          // 气态行星柔和高光=高级感
        color: pl.hero ? 0xdceaff : 0xffffff,
        emissive: pl.hero ? 0x6a86c8 : 0x8a97b8, emissiveMap: pt,
        emissiveIntensity: pl.hero ? 0.2 : 0.16 });               // 自发光降档：晨昏线显形=立体
      if (pl.bump) { bodyMat.bumpMap = pt; bodyMat.bumpScale = 0.4; }   // 岩质行星凹凸 relief
      const body = new THREE.Mesh(new THREE.SphereGeometry(pl.r, pl.hero ? 96 : 48, pl.hero ? 96 : 48),
        bodyMat);
      const grp = new THREE.Group();
      body.rotation.z = pl.tilt;
      grp.add(body);
      let clouds = null, atmU = null;
      if (pl.hero) {
        // （夜灯层按主人 2026-09-03 裁决移除：纯蓝色弹珠地球更大众审美）
        // 云层 + 大气边缘光（菲涅尔）
        const cloudsT = await tex('assets/space/textures/2k_earth_clouds.jpg');
        clouds = new THREE.Mesh(new THREE.SphereGeometry(pl.r * 1.02, 96, 96),
          new THREE.MeshStandardMaterial({ alphaMap: cloudsT, transparent: true,
            roughness: 1, metalness: 0, depthWrite: false }));
        grp.add(clouds);
        const atmMat = new THREE.ShaderMaterial({
          uniforms: { uColor: { value: new THREE.Color(0.45, 0.7, 1.0) } },
          vertexShader:
            'varying vec3 vN; varying vec3 vW;' +
            'void main(){ vN = normalize(normalMatrix * normal);' +
            '  vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;' +
            '  gl_Position = projectionMatrix * viewMatrix * w; }',
          fragmentShader:
            'uniform vec3 uColor; varying vec3 vN; varying vec3 vW;' +
            'void main(){ vec3 V = normalize(cameraPosition - vW);' +
            '  float f = pow(1.0 - abs(dot(normalize(vN), V)), 2.2);' +
            '  gl_FragColor = vec4(uColor * f * 1.6, f); }',
          transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
          side: THREE.BackSide });
        grp.add(new THREE.Mesh(new THREE.SphereGeometry(pl.r * 1.12, 96, 96), atmMat));
      }
      if (!pl.hero && pl.atm) {
        // 菲涅尔大气边缘光（非 hero 行星的高级感标配；近距掠过时 uBoost 增亮「苏醒」）
        const [ar, ag, ab, astr] = pl.atm;
        const aMat = new THREE.ShaderMaterial({
          uniforms: { uColor: { value: new THREE.Color(ar, ag, ab) },
                      uBoost: { value: 1 }, uStr: { value: astr } },
          vertexShader:
            'varying vec3 vN; varying vec3 vW;' +
            'void main(){ vN = normalize(normalMatrix * normal);' +
            '  vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;' +
            '  gl_Position = projectionMatrix * viewMatrix * w; }',
          fragmentShader:
            'uniform vec3 uColor; uniform float uBoost; uniform float uStr;' +
            'varying vec3 vN; varying vec3 vW;' +
            'void main(){ vec3 V = normalize(cameraPosition - vW);' +
            '  float f = pow(1.0 - abs(dot(normalize(vN), V)), 2.4);' +
            '  gl_FragColor = vec4(uColor * f * 1.5 * uStr * uBoost, f * uStr * uBoost); }',
          transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
          side: THREE.BackSide });
        grp.add(new THREE.Mesh(new THREE.SphereGeometry(pl.r * 1.1, 48, 48), aMat));
        atmU = aMat.uniforms;
      }
      if (pl.ring) {
        // 程序化土星环（主人 2026-09-04 裁决：旧 12KB 贴图+Standard 弱光=黑团，太丑）：
        // 1024² 逐像素同心环带——C 薄纱→B 亮主环→卡西尼缝→A 环→恩克缝，细纹 striation；
        // RingGeometry 平面 UV=同心圆直贴；自发光贴图=任何光照角度环都在（背光面不再消失）
        const RC = document.createElement('canvas'); RC.width = RC.height = 1024;
        const rc2 = RC.getContext('2d');
        const img = rc2.createImageData(1024, 1024);
        const d = img.data;
        const RIN = 512 * (1.24 / 2.3);                  // 环内缘在贴图上的半径
        const segs = [   // [u起, u止, 亮度, 不透明度]（u: 0=内缘 1=外缘）
          [0.00, 0.13, 0.42, 0.30],   // C 环（薄纱）
          [0.15, 0.55, 1.00, 0.98],   // B 环（最亮最密）
          [0.55, 0.63, 0.10, 0.16],   // 卡西尼缝
          [0.64, 0.85, 0.74, 0.84],   // A 环
          [0.85, 0.885, 0.16, 0.22],  // 恩克缝
          [0.90, 0.97, 0.56, 0.60],   // A 外环
          [0.97, 1.00, 0.30, 0.22],   // 外缘渐薄
        ];
        const lat = new Float32Array(512).map(() => rnd());   // 1D 值噪声晶格（复用场景种子）
        const n1 = (x) => { const i = Math.floor(x) % 511, f = x - Math.floor(x), w = f * f * (3 - 2 * f);
                            return lat[i] * (1 - w) + lat[i + 1] * w; };
        const prof = (u) => {
          for (const [u0, u1, l, o] of segs) if (u >= u0 && u <= u1) {
            const f = (u - u0) / (u1 - u0);
            const soft = Math.min(1, Math.min(f, 1 - f) * 3 + 0.25);
            return [l * soft, o * soft];
          }
          return [0.05, 0.05];   // 段间缝隙兜底
        };
        for (let y = 0; y < 1024; y++) {
          const dy = y - 511.5;
          for (let x = 0; x < 1024; x++) {
            const dx = x - 511.5;
            const idx = (y * 1024 + x) * 4;
            const u = (Math.sqrt(dx * dx + dy * dy) - RIN) / (512 - RIN);
            if (u < 0 || u > 1) { d[idx + 3] = 0; continue; }
            const [l0, o0] = prof(u);
            const lum = l0 * (0.82 + 0.26 * n1(u * 130) + 0.08 * n1(u * 410));   // 细纹
            const op = o0 * (0.9 + 0.1 * n1(u * 210)) * Math.min(1, Math.min(u, 1 - u) * 18);   // 内外缘软出
            const warm = 0.92 + 0.08 * n1(u * 60);
            d[idx]     = Math.min(255, 255 * lum);
            d[idx + 1] = Math.min(255, 255 * lum * 0.93 * warm);
            d[idx + 2] = Math.min(255, 255 * lum * 0.80 * warm);
            d[idx + 3] = Math.round(255 * Math.max(0, Math.min(1, op)));
          }
        }
        rc2.putImageData(img, 0, 0);
        const ringT2 = new THREE.CanvasTexture(RC);
        ringT2.colorSpace = THREE.SRGBColorSpace; ringT2.anisotropy = 8;
        const sr = new THREE.Mesh(new THREE.RingGeometry(pl.r * 1.24, pl.r * 2.3, 128, 1),
          new THREE.MeshBasicMaterial({ map: ringT2, transparent: true,
            side: THREE.DoubleSide, depthWrite: false }));
        sr.rotation.x = Math.PI / 2 - 0.1; sr.rotation.y = pl.tilt;
        sr.renderOrder = 1;
        grp.add(sr);
      }
      scene.add(grp);
      bodyGrps[pl.n] = grp;
      const speed = 0.045 * Math.pow(7 / pl.R, J.orbitPow ?? 1.2);   // 开普勒感：内快外慢（1.2=外行星也明显）
      planetMakers.push({ grp, pl, speed, body, clouds, atmU });
    }
  }
  const launchGrp = bodyGrps[J.launchBody] ?? null;   // 起飞段视线锚（缺省地球）

  // （太阳风粒子/流线已按主人 2026-09-03 裁决移除：呈现显脏。太阳风的存在交由日球层顶气泡表达——气泡即风的疆域）
  // —— 日球层顶气泡（菲涅尔边缘光 + 穿越涟漪：波从穿越点扩散，非全屏增亮）——
  // 近景星点视差层：相机运动的纵深参照（宇宙的「大」）
  const NEAR_N = 1400;
  const nPos = new Float32Array(NEAR_N * 3);
  for (let i = 0; i < NEAR_N; i++) {
    const r = 60 + rnd() * 80;
    const th = rnd() * Math.PI * 2, ph = Math.acos(2 * rnd() - 1);
    nPos[i * 3] = r * Math.sin(ph) * Math.cos(th);
    nPos[i * 3 + 1] = r * Math.cos(ph) * 0.6;
    nPos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
  }
  const nearStars = new THREE.Points(
    (() => { const g = new THREE.BufferGeometry();
             g.setAttribute('position', new THREE.BufferAttribute(nPos, 3)); return g; })(),
    new THREE.PointsMaterial({ color: 0xdce9fb, size: 0.55, sizeAttenuation: true,
      transparent: true, opacity: 1.0, depthWrite: false }));
  scene.add(nearStars);

  // 真实穿越点：轨迹×椭球面数值求交（实测在轨迹定义后，见下）
  let CROSS_POS = new THREE.Vector3(31.0, 16.0, 31.0), CROSS_TK = 0.91;
  let helioMat = null;
  if (J.membrane) {
    helioMat = new THREE.ShaderMaterial({
      uniforms: { uCross: { value: 0 }, uCrossAge: { value: 99 }, uCrossPos: { value: CROSS_POS }, uTime: { value: 0 },
                  uColor: { value: new THREE.Color(...J.membrane.color) } },
    vertexShader:
      'varying vec3 vN; varying vec3 vW;' +
      'void main(){ vN = normalize(normalMatrix * normal);' +
      '  vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;' +
      '  gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader:
      'uniform vec3 uColor; uniform float uCross; uniform float uCrossAge; uniform vec3 uCrossPos;' +
      'varying vec3 vN; varying vec3 vW;' +
      'uniform float uTime;' +
      'void main(){' +
      '  vec3 V = normalize(cameraPosition - vW);' +
      '  float f = pow(1.0 - abs(dot(normalize(vN), V)), 2.0);' +
      '  float wave = 0.95 + 0.05 * sin(vW.x * 0.35 + uTime * 0.35) * sin(vW.y * 0.42 - uTime * 0.25) * sin(vW.z * 0.31 + uTime * 0.3);' +
      '  float glow = f * 0.7 * wave + 0.012;' +                    // 壳存在感：轮廓亮 + 底噪微光
      '  float d = length(vW - uCrossPos);' +
      '  float ripple = uCross * exp(-d * d / 90.0) * 1.2;' + // 穿越局部增亮
      '  float ringR = uCrossAge * 14.0;' +                   // 冲击波环：半径随龄扩散
      '  float ringW = 1.6 + uCrossAge * 2.2;' +
      '  float ringFade = exp(-uCrossAge * 0.8);' +
      '  float ring = exp(-pow((d - ringR) / ringW, 2.0)) * ringFade * 2.8;' +
      '  glow += ripple + ring;' +
      '  gl_FragColor = vec4(uColor * glow, clamp(glow, 0.0, 1.0) * 0.85);' +
      '}',
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide });
    const helio = new THREE.Mesh(new THREE.SphereGeometry(HELIO_R, 96, 96), helioMat);
    helio.renderOrder = 3;
    helio.scale.set(...J.membrane.scale);      // 略椭：出射方向拉长
    scene.add(helio);
  }

  // —— 探测器轨迹（控制点全部走 params；缺省=过土星后北出黄道面的 V1 真实出射姿态）——
  const trajPts = J.trajectory.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const trajCurve = new THREE.CatmullRomCurve3(trajPts, false, 'centripetal', 0.5);
  // 真实穿越点求交（拍脑袋控制点远在气泡外=前版冲击波环不可见根因）
  const _helioR = (v) => {   // 椭球面上归一化距离：<1 在内部
    const [, sy, sz] = J.membrane ? J.membrane.scale : [1, 1, 1];
    const nx = v.x / HELIO_R, ny = v.y / (HELIO_R * sy), nz = v.z / (HELIO_R * sz);
    return Math.sqrt(nx * nx + ny * ny + nz * nz);
  };
  if (J.membrane) {
    let prev = null;
    for (let i = 1; i <= 400; i++) {
      const k = i / 400;
      const pt = trajCurve.getPoint(k);
      const rn = _helioR(pt);
      if (prev && prev.rn < 1 && rn >= 1) {   // 从内到外穿越
        const u = (1 - prev.rn) / (rn - prev.rn);
        CROSS_TK = prev.k + (k - prev.k) * u;
        CROSS_POS = trajCurve.getPoint(CROSS_TK).clone();
        break;
      }
      prev = { k, rn };
    }
  } else {
    CROSS_TK = 1; CROSS_POS = trajCurve.getPoint(1).clone();   // 无膜场景：事件点=轨迹终点
  }
  if (helioMat) helioMat.uniforms.uCrossPos.value = CROSS_POS;
  const traj = new THREE.Mesh(
    new THREE.TubeGeometry(trajCurve, 320, 0.035, 8, false),
    new THREE.MeshBasicMaterial({ color: 0xffc46b, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false }));
  traj.renderOrder = 2;
  scene.add(traj);
  // 轨迹辉光套管（更粗更淡，光晕感）
  const trajGlow = new THREE.Mesh(
    new THREE.TubeGeometry(trajCurve, 320, 0.09, 8, false),
    new THREE.MeshBasicMaterial({ color: 0xff9c4b, transparent: true, opacity: 0.12,
      blending: THREE.AdditiveBlending, depthWrite: false }));
  trajGlow.renderOrder = 2;
  scene.add(trajGlow);
  // （热端笔尖已按主人 2026-09-03 裁决移除：轨迹前端变粗+30fps 频闪）
  const TRAJ_IDX = traj.geometry.index.count;   // 生长：drawRange 随光点推进
  // （anamorphic 水平光晕已按主人 2026-09-03 裁决移除：贴图垂直方向无 falloff，
  //   显形时是硬边长方形而非柔和光带；且属装饰无岗位——设计感元素判例第五杀）
  // 光点 + 脉冲环 + 拖尾
  const dotCv = document.createElement('canvas'); dotCv.width = dotCv.height = 64;
  const dg = dotCv.getContext('2d');
  const dgr = dg.createRadialGradient(32, 32, 1, 32, 32, 32);
  dgr.addColorStop(0, 'rgba(255,255,255,1)'); dgr.addColorStop(0.12, 'rgba(210,235,255,0.95)');
  dgr.addColorStop(0.3, 'rgba(140,200,255,0.28)'); dgr.addColorStop(1, 'rgba(120,200,255,0)');
  dg.fillStyle = dgr; dg.fillRect(0, 0, 64, 64);
  const dotTex = new THREE.CanvasTexture(dotCv);
  // 旅行者飞船本体（简化版）：高增益天线白锅+十边机身+RTG 长杆+金色唱片
  const craft = new THREE.Group();
  const dishM = new THREE.Mesh(new THREE.SphereGeometry(0.55, 32, 16, 0, Math.PI * 2, 0, 0.62),
    new THREE.MeshStandardMaterial({ color: 0xd8d4c8, roughness: 0.6, metalness: 0.35, side: THREE.DoubleSide, emissive: 0x9a9484, emissiveIntensity: 0.3 }));
  dishM.rotation.x = Math.PI / 2; craft.add(dishM);
  const busM = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.35, 10),
    new THREE.MeshStandardMaterial({ color: 0x2a2a30, roughness: 0.8, metalness: 0.4, emissive: 0x44444c, emissiveIntensity: 0.35 }));
  busM.position.y = -0.3; craft.add(busM);
  const boomM = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.5, 6),
    new THREE.MeshStandardMaterial({ color: 0x8a8a92, roughness: 0.5, metalness: 0.6 }));
  boomM.rotation.z = Math.PI / 2.3; boomM.position.set(-0.55, -0.5, 0); craft.add(boomM);
  const rtgM = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.45, 8),
    new THREE.MeshStandardMaterial({ color: 0x5a5a60, roughness: 0.7, metalness: 0.5 }));
  rtgM.rotation.z = Math.PI / 2.3; rtgM.position.set(-1.15, -0.85, 0); craft.add(rtgM);
  const recordM = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.015, 24),
    new THREE.MeshStandardMaterial({ color: 0xd8a832, roughness: 0.25, metalness: 0.9, emissive: 0x8a6420, emissiveIntensity: 0.45 }));
  recordM.rotation.x = Math.PI / 2; recordM.position.set(0.05, -0.18, 0.22); craft.add(recordM);
  craft.renderOrder = 1;
  scene.add(craft);
  const dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex,
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  dot.renderOrder = 4;
  dot.scale.set(1.4, 1.4, 1); scene.add(dot);
  const TRAIL = 22;
  const trail = [];
  for (let i = 0; i < TRAIL; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
      opacity: 0.20 * (1 - i / TRAIL) }));
    sp.scale.set(0.22 * (1 - i / TRAIL) + 0.06, 0.22 * (1 - i / TRAIL) + 0.06, 1);
    sp.renderOrder = 4; scene.add(sp); trail.push(sp);
  }
  const flashCv = document.createElement('canvas'); flashCv.width = flashCv.height = 64;
  const fg = flashCv.getContext('2d');
  const fgr = fg.createRadialGradient(32, 32, 1, 32, 32, 32);
  fgr.addColorStop(0, 'rgba(255,255,255,1)'); fgr.addColorStop(0.25, 'rgba(255,255,255,0.7)');
  fgr.addColorStop(1, 'rgba(255,255,255,0)');
  fg.fillStyle = fgr; fg.fillRect(0, 0, 64, 64);
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(flashCv),
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
  flash.renderOrder = 5;
  flash.scale.set(6, 6, 1); scene.add(flash);
  // （跟随光点的白色脉冲环已按主人 2026-09-03 裁决移除：人工设计感=不真实）

  // —— 时间编排 ——
  const TRAVEL = (p.travelMs ?? CFG.duration * 1000) / 1000;
  const CROSS_K = p.crossK ?? CROSS_TK;   // 实测轨迹-气泡交点
  // 机位关键帧走 params；缺省四幕：近地起飞 → 离肩 → 全景一眼太阳系 → 跟随穿越 → 拉远气泡里的家
  const CAM_KEYS = J.camKeys;
  const camLerp = (k) => {
    let i = 0;
    while (i < CAM_KEYS.length - 2 && k > CAM_KEYS[i + 1][0]) i++;
    const [k0, p0, l0] = CAM_KEYS[i], [k1, p1, l1] = CAM_KEYS[i + 1];
    const u = smooth((k - k0) / (k1 - k0));
    return [[p0[0] + (p1[0] - p0[0]) * u, p0[1] + (p1[1] - p0[1]) * u, p0[2] + (p1[2] - p0[2]) * u],
            [l0[0] + (l1[0] - l0[0]) * u, l0[1] + (l1[1] - l0[1]) * u, l0[2] + (l1[2] - l0[2]) * u]];
  };
  const [PK0, PK1, PK2, PK3, PK4] = J.phaseK;      // 五相边界：起飞锚/渐释/过渡带/混合锚/穿越锚
  const [OLX, OLY, OLZ] = J.lookout;               // 渐释终点
  const [FAX, FAY, FAZ] = J.finalAnchor;           // 收尾锚

  return (t) => {
    const k = p.camK ?? clamp01(t / CFG.duration);
    // 探测器：全程沿轨迹飞行（样张 camK 模式下也推进）
    // tk = 慢启动幂曲线 + 弹弓修正：借力点附近局部提速（单调，drawRange 与光点同函数天然同步）
    const tkBase = Math.pow(clamp01(t / TRAVEL), J.speed.pow);
    let slingshot = 0;
    for (const s of J.speed.slingshots)
      slingshot += s.amp * Math.exp(-Math.pow((tkBase - s.at) / s.width, 2)) * (tkBase - s.at);
    const tk = (tkBase + slingshot) * J.speed.gain;
    const pos = trajCurve.getPoint(clamp01(tk));
    dot.position.copy(pos);
    const camDistSafe = () => camera.position.distanceTo(pos);
    // 光点屏幕尺寸恒定：相机近时收小（近景 sprite 变光团=不真实感根因）
    const camDist = camera.position.distanceTo(pos);
    // 近景飞船 ↔ 远景光点：camDist 10–16 互补过渡（闪变判例：杜绝「大亮点跳小亮点」）
    const blend = smooth((camDistSafe() - 10) / 6);
    const craftVis = 1 - blend;
    craft.visible = craftVis > 0.02;
    if (craft.visible) {
      craft.position.copy(pos);
      const ahead = trajCurve.getPoint(clamp01(tk + 0.01));
      craft.lookAt(ahead);
      craft.rotateY(2.1);            // 侧后向对相机：天线大锅侧影+金色唱片面可见（原背对=灰球判例）
      craft.rotateX(0.35);
      const cs = 0.85 * (0.5 + 0.5 * craftVis);
      craft.scale.set(cs, cs, cs);
      craft.traverse((o) => { if (o.material) { o.material.transparent = true; o.material.opacity = craftVis; } });
    }
    // 穿越瞬间一次闪光（无常态脉动——光点保持干净）
    const crossT = TRAVEL * Math.pow(CROSS_K / J.speed.gain, 1 / J.speed.pow);
    const cw = Math.exp(-Math.pow((t - crossT) / 1.1, 2));
    let dotBase = 0.7;                       // 世界尺寸固定：离地球越远越小=真实透视（主人 2026-09-03 裁决）
    if (k > 0.94) dotBase *= 1 - 0.6 * smooth((k - 0.94) / 0.06);   // 融入星场
    dot.material.opacity = blend;            // 近景藏光点（飞船接管），远景显出
    dot.scale.set(dotBase * (1 + cw * 2.2), dotBase * (1 + cw * 2.2), 1);
    flash.position.copy(pos);
    flash.material.opacity = cw * 0.75;
    flash.scale.set(4 + 5 * (1 - cw), 4 + 5 * (1 - cw), 1);
    const shown = Math.floor(clamp01(tk) * TRAJ_IDX);   // 轨迹飞到哪长到哪
    traj.geometry.setDrawRange(0, shown);
    trajGlow.geometry.setDrawRange(0, shown);
    const trailGate = smooth((t - 1.5) / 6);   // 起飞低速段拖尾渐隐
    for (let i = 0; i < TRAIL; i++) {
      const bk = clamp01(tk - 0.012 * (i + 1));
      trail[i].position.copy(trajCurve.getPoint(bk));
      trail[i].material.opacity = 0.20 * (1 - i / TRAIL) * trailGate;
    }
    helioMat && (helioMat.uniforms.uCross.value = cw);
    helioMat && (helioMat.uniforms.uTime.value = t);
    helioMat && (helioMat.uniforms.uCrossAge.value = t > crossT ? t - crossT : 99.0);
    // 行星公转（orbitGain 增益，开普勒感内快外慢）+ 自转差速（每体 rot，金星逆转）
    // + 云层漂动 + 经过增亮（旅行者经过时行星提亮，大气壳同步「苏醒」）
    for (const { grp, pl, speed, body, clouds, atmU } of planetMakers) {
      const a = pl.a0 + t * speed * (J.orbitGain ?? 1);
      grp.position.set(pl.R * Math.cos(a), 0, pl.R * Math.sin(a));
      body.rotation.y = t * (pl.rot ?? 0.15);
      if (clouds) clouds.rotation.y = t * (pl.rot ?? 0.15) * 1.12 + 0.3;   // 云层略快于本体=风
      const dx = grp.position.x - pos.x, dy = grp.position.y - pos.y, dz = grp.position.z - pos.z;
      const near = Math.exp(-(dx * dx + dy * dy + dz * dz) / 30);
      body.material.emissiveIntensity = (pl.hero ? 0.2 : 0.16) + 0.4 * near;
      if (atmU) atmU.uBoost.value = 1 + 1.3 * near;
    }
    sun.rotation.y = t * 0.05;
    // 太阳燃烧脉动：shader 时间推进 + 辉光呼吸 + 点光微闪烁
    if (sunMat) {
      sunMat.uniforms.uTime.value = t;
      const gbA = 1 + 0.05 * burn * Math.sin(t * 1.9);
      const gbB = 1 + 0.035 * burn * Math.sin(t * 1.3 + 2.1);
      glowA.scale.set(SUN_R * 3.6 * gbA, SUN_R * 3.6 * gbA, 1);
      glowB.scale.set(SUN_R * 6.5 * gbB, SUN_R * 6.5 * gbB, 1);
      sunLight.intensity = 4.2 * (1 + 0.05 * burn * (0.6 * Math.sin(t * 2.3) + 0.4 * Math.sin(t * 3.7 + 1.3)));
    }
    // 相机：位置按关键帧；视线分相——全景锚太阳系 / 跟随锚光点 / 拉远渐释全局
    const [cp] = camLerp(k);
    // （相机穿越微震已按主人 2026-09-03 裁决移除：幌。冲击由冲击波环承担）
    camera.position.set(cp[0], cp[1], cp[2]);
    let lx, ly, lz;
    if (k < PK0 && launchGrp) {
      // 起飞段：出发星为主、视线向飞船出发侧偏 35%（看清飞船从母星边上出发）
      lx = launchGrp.position.x + (pos.x - launchGrp.position.x) * 0.35;
      ly = launchGrp.position.y + 0.1 + (pos.y - launchGrp.position.y) * 0.35;
      lz = launchGrp.position.z + (pos.z - launchGrp.position.z) * 0.35;
    } else if (k < PK1 && launchGrp) {
      // 出发星(含 35% 偏移)→lookout 渐释（起点与起飞段终点连续=切相不闪判例）
      const ex = launchGrp.position.x + (pos.x - launchGrp.position.x) * 0.35;
      const ey = launchGrp.position.y + 0.1 + (pos.y - launchGrp.position.y) * 0.35;
      const ez = launchGrp.position.z + (pos.z - launchGrp.position.z) * 0.35;
      const u = smooth((k - PK0) / (PK1 - PK0));
      lx = ex + (OLX - ex) * u; ly = ey + (OLY - ey) * u; lz = ez + (OLZ - ez) * u;
    } else if (k < PK2) {
      // 渐释终点→混合锚过渡带（切换跳变=第二次闪判例，过渡带宽度=PK2-PK1）
      const u = smooth((k - PK1) / (PK2 - PK1));
      lx = OLX + (pos.x * 0.55 - OLX) * u;
      ly = OLY + (pos.y * 0.55 + 0.9 - OLY) * u;
      lz = OLZ + (pos.z * 0.55 - OLZ) * u;
    } else if (k < PK3) {
      // 混合锚：光点 0.55 + 星系中心 0.45——船/家/边界三者同框，不丢参照系
      lx = pos.x * 0.55; ly = pos.y * 0.55 + 0.9; lz = pos.z * 0.55;
    } else if (k < PK4) {
      // 穿越段：锚定真实穿越点——高潮必在画面中心
      const u = smooth((k - PK3) / 0.05);
      lx = (pos.x * 0.55) + (CROSS_POS.x - pos.x * 0.55) * u;
      ly = (pos.y * 0.55 + 0.9) + (CROSS_POS.y - pos.y * 0.55 - 0.9) * u;
      lz = (pos.z * 0.55) + (CROSS_POS.z - pos.z * 0.55) * u;
    } else {
      // 拉远全局收尾：从穿越点缓释到 finalAnchor（「气泡里的家」全景）
      const u = smooth((k - PK4) / (1 - PK4));
      lx = CROSS_POS.x + (FAX - CROSS_POS.x) * u;
      ly = CROSS_POS.y + (FAY - CROSS_POS.y) * u;
      lz = CROSS_POS.z + (FAZ - CROSS_POS.z) * u;
    }
    camera.lookAt(lx, ly, lz);
  };
}

// —— 华山太阳实验（谜面地图 EP1 S2）：真实 DEM 地形 + 太阳一日轨迹 ——
// 叙事：相机从高空降到山脊延长线上，亲眼看太阳东升→南中天→西斜，
//       南坡始终受光、北坡始终背阴 → 「山南曰阳」不是定义，是看见的事实。
// 2026-09-04 v2 真实感升级：z15 DEM（~4m/px）+ z16 Esri 纹理（~2m/px）+
//       PCFSoft 真实投影（北坡真的躺在山体阴影里）+ FogExp2 大气透视 + 主峰对中。
async function buildHuashanSun(p) {
  const base = p.base;
  if (!base) throw new Error('huashan_sun: params.base 必填（fetch_terrain_block 产物目录，服务器相对路径）');
  const meta = await (await fetch('/' + base + '/meta.json')).json();
  const buf = await (await fetch('/' + base + '/heights.f32')).arrayBuffer();
  const HG = new Float32Array(buf);
  const texT = await tex(base + '/surface.jpg');
  texT.anisotropy = 16;

  const KM_LAT = 110.6;
  const KM_LON = 111.3 * Math.cos(((meta.latNorth + meta.latSouth) / 2) * Math.PI / 180);
  const spanX = (meta.lonEast - meta.lonWest) * KM_LON;
  const spanZ = (meta.latNorth - meta.latSouth) * KM_LAT;
  const EXAG = p.exaggeration ?? 1.6;
  const FLOOR_Y = 0.5;
  const STEP = p.step ?? 2;
  const gc = Math.floor(meta.cols / STEP), gr = Math.floor(meta.rows / STEP);

  // 主峰对中：相机曲线沿旧窗调参（峰≈原点），新窗按经纬度反算峰位并整体平移地形
  const pk = (meta.landmarks && meta.landmarks.peak) || { lon: 110.0899, lat: 34.4883 };
  const pkX = ((pk.lon - meta.lonWest) / (meta.lonEast - meta.lonWest) - 0.5) * spanX;
  const pkZ = -((pk.lat - (meta.latNorth + meta.latSouth) / 2) / (meta.latNorth - meta.latSouth)) * spanZ;

  const geo = new THREE.PlaneGeometry(spanX, spanZ, gc - 1, gr - 1);
  geo.rotateX(-Math.PI / 2);                    // 躺平：+x 东，-z 北，+y 高
  const pos = geo.attributes.position;
  for (let r = 0; r < gr; r++)
    for (let c = 0; c < gc; c++)
      pos.setY(r * gc + c, HG[(r * STEP) * meta.cols + c * STEP] / 1000 * EXAG);
  // 裙边：边界顶点外推 30% 并压到地面高，UV 同步外扩（ClampToEdge 边缘色自然延伸，无拉伸条纹）
  const uv = geo.attributes.uv;
  for (let r = 0; r < gr; r++)
    for (let c = 0; c < gc; c++) {
      if (r > 1 && r < gr - 2 && c > 1 && c < gc - 2) continue;
      const i = r * gc + c;
      pos.setX(i, pos.getX(i) * 1.3);
      pos.setZ(i, pos.getZ(i) * 1.3);
      pos.setY(i, FLOOR_Y + 0.02);
      uv.setXY(i, (uv.getX(i) - 0.5) * 1.3 + 0.5, (uv.getY(i) - 0.5) * 1.3 + 0.5);
    }
  geo.computeVertexNormals();
  const terrainMesh = new THREE.Mesh(geo,
    new THREE.MeshStandardMaterial({ map: texT, roughness: 1, metalness: 0 }));
  terrainMesh.position.set(-pkX, 0, -pkZ);       // 主峰平移到原点（相机曲线基准）
  terrainMesh.castShadow = true;
  terrainMesh.receiveShadow = true;
  scene.add(terrainMesh);

  // 无限地面延伸（卫星图 repeat 铺地，雾中平原观感，防「悬浮岛」穿帮）
  const floorTex = texT.clone();
  floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
  floorTex.repeat.set(5, 5);
  floorTex.needsUpdate = true;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(240, 240),
    new THREE.MeshStandardMaterial({ map: floorTex, color: 0xb0b4a8, roughness: 1, metalness: 0 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = FLOOR_Y;
  floor.receiveShadow = true;
  scene.add(floor);

  const groundY = (x, z) => {                   // 场景坐标（已对中）→ exaggerated 地面高（双线性）
    x += pkX; z += pkZ;
    const c = clamp01((x / spanX + 0.5)) * (meta.cols - 1);
    const r = clamp01((z / spanZ + 0.5)) * (meta.rows - 1);
    const c0 = Math.floor(c), r0 = Math.floor(r);
    const c1 = Math.min(meta.cols - 1, c0 + 1), r1 = Math.min(meta.rows - 1, r0 + 1);
    const fc = c - c0, fr = r - r0;
    const h = HG[r0 * meta.cols + c0] * (1 - fc) * (1 - fr) + HG[r0 * meta.cols + c1] * fc * (1 - fr)
            + HG[r1 * meta.cols + c0] * (1 - fc) * fr + HG[r1 * meta.cols + c1] * fc * fr;
    return h / 1000 * EXAG;
  };

  // 天空：equirect 全景渐变（3D 世界一部分，相机俯仰正确跟随；地平线=雾色无缝）
  const skyCv = document.createElement('canvas');
  skyCv.width = 1024; skyCv.height = 512;
  const sg = skyCv.getContext('2d');
  const grad = sg.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#16283f'); grad.addColorStop(0.28, '#1c3350');
  grad.addColorStop(0.42, '#5d7fa4'); grad.addColorStop(0.485, '#93a8b6');
  grad.addColorStop(0.5, '#acb9c4'); grad.addColorStop(0.52, '#a2aeb8');
  grad.addColorStop(0.7, '#8a8e82'); grad.addColorStop(1, '#6a6e62');
  sg.fillStyle = grad; sg.fillRect(0, 0, 1024, 512);
  const skyTex = new THREE.CanvasTexture(skyCv);
  skyTex.colorSpace = THREE.SRGBColorSpace;
  skyTex.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = skyTex;
  scene.fog = new THREE.FogExp2(0xacb9c4, 0.055);   // 大气透视：远山蓝灰退晕

  // 光照：暖阳光（真实投影）+ 冷环境（暗面可读，手册 §五.10）
  const sun = new THREE.DirectionalLight(0xfff2d8, 4.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const sc = sun.shadow.camera;
  sc.left = -10; sc.right = 10; sc.top = 10; sc.bottom = -10;
  sc.near = 0.5; sc.far = 40;
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.02;
  scene.add(sun); scene.add(sun.target);
  scene.add(new THREE.AmbientLight(0x40536e, 0.95));

  // 太阳视觉：核心 + 光晕 sprite（与 DirectionalLight 同位）
  const sunCv = document.createElement('canvas');
  sunCv.width = sunCv.height = 256;
  const s2 = sunCv.getContext('2d');
  const rg = s2.createRadialGradient(128, 128, 4, 128, 128, 128);
  rg.addColorStop(0, 'rgba(255,252,240,1)'); rg.addColorStop(0.05, 'rgba(255,244,214,0.98)');
  rg.addColorStop(0.14, 'rgba(255,226,160,0.5)'); rg.addColorStop(0.38, 'rgba(255,208,130,0.12)');
  rg.addColorStop(1, 'rgba(255,200,120,0)');
  s2.fillStyle = rg; s2.fillRect(0, 0, 256, 256);
  const sunSpr = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(sunCv), blending: THREE.AdditiveBlending,
    depthWrite: false, transparent: true, opacity: 0.9 }));
  sunSpr.scale.set(7.5, 7.5, 1);
  scene.add(sunSpr);

  // 太阳一日轨迹（t_sun∈[0,1]：东→南→西）；冻结点 0.8（西南金光，不收黑）
  // 冬日太阳（正午仰角 33°）：斜射让北坡阴影更厚，且太阳全程在画面内
  const SUN_R = 11;                              // 视觉半径（km）
  const SUN_OFF = new THREE.Vector3(-1.5, 0, 3.5); // 弧/太阳整体南移偏西：轨迹在演示构图的天区居中
  const sunPosAt = (u) => {
    const az = (90 + 180 * u) * Math.PI / 180;   // 90=东 180=南 270=西
    const el = 33 * Math.sin(Math.PI * Math.min(1, u * 1.18)) * Math.PI / 180;
    return new THREE.Vector3(SUN_R * Math.cos(el) * Math.sin(az),
                             SUN_R * Math.sin(el) + 1.2,
                             -SUN_R * Math.cos(el) * Math.cos(az)).add(SUN_OFF);
  };
  // 轨迹虚线弧（叙事本体：让观众预判太阳要走的路）
  const arcPts = [];
  for (let i = 0; i <= 96; i++) arcPts.push(sunPosAt(i / 96 * 0.82));
  const arcGeo = new THREE.BufferGeometry().setFromPoints(arcPts);
  const arc = new THREE.Line(arcGeo, new THREE.LineDashedMaterial({
    color: 0xffe9b8, dashSize: 0.55, gapSize: 0.35, transparent: true, opacity: 0.9 }));
  arc.computeLineDistances();
  scene.add(arc);

  // 相机：开场东南高空 → 降到东北低位「阴面站位」（面前北坡背光，南天在画面上方，
  //       太阳全程可见，山脊亮边=对面南坡的光）→ 翻越山脊 → 南坡金光定格。
  //       「站在阴面看阳，翻过去成为阳」——镜头运动即论点。防抖照抄 jilong 判例。
  const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
  const camCurve = new THREE.CatmullRomCurve3([
    V([4.5, 2.8, 5.5]), V([8.0, 2.3, -1.0]), V([8.6, 2.0, -1.8]),
    V([8.3, 2.1, -2.0]), V([7.5, 2.5, -1.5]), V([5.5, 5.5, 3.0]), V([2.0, 3.4, 7.5]),
  ], false, 'centripetal');
  const lookCurve = new THREE.CatmullRomCurve3([
    V([0, 3.0, 0]), V([-1.0, 3.2, 0.5]), V([-1.5, 3.5, 1.5]),
    V([-1.5, 3.6, 1.5]), V([-1.2, 3.3, 1.0]), V([0, 2.6, 0]), V([0, 3.2, -0.5]),
  ], false, 'centripetal');

  const N = 512;
  const camPts = [];
  for (let i = 0; i <= N; i++) camPts.push(camCurve.getPointAt(i / N));
  for (const q of camPts) q.y = Math.max(q.y, groundY(q.x, q.z) + 2.2);
  const ys = camPts.map(q => q.y);
  for (let i = 0; i <= N; i++) {
    let s = 0, c = 0;
    for (let j = -14; j <= 14; j++) { const q = Math.min(N, Math.max(0, i + j)); s += ys[q]; c++; }
    camPts[i].y = s / c;
  }

  camera.fov = p.camFov ?? 54;
  camera.far = 120;
  camera.updateProjectionMatrix();

  const T = CFG.duration;
  return (t) => {
    const k = clamp01(t / T);
    // 相机全程匀速沿曲线（k 直接映射，曲线参数即节奏）
    const cp = camPts[Math.min(N, Math.round(k * N))];
    camera.position.copy(cp);
    // 太阳时间：前 18% 清晨静候 → 演示到 78% → 冻结在下午阳光位（南坡全亮）
    const ts = k < 0.18 ? 0.06 : Math.min(0.65, 0.06 + (k - 0.18) / 0.60 * 0.59);
    const sp = sunPosAt(ts);
    sun.position.copy(sp);
    sunSpr.position.copy(sp);
    // 「看一眼太阳」叙事：演示段视线向南天太阳方向偏航（山保持下半幅，太阳入画上部）
    const base3 = lookCurve.getPointAt(k);
    const wLook = smooth((k - 0.30) / 0.06) * (1 - smooth((k - 0.58) / 0.07));
    if (wLook > 0.001) {
      base3.lerp(new THREE.Vector3(sp.x * 0.55, sp.y * 0.62, sp.z * 0.55), Math.min(0.65, wLook * 0.65));
    }
    camera.lookAt(base3);
    // 弧在演示结束后淡出（证据已立，装饰退场）
    arc.material.opacity = 0.55 * (1 - smooth((k - 0.80) / 0.08));
  };
}

// —— 渭河谷 3D（谜面地图 EP1 S3 拍4）：真实 DEM 非对称河谷 ——
// 叙事：相机贴河面向东跟拍——左手南岸贴着秦岭山壁（被水掏），右手北岸渭北原展开（越垫越高）。
//       「南掏北垫」不是示意图，是河谷地形本身。标注用场景内 sprite（随相机正确跟踪）。
async function buildWeiheValley(p) {
  const base = p.base;
  if (!base) throw new Error('weihe_valley: params.base 必填（fetch_terrain_block 产物目录，服务器相对路径）');
  const meta = await (await fetch('/' + base + '/meta.json')).json();
  const buf = await (await fetch('/' + base + '/heights.f32')).arrayBuffer();
  const HG = new Float32Array(buf);
  const texT = await tex(base + '/surface.jpg');
  texT.anisotropy = 16;

  const CHAN = p.channel || [
    [109.950, 34.579], [109.980, 34.582], [110.000, 34.585], [110.010, 34.588],
    [110.020, 34.591], [110.030, 34.593], [110.050, 34.595], [110.080, 34.596],
    [110.120, 34.597], [110.160, 34.598], [110.220, 34.600]];

  const KM_LAT = 110.6;
  const KM_LON = 111.3 * Math.cos(((meta.latNorth + meta.latSouth) / 2) * Math.PI / 180);
  const spanX = (meta.lonEast - meta.lonWest) * KM_LON;
  const spanZ = (meta.latNorth - meta.latSouth) * KM_LAT;
  const EXAG = p.exaggeration ?? 1.5;
  const STEP = p.step ?? 2;
  const gc = Math.floor(meta.cols / STEP), gr = Math.floor(meta.rows / STEP);
  const FLOOR_Y = meta.elevMin / 1000 * EXAG - 0.06;

  const toScene = (lon, lat) => new THREE.Vector3(
    ((lon - meta.lonWest) / (meta.lonEast - meta.lonWest) - 0.5) * spanX, 0,
    -((lat - (meta.latNorth + meta.latSouth) / 2) / (meta.latNorth - meta.latSouth)) * spanZ);

  const geo = new THREE.PlaneGeometry(spanX, spanZ, gc - 1, gr - 1);
  geo.rotateX(-Math.PI / 2);                    // +x 东，-z 北，+y 高
  const pos = geo.attributes.position;
  for (let r = 0; r < gr; r++)
    for (let c = 0; c < gc; c++)
      pos.setY(r * gc + c, HG[(r * STEP) * meta.cols + c * STEP] / 1000 * EXAG);
  // 裙边（同 huashan：外推压地防悬浮岛）
  const uv = geo.attributes.uv;
  for (let r = 0; r < gr; r++)
    for (let c = 0; c < gc; c++) {
      if (r > 1 && r < gr - 2 && c > 1 && c < gc - 2) continue;
      const i = r * gc + c;
      pos.setX(i, pos.getX(i) * 1.3);
      pos.setZ(i, pos.getZ(i) * 1.3);
      pos.setY(i, FLOOR_Y + 0.02);
      uv.setXY(i, (uv.getX(i) - 0.5) * 1.3 + 0.5, (uv.getY(i) - 0.5) * 1.3 + 0.5);
    }
  geo.computeVertexNormals();
  const terrainMesh = new THREE.Mesh(geo,
    new THREE.MeshStandardMaterial({ map: texT, roughness: 1, metalness: 0 }));
  terrainMesh.castShadow = true;
  terrainMesh.receiveShadow = true;
  scene.add(terrainMesh);

  const floorTex = texT.clone();
  floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
  floorTex.repeat.set(5, 5);
  floorTex.needsUpdate = true;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(260, 260),
    new THREE.MeshStandardMaterial({ map: floorTex, color: 0xb0b4a8, roughness: 1, metalness: 0 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = FLOOR_Y;
  floor.receiveShadow = true;
  scene.add(floor);

  const groundY = (x, z) => {
    const c = clamp01((x / spanX + 0.5)) * (meta.cols - 1);
    const r = clamp01((z / spanZ + 0.5)) * (meta.rows - 1);
    const c0 = Math.floor(c), r0 = Math.floor(r);
    const c1 = Math.min(meta.cols - 1, c0 + 1), r1 = Math.min(meta.rows - 1, r0 + 1);
    const fc = c - c0, fr = r - r0;
    const h = HG[r0 * meta.cols + c0] * (1 - fc) * (1 - fr) + HG[r0 * meta.cols + c1] * fc * (1 - fr)
            + HG[r1 * meta.cols + c0] * (1 - fc) * fr + HG[r1 * meta.cols + c1] * fc * fr;
    return h / 1000 * EXAG;
  };

  // 河道场景点（锚点插值密化）
  const chanPts3 = CHAN.map(q => toScene(q[0], q[1]));
  const chanCurve = new THREE.CatmullRomCurve3(chanPts3, false, 'centripetal');
  const chanAt = (u) => chanCurve.getPointAt(clamp01(u));

  // 水面：沿河道三角带（贴河床跟随地形，防被岸坡埋掉；真实河在卫星纹理上偏绿，蓝带锁定河）
  const NW = 96, HW = 0.14;                      // 半宽 140m
  const wPos = [], wIdx = [];
  for (let i = 0; i <= NW; i++) {
    const q = chanAt(i / NW), q2 = chanAt(Math.min(1, i / NW + 0.01));
    const tx = q2.x - q.x, tz = q2.z - q.z, tl = Math.hypot(tx, tz) || 1;
    const nx = -tz / tl, nz = tx / tl;           // 左法线
    const wy = groundY(q.x, q.z) + 0.008;
    wPos.push(q.x + nx * HW, wy, q.z + nz * HW, q.x - nx * HW, wy, q.z - nz * HW);
    if (i < NW) { const a = i * 2; wIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const wGeo = new THREE.BufferGeometry();
  wGeo.setAttribute('position', new THREE.Float32BufferAttribute(wPos, 3));
  wGeo.setIndex(wIdx);
  wGeo.computeVertexNormals();
  const water = new THREE.Mesh(wGeo, new THREE.MeshStandardMaterial({
    color: 0x4a90c2, roughness: 0.1, metalness: 0.3,
    transparent: true, opacity: 0.9 }));
  scene.add(water);

  // 岸侧高亮带（贴地随地形，窄带低饱和：指岸不盖地）：南岸红=被水掏 / 北岸金=越垫越高
  function bankStrip(off0, off1, color) {
    const posA = [], idxA = [];
    const NB = 72;
    for (let i = 0; i <= NB; i++) {
      const u = i / NB, q = chanAt(u);
      for (const off of [off0, off1])
        posA.push(q.x, groundY(q.x, q.z + off) + 0.02, q.z + off);
      if (i < NB) { const a = i * 2; idxA.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(posA, 3));
    g.setIndex(idxA);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0, depthWrite: false }));
    scene.add(m);
    return m;
  }
  const southStrip = bankStrip(0.18, 0.72, 0xd84a3a);   // +z = 南
  const northStrip = bankStrip(-0.18, -0.80, 0xe8b23a); // -z = 北

  // 文字 sprite（canvas → Sprite，世界尺寸恒定，随相机正确透视）
  function textSprite(str, fg, scaleW) {
    const cv = document.createElement('canvas');
    cv.width = 640; cv.height = 200;
    const g2 = cv.getContext('2d');
    g2.font = '600 84px "RuyiSmiley", sans-serif';
    g2.textAlign = 'center'; g2.textBaseline = 'middle';
    g2.shadowColor = 'rgba(6,10,16,0.9)'; g2.shadowBlur = 18;
    g2.fillStyle = fg;
    g2.fillText(str, 320, 100);
    const t2 = new THREE.CanvasTexture(cv);
    t2.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: t2, transparent: true, opacity: 0, depthWrite: false }));
    sp.scale.set(scaleW, scaleW * 200 / 640, 1);
    scene.add(sp);
    return sp;
  }
  const southLbl = textSprite('南岸 · 被水掏', '#ff8a76', 1.5);
  const northLbl = textSprite('北岸 · 越垫越高', '#ffd27a', 1.5);
  {
    const qs = chanAt(0.38), qn = chanAt(0.60);
    southLbl.position.set(qs.x, groundY(qs.x, qs.z + 0.5) + 0.42, qs.z + 0.5);
    northLbl.position.set(qn.x, groundY(qn.x, qn.z - 0.55) + 0.42, qn.z - 0.55);
  }

  // 天空 + 雾 + 光（配方同 huashan v2）
  const skyCv = document.createElement('canvas');
  skyCv.width = 1024; skyCv.height = 512;
  const sg = skyCv.getContext('2d');
  const grad = sg.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#16283f'); grad.addColorStop(0.28, '#1c3350');
  grad.addColorStop(0.42, '#5d7fa4'); grad.addColorStop(0.485, '#93a8b6');
  grad.addColorStop(0.5, '#acb9c4'); grad.addColorStop(0.52, '#a2aeb8');
  grad.addColorStop(0.7, '#8a8e82'); grad.addColorStop(1, '#6a6e62');
  sg.fillStyle = grad; sg.fillRect(0, 0, 1024, 512);
  const skyTex = new THREE.CanvasTexture(skyCv);
  skyTex.colorSpace = THREE.SRGBColorSpace;
  skyTex.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = skyTex;
  scene.fog = new THREE.FogExp2(0xacb9c4, 0.045);

  const sun = new THREE.DirectionalLight(0xfff2d8, 4.2);   // 午后南南西
  const azS = 200 * Math.PI / 180, elS = 38 * Math.PI / 180, RS = 16;
  sun.position.set(RS * Math.cos(elS) * Math.sin(azS), RS * Math.sin(elS), -RS * Math.cos(elS) * Math.cos(azS));
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const sc2 = sun.shadow.camera;
  sc2.left = -18; sc2.right = 18; sc2.top = 14; sc2.bottom = -14;
  sc2.near = 0.5; sc2.far = 60;
  sun.shadow.bias = -0.0002; sun.shadow.normalBias = 0.02;
  scene.add(sun); scene.add(sun.target);
  scene.add(new THREE.AmbientLight(0x40536e, 0.95));

  // 相机：河道南侧 ~2.5km、1.7km 高度向东缓推；视线从东南（南山+南岸）扫到东北（北岸+原面）
  const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
  const cw = chanAt(0.10), cm = chanAt(0.45), ce = chanAt(0.80);
  const camCurve = new THREE.CatmullRomCurve3([
    V([cw.x - 1.5, 0, cw.z + 2.6]), V([cm.x - 1.2, 0, cm.z + 2.8]), V([ce.x - 0.6, 0, ce.z + 2.4]),
  ], false, 'centripetal');
  const lookCurve = new THREE.CatmullRomCurve3([
    V([cw.x + 3.0, 0, cw.z + 1.2]), V([cm.x + 2.8, 0, cm.z + 0.4]), V([ce.x + 2.2, 0, ce.z - 1.8]),
  ], false, 'centripetal');
  const N = 256;
  const camPts = [], lookPts = [];
  for (let i = 0; i <= N; i++) {
    camPts.push(camCurve.getPointAt(i / N));
    lookPts.push(lookCurve.getPointAt(i / N));
  }
  for (let i = 0; i <= N; i++) {
    const q = camPts[i];
    q.y = groundY(q.x, q.z) + 1.7 + 0.3 * (i / N);        // 1.7→2.0km 缓升
  }
  for (const q of lookPts) q.y = groundY(q.x, q.z) + 0.10;
  {
    const ys = camPts.map(q => q.y);
    for (let i = 0; i <= N; i++) {
      let s = 0, c = 0;
      for (let j = -10; j <= 10; j++) { const q = Math.min(N, Math.max(0, i + j)); s += ys[q]; c++; }
      camPts[i].y = s / c;
    }
  }

  camera.fov = p.camFov ?? 52;
  camera.far = 160;
  camera.updateProjectionMatrix();

  const T = CFG.duration;
  return (t) => {
    const k = clamp01(t / T);
    camera.position.copy(camPts[Math.min(N, Math.round(k * N))]);
    camera.lookAt(lookPts[Math.min(N, Math.round(k * N))]);
    // 南岸红（旁白 14.07「南岸天天被水掏」→ k≈0.05）；北岸金（15.70 → k≈0.49）
    // 视线扫北后南案退到弱存（不抢焦点）
    const southIn = smooth((k - 0.04) / 0.12);
    const southOut = 1 - 0.7 * smooth((k - 0.58) / 0.16);
    southStrip.material.opacity = 0.24 * southIn * southOut;
    southLbl.material.opacity = southIn * southOut;
    northStrip.material.opacity = 0.34 * smooth((k - 0.40) / 0.10);
    northLbl.material.opacity = smooth((k - 0.42) / 0.10) * (1 - smooth((k - 0.70) / 0.13));
  };
}

// 渭河冲蚀概念片：水流撞南岸 → 掏槽崩塌 → 浑水下行 → 北岸沙洲淤高。
// 真实地形（terrain_wh DEM+Esri）上做时间加速：宽镜皆真实，唯南岸特写嵌入一段
// 致密黄土陡岸（canvas 层理纹理），塌陷/水花/沙洲全部确定性调度（ seeded rng ）。
async function buildWeiheErosion(p) {
  const base = p.base;
  if (!base) throw new Error('weihe_erosion: params.base 必填（fetch_terrain_block 产物目录，服务器相对路径）');
  const meta = await (await fetch('/' + base + '/meta.json')).json();
  const buf = await (await fetch('/' + base + '/heights.f32')).arrayBuffer();
  const HG = new Float32Array(buf);
  const texT = await tex(base + '/surface.jpg');
  texT.anisotropy = 16;

  // 渭河真实河道描线（z15 卫星影像逐段勘验：华阴东—潼关汇入黄河前，南凹弯+真沙洲）
  const CHAN = p.channel || [
    [110.090, 34.589], [110.100, 34.600], [110.118, 34.617], [110.130, 34.620],
    [110.160, 34.622], [110.195, 34.623], [110.207, 34.626], [110.214, 34.627],
    [110.220, 34.622], [110.226, 34.615], [110.233, 34.615], [110.244, 34.616], [110.252, 34.616]];
  const KM_LAT = 110.6;
  const KM_LON = 111.3 * Math.cos(((meta.latNorth + meta.latSouth) / 2) * Math.PI / 180);
  const spanX = (meta.lonEast - meta.lonWest) * KM_LON;
  const spanZ = (meta.latNorth - meta.latSouth) * KM_LAT;
  const EXAG = p.exaggeration ?? 1.5;
  const STEP = p.step ?? 3;
  const gc = Math.floor(meta.cols / STEP), gr = Math.floor(meta.rows / STEP);
  const FLOOR_Y = meta.elevMin / 1000 * EXAG - 0.06;
  const toScene = (lon, lat) => new THREE.Vector3(
    ((lon - meta.lonWest) / (meta.lonEast - meta.lonWest) - 0.5) * spanX, 0,
    -((lat - (meta.latNorth + meta.latSouth) / 2) / (meta.latNorth - meta.latSouth)) * spanZ);
  const geo = new THREE.PlaneGeometry(spanX, spanZ, gc - 1, gr - 1);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let r = 0; r < gr; r++)
    for (let c = 0; c < gc; c++)
      pos.setY(r * gc + c, HG[(r * STEP) * meta.cols + c * STEP] / 1000 * EXAG);
  const uv0 = geo.attributes.uv;
  for (let r = 0; r < gr; r++)
    for (let c = 0; c < gc; c++) {
      if (r > 1 && r < gr - 2 && c > 1 && c < gc - 2) continue;
      const i = r * gc + c;
      pos.setX(i, pos.getX(i) * 1.3); pos.setZ(i, pos.getZ(i) * 1.3);
      pos.setY(i, FLOOR_Y + 0.02);
      uv0.setXY(i, (uv0.getX(i) - 0.5) * 1.3 + 0.5, (uv0.getY(i) - 0.5) * 1.3 + 0.5);
    }

  const groundY = (x, z) => {
    const c = clamp01((x / spanX + 0.5)) * (meta.cols - 1);
    const r = clamp01((z / spanZ + 0.5)) * (meta.rows - 1);
    const c0 = Math.floor(c), r0 = Math.floor(r);
    const c1 = Math.min(meta.cols - 1, c0 + 1), r1 = Math.min(meta.rows - 1, r0 + 1);
    const fc = c - c0, fr = r - r0;
    const h = HG[r0 * meta.cols + c0] * (1 - fc) * (1 - fr) + HG[r0 * meta.cols + c1] * fc * (1 - fr)
            + HG[r1 * meta.cols + c0] * (1 - fc) * fr + HG[r1 * meta.cols + c1] * fc * fr;
    return h / 1000 * EXAG;
  };

  const chanPts3 = CHAN.map(q => toScene(q[0], q[1]));
  const chanCurve = new THREE.CatmullRomCurve3(chanPts3, false, 'centripetal');
  const chanAt = (u) => chanCurve.getPointAt(clamp01(u));
  const chanLen = chanCurve.getLength();
  const tanAt = (u) => {
    const a = chanAt(Math.max(0, u - 0.004)), b = chanAt(Math.min(1, u + 0.004));
    return b.sub(a).setY(0).normalize();
  };
  const southAt = (u) => { const t = tanAt(u); return new THREE.Vector3(-t.z, 0, t.x); }; // 左法线=南

  // 确定性随机（渲染契约：同 t 同帧，禁 Math.random）
  let seed = 42;
  const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let z = Math.imul(seed ^ seed >>> 15, 1 | seed);
    z = z + Math.imul(z ^ z >>> 7, 61 | z) ^ z; return ((z ^ z >>> 14) >>> 0) / 4294967296; };

  // ---- 雕槽：把河道刻进平原（南深北浅不对称槽——凹岸深槽逼南岸，凸岸浅滩靠北）----
  // SRTM 分不出 100m 级河槽，不雕槽水面会被 ±3m 的平原起伏盖没（探针判例）
  const bedDepth = (off) => {                       // off 南正，scene km
    const ao = Math.abs(off);
    if (ao > 0.13) return 0;
    let d;
    if (off >= 0.075) d = 0.0055;                   // 深槽逼南岸脚
    else if (off >= 0) d = 0.0030 + 0.0025 * (off / 0.075);
    else d = 0.0030 * Math.max(0, 1 + off / 0.085); // 北側漸淺，-85m 出水
    const blend = 1 - smooth((ao - 0.10) / 0.03);
    return d * Math.max(0, blend);
  };
  {
    const NC = 500;
    for (let s = 0; s <= NC; s++) {
      const u = s / NC;
      const q = chanAt(u), t = tanAt(u), n = southAt(u);
      const plainY = groundY(q.x, q.z);
      const cC = (q.x / spanX + 0.5) * (gc - 1), rC = (q.z / spanZ + 0.5) * (gr - 1);
      const dc = Math.ceil(0.14 / spanX * (gc - 1)), dr = Math.ceil(0.14 / spanZ * (gr - 1));
      const r0 = Math.max(2, Math.floor(rC - dr)), r1 = Math.min(gr - 3, Math.ceil(rC + dr));
      const c0 = Math.max(2, Math.floor(cC - dc)), c1 = Math.min(gc - 3, Math.ceil(cC + dc));
      for (let r = r0; r <= r1; r++)
        for (let c = c0; c <= c1; c++) {
          const vx = (c / (gc - 1) - 0.5) * spanX, vz = (r / (gr - 1) - 0.5) * spanZ;
          const dx = vx - q.x, dz = vz - q.z;
          const along = dx * t.x + dz * t.z;
          if (Math.abs(along) > 0.15) continue;
          const d = bedDepth(dx * n.x + dz * n.z);
          if (d <= 0) continue;
          const target = plainY - d, i = r * gc + c;
          if (pos.getY(i) > target) pos.setY(i, target);
        }
    }
  }
  geo.computeVertexNormals();
  const terrainMesh = new THREE.Mesh(geo,
    new THREE.MeshStandardMaterial({ map: texT, roughness: 1, metalness: 0 }));
  terrainMesh.castShadow = true; terrainMesh.receiveShadow = true;
  scene.add(terrainMesh);
  if (p.hideTerrain) terrainMesh.visible = false;          // 诊断：藏地形，验证水面是否被遮挡
  const floorTex = texT.clone();
  floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
  floorTex.repeat.set(5, 5); floorTex.needsUpdate = true;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(260, 260),
    new THREE.MeshStandardMaterial({ map: floorTex, color: 0xb0b4a8, roughness: 1, metalness: 0 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = FLOOR_Y;
  floor.receiveShadow = true; scene.add(floor);

  // 统一水位基准：平原面下 1.8 scene-m（≈1.2m 真实），全场共用
  // 水位必须沿河道水平：手绘 CHAN 线偏离真实河槽时，groundY 逐点采样带上 ±3m 起伏，
  // 水面变「水坡」，贴水相机扎进坡里=灰绿罩盖住崖面（KF 沿河道入水判例）。
  // 41 点滑窗（±4km）抹平百米级偏离抖动，保留千米级真实坡降
  const NWY = 128, rawWY = [];
  for (let i = 0; i <= NWY; i++) { const q = chanAt(i / NWY); rawWY.push(groundY(q.x, q.z) - 0.0018); }
  const smoothWaterY = (u) => {
    const c = Math.floor(u * NWY), i0 = Math.max(0, c - 20), i1 = Math.min(NWY, c + 20);
    let s = 0; for (let i = i0; i <= i1; i++) s += rawWY[i];
    return s / (i1 - i0 + 1);
  };
  const waterYAt = smoothWaterY;

  // ---- 天空 / 雾 / 光（同 valley 配方）----
  const skyCv = document.createElement('canvas');
  skyCv.width = 1024; skyCv.height = 512;
  const sg = skyCv.getContext('2d');
  const grad = sg.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#16283f'); grad.addColorStop(0.28, '#1c3350');
  grad.addColorStop(0.42, '#5d7fa4'); grad.addColorStop(0.485, '#93a8b6');
  grad.addColorStop(0.5, '#acb9c4'); grad.addColorStop(0.52, '#a2aeb8');
  grad.addColorStop(0.7, '#8a8e82'); grad.addColorStop(1, '#6a6e62');
  sg.fillStyle = grad; sg.fillRect(0, 0, 1024, 512);
  const skyTex = new THREE.CanvasTexture(skyCv);
  skyTex.colorSpace = THREE.SRGBColorSpace;
  skyTex.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = skyTex;
  const FOGC = new THREE.Color(0xacb9c4), FOGD = 0.045;
  scene.fog = new THREE.FogExp2(FOGC.getHex(), FOGD);
  const sun = new THREE.DirectionalLight(0xfff2d8, 4.2);
  const azS = 200 * Math.PI / 180, elS = 38 * Math.PI / 180, RS = 16;
  sun.position.set(RS * Math.cos(elS) * Math.sin(azS), RS * Math.sin(elS), -RS * Math.cos(elS) * Math.cos(azS));
  sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096);
  const sc2 = sun.shadow.camera;
  sc2.left = -18; sc2.right = 18; sc2.top = 14; sc2.bottom = -14; sc2.near = 0.5; sc2.far = 60;
  sun.shadow.bias = -0.0002; sun.shadow.normalBias = 0.02;
  scene.add(sun); scene.add(sun.target);
  scene.add(new THREE.AmbientLight(0x40536e, 0.95));
  const fillN = new THREE.DirectionalLight(0xe8e2d4, 1.9);   // 北侧补光：南岸陡崖朝北背光，层理不死黑
  fillN.position.set(4, 5, -12);
  scene.add(fillN); scene.add(fillN.target);

  // ---- 水面（shader：浑绿渐变+流速线+太阳碎金+南岸拍岸白浪带，手动雾）----
  const STAGE_U = p.stageU ?? 0.80;
  const HW = 0.085;
  const NW = 128;
  const wPos = [], wIdx = [], wUv = [], wBase = [];
  for (let i = 0; i <= NW; i++) {
    const u = i / NW, q = chanAt(u), n = southAt(u);
    const wy = smoothWaterY(u);                              // 平滑水位：逐点 groundY 会成「水坡」（入水判例）
    wPos.push(q.x + n.x * HW, wy, q.z + n.z * HW, q.x - n.x * HW, wy, q.z - n.z * HW);
    wBase.push({ u, x: q.x, z: q.z, nx: n.x, nz: n.z });   // 南缘顶点基准：掏槽扩边用
    wUv.push(u, 0, u, 1);                    // v=0 南缘（贴岸），v=1 北缘
    if (i < NW) { const a = i * 2; wIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const wGeo = new THREE.BufferGeometry();
  wGeo.setAttribute('position', new THREE.Float32BufferAttribute(wPos, 3));
  wGeo.setAttribute('uv', new THREE.Float32BufferAttribute(wUv, 2));
  wGeo.setIndex(wIdx);
  const waterUniforms = { uT: { value: 0 }, uSurge: { value: 0 },
    uFogColor: { value: FOGC }, uFogDensity: { value: FOGD } };
  const water = new THREE.Mesh(wGeo, new THREE.ShaderMaterial({
    uniforms: waterUniforms, transparent: true, side: THREE.DoubleSide,   // 顶点序（南缘,北缘）法线朝下，必须双面否则仰视剔除
    vertexShader: 'varying vec2 vUv; varying float vDepth; varying vec3 vWorld;' +
      'void main(){ vUv=uv; vec4 wp=modelMatrix*vec4(position,1.0); vWorld=wp.xyz;' +
      '  vec4 mv=viewMatrix*wp; vDepth=-mv.z;' +
      '  gl_Position=projectionMatrix*mv; }',
    fragmentShader: 'varying vec2 vUv; varying float vDepth; varying vec3 vWorld;' +
      'uniform float uT; uniform float uSurge; uniform float uFogDensity; uniform vec3 uFogColor;' +
      'float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }' +
      'float vnoise(vec2 p){ vec2 i=floor(p); vec2 f=fract(p); f=f*f*(3.0-2.0*f);' +
      '  return mix(mix(hash(i),hash(i+vec2(1.0,0.0)),f.x),mix(hash(i+vec2(0.0,1.0)),hash(i+vec2(1.0,1.0)),f.x),f.y); }' +
      'void main(){' +
      // 表观流速 ≈18m/s（五审判例：4m/s=死水无质感，>1000m/s=沸腾；18m/s 流动可辨不癫；
      // 换算：相位速度 c / 频率 f × chanLen≈27km，c = 系数 × 27000m / f）
      '  float streak = vnoise(vec2(vUv.x*340.0 - uT*0.23, vUv.y*30.0));' +
      '  streak = smoothstep(0.46,0.95,streak)*0.42;' +                  // 流速线加亮加密：水感的本体
      '  float chop = vnoise(vec2(vUv.x*140.0 - uT*0.09, vUv.y*55.0 + uT*0.25));' +
      '  float mid = vnoise(vec2(vUv.x*270.0 - uT*0.18, vUv.y*4.0));' +   // 中频 ~100×40m 胞：贴水掠射下远处水面被压成均匀灰带（灰带帧判例），中尺度明暗破均匀
      '  float pulse = pow(max(0.0,sin(vUv.x*120.0 - uT*0.20)),6.0);' +   // 涌浪行波 ~45m/s：可辨推进，不癫
      '  float foamBand = smoothstep(0.16,0.0,vUv.y);' +
      '  float foamN = vnoise(vec2(vUv.x*200.0 - uT*0.13, vUv.y*70.0 + uT*0.40));' +
      '  float fn2 = vnoise(vec2(vUv.x*1600.0 - uT*0.50, vUv.y*300.0 + uT*0.60));' +   // 高频拍岸碎浪：近景机位下 foamN 变化太慢会刷成均匀白带
      '  float foam = foamBand * smoothstep(0.62,1.02, foamN*0.55+fn2*0.45 + pulse*0.30);' +   // 常态碎浪：稀疏 patch；涌浪白只走下式瞬态项，不进阈值（连拍饱和白带判例）
      '  vec3 deep = vec3(0.20,0.29,0.24);' +                  // 主槽浑绿
      '  vec3 shal = vec3(0.30,0.36,0.26);' +                  // 北浅
      '  vec3 mud  = vec3(0.50,0.40,0.24);' +                  // 南缘泥沙（冲蚀供给）
      '  vec3 col = mix(deep, shal, smoothstep(0.35,0.95,vUv.y));' +
      '  col *= 0.90 + 0.20*mid;' +                          // 中尺度明暗：远水面不再一块匀灰
      '  float mudBand = smoothstep(0.55,0.05,vUv.y);' +
      '  col = mix(col, mud, mudBand*(0.50+0.30*chop));' +
      '  col += vec3(1.0)*streak*(0.15+0.17*chop);' +
      '  col += vec3(0.93,0.96,0.96)*(foam*0.70 + uSurge*foamBand*0.50*(0.10+0.90*fn2));' +   // 涌浪白=每拍瞬态闪光，被 fn2 打碎（荧光水线判例）
      '  float glint = pow(vnoise(vec2(vUv.x*700.0 - uT*0.22, vUv.y*140.0)), 14.0);' +
      '  col += vec3(1.0,0.98,0.88)*glint*0.70*(1.0-mudBand*0.6);' +       // 太阳碎金加量：流动质感的高光本体
      '  vec3 V = normalize(cameraPosition - vWorld);' +       // 菲涅尔：掠射角反射天空，水面才读成「水」
      '  float fres = pow(1.0 - clamp(V.y, 0.0, 1.0), 2.5);' +
      '  fres *= (0.55+0.45*chop)*(1.0-mudBand*0.45);' +       // 用涟漪/泥沙打散水线均匀光带（霓虹水线判例）
      '  col = mix(col, vec3(0.44,0.52,0.56), fres*0.40);' +
      '  float fogF = 1.0 - exp(-uFogDensity*uFogDensity*vDepth*vDepth);' +
      '  col = mix(col, uFogColor, clamp(fogF,0.0,1.0));' +
      '  gl_FragColor = vec4(col, 0.96);' +
      '}' }));
  scene.add(water);
  if (p.waterDebug) water.material = new THREE.MeshBasicMaterial({ color: 0xff2222, side: THREE.DoubleSide });   // 诊断：水面纯红显形

  // ---- 南岸黄土陡岸嵌入体（致密网格，掏槽+崩塌的舞台）----
  const stageC = chanAt(STAGE_U);
  const stageN = southAt(STAGE_U);
  const stageT = tanAt(STAGE_U);
  const waterY0 = waterYAt(STAGE_U);
  const halfLen = 0.28;                                   // 岸段半长 km
  const du = halfLen / chanLen;
  const NU = 180, NV = 16;
  // 层理纹理（黄土水平地层 + 斑点）
  const loessCv = document.createElement('canvas');
  loessCv.width = 512; loessCv.height = 512;
  {
    const g = loessCv.getContext('2d');
    const bands = ['#b89c6e', '#a8895d', '#c4aa7c', '#9c7f56', '#b2955f'];
    let y = 0, bi = 0;
    while (y < 512) { const h = 26 + rnd() * 46; g.fillStyle = bands[bi++ % bands.length];
      g.fillRect(0, y, 512, h); y += h; }
    for (let i = 0; i < 9000; i++) { g.fillStyle = 'rgba(' + (60+rnd()*40|0) + ',' + (45+rnd()*30|0) + ',' + (25+rnd()*20|0) + ',' + (0.05+rnd()*0.10) + ')';
      g.fillRect(rnd() * 512, rnd() * 512, 1 + rnd() * 2, 1 + rnd() * 2); }
    g.fillStyle = 'rgba(70,55,35,0.25)';                   // 竖向雨蚀沟
    for (let i = 0; i < 60; i++) { const x = rnd() * 512; g.fillRect(x, rnd() * 100, 1 + rnd() * 2, 200 + rnd() * 300); }
  }
  const loessTex = new THREE.CanvasTexture(loessCv);
  loessTex.colorSpace = THREE.SRGBColorSpace;
  loessTex.wrapS = loessTex.wrapT = THREE.RepeatWrapping;
  loessTex.repeat.set(6, 1);
  // 顶点基准数据（每 i：南法线/水面/岸顶高 + 参差噪声）
  const bBase = [];
  for (let i = 0; i <= NU; i++) {
    const u = STAGE_U - du + (2 * du) * i / NU;
    const q = chanAt(u), n = southAt(u);
    const plainY = groundY(q.x, q.z);
    const wy = smoothWaterY(u);                            // 崖脚水位与水面同源（平滑），否则崖脚泡水深度沿河道起伏
    const qTop = q.clone().addScaledVector(n, 0.115);
    const topY = Math.max(groundY(qTop.x, qTop.z), plainY + 0.014) + 0.001 + rnd() * 0.002;   // 崖顶抬到水面上 17-19m，贴水仰拍才读得出「崖」
    bBase.push({ q, n, wy, topY, jag: 0.7 + rnd() * 0.6 });
  }
  const bGeo = new THREE.BufferGeometry();
  const bPosArr = new Float32Array((NU + 1) * (NV + 1) * 3);
  const bUvArr = new Float32Array((NU + 1) * (NV + 1) * 2);
  const bColArr = new Float32Array((NU + 1) * (NV + 1) * 3);
  const bIdx = [];
  for (let i = 0; i <= NU; i++)
    for (let j = 0; j <= NV; j++) {
      const a = i * (NV + 1) + j;
      bUvArr[a * 2] = i / NU; bUvArr[a * 2 + 1] = j / NV;
      const shade = 0.78 + 0.38 * (j / NV);               // 坡脚暗、坡顶亮（伪 AO）
      bColArr[a * 3] = shade; bColArr[a * 3 + 1] = shade; bColArr[a * 3 + 2] = shade;
      if (i < NU && j < NV) { const b = a;
        bIdx.push(b, b + NV + 1, b + 1, b + 1, b + NV + 1, b + NV + 2); }
    }
  bGeo.setAttribute('position', new THREE.BufferAttribute(bPosArr, 3));
  bGeo.setAttribute('uv', new THREE.BufferAttribute(bUvArr, 2));
  bGeo.setAttribute('color', new THREE.BufferAttribute(bColArr, 3));
  bGeo.setIndex(bIdx);
  const bank = new THREE.Mesh(bGeo, new THREE.MeshStandardMaterial({
    map: loessTex, vertexColors: true, roughness: 1, metalness: 0, side: THREE.DoubleSide }));
  bank.castShadow = true; bank.receiveShadow = true;
  scene.add(bank);
  // 掏槽形变：ero=全局掏蚀进度 0..1；前沿从中段向下游扫，齿状参差
  const NOTCH = 0.018;                                    // 最大掏进 18m
  function bankUpdate(ero) {
    for (let i = 0; i <= NU; i++) {
      const B = bBase[i];
      const d = Math.abs(i / NU - 0.45) * 2;
      const e = clamp01((ero - d * 0.38) / 0.34) * B.jag; // 各列掏蚀量
      B.e = e;                                            // 存当前列掏蚀量：水面南缘同步扩边用
      const notch = NOTCH * e;
      for (let j = 0; j <= NV; j++) {
        const v = j / NV, a = (i * (NV + 1) + j) * 3;
        // 断面：水下脚 → 黄土陡坎（水平仅 26m，~30°，读得出「崖」）→ 顶缘
        const off = 0.078 + 0.026 * Math.pow(v, 1.3)
                  + notch * Math.max(0, 1 - v / 0.38)     // 掏槽：坡脚向南凹进
                  + notch * 0.35 * Math.sin(v * Math.PI); // 上部随塌整体南移
        const y = B.wy - 0.004 + (B.topY - B.wy + 0.004) * v
                - notch * 0.30 * Math.sin(v * Math.PI);   // 塌陷下沉
        bPosArr[a] = B.q.x + B.n.x * off;
        bPosArr[a + 1] = y;
        bPosArr[a + 2] = B.q.z + B.n.z * off;
        const wet = 1 - 0.32 * Math.min(1, e) * Math.max(0, 1 - v / 0.5);   // 掏蚀湿痕：被掏下段变暗，机制可读
        const shade = (0.78 + 0.38 * v) * wet;
        bColArr[a] = shade; bColArr[a + 1] = shade; bColArr[a + 2] = shade;
      }
    }
    bGeo.attributes.position.needsUpdate = true;
    bGeo.attributes.color.needsUpdate = true;
    bGeo.computeVertexNormals();
    waterEdgeUpdate();
  }
  // 水面南缘随掏槽同步南扩：水漫进掏空的凹槽——否则掏槽后崖脚南移、水面不动，
  // 崖脚与水面之间露出 7-11m 裸露河床条带（低角度下=均匀灰带，把崖面切成上下两段的「双崖灰带」判例）
  const wArr = wGeo.attributes.position.array;
  function waterEdgeUpdate() {
    for (let i = 0; i <= NW; i++) {
      const W = wBase[i];
      let e = 0;
      const ib = (W.u - (STAGE_U - du)) / (2 * du) * NU;
      if (ib >= 0 && ib <= NU) {
        const i0 = Math.min(NU - 1, Math.max(0, Math.floor(ib))), f = ib - i0;
        e = (bBase[i0].e || 0) * (1 - f) + (bBase[i0 + 1].e || 0) * f;
      }
      const off = HW + NOTCH * e;          // 与崖脚同步南移，保住 7m 贴岸余量
      wArr[i * 6] = W.x + W.nx * off;
      wArr[i * 6 + 2] = W.z + W.nz * off;
    }
    wGeo.attributes.position.needsUpdate = true;
  }
  bankUpdate(0);

  // ---- 崩落土块（InstancedMesh，确定性时间表）----
  const NCH = 64;
  const chunks = new THREE.InstancedMesh(
    new THREE.DodecahedronGeometry(0.0028, 0),
    new THREE.MeshStandardMaterial({ color: 0xa98f66, roughness: 1, metalness: 0 }), NCH);
  chunks.castShadow = true;
  scene.add(chunks);
  const HIT0 = 0.34, HIT1 = 0.66, NHIT = 5;               // 涌浪拍岸节拍：5 拍间距 1.76s（9 拍/1s 连拍=频闪+连拍饱和判例）
  const hitKs = [];
  for (let j = 0; j < NHIT; j++) hitKs.push(HIT0 + (HIT1 - HIT0) * j / (NHIT - 1));
  const chDef = [];
  for (let c = 0; c < NCH; c++) {
    const fi = 0.15 + rnd() * 0.7;                        // 沿岸位置
    const hit = hitKs[Math.floor(rnd() * NHIT)];
    chDef.push({ fi, k0: hit + (rnd() - 0.5) * 0.035, v0: 0.25 + rnd() * 0.45,
      size: 0.5 + rnd() * 0.9, ax: new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize(),
      spin: 2 + rnd() * 5, lat: rnd(), splashed: false });
  }
  const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), SV = new THREE.Vector3();
  // 水花 sprite 池（土块落水 + 拍岸白浪共用）
  const splashCv = document.createElement('canvas');
  splashCv.width = splashCv.height = 128;
  {
    const g = splashCv.getContext('2d');
    const rg = g.createRadialGradient(64, 64, 4, 64, 64, 62);
    rg.addColorStop(0, 'rgba(255,255,255,0.9)'); rg.addColorStop(0.45, 'rgba(240,248,250,0.42)');
    rg.addColorStop(1, 'rgba(240,248,250,0)');
    g.fillStyle = rg; g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 16; i++) {                       // 碎沫团（无放射线，杜绝星形闪光）
      const a = rnd() * Math.PI * 2, r = 10 + rnd() * 34, rr = 3 + rnd() * 8;
      const bx = 64 + Math.cos(a) * r, by = 64 + Math.sin(a) * r;
      const gg = g.createRadialGradient(bx, by, 0, bx, by, rr);
      gg.addColorStop(0, 'rgba(255,255,255,0.55)'); gg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gg; g.beginPath(); g.arc(bx, by, rr, 0, 7); g.fill(); }
  }
  const splashTex = new THREE.CanvasTexture(splashCv);
  splashTex.colorSpace = THREE.SRGBColorSpace;
  const splashes = [];
  for (let i = 0; i < 80; i++) {   // 5 拍×3 + 64 土块入水都要水花：池 30 时大半崩落砸水无水花
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: splashTex, transparent: true, opacity: 0, depthWrite: false }));
    sp.scale.set(0.012, 0.012, 1); scene.add(sp); splashes.push(sp);
  }
  if (p.hideSplashes) splashes.forEach(sp => { sp.visible = false; });   // 诊断：藏水花二分荧光水线
  // 拍岸白浪时刻表（每拍 3 处，沿南岸脚确定性分布）
  const toeSpl = [];
  for (let j = 0; j < NHIT; j++) {
    const arr = [];
    for (let m = 0; m < 3; m++) arr.push({ fi: 0.08 + rnd() * 0.84, ph: rnd() * 0.02 });
    toeSpl.push(arr);
  }
  const toeFired = new Array(NHIT).fill(false);

  // ---- 浑水团（南岸贴岸下行）----
  const plumeCv = document.createElement('canvas');
  plumeCv.width = 256; plumeCv.height = 64;
  {
    const g = plumeCv.getContext('2d');
    g.fillStyle = 'rgba(110,84,50,0.0)'; g.fillRect(0, 0, 256, 64);
    for (let i = 0; i < 260; i++) { g.fillStyle = 'rgba(' + (115+rnd()*30|0) + ',' + (88+rnd()*22|0) + ',' + (52+rnd()*18|0) + ',' + (0.10+rnd()*0.16) + ')';
      const x = rnd() * 256, y = 20 + rnd() * 24;
      g.beginPath(); g.ellipse(x, y, 8 + rnd() * 22, 2 + rnd() * 5, 0, 0, 7); g.fill(); }
  }
  const plumeTex = new THREE.CanvasTexture(plumeCv);
  plumeTex.colorSpace = THREE.SRGBColorSpace;
  plumeTex.wrapS = THREE.RepeatWrapping; plumeTex.repeat.set(3, 1);
  const NP = 48, pPos = [], pIdx = [], pUv = [];
  for (let i = 0; i <= NP; i++) {
    const uu = Math.min(1, STAGE_U + (i / NP) * (1.6 / chanLen));
    const q = chanAt(Math.min(1, uu)), n = southAt(Math.min(1, uu));
    const wy = smoothWaterY(Math.min(1, uu)) + 0.0006;     // 浑水团贴平滑水面
    pPos.push(q.x + n.x * 0.075, wy, q.z + n.z * 0.075, q.x + n.x * 0.008, wy, q.z + n.z * 0.008);
    pUv.push(i / NP, 0, i / NP, 1);
    if (i < NP) { const a = i * 2; pIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.Float32BufferAttribute(pPos, 3));
  pGeo.setAttribute('uv', new THREE.Float32BufferAttribute(pUv, 2));
  pGeo.setIndex(pIdx);
  const plume = new THREE.Mesh(pGeo, new THREE.MeshBasicMaterial({
    map: plumeTex, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
  scene.add(plume);

  // ---- 泥沙北运浑水团（山南水北机制闭环的灵魂：南岸塌下的土，观众要亲眼看到它过河淤北岸）----
  const mudCv = document.createElement('canvas');
  mudCv.width = mudCv.height = 128;
  {
    const g = mudCv.getContext('2d');
    const rg = g.createRadialGradient(64, 64, 4, 64, 64, 62);
    rg.addColorStop(0, 'rgba(122,94,56,0.85)'); rg.addColorStop(0.55, 'rgba(112,86,50,0.40)');
    rg.addColorStop(1, 'rgba(105,80,46,0)');
    g.fillStyle = rg; g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 40; i++) { g.fillStyle = 'rgba(' + (100 + rnd() * 40 | 0) + ',' + (78 + rnd() * 26 | 0) + ',' + (46 + rnd() * 18 | 0) + ',' + (0.08 + rnd() * 0.12) + ')';
      g.beginPath(); g.ellipse(20 + rnd() * 88, 20 + rnd() * 88, 5 + rnd() * 14, 3 + rnd() * 8, rnd() * 3, 0, 7); g.fill(); }   // 絮状斑点：泥浆不是均匀色团
  }
  const mudTex = new THREE.CanvasTexture(mudCv);
  mudTex.colorSpace = THREE.SRGBColorSpace;
  const NMUD = 12, mudPuffs = [];
  for (let i = 0; i < NMUD; i++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: mudTex, transparent: true, opacity: 0, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; scene.add(m); mudPuffs.push(m);
  }
  // 确定性时刻表（setState 内禁 rnd：调用次数随帧率变，破坏确定性）
  const mudPlan = [];
  for (let j = 0; j < NHIT; j++) {
    const arr = [];
    for (let m2 = 0; m2 < 2; m2++) arr.push({ fi: 0.22 + rnd() * 0.56, ph: m2 * 0.035 + rnd() * 0.02, sz: 0.8 + rnd() * 0.5 });
    mudPlan.push(arr);
  }
  const mudState = mudPuffs.map(() => ({ k0: -1, x: 0, y: 0, z: 0, nx: 0, nz: 0, tx: 0, tz: 0, sz: 1 }));
  let mudCursor = 0;
  // 北岸淤晕：沙洲生长时周围水变浑——「泥到了，洲才长」的因果目击
  const hazeC = chanAt(0.84), hazeN = southAt(0.84);
  const northHaze = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: mudTex, transparent: true, opacity: 0, depthWrite: false }));
  northHaze.rotation.x = -Math.PI / 2;
  northHaze.position.set(hazeC.x - hazeN.x * 0.05, smoothWaterY(0.84) + 0.001, hazeC.z - hazeN.z * 0.05);
  scene.add(northHaze);

  // ---- 北岸沙洲（淤高出水，stage 下游 0.3-1.2km）----
  const BAR_U0 = 0.815, BAR_U1 = 0.87;
  const NB = 70, NBJ = 8;
  const barGeo = new THREE.BufferGeometry();
  const barPos = new Float32Array((NB + 1) * (NBJ + 1) * 3);
  const barCol = new Float32Array((NB + 1) * (NBJ + 1) * 3);
  const barIdx = [];
  const barBase = [];
  for (let i = 0; i <= NB; i++) {
    const u = BAR_U0 + (BAR_U1 - BAR_U0) * i / NB;
    const q = chanAt(u), n = southAt(u);
    barBase.push({ q, n, wy: smoothWaterY(u) });           // 沙洲水位基准与平滑水面同源
    for (let j = 0; j <= NBJ; j++) {
      const a = i * (NBJ + 1) + j, v = j / NBJ;
      const wet = 1 - 0.35 * Math.abs(v - 0.5) * 2;       // 边缘湿沙色深
      barCol[a * 3] = wet; barCol[a * 3 + 1] = wet * 0.97; barCol[a * 3 + 2] = wet * 0.9;
      if (i < NB && j < NBJ) { const b = a;
        barIdx.push(b, b + NBJ + 1, b + 1, b + 1, b + NBJ + 1, b + NBJ + 2); }
    }
  }
  const sandCv = document.createElement('canvas');
  sandCv.width = sandCv.height = 256;
  {
    const g = sandCv.getContext('2d');
    g.fillStyle = '#dcc79b'; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 6000; i++) { g.fillStyle = 'rgba(' + (120+rnd()*50|0) + ',' + (100+rnd()*42|0) + ',' + (66+rnd()*30|0) + ',' + (0.10+rnd()*0.14) + ')';
      g.fillRect(rnd() * 256, rnd() * 256, 1 + rnd() * 2, 1 + rnd() * 2); }
  }
  const sandTex = new THREE.CanvasTexture(sandCv);
  sandTex.colorSpace = THREE.SRGBColorSpace;
  sandTex.wrapS = sandTex.wrapT = THREE.RepeatWrapping; sandTex.repeat.set(4, 1);
  const barUvArr = new Float32Array((NB + 1) * (NBJ + 1) * 2);
  for (let i = 0; i <= NB; i++) for (let j = 0; j <= NBJ; j++) {
    const a = i * (NBJ + 1) + j; barUvArr[a * 2] = i / NB; barUvArr[a * 2 + 1] = j / NBJ; }
  barGeo.setAttribute('position', new THREE.BufferAttribute(barPos, 3));
  barGeo.setAttribute('uv', new THREE.BufferAttribute(barUvArr, 2));
  barGeo.setAttribute('color', new THREE.BufferAttribute(barCol, 3));
  barGeo.setIndex(barIdx);
  const bar = new THREE.Mesh(barGeo, new THREE.MeshStandardMaterial({
    map: sandTex, vertexColors: true, roughness: 1, metalness: 0 }));
  bar.receiveShadow = true;
  scene.add(bar);
  function barUpdate(grow) {
    for (let i = 0; i <= NB; i++) {
      const B = barBase[i];
      const gi = clamp01((grow * 1.35 - (i / NB) * 0.55) / 0.55);   // 从上游向下游长
      for (let j = 0; j <= NBJ; j++) {
        const v = j / NBJ, a = (i * (NBJ + 1) + j) * 3;
        const off = -(0.052 + 0.066 * Math.sin(v * Math.PI) * gi + 0.012 * v * gi);
        const crown = Math.sin(v * Math.PI);
        const y = B.wy - 0.003 + gi * (0.0042 * crown + 0.0005);
        barPos[a] = B.q.x + B.n.x * off;
        barPos[a + 1] = y;
        barPos[a + 2] = B.q.z + B.n.z * off;
      }
    }
    barGeo.attributes.position.needsUpdate = true;
    barGeo.computeVertexNormals();
  }
  barUpdate(0);

  // ---- 流向箭头（拍1：水往右偏）----
  const arrowCv = document.createElement('canvas');
  arrowCv.width = 256; arrowCv.height = 128;
  {
    const g = arrowCv.getContext('2d');
    g.strokeStyle = 'rgba(255,255,255,0.95)'; g.fillStyle = 'rgba(255,255,255,0.95)';
    g.lineWidth = 14; g.lineCap = 'round';
    g.beginPath(); g.moveTo(20, 34); g.quadraticCurveTo(150, 40, 205, 78); g.stroke();
    g.beginPath(); g.moveTo(236, 92); g.lineTo(186, 92); g.lineTo(208, 52); g.closePath(); g.fill();
  }
  const arrowTex = new THREE.CanvasTexture(arrowCv);
  arrowTex.colorSpace = THREE.SRGBColorSpace;
  const arrows = [];
  for (let i = 0; i < 4; i++) {
    const u = 0.40 + i * 0.055;
    const q = chanAt(u), n = southAt(u), t = tanAt(u);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.38, 0.19),
      new THREE.MeshBasicMaterial({ map: arrowTex, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
    const dx = t.x * 0.8 + n.x * 0.6, dz = t.z * 0.8 + n.z * 0.6;   // 下游+向右（南）
    m.rotation.set(-Math.PI / 2, 0, Math.atan2(-dz, dx));
    m.position.set(q.x + n.x * 0.01, smoothWaterY(u) + 0.003, q.z + n.z * 0.01);
    scene.add(m); arrows.push(m);
  }

  // ---- 字卡 ----
  function textSprite(str, fg, scaleW) {
    const cv = document.createElement('canvas');
    cv.width = 640; cv.height = 200;
    const g2 = cv.getContext('2d');
    g2.font = '600 84px "RuyiSmiley", sans-serif';
    g2.textAlign = 'center'; g2.textBaseline = 'middle';
    g2.shadowColor = 'rgba(6,10,16,0.9)'; g2.shadowBlur = 18;
    g2.fillStyle = fg; g2.fillText(str, 320, 100);
    const t2 = new THREE.CanvasTexture(cv);
    t2.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: t2, transparent: true, opacity: 0, depthWrite: false }));
    sp.scale.set(scaleW, scaleW * 200 / 640, 1);
    scene.add(sp);
    return sp;
  }
  const southLbl = textSprite('南岸 · 被水掏', '#ff8a76', 0.034);   // 48m→34m：贴水机位 48m 字卡横跨半屏
  southLbl.position.set(stageC.x + stageN.x * 0.10 + stageT.x * 0.06, waterY0 + 0.018,
                        stageC.z + stageN.z * 0.10 + stageT.z * 0.06);   // 悬在岸顶上方、随 KF1/KF2 视线入画
  // 真沙洲（弯道内侧，影像可见）：字卡钉在它上面
  const realBarN = southAt(0.72);
  const realBarC = chanAt(0.72).addScaledVector(realBarN, -0.12);
  const northLbl = textSprite('北岸 · 越垫越高', '#ffd27a', 0.20);
  northLbl.position.set(realBarC.x, waterY0 + 0.026, realBarC.z);

  // ---- 底部解读字幕条（DOM overlay：renderer pixelRatio=1，CSS px 即截图 px，无 dpr 坑）----
  const HL = (s) => '<span style="color:#ffd27a">' + s + '</span>';
  const CAPTIONS = [                                   // 一句一机制，灵魂句收尾：南岸退、北岸长，所以城在水北
    { k0: 0.020, k1: 0.220, html: '渭河穿过关中平原，一路裹挟着黄土的泥沙' },
    { k0: 0.270, k1: 0.395, html: '南岸，是一道 ' + HL('18 米') + ' 高的黄土立崖' },
    { k0: 0.415, k1: 0.530, html: '水一涨，浪就往崖脚' + HL('掏') },
    { k0: 0.550, k1: 0.680, html: '掏空了，就' + HL('塌') },
    { k0: 0.720, k1: 0.850, html: '塌下来的土，在河湾' + HL('北岸') + '淤成新地' },
    { k0: 0.870, k1: 0.995, html: '南岸在后退，北岸在生长——所以，城在' + HL('水北') },
  ];
  const capEl = document.createElement('div');
  capEl.style.cssText = 'position:fixed;left:0;right:0;bottom:7%;text-align:center;' +
    'font:600 46px "RuyiSmiley", sans-serif;color:#fff;letter-spacing:2px;' +
    'text-shadow:0 2px 16px rgba(0,0,0,0.9),0 0 6px rgba(0,0,0,0.8);opacity:0;pointer-events:none;';
  document.body.appendChild(capEl);

  // ---- 相机：关键帧分段插值（贴水面拍，节拍对齐：俯冲到位才开塌）----
  const lookBank = stageC.clone().addScaledVector(stageN, 0.078); lookBank.y = waterY0 + 0.003;
  const kf3q = chanAt(0.765), kf3n = southAt(0.765);
  // 贴水段必须沿河道走：stage 段河道弯 20-30°，用 stageC+stageT 直线外推 130m 会偏进主槽 30m+，
  // 「正南 36m」落点从崖脚变成河心水面——崖面缩成远处一条，被水花/雾气一盖即「消失」（灰带帧真根因判例）
  const kf1u = STAGE_U - du * 0.04, kf2u = STAGE_U + du * 0.18;   // 贴水横移 50m/8s：130m 崖面纹理横滚眼睛跟不上（五审判例）
  const kf1q = chanAt(kf1u), kf1n = southAt(kf1u);
  const kf2q = chanAt(kf2u), kf2n = southAt(kf2u);
  const KF = [
    { k: 0.00, pos: new THREE.Vector3(stageC.x - stageT.x * 2.6 + stageN.x * 1.3, groundY(stageC.x, stageC.z) + 1.3, stageC.z - stageT.z * 2.6 + stageN.z * 1.3),
      look: stageC.clone().addScaledVector(stageT, 0.6).setY(waterY0) },
    { k: 0.26, pos: new THREE.Vector3(kf1q.x + kf1n.x * 0.042, waterY0 + 0.0025, kf1q.z + kf1n.z * 0.042),
      look: new THREE.Vector3(kf1q.x + kf1n.x * 0.078, waterY0 + 0.008, kf1q.z + kf1n.z * 0.078) },   // 贴水 2.5m、距崖 36m，仰视 18m 崖面
    { k: 0.62, pos: new THREE.Vector3(kf2q.x + kf2n.x * 0.042, waterY0 + 0.0025, kf2q.z + kf2n.z * 0.042),
      look: new THREE.Vector3(kf2q.x + kf2n.x * 0.078, waterY0 + 0.008, kf2q.z + kf2n.z * 0.078) },   // 下游 130m 弧长处，仍贴岸 36m 正南看崖
    { k: 0.78, pos: new THREE.Vector3(kf3q.x - kf3n.x * 0.16, waterY0 + 0.055, kf3q.z - kf3n.z * 0.16),
      look: realBarC.clone().setY(waterY0 + 0.003) },
    { k: 1.00, pos: new THREE.Vector3(stageC.x + stageT.x * 0.30 - stageN.x * 0.70, waterY0 + 0.28, stageC.z + stageT.z * 0.30 - stageN.z * 0.70),
      look: chanAt(0.86).setY(waterY0) },
  ];
  const camPosAt = (k) => {
    for (let s = 0; s < KF.length - 1; s++) {
      const a = KF[s], b = KF[s + 1];
      if (k <= b.k || s === KF.length - 2) {
        const f = smooth((k - a.k) / (b.k - a.k));
        return { pos: a.pos.clone().lerp(b.pos, f), look: a.look.clone().lerp(b.look, f) };
      }
    }
  };
  camera.near = p.camNear ?? 0.002;   // 默认 0.1=100m 会把贴水机位 100m 内的水面/崖面全部裁掉（红水判例）
  camera.fov = p.camFov ?? 46;
  camera.far = 160;
  camera.updateProjectionMatrix();

  const T = CFG.duration;
  const splashState = splashes.map(() => ({ k0: -1, x: 0, y: 0, z: 0 }));
  let splashCursor = 0;
  return (t) => {
    const k = clamp01(t / T);
    if (p.debugCam === 'kf1top') {                         // 诊断：KF1 机位正上方俯视，红水 coverage 一目了然
      bankUpdate(smooth((k - HIT0) / (HIT1 - HIT0)));
      barUpdate(smooth((k - 0.70) / 0.17));
      waterUniforms.uT.value = t;
      camera.position.set(KF[1].pos.x, waterY0 + 0.50, KF[1].pos.z);
      camera.lookAt(KF[1].pos.x, waterY0, KF[1].pos.z + 0.001);
      return;
    }
    if (p.debugCam === 'kf2') {                            // 诊断：冻结 KF2 机位（荧光水线二分）
      bankUpdate(smooth((k - HIT0) / (HIT1 - HIT0)));
      barUpdate(smooth((k - 0.70) / 0.17));
      waterUniforms.uT.value = t;
      camera.position.copy(KF[2].pos); camera.lookAt(KF[2].look);
      return;
    }
    if (p.debugCam === 'kf1') {                            // 诊断：冻结 KF1 机位，红水/正水皆可，二分 shader 与遮挡
      bankUpdate(smooth((k - HIT0) / (HIT1 - HIT0)));
      barUpdate(smooth((k - 0.70) / 0.17));
      waterUniforms.uT.value = t;
      camera.position.copy(KF[1].pos); camera.lookAt(KF[1].look);
      return;
    }
    if (p.debugCam) {                                      // 诊断机位：高位固定斜视舞台，看清水/岸/洲/地形关系
      bankUpdate(smooth((k - HIT0) / (HIT1 - HIT0)));
      barUpdate(smooth((k - 0.70) / 0.17));
      waterUniforms.uT.value = t;
      camera.position.set(stageC.x - stageT.x * 0.35 - stageN.x * 0.28, waterY0 + 0.32,
                          stageC.z - stageT.z * 0.35 - stageN.z * 0.28);
      camera.lookAt(stageC.x + stageN.x * 0.04, waterY0, stageC.z + stageN.z * 0.04);
      return;
    }
    // 节拍
    const ero = smooth((k - HIT0) / (HIT1 - HIT0));       // 掏蚀进度
    bankUpdate(ero);
    const grow = smooth((k - 0.70) / 0.17);               // 沙洲淤高
    barUpdate(grow);
    waterUniforms.uT.value = t;
    // 涌浪脉冲双通道：尖锐泡沫峰（exp*26≈0.4s）与沉重浮沉（exp*7）分离——
    // 合并时长余震槽底 0.57 会把「瞬态白」拉成常驻白带；6.8Hz±4m 抖镜会把贴水相机压进水下=全屏灰绿频闪（入水频闪判例）
    let surgeFoam = 0, shake = 0;
    for (const hk of hitKs) {
      const dk = k - hk;
      if (dk > 0) {
        surgeFoam = Math.max(surgeFoam, Math.exp(-dk * 26));
        shake += Math.exp(-dk * 5) * Math.sin(t * 4.5 + hk * 91);   // 沉重低频：±1m@2.5m 贴水机位=构图跳变「闪」（拍岸期灰带帧判例），压到 ±0.3m
      }
    }
    waterUniforms.uSurge.value = surgeFoam * smooth((k - HIT0) / 0.05);
    // 拍岸白浪：每拍 3 处南岸脚水花（确定性时刻表）
    for (let j = 0; j < NHIT; j++) {
      if (toeFired[j] || k < hitKs[j]) continue;
      toeFired[j] = true;
      for (const d of toeSpl[j]) {
        if (splashCursor >= splashes.length) break;
        const s = splashState[splashCursor++];
        s.k0 = k + d.ph;
        const i0 = Math.min(NU, Math.max(0, Math.round(d.fi * NU)));
        const B = bBase[i0];
        const toeOff = 0.076 + (B.e || 0) * NOTCH;          // 贴掏槽槽脚：白浪掏进凹槽，不悬浮成孤立水球
        s.x = B.q.x + B.n.x * toeOff; s.y = B.wy + 0.002; s.z = B.q.z + B.n.z * toeOff;
      }
      // 泥沙北运：每拍 2 团浑水从崩塌段崖脚启程，过河去北岸
      for (const d of mudPlan[j]) {
        if (mudCursor >= NMUD) break;
        const ms = mudState[mudCursor++];
        ms.k0 = k + d.ph; ms.sz = d.sz;
        const i0 = Math.min(NU, Math.max(0, Math.round(d.fi * NU)));
        const B = bBase[i0], B2 = bBase[Math.min(NU, i0 + 1)];
        ms.x = B.q.x + B.n.x * 0.075; ms.y = B.wy + 0.001; ms.z = B.q.z + B.n.z * 0.075;
        ms.nx = B.n.x; ms.nz = B.n.z;
        const tx = B2.q.x - B.q.x, tz = B2.q.z - B.q.z, tl = Math.hypot(tx, tz) || 1;   // 河道切向=下行方向
        ms.tx = tx / tl; ms.tz = tz / tl;
      }
    }
    // 土块状态机
    for (let c = 0; c < NCH; c++) {
      const C = chDef[c];
      const dk = k - C.k0;
      const i0 = Math.min(NU, Math.max(0, Math.round(C.fi * NU)));
      const B = bBase[i0];
      if (dk < 0) {                                        // 未脱落：嵌在立面，临落前 1.3s 挤出墙面（避免全程贴片感）
        const off = 0.078 + 0.026 * Math.pow(C.v0, 1.3);
        const swell = smooth((dk + 0.06) / 0.06);
        SV.set(B.q.x + B.n.x * (off - 0.008 + 0.006 * swell), B.wy - 0.004 + (B.topY - B.wy + 0.004) * C.v0, B.q.z + B.n.z * (off - 0.008 + 0.006 * swell));
        Q.setFromAxisAngle(C.ax, 0);
        M4.compose(SV, Q, new THREE.Vector3(C.size * swell, C.size * swell, C.size * swell));
      } else if (dk < 0.055) {                             // 坠落（k 域 0.055 ≈ 1.2s）
        const f = dk / 0.055;
        const off0 = 0.078 + 0.026 * Math.pow(C.v0, 1.3) - 0.002;
        const off = off0 - f * (off0 - 0.052);             // 落向河心
        const y0 = B.wy - 0.004 + (B.topY - B.wy + 0.004) * C.v0;
        const yDrop = (y0 - (B.wy - 0.006)) * f * f;       // 重力加速落水
        SV.set(B.q.x + B.n.x * off + B.n.z * C.lat * 0.01 * f, y0 - yDrop, B.q.z + B.n.z * off - B.n.x * C.lat * 0.01 * f);
        Q.setFromAxisAngle(C.ax, C.spin * f);
        M4.compose(SV, Q, new THREE.Vector3(C.size, C.size, C.size));
      } else {                                             // 入水下沉消失 + 触发水花（每块一次）
        if (!C.splashed) {
          C.splashed = true;
          if (splashCursor < splashes.length) {
            const s = splashState[splashCursor++];
            s.k0 = k;
            const off = 0.052;
            s.x = B.q.x + B.n.x * off; s.y = B.wy + 0.002; s.z = B.q.z + B.n.z * off;
          }
        }
        M4.compose(SV.set(0, -50, 0), Q, new THREE.Vector3(0.001, 0.001, 0.001));
      }
      chunks.setMatrixAt(c, M4);
    }
    chunks.instanceMatrix.needsUpdate = true;
    // 水花
    for (let i = 0; i < splashes.length; i++) {
      const s = splashState[i], sp = splashes[i];
      if (s.k0 < 0) continue;
      const f = (k - s.k0) / 0.045;
      if (f < 0) continue;
      if (f > 1) { sp.material.opacity = 0; continue; }
      sp.position.set(s.x, s.y + f * 0.004, s.z);
      const sc = 0.005 + f * 0.007;                       // ≤12m：18m 大球 38m 外张角 26°>fov 半高，整朵糊住崖面视野=灰罩「闪」（四审判例）
      sp.scale.set(sc * 1.8, sc * 0.55, 1);               // 压扁贴脚：读作「沿崖脚一条白浪」而非悬浮灰球
      // 距离保护：任何机位下 30m 内水花淡出——Billboard 贴脸=全屏半透明灰罩
      const dcam = Math.hypot(s.x - camera.position.x, s.z - camera.position.z);
      const nearF = Math.min(1, Math.max(0, (dcam - 0.012) / 0.018));
      sp.material.opacity = 0.62 * (1 - f) * nearF;
    }
    // 浑水团北运：崖脚→过河心→北岸侧，~4s 扩散消隐；收尾段沙洲晕随 grow 变浑
    for (let i = 0; i < NMUD; i++) {
      const ms = mudState[i], mp = mudPuffs[i];
      if (ms.k0 < 0) continue;
      const f = (k - ms.k0) / 0.18;                         // k 域 0.18 ≈ 4s：走得慢才读得出「运」
      if (f < 0) continue;
      if (f > 1) { mp.material.opacity = 0; continue; }
      mp.position.set(ms.x - ms.nx * 0.115 * f + ms.tx * 0.045 * f, ms.y,
                      ms.z - ms.nz * 0.115 * f + ms.tz * 0.045 * f);   // 北移 115m + 下行 45m
      const sc = (0.008 + f * 0.040) * ms.sz;               // 8m → 48m 扩散
      mp.scale.set(sc, sc, 1);
      mp.material.opacity = 0.55 * (1 - f) * Math.min(1, f / 0.08);
    }
    northHaze.material.opacity = grow * 0.38;               // 泥到洲长：沙洲生长期周围水变浑
    northHaze.scale.set(0.030 + grow * 0.070, 0.030 + grow * 0.070, 1);
    // 浑水团
    plume.material.opacity = 0.55 * smooth((k - 0.36) / 0.10) * (1 - smooth((k - 0.90) / 0.08));
    plumeTex.offset.x = -t * 0.010;                       // 浑水团下移 ~15m/s，与主槽流速一致（原 48m/s 泥浆飞流判例）
    // 箭头（拍1）/ 字卡
    const aIn = smooth((k - 0.04) / 0.08) * (1 - smooth((k - 0.28) / 0.05));
    arrows.forEach((m, i) => { m.material.opacity = aIn * (0.55 + 0.45 * Math.sin(t * 3 + i * 1.7)); });
    southLbl.material.opacity = smooth((k - 0.40) / 0.06) * (1 - smooth((k - 0.68) / 0.05));   // 首拍落地后再出，避让浪峰
    northLbl.material.opacity = smooth((k - 0.70) / 0.06);
    // 解读字幕条：一句一换，逐帧手控 opacity（逐帧截图下 CSS transition 不可控）
    let capOn = null;
    for (const C of CAPTIONS) if (k >= C.k0 && k <= C.k1) { capOn = C; break; }
    if (capOn) {
      if (capEl.innerHTML !== capOn.html) capEl.innerHTML = capOn.html;
      capEl.style.opacity = Math.min(smooth((k - capOn.k0) / 0.022),
        1 - smooth((k - capOn.k1 + 0.020) / 0.020)).toFixed(3);
    } else if (capEl.style.opacity !== '0') { capEl.style.opacity = '0'; }
    // 相机 + 拍岸微震
    const cam = camPosAt(k);
    camera.position.copy(cam.pos);
    if (p.camLog) {   // 诊断：相机位置/朝向数值实锤（画面推断≠数值，先定位再动手判例）
      const d = cam.look.clone().sub(cam.pos);
      console.warn('CAM k=' + k.toFixed(3),
        'pos=' + cam.pos.toArray().map(v => v.toFixed(4)).join(','),
        'look=' + cam.look.toArray().map(v => v.toFixed(4)).join(','),
        'stageC=' + stageC.toArray().map(v => v.toFixed(3)).join(','),
        'dir=' + d.normalize().toArray().map(v => v.toFixed(3)).join(','),
        'y-water=' + (cam.pos.y - waterY0).toFixed(4));
    }
    camera.position.y += shake * 0.0003;                  // 拍岸浮沉 ±0.3m：±1m 在贴水掠射构图=前景占比帧间跳变（闪），±4m 会扎进水里
    camera.position.x += shake * 0.0002 * Math.sin(t * 3.5);
    camera.position.y = Math.max(camera.position.y, waterY0 + 0.0012);   // 永不入水硬 clamp：贴水机位入水=全屏灰绿频闪
    camera.lookAt(cam.look);
  };
}

// arctic_wall  北极围墙（warming-cold-snap S1/S2 hero）
//   北极俯视：云图质感旋转围墙环绕极地 → 北极"发烧"红化增强 → 围墙变矮变薄 →
//   朝目标经度塌口 → 寒气（云图质感 sprite 群，非液体洪水，判死线自律）南漫目标大陆。
//   params: { phase:'fever'|'full', wallLat, breachLon, targetLat, targetLon,
//             shrinkT:[t0,t1], breachT:[t0,t1], flowT:[t0,t1], showGrid }
async function buildArcticWall(p) {
  const phase = p.phase || 'full';
  const wallLat = p.wallLat ?? 62, breachLon = p.breachLon ?? -100;
  const targetLat = p.targetLat ?? 45, targetLon = p.targetLon ?? -100;
  const shrinkT = p.shrinkT || [6, 12], breachT = p.breachT || [12, 14], flowT = p.flowT || [14, 22];
  const LAYERS = (p.layers || 'wall,rim,pool,pool2,inner,puffs,fever,earth').split(',');
  const hasL = (n) => LAYERS.includes(n);
  const R = 1;

  // —— 确定性工具：LCG + 值噪声 fbm ——
  let seed = 20260910;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const hash2 = (x, y) => {
    let h = (x * 374761393 + y * 668265263) | 0; h = (h ^ (h >> 13)) * 1274126177;
    return ((h ^ (h >> 16)) >>> 0) / 4294967295;
  };
  const vnoise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    return hash2(xi, yi) * (1 - u) * (1 - v) + hash2(xi + 1, yi) * u * (1 - v)
         + hash2(xi, yi + 1) * (1 - u) * v + hash2(xi + 1, yi + 1) * u * v;
  };
  const fbm = (x, y, oct = 3) => {
    let a = 0, amp = 0.5, f = 1;
    for (let i = 0; i < oct; i++) { a += amp * vnoise(x * f, y * f); amp *= 0.5; f *= 2.03; }
    return a / (1 - Math.pow(0.5, oct)) * (1 - 0.5) * 2; // ≈[0,1]
  };
  const sstep = (a, b, x) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); };

  // 经纬 → 球面三维（three SphereGeometry 贴图约定：u=0 对应经度 -180）
  const lonLatToVec = (lat, lon, r) => {
    const phi = (90 - lat) * Math.PI / 180, th = (lon + 180) * Math.PI / 180;
    return new THREE.Vector3(-r * Math.cos(th) * Math.sin(phi), r * Math.cos(phi), r * Math.sin(th) * Math.sin(phi));
  };

  // —— 世界：星空 + 地球（冷冽影调）——
  const sky = await tex('assets/space/textures/8k_stars_milky_way.jpg');
  sky.mapping = THREE.EquirectangularReflectionMapping; scene.background = sky;
  const dayT = await tex('assets/space/textures/8k_earth_daymap.jpg');
  const earth = new THREE.Mesh(new THREE.SphereGeometry(R, 96, 96),
    new THREE.MeshStandardMaterial({ map: dayT, roughness: 1, metalness: 0, color: 0xd8dce8 }));
  if (hasL('earth')) scene.add(earth);
  const sun = new THREE.DirectionalLight(0xfff2d8, 1.8); sun.position.set(1.5, 4, 1); scene.add(sun);
  scene.add(new THREE.AmbientLight(0x2a3a5c, 0.8));

  // —— 围墙云带纹理（横向周期噪声，无接缝）——
  function wallTexture() {
    const W = 1024, H = 128, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d'), img = g.createImageData(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const u = x / W;
      const ang = u * Math.PI * 2 + (y / H - 0.5) * 0.9;   // 螺旋扭曲，像急流云系
      const nx = Math.cos(ang) * 1.15 + 5, ny = Math.sin(ang) * 1.15 + 5;
      const n = fbm(nx * 1.6 + y / H * 4.2, ny * 1.6 + y / H * 1.2, 3);
      const vFade = Math.sin((y / H) * Math.PI);
      const body = Math.max(0, n - 0.16) * 2.5 * vFade;
      const idx = (y * W + x) * 4;
      img.data[idx] = 130 + Math.floor(110 * n);
      img.data[idx + 1] = 175 + Math.floor(70 * n);
      img.data[idx + 2] = 255;
      img.data[idx + 3] = Math.min(255, Math.floor(body * 300));
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(cv); t.wrapS = THREE.RepeatWrapping; return t;
  }
  const wallTex = wallTexture();

  // —— 围墙：48 段平躺环带（RingGeometry，UV 重算为角向/径向），俯视可读 ——
  const SEG = 48;
  const wallR = R * Math.cos(wallLat * Math.PI / 180) * 1.06;
  const wallY = R * Math.sin(wallLat * Math.PI / 180);
  const R_IN = wallR * 0.86, R_OUT = wallR * 1.2, segs = [];
  // 塌口 alphaMap（rim 与云带共享）：声明必须在使用之前
  const alphaCv = document.createElement('canvas'); alphaCv.width = 1024; alphaCv.height = 8;
  const alphaG = alphaCv.getContext('2d');
  const gapTex = new THREE.CanvasTexture(alphaCv); gapTex.wrapS = THREE.RepeatWrapping;
  {
    const geo = new THREE.RingGeometry(R_IN, R_OUT, 128, 1, 0, Math.PI * 2);
    // UV 重算：(角向 u, 径向 v)
    const pos = geo.attributes.position, uv = geo.attributes.uv;
    for (let vi = 0; vi < pos.count; vi++) {
      const px = pos.getX(vi), py = pos.getY(vi);
      const rr = Math.sqrt(px * px + py * py);
      let aa = Math.atan2(py, px); if (aa < 0) aa += Math.PI * 2;
      uv.setXY(vi, aa / (Math.PI * 2), (rr - R_IN) / (R_OUT - R_IN));
    }
    const mat = new THREE.MeshBasicMaterial({ map: wallTex, transparent: true, opacity: 0.55,
      alphaMap: gapTex, side: THREE.DoubleSide, depthWrite: false });
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2; m.position.y = wallY + 0.02; m.renderOrder = 2;
    if (hasL('wall')) scene.add(m); segs.push(m);
  }
  // 外缘晕环（整环单 mesh），与云带墙共享 gapTex 塌口
  const rimGeo = new THREE.RingGeometry(R_OUT * 0.95, R_OUT * 1.05, 128, 1, 0, Math.PI * 2);
  {
    const pos = rimGeo.attributes.position, uv = rimGeo.attributes.uv;
    for (let vi = 0; vi < pos.count; vi++) {
      const px = pos.getX(vi), py = pos.getY(vi);
      let aa = Math.atan2(py, px); if (aa < 0) aa += Math.PI * 2;
      uv.setXY(vi, aa / (Math.PI * 2), 0.5);
    }
  }
  const rim = new THREE.Mesh(rimGeo, new THREE.MeshBasicMaterial({ color: 0x9fd0ff, transparent: true,
    opacity: 0.35, alphaMap: gapTex, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }));
  rim.rotation.x = -Math.PI / 2; rim.position.y = wallY + 0.025; rim.renderOrder = 2.5;
  if (hasL('rim')) scene.add(rim);
  // RingGeometry 在 XY 平面，theta 从 +X 逆时针；rotation.x=-π/2 后 +X 保持、+Y→-Z。
  // lonLatToVec 中经度角 th 从 -X 起算（x=-cos(th)）→ 段 i 中心角 θc=(i+.5)/SEG*2π 对应
  // 三维方向 (cosθc, 0, -sinθc)。诊断校准 breachIdx：
  const lonToRingTheta = (lon) => { const v = lonLatToVec(0, lon, 1); return Math.atan2(-v.z, v.x); };
  const breachTheta = lonToRingTheta(breachLon);
  let breachIdx = 0, best = 1e9;
  for (let i = 0; i < SEG; i++) {
    const tc = ((i + 0.5) / SEG) * Math.PI * 2;
    let d = Math.abs(tc - breachTheta); d = Math.min(d, Math.PI * 2 - d);
    if (d < best) { best = d; breachIdx = i; }
  }

  // —— 寒气池（极冠球冠，极坐标云涡纹理）——
  function poolTexture() {
    const W = 1024, H = 256, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d'), img = g.createImageData(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const u = x / W, ang = u * Math.PI * 2;
      const rr = y / H;                                    // 0=边缘 → 1=极点
      let fx = Math.cos(ang) * 2.5 + 11, fy = Math.sin(ang) * 2.5 + 11;
      fx = fx * 2 + rr * 2.7; fy = fy * 2 + rr * 1.9;
      const pinch = Math.pow(rr, 5);                       // 极点收束：所有经度采样趋同
      fx += (22.6 - fx) * pinch; fy += (23.1 - fy) * pinch;
      const n = fbm(fx, fy, 4);
      const idx = (y * W + x) * 4;
      img.data[idx] = 40 + Math.floor(130 * n);
      img.data[idx + 1] = 75 + Math.floor(150 * n);
      img.data[idx + 2] = 185 + Math.floor(70 * n);
      img.data[idx + 3] = Math.floor(Math.max(0, n - 0.2) * 1.55 * 210);
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(cv); t.wrapS = THREE.RepeatWrapping; return t;
  }
  const capAng = (90 - wallLat - 3) * Math.PI / 180;
  const poolTex1 = poolTexture();
  const pool = new THREE.Mesh(new THREE.SphereGeometry(R * 1.005, 64, 16, 0, Math.PI * 2, 0, capAng),
    new THREE.MeshBasicMaterial({ map: poolTex1, transparent: true, opacity: 0.7, depthWrite: false }));
  pool.renderOrder = 1;
  if (hasL('pool')) scene.add(pool);
  // 第二层碎云涡：不同频率、反向旋转、additive，双层错位=翻涌视差
  seed = 777;
  const pool2 = new THREE.Mesh(new THREE.SphereGeometry(R * 1.008, 64, 16, 0, Math.PI * 2, 0, capAng * 0.92),
    new THREE.MeshBasicMaterial({ map: poolTexture(), transparent: true, opacity: 0.45,
      blending: THREE.AdditiveBlending, depthWrite: false }));
  pool2.renderOrder = 1.5;
  if (hasL('pool2')) scene.add(pool2);

  // —— 北极红化（发烧 sprite，NormalBlending 深红，冰盖上也可读）——
  function feverTexture() {
    const S = 256, cv = document.createElement('canvas'); cv.width = cv.height = S;
    const g = cv.getContext('2d'), img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const dx = x - S / 2, dy = y - S / 2, r = Math.sqrt(dx * dx + dy * dy) / (S / 2);
      if (r > 1) continue;
      const n = fbm(dx / S * 5 + 3, dy / S * 5 + 3, 3);
      const a = Math.max(0, 1 - r) * (0.45 + 0.55 * n);
      const idx = (y * S + x) * 4;
      img.data[idx] = 235; img.data[idx + 1] = 45 + Math.floor(55 * n); img.data[idx + 2] = 35;
      img.data[idx + 3] = Math.floor(Math.pow(a, 1.6) * 255);
    }
    g.putImageData(img, 0, 0);
    return new THREE.CanvasTexture(cv);
  }
  const fever = new THREE.Sprite(new THREE.SpriteMaterial({ map: feverTexture(), transparent: true,
    depthWrite: false, opacity: 0 }));
  fever.scale.set(2.1, 2.1, 1); fever.position.set(0, R * 1.03, 0); fever.renderOrder = 4;
  scene.add(fever);

  // —— 南漫云团：锋面弧带推进（卫星云图质感，判死线自律：禁液体/禁白团）——
  function puffTexture() {
    const S = 256, cv = document.createElement('canvas'); cv.width = cv.height = S;
    const g = cv.getContext('2d'), img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const dx = x - S / 2, dy = y - S / 2, r = Math.sqrt(dx * dx + dy * dy) / (S / 2);
      if (r > 1) continue;
      const n = fbm(dx / S * 6 + 7, dy / S * 6 + 7, 4);
      const a = Math.max(0, 1 - r * (1.15 - 0.35 * n)) * (0.3 + 0.7 * n);
      const idx = (y * S + x) * 4;
      img.data[idx] = 95 + Math.floor(90 * n);
      img.data[idx + 1] = 145 + Math.floor(80 * n);
      img.data[idx + 2] = 255;
      img.data[idx + 3] = Math.floor(Math.pow(a, 1.5) * 220);
    }
    g.putImageData(img, 0, 0);
    return new THREE.CanvasTexture(cv);
  }
  const puffTex = puffTexture();
  const ROWS = 3, PER_ROW = 13, puffs = [];
  const breachPos = lonLatToVec(wallLat, breachLon, R * 1.03);
  for (let row = 0; row < ROWS; row++) for (let j = 0; j < PER_ROW; j++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTex, transparent: true,
      opacity: 0, depthWrite: false }));
    sp.renderOrder = 3;
    // 锋面弧线：每排一条垂直于推进方向的弧，散布角沿弧展开；逐排向南推进
    const spread = (j / (PER_ROW - 1) - 0.5);                    // -0.5..0.5
    const tLat = targetLat - row * 5 + (rnd() - 0.5) * 4;
    const tLon = targetLon + spread * 90 + (rnd() - 0.5) * 6;
    const dst = lonLatToVec(tLat, tLon, R * 1.04);
    puffs.push({ sp, dst, delay: row * 0.22 + rnd() * 0.08, sz: 0.24 + rnd() * 0.16 });
    scene.add(sp);
  }

  // —— 墙内翻滚云团（活物感）：圆环轨道公转+半径呼吸，塌口后向缺口泄出 ——
  const NIN = 10, innerPuffs = [];
  for (let i = 0; i < NIN; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTex, transparent: true,
      opacity: 0.35, depthWrite: false }));
    sp.renderOrder = 2.2;
    innerPuffs.push({ sp, ph: (i / NIN) * Math.PI * 2 + rnd() * 0.6, rr: 0.45 + rnd() * 0.4,
      sz: 0.16 + rnd() * 0.14, spd: 0.1 + rnd() * 0.08 });
    scene.add(sp);
  }

  // —— 诊断：经纬网格标记 ——
  if (p.showGrid) {
    for (const [la, lo, c] of [[90, 0, 0xff0000], [wallLat, breachLon, 0x00ff00], [targetLat, targetLon, 0xffff00], [60, 0, 0xff00ff], [66.5, 90, 0x00ffff]]) {
      const mk = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 8), new THREE.MeshBasicMaterial({ color: c }));
      mk.position.copy(lonLatToVec(la, lo, R * 1.02)); scene.add(mk);
    }
  }

  // —— 运动与摄影（全是 t 的解析函数）——
  const targetDir = lonLatToVec(52, (breachLon + targetLon) / 2, 1); // 构图偏向目标半球
  return (t) => {
    // 相机：北极上空俯视，缓推；南漫段略抬远露出北美（北美位于画面下方="往南涌"）
    const push = sstep(0, 8, t), pull = phase === 'full' ? sstep(flowT[0], flowT[1], t) : 0;
    const alt = 3.1 - 0.3 * push + 0.5 * pull;
    const lat0 = 90 - (6 + 20 * pull);
    const axisTilt = lonLatToVec(lat0, (breachLon + targetLon) / 2, 1);
    camera.position.set(axisTilt.x * alt, axisTilt.y * alt, axisTilt.z * alt);
    const look = lonLatToVec(90 - 30 * pull, (breachLon + targetLon) / 2, 0.3);
    camera.lookAt(look.x, look.y, look.z);
    camera.up.set(-targetDir.x, 0, -targetDir.z).normalize();

    // 北极红化：全程增强+脉动
    const burn = phase === 'fever' ? sstep(0, 3, t) : Math.min(1, sstep(0, shrinkT[1], t) * 1.1);
    fever.material.opacity = burn * 0.32;
    pool.material.color.setRGB(1, 1 - 0.75 * burn * (0.85 + 0.15 * Math.sin(t * 2.6)), 1 - 0.62 * burn * (0.85 + 0.15 * Math.sin(t * 2.6)));

    // 围墙：旋转（纹理 offset）+ 变窄变淡（"风慢墙松"）+ 塌口
    const shrink = phase === 'full' ? sstep(shrinkT[0], shrinkT[1], t) : 0;
    const wob = shrink * 0.06 * Math.sin(t * 7.3);
    wallTex.offset.x = t * 0.045 * (1 - 0.75 * shrink) + wob * 0.3;  // 风慢=旋转减速
    const rScale = 1 - 0.22 * shrink;
    const breach = phase === 'full' ? sstep(breachT[0], breachT[1], t) : 0;
    segs[0].scale.set(rScale, rScale, 1);
    segs[0].material.opacity = 0.55 - 0.2 * shrink;
    rim.scale.set(rScale, rScale, 1);
    rim.material.opacity = 0.35 * (1 - 0.3 * shrink);
    // 塌口：重画 gapTex——breach 方位高斯凹口（云带与晕环同步断开）
    const breachU = ((breachTheta % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2);
    const img = alphaG.createImageData(1024, 8);
    for (let x = 0; x < 1024; x++) {
      const u = x / 1024;
      let dd = Math.abs(u - breachU); dd = Math.min(dd, 1 - dd);
      const notch = Math.exp(-Math.pow(dd / 0.05, 2));
      const a = Math.max(0, 1 - breach * notch);
      for (let y = 0; y < 8; y++) {
        const ii = (y * 1024 + x) * 4;
        img.data[ii] = img.data[ii + 1] = img.data[ii + 2] = 255;
        img.data[ii + 3] = Math.floor(a * 255);
      }
    }
    alphaG.putImageData(img, 0, 0); gapTex.needsUpdate = true;

    // 寒气池双层错位：底层慢转+纹理流动，顶层碎云反方向快转——翻涌视差
    const drain = phase === 'full' ? sstep(flowT[0], flowT[1], t) : 0;
    pool.rotation.y = t * 0.04 * (1 - 0.5 * shrink);
    poolTex1.offset.x = -t * 0.012;
    pool2.rotation.y = -t * 0.075 * (1 - 0.4 * shrink);
    pool.material.opacity = 0.7 - 0.28 * drain;
    pool2.material.opacity = 0.45 * (1 - 0.6 * drain);

    // 墙内翻滚：公转+呼吸；塌口后整体向缺口方位漂移泄出
    const leak = phase === 'full' ? sstep(breachT[0], flowT[1], t) : 0;
    const leakDir = lonLatToVec(wallLat - 4, breachLon, R * 1.04);
    for (const ip of innerPuffs) {
      const ang = ip.ph + t * ip.spd * (1 - 0.5 * shrink);
      const rr = ip.rr * wallR * (1 + 0.08 * Math.sin(t * 0.9 + ip.ph * 3));
      const bx = Math.cos(ang) * rr, bz = Math.sin(ang) * rr;
      const pos = new THREE.Vector3(bx, wallY + 0.06, bz);
      pos.lerp(leakDir, leak * 0.85);
      ip.sp.position.copy(pos);
      const isz = ip.sz * (1 + 0.15 * Math.sin(t * 1.3 + ip.ph));
      ip.sp.scale.set(isz, isz, 1);
      ip.sp.material.opacity = 0.35 * (1 - leak * 0.7) * (0.75 + 0.25 * Math.sin(t * 1.7 + ip.ph * 2));
    }

    // 南漫云团：锋面弧带按排推进
    if (phase === 'full') {
      const span = flowT[1] - flowT[0];
      for (const pf of puffs) {
        const k = sstep(flowT[0] + pf.delay * span * 0.6, flowT[0] + pf.delay * span * 0.6 + span * 0.5, t);
        if (k <= 0) { pf.sp.material.opacity = 0; continue; }
        const v = breachPos.clone().lerp(pf.dst, k);
        v.normalize().multiplyScalar(R * (1.03 + 0.06 * Math.sin(k * Math.PI)));
        pf.sp.position.copy(v);
        const s = pf.sz * (0.4 + 1.1 * k);
        pf.sp.scale.set(s, s, 1);
        pf.sp.material.opacity = 0.42 * Math.min(1, k * 2.5) * (1 - 0.2 * k);
      }
    }
  };
}

// —— 全省地形块 3D（ep06 川西 S0/S1 hero）：真实 DEM 整块浮雕+裙边压海平面=侧面厚度墙 ——
// 叙事：相机从东南低位斜视（成都平原前缘=薄边，横断山后景=高墙）→ 升高位斜俯上帝视角锁机位。
//       「薄→厚」即落差本体；高度夸张系数自由（主人：夸张一点无所谓，要的是落差）。
//       配色=青山绿水雪山（按真实海拔分带，不用卫星贴图）。
async function buildTerrainBlock(p) {
  const base = p.base;
  if (!base) throw new Error('terrain_block: params.base 必填（fetch_terrain_block 产物目录，服务器相对路径，如 examples/terrain-block-yading/data）');
  const meta = await (await fetch('/' + base + '/meta.json')).json();
  const buf = await (await fetch('/' + base + '/heights.f32')).arrayBuffer();
  const HG = new Float32Array(buf);          // 行 0 = 北缘(lat1)，列 0 = 西缘(lon0)

  const midLat = (meta.lat0 + meta.lat1) / 2;
  const KM_LAT = 110.6, KM_LON = 111.3 * Math.cos(midLat * Math.PI / 180);
  const SCALE = 100;                          // 场景单位 = 100km
  const spanX = (meta.lon1 - meta.lon0) * KM_LON / SCALE;
  const spanZ = (meta.lat1 - meta.lat0) * KM_LAT / SCALE;
  const EXAG = p.exaggeration ?? 45;
  const STEP = p.step ?? 4;
  const gc = Math.floor(meta.w / STEP), gr = Math.floor(meta.h / STEP);
  const HY = (h) => h / 1000 / SCALE * EXAG;  // 米 → 场景高

  // 降采样 + 箱式模糊(两遍)：抹平 z9 DEM 碎噪，块面读感=抛光沙盘（盆地平=薄边故事才立）
  let HDS = new Float32Array(gc * gr);
  for (let r = 0; r < gr; r++)
    for (let c = 0; c < gc; c++) HDS[r * gc + c] = HG[(r * STEP) * meta.w + c * STEP];
  const boxBlur = (src, radius) => {
    const dst = new Float32Array(gc * gr);
    for (let r = 0; r < gr; r++)
      for (let c = 0; c < gc; c++) {
        let s = 0, n = 0;
        for (let dr = -radius; dr <= radius; dr++)
          for (let dc = -radius; dc <= radius; dc++) {
            const rr = r + dr, cc = c + dc;
            if (rr < 0 || rr >= gr || cc < 0 || cc >= gc) continue;
            s += src[rr * gc + cc]; n++;
          }
        dst[r * gc + c] = s / n;
      }
    return dst;
  };
  // 颜色用轻模糊网格（保雪峰尖），几何用重模糊网格（抛光沙盘面）
  const HDS_C = boxBlur(HDS, 1);
  const BLUR = p.blur ?? 2;
  for (let pass = 0; pass < (p.blurPasses ?? 2); pass++) HDS = boxBlur(HDS, BLUR);

  // —— 掩膜读 Python 离线成品（build_mask.py：四川∪重庆+全量扫描填湾+闭运算+杀孤岛）——
  //    金线画掩膜外轮廓（与墙裙同路径）=线内必有地形，洞在定义上不存在
  const MASK = new Uint8Array(await (await fetch('/' + base + '/mask.bin')).arrayBuffer());

  // —— EP6 v4 终版收边（五轮垂直裙全被读作人工切片后的根治）：HDS 径向边缘衰减 ——
  // MASK 内顶点距省界 <EDGE 格的高度 smoothstep 倾伏到 6%：地形向展台自然沉落，无任何垂直面。
  // 衰减写进 HDS 场本身 → 地形 mesh/sampleH/groundY/AO/金线/路线/裙顶全下游联动一致
  let edgeDist = null;
  {
    const EDGE = p.edgeFall ?? 10;   // 4→10：4 格带坡度仍 68°，卫星贴图陡坡 UV 拉伸成竖纹（kimi 六轮点名的真根）；10 格≈3km 山麓式渐降；edgeFall 参数化（EP9 判例：局部高山地块边缘也是 3000m+，10 格衰减仍陡壁，需 22-26 格缓降）
    const dist = new Int16Array(gc * gr).fill(-1);
    const q = [];
    for (let i = 0; i < gc * gr; i++) if (!MASK[i]) { dist[i] = 0; q.push(i); }
    for (let qi = 0; qi < q.length; qi++) {
      const i = q[qi], r = (i / gc) | 0, c = i % gc, d = dist[i];
      if (d >= EDGE) continue;
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= gr || cc < 0 || cc >= gc) continue;
        const j = rr * gc + cc;
        if (dist[j] === -1) { dist[j] = d + 1; q.push(j); }
      }
    }
    for (let i = 0; i < gc * gr; i++) {
      const d = dist[i];
      if (d > 0 && d < EDGE) {          // d=0 是 MASK 外本身
        const f = d / EDGE, k = f * f * (3 - 2 * f);   // smoothstep
        HDS[i] *= 0.06 + 0.94 * k;
      }
    }
    edgeDist = dist;                    // 贴图渐隐复用（横断河谷贴图竖纹=卫星图真实纹理，几何衰减不除贴图 → 带内贴图同步渐隐）
    var EDGE_N = EDGE;
  }

  // AO：大半径模糊-实际=凹度，谷地压暗（rayshader 环境遮挡质感的平价近似）
  const HDS_BIG = boxBlur(HDS, 8);
  const AO = new Float32Array(gc * gr);
  for (let i = 0; i < gc * gr; i++)
    AO[i] = 1 - clamp01((HDS_BIG[i] - HDS[i]) / 500) * 0.35;

  // —— 地形网格：手工索引几何（省外四顶点全弃=省形裁切），sat=卫星贴图原色/art=分层设色 ——
  const satTex = (p.colorMode ?? 'sat') === 'sat' ? await tex(base + '/surface.jpg') : null;
  if (satTex) satTex.anisotropy = 16;
  const RAMP = [                              // [海拔m, r,g,b] art 模式：深青山雪山
    [0,    0.32, 0.46, 0.27], [700,  0.24, 0.43, 0.23], [1800, 0.17, 0.34, 0.19],
    [3000, 0.33, 0.37, 0.22], [4200, 0.46, 0.35, 0.25], [5000, 0.62, 0.55, 0.46],
    [5600, 0.94, 0.96, 0.99], [7600, 1.00, 1.00, 1.00],
  ];
  const ramp = (h) => {
    if (h <= RAMP[0][0]) return RAMP[0].slice(1);
    for (let i = 1; i < RAMP.length; i++) {
      if (h <= RAMP[i][0]) {
        const k = (h - RAMP[i - 1][0]) / (RAMP[i][0] - RAMP[i - 1][0]);
        return [0, 1, 2].map(j => RAMP[i - 1][1 + j] + (RAMP[i][1 + j] - RAMP[i - 1][1 + j]) * k);
      }
    }
    return RAMP[RAMP.length - 1].slice(1);
  };
  const positions = new Float32Array(gc * gr * 3);
  const colors = new Float32Array(gc * gr * 3);
  const uvs = new Float32Array(gc * gr * 2);
  for (let r = 0; r < gr; r++)
    for (let c = 0; c < gc; c++) {
      const i = r * gc + c, in_ = MASK[i];
      const h = in_ ? HDS[i] : 0;
      positions[i * 3]     = (c / (gc - 1) - 0.5) * spanX;
      positions[i * 3 + 1] = HY(Math.max(0, h));
      positions[i * 3 + 2] = (r / (gr - 1) - 0.5) * spanZ;
      uvs[i * 2] = c / (gc - 1);
      uvs[i * 2 + 1] = 1 - r / (gr - 1);
      let cr, cg, cb;
      if (!in_) { cr = cg = cb = 0.16; }        // 省外=暗桌台
      else if (satTex) { cr = cg = cb = 1; }    // 卫星贴图原色
      else { [cr, cg, cb] = ramp(HDS_C[i]); }
      const ao = in_ ? AO[i] : 1;
      // 边缘渐隐：衰减带内贴图乘暗（几何降了但卫星图峡谷阴影纹理还在=「竖纹」观感残余；带内贴图向底色收）
      let fade = 1;
      if (edgeDist) {
        const d = edgeDist[i];
        if (d > 0 && d < EDGE_N) { const f = d / EDGE_N; fade = 0.42 + 0.58 * (f * f * (3 - 2 * f)); }
      }
      colors[i * 3] = cr * ao * fade; colors[i * 3 + 1] = cg * ao * fade; colors[i * 3 + 2] = cb * ao * fade;
    }
  const tIdx = [];
  for (let r = 0; r < gr - 1; r++)
    for (let c = 0; c < gc - 1; c++) {
      const a = r * gc + c, b = r * gc + c + 1, d = (r + 1) * gc + c, e = (r + 1) * gc + c + 1;
      // EP6 v4 刀片墙真根：MASK 内外交界的混合三角（高差3000m）上卫星贴图被竖向拉成密集条纹。
      // 只画全内三角；省界边界由裙边岩层墙独撑（裙顶沿 outline 精确贴地形高，无缝）
      if (!(MASK[a] && MASK[b] && MASK[d] && MASK[e])) continue;
      tIdx.push(a, d, b, b, d, e);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(tIdx);
  geo.computeVertexNormals();
  const terrainMesh = new THREE.Mesh(geo,
    new THREE.MeshStandardMaterial({ map: satTex ?? null, vertexColors: true, roughness: 1, metalness: 0 }));
  terrainMesh.castShadow = p.shadows !== false;   // EP9 判例：峡谷尺度自投影=整谷死黑；p.shadows:false 走黄山式贴图明暗（EP6 全省尺度默认开阴影不变）
  terrainMesh.receiveShadow = true;
  scene.add(terrainMesh);

  // —— 自然山体切面：掩膜边界边链接成环 → Chaikin 去阶梯 → 卫星边缘色垂直拉伸的地层墙 ——
  //    （主人判死灰色人工墙：切面必须像切开的真实山体）
  const xzOf = (lon, lat) => [
    ((lon - meta.lon0) / (meta.lon1 - meta.lon0) - 0.5) * spanX,
    ((meta.lat1 - lat) / (meta.lat1 - meta.lat0) - 0.5) * spanZ,   // lat→z 同 mesh（北=-z）：曾南北镜像判死（香格里拉镇段被山体挡住=路线"没画出来"根因）
  ];
  const sampleH = (lon, lat) => {               // HDS 双线性（真实高）
    const c = clamp01((lon - meta.lon0) / (meta.lon1 - meta.lon0)) * (gc - 1);
    const r = clamp01((meta.lat1 - lat) / (meta.lat1 - meta.lat0)) * (gr - 1);
    const c0 = Math.floor(c), r0 = Math.floor(r);
    const c1 = Math.min(gc - 1, c0 + 1), r1 = Math.min(gr - 1, r0 + 1);
    const fc = c - c0, fr = r - r0;
    return HDS[r0 * gc + c0] * (1 - fc) * (1 - fr) + HDS[r0 * gc + c1] * fc * (1 - fr)
         + HDS[r1 * gc + c0] * (1 - fc) * fr + HDS[r1 * gc + c1] * fc * fr;
  };
  // 边界边收集（inside 与 outside 之间的单元格边）
  const edges = [];
  const at = (r, c) => (r >= 0 && r < gr && c >= 0 && c < gc) ? MASK[r * gc + c] : 0;
  for (let r = 0; r < gr; r++)
    for (let c = 0; c < gc; c++) {
      if (!at(r, c)) continue;
      if (!at(r - 1, c)) edges.push([c, r, c + 1, r]);          // 北边
      if (!at(r + 1, c)) edges.push([c + 1, r + 1, c, r + 1]);  // 南边
      if (!at(r, c - 1)) edges.push([c, r + 1, c, r]);          // 西边
      if (!at(r, c + 1)) edges.push([c + 1, r, c + 1, r + 1]);  // 东边
    }
  // 链接成环（每节点度数 2）
  const adj = new Map();
  const key = (x, y) => x + ',' + y;
  edges.forEach((e, i) => {
    for (const k of [key(e[0], e[1]), key(e[2], e[3])]) {
      if (!adj.has(k)) adj.set(k, []);
      adj.get(k).push(i);
    }
  });
  const ptOf = new Map();
  for (const e of edges) { ptOf.set(key(e[0], e[1]), [e[0], e[1]]); ptOf.set(key(e[2], e[3]), [e[2], e[3]]); }
  const used = new Uint8Array(edges.length);
  let best = [];
  for (let s = 0; s < edges.length; s++) {
    if (used[s]) continue;
    const loop = [];
    const startK = key(edges[s][0], edges[s][1]);
    let cur = startK;
    while (true) {
      loop.push(ptOf.get(cur));
      const cand = adj.get(cur).filter((ei) => !used[ei]);
      if (!cand.length) break;
      const ei = cand[0];
      used[ei] = 1;
      const e = edges[ei];
      cur = key(e[0], e[1]) === cur ? key(e[2], e[3]) : key(e[0], e[1]);
      if (cur === startK) break;
    }
    if (loop.length > best.length) best = loop;  // 最长环=外轮廓
  }
  // 网格角点 → lon/lat（角点在单元格中心间，+0.5 修正）
  let outline = best.map(([x, y]) => [
    meta.lon0 + ((x - 0.5) / (gc - 1)) * (meta.lon1 - meta.lon0),
    meta.lat1 - ((y - 0.5) / (gr - 1)) * (meta.lat1 - meta.lat0),
  ]);
  // Chaikin 两轮去阶梯
  for (let pass = 0; pass < 2; pass++) {
    const out = [];
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i], b = outline[(i + 1) % outline.length];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    outline = out;
  }
  // 切面颜色：卫星图边缘色（sat）或色带色（art），向底部渐暗+微噪=地层
  let texPix = null, texW = 0, texH = 0;
  if (satTex) {
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im); im.onerror = rej;
      im.src = '/' + base + '/surface.jpg';
    });
    texW = img.width; texH = img.height;
    const cv = document.createElement('canvas');
    cv.width = texW; cv.height = texH;
    const g2 = cv.getContext('2d');
    g2.drawImage(img, 0, 0);
    texPix = g2.getImageData(0, 0, texW, texH).data;
  }
  const cutColor = (lon, lat) => {
    if (texPix) {
      const u = clamp01((lon - meta.lon0) / (meta.lon1 - meta.lon0));
      const v = clamp01((meta.lat1 - lat) / (meta.lat1 - meta.lat0));
      const x = Math.min(texW - 1, Math.round(u * (texW - 1)));
      const y = Math.min(texH - 1, Math.round(v * (texH - 1)));
      const o = (y * texW + x) * 4;
      return [Math.pow(texPix[o] / 255, 2), Math.pow(texPix[o + 1] / 255, 2), Math.pow(texPix[o + 2] / 255, 2)];
    }
    return ramp(sampleH(lon, lat));
  };
  const sPos = [], sCol = [];
  const N_OUT = outline.length;
  // 4K 判例（EP6 v4 主人判词①切片感）：outline 折线段直接连裙=长直线跨山脊+顶点台阶，
  // 4K 分辨率下暴露；每段细分 SUB 子段、逐子段独立采样高度/颜色，裙顶精确贴地形
  const SUB = 12;
  for (let i = 0; i < N_OUT; i++) {
    const [lo1, la1] = outline[i], [lo2, la2] = outline[(i + 1) % N_OUT];
    for (let s = 0; s < SUB; s++) {
      const f0 = s / SUB, f1 = (s + 1) / SUB;
      const loA = lo1 + (lo2 - lo1) * f0, laA = la1 + (la2 - la1) * f0;
      const loB = lo1 + (lo2 - lo1) * f1, laB = la1 + (la2 - la1) * f1;
      const [ax, az] = xzOf(loA, laA), [bx, bz] = xzOf(loB, laB);
      const ay = HY(Math.max(0, sampleH(loA, laA))), by = HY(Math.max(0, sampleH(loB, laB)));
      // EP6 v4 终审五轮：垂直裙无论细分/岩层化都被读成人工切片。终版收边=「暗岩+底融展台+顶接地形」：
      // 岩带对比压半（0.10-0.36）、底缘 y<12% 融入 floor 色消硬切、顶缘 8% 用地形近似色衔接
      const rock = (y, topCol) => {
        const H = HY(6000);
        const f = Math.max(0, y) / H;
        if (f > 0.92) return topCol;                        // 顶缘衔接地形色
        const FLOORC = [0.145, 0.180, 0.195];
        if (f < 0.12) return FLOORC;                        // 底缘融入展台（硬切感消失）
        const g = (f - 0.12) / 0.80;                        // 12%→92% 映射岩带
        const bands = [0.10, 0.13, 0.17, 0.22, 0.28, 0.36]; // 暗岩层带（对比压半）
        const k = Math.min(0.999, g) * bands.length;
        const b0 = bands[Math.floor(k)], b1 = bands[Math.min(bands.length - 1, Math.floor(k) + 1)];
        const mix = b0 + (b1 - b0) * (k - Math.floor(k)) * 0.55;
        const warm = 0.88 + 0.12 * f;
        const rockC = [mix * 0.62 * warm, mix * 0.55 * warm, mix * 0.47 * warm];
        const blend = Math.min(1, Math.max(0, (f - 0.12) / 0.10));   // 底部 12-22% 过渡带
        return rockC.map((v, j) => v * blend + FLOORC[j] * (1 - blend));
      };
      const cutA = cutColor(loA, laA).map(v => Math.min(1, v)), cutB = cutColor(loB, laB).map(v => Math.min(1, v));
      const ca = rock(ay, cutA), cb = rock(by, cutB), ba = rock(-0.08, cutA), bb = rock(-0.08, cutB);
      sPos.push(ax, ay, az, bx, by, bz, ax, -0.08, az,
                bx, by, bz, bx, -0.08, bz, ax, -0.08, az);
      sCol.push(...ca, ...cb, ...ba,
                ...cb, ...bb, ...ba);
    }
  }
  const skirtGeo = new THREE.BufferGeometry();
  skirtGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sPos), 3));
  skirtGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(sCol), 3));
  skirtGeo.computeVertexNormals();
  const skirt = new THREE.Mesh(skirtGeo,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, side: THREE.DoubleSide }));
  skirt.visible = false;   // EP6 v4 终版：HDS 径向衰减后无垂直面，裙退役（五轮「栅栏/切片」判词根治）

  // —— 省界金线（贴地形管径可见，画真实四川省界）——
  const STEP_B = 2;                             // 轮廓抽稀
  const bPts = [];
  for (let i = 0; i < outline.length; i += STEP_B) {
    const [lo, la] = outline[i];
    const [x, z] = xzOf(lo, la);
    bPts.push(new THREE.Vector3(x, HY(Math.max(0, sampleH(lo, la))) + 0.02, z));
  }
  // EP6 v4 终判（五轮「梳齿/拉丝」真凶定位）：0.015 细管 4K 亚像素=点串拉丝 + 衰减陡坡处近垂直下坠。
  // 治法：相邻点高差限幅（垂直下坠→平滑斜落）+管径 0.015→0.028（4K 可读）
  for (let i = 1; i < bPts.length; i++) {
    const dy = bPts[i].y - bPts[i - 1].y;
    if (Math.abs(dy) > 0.15) bPts[i].y = bPts[i - 1].y + Math.sign(dy) * 0.15;
  }
  const bCurve = new THREE.CatmullRomCurve3(bPts, true, 'centripetal');
  const bTube = new THREE.Mesh(new THREE.TubeGeometry(bCurve, bPts.length * 2, p.borderWidth ?? 0.028, 12, true),   // borderWidth 参数化（EP9 判例：局部小尺度地块下 0.028 巨管=环绕壳带伪影；全省尺度默认值不变）
    new THREE.MeshBasicMaterial({ color: 0xffd98a, transparent: true, fog: false }));
  scene.add(bTube);

  // 底座平面（块落在上面的「展台」，暗色衬出块体）
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(spanX * (p.floorScale ?? 4), spanZ * (p.floorScale ?? 4)),   // EP9 判例：4× 地板远缘在画内=山后黑楔子；12× 推远+雾气融进天际线
    new THREE.MeshStandardMaterial({ color: p.floorColor ?? 0x252e33, roughness: 1, metalness: 0 }));   // EP9 判例（主人「不要沙盘要全屏地图」）：深色地板=沙盘点读感真根，floorColor 给雾霭青灰（0x8a9eb0 档）= 远山没入雾中
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.05;
  floor.receiveShadow = true;
  scene.add(floor);

  // 经纬度 → 场景坐标 / 地面高（双线性）
  const lonLat2xz = (lon, lat) => [
    ((lon - meta.lon0) / (meta.lon1 - meta.lon0) - 0.5) * spanX,
    ((meta.lat1 - lat) / (meta.lat1 - meta.lat0) - 0.5) * spanZ,   // lat→z 同 mesh（北=-z）：曾南北镜像判死（香格里拉镇段被山体挡住=路线"没画出来"根因）
  ];
  const groundY = (lon, lat) => {
    const c = clamp01((lon - meta.lon0) / (meta.lon1 - meta.lon0)) * (gc - 1);
    const r = clamp01((meta.lat1 - lat) / (meta.lat1 - meta.lat0)) * (gr - 1);
    const c0 = Math.floor(c), r0 = Math.floor(r);
    const c1 = Math.min(gc - 1, c0 + 1), r1 = Math.min(gr - 1, r0 + 1);
    const fc = c - c0, fr = r - r0;
    const h = HDS[r0 * gc + c0] * (1 - fc) * (1 - fr) + HDS[r0 * gc + c1] * fc * (1 - fr)
            + HDS[r1 * gc + c0] * (1 - fc) * fr + HDS[r1 * gc + c1] * fc * fr;
    return HY(Math.max(0, h));
  };

  // —— 地标钉（海拔=叙事锚点）：成都薄边 vs 高原机场/雪山高墙 ——
  const LSC = (window.__SC__ || 1);   // 4K 时纹理 ×3，世界尺寸恒定（zoom/布局基准方案）
  const labelSprite = (text, scale = 1, color = '#ffffff') => {
    const cv = document.createElement('canvas');
    let g = cv.getContext('2d');
    g.font = 'bold ' + (100 * LSC) + 'px "RuyiSmiley", sans-serif';
    // 宽度自适应（v3.3 主人判词：「比拉萨还高 700 多米」≈950px 超出 768 定宽画布，两边被裁）
    cv.width = Math.max(768 * LSC, Math.ceil(g.measureText(text).width) + 96 * LSC);
    cv.height = 192 * LSC;
    g = cv.getContext('2d');                        // 改 width 会重置 ctx，重新设字体
    g.font = 'bold ' + (100 * LSC) + 'px "RuyiSmiley", sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 16 * LSC; g.strokeStyle = 'rgba(8,12,10,0.92)';
    g.strokeText(text, cv.width / 2, 96 * LSC);
    g.fillStyle = color;
    g.fillText(text, cv.width / 2, 96 * LSC);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: t, transparent: true, depthWrite: false, depthTest: false, fog: false }));  // EP7 判例：标签=信息层，斜视下被夸张山脊 depthTest 挡（镜海/珍珠滩「消失」真身）——与航迹 depthTest:false 同判例；EP9 v5 判例：信息层不吃雾（FogExp2 把金线白标洗成灰桃色）
    sp.renderOrder = 20;
    sp.scale.set(cv.width * (2.6 / 768) * scale / LSC, 0.65 * scale, 1);   // 宽随画布等比，高不变；/LSC 抵消纹理 ×LSC
    return sp;
  };
  const POIS = p.pois ?? [
    { name: '成都 500m', lon: 104.066, lat: 30.573, color: 0xffb84d },
    { name: '康定 2500m', lon: 101.963, lat: 30.049, color: 0xffd97a },
    { name: '亚丁机场 4411m', lon: 100.053, lat: 29.323, color: 0xff5a4d, dx: -1.1, dsk: 1 },
    { name: '贡嘎山 7556m', lon: 101.879, lat: 29.595, color: 0xffffff, dx: 1.0, dsk: 0 },
  ];
  const poiSprites = [];
  const PS = p.poiScale ?? 1;   // EP7 扩展：县域级小块（宽 ~1.2 单位）上 POI 几何等比缩放（EP6 默认按 ~11.7 宽省块定标）
  POIS.forEach((poi, idx) => {
    const [x, z] = lonLat2xz(poi.lon, poi.lat);
    const y = groundY(poi.lon, poi.lat);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.07 * PS, 16, 12),
      new THREE.MeshBasicMaterial({ color: poi.color, transparent: true }));
    dot.position.set(x, y + 0.03 * PS, z);
    scene.add(dot);
    const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.014 * PS, 0.014 * PS, (p.pinLength ?? 0.75) * PS, 6),
      new THREE.MeshBasicMaterial({ color: poi.color, transparent: true, opacity: 0.55 }));
    pin.position.set(x, y + (p.pinLength ?? 0.75) * PS / 2, z);
    scene.add(pin);
    const lb = labelSprite(poi.name, (poi.scale ?? p.poiLabelScale ?? PS), poi.labelColor ?? '#ffffff');
    lb.position.set(x + (poi.dx ?? 0) * PS, y + ((p.pinLength ?? 0.75) + 0.2 + ((poi.dsk ?? idx) % 2) * 0.35 + (poi.dy ?? 0)) * PS, z);  // 邻近标签错层+横移防叠字；poi.dy=EP7 扩展独立垂直偏移（两档 dsk 不够用的左列多站）
    scene.add(lb);
    poiSprites.push({ lb, dot, pin });
  });

  // —— EP7 扩展（2026-09-20 幕三「景区质感路线」）：p.routeLines 任意条贴地管线路线组 ——
  // 与 G318 自驾链同管线：CatmullRom→getSpacedPoints→逐点 sampleH 重贴地（稀疏点连线穿山判例）
  // +受光 emissive（EP6 v4 终审「偏白不黄」配方）；生长窗 t0/t1（秒）走 drawRange 整段步进（残缺三角=点线闪判例）。
  // EP8 扩展（2026-09-21 主人判词「金色路线要能明显看出来方向，带个箭头」）：
  //   rl.arrows={n,from,to,size,color} 方向箭头场（线头过后点亮+呼吸脉冲）；rl.label 文字标签（线画完浮现）。
  const RLINES = p.routeLines ?? null;
  const rlineTubes = [];
  // 方向 chevron 纹理（指向 +X，贴地平铺后随切线转向——flood sandbox 箭头姿态公式同款）
  // v2 判词复盘：金上金不可读+平面埋管内（管半径 0.0375 > lift 0.014 只有尖端露头）——
  //   深描边+主色细芯（任意线色/地形上可读）+ lift 默认抬出管面。
  const mkChevronTex = (color) => {
    const cv2 = document.createElement('canvas'); cv2.width = 256; cv2.height = 160;
    const g2 = cv2.getContext('2d');
    g2.lineJoin = 'round'; g2.lineCap = 'round';
    for (const dx of [0, 84]) {
      g2.strokeStyle = 'rgba(8,12,10,0.92)'; g2.lineWidth = 34;
      g2.beginPath(); g2.moveTo(30 + dx, 22); g2.lineTo(94 + dx, 80); g2.lineTo(30 + dx, 138); g2.stroke();
      g2.strokeStyle = color; g2.lineWidth = 18;
      g2.beginPath(); g2.moveTo(30 + dx, 22); g2.lineTo(94 + dx, 80); g2.lineTo(30 + dx, 138); g2.stroke();
    }
    const t2 = new THREE.CanvasTexture(cv2); t2.colorSpace = THREE.SRGBColorSpace; return t2;
  };
  const mkArrowField = (pts, opt = {}) => {
    const n = opt.n ?? 6, from = opt.from ?? 0.08, to = opt.to ?? 0.92;
    const tex = mkChevronTex(opt.color ?? '#ffb52e');
    const size = opt.size ?? 0.22;
    const meshes = [];
    for (let i = 0; i < n; i++) {
      const u = from + (to - from) * (i / Math.max(1, n - 1));
      const idx = Math.min(pts.length - 2, Math.max(1, Math.round(u * (pts.length - 1))));
      const dx = pts[idx + 1].x - pts[idx - 1].x, dz = pts[idx + 1].z - pts[idx - 1].z;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size * 0.625),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthTest: false, side: THREE.DoubleSide, fog: false }));
      m.rotation.set(-Math.PI / 2, 0, Math.atan2(-dz, dx));
      m.position.set(pts[idx].x, pts[idx].y + (opt.lift ?? 0.025), pts[idx].z);
      m.renderOrder = opt.renderOrder ?? 12;   // 信息层：高于 compareTube(10)/driveTube(5)
      scene.add(m);
      meshes.push({ m, u });
    }
    return { update(front, t) {           // front=线头 frac（线头过后点亮，随呼吸脉冲）
      for (const { m, u } of meshes) {
        const on = clamp01((front - u) / 0.03);
        m.material.opacity = on * (0.6 + 0.4 * Math.sin(t * 3 + u * 17));
      }
    } };
  };
  if (RLINES) {
    const toLL = (q) => [(q.x / spanX + 0.5) * (meta.lon1 - meta.lon0) + meta.lon0,
                         meta.lat1 - (q.z / spanZ + 0.5) * (meta.lat1 - meta.lat0)];   // EP9 判例（2026-09-27）：逆变换南北镜像 latent bug——mesh r0=北缘=z-span/2，逆推须 (z/span+0.5)；旧式把镇(北)采到牛奶海(南)高程
    for (const rl of RLINES) {
      const RLIFT = rl.lift ?? 0.012;   // EP8：与主线 lift 统一（断差=中断感判例）
      const ctr = rl.pts.map((q) => { const [x, z] = xzOf(q.lon, q.lat); return new THREE.Vector3(x, groundY(q.lon, q.lat) + RLIFT, z); });
      const N = rl.npts ?? 400;
      const pts = new THREE.CatmullRomCurve3(ctr, false, 'centripetal').getSpacedPoints(N).map((q) => {
        const [lo, la] = toLL(q);
        return new THREE.Vector3(q.x, HY(Math.max(0, sampleH(lo, la))) + RLIFT, q.z);  // 浮起与主线统一（断差=中断感判例）
      });
      const tube = new THREE.Mesh(
        new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'centripetal'), N, rl.width ?? 0.008, 10, false),
        rl.basic   // 【张家界规范】亮橙金不受光信息层（暗地形上高对比=发光读感）
          ? new THREE.MeshBasicMaterial({ color: rl.color ?? '#ffc23e', fog: false })   // EP9 v5 判例：信息层不吃雾——雾把亮橙金洗成灰桃色（主人「路线没金的感觉」）
          : new THREE.MeshStandardMaterial({ color: rl.color ?? '#ffc466', emissive: rl.emissive ?? '#7a5218', roughness: .55, fog: false }));
      tube.userData.idxCount = tube.geometry.index.count;
      tube.userData.seg = 10 * 2 * 3;   // radial×tri×idx：整 tubular 段步进
      if (rl.onTop) { tube.material.depthTest = false; tube.renderOrder = 6; }   // EP8 判词：概览路线过山过隧道恒可见（信息层语义）
      tube.geometry.setDrawRange(0, 0);
      scene.add(tube);
      const entry = { tube, t0: rl.t0 ?? 0, t1: rl.t1 ?? 1 };
      if (rl.arrows) entry.arrows = mkArrowField(pts, { color: rl.arrows.color ?? rl.color, ...rl.arrows });
      if (rl.label) {                     // 支线写明（EP8 判词⑦：不同的颜色也应该写明）
        const lb = labelSprite(rl.label, rl.labelScale ?? 0.55, rl.labelColor ?? rl.color ?? '#ffffff');
        const mid = pts[Math.round(pts.length / 2)];
        lb.position.set(mid.x + (rl.labelDx ?? 0), mid.y + (rl.labelDy ?? 0.35), mid.z);
        lb.material.opacity = 0;
        scene.add(lb);
        entry.label = lb;
      }
      rlineTubes.push(entry);
    }
  }

  // —— 路线戏（主人：飞行/开车分镜，不揉一张图）——
  // 飞行镜头=低空侧后下往上看（红线陡拉翻雪山墙）；开车镜头=贴路跟随（低空高pitch沿切线）
  const ROUTES = p.routes ?? false;
  let flightTube, driveTube, compareTube, headDot, drivePts, driveAlt, driveSmooth, flightCurve, planeSpr, carSpr, wpSprites = [], hudAlt, hudTag, cardDiv, ringPulses = [], apRing, cdRing, apLabel, heroDiv, heroImg, heroCap, chipDiv, heroFull, heroFullImg, heroFullTag, slapDiv, profileCtx, driveArrowSet = null, WALKERS = [], driveGlow = null;
  // 路线数据全部 params 注入（开源版无内置私货）：wps=站点链 / flight=航线 / origin=起点城市 /
  // airport=目的地机场 / finale=终章点。ROUTES=true 时五项必填。
  if (ROUTES) {
    for (const k of ['wps', 'flight', 'origin', 'airport', 'finale']) {
      if (!p[k]) throw new Error('terrain_block routes 模式需要 params.' + k + '（见 PROGRAMS.md terrain_block 节）');
    }
  }
  const CHENGDU = p.origin ?? { lon: 0, lat: 0 };       // 起点城市（金环锚点/返程落点）
  const YADING_AP = p.airport ?? { lon: 0, lat: 0 };    // 目的地机场（红环/对比标签/直飞终点）
  const WPS = p.wps ?? [];                              // 站点链 {name,lon,lat,alt?,big?,ring?,chip?,card?}
  const FINALE = p.finale
    ? { absWtOffset: p.finaleAt ?? 1.2, chip: p.finale.chip, card: p.finale.card }
    : null;
  if (ROUTES) {
    // 直飞弧：成都地面 → 陡拉 → 巡航 8000(HY3.6 高过雪山墙) → 落亚丁机场 4411
    const F = (lon, lat, h) => { const [x, z] = xzOf(lon, lat); return new THREE.Vector3(x, HY(h) + 0.05, z); };
    // p.flight = {from:{lon,lat,alt}, mids:[[lon,lat,h],...], to:{lon,lat,alt}}
    // 下滑道纪律：末段必须拉平（垂直冲下判死）；航迹=信息层 depthTest:false 实心不透明管
    flightCurve = new THREE.CatmullRomCurve3([
      F(p.flight.from.lon, p.flight.from.lat, p.flight.from.alt ?? 500),
      ...(p.flight.mids ?? []).map(([lon, lat, h]) => F(lon, lat, h)),
      F(p.flight.to.lon, p.flight.to.lat, p.flight.to.alt ?? 0),
    ], false, 'centripetal');
    flightTube = new THREE.Mesh(
      new THREE.TubeGeometry(flightCurve, 240, 0.055, 12, false),
      new THREE.MeshBasicMaterial({ color: 0xff5346, depthTest: false }));   // EP6 v4 主人判词：航迹闪烁双根因=①山墙整段遮挡→depthTest false（航迹=信息层须全程可见）②半透明管自身面片混合乱序（12边管平行线簇+点串）→实心不透明。管径 0.055 保 4K 远景可读
    flightTube.renderOrder = 10;
    flightTube.geometry.setDrawRange(0, 0);
    scene.add(flightTube);
    // ✈️ 飞机图标（主人钦定：飞行要有飞机在飞）细长后掠翼喷气机
    const pcv = document.createElement('canvas');
    pcv.width = pcv.height = 256;
    const pg = pcv.getContext('2d');
    pg.translate(128, 128);
    pg.rotate(-Math.PI / 2);                 // 机头右→机头上（rotation 公式沿用：rotation=0 朝上）
    pg.lineJoin = 'round'; pg.lineCap = 'round';
    const jetPart = (fill, pts) => {         // 闭合多边形零件：填充+深描边（白机身压暗地形上可读）
      pg.beginPath(); pg.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) pg.lineTo(pts[i][0], pts[i][1]);
      pg.closePath(); pg.fillStyle = fill; pg.fill();
      pg.strokeStyle = '#0c1218'; pg.lineWidth = 6; pg.stroke();
    };
    jetPart('#ffd98a', [[-66, -3], [-44, -5], [-28, -40], [-48, -37]]);            // 垂尾（金）
    jetPart('#f6f8fa', [[-88, -2], [-52, -12], [8, -12], [68, -10], [96, -2],
                        [68, 9], [8, 11], [-52, 11]]);                              // 机身（细长纺锤）
    jetPart('#1c2e3a', [[52, -8], [72, -7], [66, -2], [50, -3]]);                   // 座舱盖（深）
    jetPart('#e7ebef', [[26, 5], [-32, 22], [-58, 22], [-8, 3]]);                   // 主翼（后掠下反）
    jetPart('#e7ebef', [[-62, 2], [-82, 14], [-93, 14], [-74, 0]]);                 // 平尾
    pg.beginPath();                                                                  // 发动机短舱
    if (pg.roundRect) pg.roundRect(16, 12, 34, 14, 6); else pg.rect(16, 12, 34, 14);
    pg.closePath(); pg.fillStyle = '#f6f8fa'; pg.fill(); pg.strokeStyle = '#0c1218'; pg.lineWidth = 5; pg.stroke();
    pg.beginPath(); pg.moveTo(-80, -5); pg.lineTo(86, -4);                           // 金色 cheatline
    pg.strokeStyle = '#f2c879'; pg.lineWidth = 4; pg.stroke();
    const ptex = new THREE.CanvasTexture(pcv);
    ptex.colorSpace = THREE.SRGBColorSpace;
    planeSpr = new THREE.Sprite(new THREE.SpriteMaterial({ map: ptex, transparent: true, depthTest: false, fog: false }));
    planeSpr.scale.set(0.9, 0.9, 1);  // 手绘图占满画布，等效像素大于同框 emoji

    planeSpr.visible = false;
    planeSpr.renderOrder = 999;
    scene.add(planeSpr);
    // 🚗 汽车图标（顶视，主人钦定：开车要有车在走）
    const ccv = document.createElement('canvas');
    ccv.width = ccv.height = 256;
    const cg2 = ccv.getContext('2d');
    cg2.translate(128, 128);
    cg2.fillStyle = '#ffffff'; cg2.strokeStyle = '#0b1016'; cg2.lineWidth = 7;
    const rr = (x, y, w, h, r) => { cg2.beginPath(); cg2.moveTo(x + r, y); cg2.arcTo(x + w, y, x + w, y + h, r); cg2.arcTo(x + w, y + h, x, y + h, r); cg2.arcTo(x, y + h, x, y, r); cg2.arcTo(x, y, x + w, y, r); cg2.closePath(); };
    rr(-34, -95, 68, 190, 26); cg2.fill(); cg2.stroke();          // 车身
    cg2.fillStyle = '#0b1016';
    rr(-26, -52, 52, 42, 10); cg2.fill();                          // 前风挡
    rr(-26, 18, 52, 34, 10); cg2.fill();                           // 后风挡
    cg2.fillStyle = '#ffffff';
    for (const s of [-1, 1]) for (const yy of [-62, 42]) {         // 四轮
      rr(s * 34 - (s < 0 ? 14 : -0), yy, 14, 34, 5); cg2.fill(); cg2.stroke();
    }
    const ctex = new THREE.CanvasTexture(ccv);
    ctex.colorSpace = THREE.SRGBColorSpace;
    carSpr = new THREE.Sprite(new THREE.SpriteMaterial({ map: ctex, transparent: true, depthTest: false, fog: false }));
    const CAR_SC = 0.42 * (p.carScale ?? 1);   // EP9 判例：0.42 全省尺度写死值，局部地块 p.carScale 0.04-0.08
    carSpr.scale.set(CAR_SC, CAR_SC, 1);
    carSpr.visible = false;
    carSpr.renderOrder = 999;
    scene.add(carSpr);
    // —— EP9 扩展（2026-09-27 主人：不同交通方式有小人或者小车）——
    // p.walkers=[{icon:'walk'|'bus'|'drive'|'cable'|'flight',scale,t0,t1,u0,u1,pts?}]：沿线行进徽章。
    // 【张家界规范】徽章=route_renderer.html 原版 SVG 逐像素复刻（主人：直接用张家界一模一样的）：
    //   viewBox 46×60、深绿底 #102f26、金边 #ffcf65 3px、金别针 #ffb648 白描边；glyph=Font Awesome 原路径。
    const FA_WALK = 'M192 48a48 48 0 1 1 96 0 48 48 0 1 1-96 0zm51.3 182.7L224.2 307l49.7 49.7c9 9 14.1 21.2 14.1 33.9V480c0 17.7-14.3 32-32 32s-32-14.3-32-32v-82.7l-73.9-73.9c-15.8-15.8-22.2-38.6-16.9-60.3l20.4-84c8.3-34.1 42.7-54.9 76.7-46.4 19 4.8 35.6 16.4 46.4 32.7L305.1 208H336v-24c0-13.3 10.7-24 24-24s24 10.7 24 24v304c0 13.3-10.7 24-24 24s-24-10.7-24-24V272h-39.4c-16 0-31-8-39.9-21.4l-13.3-20zM81.1 471.9L117.3 334c3 4.2 6.4 8.2 10.1 11.9l41.9 41.9-26.4 100.3c-4.5 17.1-22 27.3-39.1 22.8s-27.3-22-22.8-39.1zm55.5-346-35.2 140.6c-3 12.1-14.9 19.9-27.2 17.9l-47.9-8c-14-2.3-22.9-16.3-19.2-30L31.9 155c9.5-34.8 41.1-59 77.2-59h4.2c15.6 0 27.1 14.7 23.3 29.8z';
    const FA_CAR = 'M135.2 117.4L109.1 192H402.9l-26.1-74.6C372.3 104.6 360.2 96 346.6 96H165.4c-13.6 0-25.7 8.6-30.2 21.4zM39.6 196.8L74.8 96.3C88.3 57.8 124.6 32 165.4 32H346.6c40.8 0 77.1 25.8 90.6 64.3l35.2 100.5c23.2 9.6 39.6 32.4 39.6 59.2V400c0 17.7-14.3 32-32 32H448c-17.7 0-32-14.3-32-32V384H96v16c0 17.7-14.3 32-32 32H32c-17.7 0-32-14.3-32-32V256c0-26.8 16.4-49.6 39.6-59.2zM128 288a32 32 0 1 0 -64 0 32 32 0 1 0 64 0zM448 288a32 32 0 1 0 -64 0 32 32 0 1 0 64 0z';
    const mkWalkerSpr = (kind) => {
      const wcv = document.createElement('canvas'); wcv.width = 184; wcv.height = 240;   // 46×60 @4x
      const wg = wcv.getContext('2d');
      wg.scale(4, 4);
      // 别针（先画针，圆徽压针尖）
      wg.beginPath(); wg.moveTo(23, 59); wg.lineTo(17, 49); wg.lineTo(29, 49); wg.closePath();
      wg.fillStyle = '#ffb648'; wg.fill(); wg.lineWidth = 2; wg.strokeStyle = '#fff'; wg.stroke();
      // 圆徽：深绿底+金边
      wg.beginPath(); wg.arc(23, 25, 21, 0, 7);
      wg.fillStyle = '#102f26'; wg.fill(); wg.lineWidth = 3; wg.strokeStyle = '#ffcf65'; wg.stroke();
      // glyph（白）
      wg.fillStyle = '#fff'; wg.strokeStyle = '#fff';
      if (kind === 'bus') {
        const r2 = (x, y, w, h, r) => { wg.beginPath(); wg.moveTo(x + r, y); wg.arcTo(x + w, y, x + w, y + h, r); wg.arcTo(x + w, y + h, x, y + h, r); wg.arcTo(x, y + h, x, y, r); wg.arcTo(x, y, x + w, y, r); wg.closePath(); };
        r2(12, 14, 22, 16, 4); wg.fill();
        wg.fillStyle = '#102f26';
        r2(15.5, 17.5, 6, 5, 1); wg.fill(); r2(24.5, 17.5, 6, 5, 1); wg.fill();
        wg.lineWidth = 1.6; wg.strokeStyle = '#fff';
        wg.beginPath(); wg.arc(17, 31, 2.6, 0, 7); wg.fill(); wg.stroke();
        wg.beginPath(); wg.arc(29, 31, 2.6, 0, 7); wg.fill(); wg.stroke();
      } else if (kind === 'cable') {
        wg.lineWidth = 2.6; wg.beginPath(); wg.moveTo(23, 5); wg.lineTo(23, 13); wg.stroke();
        wg.beginPath(); wg.moveTo(14, 14); wg.lineTo(32, 14); wg.lineTo(29.4, 29); wg.lineTo(16.6, 29); wg.closePath(); wg.fill();
        wg.fillStyle = '#102f26'; const r3 = (x, y, w, h, r) => { wg.beginPath(); wg.moveTo(x + r, y); wg.arcTo(x + w, y, x + w, y + h, r); wg.arcTo(x + w, y + h, x, y + h, r); wg.arcTo(x, y + h, x, y, r); wg.arcTo(x, y, x + w, y, r); wg.closePath(); };
        r3(18.5, 17.5, 9, 6, 1.2); wg.fill();
      } else if (kind === 'drive') {
        wg.save(); wg.translate(10, 10); wg.scale(0.052, 0.052); wg.fill(new Path2D(FA_CAR)); wg.restore();
      } else {   // walk（默认）：FA person-hiking 原路径
        wg.save(); wg.translate(12, 8); wg.scale(0.058, 0.058); wg.fill(new Path2D(FA_WALK)); wg.restore();
      }
      const wt = new THREE.CanvasTexture(wcv); wt.colorSpace = THREE.SRGBColorSpace;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: wt, transparent: true, depthTest: false, fog: false }));   // EP9 v5：信息层不吃雾
      sp.renderOrder = 998; sp.visible = false; scene.add(sp);
      return sp;
    };
    // WALKERS 赋值见 driveSmooth 构建之后（toLonLat TDZ 判例）
    const FLIGHT_IDX = flightTube.geometry.index.count;

    // 自驾线：G318 点位 CatmullRom 贴地（+0.035 浮起防 z-fight）
    // EP9 判例（2026-09-27）：稀疏路点 CatmullRom 抄近道=翻 5180m 垭口过山车（寺→洛绒直线剖实测），
    // p.drivePath=密点真实路迹（lon/lat 数组）替代 WPS 建链；WPS 仅留作标签/光环锚点。
    const dSrc = p.drivePath ?? WPS;
    const dCtr = dSrc.map((w) => { const [x, z] = xzOf(w.lon, w.lat); return new THREE.Vector3(x, groundY(w.lon, w.lat) + 0.035, z); });
    const driveCurve = new THREE.CatmullRomCurve3(dCtr, false, 'centripetal');
    const NPTS = 600;
    const toLonLat = (q) => [(q.x / spanX + 0.5) * (meta.lon1 - meta.lon0) + meta.lon0,
                             meta.lat1 - (q.z / spanZ + 0.5) * (meta.lat1 - meta.lat0)];   // 同上：南北镜像 latent bug 根治
    // 稀疏路点连线会穿山（45x 地形 CatmullRom 抄近道=管埋山里判例）：逐点重新贴地
    drivePts = driveCurve.getSpacedPoints(NPTS).map((q) => {
      const [lo, la] = toLonLat(q);
      return new THREE.Vector3(q.x, HY(Math.max(0, sampleH(lo, la))) + (p.routeLift ?? 0.012), q.z);  // EP8 判词：EXAG/100=0.28 近机位漂浮→统一小防 z-fight 值
    });
    driveAlt = drivePts.map((q) => { const [lo, la] = toLonLat(q); return sampleH(lo, la); });
    // 站点真值吸附：深谷模糊膨胀（香格里拉镇 4090→2900 判例），站点±6% 路径窗内拉真
    // EP8 扩展：p.wps 注入时吸附表从各节点 alt 字段派生（数据驱动，不再硬编码索引）
    // drivePath 模式下密点已贴真实路迹，吸附关闭（frac 错位的吸附反而把垭口拉成站高）
    const STATION_SNAP = p.drivePath ? [] : (p.wps
      ? WPS.map((w, i) => (w.alt != null ? [i, w.alt] : null)).filter(Boolean)
      : [[3, 2500], [4, 4298], [5, 3300], [7, 4000], [9, 2900]]);
    for (const [wi, ka] of STATION_SNAP) {
      const ci = (wi / (WPS.length - 1)) * NPTS, win = NPTS * 0.06;
      for (let i = 0; i <= NPTS; i++) {
        const d = Math.abs(i - ci);
        if (d < win) driveAlt[i] = ka + (driveAlt[i] - ka) * (d / win);
      }
    }
    // 相机/注视走 31 点移动平均平滑路径（huashan 防抖判例），贴地抖动不进镜头
    const smPts = drivePts.map(q => q.clone());
    driveSmooth = smPts.map((_, i) => {
      const acc = new THREE.Vector3(); let n = 0;
      for (let j = -15; j <= 15; j++) { const k = Math.min(NPTS, Math.max(0, i + j)); acc.add(smPts[k]); n++; }
      return acc.multiplyScalar(1 / n);
    });
    WALKERS = (p.walkers ?? []).map((w) => {
      const wk = { ...w, spr: mkWalkerSpr(w.icon ?? 'ped') };
      if (w.pts) {   // 独立路径（如 S4 长线徒步）：自带 lon/lat 密点→贴地→31 点移动平均（同 drive 链工艺）
        const wCtr = w.pts.map((q) => { const [x, z] = xzOf(q.lon, q.lat); return new THREE.Vector3(x, groundY(q.lon, q.lat) + 0.035, z); });
        const wPts = new THREE.CatmullRomCurve3(wCtr, false, 'centripetal').getSpacedPoints(400).map((q) => {
          const [lo, la] = toLonLat(q);
          return new THREE.Vector3(q.x, HY(Math.max(0, sampleH(lo, la))) + (p.routeLift ?? 0.012), q.z);
        });
        wk.path = wPts.map((_, i) => {
          const acc = new THREE.Vector3(); let n = 0;
          for (let j = -15; j <= 15; j++) { const k = Math.min(400, Math.max(0, i + j)); acc.add(wPts[k]); n++; }
          return acc.multiplyScalar(1 / n);
        });
      }
      return wk;
    });
    // EP8 箭头场（2026-09-21 主人判词⑤）：北进/主线方向 chevron——p.driveArrows={n,from,to,size,color}
    if (p.driveArrows) driveArrowSet = mkArrowField(drivePts, { color: p.driveArrows.color ?? p.driveColor ?? '#ffb52e', ...p.driveArrows });
    const driveCurveD = new THREE.CatmullRomCurve3(drivePts, false, 'centripetal');   // EP6 v4 判词③：不抽稀，600 贴地点全保留，平滑不抄近道
    // 【张家界规范】p.driveStyle='glow'：亮橙金发光带=Basic 亮金芯+2.2× additive 辉光底层（默认 Lambert 受光不变）
    const GLOW = p.driveStyle === 'glow';
    driveTube = new THREE.Mesh(
      new THREE.TubeGeometry(driveCurveD, 900, p.driveWidth ?? 0.038, 8, false),
      GLOW
        ? new THREE.MeshBasicMaterial({ color: p.driveColor ?? 0xffb52e, transparent: true, opacity: 0.98, fog: false })   // EP9 v5：信息层不吃雾
        : new THREE.MeshLambertMaterial({ color: p.driveColor ?? 0xffb52e, emissive: p.driveEmissive ?? 0x664400,
        transparent: true, opacity: 0.98, fog: false }));   // EP6 v4：受光+emissive 底色（贴地明暗犹在、阴面不发白——终审判词「偏白不黄」）；EP8 扩展 p.driveColor/p.driveEmissive（北进绿线=绿底+绿emissive，橙emissive冲绿判例）
    if (GLOW && p.driveGlowScale) {
      driveGlow = new THREE.Mesh(
        new THREE.TubeGeometry(driveCurveD, 900, (p.driveWidth ?? 0.038) * (p.driveGlowScale ?? 2.2), 8, false),
        new THREE.MeshBasicMaterial({ color: p.driveGlowColor ?? 0xc27a12, transparent: true, opacity: 0.30,
          blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
      driveGlow.geometry.setDrawRange(0, 0);
      scene.add(driveGlow);
    }
    // EP8 扩展（2026-09-20 主人判词「路线被挡住了」）：p.driveOnTop=路线环信息层化
    //   （depthTest:false+renderOrder 5=透明通道内先于 compareTube(10)——核心内容是环，任何机位恒可见；默认 false 保 EP6 贴地受光语义）
    if (p.driveOnTop) { driveTube.material.depthTest = false; driveTube.renderOrder = 5; }
    driveTube.geometry.setDrawRange(0, 0);
    scene.add(driveTube);
    const DRIVE_IDX = driveTube.geometry.index.count;
    // —— EP8 扩展：p.compareWps 对比路线管（南进红线类=信息层语义 depthTest:false 全程可见，
    //    同 EP6 flightTube 判例；p.compareFrac 控生长，默认全亮 RETAIN）——
    if (p.compareWps) {
      const cCtr = p.compareWps.map((w) => { const [x, z] = xzOf(w.lon, w.lat); return new THREE.Vector3(x, groundY(w.lon, w.lat) + 0.035, z); });
      const cCurve = new THREE.CatmullRomCurve3(cCtr, false, 'centripetal');
      const cPts = cCurve.getSpacedPoints(NPTS).map((q) => {
        const [lo, la] = toLonLat(q);
        return new THREE.Vector3(q.x, HY(Math.max(0, sampleH(lo, la))) + (p.routeLift ?? 0.012), q.z);
      });
      const cCurveD = new THREE.CatmullRomCurve3(cPts, false, 'centripetal');
      // 渲染次序判例（2026-09-19 EP8 侧视 proof）：driveTube 是 transparent（透明通道后画），
      // compareTube 若不透明=不透明通道先画 → 共享段被绿管后画覆盖+深度互写 z-fight 只剩残段。
      // 正解：compareTube 同样 transparent + renderOrder 10（透明通道内后画=对比线恒赢共享段），
      // depthTest:false 穿地信息层语义不变（EP6 flightTube 判例同款）。
      compareTube = new THREE.Mesh(
        new THREE.TubeGeometry(cCurveD, 900, p.compareWidth ?? 0.038, 8, false),
        new THREE.MeshBasicMaterial({ color: p.compareColor ?? 0xff5346, depthTest: false,
          transparent: true, opacity: 0.98 }));
      compareTube.renderOrder = 10;
      compareTube.geometry.setDrawRange(0, Math.floor(compareTube.geometry.index.count * clamp01(p.compareFrac ?? 1)));
      scene.add(compareTube);
    }
    headDot = new THREE.Mesh(new THREE.SphereGeometry(0.024, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffcf6e }));
    headDot.visible = false;
    scene.add(headDot);
    // 沿途城镇标签（头过点亮）；EP8 扩展 p.wpLabels:false=净版（proof/海报帧免标签墙）
    //   + w.noLabel 单站跳过（2026-09-20 主人判词「太拥挤」：总揽级只留锚点站，wi 保留原序供 RING_AT 对位）
    wpSprites = (p.wpLabels ?? true) ? WPS.map((w, i) => {
      if (w.noLabel) return null;
      const [x, z] = xzOf(w.lon, w.lat);
      // EP8 扩展（2026-09-20 总揽级判词「太拥挤」）：p.wpLabelScale 缩放 + w.lx/w.lz 错位（高空俯视下 sprite 恒定场景尺寸会被放大成墙）
      const LS = p.wpLabelScale ?? (w.big ? 1.7 : 1.2);
      const lb = labelSprite(w.name, LS, '#ffd98a');  // v3.2 主人判词：15px 判小看不见 → 金色大字≈45px/32px
      lb.position.set(x + (w.lx ?? 0), groundY(w.lon, w.lat) + (w.lift ?? p.wpLabelLift ?? (w.big ? 0.75 : 0.6)), z + (w.lz ?? 0));   // lift 参数化（EP9 判例：0.6 全省尺度在局部 0.29 span 地块=标签飞到两倍地块高）
      lb.material.opacity = 0;
      lb.material.depthTest = false;   // 大标签不吃山体遮挡（亮 3s 后自行淡出，不需要被山挡）
      lb.renderOrder = 998;
      scene.add(lb);
      return { lb, frac: i / (WPS.length - 1), wi: i, wh: w.hold };
    }).filter(Boolean) : [];
    // —— 光圈脉冲（住宿点金/别睡点红）+ 机场落地红环 + 拉萨对比标签 ——
    const RING_COLOR = { sleep: 0xffd98a, nosleep: 0xff5346, play: 0xffffff };
    const mkPulse = (lon, lat, color) => {
      const [x, z] = xzOf(lon, lat);
      const y = groundY(lon, lat) + 0.12;
      return [0, 1].map(() => {
        const m = new THREE.Mesh(new THREE.RingGeometry(0.12, 0.165, 48),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, fog: false }));
        m.rotation.x = -Math.PI / 2;
        m.position.set(x, y, z);
        scene.add(m);
        return m;
      });
    };
    ringPulses = WPS.map((w, i) => w.ring ? { meshes: mkPulse(w.lon, w.lat, RING_COLOR[w.ring]), frac: i / (WPS.length - 1), wi: i } : null).filter(Boolean);
    if (p.finale) ringPulses.push({ meshes: mkPulse(p.finale.lon, p.finale.lat, RING_COLOR.play), finale: true });   // 终章白环（wt=T_END+FINALE_AT，frac:undefined 永不触发的修复）
    apRing = mkPulse(YADING_AP.lon, YADING_AP.lat, RING_COLOR.nosleep);
    cdRing = mkPulse(CHENGDU.lon, CHENGDU.lat, 0xffd98a);   // 成都金环（s0dive 落点/s4back 返程落地）
    apLabel = labelSprite('比拉萨还高 700 多米', 1.3);  // 拉萨对比锤加大（v3.2 同步放大）
    { const [x, z] = xzOf(YADING_AP.lon, YADING_AP.lat);
      apLabel.position.set(x - 0.9, groundY(YADING_AP.lon, YADING_AP.lat) + 1.35, z);  // 避让红线
      apLabel.material.opacity = 0;
      scene.add(apLabel); }
    // HUD（DOM 层=字最锐利）：左下大海拔 + 右上方式章
    const mkDiv = (css) => { const d = document.createElement('div'); d.style.cssText = css; document.body.appendChild(d); return d; };
    hudAlt = mkDiv('position:absolute;left:56px;bottom:48px;opacity:0;pointer-events:none;'
      + 'font:700 92px "RuyiSmiley",sans-serif;color:#ffd98a;text-shadow:0 3px 18px rgba(0,0,0,.75);line-height:1');
    hudTag = mkDiv('position:absolute;right:56px;top:48px;opacity:0;pointer-events:none;text-align:right;'
      + 'font:700 44px "RuyiSmiley",sans-serif;color:#fff;text-shadow:0 2px 12px rgba(0,0,0,.7)');
    // 剖面卡（段末认知重构帧）：直飞近垂直 vs 自驾真实波浪 + 拉萨 3650 虚线
    cardDiv = mkDiv('position:absolute;left:50%;bottom:44px;transform:translateX(-50%);opacity:0;pointer-events:none;'
      + 'background:rgba(8,13,15,.88);border:1.5px solid rgba(255,217,138,.5);border-radius:18px;padding:18px 22px');
    heroFull = mkDiv('position:absolute;inset:0;opacity:0;pointer-events:none;background:#000');
    heroFullImg = document.createElement('img');
    heroFullImg.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block';
    heroFull.appendChild(heroFullImg);
    heroFullTag = document.createElement('div');
    heroFullTag.style.cssText = 'position:absolute;left:56px;bottom:48px;font:700 52px "RuyiSmiley",sans-serif;color:#fff;'
      + 'text-shadow:0 3px 20px rgba(0,0,0,.85)';
    heroFull.appendChild(heroFullTag);
    heroDiv = mkDiv('position:absolute;right:56px;top:130px;width:400px;opacity:0;pointer-events:none;display:none;'
      + 'border-radius:14px;overflow:hidden;box-shadow:0 10px 34px rgba(0,0,0,.55);border:1.5px solid rgba(255,255,255,.28);background:#0a0f12');
    heroImg = document.createElement('img');
    heroImg.style.cssText = 'width:100%;display:block';
    heroDiv.appendChild(heroImg);
    heroCap = document.createElement('div');
    heroCap.style.cssText = 'font:700 26px "RuyiSmiley",sans-serif;color:#fff;padding:10px 14px;';
    heroDiv.appendChild(heroCap);
    chipDiv = mkDiv('position:absolute;left:50%;bottom:168px;transform:translateX(-50%);opacity:0;pointer-events:none;white-space:nowrap;'
      + 'font:700 42px "RuyiSmiley",sans-serif;color:#fff;text-shadow:0 2px 14px rgba(0,0,0,.8);'
      + 'background:rgba(10,14,16,.55);padding:12px 30px;border-radius:999px;border:1.5px solid rgba(255,217,138,.5)');
    const CSC = (window.__SC__ || 1);
    const card = document.createElement('canvas');
    card.width = 1140 * CSC; card.height = 300 * CSC;
    card.style.width = '1140px'; card.style.height = '300px';   // css 布局恒定（body zoom 承担缩放），attr ×SC 保锐利
    cardDiv.appendChild(card);
    const cg = card.getContext('2d');
    if (CSC > 1) cg.scale(CSC, CSC);
    const X0 = 60, X1 = 1110, Y0 = 46, Y1 = 262, ALTMAX = 5000;
    const ax = (f) => X0 + f * (X1 - X0);
    const ay = (h) => Y1 - (h / ALTMAX) * (Y1 - Y0);
    cg.font = '700 26px "RuyiSmiley",sans-serif';
    cg.fillStyle = '#fff';
    cg.fillText('直飞 vs 自驾 · 海拔怎么爬', X0, 32);
    cg.strokeStyle = 'rgba(255,255,255,.14)';
    cg.lineWidth = 1;
    for (const h of [1000, 2000, 3000, 4000]) {
      cg.beginPath(); cg.moveTo(X0, ay(h)); cg.lineTo(X1, ay(h)); cg.stroke();
      cg.fillStyle = 'rgba(255,255,255,.4)'; cg.font = '400 20px sans-serif';
      cg.fillText(h + '', 8, ay(h) + 7);
    }
    // 拉萨 3650 虚线
    cg.strokeStyle = 'rgba(255,255,255,.65)';
    cg.lineWidth = 2; cg.setLineDash([9, 7]);
    cg.beginPath(); cg.moveTo(X0, ay(3650)); cg.lineTo(X1, ay(3650)); cg.stroke();
    cg.setLineDash([]);
    cg.fillStyle = 'rgba(255,255,255,.75)'; cg.font = '400 22px "RuyiSmiley",sans-serif';
    cg.fillText('拉萨 3650（多少人一下飞机就高反）', X0 + 200, ay(3650) - 12);
    // 自驾波浪（真实地形采样）
    cg.strokeStyle = '#ffab33'; cg.lineWidth = 4;
    cg.beginPath();
    for (let i = 0; i <= NPTS; i++) { const f = i / NPTS; i ? cg.lineTo(ax(f), ay(driveAlt[i])) : cg.moveTo(ax(0), ay(driveAlt[0])); }
    cg.stroke();
    cg.fillStyle = '#ffab33'; cg.font = '700 26px "RuyiSmiley",sans-serif';
    cg.fillText('自驾 · 2天', ax(0.55), ay(4450));
    // 自驾关键海拔标注
    cg.font = '400 22px "RuyiSmiley",sans-serif';
    for (const w of [{ f: 0.33, t: '康定 2500' }, { f: 0.45, t: '折多山 4298' }, { f: 0.7, t: '理塘 4000' }]) {
      const i = Math.min(NPTS, Math.round(w.f * NPTS));
      cg.fillText(w.t, ax(w.f) - 60, ay(driveAlt[i]) + (w.f === 0.45 ? -16 : 30));
    }
    const tail = '香格里拉镇 2900';
    cg.fillText(tail, X1 - cg.measureText(tail).width - 6, ay(driveAlt[NPTS]) + 34);
    // 直飞近垂直线
    cg.strokeStyle = '#ff5346'; cg.lineWidth = 5;
    cg.beginPath(); cg.moveTo(ax(0.02), ay(500)); cg.lineTo(ax(0.10), ay(4411)); cg.stroke();
    cg.fillStyle = '#ff5346'; cg.font = '700 26px "RuyiSmiley",sans-serif';
    cg.fillText('直飞 · 1小时', ax(0.17), ay(4700));
    cg.fillText('4411m', ax(0.115), ay(4280));
    // 供 setState 用
    flightTube.userData.idxCount = FLIGHT_IDX;
    driveTube.userData.idxCount = DRIVE_IDX;
  }

  // —— 天空/雾/光：暖阳西南向（山脊亮边+东侧阴影读起伏），轻大气退晕 ——
  const skyCv = document.createElement('canvas');
  skyCv.width = 1024; skyCv.height = 512;
  const sg = skyCv.getContext('2d');
  const grad = sg.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#24406b'); grad.addColorStop(0.35, '#3f6391');
  grad.addColorStop(0.48, '#8fa8bd'); grad.addColorStop(0.52, '#b6c3cc');
  grad.addColorStop(0.62, '#9aa89f'); grad.addColorStop(1, '#5d6b66');
  sg.fillStyle = grad; sg.fillRect(0, 0, 1024, 512);
  const skyTex = new THREE.CanvasTexture(skyCv);
  skyTex.colorSpace = THREE.SRGBColorSpace;
  skyTex.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = skyTex;
  scene.fog = new THREE.FogExp2(0xa8b8c2, p.fogDensity ?? 0.018);

  const sun = new THREE.DirectionalLight(0xfff0d6, p.sunIntensity ?? 4.3);
  sun.position.set(...(p.sunPos ?? [3, 7, 6]));       // EP8 扩展：侧视机位从北看南需北向光（默认南偏东高位暖光不变）
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const sc = sun.shadow.camera;
  // EP9 判例：阴影视锥 ±8 是全省尺度写死值——0.3 单位局部地块只分到 4096 的 ~2%，
  // 自阴影糊成脏斑（「地形脏」真根之一）。p.shadowSize 参数化，局部地块给 0.25-0.4。
  const SHW = p.shadowSize ?? 8;
  sc.left = -SHW; sc.right = SHW; sc.top = SHW; sc.bottom = -SHW;
  sc.near = 0.5; sc.far = p.shadowFar ?? 40;
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.03;
  scene.add(sun); scene.add(sun.target);
  scene.add(new THREE.AmbientLight(p.ambientColor ?? 0x4a5e78, p.ambient ?? 1.25));   // EP9 扩展：峡谷尺度投影斑马纹=ambient 补光参数化（EP6 全省尺度默认不变）

  // —— 相机：东侧贴地平望(成都薄边前景/横断山高墙压天际线) → 高位斜俯上帝视角锁机位 ——
  const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
  let camCurve = new THREE.CatmullRomCurve3(p.camPts ? p.camPts.map(V) : [
    V([8.8, 1.8, 5.1]), V([6.6, 2.9, 6.0]), V([4.0, 6.9, 6.9]), V([1.0, 9.4, 6.8]),
  ], false, 'centripetal');
  let lookCurve = new THREE.CatmullRomCurve3(p.lookPts ? p.lookPts.map(V) : [
    V([-2.4, 0.8, -0.8]), V([-1.8, 0.65, -0.8]), V([-0.8, 0.25, -0.6]), V([-0.3, 0.05, -0.6]),
  ], false, 'centripetal');
  camera.fov = p.camFov ?? 44;
  // EP9 判例（2026-09-27）：near=0.1 是全省尺度写死值——局部地块跟拍相机离地 0.04-0.06，
  // 脚下地形全被近裁剪吃掉（画面=地板+远处悬浮山带病根）。p.camNear 参数化，局部地块给 0.002。
  camera.near = p.camNear ?? 0.1;
  camera.far = 300;
  camera.updateProjectionMatrix();

  const T = CFG.duration;
  // —— 路线戏分镜时刻表（秒）v3 参数化：分段渲染（s0dive 俯冲 / s1 开场+飞行 / s2card 剖面卡专场 / s3 开车总揽 / s4back 返程下行）——
  const DRIVE_ONLY = p.driveOnly ?? false;
  const TL = p.timeline ?? {};
  const T_FLY = DRIVE_ONLY ? 0 : (TL.fly ?? 8), T_DRV = DRIVE_ONLY ? 0 : (TL.drv ?? 16), T_END = DRIVE_ONLY ? T : (TL.end ?? 52);
  const HERO_ON = p.hero ?? true;           // s3=false：全屏 hero 由 compose 叠实拍视频
  const CHIPS_ON = p.chips ?? true;         // s3=false：判词 chip 由 compose 统一语言
  const PROFILE_CARD = p.profileCard ?? true;   // 片尾剖面卡（s1/s3 关闭；s2 专场用 PROFILE_ONLY）
  const DRIVE_CAP = p.driveFracCap ?? 1;    // s1=0.15：G318 起点点亮预告（不出车不跑全程）
  const FINALE_AT = p.finaleAt ?? 1.2;      // 牛奶海白环时刻=T_END+此值（s3=-2.5 收到片内）
  const FLIGHT_BACK = p.flightBack ?? false;    // s4：返程 4411→500 下行
  const LABELS_ALWAYS = p.labelsAlways ?? false; // s0dive：POI 标签全程亮
  const PROFILE_ONLY = p.profileOnly ?? false;   // s2：剖面卡专场（地形退场，卡分步浮现）
  const CD_PULSE_AT = p.chengduPulseAt ?? -1;    // ≥0 启用成都金环（s0dive=1.2 / s4back=4.6）
  const DIVE_IN = p.diveIn ?? false;             // s0：机场点上空→全省开场弧起点（3s 俯冲）
  const STATION_RINGS = p.stationRings ?? true;  // 站点光圈（s0dive/s1/s4back=false）
  const DRIVE_KEYS = p.driveKeys ?? null;        // [[t, frac], ...] 车速分段线性（s3：旁白句界驱动，D1 到康定停·别贪路段·D2 一口气到镇）
  const RING_AT = p.ringAt ?? {};                // {wpsIdx: 秒} 光圈/标签点亮对旁白句界（s3）
  const keyLerp = (keys, t) => {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) if (t <= keys[i][0]) { const a = keys[i - 1], b = keys[i]; return a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]); }
    return keys[keys.length - 1][1];
  };
  if (DIVE_IN) {                                  // 轨迹终点=默认开场弧起点，与 s1 无缝接
    const [dax, daz] = xzOf(YADING_AP.lon, YADING_AP.lat);
    camCurve = new THREE.CatmullRomCurve3([
      V([dax + 2.4, 5.6, daz + 3.4]), V([dax + 4.6, 6.4, daz + 5.6]), V([7.2, 3.6, 5.4]), V([8.8, 1.8, 5.1]),
    ], false, 'centripetal');
    lookCurve = new THREE.CatmullRomCurve3([
      V([dax, 1.0, daz]), V([dax * 0.4, 0.9, daz * 0.4]), V([-0.6, 0.8, -0.5]), V([-2.4, 0.8, -0.8]),
    ], false, 'centripetal');
  }
  // —— PROFILE_ONLY（s2 机制段剖面卡专场）：全屏大卡分步浮现+三拍黑底词；地形/路线元素全退场 ——
  let drawProfile = null;
  if (PROFILE_ONLY) {
    cardDiv.style.cssText = 'position:absolute;inset:0;opacity:0;pointer-events:none;background:linear-gradient(180deg,#0b1216 0%,#070b0d 100%)';
    cardDiv.innerHTML = '';
    const pcv2 = document.createElement('canvas');
    pcv2.width = 1920; pcv2.height = 1080;
    pcv2.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:96%;';
    cardDiv.appendChild(pcv2);
    profileCtx = pcv2.getContext('2d');
    slapDiv = document.createElement('div');
    slapDiv.style.cssText = 'position:absolute;inset:0;opacity:0;pointer-events:none;background:#000;display:flex;align-items:center;justify-content:center;font:700 150px "RuyiSmiley",sans-serif;color:#fff;';
    document.body.appendChild(slapDiv);
    terrainMesh.visible = false; skirt.visible = false; bTube.visible = false; floor.visible = false;
    for (const { lb, dot, pin } of poiSprites) { lb.visible = false; dot.visible = false; pin.visible = false; }
    if (ROUTES) {
      flightTube.visible = false; driveTube.visible = false; apLabel.visible = false;
      for (const rp of ringPulses) rp.meshes.forEach((m) => (m.visible = false));
      apRing.forEach((m) => (m.visible = false)); cdRing.forEach((m) => (m.visible = false));
      for (const { lb } of wpSprites) lb.visible = false;
    }
    hudAlt.style.opacity = 0; hudTag.style.opacity = 0; heroFull.style.opacity = 0; chipDiv.style.opacity = 0;
    const X0 = 170, X1 = 1810, Y0 = 180, Y1 = 770, ALTMAX = 5000;
    const ax = (f) => X0 + f * (X1 - X0), ay = (h) => Y1 - (h / ALTMAX) * (Y1 - Y0);
    drawProfile = (t) => {
      const g = profileCtx;
      g.clearRect(0, 0, 1920, 1080);
      // 三拍黑底词（7.6-11.15）：头痛/恶心/整晚睡不着
      const SLAPS = [['头痛', 8.4], ['恶心', 9.3], ['整晚睡不着', 10.35]];
      let slapOn = null;
      for (const s of SLAPS) if (t >= s[1] && t < s[1] + 1.15) slapOn = s;
      if (slapOn) {
        slapDiv.textContent = slapOn[0];
        const lt = t - slapOn[1];
        slapDiv.style.opacity = Math.min(1, lt / 0.15) * (1 - smooth((lt - 0.85) / 0.3));
      } else slapDiv.style.opacity = 0;
      // 卡透明度时间线：淡入→三拍隐→手册窗压暗（compose 叠实拍）→红线段回亮
      let op = smooth(t / 1.2) * (1 - smooth((t - 8.2) / 0.5));
      if (t >= 11.5 && t < 16.6) op = 0.07;
      if (t >= 16.6) op = smooth((t - 16.6) / 0.7);
      cardDiv.style.opacity = op;
      if (op < 0.02) return;
      // 标题+网格
      g.fillStyle = '#fff'; g.font = '700 54px "RuyiSmiley",sans-serif';
      g.fillText('直飞 vs 自驾 · 海拔怎么爬', 110, 100);
      g.strokeStyle = 'rgba(255,255,255,.13)'; g.lineWidth = 1.5;
      g.font = '400 26px sans-serif';
      for (const h of [1000, 2000, 3000, 4000]) {
        g.beginPath(); g.moveTo(X0, ay(h)); g.lineTo(X1, ay(h)); g.stroke();
        g.fillStyle = 'rgba(255,255,255,.45)'; g.fillText(h + 'm', X0 - 96, ay(h) + 9);
      }
      // 拉萨 3650 灰虚线
      g.strokeStyle = 'rgba(255,255,255,.6)'; g.lineWidth = 2.5; g.setLineDash([12, 9]);
      g.beginPath(); g.moveTo(X0, ay(3650)); g.lineTo(X1, ay(3650)); g.stroke(); g.setLineDash([]);
      g.fillStyle = 'rgba(255,255,255,.8)'; g.font = '400 30px "RuyiSmiley",sans-serif';
      g.fillText('拉萨 3650 · 多少人一下飞机就高反', X0 + 340, ay(3650) - 18);
      // 数据字（1.2-7.1）：氧气六成/血氧 98→80+（底部空区，避让波浪尖峰）
      if (t >= 3.5 && t < 8.3) {
        g.save(); g.globalAlpha = smooth((t - 3.5) / 0.6) * (1 - smooth((t - 8.1) / 0.4));
        g.fillStyle = '#ffd98a'; g.font = '700 64px "RuyiSmiley",sans-serif';
        g.fillText('氧气不到平原六成', X0 + 180, 870);
        g.fillText('血氧 98 → 80+', X0 + 180, 960);
        g.restore();
      }
      // 缺氧红线 4300（16.6 起）
      if (t >= 16.6) {
        g.save(); g.globalAlpha = smooth((t - 16.6) / 0.8);
        g.strokeStyle = '#ff5346'; g.lineWidth = 3; g.setLineDash([12, 9]);
        g.beginPath(); g.moveTo(X0, ay(4300)); g.lineTo(X1, ay(4300)); g.stroke(); g.setLineDash([]);
        g.fillStyle = '#ff8a7e'; g.font = '700 32px "RuyiSmiley",sans-serif';
        g.fillText('缺氧红线 · 14000英尺 ≈ 4300米', X0 + 560, ay(4300) - 18);
        g.restore();
      }
      // 自驾波浪+站点
      g.strokeStyle = '#ffab33'; g.lineWidth = 5; g.beginPath();
      for (let i = 0; i <= NPTS; i++) { const f = i / NPTS; i ? g.lineTo(ax(f), ay(driveAlt[i])) : g.moveTo(ax(f), ay(driveAlt[0])); }
      g.stroke();
      g.fillStyle = '#ffab33'; g.font = '700 32px "RuyiSmiley",sans-serif';
      g.fillText('自驾 · 2天', ax(0.78), ay(4500) + 96);
      g.font = '400 28px "RuyiSmiley",sans-serif';
      for (const w of [{ f: 0.33, t: '康定 2500', dy: 48 }, { f: 0.45, t: '折多山 4298', dy: -26 }, { f: 0.7, t: '理塘 4000', dy: -26 }]) {
        const i = Math.min(NPTS, Math.round(w.f * NPTS));
        g.fillText(w.t, ax(w.f) - 70, ay(driveAlt[i]) + w.dy);
      }
      const tail = '香格里拉镇 2900';
      g.fillText(tail, X1 - g.measureText(tail).width - 10, ay(driveAlt[NPTS]) + 50);
      // 直飞近垂直线
      g.strokeStyle = '#ff5346'; g.lineWidth = 7; g.beginPath();
      g.moveTo(ax(0.02), ay(500)); g.lineTo(ax(0.10), ay(4411)); g.stroke();
      g.fillStyle = '#ff5346'; g.font = '700 32px "RuyiSmiley",sans-serif';
      g.fillText('直飞 · 1小时', ax(0.15), ay(4780));
      g.fillText('4411m', ax(0.125), ay(4411) + 44);
      // 4411 红点（16.6 起脉冲）/ 2900 绿点（28.5-36 对闪）
      const versus = t >= 32.3 && t < 39.2;
      let r4411 = 0, r2900 = 0;
      if (t >= 16.6) r4411 = 11 + 3.5 * Math.sin(t * 5);
      if (versus) { const ph = Math.floor(t / 0.7) % 2; r4411 = ph === 0 ? 17 : 9; r2900 = ph === 1 ? 17 : 9; }
      else if (t >= 39.2) { r4411 = 11; r2900 = 9; }
      if (r4411 > 0) {
        g.fillStyle = '#ff5346';
        g.beginPath(); g.arc(ax(0.10), ay(4411), r4411, 0, Math.PI * 2); g.fill();
        g.strokeStyle = 'rgba(255,83,70,.5)'; g.lineWidth = 3;
        g.beginPath(); g.arc(ax(0.10), ay(4411), r4411 + 7, 0, Math.PI * 2); g.stroke();
      }
      if (r2900 > 0) {
        g.fillStyle = '#7fe0a8';
        g.beginPath(); g.arc(ax(1.0), ay(driveAlt[NPTS]), r2900, 0, Math.PI * 2); g.fill();
        g.strokeStyle = 'rgba(127,224,168,.5)'; g.lineWidth = 3;
        g.beginPath(); g.arc(ax(1.0), ay(driveAlt[NPTS]), r2900 + 7, 0, Math.PI * 2); g.stroke();
      }
      // 两招（22.5-37）
      if (t >= 26.9) {
        g.save(); g.globalAlpha = smooth((t - 26.9) / 0.8) * (1 - smooth((t - 32.8) / 0.8));
        g.fillStyle = '#fff'; g.font = '400 44px "RuyiSmiley",sans-serif';
        g.fillText('深呼吸 = 几个小时才顶用', X0 + 180, 880);
        g.fillStyle = '#ffd98a';
        g.fillText('多造血 = 得按周算', X0 + 1000, 880);
        g.restore();
      }
      // 定格金句（37 起）
      if (t >= 39.4) {
        g.save(); g.globalAlpha = smooth((t - 39.4) / 0.9);
        g.textAlign = 'center';
        g.fillStyle = '#ffd98a'; g.font = '700 84px "RuyiSmiley",sans-serif';
        g.fillText('这是一笔物理账 · 人人平等', 960, 950);
        g.fillStyle = '#fff'; g.font = '400 46px "RuyiSmiley",sans-serif';
        g.fillText('高反不挑体质 · 只认爬升速度', 960, 1030);
        g.textAlign = 'left';
        g.restore();
      }
    };
  }
  const introEndCam = camCurve.getPointAt(1), introEndLook = lookCurve.getPointAt(1);
  // 飞行镜头：低空侧后下往上看（成都东南低机位 → 望雪山墙+红线爬升）
  const flyCam0 = new THREE.Vector3(5.6, 1.15, 3.9), flyCam1 = new THREE.Vector3(5.0, 1.3, 3.5);
  const flyLook0 = new THREE.Vector3(-2.4, 1.7, -0.9), flyLook1 = new THREE.Vector3(-2.7, 1.85, -1.0);
  // 开车总揽上帝视角：锁 pitch 微推向走廊；EP8 扩展 p.godCam0/1+p.godLook0/1（侧视剖面机位注入，默认不变）
  const godCam0 = V(p.godCam0 ?? [0.8, 9.4, 6.8]), godCam1 = V(p.godCam1 ?? [0.1, 8.2, 6.0]);
  const godLook0 = V(p.godLook0 ?? [-0.5, 0.05, -0.6]), godLook1 = V(p.godLook1 ?? [-1.1, 0.15, -0.65]);
  // 收尾走廊上帝视角
  const endCam = new THREE.Vector3(-0.6, 7.6, 5.5), endLook = new THREE.Vector3(-1.6, 0.6, -0.7);
  const NPTS = ROUTES ? drivePts.length - 1 : 0;
  return (t) => {
    if (PROFILE_ONLY) { drawProfile(t); return; }
    // —— 相机 ——
    if (!ROUTES || (!DRIVE_ONLY && t < T_FLY)) {
      const kk = smooth(Math.min(1, (t / Math.min(T_FLY, T)) / 0.92));
      camera.position.copy(camCurve.getPointAt(kk));
      camera.lookAt(lookCurve.getPointAt(kk));
    } else if (t < T_DRV) {                      // 飞行镜头（硬切进入，缓推）
      const q = smooth((t - T_FLY) / (T_DRV - T_FLY));
      camera.position.copy(flyCam0).lerp(flyCam1, q);
      camera.lookAt(flyLook0.clone().lerp(flyLook1, q));
    } else if (t < T_END) {                      // 开车=总揽全图上帝视角（主人：不要局部跟拍）
      // EP9 扩展（2026-09-26）：p.introSec=DRIVE_ONLY 下先走 camPts/lookPts 进场曲线
      // （低机位英雄镜→升起总览，EP6 非 DRIVE_ONLY 的 camCurve 效果在 DRIVE_ONLY 复现）
      const INTRO = DRIVE_ONLY ? (p.introSec ?? 0) : 0;
      if (INTRO > 0 && t < INTRO) {
        const kk = smooth(t / INTRO);
        camera.position.copy(camCurve.getPointAt(kk));
        camera.lookAt(lookCurve.getPointAt(kk));
      } else {
      const q = smooth((t - Math.max(T_DRV, INTRO)) / (T_END - Math.max(T_DRV, INTRO)));
      camera.position.copy(godCam0).lerp(godCam1, q);
      camera.lookAt(godLook0.clone().lerp(godLook1, q));
      }
    } else {                                     // 剖面卡前微沉
      const q = smooth((t - T_END) / 2.0);
      camera.position.copy(godCam1).lerp(endCam, q);
      camera.lookAt(godLook1.clone().lerp(endLook, q));
    }
    // —— EP9 扩展（2026-09-26 主人判词：运动跟拍视角学黄山）——
    // p.followCam={t0,t1,u0,u1,h,look,side,lookLift}：低空沿自驾链滑行跟拍——
    // 相机贴路线上方 h、沿路切线前看 look(frac)，山体从两旁升起=爬升体感。
    // 相机/注视走 driveSmooth（31 点移动平均路径，huashan 防抖判例），贴地抖动不进镜头。
    const FOLLOW = p.followCam ?? null;
    if (FOLLOW && ROUTES && t >= (FOLLOW.t0 ?? 0) && t <= (FOLLOW.t1 ?? T_END)) {
      if (FOLLOW.track != null && WALKERS[FOLLOW.track]) {
        // 【张家界规范】跟拍锚定 walker：相机在 icon 后上方 back/h/side，注视 icon 前方 ahead——
        // icon 永在画中下三分之一（此前相机自带 u(t) 比车快=「看不到车」病根）
        const w = WALKERS[FOLLOW.track];
        const wq = smooth((t - w.t0) / Math.max(0.01, w.t1 - w.t0));
        const wu = (w.u0 ?? 0) + ((w.u1 ?? 1) - (w.u0 ?? 0)) * wq;
        const PATH = w.path ?? driveSmooth, PN = PATH.length - 1;
        const wi = Math.min(PN, Math.max(0, Math.round(wu * PN)));
        const fp = PATH[wi];
        const j0 = Math.max(0, wi - 40), j1 = Math.min(PN, wi + 40);   // 长窗切线=回头弯不甩头
        let tx = PATH[j1].x - PATH[j0].x, tz = PATH[j1].z - PATH[j0].z;
        const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
        const back = FOLLOW.backKeys ? keyLerp(FOLLOW.backKeys, t) : (FOLLOW.back ?? 0.025);   // 推近推远时间轴
        const hh = FOLLOW.hKeys ? keyLerp(FOLLOW.hKeys, t) : (FOLLOW.h ?? 0.03);
        const sd = FOLLOW.side ?? 0;
        const camX = fp.x - tx * back - tz * sd, camZ = fp.z - tz * back + tx * sd;
        const [clo2, cla2] = [(camX / spanX + 0.5) * (meta.lon1 - meta.lon0) + meta.lon0,
                              meta.lat1 - (0.5 + camZ / spanZ) * (meta.lat1 - meta.lat0)];
        camera.position.set(camX, Math.max(fp.y, groundY(clo2, cla2)) + hh, camZ);
        const ahead = FOLLOW.ahead ?? 0.010;
        camera.lookAt(fp.x + tx * ahead, fp.y + (FOLLOW.lookLift ?? 0.006), fp.z + tz * ahead);
      } else {
      const fq = smooth((t - (FOLLOW.t0 ?? 0)) / Math.max(0.01, (FOLLOW.t1 ?? T_END) - (FOLLOW.t0 ?? 0)));
      const fu = (FOLLOW.u0 ?? 0) + ((FOLLOW.u1 ?? 1) - (FOLLOW.u0 ?? 0)) * fq;
      const fi = Math.min(NPTS, Math.max(0, Math.round(fu * NPTS)));
      const fp = driveSmooth[fi];
      const tx0 = driveSmooth[Math.min(NPTS, fi + 8)], tx1 = driveSmooth[Math.max(0, fi - 8)];
      const tdx = tx0.x - tx1.x, tdz = tx0.z - tx1.z, tdl = Math.hypot(tdx, tdz) || 1;
      const camX = fp.x + (-tdz / tdl) * (FOLLOW.side ?? 0), camZ = fp.z + (tdx / tdl) * (FOLLOW.side ?? 0);
      const [clo, cla] = [(camX / spanX + 0.5) * (meta.lon1 - meta.lon0) + meta.lon0,
                          meta.lat1 - (0.5 + camZ / spanZ) * (meta.lat1 - meta.lat0)];
      // 直线距离前瞻（EP9 判例：发卡弯弧长≫直线，按弧长前看=注视点在发卡弯里打转、俯仰 -2°→82° 鞭打）：
      // 沿路径前扫至直线距离 ≥ lookDist；扫到终点仍不足时沿末端切线外推（到港注视继续指向远处雪峰）
      const LD = FOLLOW.lookDist ?? 0.06;
      let lj = NPTS, ld = 0;
      for (let j = fi + 1; j <= NPTS; j++) {
        ld = Math.hypot(driveSmooth[j].x - fp.x, driveSmooth[j].z - fp.z);
        if (ld >= LD) { lj = j; break; }
      }
      let lp = driveSmooth[lj];
      if (lj === NPTS && ld < LD) {
        const tb = driveSmooth[NPTS], ta = driveSmooth[Math.max(0, NPTS - 40)];
        const ex = tb.x - ta.x, ez = tb.z - ta.z, el = Math.hypot(ex, ez) || 1;
        lp = new THREE.Vector3(tb.x + ex / el * (LD - ld), tb.y, tb.z + ez / el * (LD - ld));
      }
      camera.position.set(camX, Math.max(fp.y, groundY(clo, cla)) + (FOLLOW.h ?? 0.02), camZ);
      camera.lookAt(lp.x, lp.y + (FOLLOW.lookLift ?? 0.01), lp.z);
      }
    }
    // —— EP7 routeLines 生长窗（drawRange 整 tubular 段步进：残缺三角=点线闪判例）——
    for (const { tube, t0, t1, arrows, label } of rlineTubes) {
      const g = smooth((t - t0) / Math.max(0.01, t1 - t0));
      tube.geometry.setDrawRange(0, Math.floor(tube.userData.idxCount * g / tube.userData.seg) * tube.userData.seg);
      if (arrows) arrows.update(g, t);   // EP8 箭头场：线头过后点亮
      if (label) label.material.opacity = smooth((t - t1) / 0.6);   // 线画完浮现
    }
    // —— 地标钉：开场段淡入，路线段让位（沿途标签接手）——
    const lbOp = LABELS_ALWAYS ? 1 : smooth((t / T - 0.42) / 0.2) * (ROUTES ? (1 - smooth((t - (T_FLY + 0.6)) / 0.9)) : 1);
    for (const { lb, dot, pin } of poiSprites) {
      lb.material.opacity = lbOp;
      dot.material.opacity = LABELS_ALWAYS ? 1 : (ROUTES ? lbOp * (1 - smooth((t - T_DRV + 1.2) / 1.2)) + (t >= T_FLY && t < T_DRV ? 1 : 0) * (1 - smooth((t - T_DRV + 1.2) / 1.2)) : lbOp);
      pin.material.opacity = (LABELS_ALWAYS ? 1 : lbOp) * 0.55;
    }
    if (!ROUTES) return;
    // 省界金线：路线段淡出（近机位下糊成奶油色带穿帮）
    bTube.material.opacity = DRIVE_ONLY ? 0.15 : 1 - smooth((t - T_FLY) / 1.2) * 0.85;
    if (!DRIVE_ONLY) {
    // —— 直飞：陡拉爬升 + HUD 500→4411 狠跳（FLIGHT_BACK=返程下行：反向揭示 4411→500）——
    const fD = FLIGHT_BACK ? smooth(t / 4.2) : smooth((t - 9) / 3);
    const fIdx = flightTube.userData.idxCount;
    const SEG = 72;   // 管索引/tubular 段（12 边×2tri×3idx）：drawRange 任意截断=残缺三角形=点线闪（EP6 v4 主人判词），步进对齐整段
    const flyOp = FLIGHT_BACK ? 1 : (t < T_DRV ? 1 : 1 - smooth((t - T_DRV) / 1.2));  // 飞机 sprite 淡出仍用 opacity（sprite 是真透明）
    if (FLIGHT_BACK) flightTube.geometry.setDrawRange(Math.floor(fIdx * (1 - fD) / SEG) * SEG, Math.floor(fIdx * fD / SEG) * SEG);
    else {
      // 实心不透明管：开车段退场改「缩回」（opacity 对不透明材质无效，贴脸红墙穿帮判例仍防住）
      const fade = t < T_DRV ? 1 : 1 - smooth((t - T_DRV) / 1.2);
      flightTube.geometry.setDrawRange(0, Math.floor(fIdx * fD * fade / SEG) * SEG);
    }
    // ✈️ 飞机沿线飞，屏幕空间朝运动方向
    const planeOn = FLIGHT_BACK ? (t >= 0.2 && t < T - 0.6) : (t >= 9 && t < T_DRV + 0.8);
    if (planeOn) {
      planeSpr.visible = true;
      const fu = FLIGHT_BACK ? 1 - fD : fD;
      const fp = flightCurve.getPointAt(Math.min(0.999, Math.max(0.001, fu)));
      planeSpr.position.copy(fp);
      planeSpr.material.opacity = Math.min(1, (t - (FLIGHT_BACK ? 0.2 : 9)) / 0.3) * flyOp;
      const fq = flightCurve.getPointAt(Math.min(0.999, Math.max(0.001, fu + (FLIGHT_BACK ? -0.012 : 0.012))));
      const pa = fp.clone().project(camera), pb = fq.clone().project(camera);
      // v3.2 主人判词「落地要横着落」：45× 高差夸张把真实 2.8° 下滑道投影成 60°+ 俯冲像，
      // 且 fu 钳到 0.999 后方向向量退化、停机姿态会朝天——姿态层修，不动航路数据：
      // ① 屏幕俯仰角全段钳 ±26°（起飞爬升/进近下滑都像真喷气机）② 末段 flare 拉平到近水平
      const dx = pb.x - pa.x, dy = pb.y - pa.y;
      const hSign = dx >= 0 ? 0 : Math.PI;          // 行进水平方向
      let pit = Math.atan2(dy, dx) - hSign;         // 相对水平的俯仰角
      while (pit > Math.PI) pit -= 2 * Math.PI;
      while (pit < -Math.PI) pit += 2 * Math.PI;
      const MAXP = 26 * Math.PI / 180;
      pit = Math.max(-MAXP, Math.min(MAXP, pit));
      const flare = FLIGHT_BACK ? clamp01((0.1 - fu) / 0.08) : clamp01((fu - 0.9) / 0.07);
      pit *= 1 - 0.85 * flare;                      // 拉平段再压到 ≤4°（横着落）
      planeSpr.material.rotation = hSign + pit - Math.PI / 2;
    } else planeSpr.visible = false;
    } else { flightTube.material.opacity = 0; }
    // —— 自驾：贴地波浪推进 + HUD 跟地形（DRIVE_KEYS=句界分段车速；DRIVE_CAP<1=起点预告段，不出车）——
    const dD = clamp01(DRIVE_KEYS ? keyLerp(DRIVE_KEYS, t) : clamp01((t - T_DRV) / (T_END - T_DRV - 0.4))) * DRIVE_CAP;
    driveTube.geometry.setDrawRange(0, Math.floor(driveTube.userData.idxCount * dD));
    if (driveGlow) driveGlow.geometry.setDrawRange(0, Math.floor(driveTube.userData.idxCount * dD));   // 辉光与芯同步生长
    driveTube.material.opacity = 0.95 * (t < T_END ? 1 : 1 - smooth((t - T_END) / 1.5) * 0.6);
    if (driveArrowSet) driveArrowSet.update(dD, t);   // EP8 箭头场（判词⑤：金色路线要能明显看出来方向）
    const hi2 = Math.min(NPTS, Math.round(dD * NPTS));
    // 🚗 车顶在线头，屏幕空间朝运动方向
    if (DRIVE_CAP >= 1 && p.carSprite !== false && t >= T_DRV + 0.15 && t < T_END - 0.1) {   // p.carSprite:false=跟拍镜头只要线生长不要车（EP9 判例：0.42 省尺度车 sprite 在峡谷块=遮屏巨物）
      carSpr.visible = true;
      carSpr.position.copy(drivePts[hi2]).add(new THREE.Vector3(0, 0.06, 0));
      carSpr.material.opacity = Math.min(1, (t - T_DRV) / 0.3);
      const ca = drivePts[hi2].clone().project(camera);
      const cb = drivePts[Math.min(NPTS, hi2 + 6)].clone().project(camera);
      carSpr.material.rotation = -Math.atan2(cb.x - ca.x, cb.y - ca.y);
    } else carSpr.visible = false;
    // —— walkers 行进（EP9）：u0→u1 沿 driveSmooth 滑行，屏幕空间朝运动方向；t 窗外隐身 ——
    for (const w of WALKERS) {
      const on = t >= w.t0 && t <= w.t1;
      w.spr.visible = on;
      if (!on) continue;
      const PATH = w.path ?? driveSmooth, PN = PATH.length - 1;   // 独立路径优先，默认 drive 链
      const wq = smooth((t - w.t0) / Math.max(0.01, w.t1 - w.t0));
      const wu = (w.u0 ?? 0) + ((w.u1 ?? 1) - (w.u0 ?? 0)) * wq;
      const wi = Math.min(PN, Math.max(0, Math.round(wu * PN)));
      const wp = PATH[wi];
      const wsc = (w.scale ?? 0.02);
      const wsh = wsc * (240 / 184);   // 徽章画布 184×240（46×60 张家界原版比例）
      w.spr.scale.set(wsc, wsh, 1);
      w.spr.position.copy(wp).add(new THREE.Vector3(0, wsh * 0.48, 0));   // 针尖扎在路线上
      w.spr.material.opacity = Math.min(1, (t - w.t0) / 0.3) * Math.min(1, (w.t1 - t) / 0.3 + 1);
    }
    // 沿途标签：头过点亮 2.2s（RING_AT=句界显式时刻优先）
    for (const { lb, frac, wi, wh } of wpSprites) {
      const wt = RING_AT[wi] ?? (T_DRV + frac * (T_END - T_DRV - 0.4));
      // v3.2：字放大后亮 3.0s 防拥挤、淡出 1.2s（走过即灭=主人「逐步点亮+过会消失」口径）
      //   EP8 扩展（2026-09-20 总揽级判词）：p.wpLabelHold/p.wpLabelFade 参数化——总图收藏帧需锚点标签常亮（hold 给大值=RETAIN）
      const HOLD = wh ?? p.wpLabelHold ?? 3.0, FADE = p.wpLabelFade ?? 1.2;   // wh=w.hold per-station 覆盖（EP9 判例：总览常亮锚点 vs 短亮点名需要共存）
      lb.material.opacity = smooth((t - wt) / 0.4) * (1 - smooth((t - wt - HOLD) / FADE));
    }
    // —— HUD ——（EP8 扩展 p.hud:false=净版 proof 帧免 HUD）
    const HUD_ON = p.hud ?? true;
    let alt = null, tag = '';
    if (FLIGHT_BACK && t >= 0.2) { alt = 4411 - (4411 - 500) * smooth((t - 0.6) / 4.2); tag = '返程 · 约1小时'; }
    else if (!DRIVE_ONLY && !FLIGHT_BACK && t >= 8.6 && t < T_DRV) { alt = 500 + (4411 - 500) * smooth((t - 9) / 1.2); tag = '直飞 · 约1小时'; }
    else if (!FLIGHT_BACK && t >= T_DRV && t < T_END) { alt = driveAlt[hi2]; tag = '自驾 · 2天'; }
    if (HUD_ON && alt !== null && t < T_END + 0.6) {
      hudAlt.style.opacity = (1 - parseFloat(heroFull.style.opacity || 0)) * Math.min(1, Math.max(0, (t - (DRIVE_ONLY || FLIGHT_BACK ? 0.3 : 8.6))) / 0.5) * (DRIVE_ONLY || FLIGHT_BACK ? 1 : (1 - smooth((t - T_END) / 0.8)));
      const oxy = Math.round(Math.exp(-alt / 8400) * 100);
      let extra = '';
      if (tag.indexOf('直飞') >= 0 && t >= 9)
        extra = '<div style="font-size:32px;color:#ff9d94;margin-top:8px">氧气 ' + oxy + '%</div>'
              + '<div style="font-size:32px;color:#ff9d94">血氧 ' + Math.round(98 - 16 * smooth((t - 9) / 1.2)) + '</div>';
      else
        extra = '<div style="font-size:30px;color:#ffd98a;opacity:.9;margin-top:8px">氧气 ' + oxy + '%</div>';
      hudAlt.innerHTML = Math.round(alt / 10) * 10 + '<span style="font-size:38px"> m</span>'
        + '<div style="font-size:26px;color:#fff;opacity:.85;margin-top:6px">当前海拔</div>' + extra;
      hudTag.style.opacity = hudAlt.style.opacity;
      hudTag.textContent = tag;
    } else { hudAlt.style.opacity = 0; hudTag.style.opacity = 0; }
    // —— 光圈脉冲（站点金/红环+牛奶海白环；STATION_RINGS=false=分段渲染非开车段全关）——
    for (const rp of ringPulses) {
      if (!STATION_RINGS && !rp.finale) { rp.meshes.forEach((m) => (m.material.opacity = 0)); continue; }
      const wt = rp.finale ? T_END + FINALE_AT : (RING_AT[rp.wi] ?? (T_DRV + rp.frac * (T_END - T_DRV - 0.4)));
      const on = ROUTES && t > wt - 0.5 && t < Math.min(wt + 5.5, T_END + 4);
      rp.meshes.forEach((m, k) => {
        if (!on) { m.material.opacity = 0; return; }
        const ph = ((t - wt) * 0.85 + k * 0.5) % 1;
        m.scale.setScalar(0.6 + ph * 2.4);
        m.material.opacity = (1 - ph) * 0.95 * Math.min(1, (t - wt + 0.5) / 0.3);
      });
    }
    // —— 机场落地红环 + 拉萨对比标签（飞行段尾）——
    if (!DRIVE_ONLY) {
      const apOn = !FLIGHT_BACK && t >= 11.8 && t < T_DRV + 1;
      apRing.forEach((m, k) => {
        if (!apOn) { m.material.opacity = 0; return; }
        const ph = ((t - 11.8) * 0.85 + k * 0.5) % 1;
        m.scale.setScalar(0.6 + ph * 2.4);
        m.material.opacity = (1 - ph) * 0.95;
      });
      apLabel.material.opacity = FLIGHT_BACK ? 0 : smooth((t - 12.3) / 0.5) * (1 - smooth((t - (T_DRV - 0.6)) / 0.5));
      // —— 站站全屏兑现（素材为王）：带卡站全屏 hero 2.5s，判词压大图角标；无卡站 chip 过 ——
      // v3：HERO_ON=false 时 hero 由 compose 叠实拍视频；CHIPS_ON=false 时判词由 compose 统一语言
      const EVENTS = (CHIPS_ON || HERO_ON) ? WPS.filter((w) => w.chip).map((w) => ({ frac: WPS.indexOf(w) / (WPS.length - 1), chip: w.chip, card: w.card })) : [];
      if (FINALE) EVENTS.push(FINALE);
      let cur = null, curHero = null;
      for (const ev of EVENTS) {
        const wt = ev.absWtOffset != null ? T_END + ev.absWtOffset : T_DRV + ev.frac * (T_END - T_DRV - 0.4);
        if (t >= wt - 0.3) cur = { ...ev, wt };
        if (HERO_ON && ev.card && t >= wt - 0.1 && t <= wt + 2.4) curHero = { ...ev, wt };
      }
      const heroOn = curHero;  // 牛奶海终章在 T_END 后，不设截断
      if (HERO_ON && curHero) {
        if (heroFullImg.dataset.src !== curHero.card[0]) { heroFullImg.src = '/' + base + '/' + curHero.card[0]; heroFullImg.dataset.src = curHero.card[0]; }
        heroFullTag.textContent = curHero.chip;
      }
      heroFull.style.opacity = (HERO_ON && heroOn)
        ? smooth((t - curHero.wt + 0.1) / 0.35) * (1 - smooth((t - curHero.wt - 2.05) / 0.35))
        : 0;
      if (CHIPS_ON && cur && t < T_END + 0.4) {
        chipDiv.textContent = cur.chip;
        chipDiv.style.opacity = (1 - (heroOn ? heroFull.style.opacity : 0)) * smooth((t - cur.wt + 0.3) / 0.4) * (1 - smooth((t - T_END + 0.2) / 0.6));
      } else { chipDiv.style.opacity = 0; }
      heroDiv.style.opacity = 0;  // 小窗 PIP 判死，全弃
    }
    // —— 成都金环（s0dive 落点/s4back 返程落地）——
    if (CD_PULSE_AT >= 0) {
      const on = t >= CD_PULSE_AT && t < CD_PULSE_AT + 4.2;
      cdRing.forEach((m, k) => {
        if (!on) { m.material.opacity = 0; return; }
        const ph = ((t - CD_PULSE_AT) * 0.85 + k * 0.5) % 1;
        m.scale.setScalar(0.6 + ph * 2.4);
        m.material.opacity = (1 - ph) * 0.95;
      });
    }
    // —— 剖面卡：段末定格 ——
    cardDiv.style.opacity = (!PROFILE_CARD || DRIVE_ONLY) ? 0 : smooth((t - (T_END + 4.2)) / 1.2);  // 牛奶海终章后收束
  };
}

// ——— flood_block：「假如中国」海平面上涨沙盘（2026-09-19，EP6 terrain_block 直系衍生）———
//   数据契约同 terrain_block：base/heights.f32(float32 米, 行0=北缘)+meta.json+surface.jpg。
//   三幕：①海拔总览（卫星贴图×海拔色带混合，低空掠华北读「哪里是洼地」）
//        ②水位 0→maxM 上涨（水面=真 Three.js 平面 mesh 浮在场景里，地形 depth-test 自然遮挡
//          =「陆地变海洋」的直观感；fragment 按高程纹理算水深渐变+近岸羽化+正弦波光）
//        ③终局定格。城市海拔钉=认址锚，水位超过变红。
//   马赛克判死（2026-09-19 主人判词）：geojson 网格 fill=马赛克，正解=整块高程场建连续网格。
async function buildFloodBlock(p) {
  const base = p.base;
  if (!base) throw new Error('flood_block: params.base 必填（fetch_terrain_block 产物目录，服务器相对路径）');
  const meta = await (await fetch('/' + base + '/meta.json')).json();
  const buf = await (await fetch('/' + base + '/heights.f32')).arrayBuffer();
  const HG = new Float32Array(buf);          // 行 0 = 北缘(lat1)，列 0 = 西缘(lon0)

  const midLat = (meta.lat0 + meta.lat1) / 2;
  const KM_LAT = 110.6, KM_LON = 111.3 * Math.cos(midLat * Math.PI / 180);
  const SCALE = 100;
  const spanX = (meta.lon1 - meta.lon0) * KM_LON / SCALE;
  const spanZ = (meta.lat1 - meta.lat0) * KM_LAT / SCALE;
  const EXAG = p.exaggeration ?? 28;
  const STEP = p.step ?? 6;
  const gc = Math.floor(meta.w / STEP), gr = Math.floor(meta.h / STEP);
  const HY = (h) => h / 1000 / SCALE * EXAG;

  // 降采样 + 箱式模糊：颜色轻模糊保碎峰，几何重模糊=抛光沙盘（同 terrain_block）
  let HDS = new Float32Array(gc * gr);
  for (let r = 0; r < gr; r++)
    for (let c = 0; c < gc; c++) HDS[r * gc + c] = HG[(r * STEP) * meta.w + c * STEP];
  const boxBlur = (src, radius) => {   // 可分离两遍（与方形盒等值，148万格半径8快~9倍）
    const mid = new Float32Array(gc * gr), dst = new Float32Array(gc * gr);
    for (let r = 0; r < gr; r++)
      for (let c = 0; c < gc; c++) {
        let s = 0, n = 0;
        for (let dc = -radius; dc <= radius; dc++) {
          const cc = c + dc;
          if (cc < 0 || cc >= gc) continue;
          s += src[r * gc + cc]; n++;
        }
        mid[r * gc + c] = s / n;
      }
    for (let r = 0; r < gr; r++)
      for (let c = 0; c < gc; c++) {
        let s = 0, n = 0;
        for (let dr = -radius; dr <= radius; dr++) {
          const rr = r + dr;
          if (rr < 0 || rr >= gr) continue;
          s += mid[rr * gc + c]; n++;
        }
        dst[r * gc + c] = s / n;
      }
    return dst;
  };
  const HDS_C = boxBlur(HDS, 1);
  for (let pass = 0; pass < (p.blurPasses ?? 2); pass++) HDS = boxBlur(HDS, p.blur ?? 3);

  // 块缘径向衰减（同 EP6 v4：地形向展台沉落，无垂直切片面）
  let edgeDist;
  {
    const EDGE = p.edge ?? 10;
    const dist = new Int16Array(gc * gr).fill(-1);
    const q = [];
    for (let c = 0; c < gc; c++) { dist[c] = 0; q.push(c); dist[(gr - 1) * gc + c] = 0; q.push((gr - 1) * gc + c); }
    for (let r = 0; r < gr; r++) { dist[r * gc] = 0; q.push(r * gc); dist[r * gc + gc - 1] = 0; q.push(r * gc + gc - 1); }
    for (let qi = 0; qi < q.length; qi++) {
      const i = q[qi], r = (i / gc) | 0, c = i % gc, d = dist[i];
      if (d >= EDGE) continue;
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= gr || cc < 0 || cc >= gc) continue;
        const j = rr * gc + cc;
        if (dist[j] === -1) { dist[j] = d + 1; q.push(j); }
      }
    }
    for (let i = 0; i < gc * gr; i++) {
      const d = dist[i];
      if (d > 0 && d < EDGE) { const f = d / EDGE, k = f * f * (3 - 2 * f); HDS[i] *= 0.06 + 0.94 * k; }
    }
    edgeDist = dist;
  }

  // AO：大模糊-实际=凹度，谷地压暗
  const HDS_BIG = boxBlur(HDS, 8);
  const AO = new Float32Array(gc * gr);
  for (let i = 0; i < gc * gr; i++)
    AO[i] = 1 - clamp01((HDS_BIG[i] - HDS[i]) / 500) * 0.35;

  // —— 海拔色带纹理（幕1 直读海拔：洼地青蓝→平原黄绿→山地棕→雪白）——
  const RAMP = [
    [0, 0.14, 0.42, 0.46], [10, 0.18, 0.46, 0.30], [50, 0.52, 0.52, 0.28],
    [200, 0.60, 0.47, 0.30], [500, 0.55, 0.40, 0.33], [1500, 0.74, 0.66, 0.58], [2900, 0.95, 0.95, 0.98],
  ];
  const ramp = (h) => {
    if (h <= RAMP[0][0]) return RAMP[0].slice(1);
    for (let i = 1; i < RAMP.length; i++) {
      if (h <= RAMP[i][0]) {
        const k = (h - RAMP[i - 1][0]) / (RAMP[i][0] - RAMP[i - 1][0]);
        return [0, 1, 2].map(j => RAMP[i - 1][1 + j] + (RAMP[i][1 + j] - RAMP[i - 1][1 + j]) * k);
      }
    }
    return RAMP[RAMP.length - 1].slice(1);
  };
  const bandData = new Uint8Array(gc * gr * 4);
  for (let i = 0; i < gc * gr; i++) {
    const [r, g, b] = ramp(HDS_C[i]);
    bandData[i * 4] = r * 255; bandData[i * 4 + 1] = g * 255; bandData[i * 4 + 2] = b * 255; bandData[i * 4 + 3] = 255;
  }
  const bandTex = new THREE.DataTexture(bandData, gc, gr);
  bandTex.colorSpace = THREE.SRGBColorSpace;
  bandTex.minFilter = THREE.LinearMipmapLinearFilter;   // v22 终根因（判词⑧收口）：
  // 地形闪率 70% vs 水区 2.5%——分区域探针指认：bandTex 无 mipmap 的远处采样噪声
  // x uBand 每帧渐变=噪声纹样逐帧重排=地形全域闪烁（hTex 有 mip 后水区已 2.5% 佐证）
  bandTex.magFilter = THREE.LinearFilter;
  bandTex.wrapS = bandTex.wrapT = THREE.ClampToEdgeWrapping;
  bandTex.generateMipmaps = true;
  bandTex.needsUpdate = true;

  // —— 地形网格：连续 mesh（无掩膜=整块），卫星贴图 × 可调海拔色带混合 ——
  const satTex = (p.colorMode ?? 'sat') === 'sat' ? await tex(base + '/surface.jpg') : null;
  if (satTex) satTex.anisotropy = 16;
  const positions = new Float32Array(gc * gr * 3);
  const colors = new Float32Array(gc * gr * 3);
  const uvs = new Float32Array(gc * gr * 2);
  for (let r = 0; r < gr; r++)
    for (let c = 0; c < gc; c++) {
      const i = r * gc + c;
      positions[i * 3] = (c / (gc - 1) - 0.5) * spanX;
      positions[i * 3 + 1] = HY(Math.max(0, HDS[i]));
      positions[i * 3 + 2] = (r / (gr - 1) - 0.5) * spanZ;
      uvs[i * 2] = c / (gc - 1);
      uvs[i * 2 + 1] = 1 - r / (gr - 1);
      const ao = AO[i];
      let fade = 1;
      const d = edgeDist[i];
      if (d > 0 && d < 10) { const f = d / 10; fade = 0.42 + 0.58 * (f * f * (3 - 2 * f)); }
      const v = ao * fade;
      colors[i * 3] = v; colors[i * 3 + 1] = v; colors[i * 3 + 2] = v;
    }
  const tIdx = [];
  for (let r = 0; r < gr - 1; r++)
    for (let c = 0; c < gc - 1; c++) {
      const a = r * gc + c, b = r * gc + c + 1, d = (r + 1) * gc + c, e = (r + 1) * gc + c + 1;
      tIdx.push(a, d, b, b, d, e);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(tIdx);
  geo.computeVertexNormals();
  const bandUniform = { value: p.bandStart ?? 0.88 };
  const terrainMat = new THREE.MeshStandardMaterial({ map: satTex ?? null, vertexColors: true, roughness: 1, metalness: 0 });
  if (satTex) terrainMat.onBeforeCompile = (sh) => {   // 幕1 海拔色带混合（幕2 渐退保卫星质感）+ 湿润带（水到之前土地先「湿」）
    sh.uniforms.uBand = bandUniform;
    sh.uniforms.uBandTex = { value: bandTex };
    sh.uniforms.uWLt = wlUniform;                      // 与水面共用同一水位 uniform
    sh.uniforms.uHTex = { value: hTex };
    sh.fragmentShader = 'uniform float uBand; uniform sampler2D uBandTex; uniform float uWLt; uniform sampler2D uHTex;\\n' + sh.fragmentShader;
    sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>',
      '#include <map_fragment>\\n      diffuseColor.rgb = mix(diffuseColor.rgb, texture2D(uBandTex, vMapUv).rgb, uBand);\\n      float thT = texture2D(uHTex, vMapUv).r * 80.0; diffuseColor.rgb *= 1.0;   // v20 终判（判词⑧）：湿润带三态切换（干亮→湿暗→水蓝）在时间轴上=剧烈亮度摆动=闪感本体。删湿润带：地形亮度恒定，水以 alpha 渐变接管=单一平滑过渡');
  };
  const terrainMesh = new THREE.Mesh(geo, terrainMat);
  scene.add(terrainMesh);

  // 展台底座
  // v6 判词「平面沙盘/标准地图」：展台删除——中国立在海里，水即海（水已扩 span*9）
  camera.far = 700;          // 水面扩到 span*9 后外缘更远
  if (p.cam === 'plain') { camera.fov = 34; }   // 平原看海拔：中长焦压缩感；终局拉高段 setState 内动态放宽到 40
  else if (p.cam === 'full') { camera.fov = 40; }   // 30° 垂直装不下南北 41.5 单位
  camera.updateProjectionMatrix();

  // 灯光/大气：look=real（默认）=山清水秀真实地图感（亮天/淡雾/暖阳）；look=dark=EP6 暗调沙盘
  if ((p.look ?? 'real') === 'real') {
    scene.background = new THREE.Color(p.skyColor ?? 0xbcd6ea);
    scene.fog = new THREE.FogExp2(0xa8c2d6, p.fogDensity ?? 0.0035);
  } else {
    scene.fog = new THREE.FogExp2(0x0c141a, p.fogDensity ?? 0.016);
  }
  const sun = new THREE.DirectionalLight(0xfff8ec, p.sunI ?? 3.1);
  sun.position.set(-spanX * 0.3, 52, spanZ * 0.55);
  scene.add(sun);
  scene.add(new THREE.AmbientLight((p.look ?? 'real') === 'real' ? 0xd4e6f0 : 0x4a5e78,
    (p.look ?? 'real') === 'real' ? 2.7 : 1.25));

  // —— 高程纹理（水面 shader 采样：h/80m → Uint8，块外由 shader 判深海）——
  const HMAX = 80;
  // 水面用高程纹理：低地（<80m，即会被淹的平原）额外大半径模糊——
  // 平原 DEM ±1-2m 噪声 × 水位过零 = 成片水出没（武汉江汉平原判例）。
  // 只模糊水面纹理不动几何：视觉水线平滑，沙盘地形细节保留
  let HDS_W = HDS;
  {
    const LB = p.lowBlur ?? 10;
    const soft = boxBlur(HDS, LB);
    HDS_W = new Float32Array(gc * gr);
    for (let i = 0; i < gc * gr; i++) {
      const k = 1 - clamp01(HDS[i] / 120);   // 0-120m 渐变混入强模糊（低地全柔化，120m 以上原样）
      HDS_W[i] = HDS[i] * (1 - k) + soft[i] * k;
    }
  }
  // v25 终判（判词⑧收口）：黑-白二值翻转实锤=水面 vUv 亚像素移动 x hTex 相邻
  // texel 高差（山地海岸 20m+）= depth 帧间跳 = foam白边-深海黑 帧间翻转。
  // mipmap 无效（mip0 仍高频）；正解=水面高程纹理 4x 降分辨率：相邻 texel 高差/4
  const gc4 = Math.max(2, gc >> 2), gr4 = Math.max(2, gr >> 2);
  const hData = new Uint8Array(gc4 * gr4);
  for (let r = 0; r < gr4; r++)
    for (let c = 0; c < gc4; c++) {
      let s = 0, n = 0;
      for (let rr = r * 4; rr < Math.min(gr, (r + 1) * 4); rr++)
        for (let cc = c * 4; cc < Math.min(gc, (c + 1) * 4); cc++) { s += HDS_W[rr * gc + cc]; n++; }
      hData[r * gc4 + c] = Math.min(255, Math.max(0, Math.round((s / Math.max(1, n)) / HMAX * 255)));
    }
  // 水面高程纹理：**mipmap 必须**（判词⑧终根因）：无 mip 的 DataTexture 在远处水面
  // 逐像素采样高频高程场=全水面像素噪声闪烁（逐像素时间频谱 44% 像素高频振荡实测坐实；
  // 均值/占比探针全部测不出，只有单像素时间序列能看见）
  const hTex = new THREE.DataTexture(hData, gc4, gr4);
  hTex.minFilter = THREE.LinearMipmapLinearFilter;
  hTex.magFilter = THREE.LinearFilter;
  hTex.wrapS = hTex.wrapT = THREE.ClampToEdgeWrapping;
  hTex.generateMipmaps = true;
  hTex.needsUpdate = true;

  // —— 水面：整片平面 mesh（y=水位），地形 depth-test 遮挡=水绕山走的直观感 ——
  const MAXM = p.maxM ?? 50;
  const wlUniform = { value: 0 };            // 米
  // 水面 v6（主人判词「啥玩意啊/闪的不行」根治）：①去 sin 时间波光（高频图案随水位/相机爬行=闪源）
  // ②不透明：颜色全由水深驱动，无 alpha 大面积混合；③岸线羽化带收窄到 3m 防推进锯齿爬行
  const waterMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,   // v16 真根因：opaque 材质忽略 gl_FragColor 的 alpha——
    // shore 渐变带从未生效过（水面硬出现=水线乱跳观感）。恢复 transparent+depthWrite:false；
    // z-fighting 由 waterLift(默认 0.002→) 抬高防（经验值 0.012 在 45 倍夸张下无视觉缝隙）
    uniforms: { uWL: wlUniform, uH: { value: hTex }, uHMAX: { value: HMAX }, uMaxM: { value: MAXM } },
    vertexShader: [
      'varying vec2 vUv; varying vec3 vWpos;',
      'void main(){ vUv = uv; vec4 wp = modelMatrix * vec4(position,1.0); vWpos = wp.xyz;',
      '  gl_Position = projectionMatrix * viewMatrix * wp; }'].join('\\n'),
    fragmentShader: [
      'uniform float uWL; uniform sampler2D uH; uniform float uHMAX; uniform float uMaxM;',
      'varying vec2 vUv; varying vec3 vWpos;',
      'void main(){',
      '  float inB = step(0.001, vUv.x) * step(vUv.x, 0.999) * step(0.001, vUv.y) * step(vUv.y, 0.999);',
      '  float h = texture2D(uH, vUv).r * uHMAX;',
      '  float depth = uWL - h;',
      // v27 终判（判词⑧全案收口）：块外不画水！卫星图自带海色（Esri 影像海=蓝），
      // 水面 mesh 只负责「涨出来的新海」——块外渲染=与卫星海色双层叠加，
      // 海岸线处两色争夺=「有水的边界都闪」的本体。块外过渡由地形裙边衰减承担
      '  if (inB < 0.5) discard;',
      '  vec3 shoreC = vec3(0.42, 0.78, 0.82);',     // 滩涂浅青（水刚漫到=亮）
      '  vec3 shallowC = vec3(0.16, 0.58, 0.72);',
      '  vec3 midC = vec3(0.05, 0.32, 0.52);',
      '  vec3 deepC = vec3(0.008, 0.07, 0.16);',
      '  float foam = 1.0 - smoothstep(0.5, 20.0, depth);',   // 白边带宽 0.5-20m：扫过像素的亮度脉冲拉长4倍=低频（窄白边2-3帧脉冲=高频闪判死）
      '  foam *= clamp(28.0 / distance(cameraPosition, vWpos), 0.12, 1.0);',  // v28：白边远处淡出——终局高空视角下细白线=高频晃感；28 单位外压到 12%
      // 闪源根治：色界钉在地形高程 h 上（等深线贴地不动），水位涨=淹没范围扩+水线推进，
      // 已淹没像素颜色不随 WL 变——depth 分层的色界随 WL 每帧扫过整片水面=弥散闪（13.6 判死）
      '  vec3 col = mix(mix(mix(shoreC, shallowC, smoothstep(2.0, 8.0, h)), midC, smoothstep(8.0, 20.0, h)), deepC, smoothstep(20.0, 55.0, h));',
      '  col = mix(col, deepC, smoothstep(0.0, 10.0, uWL - 40.0));',   // 块外深海随满水位微压暗
      '  float shore = smoothstep(-2.0, 20.0, depth);',// 岸线羽化带（出现过渡 22m：状态切换速度=闪感的分母）
      '  col = mix(col, vec3(0.93, 0.97, 1.0), foam * 0.5);',  // 白边亮度压半：脉冲幅度=闪感主源
      '  gl_FragColor = vec4(col, shore);',
      '}'].join('\\n'),
  });
  // 标准地图感：无展台，中国直接立在海里——水扩到视野尽头，四周皆海
  const water = new THREE.Mesh(new THREE.PlaneGeometry(spanX * 9, spanZ * 9), waterMat);
  // v17 真根因（判词⑧终结）：缓坡地形（华北 0.1% 坡度）与水面近平行=大面积 z 竞争带，
  // 水位每帧升→交线爬行→地形/水深度竞争帧帧翻转=全水面乱跳。polygonOffset 把水面
  // 深度整体 bias，交线翻转被吸收（waterLift 抬高只是挪竞争带位置不消除）
  water.material.polygonOffset = true;
  water.material.polygonOffsetFactor = -2;
  water.material.polygonOffsetUnits = -2;
  water.rotation.x = -Math.PI / 2;
  water.position.y = 0.001;
  scene.add(water);

  // —— 城市海拔钉（认址锚：水位超过海拔 → 红色「已淹没」）——
  const lonLat2xz = (lon, lat) => [
    ((lon - meta.lon0) / (meta.lon1 - meta.lon0) - 0.5) * spanX,
    ((meta.lat1 - lat) / (meta.lat1 - meta.lat0) - 0.5) * spanZ,
  ];
  const groundY = (lon, lat) => {
    const c = clamp01((lon - meta.lon0) / (meta.lon1 - meta.lon0)) * (gc - 1);
    const r = clamp01((meta.lat1 - lat) / (meta.lat1 - meta.lat0)) * (gr - 1);
    const c0 = Math.floor(c), r0 = Math.floor(r);
    const c1 = Math.min(gc - 1, c0 + 1), r1 = Math.min(gr - 1, r0 + 1);
    const fc = c - c0, fr = r - r0;
    const h = HDS[r0 * gc + c0] * (1 - fc) * (1 - fr) + HDS[r0 * gc + c1] * fc * (1 - fr)
            + HDS[r1 * gc + c0] * (1 - fc) * fr + HDS[r1 * gc + c1] * fc * fr;
    return HY(Math.max(0, h));
  };
  const LSC = (window.__SC__ || 1);
  const labelSprite = (text, scale = 1, color = '#ffffff') => {
    const cv = document.createElement('canvas');
    let g = cv.getContext('2d');
    g.font = 'bold ' + (100 * LSC) + 'px "RuyiSmiley", sans-serif';
    cv.width = Math.max(768 * LSC, Math.ceil(g.measureText(text).width) + 96 * LSC);
    cv.height = 192 * LSC;
    g = cv.getContext('2d');
    g.font = 'bold ' + (100 * LSC) + 'px "RuyiSmiley", sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 16 * LSC; g.strokeStyle = 'rgba(8,12,10,0.92)';
    g.strokeText(text, cv.width / 2, 96 * LSC);
    g.fillStyle = color;
    g.fillText(text, cv.width / 2, 96 * LSC);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, depthTest: false }));
    sp.scale.set(cv.width * (2.6 / 768) * scale / LSC, 0.65 * scale, 1);
    return sp;
  };
  const CITIES = p.cities ?? [
    { name: '北京 43m', lon: 116.40, lat: 39.90, elev: 43 },
    { name: '天津 3m', lon: 117.20, lat: 39.13, elev: 3 },
    { name: '哈尔滨 132m', lon: 126.53, lat: 45.80, elev: 132 },
    { name: '济南 50m', lon: 117.00, lat: 36.65, elev: 50 },
    { name: '西安 400m', lon: 108.94, lat: 34.34, elev: 400 },
    { name: '上海 4m', lon: 121.47, lat: 31.23, elev: 4 },
    { name: '南京 8m', lon: 118.80, lat: 32.06, elev: 8 },
    { name: '武汉 23m', lon: 114.30, lat: 30.60, elev: 23 },
    { name: '成都 500m', lon: 104.06, lat: 30.57, elev: 500 },
    { name: '广州 11m', lon: 113.26, lat: 23.13, elev: 11 },
    { name: '长沙 63m', lon: 112.94, lat: 28.23, elev: 63 },
  ];
  const mkDiv = (css) => { const d = document.createElement('div'); d.style.cssText = css; document.body.appendChild(d); return d; };
  const cityObjs = CITIES.map((ci, idx) => {
    const [x, z] = lonLat2xz(ci.lon, ci.lat);
    const y = groundY(ci.lon, ci.lat);
    // v27：城市标注全 DOM 化——3D dot/pin 判死（远距亚像素覆盖抖动=周期亮脉冲）
    const _dot = null, _pin = null;
    // v26 终判（判词⑧收口）：文字 sprite=3D billboard 亚像素重采样抖动（黑白边缘
    // 逐帧跳变=「闪」本体）。v27 补刀：dot/pin 3D 几何在远距下同为亚像素覆盖抖动源——
    // 城市标注三件全部 DOM 化（圆点+文字+淹没红渐变），投影到整数像素，屏幕恒定尺寸
    const lb = mkDiv('position:absolute;left:0;top:0;pointer-events:none;white-space:nowrap;'
      + 'font:700 ' + Math.round(26 * (p.cityScale ?? 0.95)) + 'px "RuyiSmiley",sans-serif;'
      + 'color:#fff;text-shadow:0 2px 8px rgba(0,0,0,.85);will-change:transform');
    lb.textContent = ci.name;
    const dot = mkDiv('position:absolute;left:0;top:0;pointer-events:none;width:14px;height:14px;'
      + 'border-radius:50%;background:#ffd97a;box-shadow:0 0 0 3px rgba(0,0,0,.35),0 0 14px rgba(255,217,122,.6);'
      + 'will-change:transform');
    scene.remove(_dot); scene.remove(_pin);
    return { ...ci, dot, pin: null, lb, anchor: new THREE.Vector3(x, y + 0.1, z) };
  });

  // —— DOM HUD ——
  const hudLvl = mkDiv('position:absolute;right:64px;top:56px;opacity:0;pointer-events:none;text-align:right;'
    + 'font:700 120px "RuyiSmiley",sans-serif;color:#7fd4e8;text-shadow:0 4px 24px rgba(0,0,0,.8);line-height:1');
  const hudCap = mkDiv('position:absolute;right:64px;top:190px;opacity:0;pointer-events:none;text-align:right;'
    + 'font:700 34px "RuyiSmiley",sans-serif;color:#fff;text-shadow:0 2px 12px rgba(0,0,0,.7)');
  const hudTitle = mkDiv('position:absolute;left:64px;top:56px;pointer-events:none;'
    + 'font:700 54px "RuyiSmiley",sans-serif;color:#fff;text-shadow:0 3px 20px rgba(0,0,0,.85);line-height:1.25');
  const hudSub = mkDiv('position:absolute;left:64px;top:132px;pointer-events:none;'
    + 'font:500 30px "RuyiSmiley",sans-serif;color:#cfe6d8;text-shadow:0 2px 12px rgba(0,0,0,.7)');
  const hudDisc = mkDiv('position:absolute;left:50%;bottom:36px;transform:translateX(-50%);pointer-events:none;white-space:nowrap;'
    + 'font:500 24px "RuyiSmiley",sans-serif;color:rgba(255,255,255,.72);text-shadow:0 1px 8px rgba(0,0,0,.8)');
  hudDisc.textContent = '科学思想实验 · 非预测 ｜ 全球冰盖全部融化上限约 +70m ｜ 当前实际海平面年升约 4mm';
  const hudLegend = mkDiv('position:absolute;left:64px;bottom:56px;pointer-events:none;'
    + 'font:500 26px "RuyiSmiley",sans-serif;color:#e8f2ec;line-height:1.9;text-shadow:0 2px 10px rgba(0,0,0,.85)');
  hudLegend.innerHTML = '<span style="color:#2e8f9a">■</span> 0-10m · 大水首先到这<br>'
    + '<span style="color:#5d8a4e">■</span> 10-50m<br><span style="color:#a9835c">■</span> 50-200m<br>'
    + '<span style="color:#d8cfc0">■</span> 200m 以上';

  // —— 时间编排 ——
  const DUR = CFG.duration;
  const T1 = p.tAct1 ?? DUR * 0.3;           // 幕1 海拔总览
  const T2 = p.tAct2 ?? DUR * 0.82;          // 幕2 水涨截止
  const ease = (x) => { x = clamp01(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
  // v16 终版涨速：幂 p=0.65 前慢后快——低地（水线扫得快的区域）淹没时 dWL 更小，
  // 白边扫过单像素的时间拉长=脉冲低频化；后段高地坡陡水线天然慢，提速无妨
  const lvlAt = (t) => (t < T1 ? 0 : MAXM * Math.pow(clamp01((t - T1) / (T2 - T1)), 0.65));
  const bandAt = (t) => {   // 幕1 全色带 → 幕2 前半退到 0.12（卫星质感接管，保留淡海拔感）
    const k = clamp01((t - T1 * 0.6) / (T2 - T1 * 0.6));
    return (p.bandStart ?? 0.88) * (1 - k) + 0.12 * k;
  };
  // 三幕相机：幕1 华北低空掠（色带可读）→ 幕2 拉远拉高看水进 → 幕3 定格局
  const CX = 0, CZ = 0.35 * spanZ;           // 视觉中心偏华北
  // cam=full：上帝视角看完整中国（SE 高空斜俯视 → 微推 → 拉高收格局）；默认=区域近景三幕
  // v6 cam=plain（主人判词「平原看海拔的视角」）：站在华北平原上空朝西看三级阶梯墙（45 倍夸张下墙即海拔）；
  // 水涨时相机贴水面上方随水位浮升（脚下永远是新生海，前方地形墙始终立着）；终局拉高空定格全图。
  // pos.y 中的 0.9 基准=平原上方低空；look 朝西看地形墙中部。
  const camKey = p.cam === 'plain' ? [
    // v27 全案收口（判词⑧）：幕1→幕2 相机每帧 ~50px 移动=高频纹理视差闪（每帧
    // 大幅亮度跳变=主人看到的「边界都闪」的真身——非水线 bug 是相机速度）。
    // 水涨段相机近乎驻场（<8px/帧）：观众凝视水面上涨，画面运动留给水
    { t: 0,    pos: [spanX * 0.38, 1.35, spanZ * 0.16], look: [-spanX * 0.30, 1.1, spanZ * 0.05] },
    { t: T1,   pos: [spanX * 0.37, 1.42, spanZ * 0.17], look: [-spanX * 0.30, 1.0, spanZ * 0.02] },
    { t: T2,   pos: [spanX * 0.36, 1.9, spanZ * 0.20], look: [-spanX * 0.22, 0.8, 0] },
    // 终局「提起来」（v10 幌判词终解）：拉升 8s 半速——《家园》式极缓拉高
    { t: T2 + 8.0, pos: [spanX * 0.10, 44, spanZ * 0.96], look: [0, 0.6, 0] },
    { t: DUR - 2.0, pos: [spanX * 0.05, 46.2, spanZ * 0.99], look: [0, 0.5, 0] },
    { t: DUR,  pos: [spanX * 0.05, 46.2, spanZ * 0.99], look: [0, 0.5, 0] },  // v28：末 2s 完全定格（终局总揽文字+水线静止）
  ] : p.cam === 'full' ? [
    { t: 0,    pos: [spanX * 0.02, 48, spanZ * 1.02], look: [0, 1.2, 0] },
    { t: T1,   pos: [spanX * 0.05, 46, spanZ * 0.96], look: [0, 1.0, 0] },
    { t: T2,   pos: [-spanX * 0.03, 52, spanZ * 1.08], look: [0, 0.7, 0] },
    { t: DUR,  pos: [spanX * 0.00, 55, spanZ * 1.10], look: [0, 0.5, 0] },
  ] : [
    { t: 0,    pos: [-spanX * 0.42, 0.55, spanZ * 0.30], look: [CX, 0.05, CZ] },
    { t: T1,   pos: [-spanX * 0.30, 0.85, spanZ * 0.42], look: [CX, 0.05, CZ] },
    { t: T2,   pos: [spanX * 0.16, 1.55, spanZ * 0.85], look: [CX, 0.0, CZ * 0.6] },
    { t: DUR,  pos: [spanX * 0.22, 1.75, spanZ * 0.95], look: [CX, 0.0, CZ * 0.5] },
  ];
  const FLOAT_LIFT = p.cam === 'plain' ? (p.floatLift ?? 1) : 0;   // 随水浮起强度
  const camAt = (t) => {
    let i = 0;
    while (i < camKey.length - 1 && t > camKey[i + 1].t) i++;
    const a = camKey[i], b = camKey[Math.min(i + 1, camKey.length - 1)];
    const k = b.t > a.t ? ease(clamp01((t - a.t) / (b.t - a.t))) : 0;
    const pos = a.pos.map((v, j) => v + (b.pos[j] - v) * k);
    const look = a.look.map((v, j) => v + (b.look[j] - v) * k);
    // 随水浮起：smoothstep 全程平滑开启（liftF 方形窗在 T1/T2 附近有速度跳变=帧间抖源，判死）
    const lvl = lvlAt(t);
    const lift = FLOAT_LIFT * (lvl / MAXM) * 0.22;
    const liftF = smooth((t - T1) / ((T2 - T1) * 0.7)) * (1 - smooth((t - (T2 - (T2 - T1) * 0.12)) / ((T2 - T1) * 0.12)));
    camera.position.set(pos[0], pos[1] + lift * liftF, pos[2]);
    camera.lookAt(look[0], look[1], look[2]);
  };

  const setState = (t) => {
    camAt(t);
    const lvl = lvlAt(t);
    wlUniform.value = lvl;
    bandUniform.value = bandAt(t);
    water.position.y = HY(lvl) + (p.waterLift ?? 0.012);
    // plain 终局拉高：fov 34→40 与提升段(4.5s)同步、smooth 曲线（fov 阶变=透视跳=幌源之一）
    if (p.cam === 'plain') {
      const fk = smooth(clamp01((t - T2) / 8.0));
      camera.fov = 34 + 6 * fk;
      camera.updateProjectionMatrix();
    }
    // 城市淹没态：水位超海拔 → 红（sunk 过渡 0.6s：布尔一帧切 color/scale=钉跳变闪源）
    // 钉尺寸=屏幕空间近恒定（dist 补偿）：远距拉升时 0.09 半径 <1px=亚像素闪烁根治
    for (const c of cityObjs) {
      const sunkK = smooth((lvl - c.elev) / 3.0);        // 0=干 1=全沉，±3m 过渡带
      const sunk = sunkK > 0.5;
      c._last = c._last || {};
      const gr = 0xffd97a, rd = 0xff3b2f;
      const lerpHex = (a, b, k) => {
        const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
        const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
        return (Math.round(ar + (br - ar) * k) << 16) | (Math.round(ag + (bg - ag) * k) << 8) | Math.round(ab + (bb - ab) * k);
      };
      /* DOM 圆点颜色已并入增量更新分支 */
      // v21 终判（判词⑧收口）：钉随水浮升=钉每帧移动扫过高对比金色像素带=闪烁带。
      // 钉钉死在地面（baseY 恒定，depthTest=false 保证水下仍可见），淹没语义由 sunkK 颜色渐变表达
      // v28+：DOM 写入全增量更新（同值跳过）——同值 style 重写触发 compositor
      // 重栅格化=定格段文字边缘仍闪的残余源；toFixed(1) 量化亚像素到 0.1px 防浮点噪声
      const proj = c.anchor.clone().project(camera);
      const on = proj.z < 1 && Math.abs(proj.x) < 1.15 && Math.abs(proj.y) < 1.15;
      if (on) {
        const vw = renderer.domElement.clientWidth || 1280, vh = renderer.domElement.clientHeight || 720;
        const tx = ((proj.x * 0.5 + 0.5) * vw).toFixed(1);
        const ty = ((-proj.y * 0.5 + 0.5) * vh).toFixed(1);
        const col = sunk ? '#ff8a80' : '#ffffff';
        const dcol = sunk ? '#ff3b2f' : '#ffd97a';
        const dsc = (1 + 0.55 * sunkK).toFixed(2);
        if (c._last.tx !== tx || c._last.ty !== ty || c._last.col !== col) {
          c.lb.style.transform = 'translate(-50%,-100%) translate(' + tx + 'px,' + ty + 'px)';
          c.lb.style.color = col;
          Object.assign(c._last, { tx, ty, col });
        }
        if (c._last.dtx !== tx || c._last.dty !== ty || c._last.dcol !== dcol || c._last.dsc !== dsc) {
          c.dot.style.transform = 'translate(-50%,-50%) translate(' + tx + 'px,' + ty + 'px) scale(' + dsc + ')';
          c.dot.style.background = dcol;
          Object.assign(c._last, { dtx: tx, dty: ty, dcol, dsc });
        }
      } else if (c._last.on !== false) {
        c.lb.style.transform = 'translate(-9999px,-9999px)';
        c.dot.style.transform = 'translate(-9999px,-9999px)';
      }
      c._last.on = on;
    }
    hudLvl.textContent = Math.round(lvl) + 'm';
    hudLvl.style.opacity = t > T1 * 0.9 ? 1 : 0;
    hudCap.textContent = lvl < 0.5 ? '' : '模拟海平面';
    hudTitle.textContent = t < T1 ? '中国哪里最低，水就淹到哪里' : (t < T2 ? '水来了' : MAXM + ' 米之后');
    hudSub.textContent = t < T1 ? '先看海拔分色 · 再看大水怎么进' : (t < T2 ? '海平面每涨一米，就吞掉一片洼地' : '华北平原成了浅海 · 山东成了群岛');
    hudLegend.style.opacity = (p.bandStart ?? 0.88) < 0.5 ? 0
      : (t < T1 * 0.85 ? 1 : (t < T1 * 1.4 ? (T1 * 1.4 - t) / (T1 * 0.55) : 0));   // band 关=纯卫星真实感，图例无意义
  };
  return setState;
}

// —— tower_showcase：上海之巅手办展（程序化生成，无外部模型）——
// 形态四参数：圆角三角截面 / 底→顶扭转 120° / 收分 taper / 9 分区设备层腰带（几何微外扩+纹理亮带对齐）。
// 质感：程序化 equirect 环境图(PMREM) 供幕墙反射 + 种子随机 emissive 灯窗 + 青/品红轮廓光 + 展台双灯环。
// 注意：本函数运行于 PAGE 模板串内，禁用反引号模板串与美元符插值。
// params: { seed=7 }
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roundedTriShape(R, cr) {
  const v = [0, 1, 2].map((k) => {
    const a = Math.PI / 2 + (k * 2 * Math.PI) / 3;
    return new THREE.Vector2(Math.cos(a) * R, Math.sin(a) * R);
  });
  const sh = new THREE.Shape();
  for (let k = 0; k < 3; k++) {
    const a = v[k], b = v[(k + 1) % 3];
    const p0 = a.clone().lerp(b, cr), p1 = a.clone().lerp(b, 1 - cr);
    if (k === 0) sh.moveTo(p0.x, p0.y); else sh.lineTo(p0.x, p0.y);
    sh.lineTo(p1.x, p1.y);
    const q = b.clone().lerp(v[(k + 2) % 3], cr);
    sh.quadraticCurveTo(b.x, b.y, q.x, q.y);
  }
  sh.closePath();
  return sh;
}

function towerLoft({ H, R, twist, rings, seg, zones }) {
  const outline = roundedTriShape(1, 0.30).getSpacedPoints(seg);
  outline.pop();                       // 去闭合重复点；接缝顶点单独复制（u=0 与 u=3 各一份，防纹理横向拉花）
  const VREP = zones;                  // 每区一个纹理循环 → 每区一道腰带
  const taper = (t) => 1 - 0.38 * Math.pow(t, 1.35);
  const belt = (t) => {
    const f = t * zones - Math.floor(t * zones);
    return f > 0.965 ? 1.018 : 1.0;    // 区顶设备层微外扩
  };
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const s = taper(t) * belt(t);
    const a = twist * t, ca = Math.cos(a), sa = Math.sin(a);
    for (let j = 0; j <= seg; j++) {
      const p = outline[j % seg];
      const x = p.x * R * s, z = p.y * R * s;
      pos.push(x * ca - z * sa, H * t, x * sa + z * ca);
      uv.push((j / seg) * 3, t * VREP);
    }
  }
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < seg; j++) {
      const a = i * (seg + 1) + j, b = a + 1, c = a + seg + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  const topStart = rings * (seg + 1);  // 顶盖扇（法线 +y）
  const ci = pos.length / 3;
  pos.push(0, H, 0); uv.push(1.5, VREP);
  for (let j = 0; j < seg; j++) idx.push(topStart + j, ci, topStart + j + 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function litWindowsTex(rnd, { cols, rows, lit, beltRow }) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, 512, 512);
  const cw = 512 / cols, ch = 512 / rows;
  for (let i = 0; i < cols; i++)
    for (let j = 0; j < rows; j++) {
      const y = (rows - 1 - j) * ch;   // flipY：canvas 底部 = v0 = 塔底
      if (beltRow && j === rows - 1) {
        g.fillStyle = 'rgba(150,225,255,0.5)';   // v3 判例：腰带 0.95 太亮抢眼
        g.fillRect(i * cw, y, cw, ch);
        continue;
      }
      if (rnd() < lit) {
        const warm = rnd() < 0.72, a = 0.45 + rnd() * 0.55;
        g.fillStyle = warm ? 'rgba(255,212,148,' + a + ')' : 'rgba(168,222,255,' + a + ')';
        g.fillRect(i * cw + cw * 0.15, y + ch * 0.2, cw * 0.7, ch * 0.58);
      }
    }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  // loft UV 超 [0,1]（u0..3/v0..9）：默认 ClampToEdge 会把超界部分全贴到边缘行
  // （v2 白板病灶=全塔采样腰带行）——必须 RepeatWrapping
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function studioEnvTex() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 512;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#4a5a78'); grad.addColorStop(0.45, '#141a26'); grad.addColorStop(1, '#05070a');
  g.fillStyle = grad; g.fillRect(0, 0, 1024, 512);
  const blob = (x, y, r, color) => {
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, color); rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg; g.fillRect(x - r, y - r, r * 2, r * 2);
  };
  blob(200, 180, 190, 'rgba(90,200,255,0.40)');    // 青光位
  blob(800, 200, 170, 'rgba(255,120,190,0.32)');   // 品红光位
  blob(512, 90, 260, 'rgba(255,255,255,0.16)');    // 顶光（过强=白板判例 v1）
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

async function buildTowerShowcase(p) {
  const rnd = mulberry32(p.seed ?? 7);
  const PLINTH_R = 3.1, PLINTH_H = 0.22, TOP = PLINTH_H;
  camera.fov = 35; camera.updateProjectionMatrix();
  renderer.toneMappingExposure = 1.12;
  scene.background = new THREE.Color(0x05070c);
  scene.fog = new THREE.Fog(0x05070c, 10, 26);
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromEquirectangular(studioEnvTex()).texture;

  // 展厅地面（径向渐隐入背景）
  const gndC = document.createElement('canvas'); gndC.width = gndC.height = 512;
  const gg = gndC.getContext('2d');
  const rg = gg.createRadialGradient(256, 256, 40, 256, 256, 256);
  rg.addColorStop(0, '#1a2029'); rg.addColorStop(0.55, '#0c0f16'); rg.addColorStop(1, '#05070c');
  gg.fillStyle = rg; gg.fillRect(0, 0, 512, 512);
  const gndT = new THREE.CanvasTexture(gndC); gndT.colorSpace = THREE.SRGBColorSpace;
  const ground = new THREE.Mesh(new THREE.CircleGeometry(18, 64),
    new THREE.MeshStandardMaterial({ map: gndT, roughness: 0.4, metalness: 0.55 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
  scene.add(ground);

  // 展示底座 + 双灯环
  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(PLINTH_R, PLINTH_R + 0.12, PLINTH_H, 96),
    new THREE.MeshStandardMaterial({ color: 0x151a23, roughness: 0.3, metalness: 0.75 }));
  plinth.position.y = PLINTH_H / 2; plinth.receiveShadow = true;
  scene.add(plinth);
  const glowRing = (r, y, color) => {
    const m = new THREE.Mesh(new THREE.TorusGeometry(r, 0.014, 8, 128),
      new THREE.MeshBasicMaterial({ color }));
    m.rotation.x = Math.PI / 2; m.position.y = y; scene.add(m);
  };
  glowRing(PLINTH_R - 0.06, TOP + 0.005, 0x2fc8ff);
  glowRing(PLINTH_R + 0.03, TOP + 0.005, 0xff4fa0);   // v1 判例：品红环贴侧面 y0.06 看不见，挪顶面外缘

  const towerGroup = new THREE.Group();
  towerGroup.position.y = TOP;
  scene.add(towerGroup);

  // —— 上海中心（1 单位=100m：H=6.32，底半宽 0.42）——
  // 材质判例 v1：metalness 0.9+强 env=镜面白板吃光灯窗；玻璃夜景=低 metalness+弱 env+强 emissive
  const H = 6.32;
  const winTex = litWindowsTex(rnd, { cols: 24, rows: 12, lit: 0.55, beltRow: true });   // v3 判例：33 列窗太碎成噪点
  const body = new THREE.Mesh(
    towerLoft({ H, R: 0.42, twist: (2 * Math.PI) / 3, rings: 180, seg: 108, zones: 9 }),
    new THREE.MeshPhysicalMaterial({ color: 0x182430, metalness: 0.55, roughness: 0.38,
      clearcoat: 0.25, clearcoatRoughness: 0.35,
      emissive: 0xffffff, emissiveMap: winTex, emissiveIntensity: 1.9, envMapIntensity: 0.55 }));
  body.castShadow = true; body.receiveShadow = true;
  towerGroup.add(body);
  // 白板病灶探针（v2 塔身灯窗不可见）：basicTex=纹理直贴验 UV / noEmissive=分辨自发光白 / noLights=分辨灯光反射白
  if (p.probe === 'basicTex') body.material = new THREE.MeshBasicMaterial({ map: winTex });
  if (p.probe === 'noEmissive') body.material.emissiveIntensity = 0;

  // 冠顶收口 + 塔尖呼吸灯
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.16, 0.22, 24),
    new THREE.MeshStandardMaterial({ color: 0x2a3a4a, metalness: 0.9, roughness: 0.3 }));
  crown.position.y = H + 0.1; towerGroup.add(crown);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.045, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xff5566 }));
  tip.position.y = H + 0.24; towerGroup.add(tip);

  // 塔座裙楼
  const podiumGeo = new THREE.ExtrudeGeometry(roundedTriShape(0.62, 0.3),
    { depth: 0.26, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 2, curveSegments: 48 });
  podiumGeo.rotateX(-Math.PI / 2);
  const podium = new THREE.Mesh(podiumGeo,
    new THREE.MeshStandardMaterial({ color: 0x1c2836, metalness: 0.7, roughness: 0.38, envMapIntensity: 1.1 }));
  podium.castShadow = true; podium.receiveShadow = true;
  towerGroup.add(podium);

  // —— 陆家嘴手办沙盘：金茂（分层收分）/ 环球金融（方台体）/ 东方明珠 + 概括配楼 ——
  // v1 判例：金茂/环球用 8x12 窗纹理=窗户比例失真，地标配楼单独用密窗材质
  const blockTex = litWindowsTex(rnd, { cols: 8, rows: 12, lit: 0.42, beltRow: false });
  const blockMat = new THREE.MeshStandardMaterial({ color: 0x232a35, roughness: 0.6, metalness: 0.4,
    emissive: 0xffffff, emissiveMap: blockTex, emissiveIntensity: 0.9, envMapIntensity: 0.9 });
  // v3 判例：地标配楼侧/柱面 UV v0..1 沿全高，rows 必须按高度比例给（22 行=22m/层巨块判死）
  const denseTex = litWindowsTex(rnd, { cols: 16, rows: 60, lit: 0.45, beltRow: false });
  const denseMat = new THREE.MeshStandardMaterial({ color: 0x20262f, roughness: 0.55, metalness: 0.45,
    emissive: 0xffffff, emissiveMap: denseTex, emissiveIntensity: 1.0, envMapIntensity: 0.9 });
  const put = (mesh, x, z, ry) => {
    mesh.position.set(x, TOP, z);
    if (ry) mesh.rotation.y = ry;
    mesh.castShadow = true; mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  };
  const jinmao = new THREE.Group();
  let jmY = 0;
  [[0.5, 1.7], [0.42, 1.05], [0.34, 0.7], [0.26, 0.45], [0.18, 0.3]].forEach(([w, h]) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), denseMat);
    m.position.y = jmY + h / 2; m.castShadow = true; jinmao.add(m);
    jmY += h;
  });
  put(jinmao, 1.05, -0.62, 0.3);
  const swfc = put(new THREE.Mesh(new THREE.CylinderGeometry(0.30, 0.44, 4.92, 4), denseMat), 1.42, 0.72, Math.PI / 4);
  swfc.position.y = TOP + 4.92 / 2;

  // v1 判例：明珠放相机起幅与塔之间=前景抢戏；挪到底座边缘东北侧（起幅 SW 的对角）
  const op = new THREE.Group();
  const opMat = new THREE.MeshStandardMaterial({ color: 0xb8a8b0, roughness: 0.4, metalness: 0.55, envMapIntensity: 0.9 });
  const opAdd = (geo, y) => {
    const m = new THREE.Mesh(geo, opMat); m.position.y = y; m.castShadow = true; op.add(m);
  };
  opAdd(new THREE.CylinderGeometry(0.07, 0.13, 1.6, 12), 0.8);
  opAdd(new THREE.SphereGeometry(0.30, 24, 18), 1.9);
  opAdd(new THREE.CylinderGeometry(0.05, 0.05, 1.2, 10), 2.75);
  opAdd(new THREE.SphereGeometry(0.20, 20, 14), 3.5);
  opAdd(new THREE.CylinderGeometry(0.02, 0.04, 1.0, 8), 4.2);
  const opTip = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0xff5566 }));
  opTip.position.y = 4.72; op.add(opTip);
  put(op, 2.0, 2.0, 0);

  for (let k = 0; k < 26; k++) {                       // 概括配楼（v1 判例：太高太密抢英雄）
    const ang = rnd() * Math.PI * 2, r = 0.95 + rnd() * 1.75;
    const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
    if (Math.hypot(x - 1.05, z + 0.62) < 0.6 || Math.hypot(x - 1.42, z - 0.72) < 0.65 ||
        Math.hypot(x - 2.0, z - 2.0) < 0.85 || r < 0.9) continue;
    if (r > 1.5 && r < 2.25 && ang > 0.02 && ang < 1.55) continue;   // 黄浦江带
    const w = 0.14 + rnd() * 0.22;
    const h = rnd() < 0.1 ? 1.5 + rnd() * 0.8 : 0.2 + rnd() * 1.1;
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, w * (0.7 + rnd() * 0.6)), blockMat);
    b.position.set(x, TOP + h / 2, z);
    b.rotation.y = rnd() * Math.PI;
    b.castShadow = true; b.receiveShadow = true;
    scene.add(b);
  }

  // 黄浦江：环形弧段镜面（NE 岸分隔明珠与塔群，配楼生成已避开此带）
  const river = new THREE.Mesh(new THREE.RingGeometry(1.62, 2.1, 72, 1, -1.47, 1.37),
    new THREE.MeshPhysicalMaterial({ color: 0x0b2033, metalness: 0.9, roughness: 0.07,
      envMapIntensity: 1.6, emissive: 0x0a2a44, emissiveIntensity: 0.6 }));
  river.rotation.x = -Math.PI / 2; river.position.y = TOP + 0.004;
  river.receiveShadow = true;
  scene.add(river);

  // 扫射光束（additive 空心锥，灯塔式绕塔对旋）
  const mkBeam = (color, opa) => {
    const g = new THREE.ConeGeometry(0.8, 7, 24, 1, true);
    g.translate(0, -3.5, 0);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: opa,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false, fog: false }));
    m.rotation.z = 0.62;
    const grp = new THREE.Group();
    grp.add(m); grp.position.y = TOP + 6.9;
    scene.add(grp);
    return grp;
  };
  const beam1 = mkBeam(0x55ccff, 0.035);
  const beam2 = mkBeam(0xff66aa, 0.028);

  // 灯光：主光 + 青/品红轮廓光
  const key = new THREE.DirectionalLight(0xfff4e6, 1.6);
  key.position.set(6, 9, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = key.shadow.camera.bottom = -6;
  key.shadow.camera.right = key.shadow.camera.top = 6;
  key.shadow.camera.near = 1; key.shadow.camera.far = 25;
  key.shadow.bias = -0.0004;
  key.shadow.camera.updateProjectionMatrix();
  scene.add(key);
  const cyan = new THREE.PointLight(0x35c8ff, 35, 0, 2); cyan.position.set(-5.5, 3, -4.5); scene.add(cyan);
  const pink = new THREE.PointLight(0xff4fa0, 28, 0, 2); pink.position.set(5, 2, -5); scene.add(pink);
  if (p.probe === 'noLights') { key.intensity = 0; cyan.intensity = 0; pink.intensity = 0; scene.environment = null; }

  // —— 后期链（自写最小 composer，零 vendor）：bloom 辉光 + 径向移轴虚化 + 暗角 ——
  // 主 RT 带 MSAA×4 + sRGB（材质 ACES/sRGB 在写入时完成，合成只搬运显示值，无双重转换）
  const dbs = renderer.getDrawingBufferSize(new THREE.Vector2());
  const FW = dbs.x, FH = dbs.y;
  // 色彩链路判例（v5 整体变暗）：RT 标 sRGB=硬件写入编码+采样解码，合成缺输出 gamma；
  // 正解=RT 全线性域（NoColorSpace 默认），composite 末尾手动 pow(1/2.2) 编码
  const rtScene = new THREE.WebGLRenderTarget(FW, FH, { samples: 4, type: THREE.HalfFloatType });
  const BW = Math.floor(FW / 4), BH = Math.floor(FH / 4);
  const mkRT = () => new THREE.WebGLRenderTarget(BW, BH, { type: THREE.HalfFloatType });
  const rtB1 = mkRT(), rtB2 = mkRT();
  const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const fsScene = new THREE.Scene();
  const fsMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
  fsScene.add(fsMesh);
  const VERT = 'varying vec2 vUv;\\nvoid main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
  const brightMat = new THREE.ShaderMaterial({
    uniforms: { uTex: { value: rtScene.texture } },
    vertexShader: VERT,
    fragmentShader: 'uniform sampler2D uTex; varying vec2 vUv;\\n' +
      'void main(){ vec3 c = texture2D(uTex, vUv).rgb;\\n' +
      'float l = max(c.r, max(c.g, c.b));\\n' +
      'float k = max(0.0, l - 0.42) / max(l, 0.0001);\\n' +
      'gl_FragColor = vec4(c * k, 1.0); }',
    depthTest: false, depthWrite: false });
  const blurMat = new THREE.ShaderMaterial({
    uniforms: { uTex: { value: null }, uDir: { value: new THREE.Vector2(1, 0) } },
    vertexShader: VERT,
    fragmentShader: 'uniform sampler2D uTex; uniform vec2 uDir; varying vec2 vUv;\\n' +
      'void main(){ vec3 s = texture2D(uTex, vUv).rgb * 0.227027;\\n' +
      's += texture2D(uTex, vUv + uDir * 1.3846).rgb * 0.3162162;\\n' +
      's += texture2D(uTex, vUv - uDir * 1.3846).rgb * 0.3162162;\\n' +
      's += texture2D(uTex, vUv + uDir * 3.2308).rgb * 0.0702703;\\n' +
      's += texture2D(uTex, vUv - uDir * 3.2308).rgb * 0.0702703;\\n' +
      'gl_FragColor = vec4(s, 1.0); }',
    depthTest: false, depthWrite: false });
  // 移轴：Vogel 盘 12 抽头径向虚化（手办摄影的模型感来源），bloom 加法合成，暗角收尾
  const compMat = new THREE.ShaderMaterial({
    uniforms: { uScene: { value: rtScene.texture }, uBloom: { value: rtB1.texture },
      uRes: { value: new THREE.Vector2(FW, FH) }, uBloomK: { value: 1.0 } },
    vertexShader: VERT,
    fragmentShader: 'uniform sampler2D uScene; uniform sampler2D uBloom;\\n' +
      'uniform vec2 uRes; uniform float uBloomK; varying vec2 vUv;\\n' +
      'void main(){\\n' +
      'vec2 asp = vec2(uRes.x / uRes.y, 1.0);\\n' +
      'float r = length((vUv - vec2(0.5, 0.46)) * asp);\\n' +
      'float blur = smoothstep(0.26, 0.70, r);\\n' +
      'vec3 sharp = texture2D(uScene, vUv).rgb;\\n' +
      'float rad = blur * 9.0 / uRes.y;\\n' +
      'vec2 xa = vec2(uRes.y / uRes.x, 1.0);\\n' +
      'vec3 acc = vec3(0.0);\\n' +
      'for (int i = 0; i < 12; i++) {\\n' +
      '  float fi = float(i);\\n' +
      '  float a = fi * 2.39996;\\n' +
      '  float rr = sqrt((fi + 0.5) / 12.0);\\n' +
      '  acc += texture2D(uScene, vUv + rr * rad * vec2(cos(a), sin(a)) * xa).rgb;\\n' +
      '}\\n' +
      'acc /= 12.0;\\n' +
      'vec3 c = mix(sharp, acc, blur * 0.85);\\n' +
      'c += texture2D(uBloom, vUv).rgb * uBloomK;\\n' +
      'c *= 1.0 - 0.26 * smoothstep(0.45, 1.0, r);\\n' +
      'c = pow(max(c, vec3(0.0)), vec3(0.4545));\\n' +   // 线性域 RT 手动输出编码（v6 缺 gamma 判例）
      'gl_FragColor = vec4(c, 1.0); }',
    depthTest: false, depthWrite: false });
  const fsPass = (mat, target) => {
    fsMesh.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(fsScene, fsCam);
  };
  window.__postRender = () => {
    renderer.setRenderTarget(rtScene);
    renderer.render(scene, camera);
    fsPass(brightMat, rtB1);
    blurMat.uniforms.uTex.value = rtB1.texture; blurMat.uniforms.uDir.value.set(1.6 / BW, 0);
    fsPass(blurMat, rtB2);
    blurMat.uniforms.uTex.value = rtB2.texture; blurMat.uniforms.uDir.value.set(0, 1.6 / BH);
    fsPass(blurMat, rtB1);
    blurMat.uniforms.uTex.value = rtB1.texture; blurMat.uniforms.uDir.value.set(1.6 / BW, 0);
    fsPass(blurMat, rtB2);
    blurMat.uniforms.uTex.value = rtB2.texture; blurMat.uniforms.uDir.value.set(0, 1.6 / BH);
    fsPass(blurMat, rtB1);
    compMat.uniforms.uBloom.value = rtB1.texture;
    fsPass(compMat, null);
  };

  // v1 判例：收尾机位没复算=塔顶出画。fov35 全塔+底座入画数值解 dist≈14.5, cy≈9.6, lookY≈2.4
  return (t) => {
    const T = CFG.duration;
    const u = clamp01(t / T);
    const az = -2.35 + 4.5 * smooth(u / 0.92);                  // 低位起幅 → 环绕 ~258°
    const rise = smooth((u - 0.06) / 0.8);
    const dist = 8.6 - 1.2 * smooth(u / 0.3) + 7.1 * smooth((u - 0.5) / 0.5);
    const cy = 0.5 + 9.1 * Math.pow(rise, 1.7);                 // 0.5 → 9.6 拉升俯瞰
    const lookY = 2.75 - 0.35 * smooth((u - 0.58) / 0.42);
    camera.position.set(Math.cos(az) * dist, cy, Math.sin(az) * dist);
    camera.lookAt(0.15, lookY, 0.05);
    towerGroup.rotation.y = 0.5 * u;                            // 展台缓转
    beam1.rotation.y = t * 0.45;                                // 扫射光束对旋
    beam2.rotation.y = Math.PI - t * 0.45;
    tip.material.color.setHSL(0.98, 0.9, 0.55 + 0.25 * Math.sin(t * 4));
  };
}

const BUILDERS = { tower_showcase: buildTowerShowcase, lights_out: buildLightsOut, wandering_earth: buildWandering,
                   pacific_dive: buildPacificDive,
                   tidal_lock: buildTidalLock, solar_system_map: buildSolarSystemMap,
                   jilong_flyover: buildJilongFlyover, cme_storm: buildCmeStorm,
                   voyager_helio: buildEpicJourney, epic_journey: buildEpicJourney,
                   eclipse_geometry: buildEclipseGeometry, red_ring_earth: buildRedRingEarth,
                   terminator_earth: buildTerminatorEarth, huashan_sun: buildHuashanSun,
                   weihe_valley: buildWeiheValley, weihe_erosion: buildWeiheErosion,
                   arctic_wall: buildArcticWall, terrain_block: buildTerrainBlock, flood_block: buildFloodBlock };

(async () => {
  const setState = await BUILDERS[CFG.program](CFG.params);
  // builder 可挂 window.__postRender 自管渲染（后期链程序），缺省直渲
  window.__render = (t) => { setState(t); if (window.__postRender) window.__postRender(); else renderer.render(scene, camera); };
  window.__DONE__ = true;
})();
<\/script></body></html>`;

// 页面落盘调试：DUMP_PAGE=1 时把最终 HTML 写 /tmp/page_dump.html（就绪超时无报错时排查 script 截断/语法错误）
if (process.env.DUMP_PAGE) writeFileSync('/tmp/page_dump.html', PAGE);

// 内置静态服务器：repo 根为 server 根（纹理同源加载，规避 file:// CORS）
const server = createServer((req, res) => {
  if (req.url === '/__scene.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE);
    return;
  }
  const path = join(REPO, decodeURIComponent(req.url.split('?')[0]));
  try {
    const data = readFileSync(path);
    const ext = path.slice(path.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
const PORT0 = Number(process.env.RENDER_PORT ?? 8791);
let PORT = PORT0;
for (; PORT < PORT0 + 50; PORT++) {
  try { await new Promise((ok, bad) => { server.once('error', bad); server.listen(PORT, '127.0.0.1', ok); }); break; }
  catch { /* 被占扫下一个 */ }
}
if (PORT >= PORT0 + 50) { console.error('端口扫描耗尽'); process.exit(1); }

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: LAYOUT ? LAYOUT[0] : W, height: LAYOUT ? LAYOUT[1] : H }, deviceScaleFactor: LAYOUT ? SC : 1 });
// 页面报错直通 stderr（shader 编译失败/JS 异常=画面静默变白变黑的根因，必须可见）
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.error('[page]', m.text().slice(0, 2000)); });
page.on('pageerror', (e) => console.error('[pageerror]', String(e).slice(0, 2000)));
await page.goto(`http://127.0.0.1:${PORT}/__scene.html`);
await page.waitForFunction('window.__DONE__ === true', { timeout: 120000 });
await page.evaluate(() => document.fonts.ready);

// 运动模糊（opt-in spec.motionBlur {samples, shutter}）：每帧按快门窗均匀采 N 子帧，
// 帧目录落 N×FRAMES 张，ffmpeg tmix 算术平均后降回 FPS——高速细线/光点的胶片快门感。
const MB = spec.motionBlur ?? null;
const SAMPLES = MB ? (MB.samples ?? 3) : 1;
const SHUTTER = MB ? (MB.shutter ?? 0.5) : 0;
console.error(`rendering ${FRAMES} frames (${DURATION}s @${FPS}fps${MB ? `, motionBlur x${SAMPLES}` : ''}) → ${framesDir}`);
const t0 = Date.now();
let fn = 0;
for (let i = 0; i < FRAMES; i++) {
  for (let j = 0; j < SAMPLES; j++) {
    const sub = SAMPLES > 1 ? (j / (SAMPLES - 1) - 0.5) * SHUTTER / FPS : 0;
    await page.evaluate((t) => window.__render(t), i / FPS + sub);
    // 截图 30s 超时重试（2026-09-20 EP8 侧视 proof 连续两次 page.screenshot TimeoutError 挂死整渲判例：
    // GPU 抖动类非确定性帧——同帧重试 4 次、间隔 2s，成功路径零行为变化；render.mjs 崩溃自愈同款思路）
    const shotPath = join(framesDir, `f${String(fn++).padStart(5, '0')}.png`);
    for (let retry = 0; retry < 4; retry++) {
      try {
        await page.screenshot({ path: shotPath });
        break;
      } catch (e) {
        console.error(`  [shot retry ${retry + 1}/4] frame ${i} ${e.name}`);
        if (retry === 3) throw e;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
  if (i % 120 === 0) {
    const per = (Date.now() - t0) / (i + 1);
    console.error(`  ${i}/${FRAMES}  ${per.toFixed(0)}ms/帧  预计剩 ${((FRAMES - i) * per / 1000).toFixed(0)}s`);
  }
}
await browser.close();
server.close();

const ffArgs = MB
  ? ['-y', '-framerate', String(FPS * SAMPLES), '-i', join(framesDir, 'f%05d.png'),
     '-vf', `tmix=frames=${SAMPLES},fps=${FPS}`,
     '-c:v', 'libx264', '-crf', String(spec.crf ?? 18), '-preset', 'medium',
     '-pix_fmt', 'yuv420p', '-r', String(FPS), OUT]
  : ['-y', '-framerate', String(FPS), '-i', join(framesDir, 'f%05d.png'),
     '-c:v', 'libx264', '-crf', String(spec.crf ?? 18), '-preset', 'medium',
     '-pix_fmt', 'yuv420p', '-r', String(FPS), OUT];
execFileSync('ffmpeg', ffArgs, { stdio: 'inherit' });

// —— 渲染验收三件套（2026-09-10 v4 TDZ 四轮假渲染判例：成功判定=产物核验，不靠 stdout）——
// 任何一项不过即非零退出：产物存在且为本次新出 / 时长对账 / 首帧非黑。
{
  const fail = (msg) => { console.error(`RENDER-ACCEPT FAIL: ${msg}`); process.exit(1); };
  if (!existsSync(OUT)) fail(`产物不存在 ${OUT}`);
  if (statSync(OUT).mtimeMs < t0) fail(`产物 mtime 早于本次渲染启动（旧文件）${OUT}`);
  if (statSync(OUT).size < 1024) fail(`产物过小 ${OUT}`);
  const durOut = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', OUT], { encoding: 'utf-8' }).trim());
  if (Math.abs(durOut - DURATION) > 0.5) fail(`时长对账：期望 ${DURATION}s 实际 ${durOut}s`);
  const probePng = join(framesDir, '__accept_first.png');
  execFileSync('ffmpeg', '-v error -y -i'.split(' ').concat([OUT, '-frames:v', '1', probePng]));
  const px = execFileSync('ffmpeg', ['-v', 'error', '-i', probePng, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
  let sum = 0; for (let k = 0; k < px.length; k += 97) sum += px[k];
  const mean = sum / Math.ceil(px.length / 97);
  if (mean < 5) fail(`首帧均亮 ${mean.toFixed(1)} < 5（黑帧）`);
  if (!spec.keepFrames) rmSync(probePng, { force: true });
  console.error(`RENDER-ACCEPT OK: ${OUT}  ${durOut}s  首帧均亮 ${mean.toFixed(0)}`);
}
if (!spec.keepFrames) rmSync(framesDir, { recursive: true, force: true });
console.log(OUT);
