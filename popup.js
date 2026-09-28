(() => {
  "use strict";

  const elements = {
    statusIndicator: document.querySelector("#status-indicator"),
    statusLabel: document.querySelector("#status-label"),
    statusMessage: document.querySelector("#status-message"),
    openButton: document.querySelector("#open-button"),
    queueState: document.querySelector("#queue-state"),
    queueFound: document.querySelector("#queue-found"),
    queuePending: document.querySelector("#queue-pending"),
    queueProcessed: document.querySelector("#queue-processed"),
    queueRemoved: document.querySelector("#queue-removed"),
    queueFailed: document.querySelector("#queue-failed"),
    queueCurrent: document.querySelector("#queue-current"),
    queueMessage: document.querySelector("#queue-message"),
    queueScan: document.querySelector("#queue-scan"),
    queueStart: document.querySelector("#queue-start"),
    queueToggle: document.querySelector("#queue-toggle"),
    queueStop: document.querySelector("#queue-stop")
  };

  let activeTikTokTabId = null;
  let currentQueueState = null;
  const STATE_LABELS = Object.freeze({
    IDLE: "Listo",
    QUEUED: "Preparado",
    RUNNING: "En curso",
    PAUSED: "Pausado",
    COMPLETED: "Completado",
    BLOCKED: "Bloqueado",
    STOPPED: "Detenido"
  });

  const sendRuntimeMessage = (message) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });

  const sendTabMessage = (tabId, message) => new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });

  function isTikTokUrl(url = "") {
    try { return new URL(url).origin === "https://www.tiktok.com"; }
    catch { return false; }
  }

  function showMessage(text, result = "error") {
    elements.queueMessage.hidden = !text;
    elements.queueMessage.dataset.result = result;
    elements.queueMessage.textContent = text || "";
  }

  function setConnection(ready, message) {
    elements.statusIndicator.dataset.state = ready ? "ready" : "warning";
    elements.statusLabel.textContent = ready ? "Listo" : "Sin conexión";
    elements.statusMessage.textContent = message;
    elements.openButton.hidden = ready;
    elements.queueScan.disabled = !ready || currentQueueState?.state === "RUNNING";
    elements.queueStart.disabled = !ready || currentQueueState?.state !== "QUEUED";
  }

  function renderQueue(state) {
    if (!state) return;
    currentQueueState = state;
    const stats = state.stats || {};
    elements.queueState.textContent = STATE_LABELS[state.state] || state.state;
    elements.queueFound.textContent = stats.found ?? 0;
    elements.queuePending.textContent = stats.queued ?? 0;
    elements.queueProcessed.textContent = stats.processed ?? 0;
    elements.queueRemoved.textContent = stats.removed ?? 0;
    elements.queueFailed.textContent = stats.failed ?? 0;
    elements.queueCurrent.textContent = state.currentVideoId
      ? `Procesando ${state.currentVideoId}`
      : state.state === "QUEUED" ? `${stats.found} videos preparados.` : "Sin video en proceso.";

    const running = state.state === "RUNNING";
    const paused = state.state === "PAUSED";
    elements.queueScan.disabled = !activeTikTokTabId || running;
    elements.queueStart.disabled = !activeTikTokTabId || state.state !== "QUEUED";
    elements.queueToggle.disabled = !running && !paused;
    elements.queueToggle.textContent = paused ? "Continuar" : "Pausar";
    elements.queueStop.disabled = !running && !paused;
    if (state.lastError) showMessage(state.lastError, "error");
  }

  async function refreshConnection() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !isTikTokUrl(tab.url)) {
      activeTikTokTabId = null;
      setConnection(false, "Abre TikTok para comenzar.");
      return;
    }
    try {
      const health = await sendTabMessage(tab.id, { type: "CONTENT_HEALTH_CHECK" });
      if (!health?.ok || health.blockedReason) throw new Error(health?.blockedReason || "TikTok no respondió.");
      activeTikTokTabId = tab.id;
      setConnection(true, "TikTok conectado");
    } catch (error) {
      activeTikTokTabId = null;
      setConnection(false, error.message);
    }
  }

  async function detectLoaded() {
    if (!activeTikTokTabId) return;
    showMessage("");
    const response = await sendTabMessage(activeTikTokTabId, { type: "DISCOVER_VIDEO_BATCH" });
    const state = await sendRuntimeMessage({
      type: "QUEUE_INITIALIZE",
      items: response?.items || [],
      tabId: activeTikTokTabId,
      mode: "remove"
    });
    renderQueue(state);
    if (state.stats?.found) showMessage(`${state.stats.found} videos cargados quedaron fijados para este lote.`, "success");
  }

  async function startQueue() {
    if (!activeTikTokTabId) return;
    const state = await sendRuntimeMessage({ type: "QUEUE_GET_STATE" });
    if (!state?.stats?.found || state.state !== "QUEUED") {
      showMessage("Primero pulsa Detectar.");
      return;
    }
    if (state.mode !== "remove") {
      showMessage("Pulsa Detectar otra vez para preparar el lote.");
      return;
    }
    await chrome.storage.local.set({
      batchAuthorization: {
        authorized: true,
        targetCount: state.stats.found,
        expiresAt: Date.now() + 60 * 60 * 1000
      }
    });
    showMessage("");
    renderQueue(await sendRuntimeMessage({ type: "QUEUE_START", tabId: activeTikTokTabId }));
  }

  async function toggleQueue() {
    if (!activeTikTokTabId || !currentQueueState) return;
    if (currentQueueState.state === "PAUSED") {
      renderQueue(await sendRuntimeMessage({ type: "QUEUE_RESUME", tabId: activeTikTokTabId }));
    } else if (currentQueueState.state === "RUNNING") {
      renderQueue(await sendRuntimeMessage({ type: "QUEUE_CONTROL", action: "pause" }));
    }
  }

  elements.queueScan.addEventListener("click", () => detectLoaded().catch((error) => showMessage(error.message)));
  elements.queueStart.addEventListener("click", () => startQueue().catch((error) => showMessage(error.message)));
  elements.queueToggle.addEventListener("click", () => toggleQueue().catch((error) => showMessage(error.message)));
  elements.queueStop.addEventListener("click", () => sendRuntimeMessage({ type: "QUEUE_CONTROL", action: "stop" }).then(renderQueue).catch((error) => showMessage(error.message)));
  elements.openButton.addEventListener("click", () => chrome.tabs.create({ url: "https://www.tiktok.com/" }));

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "QUEUE_STATE_UPDATE") renderQueue(message.state);
  });

  Promise.all([refreshConnection(), sendRuntimeMessage({ type: "QUEUE_GET_STATE" }).then(renderQueue)])
    .catch((error) => showMessage(error.message));
})();
