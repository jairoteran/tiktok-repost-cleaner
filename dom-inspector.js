(() => {
  "use strict";

  const MAX_SCANNED_ELEMENTS = 5000;
  const MAX_CANDIDATES_PER_GROUP = 50;
  const MAX_TEXT_LENGTH = 160;
  const MEDIA_PATH_PATTERN = /\/(?:video|photo)\/(\d+)/i;

  const SHARE_TERMS = [
    "share",
    "compartir",
    "partager",
    "teilen",
    "compartilhar",
    "condividi",
    "поделиться",
    "共有",
    "分享",
    "bagikan"
  ];

  const REMOVE_REPOST_TERMS = [
    "remove repost",
    "undo repost",
    "quitar repost",
    "eliminar repost",
    "deshacer repost",
    "eliminar la publicación compartida",
    "retirer le repost",
    "repost entfernen",
    "remover repost",
    "rimuovi repost",
    "удалить репост",
    "取消转发",
    "取消轉發"
  ];

  const NAVIGATION_TERMS = [
    "next video", "previous video", "next", "previous",
    "siguiente video", "video siguiente", "siguiente", "anterior",
    "próximo video", "proximo video"
  ];

  const MENU_ROLES = new Set(["menu", "menuitem", "dialog", "listbox", "option"]);

  function normalizeText(value = "") {
    return String(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase();
  }

  function truncate(value = "", limit = MAX_TEXT_LENGTH) {
    const compact = String(value).replace(/\s+/g, " ").trim();
    return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
  }

  function safePageUrl(value) {
    try {
      const parsed = new URL(value, window.location.origin);
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return "";
    }
  }

  function safeHref(element) {
    const rawHref = element.getAttribute("href");
    return rawHref ? safePageUrl(rawHref) : "";
  }

  function isVisible(element) {
    if (!(element instanceof Element) || element.getClientRects().length === 0) {
      return false;
    }

    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function collectSemanticAttributes(element) {
    const attributes = {};

    for (const attribute of element.attributes) {
      const name = attribute.name.toLowerCase();
      if (
        name === "role" ||
        name === "aria-label" ||
        name === "aria-labelledby" ||
        name === "title" ||
        name === "name" ||
        name.startsWith("data-")
      ) {
        attributes[name] = truncate(attribute.value, 120);
      }

      if (Object.keys(attributes).length >= 12) {
        break;
      }
    }

    return attributes;
  }

  function describeElement(element) {
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role") || "",
      ariaLabel: truncate(element.getAttribute("aria-label") || ""),
      title: truncate(element.getAttribute("title") || ""),
      text: truncate(element.innerText || element.textContent || ""),
      href: safeHref(element),
      visible: isVisible(element),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      attributes: collectSemanticAttributes(element)
    };
  }

  function semanticText(element) {
    return normalizeText([
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("name"),
      truncate(element.innerText || "", 500),
      truncate(element.textContent || "", 500),
      ...Array.from(element.attributes)
        .filter((attribute) => attribute.name.startsWith("data-"))
        .map((attribute) => `${attribute.name} ${truncate(attribute.value, 200)}`)
    ].filter(Boolean).join(" "));
  }

  function findMatchedTerms(text, terms) {
    return terms.filter((term) => text.includes(normalizeText(term)));
  }

  function addCandidate(target, element, matchedTerms = []) {
    if (target.length >= MAX_CANDIDATES_PER_GROUP) {
      return;
    }

    target.push({
      ...describeElement(element),
      matchedTerms
    });
  }

  function inspectDom() {
    const startedAt = performance.now();
    const videoLinks = [];
    const seenVideoIds = new Set();

    for (const anchor of document.querySelectorAll("a[href]")) {
      const href = safeHref(anchor);
      const match = href.match(MEDIA_PATH_PATTERN);
      if (!match || seenVideoIds.has(match[1])) {
        continue;
      }

      seenVideoIds.add(match[1]);
      if (videoLinks.length < MAX_CANDIDATES_PER_GROUP) {
        videoLinks.push({
          videoId: match[1],
          url: href,
          evidence: describeElement(anchor)
        });
      }
    }

    const shareCandidates = [];
    const removeRepostCandidates = [];
    const menuCandidates = [];
    const navigationCandidates = [];
    const interactiveElements = document.querySelectorAll(
      "button, [role], [aria-label], [title], [data-e2e], [data-testid]"
    );
    const scanLimit = Math.min(interactiveElements.length, MAX_SCANNED_ELEMENTS);

    for (let index = 0; index < scanLimit; index += 1) {
      const element = interactiveElements[index];
      if (!isVisible(element)) {
        continue;
      }

      const text = semanticText(element);
      const shareMatches = findMatchedTerms(text, SHARE_TERMS);
      const removeMatches = findMatchedTerms(text, REMOVE_REPOST_TERMS);
      const navigationMatches = findMatchedTerms(text, NAVIGATION_TERMS);
      const role = normalizeText(element.getAttribute("role"));

      if (shareMatches.length > 0) {
        addCandidate(shareCandidates, element, shareMatches);
      }

      if (removeMatches.length > 0) {
        addCandidate(removeRepostCandidates, element, removeMatches);
      }

      if (navigationMatches.length > 0 && (element.tagName === "BUTTON" || role === "button")) {
        addCandidate(navigationCandidates, element, navigationMatches);
      }

      if (MENU_ROLES.has(role)) {
        addCandidate(menuCandidates, element, [role]);
      }
    }

    const result = {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      page: {
        url: safePageUrl(window.location.href),
        title: truncate(document.title),
        language: document.documentElement.lang || "",
        readyState: document.readyState
      },
      limits: {
        maxScannedElements: MAX_SCANNED_ELEMENTS,
        maxCandidatesPerGroup: MAX_CANDIDATES_PER_GROUP,
        interactiveElementsFound: interactiveElements.length,
        scanWasTruncated: interactiveElements.length > MAX_SCANNED_ELEMENTS
      },
      summary: {
        uniqueVideoIdsFound: seenVideoIds.size,
        videoLinksReported: videoLinks.length,
        videoElementsVisible: Array.from(document.querySelectorAll("video")).filter(isVisible).length,
        shareCandidates: shareCandidates.length,
        removeRepostCandidates: removeRepostCandidates.length,
        menuCandidates: menuCandidates.length,
        navigationCandidates: navigationCandidates.length
      },
      candidates: {
        videoLinks,
        share: shareCandidates,
        removeRepost: removeRepostCandidates,
        menus: menuCandidates,
        navigation: navigationCandidates
      },
      notes: [
        "Las coincidencias son hallazgos semánticos observados, no selectores confirmados.",
        "Las URLs se guardan sin query string ni fragmento.",
        "No se hizo clic ni se modificó el DOM de TikTok."
      ],
      durationMs: Math.round(performance.now() - startedAt)
    };

    return result;
  }

  globalThis.TikTokDomInspector = Object.freeze({ inspectDom });
})();
