/* global TikTokCleanerConfig */
(() => {
  "use strict";

  const LOG_PREFIX = "[TikTok Repost Cleaner]";
  const MEDIA_PATH_PATTERN = /\/(?:video|photo)\/(\d+)/i;
  let currentUrl = window.location.href;

  function log(level, message, details) {
    const method = level === "ERROR" ? "error" : level === "WARN" ? "warn" : "log";
    console[method](`${LOG_PREFIX} [${level}] ${message}`, details ?? "");
  }

  function reportRouteIfChanged() {
    if (window.location.href === currentUrl) {
      return;
    }

    const previousUrl = currentUrl;
    currentUrl = window.location.href;
    log("INFO", "Navegación interna de TikTok detectada.", {
      from: previousUrl,
      to: currentUrl
    });
  }

  const routeObserver = new MutationObserver(reportRouteIfChanged);
  routeObserver.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  window.addEventListener("popstate", reportRouteIfChanged);
  window.addEventListener("hashchange", reportRouteIfChanged);

  function createOperationError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function publishSingleRunProgress(progress) {
    const label = progress.mode === "remove" ? "Eliminación individual" : "Dry Run";
    log("DEBUG", `Estado ${label}: ${progress.state}`, progress.details);
    chrome.storage.local.set({ singleRunState: progress }).catch(() => {});
    chrome.runtime.sendMessage({ type: "SINGLE_RUN_PROGRESS", progress }).catch(() => {});
  }

  async function persistSingleRun(result) {
    await chrome.storage.local.set({
      latestSingleRun: result,
      singleRunState: result.history.at(-1)
    });
  }

  async function runDryRun() {
    const result = await globalThis.TikTokSingleVideoRunner.runner.run({
      mode: globalThis.TikTokSingleVideoRunner.MODES.DRY_RUN,
      onProgress: publishSingleRunProgress
    });
    await persistSingleRun(result);
    return result;
  }

  async function runAuthorizedRemoval() {
    try {
      const { runtimeSettings, removalAuthorization } = await chrome.storage.local.get([
        "runtimeSettings",
        "removalAuthorization"
      ]);
      const currentVideoId = window.location.pathname.match(MEDIA_PATH_PATTERN)?.[1] || null;
      const authorizationIsValid =
        runtimeSettings?.dryRun === false &&
        removalAuthorization?.videoId === currentVideoId &&
        removalAuthorization?.confirmation === "ELIMINAR" &&
        Number(removalAuthorization?.expiresAt) > Date.now();

      if (!authorizationIsValid) {
        throw createOperationError(
          "REMOVAL_NOT_AUTHORIZED",
          "La autorización expiró, no corresponde al video actual o Dry Run sigue activado."
        );
      }

      await chrome.storage.local.set({ removalAuthorization: null });

      const result = await globalThis.TikTokSingleVideoRunner.runner.run({
        mode: globalThis.TikTokSingleVideoRunner.MODES.REMOVE,
        allowRemoval: true,
        onProgress: publishSingleRunProgress
      });
      await persistSingleRun(result);
      return result;
    } finally {
      await chrome.storage.local.set({
        runtimeSettings: {
          dryRun: true,
          updatedAt: new Date().toISOString()
        },
        removalAuthorization: null
      });
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "CONTENT_HEALTH_CHECK") {
      const pageText = document.body?.innerText || "";
      const response = {
        ok: true,
        url: window.location.href,
        title: document.title,
        readyState: document.readyState,
        dryRun: TikTokCleanerConfig.DRY_RUN,
        timestamp: new Date().toISOString(),
        blockedReason: /HTTP ERROR 403|Se denegó el acceso/i.test(pageText) ? "HTTP_403" : null
      };

      log("DEBUG", "Health check recibido desde el popup.", response);
      sendResponse(response);
      return false;
    }

    if (message?.type === "RUN_DOM_DIAGNOSTIC") {
      try {
        const result = globalThis.TikTokDomInspector.inspectDom();
        chrome.storage.local.set({ latestDomDiagnostic: result }).then(() => {
          log("INFO", "Diagnóstico semántico del DOM completado.", {
            source: message.source || "unknown",
            ...result.summary,
            durationMs: result.durationMs
          });
          sendResponse({ ok: true, result });
        }).catch((error) => {
          log("ERROR", "No se pudo guardar el diagnóstico DOM.", error);
          sendResponse({ ok: false, error: error.message });
        });
      } catch (error) {
        log("ERROR", "Falló el diagnóstico semántico del DOM.", error);
        sendResponse({ ok: false, error: error.message });
      }

      return true;
    }

    if (message?.type === "DISCOVER_VIDEO_BATCH") {
      const itemsById = new Map();
      const addVideo = (url) => {
        try {
          const absoluteUrl = new URL(url, window.location.origin);
          const videoId = absoluteUrl.pathname.match(MEDIA_PATH_PATTERN)?.[1];
          if (videoId && !itemsById.has(videoId)) {
            itemsById.set(videoId, { videoId, url: `${absoluteUrl.origin}${absoluteUrl.pathname}` });
          }
        } catch { /* Ignorar enlaces no válidos. */ }
      };

      addVideo(window.location.href);
      document.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]').forEach((anchor) => addVideo(anchor.href));
      sendResponse({ ok: true, items: Array.from(itemsById.values()) });
      return false;
    }

    if (message?.type === "TEST_NEXT_VIDEO_NAVIGATION") {
      const beforeUrl = window.location.href;
      const beforeVideoId = window.location.pathname.match(MEDIA_PATH_PATTERN)?.[1] || null;
      const button = Array.from(document.querySelectorAll('button[aria-label="Next video"]'))
        .find((element) => element.getClientRects().length > 0);
      if (!button) { sendResponse({ ok: false, error: "No se encontró el botón Next video visible." }); return false; }
      log("DEBUG", "Clic en Next video confirmado.", { beforeUrl, beforeVideoId });
      button.click();
      const started = Date.now();
      const timer = window.setInterval(() => {
        const pageText = document.body?.innerText || "";
        if (/HTTP ERROR 403|Se denegó el acceso/i.test(pageText)) {
          window.clearInterval(timer); sendResponse({ ok: false, error: "HTTP_403" }); return;
        }
        const nextVideoId = window.location.pathname.match(MEDIA_PATH_PATTERN)?.[1] || null;
        if (nextVideoId && nextVideoId !== beforeVideoId) {
          log("INFO", "Next abrió un nuevo video.", { beforeVideoId, nextVideoId, url: window.location.href });
          window.clearInterval(timer); sendResponse({ ok: true, beforeUrl, afterUrl: window.location.href, videoId: nextVideoId }); return;
        }
        if (Date.now() - started > 15000) {
          window.clearInterval(timer); sendResponse({ ok: false, error: "La ruta no cambió en 15 segundos." });
        }
      }, 300);
      return true;
    }

    if (message?.type === "OPEN_LOADED_VIDEO") {
      const targetId = String(message.videoId || "");
      const anchor = Array.from(document.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]'))
        .find((element) => element.href.match(MEDIA_PATH_PATTERN)?.[1] === targetId);
      if (!anchor) {
        sendResponse({ ok: false, error: "El siguiente video detectado ya no está cargado en el DOM." });
        return false;
      }
      log("WARN", "El visor estaba cerrado; se reabre un video pendiente mediante su enlace cargado.", {
        videoId: targetId,
        href: anchor.href
      });
      anchor.click();
      const started = Date.now();
      const timer = window.setInterval(() => {
        const pageText = document.body?.innerText || "";
        if (/HTTP ERROR 403|Se denegó el acceso/i.test(pageText)) {
          window.clearInterval(timer); sendResponse({ ok: false, error: "HTTP_403" }); return;
        }
        const currentId = window.location.pathname.match(MEDIA_PATH_PATTERN)?.[1];
        if (currentId === targetId) {
          window.clearInterval(timer); sendResponse({ ok: true, videoId: currentId }); return;
        }
        if (Date.now() - started > 15000) {
          window.clearInterval(timer); sendResponse({ ok: false, error: "El video detectado no se abrió en 15 segundos." });
        }
      }, 300);
      return true;
    }

    if (message?.type === "RUN_SINGLE_VIDEO_DRY_RUN") {
      runDryRun()
        .then((result) => {
          log("INFO", `[DRY RUN] Se habría eliminado el repost ${result.videoId}.`, result);
          sendResponse({ ok: true, result });
        })
        .catch((error) => {
          log("ERROR", "La prueba Dry Run individual falló.", {
            code: error.code || "UNEXPECTED_ERROR",
            message: error.message
          });
          sendResponse({
            ok: false,
            error: {
              code: error.code || "UNEXPECTED_ERROR",
              message: error.message
            }
          });
        });

      return true;
    }

    if (message?.type === "RUN_SINGLE_VIDEO_REMOVAL") {
      runAuthorizedRemoval()
        .then((result) => {
          log("INFO", `Repost ${result.videoId} eliminado y verificado.`, result);
          sendResponse({ ok: true, result });
        })
        .catch((error) => {
          log("ERROR", "La eliminación individual falló o no pudo verificarse.", {
            code: error.code || "UNEXPECTED_ERROR",
            message: error.message,
            failedAtState: error.failedAtState || null
          });
          sendResponse({
            ok: false,
            error: {
              code: error.code || "UNEXPECTED_ERROR",
              message: error.message,
              failedAtState: error.failedAtState || null
            }
          });
        });

      return true;
    }

    return false;
  });

  log("INFO", "Content script conectado a TikTok.", {
    url: currentUrl,
    dryRun: TikTokCleanerConfig.DRY_RUN
  });
})();
