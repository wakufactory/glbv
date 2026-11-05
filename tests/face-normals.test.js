import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const app = await readFile(new URL('../html/app.js', import.meta.url), 'utf8');
const factory = app.slice(app.indexOf('function localFaceNormalMaterial('), app.indexOf('\nfunction restoreMaterials('));

function createMaterial() {
  class Matrix4 {
    copy(matrix) { this.source = matrix; return this; }
    invert() { this.inverted = true; return this; }
    multiplyMatrices(left, right) { this.left = left; this.right = right; return this; }
  }
  class ShaderMaterial {
    constructor(options) { Object.assign(this, options); }
  }
  const model = { matrixWorld: {} }, object = { matrixWorld: {} };
  const material = vm.runInNewContext(`${factory}\nlocalFaceNormalMaterial({ side: 2 }, object);`, {
    THREE: { ShaderMaterial, Matrix4 }, model, object,
  });
  return { material, model, object };
}

test('face-normal material directly outputs GLB-local RGB without lighting or shader injection', () => {
  const { material } = createMaterial();
  assert.equal(material.lights, false);
  assert.equal(material.toneMapped, false);
  assert.equal(material.side, 2);
  assert.equal(material.onBeforeCompile, undefined);
  assert.match(material.vertexShader, /uniform mat4 meshToGLB;/);
  assert.match(material.vertexShader, /varying vec3 vLocalPosition;/);
  assert.match(material.vertexShader, /vLocalPosition = \(meshToGLB \* glbPosition\).xyz;/);
  for (const chunk of ['morphinstance_vertex', 'morphtarget_vertex', 'skinning_vertex']) {
    assert.ok(material.vertexShader.indexOf('vLocalPosition =') > material.vertexShader.indexOf(`#include <${chunk}>`));
    assert.ok(material.vertexShader.includes(`#include <${chunk}>`));
  }
  assert.match(material.vertexShader, /glbPosition = instanceMatrix \* glbPosition;/);
  assert.match(material.vertexShader, /glbPosition = batchingMatrix \* glbPosition;/);
  assert.match(material.fragmentShader, /varying vec3 vLocalPosition;/);
  assert.doesNotMatch(material.fragmentShader, /#include <(?:normal|lights)_/);
  assert.match(material.fragmentShader, /vec3 normal = normalize\(cross\(dFdx\(vLocalPosition\), dFdy\(vLocalPosition\)\)\)/);
  assert.match(material.fragmentShader, /gl_FrontFacing \? 1.0 : -1.0/);
  assert.match(material.fragmentShader, /gl_FragColor = vec4\(normal \* 0.5 \+ 0.5, 1.0\)/);
});

test('each draw refreshes the mesh transform relative to the GLB root', () => {
  const { material, model, object } = createMaterial();
  const transform = material.uniforms.meshToGLB.value;
  material.onBeforeRender();
  assert.equal(transform.left.source, model.matrixWorld);
  assert.equal(transform.left.inverted, true);
  assert.equal(transform.right, object.matrixWorld);
  model.matrixWorld = {};
  object.matrixWorld = {};
  material.onBeforeRender();
  assert.equal(transform.left.source, model.matrixWorld);
  assert.equal(transform.right, object.matrixWorld);
  assert.notEqual(createMaterial().material.uniforms.meshToGLB.value, transform);
});
