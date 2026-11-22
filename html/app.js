import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { createVRMAnimationClip, VRMAnimationLoaderPlugin, VRMLookAtQuaternionProxy } from '@pixiv/three-vrm-animation';
import { RoomEnvironment } from './room-environment.js';
import { XRPinchGestures } from './xr-gestures.js';
import { renderObjectTree } from './object-tree.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(window.location.search);
const debugXR = params.get('debugXR') === '1';
const AR_DRAG_THRESHOLD = 0.035; // Radians, equivalent to 1 cm of pinch movement.
const CDN = 'https://cdn.jsdelivr.net/npm/three@0.187.0/examples/jsm/';
const renderer = new THREE.WebGLRenderer({ canvas: $('viewport'), antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local');
const scene = new THREE.Scene();
let background = '#000000';
scene.background = new THREE.Color(background);
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.01, 1000);
const stereo = new THREE.StereoCamera();
stereo.aspect = 0.5;
const viewportSize = new THREE.Vector2();
let cameraMode = 'mono';
camera.position.set(1.7, 1.1, 2.5);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = false;
controls.minDistance = 0.05;
controls.maxDistance = 100;
const pmrem = new THREE.PMREMGenerator(renderer);
const room = new RoomEnvironment();
const environment = pmrem.fromScene(room, 0.01, 0.1, 100, { size: 1024 }).texture;
scene.environment = environment;
scene.environmentIntensity = 0.35;
room.dispose();
pmrem.dispose();
const hemisphere = new THREE.HemisphereLight(0xffffff, 0x737987, 0.5);
scene.add(hemisphere);
const light = new THREE.DirectionalLight(0xffffff, 2.5);
light.position.set(3, 5, 4);
scene.add(light);
for (const [name, target, property] of [
  ['environment', scene, 'environmentIntensity'],
  ['hemisphere', hemisphere, 'intensity'],
  ['directional', light, 'intensity'],
]) {
  const slider = $(`${name}-intensity`);
  const output = $(`${name}-value`);
  slider.value = target[property];
  output.value = target[property].toFixed(2);
  slider.addEventListener('input', () => {
    target[property] = Number(slider.value);
    output.value = target[property].toFixed(2);
  });
}
const placement = new THREE.Group();
scene.add(placement);
const content = new THREE.Group();
placement.add(content);
const gestures = new XRPinchGestures();
const handSelections = new WeakMap();
const gestureAxis = new THREE.Vector3();
const gestureRotation = new THREE.Quaternion();
const manager = new THREE.LoadingManager();
// Opened files must be self-contained. Never fetch a URI embedded in a file.
manager.setURLModifier(url => {
  if (/^(data:|blob:)/i.test(url)) return url;
  throw new Error('外部ファイルを参照しています。テクスチャやバッファを埋め込んでください。');
});
const draco = new DRACOLoader().setDecoderPath(`${CDN}libs/draco/gltf/`);
const ktx2 = new KTX2Loader().setTranscoderPath(`${CDN}libs/basis/`).detectSupport(renderer);
const loader = new GLTFLoader(manager).setDRACOLoader(draco).setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
loader.register(parser => new VRMLoaderPlugin(parser));
loader.register(parser => new VRMAnimationLoaderPlugin(parser));
let model, vrm, mixer, action, embeddedClips = [], clips = [], playing = true, loadId = 0, statusTimer;
const originalMaterials = new Map();
const diagnosticMaterials = new Map();
function localFaceNormalMaterial(options, object) {
  const meshToGLB = { value: new THREE.Matrix4() };
  const rootInverse = new THREE.Matrix4();
  const material = new THREE.ShaderMaterial({
    ...options,
    lights: false,
    toneMapped: false,
    uniforms: { meshToGLB },
    vertexShader: `
      #include <common>
      #include <batching_pars_vertex>
      #include <morphtarget_pars_vertex>
      #include <skinning_pars_vertex>
      #include <logdepthbuf_pars_vertex>
      uniform mat4 meshToGLB;
      varying vec3 vLocalPosition;
      void main() {
        #include <batching_vertex>
        #include <morphinstance_vertex>
        #include <begin_vertex>
        #include <morphtarget_vertex>
        #include <skinbase_vertex>
        #include <skinning_vertex>
        vec4 glbPosition = vec4(transformed, 1.0);
        #ifdef USE_BATCHING
          glbPosition = batchingMatrix * glbPosition;
        #endif
        #ifdef USE_INSTANCING
          glbPosition = instanceMatrix * glbPosition;
        #endif
        vLocalPosition = (meshToGLB * glbPosition).xyz;
        #include <project_vertex>
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: `
      #include <logdepthbuf_pars_fragment>
      varying vec3 vLocalPosition;
      void main() {
        #include <logdepthbuf_fragment>
        vec3 normal = normalize(cross(dFdx(vLocalPosition), dFdy(vLocalPosition)))
          * (gl_FrontFacing ? 1.0 : -1.0);
        gl_FragColor = vec4(normal * 0.5 + 0.5, 1.0);
      }
    `,
  });
  // Each mesh keeps its own transform; remove viewer placement and retain the
  // GLB hierarchy and animation. Deformation is applied in the vertex shader.
  material.onBeforeRender = () => {
    rootInverse.copy(model.matrixWorld).invert();
    meshToGLB.value.multiplyMatrices(rootInverse, object.matrixWorld);
  };
  return material;
}

function restoreMaterials() {
  for (const [object, material] of originalMaterials) object.material = material;
  originalMaterials.clear();
  for (const variants of diagnosticMaterials.values()) {
    for (const material of Object.values(variants)) material.dispose();
  }
  diagnosticMaterials.clear();
}
function applyRenderMode() {
  const mode = $('render-mode').value;
  const shaded = mode === 'shading';
  $('lighting').hidden = !shaded;
  if (!shaded) $('lighting').open = false;
  for (const input of $('lighting').querySelectorAll('input')) input.disabled = !shaded;
  if (!model) return;
  const wireColor = background === 'room' || new THREE.Color(background).getHSL({}).l > 0.5 ? 0x202020 : 0xeeeeee;
  model.traverse(object => {
    if (!object.isMesh) return;
    if (!originalMaterials.has(object)) originalMaterials.set(object, object.material);
    const original = originalMaterials.get(object);
    const convert = material => {
      if (shaded) return material;
      let variants = diagnosticMaterials.get(material);
      if (!variants) { variants = {}; diagnosticMaterials.set(material, variants); }
      const key = mode === 'normals' ? `normals:${object.uuid}` : mode;
      if (!variants[key]) {
        const options = { side: material.side, toneMapped: false };
        variants[key] = mode === 'wireframe'
          ? new THREE.MeshBasicMaterial({ ...options, wireframe: true })
          : localFaceNormalMaterial(options, object);
      }
      if (mode === 'wireframe') variants[key].color.setHex(wireColor);
      return variants[key];
    };
    object.material = Array.isArray(original) ? original.map(convert) : convert(original);
  });
}
$('render-mode').onchange = applyRenderMode;
let modelHalfHeight = 0.5;
let sessionMode = null, hitSource = null, pendingPlacement = false, savedView;

function updateBackground() {
  scene.background = sessionMode === 'ar' ? null
    : background === 'room' ? environment : new THREE.Color(background);
}
const reticle = new THREE.Mesh(new THREE.RingGeometry(0.065, 0.085, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xc8ffc9, side: THREE.DoubleSide }));
reticle.matrixAutoUpdate = false;
reticle.visible = false;
scene.add(reticle);

function status(message = '', error = false, timeout = 0) {
  clearTimeout(statusTimer);
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
  if (timeout) statusTimer = setTimeout(() => status(), timeout);
}
function dispose(root) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  root.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    if (object.skeleton) object.skeleton.dispose();
    if (object.material) for (const material of [].concat(object.material)) materials.add(material);
  });
  for (const material of materials) {
    for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    material.dispose();
  }
  for (const texture of textures) {
    texture.dispose();
    const images = [].concat(texture.source?.data ?? []);
    for (const img of images) img?.close?.();
  }
  for (const geometry of geometries) geometry.dispose();
}
function fit() {
  if (!model || renderer.xr.isPresenting) return;
  controls.reset();
  const box = new THREE.Box3().setFromObject(content);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 0.01);
  const vertical = THREE.MathUtils.degToRad(camera.fov / 2);
  const horizontal = Math.atan(Math.tan(vertical) * camera.aspect * (cameraMode === 'mono' ? 1 : 0.5));
  const distance = radius / Math.sin(Math.min(vertical, horizontal)) * 1.15;
  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).addScaledVector(new THREE.Vector3(1, 0.6, 1.5).normalize(), distance);
  camera.near = 0.001;
  camera.far = Math.max(1000, distance * 20);
  camera.updateProjectionMatrix();
  controls.update();
}
function updatePlayButton() {
  $('play').textContent = playing ? 'Ⅱ' : '▶';
  $('play').setAttribute('aria-label', playing ? '一時停止' : '再生');
}
function selectClip() {
  mixer.stopAllAction();
  action = mixer.clipAction(clips[Number($('clips').value)]);
  action.reset().play();
  mixer.update(0);
  $('timeline').max = Math.max(action.getClip().duration, 0.001);
  playing = true;
  updatePlayButton();
}
function setClips(root, nextClips) {
  mixer?.stopAllAction();
  mixer?.uncacheRoot(mixer.getRoot());
  clips = nextClips;
  mixer = clips.length ? new THREE.AnimationMixer(root) : null;
  action = null;
  $('clips').replaceChildren(...clips.map((clip, i) => new Option(clip.name || `Animation ${i + 1}`, i)));
  $('playback').hidden = !clips.length;
  $('animation-count').textContent = clips.length ? ` · ${clips.length} animations` : '';
  if (mixer) selectClip();
}
async function readVRMA(readData, target, id) {
  status('VRMAを読み込み中…');
  const data = await readData();
  if (id !== loadId) return;
  const gltf = await loader.parseAsync(data, '');
  let proxy;
  try {
    if (id !== loadId) return;
    const animations = gltf.userData.vrmAnimations;
    if (!animations?.length) throw new Error('VRMAに再生できるアニメーションがありません。');
    if (target.lookAt && !target.scene.children.some(object => object instanceof VRMLookAtQuaternionProxy)) {
      proxy = new VRMLookAtQuaternionProxy(target.lookAt);
      proxy.name = 'VRMLookAtQuaternionProxy';
      target.scene.add(proxy);
    }
    const animationClips = animations.map((animation, i) => {
      const clip = createVRMAnimationClip(animation, target);
      clip.name = gltf.animations[i]?.name || `VRMA ${i + 1}`;
      return clip;
    }).filter(clip => clip.tracks.length);
    if (!animationClips.length) throw new Error('このVRMに適用できるVRMAのトラックがありません。');
    return animationClips;
  } catch (error) {
    proxy?.removeFromParent();
    throw error;
  } finally {
    dispose(gltf.scene);
  }
}
async function replaceVRMA(file) {
  if (!vrm) return status('VRMを開いてからVRMAを指定してください。', true, 6000);
  const id = ++loadId;
  try {
    const animationClips = await readVRMA(() => file.arrayBuffer(), vrm, id);
    if (id !== loadId) return;
    setClips(model, [...animationClips, ...embeddedClips]);
    status();
  } catch (error) {
    console.error(error);
    if (id === loadId) status(`VRMAを読み込めませんでした。${error.message || 'ファイルを確認してください。'}`, true);
  }
}
async function openModel(name, readData, { expectVRM = false, readAnimation } = {}) {
  const id = ++loadId;
  let next;
  status('モデルを読み込み中…');
  try {
    const data = await readData();
    if (id !== loadId) return;
    const gltf = await loader.parseAsync(data, '');
    next = gltf.scene;
    if (id !== loadId) return;
    const nextVRM = gltf.userData.vrm;
    if (!nextVRM && readAnimation) throw new Error('VRMAと一緒にVRMモデルを指定してください。');
    if (!nextVRM && expectVRM) throw new Error('VRMモデルを確認してください。');
    if (nextVRM) {
      VRMUtils.rotateVRM0(nextVRM);
      next.traverse(object => {
        if (object.isSkinnedMesh) object.frustumCulled = false;
      });
    }
    next.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(next);
    if (bounds.isEmpty() || !Number.isFinite(bounds.min.length() + bounds.max.length())) {
      throw new Error('表示できる形状がありません。');
    }
    let animationClips = [];
    if (readAnimation) {
      animationClips = await readVRMA(readAnimation, nextVRM, id);
      if (id !== loadId) return;
    }
    embeddedClips = gltf.animations;
    setClips(next, [...animationClips, ...embeddedClips]);
    if (model) {
      content.remove(model);
      restoreMaterials();
      dispose(model);
    }
    model = next;
    next = null;
    vrm = nextVRM;
    content.add(model);
    applyRenderMode();
    const size = bounds.getSize(new THREE.Vector3());
    const scale = 1 / Math.max(size.x, size.y, size.z, 0.000001);
    modelHalfHeight = size.y * scale / 2;
    content.scale.setScalar(scale);
    content.position.copy(bounds.getCenter(new THREE.Vector3())).multiplyScalar(-scale);
    renderObjectTree($('object-tree'), model);
    $('objects').hidden = false;
    $('welcome').hidden = true;
    $('filename').textContent = name;
    $('filename').title = name;
    $('open').hidden = params.has('url') && !vrm;
    $('fit').disabled = false;
    let meshes = 0, triangles = 0;
    model.traverse(object => {
      if (object.isMesh) {
        meshes++;
        triangles += ((object.geometry.index?.count ?? object.geometry.attributes.position?.count ?? 0) / 3) * (object.isInstancedMesh ? object.count : 1);
      }
    });
    $('mesh-info').textContent = `${meshes.toLocaleString()} meshes · ${Math.round(triangles).toLocaleString()} triangles`;
    fit();
    updateXRButtons();
    status();
  } catch (error) {
    console.error(error);
    if (id === loadId) status(`読み込めませんでした。${error.message || 'ファイルを確認してください。'}`, true);
  } finally {
    if (next) dispose(next);
  }
}
function openFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  const models = files.filter(file => /\.(glb|vrm)$/i.test(file.name));
  const animations = files.filter(file => /\.vrma$/i.test(file.name));
  if (files.length === 1 && animations.length === 1) return replaceVRMA(animations[0]);
  if (models.length !== 1 || animations.length > 1 || files.length !== models.length + animations.length) {
    return status('GLBまたはVRMを1つ選んでください。VRMはVRMAを1つ同時に指定できます。', true, 6000);
  }
  const [file] = models;
  const [animation] = animations;
  const expectVRM = /\.vrm$/i.test(file.name);
  if (animation && !expectVRM) return status('VRMAと一緒にVRMモデルを選んでください。', true, 6000);
  return openModel(file.name, () => file.arrayBuffer(), {
    expectVRM,
    readAnimation: animation && (() => animation.arrayBuffer()),
  });
}
async function readURL(value, label) {
  const url = new URL(value, window.location.href);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('URLはHTTPまたはHTTPSで指定してください。');
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label}の取得に失敗しました (HTTP ${response.status})。`);
  return response.arrayBuffer();
}
function openURL(value, animationURL) {
  return openModel(value, () => readURL(value, 'モデル'), {
    readAnimation: animationURL && (() => readURL(animationURL, 'VRMA')),
  });
}
$('open').onclick = () => $('file').click();
$('file').onchange = () => { openFiles($('file').files); $('file').value = ''; };
$('demo').onclick = () => openURL('./clock2-6.glb');
$('fit').onclick = fit;
let dragDepth = 0;
window.addEventListener('dragenter', event => {
  event.preventDefault();
  if (event.dataTransfer?.types.includes('Files')) {
    dragDepth++;
    $('drop').textContent = vrm ? 'GLB／VRM／VRMAをドロップ' : 'GLB／VRM（＋VRMA）をドロップ';
    $('drop').hidden = false;
  }
});
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('dragleave', event => { event.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
window.addEventListener('drop', event => {
  event.preventDefault(); dragDepth = 0; $('drop').hidden = true;
  openFiles(event.dataTransfer.files);
});
window.addEventListener('blur', () => { dragDepth = 0; $('drop').hidden = true; });
for (const button of document.querySelectorAll('[data-background]')) button.onclick = () => {
  background = button.dataset.background;
  updateBackground();
  applyRenderMode();
  for (const swatch of document.querySelectorAll('[data-background]')) swatch.setAttribute('aria-pressed', String(swatch === button));
};
$('play').onclick = () => { playing = !playing; updatePlayButton(); };
$('clips').onchange = selectClip;
$('camera-mode').onchange = () => {
  const wasStereo = cameraMode !== 'mono';
  cameraMode = $('camera-mode').value;
  $('stereo-strength-control').hidden = cameraMode === 'mono';
  if (wasStereo !== (cameraMode !== 'mono')) fit();
};
$('stereo-strength').oninput = () => {
  $('stereo-strength-value').value = Number($('stereo-strength').value).toFixed(1);
};
$('timeline').oninput = () => {
  if (!action) return;
  action.time = Number($('timeline').value);
  mixer.update(0);
};
window.addEventListener('keydown', event => {
  if (/INPUT|SELECT|BUTTON|TEXTAREA/.test(event.target.tagName) || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.code === 'Space' && mixer) { event.preventDefault(); $('play').click(); }
  if (event.code === 'KeyF') fit();
});
window.addEventListener('resize', () => {
  if (renderer.xr.isPresenting) return;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const xrSupport = { ar: false, vr: false };
let xrStartup;
if (debugXR) {
  renderer.domElement.addEventListener('webglcontextlost', () => xrStartup?.log('WebGL context lost'));
  renderer.domElement.addEventListener('webglcontextrestored', () => xrStartup?.log('WebGL context restored'));
}
function updateXRButtons() {
  for (const type of ['ar', 'vr']) {
    $(type).disabled = !xrSupport[type] || !model;
    $(type).title = !isSecureContext ? 'AR/VRにはHTTPSまたはlocalhostが必要です' : !xrSupport[type] ? `この環境はWebXR ${type.toUpperCase()}に非対応です` : !model ? 'GLBを開いてください' : `${type.toUpperCase()}で表示（最大辺 約1m）`;
  }
}
async function detectXR() {
  if (isSecureContext && navigator.xr) {
    await Promise.all(['ar', 'vr'].map(async type => {
      try { xrSupport[type] = await navigator.xr.isSessionSupported(`immersive-${type}`); } catch { /* Unavailable in this browser. */ }
    }));
  }
  updateXRButtons();
}
detectXR();
async function startXR(type) {
  let session;
  const startedAt = debugXR ? performance.now() : 0;
  const trace = debugXR ? {
    receivedFrame: false,
    log(stage) {
      console.info(`[GLBV XR ${type.toUpperCase()}] +${(performance.now() - startedAt).toFixed(1)} ms ${stage}`);
    },
  } : null;
  try {
    trace?.log('requestSession started');
    session = await navigator.xr.requestSession(`immersive-${type}`, {
      optionalFeatures: ['local-floor', 'hand-tracking', ...(type === 'ar' ? ['hit-test', 'dom-overlay'] : [])],
      ...(type === 'ar' ? { domOverlay: { root: document.body } } : {}),
    });
    trace?.log('requestSession resolved');
    savedView = { position: camera.position.clone(), quaternion: camera.quaternion.clone(), target: controls.target.clone() };
    sessionMode = type;
    gestures.reset();
    controls.enabled = false;
    camera.position.set(0, 0, 0);
    camera.quaternion.identity();
    updateBackground();
    pendingPlacement = true;
    document.body.classList.add('xr');
    session.addEventListener('end', endXR, { once: true });
    session.addEventListener('visibilitychange', () => gestures.reset());
    if (type === 'ar') {
      session.addEventListener('selectstart', ({ inputSource }) => {
        if (inputSource.hand) handSelections.set(inputSource, { yaw: 0, pitch: 0, manipulated: false });
      });
      session.addEventListener('selectend', ({ inputSource }) => handSelections.delete(inputSource));
      session.addEventListener('select', ({ inputSource }) => {
        if (!inputSource.hand || !reticle.visible || handSelections.get(inputSource)?.manipulated) return;
        placement.position.setFromMatrixPosition(reticle.matrix);
        placement.position.y += modelHalfHeight * placement.scale.y;
        placement.quaternion.identity();
        pendingPlacement = false;
        status('配置しました。面に向けてピンチすると再配置できます。', false, 3000);
      });
    }
    xrStartup = trace;
    trace?.log('setSession started');
    await renderer.xr.setSession(session);
    trace?.log('setSession resolved');
    renderer.xr.getReferenceSpace()?.addEventListener('reset', () => gestures.reset());
    const gestureHelp = '片手のピンチ移動で回転 · 両手のピンチで拡縮';
    status(type === 'ar' ? `面に向けてピンチで配置 · ${gestureHelp}` : gestureHelp, false, 7000);
    if (type === 'ar' && session.requestHitTestSource) {
      try {
        const space = await session.requestReferenceSpace('viewer');
        const source = await session.requestHitTestSource({ space });
        if (renderer.xr.getSession() === session) hitSource = source;
        else source.cancel();
      } catch { /* Front-of-view placement remains available without hit testing. */ }
    }
  } catch (error) {
    trace?.log('XR startup failed');
    if (session) { await session.end().catch(() => {}); endXR(); }
    status(`XRを開始できませんでした。${error.message}`, true, 8000);
  }
}
function endXR() {
  xrStartup = null;
  hitSource?.cancel(); hitSource = null;
  sessionMode = null; pendingPlacement = false; reticle.visible = false;
  gestures.reset();
  document.body.classList.remove('xr');
  placement.position.set(0, 0, 0); placement.quaternion.identity();
  placement.scale.setScalar(1);
  updateBackground();
  if (savedView) {
    camera.position.copy(savedView.position); camera.quaternion.copy(savedView.quaternion);
    controls.target.copy(savedView.target); savedView = null;
  }
  controls.enabled = true;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  controls.update(); status();
}
$('exit-xr').onclick = () => renderer.xr.getSession()?.end().catch(error => status(error.message, true));
$('exit-xr').addEventListener('beforexrselect', event => event.preventDefault());
$('ar').onclick = () => startXR('ar');
$('vr').onclick = () => startXR('vr');
const direction = new THREE.Vector3();
function renderView() {
  // WebXR supplies its own eye cameras and viewports.
  if (renderer.xr.isPresenting) {
    renderer.render(scene, camera);
    return;
  }
  renderer.getSize(viewportSize);
  const { x: width, y: height } = viewportSize;
  if (cameraMode === 'mono') {
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, width, height);
    renderer.render(scene, camera);
    return;
  }
  camera.updateMatrixWorld();
  camera.focus = Math.max(camera.position.distanceTo(controls.target), camera.near);
  // Scale the eye separation to the view distance for arbitrary GLB units.
  stereo.eyeSep = camera.focus * 0.035 * Number($('stereo-strength').value);
  stereo.update(camera);
  const left = cameraMode === 'cross' ? stereo.cameraR : stereo.cameraL;
  const right = cameraMode === 'cross' ? stereo.cameraL : stereo.cameraR;
  renderer.setScissorTest(true);
  renderer.setScissor(0, 0, width / 2, height);
  renderer.setViewport(0, 0, width / 2, height);
  renderer.render(scene, left);
  renderer.setScissor(width / 2, 0, width / 2, height);
  renderer.setViewport(width / 2, 0, width / 2, height);
  renderer.render(scene, right);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, width, height);
}
let lastTime;
renderer.setAnimationLoop((time, frame) => {
  const trace = frame ? xrStartup : null;
  if (trace && !trace.receivedFrame) {
    trace.receivedFrame = true;
    trace.log('first XR frame');
  }
  const delta = lastTime === undefined ? 0 : Math.min((time - lastTime) / 1000, 0.1);
  lastTime = time;
  if (mixer) {
    if (playing) mixer.update(delta * Number($('speed').value));
    $('timeline').value = action.time;
    $('time').textContent = `${action.time.toFixed(1)} / ${action.getClip().duration.toFixed(1)}`;
  }
  vrm?.update(delta);
  let firstPlacedRender = false;
  if (frame) {
    const reference = renderer.xr.getReferenceSpace();
    const viewerPose = frame.getViewerPose(reference);
    if (pendingPlacement) {
      const pose = viewerPose;
      if (pose) {
        const p = pose.transform.position, q = pose.transform.orientation;
        direction.set(0, 0, -1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
        direction.y = 0; direction.normalize();
        placement.position.set(p.x + direction.x * 1.7, p.y - 0.25, p.z + direction.z * 1.7);
        pendingPlacement = false;
        firstPlacedRender = Boolean(trace);
      }
    }
    if (model) {
      const gesture = gestures.update(frame, reference, viewerPose?.transform.orientation);
      if (gesture?.type === 'rotate') {
        const selection = sessionMode === 'ar' && handSelections.get(gesture.source);
        if (selection && !selection.manipulated) {
          selection.yaw += gesture.yaw;
          selection.pitch += gesture.pitch;
          selection.manipulated = Math.hypot(selection.yaw, selection.pitch) >= AR_DRAG_THRESHOLD;
        }
        gestureAxis.copy(gesture.up);
        gestureRotation.setFromAxisAngle(gestureAxis, gesture.yaw);
        placement.quaternion.premultiply(gestureRotation);
        gestureAxis.copy(gesture.right);
        gestureRotation.setFromAxisAngle(gestureAxis, gesture.pitch);
        placement.quaternion.premultiply(gestureRotation).normalize();
      } else if (gesture?.type === 'zoom') {
        for (const source of gesture.sources) {
          const selection = handSelections.get(source);
          if (selection) selection.manipulated = true;
        }
        placement.scale.setScalar(THREE.MathUtils.clamp(placement.scale.x * gesture.factor, 0.1, 5));
      }
    }
    reticle.visible = false;
    if (sessionMode === 'ar' && hitSource) {
      const hit = frame.getHitTestResults(hitSource)[0];
      const pose = hit?.getPose(reference);
      if (pose) { reticle.matrix.fromArray(pose.transform.matrix); reticle.visible = true; }
    }
  } else controls.update();
  if (firstPlacedRender) trace.log('first render with viewer pose started');
  renderView();
  if (firstPlacedRender) {
    trace.log('first render with viewer pose returned');
    xrStartup = null;
  }
});

// URLSearchParams decodes an encoded URL once, including its query string.
const modelURL = params.get('url');
const animationURL = params.get('vrma');
if (modelURL !== null) {
  $('open').hidden = true;
  if (!modelURL.trim()) status('urlパラメータにGLBまたはVRMのパスかURLを指定してください。', true);
  else if (animationURL !== null && !animationURL.trim()) status('vrmaパラメータにVRMAのパスかURLを指定してください。', true);
  else openURL(modelURL.trim(), animationURL?.trim());
} else if (animationURL !== null) {
  status('vrmaパラメータと一緒にurlパラメータでVRMを指定してください。', true);
}
