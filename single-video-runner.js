/* global TikTokCleanerConfig */
(() => {
  "use strict";

  const MEDIA_PATH_PATTERN = /\/(?:video|photo)\/(\d+)/i;
  const REMOVE_REPOST_TEXT = "eliminar la publicación compartida";
  const SHARE_TERMS = ["share", "compartir"];
  const CLOSE_TERMS = ["close", "cerrar"];
  const MODES = Object.freeze({ DRY_RUN: "dry-run", REMOVE: "remove" });
  const STATES = Object.freeze({
    IDLE: "IDLE",
    VALIDATING_VIDEO: "VALIDATING_VIDEO",
    LOCATING_SHARE_BUTTON: "LOCATING_SHARE_BUTTON",
    OPENING_SHARE_MENU: "OPENING_SHARE_MENU",
    LOCATING_REMOVE_REPOST: "LOCATING_REMOVE_REPOST",
    READY_TO_REMOVE: "READY_TO_REMOVE",
    REMOVING: "REMOVING",
    VERIFYING: "VERIFYING",
    SUCCESS: "SUCCESS",
    FAILED: "FAILED"
  });

  const ALLOWED_TRANSITIONS = Object.freeze({
    [STATES.IDLE]: [STATES.VALIDATING_VIDEO],
    [STATES.VALIDATING_VIDEO]: [STATES.LOCATING_SHARE_BUTTON, STATES.FAILED],
    [STATES.LOCATING_SHARE_BUTTON]: [STATES.OPENING_SHARE_MENU, STATES.FAILED],
    [STATES.OPENING_SHARE_MENU]: [STATES.LOCATING_REMOVE_REPOST, STATES.FAILED],
    [STATES.LOCATING_REMOVE_REPOST]: [STATES.READY_TO_REMOVE, STATES.FAILED],
    [STATES.READY_TO_REMOVE]: [STATES.REMOVING, STATES.SUCCESS, STATES.FAILED],
    [STATES.REMOVING]: [STATES.VERIFYING, STATES.FAILED],
    [STATES.VERIFYING]: [STATES.SUCCESS, STATES.FAILED],
    [STATES.SUCCESS]: [],
    [STATES.FAILED]: []
  });

  class RunnerError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "RunnerError";
      this.code = code;
    }
  }

  function normalizeText(value = "") {
    return String(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase();
  }

  function compactText(element) {
    return String(element.innerText || element.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function sleep(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  function isInteractable(element) {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    if (
      rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0 ||
      rect.top >= window.innerHeight || rect.left >= window.innerWidth
    ) {
      return false;
    }
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function describeEvidence(element) {
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role") || "",
      ariaLabel: element.getAttribute("aria-label") || "",
      text: compactText(element).slice(0, 180),
      attributes: {
        dataE2e: element.getAttribute("data-e2e") || "",
        dataKeyInteraction: element.getAttribute("data-key-interaction") || ""
      },
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  }

  function semanticText(element) {
    return normalizeText([
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      compactText(element).slice(0, 500),
      element.getAttribute("data-e2e"),
      element.getAttribute("data-key-interaction")
    ].filter(Boolean).join(" "));
  }

  function findShareButton() {
    const candidates = Array.from(document.querySelectorAll(
      '[data-key-interaction="action_share"], [data-e2e="share-icon"], [data-e2e="share-btn"], button[aria-label], [role="button"][aria-label]'
    )).filter((element) => {
      const text = semanticText(element);
      return isInteractable(element) && SHARE_TERMS.some((term) => text.includes(term));
    });
    return candidates.sort((first, second) => {
      const score = (element) => {
        let value = 0;
        if (element.getAttribute("data-key-interaction") === "action_share") value += 4;
        if (element.getAttribute("data-e2e") === "share-icon") value += 3;
        if (element.getAttribute("role") === "button") value += 2;
        if (normalizeText(element.getAttribute("aria-label")).includes("compartir")) value += 1;
        return value;
      };
      return score(second) - score(first);
    })[0] || null;
  }

  function findShareMenu() {
    const shareGroup = Array.from(document.querySelectorAll(
      '[data-key-interaction="share_menu"], [data-e2e="share-group"]'
    )).find(isInteractable) || null;
    if (!shareGroup) return null;
    const dialog = shareGroup.closest('[role="dialog"]');
    return dialog && isInteractable(dialog) ? dialog : shareGroup;
  }

  function findShareMenuCloseButton(menu = findShareMenu()) {
    if (!menu) return null;
    const candidates = Array.from(menu.querySelectorAll(
      'button, [role="button"], [aria-label], [title], [data-e2e]'
    )).filter(isInteractable);
    const semanticMatch = candidates.find((element) => {
      const text = normalizeText([
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("data-e2e")
      ].filter(Boolean).join(" "));
      return CLOSE_TERMS.some((term) => text.includes(term));
    });
    if (semanticMatch) return semanticMatch;

    const shareGroup = menu.querySelector('[data-key-interaction="share_menu"], [data-e2e="share-group"]');
    if (!shareGroup) return null;
    const menuRect = menu.getBoundingClientRect();
    const groupRect = shareGroup.getBoundingClientRect();
    const headerHeight = Math.max(40, groupRect.top - menuRect.top);
    const hit = document.elementFromPoint(menuRect.right - 30, menuRect.top + headerHeight / 2);
    if (!hit || hit === menu || !menu.contains(hit)) return null;
    return hit.closest('button, [role="button"], [tabindex]') || hit;
  }

  async function closeShareMenu({ required = true } = {}) {
    const menu = findShareMenu();
    if (!menu) return { alreadyClosed: true };
    const closeButton = findShareMenuCloseButton(menu);
    if (!closeButton) {
      return { skipped: true, reason: "No se encontró un cierre semántico seguro." };
    }
    const evidence = describeEvidence(closeButton);
    if (typeof closeButton.click === "function") closeButton.click();
    else closeButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    try {
      await waitForCondition(() => !findShareMenu(), { timeout: 3000 });
    } catch {
      if (required) throw new RunnerError("MENU_CLOSE_FAILED", "El menú de compartir no se cerró.");
      return null;
    }
    return evidence;
  }

  function findRepostControl() {
    return Array.from(document.querySelectorAll('[data-e2e="share-repost"]'))
      .find(isInteractable) || null;
  }

  function findRemoveRepostOption() {
    const exactMatch = Array.from(document.querySelectorAll('[data-e2e="share-repost"]'))
      .find((element) => (
        isInteractable(element) && normalizeText(compactText(element)) === normalizeText(REMOVE_REPOST_TEXT)
      ));
    if (exactMatch) return exactMatch;

    const menu = findShareMenu();
    if (!menu) return null;
    return Array.from(menu.querySelectorAll("button, [role='button'], [data-e2e]"))
      .find((element) => (
        isInteractable(element) && normalizeText(compactText(element)) === normalizeText(REMOVE_REPOST_TEXT)
      )) || null;
  }

  function waitForCondition(check, { timeout = TikTokCleanerConfig.TIMEOUT_ELEMENT } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let observer;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        observer?.disconnect();
        window.clearTimeout(timeoutId);
        resolve(value);
      };
      const evaluate = () => {
        try {
          const value = check();
          if (value) finish(value);
        } catch (error) {
          if (settled) return;
          settled = true;
          observer?.disconnect();
          window.clearTimeout(timeoutId);
          reject(error);
        }
      };
      const timeoutId = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        observer?.disconnect();
        reject(new RunnerError("TIMEOUT", `No apareció el elemento esperado en ${timeout} ms.`));
      }, timeout);
      observer = new MutationObserver(evaluate);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      evaluate();
    });
  }

  async function verifyRemovalState() {
    await sleep(600);
    let firstObservation;
    try {
      firstObservation = await waitForCondition(() => {
        const control = findRepostControl();
        const controlText = control ? normalizeText(compactText(control)) : "";
        if (control && controlText && controlText !== normalizeText(REMOVE_REPOST_TEXT)) {
          return { changedControl: control };
        }
        if (!findShareMenu()) return { menuClosed: true };
        return null;
      }, { timeout: 4000 });
    } catch {
      throw new RunnerError(
        "VERIFICATION_FAILED",
        "La opción de eliminación siguió visible después del clic. No se intentará de nuevo."
      );
    }

    if (firstObservation.changedControl) return describeEvidence(firstObservation.changedControl);

    const shareButton = await waitForCondition(findShareButton);
    shareButton.click();
    await waitForCondition(findShareMenu);

    let changedControl;
    try {
      changedControl = await waitForCondition(() => {
        const control = findRepostControl();
        if (!control) return null;
        const controlText = normalizeText(compactText(control));
        return controlText && controlText !== normalizeText(REMOVE_REPOST_TEXT) ? control : null;
      });
    } catch {
      throw new RunnerError(
        "VERIFICATION_INCONCLUSIVE",
        "No se pudo confirmar el nuevo estado. Revisa el video manualmente antes de repetir cualquier acción."
      );
    }
    return describeEvidence(changedControl);
  }

  class SingleVideoRunner {
    constructor() {
      this.state = STATES.IDLE;
      this.mode = MODES.DRY_RUN;
      this.running = false;
      this.history = [];
    }

    transition(nextState, details, onProgress) {
      if (!ALLOWED_TRANSITIONS[this.state]?.includes(nextState)) {
        throw new RunnerError("INVALID_STATE_TRANSITION", `Transición inválida: ${this.state} → ${nextState}`);
      }
      this.state = nextState;
      const entry = {
        state: nextState,
        mode: this.mode,
        timestamp: new Date().toISOString(),
        details: details || null
      };
      this.history.push(entry);
      onProgress?.(entry);
    }

    async run({ mode = MODES.DRY_RUN, allowRemoval = false, onProgress } = {}) {
      if (this.running) throw new RunnerError("ALREADY_RUNNING", "Ya hay una operación individual en curso.");
      if (!Object.values(MODES).includes(mode)) throw new RunnerError("INVALID_MODE", "Modo de ejecución inválido.");
      if (mode === MODES.REMOVE && allowRemoval !== true) {
        throw new RunnerError("REMOVAL_NOT_AUTHORIZED", "La eliminación real no tiene autorización de un solo uso.");
      }

      this.running = true;
      this.mode = mode;
      this.state = STATES.IDLE;
      this.history = [];
      const startedAt = Date.now();
      let videoId = null;

      try {
        this.transition(STATES.VALIDATING_VIDEO, null, onProgress);
        const match = window.location.pathname.match(MEDIA_PATH_PATTERN);
        if (!match) throw new RunnerError("VIDEO_PAGE_REQUIRED", "Abre manualmente una publicación reposteada antes de iniciar.");
        videoId = match[1];

        if (findShareMenu()) {
          await closeShareMenu({ required: true });
          await sleep(150);
        }

        this.transition(STATES.LOCATING_SHARE_BUTTON, { videoId }, onProgress);
        const shareButton = await waitForCondition(findShareButton);
        this.transition(STATES.OPENING_SHARE_MENU, { videoId, shareButton: describeEvidence(shareButton) }, onProgress);
        shareButton.click();
        const shareMenu = await waitForCondition(findShareMenu);

        this.transition(STATES.LOCATING_REMOVE_REPOST, { videoId, shareMenu: describeEvidence(shareMenu) }, onProgress);
        const removeOption = await waitForCondition(findRemoveRepostOption);
        this.transition(STATES.READY_TO_REMOVE, { videoId, removeOption: describeEvidence(removeOption) }, onProgress);

        let resultType = "DRY_RUN_WOULD_REMOVE";
        let verificationEvidence = null;
        if (mode === MODES.REMOVE) {
          this.transition(STATES.REMOVING, { videoId }, onProgress);
          removeOption.click();
          this.transition(STATES.VERIFYING, { videoId }, onProgress);
          verificationEvidence = await verifyRemovalState();
          resultType = "REMOVED_VERIFIED";
        }

        const menuCloseEvidence = await closeShareMenu();

        const result = {
          videoId,
          url: `${window.location.origin}${window.location.pathname}`,
          timestamp: new Date().toISOString(),
          result: resultType,
          attempts: 1,
          error: null,
          durationMs: Date.now() - startedAt,
          evidence: describeEvidence(removeOption),
          verificationEvidence,
          menuCloseEvidence
        };
        this.transition(STATES.SUCCESS, result, onProgress);
        return { ...result, mode, history: [...this.history] };
      } catch (error) {
        const failedAtState = this.state;
        await closeShareMenu({ required: false });
        const normalizedError = error instanceof RunnerError
          ? error
          : new RunnerError("UNEXPECTED_ERROR", error.message || String(error));
        normalizedError.failedAtState = failedAtState;
        if (ALLOWED_TRANSITIONS[this.state]?.includes(STATES.FAILED)) {
          this.transition(STATES.FAILED, {
            videoId,
            code: normalizedError.code,
            message: normalizedError.message
          }, onProgress);
        }
        throw normalizedError;
      } finally {
        this.running = false;
      }
    }
  }

  globalThis.TikTokSingleVideoRunner = Object.freeze({ MODES, STATES, runner: new SingleVideoRunner() });
})();
