// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { addResizeGrip } from "../src/editors/resize-grip.js";

function mount(options) {
  const parent = document.createElement("div");
  const target = document.createElement("div");
  parent.append(target);
  document.body.append(parent);
  const grip = addResizeGrip(target, { maxHeight: () => 600, ...options });
  return { target, grip };
}

function pointer(type, clientY) {
  return new PointerEvent(type, { button: 0, clientY, pointerId: 1, bubbles: true });
}

describe("addResizeGrip", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("sets the initial height and places the grip after the target", () => {
    const { target, grip } = mount({ height: 280, minHeight: 110 });
    expect(target.style.height).toBe("280px");
    expect(target.nextElementSibling).toBe(grip);
    expect(grip.getAttribute("role")).toBe("separator");
  });

  it("drags within the min and max bounds and remembers the height", () => {
    const { target, grip } = mount({ height: 280, minHeight: 110, storageKey: "q" });
    grip.dispatchEvent(pointer("pointerdown", 100));
    grip.dispatchEvent(pointer("pointermove", 150));
    expect(target.style.height).toBe("330px");
    grip.dispatchEvent(pointer("pointermove", 2000));
    expect(target.style.height).toBe("600px");
    grip.dispatchEvent(pointer("pointermove", -2000));
    expect(target.style.height).toBe("110px");
    grip.dispatchEvent(pointer("pointermove", 120));
    grip.dispatchEvent(pointer("pointerup", 120));
    expect(localStorage.getItem("mong.editorHeight.q")).toBe("300");

    const again = mount({ height: 280, minHeight: 110, storageKey: "q" });
    expect(again.target.style.height).toBe("300px");
  });

  it("resizes with the arrow keys and fits the content on double-click", () => {
    const { target, grip } = mount({ height: 280, minHeight: 110, fitHeight: () => 412 });
    grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(target.style.height).toBe("304px");
    grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", shiftKey: true, bubbles: true }));
    expect(target.style.height).toBe("208px");
    grip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(target.style.height).toBe("412px");
  });
});
