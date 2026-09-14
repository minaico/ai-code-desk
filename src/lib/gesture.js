/**
 * Telling a tap apart from a drag on a touch screen, and how fast it was.
 *
 * This lives on its own, with no imports, so the decision can be tested
 * without a DOM or a terminal.
 *
 * Why it exists: xterm only scrolls on touch while no program has asked for
 * the mouse ("if (!coreMouseService.areMouseEventsActive)"). Claude Code, vim
 * and less all ask for it, so inside exactly the sessions this app is for, a
 * drag was handed to the program as mouse movement and the screen never moved.
 * The gesture is therefore split before xterm sees it: a tap stays the
 * program's, a vertical drag scrolls the scrollback.
 */

/** Weight of the newest sample in the velocity average. */
const VELOCITY_SMOOTHING = 0.35;

/**
 * @param {number} thresholdPx how far a finger must travel to mean "scroll"
 */
export function createDragTracker(thresholdPx = 8) {
  let startY = null;
  let lastY = null;
  let lastAt = 0;
  let dragging = false;
  let velocity = 0; // pixels per millisecond, positive = content moving up

  return {
    get dragging() {
      return dragging;
    },

    /** Pixels per millisecond at the moment the finger left the glass. */
    get velocity() {
      return velocity;
    },

    start(y, now = performance.now()) {
      startY = lastY = y;
      lastAt = now;
      dragging = false;
      velocity = 0;
    },

    /**
     * @param {number} y current finger position
     * @param {number} [now] timestamp, injectable so the maths can be tested
     * @returns {{dragging: boolean, delta: number}} delta in pixels to scroll
     */
    move(y, now = performance.now()) {
      if (startY === null) return { dragging: false, delta: 0 };
      // Once a gesture is a drag it stays one, so a finger that pauses
      // mid-scroll does not hand the rest of the movement back to the program.
      if (!dragging && Math.abs(y - startY) < thresholdPx) return { dragging: false, delta: 0 };
      dragging = true;

      const delta = lastY - y;
      const elapsed = now - lastAt;
      if (elapsed > 0) {
        const sample = delta / elapsed;
        // A finger that stops before lifting should not fling: the average is
        // weighted towards the newest samples so a pause damps it out.
        velocity = velocity * (1 - VELOCITY_SMOOTHING) + sample * VELOCITY_SMOOTHING;
      }
      lastY = y;
      lastAt = now;
      return { dragging: true, delta };
    },

    /** @returns {boolean} whether the gesture that just ended was a drag */
    end() {
      const wasDragging = dragging;
      startY = lastY = null;
      dragging = false;
      return wasDragging;
    },
  };
}

/**
 * Carry a flick on after the finger lifts, the way a native list does.
 *
 * Without this the terminal stops dead the moment you let go, which is what
 * makes hand-rolled touch scrolling feel wrong however accurate it is.
 *
 * @param {{velocity:number, onScroll:(delta:number)=>boolean, now?:()=>number,
 *          schedule?:(cb:(t:number)=>void)=>number, cancel?:(id:number)=>void}} opts
 * @returns {() => void} call to stop the glide early
 */
export function glide({
  velocity,
  onScroll,
  now = () => performance.now(),
  schedule = (cb) => requestAnimationFrame(cb),
  cancel = (id) => cancelAnimationFrame(id),
}) {
  /** Below this a flick is indistinguishable from letting go. */
  const MIN_VELOCITY = 0.04; // px/ms  (~2.4 px per frame)
  /** Kept per millisecond so the deceleration does not depend on frame rate. */
  const DECAY_PER_MS = 0.995;
  const MAX_FRAME_MS = 32; // a long frame must not launch the view across the buffer

  let speed = velocity;
  let handle = 0;
  let previous = now();

  if (Math.abs(speed) < MIN_VELOCITY) return () => {};

  const step = () => {
    const current = now();
    const elapsed = Math.min(current - previous, MAX_FRAME_MS);
    previous = current;

    const delta = speed * elapsed;
    // A frame that asks for no movement says nothing about whether the view
    // could have moved. Treating it as "we hit the end" would kill the glide
    // whenever the first frame lands in the same millisecond as the release.
    const blocked = delta !== 0 && !onScroll(delta);
    speed *= Math.pow(DECAY_PER_MS, elapsed);
    // Stop at the ends of the buffer instead of grinding against them.
    if (blocked || Math.abs(speed) < MIN_VELOCITY) return;
    handle = schedule(step);
  };

  handle = schedule(step);
  return () => {
    if (handle) cancel(handle);
    handle = 0;
  };
}
