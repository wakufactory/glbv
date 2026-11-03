// WebXR joint poses are in meters. Separate thresholds prevent pinch chatter.
const PINCH_START = 0.025;
const PINCH_END = 0.04;
const ROTATION_PER_METER = 3.5;
const MIN_HAND_DISTANCE = 0.05;
const MAX_FRAME_MOVEMENT = 0.25;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const validPosition = p => p && [p.x, p.y, p.z].every(Number.isFinite);

// Produces model manipulation deltas without changing the tracked XR camera.
export class XRPinchGestures {
  constructor() { this.reset(); }

  reset() {
    this.hands = new Map();
    this.gesture = null;
  }

  update(frame, reference, orientation) {
    if (!reference || !orientation || !frame.getJointPose || frame.session.visibilityState !== 'visible') {
      this.reset();
      return null;
    }
    const tracked = new Set();
    const pinches = [];
    for (const source of frame.session.inputSources) {
      if (!source.hand || !['left', 'right'].includes(source.handedness)) continue;
      const thumbSpace = source.hand.get('thumb-tip');
      const indexSpace = source.hand.get('index-finger-tip');
      if (!thumbSpace || !indexSpace) continue;
      const thumb = frame.getJointPose(thumbSpace, reference)?.transform.position;
      const index = frame.getJointPose(indexSpace, reference)?.transform.position;
      if (!validPosition(thumb) || !validPosition(index)) continue;
      tracked.add(source);
      const previous = this.hands.get(source);
      const pinched = distance(thumb, index) < (previous?.pinched ? PINCH_END : PINCH_START);
      this.hands.set(source, { pinched });
      if (pinched) pinches.push({ source, position: {
        x: (thumb.x + index.x) / 2,
        y: (thumb.y + index.y) / 2,
        z: (thumb.z + index.z) / 2,
      } });
    }
    for (const source of this.hands.keys()) if (!tracked.has(source)) this.hands.delete(source);
    if (!pinches.length) { this.gesture = null; return null; }
    const hands = pinches.slice(0, 2);
    const previous = this.gesture;
    const sameHands = previous && previous.sources.length === hands.length &&
      hands.every(hand => previous.sources.includes(hand.source));
    if (hands.length === 2) {
      const span = distance(hands[0].position, hands[1].position);
      // Rebase on mode changes, near-coincident hands and tracking discontinuities.
      this.gesture = { sources: hands.map(hand => hand.source), span };
      if (!sameHands || span < MIN_HAND_DISTANCE || previous.span < MIN_HAND_DISTANCE ||
          Math.abs(span - previous.span) > MAX_FRAME_MOVEMENT) return null;
      return { type: 'zoom', factor: span / previous.span };
    }
    const position = hands[0].position;
    if (!sameHands) {
      const { x, y, z, w } = orientation;
      // Capture viewer axes at pinch start; turning the head alone never rotates the model.
      this.gesture = { sources: [hands[0].source], position,
        right: { x: 1 - 2 * (y * y + z * z), y: 2 * (x * y + z * w), z: 2 * (x * z - y * w) },
        up: { x: 2 * (x * y - z * w), y: 1 - 2 * (x * x + z * z), z: 2 * (y * z + x * w) } };
      return null;
    }
    const delta = { x: position.x - previous.position.x, y: position.y - previous.position.y, z: position.z - previous.position.z };
    const travel = distance(position, previous.position);
    this.gesture.position = position;
    if (travel > MAX_FRAME_MOVEMENT) return null;
    const dot = axis => delta.x * axis.x + delta.y * axis.y + delta.z * axis.z;
    return { type: 'rotate', yaw: dot(previous.right) * ROTATION_PER_METER,
      pitch: -dot(previous.up) * ROTATION_PER_METER, right: previous.right, up: previous.up };
  }
}
