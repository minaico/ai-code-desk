/**
 * Mobile keyboard handling.
 *
 * iOS Safari does not shrink the layout viewport when the software keyboard
 * opens: `100dvh` stays at the full screen height and Safari instead scrolls
 * the whole page to reveal the focused input. The result is the header sliding
 * up under the status bar while the terminal keeps its full height, so the
 * cursor ends up hidden behind the keyboard.
 *
 * The fix is to drive the layout from `visualViewport` — the only box that
 * actually reflects the space left above the keyboard — and to keep the page
 * itself pinned so Safari has nothing to scroll.
 */
const KEYBOARD_THRESHOLD_PX = 120;

export function trackViewport({ onResize, onKeyboard }) {
  const vv = window.visualViewport;
  let keyboardOpen = false;
  let timer = 0;

  function apply() {
    timer = 0;
    const height = vv ? Math.round(vv.height) : window.innerHeight;
    document.documentElement.style.setProperty("--app-height", `${height}px`);

    // Safari may still have scrolled the layout viewport before we resized;
    // put it back so the tab bar and the cwd header stay on screen.
    if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
    if (vv && vv.offsetTop > 0) {
      document.documentElement.style.setProperty("--app-offset", `${Math.round(vv.offsetTop)}px`);
    } else {
      document.documentElement.style.setProperty("--app-offset", "0px");
    }

    const open = !!vv && window.innerHeight - height > KEYBOARD_THRESHOLD_PX;
    if (open !== keyboardOpen) {
      keyboardOpen = open;
      document.body.classList.toggle("keyboard-open", open);
      if (onKeyboard) onKeyboard(open);
    }
    if (onResize) onResize({ height, keyboardOpen });
  }

  // A timer, not requestAnimationFrame: rAF is throttled or paused when the tab
  // is not being painted, and the layout must still be correct when it comes
  // back. iOS fires a burst of resize events while the keyboard animates, so
  // coalesce them.
  function schedule() {
    if (timer) return;
    timer = setTimeout(apply, 16);
  }

  if (vv) {
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
  }
  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", () => setTimeout(apply, 250));
  apply();

  return {
    get keyboardOpen() {
      return keyboardOpen;
    },
    refresh: schedule,
  };
}
