const STORAGE_DEFAULTS = {
  customDisplayName: "",
  customProfilePhotoUrl: ""
};

const MISSING_VALUE = "__AUTOCHAT_MISSING__";
let currentSettings = { ...STORAGE_DEFAULTS };
let mutationObserver = null;
let applyTimerId = null;
let isApplying = false;

function hasStoredValue(element, datasetKey) {
  return Object.prototype.hasOwnProperty.call(element.dataset, datasetKey);
}

function encodeStoredValue(value) {
  return value == null ? MISSING_VALUE : value;
}

function decodeStoredValue(value) {
  return value === MISSING_VALUE ? null : value;
}

function peekOriginalValue(element, datasetKey, currentValue) {
  if (hasStoredValue(element, datasetKey)) {
    return decodeStoredValue(element.dataset[datasetKey]);
  }

  return currentValue;
}

function getOriginalValue(element, datasetKey, currentValue) {
  if (!hasStoredValue(element, datasetKey)) {
    element.dataset[datasetKey] = encodeStoredValue(currentValue);
  }

  return decodeStoredValue(element.dataset[datasetKey]);
}

function restoreText(element, datasetKey) {
  if (!hasStoredValue(element, datasetKey)) {
    return;
  }

  const original = decodeStoredValue(element.dataset[datasetKey]);
  element.textContent = original == null ? "" : original;
}

function restoreAttribute(element, attributeName, datasetKey) {
  if (!hasStoredValue(element, datasetKey)) {
    return;
  }

  const original = decodeStoredValue(element.dataset[datasetKey]);
  if (original == null) {
    element.removeAttribute(attributeName);
  } else {
    element.setAttribute(attributeName, original);
  }
}

function getShortName(name) {
  return (name || "").trim().split(/\s+/)[0] || "";
}

function extractNameFromLabel(value, prefix) {
  if (!value || !value.startsWith(prefix)) {
    return "";
  }

  return value.slice(prefix.length).trim();
}

