(() => {
  "use strict";

  const config = Object.freeze({
    BATCH_ENABLED: true,
    BATCH_REAL_ENABLED: true,
    DRY_RUN: true,
    LOG_LEVEL: "DEBUG",
    MIN_DELAY: 1500,
    MAX_DELAY: 4000,
    PAUSE_EVERY: 100,
    PAUSE_DURATION: 60000,
    MAX_RETRIES: 3,
    TIMEOUT_ELEMENT: 10000
  });

  globalThis.TikTokCleanerConfig = config;
})();
