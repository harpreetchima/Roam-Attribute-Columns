const GLOBAL_KEY = "__roamAttributeColumns";
const COMMAND_LABEL = "Roam Attribute Columns: Toggle horizontal attributes";
const SUMMARY_PULL_PATTERN = "[:block/uid {:block/children ...}]";
const ATTRIBUTE_PULL_PATTERN = `[:block/string
  {:harc/_a-source [:block/uid {:harc/e [:block/uid {:harc/a [:block/uid]}]}
                    {:harc/a [:block/uid :node/title :attr/proxy]}
                    {:harc/v [:block/uid]} {:harc/v-source [:block/uid]}]}]`;
const CLASS_TAG_SYNTAX = /#\[\[\.[^\]]+\]\]|#\.[^\s#[\]]+/gu;
const FALLBACK_SUMMARY = "Folded blocks";
const FOLDED_SUMMARY_BLOCK_ATTRIBUTE = "data-rc-folded-summary-block";
const TRAILING_BODY_BLOCK_ATTRIBUTE = "data-rc-trailing-body-block";
const TRAILING_BODY_PENDING_ATTRIBUTE = "data-rc-trailing-body-pending";
const RESIZER_ATTRIBUTE = "data-rc-resizer";
const INJECTED_SELECTOR =
  `[${FOLDED_SUMMARY_BLOCK_ATTRIBUTE}], [${TRAILING_BODY_BLOCK_ATTRIBUTE}], [${RESIZER_ATTRIBUTE}]`;
const EDITOR_SELECTOR = "textarea:is(.rm-block-input, .rm-block__input)";
const PANE_SELECTOR = ".roam-main, #right-sidebar";
const MAIN_ARTICLE_SELECTOR = ".roam-main .roam-body-main .roam-article";
const SIDEBAR_WINDOW_SELECTOR = "#right-sidebar .rm-sidebar-window";
const LAYOUT_PANE_SELECTOR = ".roam-article, .rm-sidebar-window, #right-sidebar";
const OUTLINE_SELECTOR = `.rm-block-children.rm-level-0, .rm-zoom-block-wrapper, .roam-log-page, ${LAYOUT_PANE_SELECTOR}`;
const MIN_PANE_WIDTH = 340;
const MIN_ROW_WIDTH = 260;
const UNSTACK_MARGIN = 6;

const SETTINGS_KEYS = {
  enabled: "enabled",
  columnWidthRatios: "columnWidthRatios",
  rowDividers: "rowDividers",
};

const DEFAULTS = {
  enabled: true,
  rowDividers: true,
};

const CLASSES = {
  enabled: "roam-attribute-columns-enabled",
  rowDividers: "roam-attribute-columns-row-dividers",
  row: "rc-attribute-row",
  closed: "rc-attribute-row--closed",
  summaryPending: "rc-attribute-row--summary-pending",
  label: "rc-attribute-label",
  values: "rc-attribute-values",
  resizing: "rc-attribute-columns-resizing",
  trailingBodyBlock: "rc-trailing-body-block",
};

const SUMMARY_ATTRIBUTES = ["data-rc-summary", "data-rc-child-count"];
const HARC_ATTRIBUTES = ["data-rc-attr-model", "data-rc-harc-uid", "data-rc-attr-role"];
const PASSTHROUGH_ATTRIBUTE = "data-rc-passthrough";
const HARC_SELECTOR = HARC_ATTRIBUTES.map((key) => `[${key}]`).join(", ");

