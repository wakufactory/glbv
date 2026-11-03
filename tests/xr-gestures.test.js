import test from 'node:test';
import assert from 'node:assert/strict';
import { XRPinchGestures } from '../html/xr-gestures.js';

const identity = { x: 0, y: 0, z: 0, w: 1 };
const reference = {};
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
function hand(handedness, x = 0) {
  const thumb = {}, index = {};
  const source = { handedness, hand: new Map([['thumb-tip', thumb], ['index-finger-tip', index]]) };
  source.move = (x, y = 1, z = -0.5, gap = 0.015) => {
    thumb.pose = { transform: { position: { x: x - gap / 2, y, z } } };
    index.pose = { transform: { position: { x: x + gap / 2, y, z } } };
  };
  source.lose = () => { index.pose = null; };
  source.move(x);
  return source;
}
function setup(...hands) {
  const controller = new XRPinchGestures();
  const frame = { session: { visibilityState: 'visible', inputSources: hands }, getJointPose: joint => joint.pose };
  return { controller, frame, update: (orientation = identity) => controller.update(frame, reference, orientation) };
}

test('either hand can pinch and drag horizontally and vertically with no easing', () => {
  for (const side of ['left', 'right']) {
    const source = hand(side);
    const { update } = setup(source);
    assert.equal(update(), null); // Pinching alone must not move the model.
    source.move(0.1, 1.1);
    const rotation = update();
    assert.equal(rotation.type, 'rotate');
    close(rotation.yaw, 0.35);
    close(rotation.pitch, -0.35);
    const stationary = update();
    close(stationary.yaw, 0);
    close(stationary.pitch, 0);
    source.move(0.1, 1.1, -0.5, 0.05);
    assert.equal(update(), null);
    source.move(0.2, 1.1, -0.5, 0.05);
    assert.equal(update(), null);
  }
});

test('pinch hysteresis prevents flicker near the contact threshold', () => {
  const source = hand('left');
  source.move(0, 1, -0.5, 0.03);
  const { update } = setup(source);
  assert.equal(update(), null);
  source.move(0.1, 1, -0.5, 0.03);
  assert.equal(update(), null); // Not close enough to begin.
  source.move(0.1);
  assert.equal(update(), null);
  source.move(0.2, 1, -0.5, 0.03);
  assert.equal(update().type, 'rotate'); // Still held, not released.
  source.move(0.2, 1, -0.5, 0.045);
  assert.equal(update(), null);
});

test('two pinched hands expand and shrink without rotating', () => {
  const left = hand('left', -0.2), right = hand('right', 0.2);
  const { update, frame } = setup(left, right);
  assert.equal(update(), null);
  left.move(-0.3); right.move(0.3);
  const expand = update();
  assert.equal(expand.type, 'zoom');
  close(expand.factor, 1.5);
  frame.session.inputSources = [right, left]; // Input ordering is not significant.
  left.move(-0.2); right.move(0.2);
  const shrink = update();
  assert.equal(shrink.type, 'zoom');
  close(shrink.factor, 2 / 3);
});

test('switching between single and double pinch rebases without a jump', () => {
  const left = hand('left', -0.2), right = hand('right', 0.2);
  right.move(0.2, 1, -0.5, 0.06);
  const { update } = setup(left, right);
  assert.equal(update(), null);
  left.move(-0.1);
  assert.equal(update().type, 'rotate');
  right.move(0.2);
  assert.equal(update(), null);
  left.move(-0.2);
  assert.equal(update().type, 'zoom');
  right.move(0.2, 1, -0.5, 0.06);
  left.move(-0.3);
  assert.equal(update(), null);
  left.move(-0.2);
  close(update().yaw, 0.35);
});

test('lost poses or disconnected hands stop the gesture and rebase on recovery', () => {
  const source = hand('left');
  const { update, frame } = setup(source);
  update();
  source.lose();
  assert.equal(update(), null);
  source.move(2);
  assert.equal(update(), null);
  source.move(2.1);
  close(update().yaw, 0.35);
  frame.session.inputSources = [];
  assert.equal(update(), null);
  frame.session.inputSources = [source];
  source.move(-1);
  assert.equal(update(), null);
});

test('hand identity changes while pinching do not cause jumps', () => {
  const source = hand('left');
  const { update, frame } = setup(source);
  update();
  frame.session.inputSources = [hand('right', 1)];
  assert.equal(update(), null);
});

test('head turns alone do not manipulate the model and drag follows the captured viewer axes', () => {
  const source = hand('left');
  const { update } = setup(source);
  const quarterTurn = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
  update(quarterTurn);
  const still = update(identity);
  close(still.yaw, 0); close(still.pitch, 0);
  source.move(0, 1, -0.6);
  close(update(identity).yaw, 0.35);
});

test('untracked viewer, session blur, reset and missing hand API clear held gestures', () => {
  const source = hand('left');
  const { controller, frame, update } = setup(source);
  update();
  frame.session.visibilityState = 'visible-blurred';
  assert.equal(update(), null);
  source.move(1);
  frame.session.visibilityState = 'visible';
  assert.equal(update(), null);
  assert.equal(update(null), null);
  source.move(2);
  assert.equal(update(), null);
  controller.reset();
  assert.equal(update(), null);
  frame.getJointPose = undefined;
  assert.equal(update(), null);
});

test('near-coincident hands and implausible tracking jumps never produce huge deltas', () => {
  const left = hand('left', -0.005), right = hand('right', 0.005);
  const { update, frame } = setup(left, right);
  assert.equal(update(), null);
  left.move(-0.1); right.move(0.1);
  assert.equal(update(), null);
  left.move(-0.2); right.move(0.2);
  close(update().factor, 2);
  left.move(-1); right.move(1);
  assert.equal(update(), null);
  frame.session.inputSources = [left];
  assert.equal(update(), null);
  left.move(-2);
  assert.equal(update(), null);
  left.move(-2.1);
  close(update().yaw, -0.35);
});

test('nonfinite joint positions are ignored and recovery is rebased', () => {
  const source = hand('left');
  const { update } = setup(source);
  update();
  source.move(NaN);
  assert.equal(update(), null);
  source.move(1);
  assert.equal(update(), null);
});
