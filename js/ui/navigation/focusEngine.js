import { Router } from "./router.js";
import { Platform } from "../../platform/index.js";

function buildNormalizedEvent(event) {
  // Closures capture this specific native event. Screen key handlers may be async
  // (handleKey wraps them in Promise.resolve), so a shared module-level reference
  // would point at a newer event by the time an awaited handler calls preventDefault.
  const nativeEvent = event;
  const normalizedKey = Platform.normalizeKey(event);
  const normalizedCode = Number(normalizedKey.keyCode || 0);
  return {
    key: normalizedKey.key,
    code: normalizedKey.code,
    keyName: normalizedKey.keyName,
    target: event?.target || null,
    altKey: Boolean(event?.altKey),
    ctrlKey: Boolean(event?.ctrlKey),
    shiftKey: Boolean(event?.shiftKey),
    metaKey: Boolean(event?.metaKey),
    repeat: Boolean(event?.repeat),
    defaultPrevented: Boolean(event?.defaultPrevented),
    keyCode: normalizedCode,
    which: normalizedCode,
    originalKeyCode: Number(normalizedKey.originalKeyCode || event?.keyCode || 0),
    keyDownDurationMs: 0,
    preventDefault: () => {
      if (typeof nativeEvent?.preventDefault === "function") nativeEvent.preventDefault();
    },
    stopPropagation: () => {
      if (typeof nativeEvent?.stopPropagation === "function") nativeEvent.stopPropagation();
    },
    stopImmediatePropagation: () => {
      if (typeof nativeEvent?.stopImmediatePropagation === "function") nativeEvent.stopImmediatePropagation();
    }
  };
}

// Pointer-only modal guard. Key events are NOT gated on this: fork screens
// drive dialogs and pickers through screen.onKeyDown, and dialogs that own
// their keys already stop propagation via a capture-phase listener.
function hasActiveModal() {
  return Boolean(globalThis?.document?.body?.classList?.contains("nuvio-modal-open"));
}