function createRoamAttributeColumnsExtension({ extensionAPI } = {}) {
  let mutationObserver = null;
  let refreshTimeout = null;
  let paneObserver = null;
  let layoutFrame = null;
  const observedPaneWidths = new Map();
  const rowPanes = new Map();
  let commandPaletteApi = null;
  let unloaded = false;
  let pendingBodyContainer = null;
  const layoutListeners = new AbortController();
  let drag = null;
  let suppressDividerClick = false;
  let focusTimer = null;
  let finishFocusWait = null;

  let settings = {
    ...DEFAULTS,
    columnWidthRatios: {},
  };

  const summaryCache = new Map();
  const lastRenderedCounts = new Map();
  const markedBlocks = new Set();
  const trailingBlocks = new Map();
  const appliedDepths = new Set();
  const savingSettings = new Map();
  const summaryWatches = new Map();
  const pendingSummaryWatches = new Set();
  const activeClosedRowUids = new Set();

  function warn(...args) {
    console.warn("[Roam Attribute Columns]", ...args);
  }

  function normalizeText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function visibleText(element) {
    return normalizeText(element?.innerText || element?.textContent || "");
  }

  function directChildMatching(parent, selector) {
    if (!parent?.children) return null;
    return Array.from(parent.children).find((child) => child.matches?.(selector)) || null;
  }

  function directChildBlocks(childrenContainer) {
    if (!childrenContainer?.children) return [];
    return Array.from(childrenContainer.children).filter((child) =>
      child.matches?.(".roam-block-container") &&
      !child.matches(INJECTED_SELECTOR)
    );
  }

  function getBlockUid(block) {
    return block?.getAttribute?.("data-block-uid") || "";
  }

  function getKeywordValue(object, keyword) {
    if (!object) return undefined;
    const bareKeyword = keyword.replace(/^:/, "");
    return object[keyword] ?? object[bareKeyword] ?? object[bareKeyword.split("/").pop()];
  }

  function summaryTextFromCount(count) {
    return `${count} folded ${count === 1 ? "block" : "blocks"}`;
  }

  function buildSummaryFromCount(count, pending = false) {
    if (count === 0) {
      return {
        hasChildren: false,
        summary: "",
        childCount: 0,
        pending: false,
      };
    }

    return {
      hasChildren: true,
      summary: Number.isFinite(count) ? summaryTextFromCount(count) : FALLBACK_SUMMARY,
      childCount: count,
      pending,
    };
  }

  function countRenderedDescendants(childrenContainer) {
    if (!childrenContainer) return 0;

    return Array.from(childrenContainer.querySelectorAll(".roam-block-container")).filter(
      (block) => !block.closest(INJECTED_SELECTOR)
    ).length;
  }

  function countPulledDescendants(blockData) {
    const children = getKeywordValue(blockData, ":block/children");
    if (!Array.isArray(children)) return null;

    return children.reduce((total, child) => {
      const childCount = countPulledDescendants(child);
      return total + 1 + (Number.isFinite(childCount) ? childCount : 0);
    }, 0);
  }

  function buildApiRowSummary(blockData) {
    // Roam can omit :block/children entirely for an existing leaf.
    if (getKeywordValue(blockData, ":block/uid") && !getKeywordValue(blockData, ":block/children")) {
      return buildSummaryFromCount(0);
    }
    const count = countPulledDescendants(blockData);
    if (!Number.isFinite(count)) return null;
    return buildSummaryFromCount(count);
  }

  function getPullApi() {
    const dataApi = getRoamDataApi();
    if (typeof dataApi?.pull === "function") {
      return {
        api: dataApi,
        method: dataApi.pull,
      };
    }

    const alphaApi = getRoamAlphaApi();
    if (typeof alphaApi?.pull === "function") {
      return {
        api: alphaApi,
        method: alphaApi.pull,
      };
    }

    return {
      api: null,
      method: null,
    };
  }

  function pullData(pattern, entity) {
    const { api, method } = getPullApi();
    return typeof method === "function" ? method.call(api, pattern, entity) : null;
  }

  function pullClosedRowSummary(uid) {
    try {
      const blockData = pullData(SUMMARY_PULL_PATTERN, [":block/uid", uid]);
      return buildApiRowSummary(blockData);
    } catch (error) {
      warn(`Could not pull folded row summary for block ${uid}.`, error);
      return null;
    }
  }

  function pullWatchEntity(uid) {
    return `[:block/uid "${String(uid).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
  }

  function getPullWatchApi(methodName) {
    const dataApi = getRoamDataApi();
    const method = dataApi?.[methodName];
    return typeof method === "function"
      ? {
          api: dataApi,
          method,
        }
      : {
          api: null,
          method: null,
        };
  }

  function removePullWatchEntity(entity, callback) {
    const { api, method } = getPullWatchApi("removePullWatch");
    if (typeof method !== "function") return;

    try {
      const result = method.call(api, SUMMARY_PULL_PATTERN, entity, callback);
      if (result && typeof result.catch === "function") {
        result.catch((error) => warn("Could not remove folded summary pull watch.", error));
      }
    } catch (error) {
      warn("Could not remove folded summary pull watch.", error);
    }
  }

  function removeClosedRowWatch(uid) {
    activeClosedRowUids.delete(uid);

    const watch = summaryWatches.get(uid);
    if (!watch) return;

    summaryWatches.delete(uid);
    removePullWatchEntity(watch.entity, watch.callback);
  }

  function removeAllClosedRowWatches() {
    activeClosedRowUids.clear();
    summaryWatches.forEach((watch) => {
      removePullWatchEntity(watch.entity, watch.callback);
    });
    summaryWatches.clear();
  }

  async function ensureClosedRowWatch(uid) {
    if (
      !uid ||
      unloaded ||
      summaryWatches.has(uid) ||
      pendingSummaryWatches.has(uid)
    ) {
      return;
    }

    const { api, method } = getPullWatchApi("addPullWatch");
    if (typeof method !== "function") return;

    const entity = pullWatchEntity(uid);
    const callback = (_before, after) => {
      if (unloaded || !activeClosedRowUids.has(uid)) return;

      const summary = buildApiRowSummary(after);
      if (summary?.hasChildren) {
        summaryCache.set(uid, summary);
      } else {
        summaryCache.delete(uid);
      }

      scheduleRefresh();
    };

    pendingSummaryWatches.add(uid);

    try {
      const result = method.call(api, SUMMARY_PULL_PATTERN, entity, callback);
      if (result && typeof result.then === "function") await result;

      if (unloaded || !activeClosedRowUids.has(uid)) {
        removePullWatchEntity(entity, callback);
        return;
      }

      summaryWatches.set(uid, {
        entity,
        callback,
      });
    } catch (error) {
      warn(`Could not add folded summary pull watch for block ${uid}.`, error);
    } finally {
      pendingSummaryWatches.delete(uid);
    }
  }

  function fallbackClosedSummary(uid) {
    const cached = summaryCache.get(uid);
    if (cached?.hasChildren) return { ...cached, pending: false };

    return {
      hasChildren: true,
      summary: FALLBACK_SUMMARY,
      childCount: "",
      pending: true,
    };
  }

  function resolveClosedRowSummary(uid) {
    const cached = summaryCache.get(uid);
    if (cached?.hasChildren && (summaryWatches.has(uid) || pendingSummaryWatches.has(uid))) {
      return {
        ...cached,
        pending: false,
      };
    }

    const summary = pullClosedRowSummary(uid);
    if (summary) {
      if (summary.hasChildren) summaryCache.set(uid, summary);
      else summaryCache.delete(uid);
      return summary;
    }

    return fallbackClosedSummary(uid);
  }

  function getSetting(key) {
    if (savingSettings.has(key)) return savingSettings.get(key).value;
    try {
      return extensionAPI?.settings?.get?.(key);
    } catch (error) {
      warn(`Could not read setting "${key}".`, error);
      return undefined;
    }
  }

  async function setSetting(key, value) {
    // Keep rapid consecutive drags (and resets) ordered until Roam saves them.
    const previous = savingSettings.get(key);
    const write = async () => extensionAPI?.settings?.set?.(key, value);
    const promise = previous ? previous.promise.catch(() => {}).then(write) : write();
    savingSettings.set(key, { value, promise });
    try {
      await promise;
    } catch (error) {
      warn(`Could not save setting "${key}".`, error);
    } finally {
      if (savingSettings.get(key)?.promise === promise) savingSettings.delete(key);
    }
  }

  async function setSettingDefault(key, value) {
    if (unloaded) return;
    const existing = getSetting(key);
    if (existing === null || typeof existing === "undefined") {
      await setSetting(key, value);
    }
  }

  function normalizeBoolean(value, fallback) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true") return true;
      if (normalized === "false") return false;
    }
    return fallback;
  }

  function readSettings() {
    const savedWidths = getSetting(SETTINGS_KEYS.columnWidthRatios);
    const columnWidthRatios = {};
    if (savedWidths && typeof savedWidths === "object" && !Array.isArray(savedWidths)) {
      for (const [depth, width] of Object.entries(savedWidths)) {
        if (!/^(0|[1-9]\d*)$/.test(depth)) continue;
        if (typeof width !== "string" || !/^\d+(?:\.\d+)?%$/.test(width)) continue;
        const percent = Number(width.slice(0, -1));
        if (percent >= 5 && percent <= 80) columnWidthRatios[depth] = width;
      }
    }
    settings = {
      columnWidthRatios,
      enabled: normalizeBoolean(getSetting(SETTINGS_KEYS.enabled), DEFAULTS.enabled),
      rowDividers: normalizeBoolean(getSetting(SETTINGS_KEYS.rowDividers), DEFAULTS.rowDividers),
    };

    return settings;
  }

  function readSwitchValue(eventOrValue, fallback) {
    if (typeof eventOrValue === "boolean") return eventOrValue;
    if (typeof eventOrValue?.target?.checked === "boolean") return eventOrValue.target.checked;
    if (typeof eventOrValue?.checked === "boolean") return eventOrValue.checked;
    return fallback;
  }

  async function updateSetting(key, rawValue) {
    if (unloaded) return;
    finishDrag(false);
    let nextValue = rawValue;
    if (key === SETTINGS_KEYS.enabled || key === SETTINGS_KEYS.rowDividers) {
      nextValue = normalizeBoolean(rawValue, DEFAULTS[key]);
    }

    settings[key] = nextValue;
    const saved = setSetting(key, nextValue);
    applyDocumentSettings();
    if (!settings.enabled) clearRowMarks();
    scheduleRefresh();
    await saved;
  }

  async function toggleEnabled() {
    await updateSetting(SETTINGS_KEYS.enabled, !settings.enabled);
  }

  function applyDocumentSettings() {
    if (typeof document === "undefined") return;

    const root = document.documentElement;
    const body = document.body;
    if (!root || !body) return;

    for (const depth of appliedDepths) {
      if (!(depth in settings.columnWidthRatios)) {
        root.style.removeProperty(widthProperty(depth));
        appliedDepths.delete(depth);
      }
    }
    for (const [depth, width] of Object.entries(settings.columnWidthRatios)) {
      root.style.setProperty(widthProperty(depth), width);
      appliedDepths.add(depth);
    }

    body.classList.toggle(CLASSES.enabled, settings.enabled);
    body.classList.toggle(CLASSES.rowDividers, settings.enabled && settings.rowDividers);
  }

  function clearDocumentSettings() {
    if (typeof document === "undefined") return;

    document.body?.classList.remove(CLASSES.enabled, CLASSES.rowDividers);
    appliedDepths.forEach((depth) => {
      document.documentElement.style.removeProperty(widthProperty(depth));
    });
    appliedDepths.clear();
  }

  function findBlockEditor(main) {
    const editor = main?.querySelector?.(EDITOR_SELECTOR);
    return editor && editor.closest?.(".rm-block-main") === main ? editor : null;
  }

  function hasBlankRenderedTail(blockText, ref) {
    const range = document.createRange();
    range.selectNodeContents(blockText);
    range.setStartAfter(ref);

    // Images and other inline values can render without a text node.
    for (const value of blockText.querySelectorAll("img, video, audio, iframe, canvas, input, button, hr")) {
      if (range.intersectsNode(value) && !value.closest('[data-tag^="."]')) return false;
    }

    // Only ignore markup attached to a rendered dot tag. Its hash and
    // link brackets can be separate siblings, even when the tag is hidden.
    let expectClosingBrackets = false;
    for (const tag of blockText.querySelectorAll('[data-tag^="."]')) {
      if (!range.intersectsNode(tag) || tag.contains(ref)) continue;
      range.setEndBefore(tag);
      const beforeTag = expectClosingBrackets ? /^\]\]\s*#?(\[\[)?$/ : /^\s*#?(\[\[)?$/;
      const match = beforeTag.exec(range.toString());
      if (!match) return false;
      expectClosingBrackets = Boolean(match[1]);
      range.setStartAfter(tag);
      range.setEnd(blockText, blockText.childNodes.length);
    }
    return expectClosingBrackets ? /^\]\]\s*$/.test(range.toString()) : !range.toString().trim();
  }

  function readAttributeLabel(main) {
    const editor = findBlockEditor(main);
    if (editor) {
      const match = /^([^\r\n]+?)::([\s\S]*)$/.exec(editor.value);
      const name = match?.[1].trim();
      if (!name) return null;
      return {
        title: name.replace(/^\[\[([\s\S]+)\]\]$/, "$1"),
        editor,
        hasBlankTail: () => !match[2].replace(CLASS_TAG_SYNTAX, "").trim(),
      };
    }

    const blockText = directChildMatching(main, ".rm-block-text");
    const ref = blockText?.querySelector(".rm-attr-ref");
    if (!ref || ref.closest(".rm-block-text") !== blockText || blockText.contains(ref.closest(".rm-block-ref"))) {
      return null;
    }
    const range = document.createRange();
    range.selectNodeContents(blockText);
    range.setEndBefore(ref);
    if (range.toString().trim()) return null;

    const linkSelector = "[data-link-title], [data-link-uid]";
    const wrapper = ref.closest(linkSelector);
    const link = blockText.contains(wrapper) ? wrapper : ref.querySelector(linkSelector);
    const page = link?.dataset || {};
    const title = page.linkTitle || ref.textContent.trim().replace(/:{1,2}$/, "").trim();
    if (!title && !page.linkUid) return null;

    return { title, pageUid: page.linkUid, hasBlankTail: () => hasBlankRenderedTail(blockText, ref) };
  }

  function cachedAttributePull(cache, pattern, key, value) {
    const lookup = `${key} ${value}`;
    if (!cache.has(lookup)) {
      let result = null;
      try {
        result = pullData(pattern, [key, value]);
      } catch {
        // Older graphs can reject unknown attributes. Use the rendered label.
      }
      cache.set(lookup, result);
    }
    return cache.get(lookup);
  }

  function isPassThroughTitle(title) {
    return String(title || "").trim() === "roam/meta";
  }

  function isPassThroughPage(page) {
    return isPassThroughTitle(getKeywordValue(page, ":node/title")) || getKeywordValue(page, ":attr/proxy") === true;
  }

  function refs(entity, keyword) {
    const value = getKeywordValue(entity, keyword);
    return Array.isArray(value) ? value : value ? [value] : [];
  }

  function getAttributeRowDescriptor(block, cache) {
    if (block.closest(INJECTED_SELECTOR)) return { eligible: false };
    const { label: main, values: children } = getRowParts(block);
    const label = readAttributeLabel(main);
    if (!label) return { eligible: false };
    if (isPassThroughTitle(label.title)) return { eligible: false, passthrough: true };

    const uid = getBlockUid(block);
    const source = uid && cachedAttributePull(cache.blocks, ATTRIBUTE_PULL_PATTERN, ":block/uid", uid);
    const savedText = getKeywordValue(source, ":block/string");
    // The editor can be ahead of Roam's derived assertion until the edit is saved.
    const draft = label.editor && typeof savedText === "string" && label.editor.value !== savedText;
    const harc = draft ? null : refs(source, ":harc/_a-source")[0];
    if (harc) {
      if (refs(harc, ":harc/a").some(isPassThroughPage)) return { eligible: false, passthrough: true };
      if (refs(harc, ":harc/v-source").some((value) => getKeywordValue(value, ":block/uid") === uid)) {
        return { eligible: false };
      }
    } else {
      const key = label.pageUid ? ":block/uid" : ":node/title";
      const page = cachedAttributePull(cache.pages, "[:node/title :attr/proxy]", key, label.pageUid || label.title);
      if (isPassThroughPage(page)) return { eligible: false, passthrough: true };
      if (!label.hasBlankTail()) return { eligible: false };
    }

    const closed = block.classList.contains("rm-block--closed");

    if (closed) {
      if (!uid) return { eligible: false };

      const summary = resolveClosedRowSummary(uid);
      if (!summary.hasChildren) return { eligible: false };

      return {
        eligible: true,
        harc,
        closed: true,
        summary,
      };
    }

    const childBlocks = directChildBlocks(children);
    if (childBlocks.length === 0) return { eligible: false };

    if (uid) {
      const count = countRenderedDescendants(children);
      cache.openCounts.set(uid, Math.max(count, cache.openCounts.get(uid) || 0));
    }

    return {
      eligible: true,
      harc,
      closed: false,
      summary: null,
    };
  }

  function collectOutlineBlocks() {
    if (typeof document === "undefined") return [];

    return document.querySelectorAll(
      `${MAIN_ARTICLE_SELECTOR} .roam-block-container, #right-sidebar .roam-block-container`
    );
  }

  function getRowParts(row) {
    return {
      label: directChildMatching(row, ".rm-block-main"),
      values: directChildMatching(row, ".rm-block-children"),
    };
  }

  function createFoldedSummaryBlock() {
    const block = document.createElement("div");
    block.className =
      "roam-block-container rm-block rm-block--mine rm-block--open rm-not-focused block-bullet-view";
    block.setAttribute(FOLDED_SUMMARY_BLOCK_ATTRIBUTE, "true");
    block.setAttribute("contenteditable", "false");

    const { main } = createRoamBlockMainShell();
    block.append(main);

    return block;
  }

  function createRoamBlockMainShell() {
    const main = document.createElement("div");
    main.className = "rm-block-main rm-block__self";

    const controls = document.createElement("div");
    controls.className = "controls rm-block__controls noselect";

    const expand = document.createElement("span");
    expand.className = "block-expand";

    const caret = document.createElement("span");
    caret.className =
      "bp3-icon-standard bp3-icon-caret-down rm-caret rm-caret-open rm-caret-hidden";
    expand.append(caret);

    const bullet = document.createElement("span");
    bullet.className = "rm-bullet";

    const popoverWrapper = document.createElement("span");
    popoverWrapper.className = "bp3-popover-wrapper";

    const popoverTarget = document.createElement("span");
    popoverTarget.className = "bp3-popover-target";
    popoverTarget.setAttribute("aria-haspopup", "true");

    const bulletInner = document.createElement("span");
    bulletInner.className = "rm-bullet__inner";
    bulletInner.tabIndex = -1;

    popoverTarget.append(bulletInner);
    popoverWrapper.append(popoverTarget);
    bullet.append(popoverWrapper);
    controls.append(expand, bullet);

    const text = document.createElement("div");
    text.className = "rm-block__input rm-block__input--view roam-block rm-block-text";
    text.tabIndex = -1;
    text.setAttribute("contenteditable", "false");
    text.append(document.createElement("span"));

    const separator = document.createElement("div");
    separator.className = "rm-block-separator";

    const spacer = document.createElement("div");
    spacer.style.minWidth = "24px";

    main.append(controls, text, separator, spacer);

    return {
      main,
      text,
    };
  }

  function createTrailingBodyBlock() {
    const block = document.createElement("div");
    block.className =
      `roam-block-container rm-block rm-block--mine rm-block--open ` +
      `rm-block--editable rm-not-focused block-bullet-view ${CLASSES.trailingBodyBlock}`;
    block.setAttribute(TRAILING_BODY_BLOCK_ATTRIBUTE, "true");
    block.setAttribute("aria-label", "Create a new body block");
    block.setAttribute("role", "button");
    block.tabIndex = 0;

    const { main } = createRoamBlockMainShell();
    block.append(main);

    block.addEventListener("click", handleTrailingBodyBlockClick);
    block.addEventListener("keydown", handleTrailingBodyBlockKeydown);

    return block;
  }

  function foldedSummaryBlock(values) {
    return directChildMatching(values, `[${FOLDED_SUMMARY_BLOCK_ATTRIBUTE}]`);
  }

  function setFoldedSummaryBlockText(block, text) {
    const textElement = block?.querySelector?.(".rm-block-text > span");
    textElement?.classList.toggle("rm-page-ref--tag", true);
    if (textElement && textElement.textContent !== text) {
      textElement.textContent = text;
    }
  }

  function ensureFoldedSummaryBlock(values, summary) {
    if (!values || typeof document === "undefined") return;

    let block = foldedSummaryBlock(values);
    if (!block) {
      block = createFoldedSummaryBlock();
      values.append(block);
    }

    setFoldedSummaryBlockText(block, summary?.summary || FALLBACK_SUMMARY);
    return block;
  }

  function removeFoldedSummaryBlock(values) {
    foldedSummaryBlock(values)?.remove();
  }

  function removeTrailingBodyBlocks(liveContainers = new Set()) {
    // A sidebar window can be detached with its placeholder still in it.
    for (const [container, block] of trailingBlocks) {
      if (!liveContainers.has(container) || block.parentElement !== container) {
        block.remove();
        trailingBlocks.delete(container);
      }
    }
    document.querySelectorAll(`[${TRAILING_BODY_BLOCK_ATTRIBUTE}]`).forEach((block) => {
      if (trailingBlocks.get(block.parentElement) !== block) block.remove();
    });
  }

  function topLevelOutlineContainers(root = document) {
    const outline = `:is(${MAIN_ARTICLE_SELECTOR}, ${SIDEBAR_WINDOW_SELECTOR} .rm-sidebar-outline)`;
    const zoomChildren = ".rm-zoom-block-wrapper > .roam-block-container > .rm-block-children";
    const lists = root.querySelectorAll(
      `${outline} .rm-block-children.rm-level-0, ${outline} ${zoomChildren}`
    );
    return Array.from(lists).filter((container) => {
      if (container.closest(".rm-reference-main, .rm-embed-container")) return false;
      const owner = container.closest(".roam-block-container");
      if (!owner) return true;
      return container.matches(zoomChildren) && !owner.parentElement.closest(".roam-block-container");
    });
  }

  function directTopLevelBlocks(container) {
    return directChildBlocks(container);
  }

  function shouldShowTrailingBodyBlock(container) {
    if (!settings.enabled) return false;

    const blocks = directTopLevelBlocks(container);
    if (blocks.length === 0) return false;

    const lastBlock = blocks[blocks.length - 1];
    return lastBlock.classList.contains(CLASSES.row) && !lastBlock.hasAttribute("data-rc-stacked");
  }

  function syncTrailingBodyBlocks() {
    if (typeof document === "undefined") return;

    const containers = new Set(topLevelOutlineContainers().filter(shouldShowTrailingBodyBlock));
    removeTrailingBodyBlocks(containers);
    for (const container of containers) {
      let block = trailingBlocks.get(container);
      if (!block) {
        if (container === pendingBodyContainer) continue;
        block = createTrailingBodyBlock();
        trailingBlocks.set(container, block);
      }
      if (container.lastElementChild !== block) container.append(block);
    }
  }

  function getRoamAlphaApi() {
    return typeof window !== "undefined" ? window.roamAlphaAPI : null;
  }

  function getRoamUiApi() {
    return getRoamAlphaApi()?.ui || extensionAPI?.ui || null;
  }

  function getRoamDataApi() {
    return getRoamAlphaApi()?.data || extensionAPI?.data || null;
  }

  async function getOpenPageOrBlockUid() {
    const mainWindowApi = getRoamUiApi()?.mainWindow;
    const getUid = mainWindowApi?.getOpenPageOrBlockUid;
    if (typeof getUid !== "function") return "";

    const result = getUid.call(mainWindowApi);
    return result && typeof result.then === "function" ? await result : result;
  }

  function getPageTitleFromBlock(block) {
    return (
      block?.getAttribute?.("data-page-title") ||
      block?.closest?.("[data-page-title]")?.getAttribute?.("data-page-title") ||
      ""
    );
  }

  function getVisibleTitle(pane) {
    const titleElement = pane.querySelector(".rm-title-display, .rm-title-textarea");

    if ("value" in (titleElement || {})) {
      return normalizeText(titleElement.value);
    }

    return visibleText(titleElement);
  }

  function pullPageUidByTitle(title) {
    if (!title) return "";

    try {
      const page = pullData("[:block/uid]", [":node/title", title]);
      return getKeywordValue(page, ":block/uid") || "";
    } catch (error) {
      warn(`Could not pull page UID for "${title}".`, error);
      return "";
    }
  }

  function pullPageUidForBlockUid(uid) {
    if (!uid) return "";

    try {
      const block = pullData("[{:block/page [:block/uid]}]", [":block/uid", uid]);
      const page = getKeywordValue(block, ":block/page");
      return getKeywordValue(page, ":block/uid") || "";
    } catch (error) {
      warn(`Could not pull page UID for block ${uid}.`, error);
      return "";
    }
  }

  function getOutlineParentUid(container) {
    const ownerUid = getBlockUid(container.parentElement);
    if (ownerUid) return ownerUid;
    const uid = getBlockUid(directTopLevelBlocks(container).at(-1));
    if (!uid) return "";
    try {
      const block = pullData("[{:block/_children [:block/uid]}]", [":block/uid", uid]);
      const [parent] = refs(block, ":block/_children");
      return getKeywordValue(parent, ":block/uid") || "";
    } catch (error) {
      warn(`Could not pull parent UID for block ${uid}.`, error);
      return "";
    }
  }

  function getSidebarBodyLocation(panel, parentUid) {
    // A window can zoom within its original outline. Its displayed parent
    // determines where to append, while its window ID determines where to focus.
    const windowId = panel.dataset.sidebarWindowId;
    const windows = getRoamUiApi()?.rightSidebar?.getWindows?.() || [];
    const outlines = windows.filter((entry) => entry?.type === "outline" || entry?.type === "block");
    const matches = outlines.filter((entry) => {
      if (windowId) return entry["window-id"] === windowId;
      return parentUid && !entry["collapsed?"] && (entry["block-uid"] || entry["page-uid"]) === parentUid;
    });
    if (matches.length !== 1 || !matches[0]["window-id"]) return null;
    const [entry] = matches;
    if (!windowId) {
      // Another panel may already own this ID or be zoomed to the same outline.
      for (const other of document.querySelectorAll(SIDEBAR_WINDOW_SELECTOR)) {
        if (other === panel) continue;
        if (other.dataset.sidebarWindowId === entry["window-id"]) return null;
        if (other.dataset.sidebarWindowId) continue;
        if (topLevelOutlineContainers(other).some((list) => getOutlineParentUid(list) === parentUid)) return null;
      }
    }
    return {
      pane: panel,
      windowId: entry["window-id"],
      parentUid: parentUid || entry["block-uid"] || entry["page-uid"],
    };
  }

  async function getTrailingBodyLocation(container) {
    const outlineUid = getOutlineParentUid(container);
    const panel = container.closest(SIDEBAR_WINDOW_SELECTOR);
    if (panel) return getSidebarBodyLocation(panel, outlineUid);

    const pane = container.closest(MAIN_ARTICLE_SELECTOR);
    if (!pane) return null;
    const lastBlock = directTopLevelBlocks(container).at(-1);
    const parentUid = outlineUid || await getOpenPageOrBlockUid() ||
      pullPageUidForBlockUid(getBlockUid(lastBlock)) ||
      pullPageUidByTitle(getPageTitleFromBlock(lastBlock) || getVisibleTitle(pane));
    return { pane, windowId: "main-window", parentUid };
  }

  function generateUid() {
    const generate = getRoamAlphaApi()?.util?.generateUID;
    return typeof generate === "function" ? generate() : "";
  }

  async function waitForBlockToRender(uid, pane) {
    for (let attempt = 0; !unloaded && pane.isConnected && attempt < 10; attempt += 1) {
      const rendered = topLevelOutlineContainers(pane).some((container) =>
        directChildBlocks(container).some((block) => getBlockUid(block) === uid)
      );
      if (rendered) return true;
      await new Promise((resolve) => {
        finishFocusWait = resolve;
        focusTimer = window.setTimeout(resolve, 40);
      });
      finishFocusWait = focusTimer = null;
    }
    return false;
  }

  async function focusBlock(uid, { pane, windowId }) {
    const uiApi = getRoamUiApi();
    const focus = uiApi?.setBlockFocusAndSelection;
    if (!uid || typeof focus !== "function") return;

    if (!(await waitForBlockToRender(uid, pane)) || unloaded) return;
    if (pane.dataset.sidebarWindowId && pane.dataset.sidebarWindowId !== windowId) return;

    try {
      await focus.call(uiApi, {
        location: {
          "block-uid": uid,
          "window-id": windowId,
        },
        selection: {
          start: 0,
        },
      });
    } catch (error) {
      warn(`Could not focus new body block ${uid}.`, error);
    }
  }

  async function createTrailingBodyBlockInGraph(parentUid) {
    const dataApi = getRoamDataApi();
    const createBlock = dataApi?.block?.create;
    if (typeof createBlock !== "function") {
      throw new Error("Roam block creation API is unavailable.");
    }

    if (!parentUid) throw new Error("Could not determine the current page or block UID.");

    const uid = generateUid();
    const block = {
      string: "",
      open: true,
    };
    if (uid) block.uid = uid;

    await createBlock.call(dataApi.block, {
      location: {
        "parent-uid": parentUid,
        order: "last",
      },
      block,
    });

    return uid;
  }

  async function activateTrailingBodyBlock(block) {
    const container = block.parentElement;
    if (pendingBodyContainer || !shouldShowTrailingBodyBlock(container)) return;
    if (!topLevelOutlineContainers().includes(container)) return;

    pendingBodyContainer = container;
    block?.setAttribute?.(TRAILING_BODY_PENDING_ATTRIBUTE, "true");

    try {
      const location = await getTrailingBodyLocation(container);
      if (unloaded || !block.isConnected) return;
      if (!location?.parentUid) throw new Error("Could not identify the outline for this body block.");
      block.remove();
      const uid = await createTrailingBodyBlockInGraph(location.parentUid);
      await focusBlock(uid, location);
    } catch (error) {
      warn("Could not create trailing body block.", error);
    } finally {
      block.removeAttribute(TRAILING_BODY_PENDING_ATTRIBUTE);
      pendingBodyContainer = null;
      scheduleRefresh();
    }
  }

  function handleTrailingBodyBlockClick(event) {
    event.preventDefault();
    event.stopPropagation();
    void activateTrailingBodyBlock(event.currentTarget);
  }

  function handleTrailingBodyBlockKeydown(event) {
    if (event.key !== "Enter" && event.key !== " ") return;

    event.preventDefault();
    event.stopPropagation();
    void activateTrailingBodyBlock(event.currentTarget);
  }

  function widthProperty(depth) {
    return `--rc-label-width-depth-${depth}`;
  }

  function saveWidth(depth, width) {
    const widths = { ...settings.columnWidthRatios };
    if (width) widths[depth] = width;
    else delete widths[depth];
    return updateSetting(SETTINGS_KEYS.columnWidthRatios, widths);
  }

  function ensureResizer(row) {
    if (directChildMatching(row, `[${RESIZER_ATTRIBUTE}]`)) return;
    const handle = document.createElement("div");
    handle.className = "rc-column-resizer";
    handle.setAttribute(RESIZER_ATTRIBUTE, "");
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-label", "Resize attribute label column");
    handle.setAttribute("aria-orientation", "vertical");
    handle.title = "Drag to resize. Double-click to reset this level.";
    row.append(handle);
  }

  function stopEvent(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  function finishDrag(commit) {
    if (!drag) return;
    const { handle, pointerId, listeners, depth, width, previous } = drag;
    drag = null;
    suppressDividerClick = true;
    listeners.abort();
    if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
    handle.removeAttribute("data-rc-dragging");
    document.body.classList.remove(CLASSES.resizing);

    const root = document.documentElement.style;
    if (previous) root.setProperty(widthProperty(depth), previous);
    else root.removeProperty(widthProperty(depth));
    if (commit && width !== null) void saveWidth(depth, width);
    scheduleRefresh();
  }

  function moveDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    stopEvent(event);
    const delta = (event.clientX - drag.startX) * drag.direction;
    const pixels = Math.min(drag.max, Math.max(drag.min, drag.startWidth + delta));
    const percent = Math.max(5, Math.min(80, Math.round(pixels / drag.rowWidth * 1000) / 10));
    drag.width = delta === 0 ? null : `${percent}%`;
    document.documentElement.style.setProperty(widthProperty(drag.depth), drag.width || drag.previous);
    scheduleLayout();
  }

  function rowContentWidth(row, style = getComputedStyle(row)) {
    const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const border = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
    return row.getBoundingClientRect().width - padding - border;
  }

  function beginDrag(event, handle) {
    if (drag || event.button !== 0 || event.isPrimary === false) return;
    const row = handle.parentElement;
    const { label, values: children } = getRowParts(row);
    const values = children || foldedSummaryBlock(row);
    if (!label || !values) return;

    const style = getComputedStyle(row);
    const rtl = style.direction === "rtl";
    const labelRect = label.getBoundingClientRect();
    const valueRect = values.getBoundingClientRect();
    const gap = rtl ? labelRect.left - valueRect.right : valueRect.left - labelRect.right;
    const rowWidth = rowContentWidth(row, style);
    if (rowWidth <= 0 || labelRect.width <= 0) return;

    // Match the grid's responsive bounds even inside a narrow nested value.
    const available = Math.max(0, rowWidth - Math.max(0, gap));
    const depth = Number(row.dataset.rcDepth);
    const listeners = new AbortController();
    drag = {
      handle,
      depth,
      listeners,
      pointerId: event.pointerId,
      startX: event.clientX,
      direction: rtl ? -1 : 1,
      startWidth: labelRect.width,
      rowWidth,
      min: Math.min(96, available * 0.35),
      max: available - Math.min(140, available * 0.5),
      previous: document.documentElement.style.getPropertyValue(widthProperty(depth)),
      width: null,
    };

    window.clearTimeout(refreshTimeout);
    refreshTimeout = null;
    document.body.classList.add(CLASSES.resizing);
    handle.setAttribute("data-rc-dragging", "");
    const options = { capture: true, signal: listeners.signal };
    window.addEventListener("pointermove", moveDrag, options);
    window.addEventListener("pointerup", (up) => {
      if (up.pointerId !== drag.pointerId) return;
      // A pane resize during the gesture invalidates its starting grid geometry.
      if (!handle.isConnected || Math.abs(rowContentWidth(row) - drag.rowWidth) > 0.5) {
        stopEvent(up);
        finishDrag(false);
        return;
      }
      moveDrag(up);
      finishDrag(true);
    }, options);
    const cancelPointer = (end) => {
      if (end.pointerId === drag.pointerId) finishDrag(false);
    };
    window.addEventListener("pointercancel", cancelPointer, options);
    handle.addEventListener("lostpointercapture", cancelPointer, options);
    window.addEventListener("blur", () => finishDrag(false), options);
    window.addEventListener("keydown", (key) => {
      if (key.key !== "Escape") return;
      stopEvent(key);
      finishDrag(false);
    }, options);
    try {
      handle.setPointerCapture(event.pointerId);
    } catch (_) {
      // Window listeners also track the gesture when capture is unavailable.
    }
  }

  function handleDividerEvent(event) {
    if (event.type === "pointerdown") suppressDividerClick = false;
    // Without capture, a release outside the divider can dispatch click on its ancestor.
    if (event.type === "click" && suppressDividerClick && event.detail > 0) {
      suppressDividerClick = false;
      stopEvent(event);
      return;
    }
    const handle = event.target.closest?.(`.${CLASSES.row} > [${RESIZER_ATTRIBUTE}]`);
    if (!handle || !settings.enabled || handle.parentElement.hasAttribute("data-rc-stacked")) return;
    stopEvent(event);
    if (event.type === "pointerdown") beginDrag(event, handle);
    if (event.type === "dblclick") void saveWidth(Number(handle.parentElement.dataset.rcDepth), null);
  }

  function handleEditorInput(event) {
    if (event.target.matches?.(EDITOR_SELECTOR)) scheduleRefresh();
  }

  function applyRowSummary(row, summary) {
    if (!summary) {
      SUMMARY_ATTRIBUTES.forEach((key) => row.removeAttribute(key));
      return;
    }

    row.setAttribute("data-rc-summary", summary.summary || FALLBACK_SUMMARY);
    row.setAttribute("data-rc-child-count", String(summary.childCount ?? ""));
  }

  function markRow(row, descriptor, depth, maxDepth) {
    const parts = getRowParts(row);
    markedBlocks.add(row);
    row.removeAttribute(PASSTHROUGH_ATTRIBUTE);
    const harc = descriptor.harc;
    if (harc) row.dataset.rcAttrModel = "harc";
    else delete row.dataset.rcAttrModel;
    const harcUid = getKeywordValue(harc, ":block/uid");
    if (harcUid) row.dataset.rcHarcUid = harcUid;
    else delete row.dataset.rcHarcUid;
    if (refs(harc, ":harc/e").some((entity) => refs(entity, ":harc/a").length)) {
      row.dataset.rcAttrRole = "relationship";
    } else {
      delete row.dataset.rcAttrRole;
    }
    row.classList.toggle(CLASSES.row, true);
    row.classList.toggle(CLASSES.closed, descriptor.closed);
    row.classList.toggle(CLASSES.summaryPending, Boolean(descriptor.summary?.pending));
    parts.label.classList.toggle(CLASSES.label, true);
    parts.values?.classList.toggle(CLASSES.values, true);
    if (parts.values) removeFoldedSummaryBlock(row);
    if (row.dataset.rcDepth !== String(depth)) row.dataset.rcDepth = String(depth);
    // Each remaining label gets one share, and the final value gets 2.5.
    const percent = (100 / (1 + maxDepth - depth + 2.5)).toFixed(3);
    const automatic = `min(${percent}%, ${depth === 0 ? "16rem" : "15rem"})`;
    row.style.setProperty("--rc-row-label-width", `var(${widthProperty(depth)}, ${automatic})`);
    ensureResizer(row);

    applyRowSummary(row, descriptor.summary);
    if (descriptor.closed) {
      // A folded outline may omit its native children container altogether.
      const summaryBlock = ensureFoldedSummaryBlock(parts.values || row, descriptor.summary);
      if (!parts.values) summaryBlock.classList.toggle(CLASSES.values, true);
    } else {
      removeFoldedSummaryBlock(parts.values);
    }
  }

  function unmarkRow(row) {
    const parts = getRowParts(row);
    markedBlocks.delete(row);
    row.classList.remove(CLASSES.row, CLASSES.closed, CLASSES.summaryPending);
    applyRowSummary(row, null);
    HARC_ATTRIBUTES.forEach((key) => row.removeAttribute(key));
    row.removeAttribute(PASSTHROUGH_ATTRIBUTE);
    delete row.dataset.rcDepth;
    delete row.dataset.rcStacked;
    row.style.removeProperty("--rc-row-label-width");
    directChildMatching(row, `[${RESIZER_ATTRIBUTE}]`)?.remove();
    removeFoldedSummaryBlock(row);
    removeFoldedSummaryBlock(parts.values);
    parts.label?.classList.remove(CLASSES.label);
    parts.values?.classList.remove(CLASSES.values);
  }

  function clearStrayPartMarks() {
    document.querySelectorAll(HARC_SELECTOR).forEach((block) => {
      if (!markedBlocks.has(block) || !block.classList.contains(CLASSES.row)) {
        HARC_ATTRIBUTES.forEach((key) => block.removeAttribute(key));
      }
    });
    document.querySelectorAll(`[${PASSTHROUGH_ATTRIBUTE}]`).forEach((block) => {
      if (!markedBlocks.has(block)) block.removeAttribute(PASSTHROUGH_ATTRIBUTE);
    });
    document.querySelectorAll(`.${CLASSES.label}, .${CLASSES.values}`).forEach((element) => {
      if (!element.parentElement?.classList.contains(CLASSES.row)) {
        element.classList.remove(CLASSES.label, CLASSES.values);
      }
    });
    document.querySelectorAll(`[${FOLDED_SUMMARY_BLOCK_ATTRIBUTE}]`).forEach((element) => {
      const closedRow = `.${CLASSES.row}.${CLASSES.closed}`;
      if (!element.parentElement?.matches(`${closedRow}, ${closedRow} > .rm-block-children`)) {
        element.remove();
      }
    });
    document.querySelectorAll(`[${RESIZER_ATTRIBUTE}]`).forEach((handle) => {
      if (!handle.parentElement?.classList.contains(CLASSES.row)) handle.remove();
    });
  }

  function refreshRows() {
    refreshTimeout = null;
    if (unloaded || drag) return;
    readSettings();
    applyDocumentSettings();
    if (!settings.enabled) {
      clearRowMarks();
      return;
    }

    const candidates = new Map();
    const cache = { blocks: new Map(), pages: new Map(), openCounts: new Map() };
    const childDepths = new WeakMap();
    const outlineDepths = new Map();
    rowPanes.clear();
    activeClosedRowUids.clear();
    // querySelectorAll visits parents first. Ordinary blocks pass the depth through.
    for (const block of collectOutlineBlocks()) {
      const parent = block.parentElement?.closest(".roam-block-container");
      const ancestor = childDepths.get(parent);
      // A zoomed block's child list can itself be rm-level-0. Keep that tree together.
      const outline = ancestor?.outline || block.closest(OUTLINE_SELECTOR);
      const depth = ancestor?.depth || 0;
      const descriptor = getAttributeRowDescriptor(block, cache);
      childDepths.set(block, { outline, depth: depth + Number(descriptor.eligible) });
      if (!descriptor.eligible && !descriptor.passthrough) continue;
      candidates.set(block, { descriptor, depth, outline });
      if (descriptor.eligible) {
        outlineDepths.set(outline, Math.max(depth, outlineDepths.get(outline) || 0));
        rowPanes.set(block, block.closest(LAYOUT_PANE_SELECTOR));
      }
      if (descriptor.closed) activeClosedRowUids.add(getBlockUid(block));
    }
    // A rendered copy can hide descendants. Keep its count as a fallback,
    // separate from the graph counts shared by folded copies of the same UID.
    cache.openCounts.forEach((count, uid) => lastRenderedCounts.set(uid, count));
    markedBlocks.forEach((row) => {
      if (!candidates.has(row)) unmarkRow(row);
    });
    candidates.forEach(({ descriptor, depth, outline }, block) => {
      if (descriptor.passthrough) {
        if (block.classList.contains(CLASSES.row)) unmarkRow(block);
        markedBlocks.add(block);
        block.setAttribute(PASSTHROUGH_ATTRIBUTE, "true");
      } else {
        if (descriptor.summary?.pending) {
          const count = lastRenderedCounts.get(getBlockUid(block));
          if (count) descriptor.summary = buildSummaryFromCount(count);
        }
        markRow(block, descriptor, depth, outlineDepths.get(outline));
      }
    });
    summaryWatches.forEach((_, uid) => {
      if (!activeClosedRowUids.has(uid)) removeClosedRowWatch(uid);
    });
    activeClosedRowUids.forEach((uid) => void ensureClosedRowWatch(uid));
    clearStrayPartMarks();
    syncObservedPanes();
    scheduleLayout();
  }

  function scheduleRefresh() {
    if (unloaded || drag || refreshTimeout !== null) return;
    refreshTimeout = window.setTimeout(refreshRows, 80);
  }

  function clearRowMarks() {
    if (typeof document === "undefined") return;
    rowPanes.clear();
    syncObservedPanes();
    markedBlocks.forEach(unmarkRow);
    document.querySelectorAll(`.${CLASSES.row}, [data-rc-depth]`).forEach(unmarkRow);
    clearStrayPartMarks();
    removeTrailingBodyBlocks();
    removeAllClosedRowWatches();
  }

  function syncObservedPanes() {
    if (!paneObserver) return;
    const panes = new Set(rowPanes.values());
    for (const pane of observedPaneWidths.keys()) {
      if (!panes.has(pane)) {
        paneObserver.unobserve(pane);
        observedPaneWidths.delete(pane);
      }
    }
    for (const pane of panes) {
      if (!observedPaneWidths.has(pane)) {
        observedPaneWidths.set(pane, null);
        paneObserver.observe(pane);
      }
    }
  }

  function scheduleLayout() {
    if (unloaded || layoutFrame !== null) return;
    layoutFrame = window.requestAnimationFrame
      ? window.requestAnimationFrame(updateLayout)
      : window.setTimeout(updateLayout, 16);
  }

  function updateLayout() {
    layoutFrame = null;
    const paneWidths = new Map();
    const changes = [];
    for (const [row, pane] of rowPanes) {
      if (!paneWidths.has(pane)) paneWidths.set(pane, pane.getBoundingClientRect().width);
      const paneWidth = paneWidths.get(pane);
      const rowWidth = row.getBoundingClientRect().width;
      if (!paneWidth || !rowWidth) continue;
      const stacked = row.hasAttribute("data-rc-stacked");
      const margin = stacked ? UNSTACK_MARGIN : 0;
      const shouldStack = paneWidth < MIN_PANE_WIDTH + margin || rowWidth < MIN_ROW_WIDTH + margin;
      if (stacked !== shouldStack) changes.push([row, shouldStack]);
    }
    // Batch layout reads before writes. Recheck descendants after an ancestor changes layout.
    for (const [row, stacked] of changes) {
      if (stacked) {
        row.dataset.rcStacked = "true";
        if (drag?.handle.parentElement === row) finishDrag(false);
      } else {
        delete row.dataset.rcStacked;
      }
    }
    if (changes.length) scheduleLayout();
    syncTrailingBodyBlocks();
  }

  function startLayoutListeners() {
    const options = { capture: true, signal: layoutListeners.signal };
    if (typeof ResizeObserver !== "undefined") {
      paneObserver = new ResizeObserver((entries) => {
        for (const { target, contentRect } of entries) {
          if (observedPaneWidths.has(target) && observedPaneWidths.get(target) !== contentRect.width) {
            observedPaneWidths.set(target, contentRect.width);
            scheduleLayout();
          }
        }
      });
    }
    window.addEventListener("resize", scheduleLayout, { signal: layoutListeners.signal });
    for (const event of ["pointerdown", "mousedown", "click", "dblclick"]) {
      document.addEventListener(event, handleDividerEvent, options);
    }
    document.addEventListener("input", handleEditorInput, options);
  }

  function startObserver() {
    if (typeof MutationObserver === "undefined" || typeof document === "undefined") return;

    // Either pane can be mounted or removed below the observer target.
    const target = document.body;
    if (!target) return;

    mutationObserver = new MutationObserver((records) => {
      if (drag && !drag.handle.isConnected) finishDrag(false);
      const changed = records.some((record) => {
        const element = record.target.nodeType === Node.ELEMENT_NODE
          ? record.target : record.target.parentElement;
        if (element?.closest(INJECTED_SELECTOR)) return false;
        const inPane = element?.closest(PANE_SELECTOR);
        // Page-width settings can resize an inner wrapper while its observed pane stays fixed.
        if (record.attributeName === "style" || (record.attributeName === "class" && !inPane)) {
          if (inPane || element?.querySelector(PANE_SELECTOR)) scheduleLayout();
          return false;
        }
        if (!inPane) {
          if (record.type !== "childList") return false;
          return [...record.addedNodes, ...record.removedNodes].some((node) =>
            node.matches?.(PANE_SELECTOR) || node.querySelector?.(PANE_SELECTOR)
          );
        }
        if (record.type !== "childList") return true;
        return [...record.addedNodes, ...record.removedNodes].some((node) => !node.matches?.(INJECTED_SELECTOR));
      });
      if (changed) {
        if (drag) scheduleLayout();
        else scheduleRefresh();
      }
    });

    mutationObserver.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
      attributeFilter: ["class", "style", "data-block-uid", "data-page-links", "data-link-uid", "data-link-title", "data-tag"],
    });
  }

  async function createSettingsPanel() {
    const createPanel = extensionAPI?.settings?.panel?.create;
    if (typeof createPanel !== "function") return;

    const panelConfig = {
      tabTitle: "Roam Attribute Columns",
      settings: [
        {
          id: "resetColumnWidths",
          name: "Reset column widths",
          description: "Restore all resized columns to their automatic responsive widths.",
          action: {
            type: "button",
            content: "Reset column widths",
            onClick: () => updateSetting(SETTINGS_KEYS.columnWidthRatios, {}),
          },
        },
        {
          id: SETTINGS_KEYS.rowDividers,
          name: "Show row dividers",
          description: "Draw subtle separators between horizontal attribute rows.",
          action: {
            type: "switch",
            onChange: (eventOrValue) => {
              void updateSetting(
                SETTINGS_KEYS.rowDividers,
                readSwitchValue(eventOrValue, settings.rowDividers)
              );
            },
          },
        },
      ],
    };

    try {
      const result = createPanel.call(extensionAPI.settings.panel, panelConfig);
      if (result && typeof result.then === "function") await result;
    } catch (error) {
      warn("Could not create settings panel.", error);
    }
  }

  async function registerCommand() {
    commandPaletteApi =
      extensionAPI?.ui?.commandPalette ||
      (typeof window !== "undefined" ? window.roamAlphaAPI?.ui?.commandPalette : null);

    if (typeof commandPaletteApi?.addCommand !== "function") return;

    try {
      const result = commandPaletteApi.addCommand({
        label: COMMAND_LABEL,
        callback: () => {
          void toggleEnabled();
        },
      });

      if (result && typeof result.then === "function") await result;
    } catch (error) {
      warn("Could not register command palette command.", error);
    }
  }

  function removeCommand() {
    const api =
      commandPaletteApi ||
      extensionAPI?.ui?.commandPalette ||
      (typeof window !== "undefined" ? window.roamAlphaAPI?.ui?.commandPalette : null);

    if (typeof api?.removeCommand !== "function") return;

    try {
      const result = api.removeCommand({ label: COMMAND_LABEL });
      if (result && typeof result.catch === "function") {
        result.catch((error) => warn("Could not remove command palette command.", error));
      }
    } catch (error) {
      warn("Could not remove command palette command.", error);
    }
  }

  async function onload() {
    unloaded = false;

    await setSettingDefault(SETTINGS_KEYS.enabled, DEFAULTS.enabled);
    await setSettingDefault(SETTINGS_KEYS.rowDividers, DEFAULTS.rowDividers);

    if (unloaded) return;
    readSettings();
    await createSettingsPanel();
    if (unloaded) return;
    await registerCommand();
    if (unloaded) return;

    applyDocumentSettings();
    startObserver();
    startLayoutListeners();
    scheduleRefresh();

    console.log("[Roam Attribute Columns] Loaded.");
  }

  function unload() {
    unloaded = true;
    finishDrag(false);
    window.clearTimeout(focusTimer);
    finishFocusWait?.();

    if (refreshTimeout !== null) {
      window.clearTimeout(refreshTimeout);
      refreshTimeout = null;
    }

    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }

    paneObserver?.disconnect();
    paneObserver = null;
    observedPaneWidths.clear();
    if (layoutFrame !== null) {
      if (window.cancelAnimationFrame) window.cancelAnimationFrame(layoutFrame);
      else window.clearTimeout(layoutFrame);
    }
    layoutListeners.abort();
    removeCommand();
    clearRowMarks();
    clearDocumentSettings();
    summaryCache.clear();
    lastRenderedCounts.clear();

    console.log("[Roam Attribute Columns] Unloaded.");
  }

  return {
    onload,
    unload,
  };
}

export default {
  onload: async ({ extensionAPI } = {}) => {
    if (typeof window !== "undefined" && window[GLOBAL_KEY]?.unload) {
      window[GLOBAL_KEY].unload();
    }

    const extension = createRoamAttributeColumnsExtension({ extensionAPI });
    if (typeof window !== "undefined") window[GLOBAL_KEY] = extension;
    await extension.onload();
  },

  onunload: () => {
    if (typeof window === "undefined") return;

    const extension = window[GLOBAL_KEY];
    if (extension?.unload) extension.unload();
    delete window[GLOBAL_KEY];
  },
};
