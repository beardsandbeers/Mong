const STORAGE_PREFIX = "mong.editorHeight.";
const KEY_STEP = 24;

function readStored(key) {
  if (!key) return null;
  try {
    const value = Number(localStorage.getItem(STORAGE_PREFIX + key));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  if (!key) return;
  try {
    localStorage.setItem(STORAGE_PREFIX + key, String(Math.round(value)));
  } catch {
    // Storage blocked or full: the height still applies for this session.
  }
}

/**
 * Give `target` an explicit height and append a drag grip after it.
 *
 * Drag or Arrow Up/Down resizes, double-click fits `fitHeight()`. With `storageKey`,
 * the last height is restored on the next mount.
 */
export function addResizeGrip(target, {
  height,
  minHeight,
  maxHeight = () => Math.round(window.innerHeight * 0.85),
  fitHeight = null,
  storageKey = "",
  onResize = null,
}) {
  const clamp = (value) => Math.round(Math.min(Math.max(value, minHeight), Math.max(minHeight, maxHeight())));
  let current = clamp(readStored(storageKey) ?? height);

  const apply = (value) => {
    current = clamp(value);
    target.style.height = `${current}px`;
    grip.setAttribute("aria-valuenow", String(current));
    onResize?.(current);
  };
  const commit = () => writeStored(storageKey, current);

  const grip = document.createElement("div");
  grip.className = "query-editor__grip";
  grip.tabIndex = 0;
  grip.title = "Drag to resize. Double-click to fit the content.";
  grip.setAttribute("role", "separator");
  grip.setAttribute("aria-orientation", "horizontal");
  grip.setAttribute("aria-label", "Resize editor");
  grip.setAttribute("aria-valuemin", String(minHeight));

  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = current;
    grip.setPointerCapture?.(event.pointerId);
    grip.dataset.dragging = "";
    const move = (moveEvent) => apply(startHeight + moveEvent.clientY - startY);
    const end = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", end);
      grip.removeEventListener("pointercancel", end);
      delete grip.dataset.dragging;
      commit();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  });

  grip.addEventListener("dblclick", () => {
    if (!fitHeight) return;
    apply(fitHeight());
    commit();
  });

  grip.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const step = event.shiftKey ? KEY_STEP * 4 : KEY_STEP;
    apply(current + (event.key === "ArrowDown" ? step : -step));
    commit();
  });

  target.after(grip);
  apply(current);
  return grip;
}