function extractOriginalConversationName() {
  const storedAriaElements = document.querySelectorAll(
    "[data-autochat-original-aria-label]"
  );

  for (const element of storedAriaElements) {
    const originalAriaLabel = decodeStoredValue(
      element.dataset.autochatOriginalAriaLabel
    );
    const conversationName = extractNameFromLabel(
      originalAriaLabel,
      "Conversation with "
    );
    if (conversationName) {
      return conversationName;
    }

    const messageListName = extractNameFromLabel(
      originalAriaLabel,
      "Messages in conversation with "
    );
    if (messageListName) {
      return messageListName;
    }
  }

  const currentConversationElement = document.querySelector(
    '[aria-label^="Conversation with "]'
  );
  if (currentConversationElement) {
    return extractNameFromLabel(
      currentConversationElement.getAttribute("aria-label"),
      "Conversation with "
    );
  }

  const currentMessageList = document.querySelector(
    '[aria-label^="Messages in conversation with "]'
  );
  if (currentMessageList) {
    return extractNameFromLabel(
      currentMessageList.getAttribute("aria-label"),
      "Messages in conversation with "
    );
  }

  const headingCandidates = document.querySelectorAll("h2 a[href], h2 span");
  for (const element of headingCandidates) {
    const text = element.textContent.trim();
    if (text) {
      return text;
    }
  }

  return "";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildNameContext() {
  const originalFullName = extractOriginalConversationName();
  const nextFullName = (currentSettings.customDisplayName || "").trim();

  if (!originalFullName || !nextFullName) {
    return null;
  }

  return {
    originalFullName,
    originalShortName: getShortName(originalFullName),
    nextFullName,
    nextShortName: getShortName(nextFullName)
  };
}

function isNameCandidateString(value, context) {
  if (!value) {
    return false;
  }

  const trimmed = value.trim();
  return (
    trimmed === context.originalFullName ||
    trimmed === context.originalShortName ||
    value.includes(`Conversation with ${context.originalFullName}`) ||
    value.includes(`Messages in conversation with ${context.originalFullName}`) ||
    value.includes(`Write to ${context.originalFullName}`) ||
    value.includes(`Seen by ${context.originalFullName}`) ||
    value.includes(`${context.originalFullName} sent`) ||
    value.includes(`by ${context.originalFullName}`) ||
    value.includes(`${context.originalShortName} sent`) ||
    value.includes(`by ${context.originalShortName}`)
  );
}

function replaceNameInString(value, context) {
  let nextValue = value;

  if (nextValue.includes(context.originalFullName)) {
    nextValue = nextValue.split(context.originalFullName).join(context.nextFullName);
  }

  if (
    context.originalShortName &&
    context.nextShortName &&
    context.originalShortName !== context.originalFullName
  ) {
    const exactShortNamePattern = new RegExp(
      `^\\s*${escapeRegExp(context.originalShortName)}\\s*$`
    );

    if (exactShortNamePattern.test(nextValue)) {
      nextValue = nextValue.replace(
        context.originalShortName,
        context.nextShortName
      );
    }

    nextValue = nextValue.replace(
      new RegExp(`\\b${escapeRegExp(context.originalShortName)}(?= sent\\b)`, "g"),
      context.nextShortName
    );
    nextValue = nextValue.replace(
      new RegExp(`\\bby ${escapeRegExp(context.originalShortName)}\\b`, "g"),
      `by ${context.nextShortName}`
    );
  }

  return nextValue;
}

function applyNameOverrides(context) {
  const textCandidates = document.querySelectorAll("h1, h2, h3, h4, h5, h6, a, span, div");
  for (const element of textCandidates) {
    if (element.closest('[contenteditable="true"]')) {
      continue;
    }

    if (element.childElementCount > 0) {
      continue;
    }

    const originalText = peekOriginalValue(
      element,
      "autochatOriginalText",
      element.textContent
    );

    if (!isNameCandidateString(originalText, context)) {
      continue;
    }

    getOriginalValue(element, "autochatOriginalText", element.textContent);
    const nextText = replaceNameInString(originalText, context);
    if (element.textContent !== nextText) {
      element.textContent = nextText;
    }
  }

  const attributeConfigs = [
    { selector: "[aria-label]", attributeName: "aria-label", datasetKey: "autochatOriginalAriaLabel" },
    { selector: "[aria-placeholder]", attributeName: "aria-placeholder", datasetKey: "autochatOriginalAriaPlaceholder" },
    { selector: "[title]", attributeName: "title", datasetKey: "autochatOriginalTitle" },
    { selector: "img[alt]", attributeName: "alt", datasetKey: "autochatOriginalAlt" }
  ];

  for (const config of attributeConfigs) {
    const elements = document.querySelectorAll(config.selector);
    for (const element of elements) {
      const originalValue = peekOriginalValue(
        element,
        config.datasetKey,
        element.getAttribute(config.attributeName)
      );

      if (!isNameCandidateString(originalValue, context)) {
        continue;
      }

      getOriginalValue(
        element,
        config.datasetKey,
        element.getAttribute(config.attributeName)
      );
      const nextValue = replaceNameInString(originalValue, context);
      if (element.getAttribute(config.attributeName) !== nextValue) {
        element.setAttribute(config.attributeName, nextValue);
      }
    }
  }
}

function findDominantProfilePhotoSource(originalFullName) {
  const images = Array.from(document.querySelectorAll("img[src]"));
  const preferredCounts = new Map();

  for (const image of images) {
    const originalAlt = peekOriginalValue(
      image,
      "autochatOriginalAlt",
      image.getAttribute("alt")
    );
    const originalSrc = peekOriginalValue(
      image,
      "autochatOriginalSrc",
      image.getAttribute("src")
    );

    if (!originalSrc) {
      continue;
    }

    if (
      originalAlt &&
      originalFullName &&
      (originalAlt.includes(originalFullName) ||
        originalAlt.startsWith(`Seen by ${originalFullName}`))
    ) {
      preferredCounts.set(originalSrc, (preferredCounts.get(originalSrc) || 0) + 1);
    }
  }

  let selectedSource = "";
  let selectedCount = 0;

  for (const [source, count] of preferredCounts.entries()) {
    if (count > selectedCount) {
      selectedSource = source;
      selectedCount = count;
    }
  }

  if (selectedSource) {
    return selectedSource;
  }

  const fallbackCounts = new Map();
  for (const image of images) {
    const originalSrc = peekOriginalValue(
      image,
      "autochatOriginalSrc",
      image.getAttribute("src")
    );

    if (
      !originalSrc ||
      originalSrc.startsWith("chrome-extension://") ||
      originalSrc.startsWith("data:image/svg")
    ) {
      continue;
    }

    fallbackCounts.set(originalSrc, (fallbackCounts.get(originalSrc) || 0) + 1);
  }

  for (const [source, count] of fallbackCounts.entries()) {
    if (count > selectedCount) {
      selectedSource = source;
      selectedCount = count;
    }
  }

  return selectedCount >= 2 ? selectedSource : "";
}

function applyPhotoOverrides(originalFullName) {
  const customProfilePhotoUrl = (currentSettings.customProfilePhotoUrl || "").trim();
  if (!customProfilePhotoUrl) {
    return;
  }

  const dominantSource = findDominantProfilePhotoSource(originalFullName);
  if (!dominantSource) {
    return;
  }

  const images = document.querySelectorAll("img[src]");
  for (const image of images) {
    const originalSrc = peekOriginalValue(
      image,
      "autochatOriginalSrc",
      image.getAttribute("src")
    );
    const originalAlt = peekOriginalValue(
      image,
      "autochatOriginalAlt",
      image.getAttribute("alt")
    );

    const matchesSource = originalSrc === dominantSource;
    const matchesAlt =
      !!originalAlt &&
      !!originalFullName &&
      (originalAlt.includes(originalFullName) ||
        originalAlt.startsWith(`Seen by ${originalFullName}`));

    if (!matchesSource && !matchesAlt) {
      continue;
    }

    getOriginalValue(image, "autochatOriginalSrc", image.getAttribute("src"));
    image.setAttribute("src", customProfilePhotoUrl);
  }
}

function restoreNameOverrides() {
  const textElements = document.querySelectorAll("[data-autochat-original-text]");
  for (const element of textElements) {
    restoreText(element, "autochatOriginalText");
  }

  const attributeConfigs = [
    { selector: "[data-autochat-original-aria-label]", attributeName: "aria-label", datasetKey: "autochatOriginalAriaLabel" },
    { selector: "[data-autochat-original-aria-placeholder]", attributeName: "aria-placeholder", datasetKey: "autochatOriginalAriaPlaceholder" },
    { selector: "[data-autochat-original-title]", attributeName: "title", datasetKey: "autochatOriginalTitle" },
    { selector: "img[data-autochat-original-alt]", attributeName: "alt", datasetKey: "autochatOriginalAlt" }
  ];

  for (const config of attributeConfigs) {
    const elements = document.querySelectorAll(config.selector);
    for (const element of elements) {
      restoreAttribute(element, config.attributeName, config.datasetKey);
    }
  }
}

function restorePhotoOverrides() {
  const images = document.querySelectorAll("img[data-autochat-original-src]");
  for (const image of images) {
    restoreAttribute(image, "src", "autochatOriginalSrc");
  }
}

function applyConversationAppearance() {
  const hasCustomName = !!(currentSettings.customDisplayName || "").trim();
  const hasCustomPhoto = !!(currentSettings.customProfilePhotoUrl || "").trim();

  if (!hasCustomName) {
    restoreNameOverrides();
  }

  if (!hasCustomPhoto) {
    restorePhotoOverrides();
  }

  if (!hasCustomName && !hasCustomPhoto) {
    return;
  }

  const nameContext = buildNameContext();

  if (hasCustomName && nameContext) {
    applyNameOverrides(nameContext);
  }

  applyPhotoOverrides(nameContext ? nameContext.originalFullName : "");
}

function scheduleApply(delayMs = 30) {
  if (applyTimerId !== null) {
    clearTimeout(applyTimerId);
  }

  applyTimerId = setTimeout(() => {
    applyTimerId = null;

    if (isApplying) {
      scheduleApply(30);
      return;
    }

    isApplying = true;
    try {
      applyConversationAppearance();
    } finally {
      isApplying = false;
    }
  }, delayMs);
}

function startObserver() {
  if (mutationObserver) {
    return;
  }

  mutationObserver = new MutationObserver(() => {
    scheduleApply(30);
  });

  mutationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-label", "alt", "src"]
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes.customDisplayName) {
    currentSettings.customDisplayName = changes.customDisplayName.newValue || "";
  }

  if (changes.customProfilePhotoUrl) {
    currentSettings.customProfilePhotoUrl =
      changes.customProfilePhotoUrl.newValue || "";
  }

  if (changes.customDisplayName || changes.customProfilePhotoUrl) {
    scheduleApply(0);
  }
});

async function initializeContentScript() {
  currentSettings = await chrome.storage.local.get(STORAGE_DEFAULTS);
  startObserver();
  scheduleApply(0);
}

initializeContentScript().catch(() => {
  // Ignore load-time failures and allow the script to retry on later mutations.
});