export const FocusEngine = {
  lastBackHandledAt: 0,
  lastPointerFocusTarget: null,
  pointerMoveFrame: null,
  pendingPointerMoveEvent: null,
  activeKeyDownStartedAt: new Map(),

  init() {
    this.boundHandleKey = this.handleKey.bind(this);
    this.boundHandleKeyUp = this.handleKeyUp.bind(this);
    this.boundHandleTizenHardwareKey = this.handleTizenHardwareKey.bind(this);
    this.boundHandlePointerMove = this.handlePointerMove.bind(this);
    this.boundHandlePointerClick = this.handlePointerClick.bind(this);
    this.boundHandleWindowBlur = () => {
      // Keyups are lost when the app loses focus mid-hold; drop the timestamps so
      // they can't leak into the next press of the same key.
      this.activeKeyDownStartedAt.clear();
    };
    document.addEventListener("keydown", this.boundHandleKey, true);
    document.addEventListener("keyup", this.boundHandleKeyUp, true);
    window.addEventListener("blur", this.boundHandleWindowBlur);
    if (Platform.isTizen()) {
      document.addEventListener("tizenhwkey", this.boundHandleTizenHardwareKey, true);
      window.addEventListener("tizenhwkey", this.boundHandleTizenHardwareKey, true);
    }
    if (Platform.isWebOS()) {
      document.addEventListener("mousemove", this.boundHandlePointerMove, true);
      document.addEventListener("pointermove", this.boundHandlePointerMove, true);
      document.addEventListener("click", this.boundHandlePointerClick, true);
      document.documentElement?.classList?.add("webos-pointer-remote");
      document.body?.classList?.add("webos-pointer-remote");
    }
  },

  handleTizenHardwareKey(event) {
    const normalizedEvent = buildNormalizedEvent(event);
    if (!Platform.isBackEvent({
      target: normalizedEvent.target,
      key: normalizedEvent.key,
      code: normalizedEvent.code,
      keyName: normalizedEvent.keyName,
      keyCode: normalizedEvent.keyCode,
      originalKeyCode: normalizedEvent.originalKeyCode,
      detail: event?.detail || null
    })) {
      return;
    }
    this.handleBack(event, normalizedEvent);
  },

  handleBack(event, normalizedEvent = buildNormalizedEvent(event)) {
    const now = Date.now();
    if (now - this.lastBackHandledAt < 250) {
      event?.preventDefault?.();
      event?.stopImmediatePropagation?.();
      return;
    }
    this.lastBackHandledAt = now;

    normalizedEvent.preventDefault();
    normalizedEvent.stopPropagation();
    normalizedEvent.stopImmediatePropagation();

    const currentScreen = Router.getCurrentScreen();
    const consumeResult = currentScreen?.consumeBackRequest?.();
    if (consumeResult) {
      if (consumeResult === "history") {
        return;
      }
      Router.suppressNextPopstate?.();
      return;
    }

    Router.back();
  },

  handleKey(event) {
    if (event?.target && !document.contains(event.target)) {
      return;
    }

    const normalizedEvent = buildNormalizedEvent(event);
    const keyIdentity = this.getKeyIdentity(normalizedEvent);
    // A non-repeat keydown is a fresh press: always restart its timestamp. Only
    // repeats preserve the existing one — otherwise a lost keyup (app blur,
    // screensaver) would make the next press report a huge keyDownDurationMs.
    if (keyIdentity && (!normalizedEvent.repeat || !this.activeKeyDownStartedAt.has(keyIdentity))) {
      this.activeKeyDownStartedAt.set(keyIdentity, Date.now());
    }

    if (
      Platform.isBackEvent({
        target: normalizedEvent.target,
        key: normalizedEvent.key,
        code: normalizedEvent.code,
        keyName: normalizedEvent.keyName,
        keyCode: normalizedEvent.keyCode,
        originalKeyCode: normalizedEvent.originalKeyCode
      })
    ) {
      this.handleBack(event, normalizedEvent);
      return;
    }

    const currentScreen = Router.getCurrentScreen();

    if (currentScreen?.onKeyDown) {
      Promise.resolve(currentScreen.onKeyDown(normalizedEvent)).catch((error) => {
        console.warn("Screen keydown handler failed", error);
      });
    }
  },

  handleKeyUp(event) {
    if (event?.target && !document.contains(event.target)) return;

    const normalizedEvent = buildNormalizedEvent(event);
    const keyIdentity = this.getKeyIdentity(normalizedEvent);
    if (keyIdentity) {
      const startedAt = Number(this.activeKeyDownStartedAt.get(keyIdentity) || 0);
      normalizedEvent.keyDownDurationMs = startedAt > 0 ? Math.max(0, Date.now() - startedAt) : 0;
      this.activeKeyDownStartedAt.delete(keyIdentity);
    }

    const currentScreen = Router.getCurrentScreen();
    if (!currentScreen?.onKeyUp) {
      return;
    }
    Promise.resolve(currentScreen.onKeyUp(normalizedEvent)).catch((error) => {
      console.warn("Screen keyup handler failed", error);
    });
  },

  getKeyIdentity(event) {
    const keyCode = Number(event?.keyCode || event?.which || 0);
    if (keyCode) {
      return `code:${keyCode}`;
    }
    const key = String(event?.key || event?.code || event?.keyName || "").trim();
    return key ? `key:${key}` : "";
  },

  getPointerFocusable(event) {
    const target = event?.target?.closest?.(".focusable");
    if (!target || !(target instanceof HTMLElement) || !document.contains(target)) {
      return null;
    }
    if (
      target.disabled ||
      target.classList.contains("is-disabled") ||
      target.classList.contains("disabled") ||
      target.getAttribute("aria-disabled") === "true"
    ) {
      return null;
    }
    const rect = target.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    return target;
  },

  focusPointerTarget(target, event = null) {
    if (!target) {
      return false;
    }
    if (hasActiveModal() && !target.closest?.(".nuvio-dialog-backdrop")) {
      return false;
    }
    const currentScreen = Router.getCurrentScreen();
    const screenContainer =
      currentScreen?.container instanceof HTMLElement
        ? currentScreen.container
        : target.closest(".screen");
    if (screenContainer && !screenContainer.contains(target)) {
      return false;
    }

    const focusRoot = screenContainer || document;
    focusRoot.querySelectorAll?.(".focusable.focused")?.forEach((node) => {
      if (node !== target) {
        node.classList.remove("focused");
      }
    });
    target.classList.add("focused");
    try {
      target.focus({ preventScroll: true });
    } catch (_) {
      try {
        target.focus();
      } catch (_) {}
    }
    currentScreen?.onPointerFocus?.(target, event);
    this.lastPointerFocusTarget = target;
    return true;
  },

  handlePointerMove(event) {
    if (!Platform.isWebOS()) {
      return;
    }
    this.pendingPointerMoveEvent = event;
    if (this.pointerMoveFrame) {
      return;
    }
    const run = () => {
      const pendingEvent = this.pendingPointerMoveEvent;
      this.pendingPointerMoveEvent = null;
      this.processPointerMove(pendingEvent);
      this.pointerMoveFrame = null;
    };
    if (typeof requestAnimationFrame === "function") {
      this.pointerMoveFrame = requestAnimationFrame(run);
    } else {
      this.pointerMoveFrame = setTimeout(run, 16);
    }
  },

  processPointerMove(event) {
    if (!Platform.isWebOS()) {
      return;
    }
    const currentScreen = Router.getCurrentScreen();
    currentScreen?.onPointerMove?.(event);
    const target = this.getPointerFocusable(event);
    if (!target || target === this.lastPointerFocusTarget) {
      return;
    }
    if (hasActiveModal() && !target.closest?.(".nuvio-dialog-backdrop")) {
      return;
    }
    this.focusPointerTarget(target, event);
  },

  async handlePointerClick(event) {
    if (!Platform.isWebOS()) {
      return;
    }
    const target = this.getPointerFocusable(event);
    if (!target) {
      return;
    }
    if (hasActiveModal() && !target.closest?.(".nuvio-dialog-backdrop")) {
      return;
    }
    this.focusPointerTarget(target, event);
    const currentScreen = Router.getCurrentScreen();
    if (hasActiveModal()) {
      return;
    }
    if (typeof currentScreen?.onPointerActivate !== "function") {
      return;
    }
    const handled = await currentScreen.onPointerActivate(target, event);
    if (handled) {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      event?.stopImmediatePropagation?.();
    }
  }
};
