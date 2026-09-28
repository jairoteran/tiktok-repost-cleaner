/* global TikTokCleanerConfig */
(() => {
  "use strict";

  const KEY = "queueState";
  const MEDIA_PATH_PATTERN = /\/(?:video|photo)\/(\d+)/i;
  const SAFE_RETRY_STATES = new Set([
    "VALIDATING_VIDEO",
    "LOCATING_SHARE_BUTTON",
    "OPENING_SHARE_MENU",
    "LOCATING_REMOVE_REPOST"
  ]);
  const POST_CLICK_STATES = new Set(["REMOVING", "VERIFYING"]);
  const SAFE_ATTEMPTS = 2;
  let running = false;

  const base = () => ({
    state: "IDLE",
    queue: [],
    targetVideoIds: [],
    visitedVideoIds: [],
    mode: "dry-run",
    currentVideoId: null,
    stats: { found: 0, queued: 0, processed: 0, removed: 0, failed: 0, skipped: 0, retries: 0 },
    startedAt: null,
    updatedAt: new Date().toISOString(),
    lastError: null,
    tabId: null
  });

  const get = async () => (await chrome.storage.local.get(KEY))[KEY] || base();
  const save = async (state) => {
    state.updatedAt = new Date().toISOString();
    await chrome.storage.local.set({ [KEY]: state });
    chrome.runtime.sendMessage({ type: "QUEUE_STATE_UPDATE", state }).catch(() => {});
    return state;
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const send = (tabId, message) => new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });

  async function initialize(items, tabId, mode) {
    const state = base();
    state.tabId = tabId;
    state.mode = TikTokCleanerConfig.BATCH_REAL_ENABLED && mode === "remove" ? "remove" : "dry-run";
    state.targetVideoIds = Array.from(new Set(
      (Array.isArray(items) ? items : []).map((item) => String(item?.videoId || "")).filter((id) => /^\d+$/.test(id))
    ));
    state.stats.found = state.targetVideoIds.length;
    state.stats.queued = state.targetVideoIds.length;
    state.state = state.targetVideoIds.length ? "QUEUED" : "BLOCKED";
    state.lastError = state.targetVideoIds.length ? null : "No se detectaron videos cargados en la página.";
    await chrome.storage.local.set({ batchAuthorization: null });
    return save(state);
  }

  async function setControl(action) {
    const state = await get();
    if (action === "pause" && state.state === "RUNNING") state.state = "PAUSED";
    if (action === "stop") {
      state.state = "STOPPED";
      await chrome.storage.local.set({ batchAuthorization: null });
    }
    if (action === "clear") {
      await chrome.storage.local.set({ batchAuthorization: null });
      return save(base());
    }
    return save(state);
  }

  const findPendingId = (state) => {
    const completedIds = new Set(state.queue.filter((item) => item.status === "completed").map((item) => item.videoId));
    return state.targetVideoIds.find((id) => !completedIds.has(id) && !state.visitedVideoIds.includes(id)) || null;
  };

  async function openLoadedVideo(tabId, videoId) {
    if (!videoId) return false;
    const response = await send(tabId, { type: "OPEN_LOADED_VIDEO", videoId });
    if (!response?.ok) return false;
    await sleep(TikTokCleanerConfig.MIN_DELAY);
    return true;
  }

  async function navigateNext(tabId, pending, recoveryId) {
    const next = await send(tabId, { type: "TEST_NEXT_VIDEO_NAVIGATION" });
    if (!next?.ok) {
      if (await openLoadedVideo(tabId, recoveryId)) return;
      throw new Error(`${next?.error || "Next falló"}. Quedaron ${pending} videos pendientes.`);
    }
    await sleep(TikTokCleanerConfig.MIN_DELAY + Math.random() * (TikTokCleanerConfig.MAX_DELAY - TikTokCleanerConfig.MIN_DELAY));
  }

  async function process(tabId) {
    if (running) return;
    running = true;
    try {
      let state = await get();
      state.state = "RUNNING";
      state.tabId = tabId;
      state.startedAt ||= new Date().toISOString();
      await save(state);

      while (true) {
        state = await get();
        if (state.state !== "RUNNING") break;

        const targetSet = new Set(state.targetVideoIds);
        const pending = state.targetVideoIds.length - state.stats.processed - state.stats.failed;
        if (pending <= 0) {
          state.state = "COMPLETED";
          state.currentVideoId = null;
          state.stats.queued = 0;
          await chrome.storage.local.set({ batchAuthorization: null });
          await save(state);
          break;
        }

        const health = await send(tabId, { type: "CONTENT_HEALTH_CHECK" });
        if (health?.blockedReason) throw new Error(health.blockedReason);
        let videoId = health?.url?.match(MEDIA_PATH_PATTERN)?.[1];
        if (!videoId) {
          const recoveryId = findPendingId(state);
          if (!recoveryId) throw new Error("No quedan videos cargados disponibles para continuar.");
          if (!await openLoadedVideo(tabId, recoveryId)) throw new Error("No se pudo reabrir automáticamente el siguiente video cargado.");
          videoId = recoveryId;
        }
        if (state.visitedVideoIds.includes(videoId)) {
          throw new Error(`La secuencia volvió al video ${videoId}. Quedaron ${pending} videos pendientes; no se repetirá ningún clic.`);
        }
        state.visitedVideoIds.push(videoId);

        if (!targetSet.has(videoId)) {
          state.stats.skipped += 1;
          await save(state);
          await navigateNext(tabId, pending, findPendingId(state));
          continue;
        }

        const item = { videoId, url: health.url, status: "processing", attempts: 1, error: null, failedAtState: null };
        state.queue.push(item);
        state.currentVideoId = videoId;
        await save(state);

        try {
          let response;
          while (item.attempts <= SAFE_ATTEMPTS) {
            if (state.mode === "remove") {
              const { batchAuthorization } = await chrome.storage.local.get("batchAuthorization");
              if (
                batchAuthorization?.authorized !== true ||
                batchAuthorization?.targetCount !== state.targetVideoIds.length ||
                batchAuthorization.expiresAt <= Date.now()
              ) throw new Error("La autorización del lote no coincide o caducó.");
              await chrome.storage.local.set({
                runtimeSettings: { dryRun: false },
                removalAuthorization: { videoId, confirmation: "ELIMINAR", expiresAt: Date.now() + 120000 }
              });
            }

            response = await send(tabId, {
              type: state.mode === "remove" ? "RUN_SINGLE_VIDEO_REMOVAL" : "RUN_SINGLE_VIDEO_DRY_RUN"
            });
            if (response?.ok) break;

            item.failedAtState = response?.error?.failedAtState || null;
            const canRetrySafely = SAFE_RETRY_STATES.has(item.failedAtState) && item.attempts < SAFE_ATTEMPTS;
            if (!canRetrySafely) {
              const operationError = new Error(response?.error?.message || "Operación fallida");
              operationError.code = response?.error?.code;
              operationError.failedAtState = item.failedAtState;
              throw operationError;
            }
            item.attempts += 1;
            state.stats.retries += 1;
            await sleep(TikTokCleanerConfig.MAX_DELAY);
          }

          item.status = "completed";
          state.stats.processed += 1;
          if (state.mode === "remove") state.stats.removed += 1;
          state.lastError = null;
        } catch (error) {
          item.error = error.message;
          item.failedAtState = error.failedAtState || item.failedAtState;
          if (SAFE_RETRY_STATES.has(item.failedAtState) || POST_CLICK_STATES.has(item.failedAtState)) {
            item.status = POST_CLICK_STATES.has(item.failedAtState) ? "uncertain" : "skipped";
            state.stats.processed += 1;
            state.stats.skipped += 1;
            state.lastError = POST_CLICK_STATES.has(item.failedAtState)
              ? `El video ${videoId} pudo eliminarse, pero la verificación no fue concluyente. No se repetirá el clic.`
              : `Se omitió el video ${videoId} después de ${item.attempts} intentos seguros.`;
          } else {
            item.status = "failed";
            state.stats.failed += 1;
            state.state = "BLOCKED";
            state.lastError = error.message;
          }
        }

        state.stats.queued = Math.max(0, state.targetVideoIds.length - state.stats.processed - state.stats.failed);
        state.currentVideoId = null;
        const controlState = (await get()).state;
        if (["PAUSED", "STOPPED"].includes(controlState)) state.state = controlState;
        await save(state);

        if (state.state !== "RUNNING") break;
        if (state.stats.processed + state.stats.failed >= state.targetVideoIds.length) continue;
        await navigateNext(tabId, state.stats.queued, findPendingId(state));
      }
    } catch (error) {
      const state = await get();
      state.state = "BLOCKED";
      state.lastError = error.message;
      state.currentVideoId = null;
      await chrome.storage.local.set({ batchAuthorization: null });
      await save(state);
    } finally {
      running = false;
    }
  }

  async function resume(tabId) {
    const state = await get();
    if (["QUEUED", "PAUSED", "RUNNING"].includes(state.state)) {
      state.state = "RUNNING";
      await save(state);
      process(tabId);
    }
    return get();
  }

  globalThis.TikTokQueueManager = Object.freeze({ get, initialize, process, resume, setControl });
})();
