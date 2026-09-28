/* global TikTokCleanerConfig */
"use strict";

importScripts("config.js", "safe-queue-manager.js");

const LOG_PREFIX = "[TikTok Repost Cleaner]";

function log(level, message, details) {
  const method = level === "ERROR" ? "error" : level === "WARN" ? "warn" : "log";
  console[method](`${LOG_PREFIX} [${level}] ${message}`, details ?? "");
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  log("INFO", `Extensión lista (${reason}).`, {
    dryRun: TikTokCleanerConfig.DRY_RUN,
    version: chrome.runtime.getManifest().version
  });

  chrome.storage.local.get("runtimeState", ({ runtimeState }) => {
    if (runtimeState) {
      return;
    }

    chrome.storage.local.set({
      runtimeState: {
        phase: 1,
        state: "IDLE",
        updatedAt: new Date().toISOString()
      }
    });
  });

  chrome.storage.local.set({
    runtimeSettings: {
      dryRun: true,
      updatedAt: new Date().toISOString()
    },
    removalAuthorization: null,
    batchAuthorization: null,
    queueState: {
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
    }
  });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.set({
    runtimeSettings: {
      dryRun: true,
      updatedAt: new Date().toISOString()
    },
    removalAuthorization: null,
    batchAuthorization: null
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "QUEUE_GET_STATE") { globalThis.TikTokQueueManager.get().then(sendResponse); return true; }
  if (message?.type === "QUEUE_INITIALIZE") { globalThis.TikTokQueueManager.initialize(message.items, message.tabId, message.mode).then(sendResponse); return true; }
  if (message?.type === "QUEUE_START" || message?.type === "QUEUE_RESUME") { globalThis.TikTokQueueManager.resume(message.tabId).then(sendResponse); return true; }
  if (message?.type === "QUEUE_CONTROL") { globalThis.TikTokQueueManager.setControl(message.action).then(sendResponse); return true; }
  if (message?.type !== "BACKGROUND_HEALTH_CHECK") {
    return false;
  }

  log("DEBUG", "Health check recibido desde el popup.", {
    tabId: sender.tab?.id ?? null
  });

  sendResponse({
    ok: true,
    version: chrome.runtime.getManifest().version,
    dryRun: TikTokCleanerConfig.DRY_RUN
  });

  return false;
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "run-dom-diagnostic") {
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://www.tiktok.com/")) {
    log("WARN", "El atajo de diagnóstico se usó fuera de TikTok.");
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: "RUN_DOM_DIAGNOSTIC", source: "keyboard" }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      log("ERROR", "No se pudo ejecutar el diagnóstico desde el atajo.", {
        error: chrome.runtime.lastError?.message || response?.error || "Respuesta vacía"
      });
      return;
    }

    chrome.action.setBadgeBackgroundColor({ color: "#147a4b" });
    chrome.action.setBadgeText({ text: "DOM", tabId: tab.id });
    log("INFO", "Diagnóstico DOM capturado desde el atajo.", response.result.summary);
  });
});
