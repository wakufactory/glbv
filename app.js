import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { XRPinchGestures } from './xr-gestures.js';

const $ = id => document.getElementById(id);
const CDN = 'https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/';
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
camera.position.set(1.7, 1.1, 2.5);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = false;
controls.minDistance = 0.05;
controls.maxDistance = 100;
const pmrem = new THREE.PMREMGenerator(renderer);
const room = new RoomEnvironment();
const environment = pmrem.fromScene(room).texture;
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
const gestureAxis = new THREE.Vector3();
const gestureRotation = new THREE.Quaternion();
const manager = new THREE.LoadingManager();
// Local GLBs must be self-contained. Never fetch a URI embedded in an opened file.
manager.setURLModifier(url => {
  if (/^(data:|blob:)/i.test(url)) return url;
  throw new Error('外部ファイルを参照しています。テクスチャを埋め込んだGLBを使用してください。');
});
const draco = new DRACOLoader().setDecoderPath(`${CDN}libs/draco/gltf/`);
const ktx2 = new KTX2Loader().setTranscoderPath(`${CDN}libs/basis/`).detectSupport(renderer);
const loader = new GLTFLoader(manager).setDRACOLoader(draco).setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
let model, mixer, action, clips = [], playing = true, loadId = 0, statusTimer;
let modelHalfHeight = 0.5;
let sessionMode = null, hitSource = null, pendingPlacement = false, savedView;
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
  const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
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
async function openModel(name, readData) {
  const id = ++loadId;
  status('GLBを読み込み中…');
  try {
    const data = await readData();
    if (id !== loadId) return;
    const gltf = await loader.parseAsync(data, '');
    if (id !== loadId) { dispose(gltf.scene); return; }
    const next = gltf.scene;
    next.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(next);
    if (bounds.isEmpty() || !Number.isFinite(bounds.min.length() + bounds.max.length())) {
      dispose(next);
      throw new Error('表示できる形状がありません。');
    }
    if (model) {
      mixer?.stopAllAction();
      mixer?.uncacheRoot(model);
      content.remove(model);
      dispose(model);
    }
    model = next;
    content.add(model);
    const size = bounds.getSize(new THREE.Vector3());
    const scale = 1 / Math.max(size.x, size.y, size.z, 0.000001);
    modelHalfHeight = size.y * scale / 2;
    content.scale.setScalar(scale);
    content.position.copy(bounds.getCenter(new THREE.Vector3())).multiplyScalar(-scale);
    clips = gltf.animations;
    mixer = clips.length ? new THREE.AnimationMixer(model) : null;
    action = null;
    $('clips').replaceChildren(...clips.map((clip, i) => new Option(clip.name || `Animation ${i + 1}`, i)));
    $('playback').hidden = !clips.length;
    if (mixer) selectClip();
    $('welcome').hidden = true;
    $('filename').textContent = name;
    $('filename').title = name;
    $('fit').disabled = false;
    let meshes = 0, triangles = 0;
    model.traverse(object => {
      if (object.isMesh) {
        meshes++;
        triangles += ((object.geometry.index?.count ?? object.geometry.attributes.position?.count ?? 0) / 3) * (object.isInstancedMesh ? object.count : 1);
      }
    });
    $('info').textContent = `${meshes.toLocaleString()} meshes · ${Math.round(triangles).toLocaleString()} triangles${clips.length ? ` · ${clips.length} animations` : ''}`;
    fit();
    updateXRButtons();
    status();
  } catch (error) {
    console.error(error);
    if (id === loadId) status(`読み込めませんでした。${error.message || 'GLBファイルを確認してください。'}`, true);
  }
}
function openFile(file) {
  if (!file) return;
  if (!/\.glb$/i.test(file.name)) return status('拡張子 .glb のファイルを選んでください。', true, 6000);
  return openModel(file.name, () => file.arrayBuffer());
}
function openURL(value) {
  return openModel(value, async () => {
    const url = new URL(value, window.location.href);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('URLはHTTPまたはHTTPSで指定してください。');
    }
    const response = await fetch(url);
    if (!response.ok) throw new Error(`GLBの取得に失敗しました (HTTP ${response.status})。`);
    // URL endpoints need not have a .glb extension (e.g. signed download URLs).
    return response.arrayBuffer();
  });
}
$('open').onclick = $('choose').onclick = () => $('file').click();
$('file').onchange = () => { openFile($('file').files[0]); $('file').value = ''; };
$('demo').onclick = () => openURL('./sample.glb');
$('fit').onclick = fit;
let dragDepth = 0;
window.addEventListener('dragenter', event => {
  event.preventDefault();
  if (event.dataTransfer?.types.includes('Files')) { dragDepth++; $('drop').hidden = false; }
});
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('dragleave', event => { event.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
window.addEventListener('drop', event => {
  event.preventDefault(); dragDepth = 0; $('drop').hidden = true;
  openFile(event.dataTransfer.files[0]);
});
window.addEventListener('blur', () => { dragDepth = 0; $('drop').hidden = true; });
for (const button of document.querySelectorAll('[data-color]')) button.onclick = () => {
  background = button.dataset.color;
  scene.background = new THREE.Color(background);
  for (const swatch of document.querySelectorAll('[data-color]')) swatch.setAttribute('aria-pressed', String(swatch === button));
};
$('play').onclick = () => { playing = !playing; updatePlayButton(); };
$('clips').onchange = selectClip;
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
  try {
    session = await navigator.xr.requestSession(`immersive-${type}`, { optionalFeatures: type === 'ar' ? ['local-floor', 'hit-test', 'dom-overlay'] : ['local-floor', 'hand-tracking'], ...(type === 'ar' ? { domOverlay: { root: document.body } } : {}) });
    savedView = { position: camera.position.clone(), quaternion: camera.quaternion.clone(), target: controls.target.clone() };
    sessionMode = type;
    gestures.reset();
    controls.enabled = false;
    camera.position.set(0, 0, 0);
    camera.quaternion.identity();
    scene.background = type === 'ar' ? null : new THREE.Color(background);
    pendingPlacement = true;
    document.body.classList.add('xr');
    session.addEventListener('end', endXR, { once: true });
    session.addEventListener('visibilitychange', () => gestures.reset());
    session.addEventListener('select', () => {
      if (type === 'ar' && reticle.visible) {
        placement.position.setFromMatrixPosition(reticle.matrix);
        placement.position.y += modelHalfHeight;
        placement.quaternion.identity();
        status('配置しました。タップで再配置できます。', false, 3000);
      }
    });
    await renderer.xr.setSession(session);
    renderer.xr.getReferenceSpace()?.addEventListener('reset', () => gestures.reset());
    status(type === 'ar' ? '面に向けてタップすると配置できます。面が見つからない場合は前方に表示します。' : '', false, 7000);
    if (type === 'ar' && session.requestHitTestSource) {
      try {
        const space = await session.requestReferenceSpace('viewer');
        const source = await session.requestHitTestSource({ space });
        if (renderer.xr.getSession() === session) hitSource = source;
        else source.cancel();
      } catch { /* Front-of-view placement remains available without hit testing. */ }
    }
  } catch (error) {
    if (session) { await session.end().catch(() => {}); endXR(); }
    status(`XRを開始できませんでした。${error.message}`, true, 8000);
  }
}
function endXR() {
  hitSource?.cancel(); hitSource = null;
  sessionMode = null; pendingPlacement = false; reticle.visible = false;
  gestures.reset();
  document.body.classList.remove('xr');
  placement.position.set(0, 0, 0); placement.quaternion.identity();
  placement.scale.setScalar(1);
  scene.background = new THREE.Color(background);
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
$('ar').onclick = () => startXR('ar');
$('vr').onclick = () => startXR('vr');
const direction = new THREE.Vector3();
let lastTime;
renderer.setAnimationLoop((time, frame) => {
  const delta = lastTime === undefined ? 0 : Math.min((time - lastTime) / 1000, 0.1);
  lastTime = time;
  if (mixer) {
    if (playing) mixer.update(delta * Number($('speed').value));
    $('timeline').value = action.time;
    $('time').textContent = `${action.time.toFixed(1)} / ${action.getClip().duration.toFixed(1)}`;
  }
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
      }
    }
    if (sessionMode === 'vr' && model) {
      const gesture = gestures.update(frame, reference, viewerPose?.transform.orientation);
      if (gesture?.type === 'rotate') {
        gestureAxis.copy(gesture.up);
        gestureRotation.setFromAxisAngle(gestureAxis, gesture.yaw);
        placement.quaternion.premultiply(gestureRotation);
        gestureAxis.copy(gesture.right);
        gestureRotation.setFromAxisAngle(gestureAxis, gesture.pitch);
        placement.quaternion.premultiply(gestureRotation).normalize();
      } else if (gesture?.type === 'zoom') {
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
  renderer.render(scene, camera);
});

// URLSearchParams decodes an encoded URL once, including its query string.
const modelURL = new URLSearchParams(window.location.search).get('url');
if (modelURL !== null) {
  $('open').hidden = true;
  $('choose').hidden = true;
  if (modelURL.trim()) openURL(modelURL.trim());
  else status('urlパラメータにGLBの相対パスまたはURLを指定してください。', true);
}
