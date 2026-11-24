const GLOBAL_KEY = "__roamAttributeColumns";
const COMMAND_LABEL = "Roam Attribute Columns: Toggle horizontal attributes";
const SUMMARY_PULL_PATTERN = "[:block/uid {:block/children ...}]";
const FALLBACK_SUMMARY = "Folded blocks";
const FOLDED_SUMMARY_BLOCK_ATTRIBUTE = "data-rc-folded-summary-block";
const TRAILING_BODY_BLOCK_ATTRIBUTE = "data-rc-trailing-body-block";
const TRAILING_BODY_PENDING_ATTRIBUTE = "data-rc-trailing-body-pending";
const RESIZER_ATTRIBUTE = "data-rc-resizer";
const INJECTED_SELECTOR =
  `[${FOLDED_SUMMARY_BLOCK_ATTRIBUTE}], [${TRAILING_BODY_BLOCK_ATTRIBUTE}], [${RESIZER_ATTRIBUTE}]`;
const EDITOR_SELECTOR = "textarea:is(.rm-block-input, .rm-block__input)";
const HORIZONTAL_LAYOUT_MEDIA_QUERY = "(min-width: 900px)";

const SETTINGS_KEYS = {
  enabled: "enabled",
  labelWidth: "labelWidth",
  nestedLabelWidths: "nestedLabelWidths",
  rowDividers: "rowDividers",
};

const DEFAULTS = {
  enabled: true,
  labelWidth: "18rem",
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

const CSS_VARS = {
  labelWidthSetting: "--rc-label-width-setting",
};

const ROW_DATA_ATTRIBUTES = ["data-rc-summary", "data-rc-child-count"];

function createRoamAttributeColumnsExtension({ extensionAPI } = {}) {
  let mutationObserver = null;
  let refreshTimeout = null;
  let commandPaletteApi = null;
  let unloaded = false;
  let creatingTrailingBodyBlock = false;
  const layoutListeners = new AbortController();
  let drag = null;
  let suppressDividerClick = false;
  let focusTimer = null;
  let finishFocusWait = null;

  let settings = {
    ...DEFAULTS,
  };

  const summaryCache = new Map();
  const markedRows = new Set();
  const appliedNestedDepths = new Set();
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
    return object[keyword] ?? object[bareKeyword];
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

  function buildOpenRowSummary(childrenContainer) {
    return buildSummaryFromCount(countRenderedDescendants(childrenContainer));
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

  function normalizeCssLength(value, fallback) {
    const candidate = typeof value === "string" ? value.trim() : "";
    if (!candidate) return fallback;

    try {
      if (
        typeof CSS !== "undefined" && CSS.supports?.("width", candidate) &&
        CSS.supports("width", `clamp(0px, ${candidate}, 100%)`)
      ) {
        return candidate;
      }
    } catch (_) {}

    return fallback;
  }

  function readSettings() {
    const savedWidths = getSetting(SETTINGS_KEYS.nestedLabelWidths);
    const nestedLabelWidths = {};
    if (savedWidths && typeof savedWidths === "object" && !Array.isArray(savedWidths)) {
      for (const [depth, width] of Object.entries(savedWidths)) {
        const length = normalizeCssLength(width, null);
        if (/^[1-9]\d*$/.test(depth) && length) nestedLabelWidths[depth] = length;
      }
    }
    settings = {
      nestedLabelWidths,
      enabled: normalizeBoolean(getSetting(SETTINGS_KEYS.enabled), DEFAULTS.enabled),
      labelWidth: normalizeCssLength(getSetting(SETTINGS_KEYS.labelWidth), DEFAULTS.labelWidth),
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

  function readInputValue(eventOrValue, fallback) {
    if (typeof eventOrValue === "string") return eventOrValue;
    if (typeof eventOrValue?.target?.value === "string") return eventOrValue.target.value;
    if (typeof eventOrValue?.value === "string") return eventOrValue.value;
    return fallback;
  }

  async function updateSetting(key, rawValue) {
    if (unloaded) return;
    finishDrag(false);
    let nextValue = rawValue;
    if (key === SETTINGS_KEYS.enabled || key === SETTINGS_KEYS.rowDividers) {
      nextValue = normalizeBoolean(rawValue, DEFAULTS[key]);
    }
    if (key === SETTINGS_KEYS.labelWidth) {
      nextValue = normalizeCssLength(rawValue, DEFAULTS.labelWidth);
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

    root.style.setProperty(CSS_VARS.labelWidthSetting, settings.labelWidth);
    for (const depth of appliedNestedDepths) {
      if (!(depth in settings.nestedLabelWidths)) {
        root.style.removeProperty(widthProperty(depth));
        appliedNestedDepths.delete(depth);
      }
    }
    for (const [depth, width] of Object.entries(settings.nestedLabelWidths)) {
      root.style.setProperty(widthProperty(depth), width);
      appliedNestedDepths.add(depth);
    }

    body.classList.toggle(CLASSES.enabled, settings.enabled);
    body.classList.toggle(CLASSES.rowDividers, settings.enabled && settings.rowDividers);
  }

  function clearDocumentSettings() {
    if (typeof document === "undefined") return;

    document.body?.classList.remove(CLASSES.enabled, CLASSES.rowDividers);
    document.documentElement?.style.removeProperty(CSS_VARS.labelWidthSetting);
    appliedNestedDepths.forEach((depth) => {
      document.documentElement.style.removeProperty(widthProperty(depth));
    });
    appliedNestedDepths.clear();
  }

  function findBlockEditor(main) {
    const editor = main?.querySelector?.(EDITOR_SELECTOR);
    return editor && editor.closest?.(".rm-block-main") === main ? editor : null;
  }

  function getAttributeRowDescriptor(block) {
    if (!block?.matches?.(".roam-block-container")) return { eligible: false };
    if (block.closest(INJECTED_SELECTOR)) {
      return { eligible: false };
    }

    const { label: main, values: children } = getRowParts(block);
    if (!main || !children) return { eligible: false };

    const editor = findBlockEditor(main);
    if (editor) {
      const text = editor.value;
      const delimiter = text.indexOf("::");
      if (
        /[\r\n]/.test(text) || delimiter < 1 ||
        !text.slice(0, delimiter).trim() || text.slice(delimiter + 2).trim()
      ) return { eligible: false };
    } else {
      const blockText = directChildMatching(main, ".rm-block-text");
      const attrText = visibleText(blockText?.querySelector(".rm-attr-ref"));
      if (!attrText || visibleText(blockText) !== attrText) return { eligible: false };
    }

    const uid = getBlockUid(block);
    const closed = block.classList.contains("rm-block--closed");

    if (closed) {
      if (!uid) return { eligible: false };

      const summary = resolveClosedRowSummary(uid);
      if (!summary.hasChildren) return { eligible: false };

      return {
        eligible: true,
        closed: true,
        summary,
      };
    }

    const childBlocks = directChildBlocks(children);
    if (childBlocks.length === 0) return { eligible: false };

    if (uid) {
      const summary = buildOpenRowSummary(children);
      if (summary.hasChildren) summaryCache.set(uid, summary);
    }

    return {
      eligible: true,
      closed: false,
      summary: null,
    };
  }

  function collectMainWindowBlocks() {
    if (typeof document === "undefined") return [];

    return document.querySelectorAll(
      ".roam-main .roam-body-main .roam-article .roam-block-container"
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

  function trailingBodyBlocks(container) {
    if (!container?.children) return [];
    return Array.from(container.children).filter((child) =>
      child.hasAttribute?.(TRAILING_BODY_BLOCK_ATTRIBUTE)
    );
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
  }

  function removeFoldedSummaryBlock(values) {
    foldedSummaryBlock(values)?.remove();
  }

  function removeTrailingBodyBlocks(root = document) {
    root
      ?.querySelectorAll?.(`[${TRAILING_BODY_BLOCK_ATTRIBUTE}]`)
      .forEach((block) => block.remove());
  }

  function isHorizontalLayoutActive() {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return true;
    }

    return window.matchMedia(HORIZONTAL_LAYOUT_MEDIA_QUERY).matches;
  }

  function topLevelOutlineContainers() {
    if (typeof document === "undefined") return [];

    return Array.from(
      document.querySelectorAll(
        ".roam-main .roam-body-main .roam-article .rm-block-children.rm-level-0"
      )
    ).filter((container) => !container.closest?.(".roam-block-container"));
  }

  function directTopLevelBlocks(container) {
    return directChildBlocks(container);
  }

  function shouldShowTrailingBodyBlock(container) {
    if (!settings.enabled || creatingTrailingBodyBlock || !isHorizontalLayoutActive()) {
      return false;
    }

    const blocks = directTopLevelBlocks(container);
    if (blocks.length === 0) return false;

    const lastBlock = blocks[blocks.length - 1];
    return lastBlock.classList.contains(CLASSES.row);
  }

  function syncTrailingBodyBlocks() {
    if (typeof document === "undefined") return;

    const containers = topLevelOutlineContainers();
    const liveContainers = new Set(containers);

    document.querySelectorAll(`[${TRAILING_BODY_BLOCK_ATTRIBUTE}]`).forEach((block) => {
      if (!liveContainers.has(block.parentElement)) block.remove();
    });

    containers.forEach((container) => {
      const [existing, ...duplicates] = trailingBodyBlocks(container);
      duplicates.forEach((block) => block.remove());

      if (!shouldShowTrailingBodyBlock(container)) {
        existing?.remove();
        return;
      }

      if (existing) {
        if (existing !== container.lastElementChild) container.append(existing);
        return;
      }

      container.append(createTrailingBodyBlock());
    });
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

  function getVisibleMainWindowTitle() {
    if (typeof document === "undefined") return "";

    const titleElement = document.querySelector(
      ".roam-main .roam-body-main .rm-title-display, " +
        ".roam-main .roam-body-main .rm-title-textarea"
    );

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

  async function getTrailingBodyParentUid(triggerBlock) {
    const openUid = await getOpenPageOrBlockUid();
    if (openUid) return openUid;

    const container = triggerBlock?.parentElement;
    const blocks = directTopLevelBlocks(container);
    const lastRealBlock = blocks[blocks.length - 1];
    const pageUid = pullPageUidForBlockUid(getBlockUid(lastRealBlock));
    if (pageUid) return pageUid;

    const pageTitle = getPageTitleFromBlock(lastRealBlock) || getVisibleMainWindowTitle();

    return pullPageUidByTitle(pageTitle);
  }

  function generateUid() {
    const generate = getRoamAlphaApi()?.util?.generateUID;
    return typeof generate === "function" ? generate() : "";
  }

  async function waitForBlockToRender(uid) {
    if (!uid || typeof document === "undefined") return;

    for (let attempt = 0; !unloaded && attempt < 10; attempt += 1) {
      if (document.querySelector(`[data-block-uid="${uid}"]`)) return;
      await new Promise((resolve) => {
        finishFocusWait = resolve;
        focusTimer = window.setTimeout(resolve, 40);
      });
      finishFocusWait = focusTimer = null;
    }
  }

  async function focusBlock(uid) {
    const uiApi = getRoamUiApi();
    const focus = uiApi?.setBlockFocusAndSelection;
    if (!uid || typeof focus !== "function") return;

    await waitForBlockToRender(uid);
    if (unloaded) return;

    try {
      await focus.call(uiApi, {
        location: {
          "block-uid": uid,
          "window-id": "main-window",
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
    if (creatingTrailingBodyBlock) return;

    creatingTrailingBodyBlock = true;
    block?.setAttribute?.(TRAILING_BODY_PENDING_ATTRIBUTE, "true");

    try {
      const parentUid = await getTrailingBodyParentUid(block);
      if (unloaded) return;
      removeTrailingBodyBlocks();
      const uid = await createTrailingBodyBlockInGraph(parentUid);
      await focusBlock(uid);
    } catch (error) {
      warn("Could not create trailing body block.", error);
    } finally {
      creatingTrailingBodyBlock = false;
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
    return Number(depth) === 0 ? CSS_VARS.labelWidthSetting : `--rc-label-width-depth-${depth}`;
  }

  function saveWidth(depth, width) {
    if (depth === 0) return updateSetting(SETTINGS_KEYS.labelWidth, width || DEFAULTS.labelWidth);

    const widths = { ...settings.nestedLabelWidths };
    if (width) widths[depth] = width;
    else delete widths[depth];
    return updateSetting(SETTINGS_KEYS.nestedLabelWidths, widths);
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
    const pixels = Math.round(Math.min(drag.max, Math.max(drag.min, drag.startWidth + delta)));
    drag.width = delta === 0 ? null : `${pixels}px`;
    document.documentElement.style.setProperty(widthProperty(drag.depth), drag.width || drag.previous);
  }

  function beginDrag(event, handle) {
    if (drag || event.button !== 0 || event.isPrimary === false) return;
    const row = handle.parentElement;
    const { label, values } = getRowParts(row);
    if (!label || !values) return;

    const style = getComputedStyle(row);
    const rtl = style.direction === "rtl";
    const labelRect = label.getBoundingClientRect();
    const valueRect = values.getBoundingClientRect();
    const gap = rtl ? labelRect.left - valueRect.right : valueRect.left - labelRect.right;
    const horizontalPadding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const horizontalBorder = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
    const rowWidth = row.getBoundingClientRect().width - horizontalPadding - horizontalBorder;
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
      min: Math.min(80, available * 0.35),
      max: available - Math.min(150, available * 0.5),
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
      moveDrag(up);
      finishDrag(handle.isConnected);
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
    if (!handle || !settings.enabled || !isHorizontalLayoutActive()) return;
    stopEvent(event);
    if (event.type === "pointerdown") beginDrag(event, handle);
    if (event.type === "dblclick") void saveWidth(Number(handle.parentElement.dataset.rcDepth), null);
  }

  function handleEditorInput(event) {
    if (event.target.matches?.(EDITOR_SELECTOR)) scheduleRefresh();
  }

  function clearRowData(row) {
    ROW_DATA_ATTRIBUTES.forEach((attribute) => row.removeAttribute(attribute));
  }

  function applyRowSummary(row, summary) {
    if (!summary) {
      clearRowData(row);
      return;
    }

    row.setAttribute("data-rc-summary", summary.summary || FALLBACK_SUMMARY);
    row.setAttribute("data-rc-child-count", String(summary.childCount ?? ""));
  }

  function markRow(row, descriptor, depth) {
    const parts = getRowParts(row);
    markedRows.add(row);
    row.classList.toggle(CLASSES.row, true);
    row.classList.toggle(CLASSES.closed, descriptor.closed);
    row.classList.toggle(CLASSES.summaryPending, Boolean(descriptor.summary?.pending));
    parts.label.classList.toggle(CLASSES.label, true);
    parts.values.classList.toggle(CLASSES.values, true);
    if (row.dataset.rcDepth !== String(depth)) row.dataset.rcDepth = String(depth);
    if (depth) {
      row.style.setProperty(
        "--rc-row-label-width",
        `var(${widthProperty(depth)}, min(var(--rc-label-width), 38%))`
      );
    } else {
      row.style.removeProperty("--rc-row-label-width");
    }
    ensureResizer(row);

    if (descriptor.closed) {
      applyRowSummary(row, descriptor.summary);
      ensureFoldedSummaryBlock(parts.values, descriptor.summary);
    } else {
      clearRowData(row);
      removeFoldedSummaryBlock(parts.values);
    }
  }

  function unmarkRow(row) {
    const parts = getRowParts(row);
    markedRows.delete(row);
    row.classList.remove(CLASSES.row, CLASSES.closed, CLASSES.summaryPending);
    clearRowData(row);
    delete row.dataset.rcDepth;
    row.style.removeProperty("--rc-row-label-width");
    directChildMatching(row, `[${RESIZER_ATTRIBUTE}]`)?.remove();
    removeFoldedSummaryBlock(parts.values);
    parts.label?.classList.remove(CLASSES.label);
    parts.values?.classList.remove(CLASSES.values);
  }

  function clearStrayPartMarks() {
    document.querySelectorAll(`.${CLASSES.label}, .${CLASSES.values}`).forEach((element) => {
      if (!element.parentElement?.classList.contains(CLASSES.row)) {
        element.classList.remove(CLASSES.label, CLASSES.values);
      }
    });
    document.querySelectorAll(`[${FOLDED_SUMMARY_BLOCK_ATTRIBUTE}]`).forEach((element) => {
      if (!element.parentElement?.matches(`.${CLASSES.row}.${CLASSES.closed} > .rm-block-children`)) {
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
    const childDepths = new WeakMap();
    activeClosedRowUids.clear();
    // querySelectorAll visits parents first. Ordinary blocks pass the depth through.
    for (const block of collectMainWindowBlocks()) {
      const parent = block.parentElement?.closest(".roam-block-container");
      const depth = childDepths.get(parent) || 0;
      const descriptor = getAttributeRowDescriptor(block);
      childDepths.set(block, depth + Number(descriptor.eligible));
      if (!descriptor.eligible) continue;
      candidates.set(block, { descriptor, depth });
      if (descriptor.closed) activeClosedRowUids.add(getBlockUid(block));
    }
    markedRows.forEach((row) => {
      if (!candidates.has(row)) unmarkRow(row);
    });
    candidates.forEach(({ descriptor, depth }, row) => markRow(row, descriptor, depth));
    summaryWatches.forEach((_, uid) => {
      if (!activeClosedRowUids.has(uid)) removeClosedRowWatch(uid);
    });
    activeClosedRowUids.forEach((uid) => void ensureClosedRowWatch(uid));
    clearStrayPartMarks();
    syncTrailingBodyBlocks();
  }

  function scheduleRefresh() {
    if (unloaded || drag || refreshTimeout !== null) return;
    refreshTimeout = window.setTimeout(refreshRows, 80);
  }

  function clearRowMarks() {
    if (typeof document === "undefined") return;
    markedRows.forEach(unmarkRow);
    document.querySelectorAll(`.${CLASSES.row}, [data-rc-depth]`).forEach(unmarkRow);
    clearStrayPartMarks();
    removeTrailingBodyBlocks();
    removeAllClosedRowWatches();
  }

  function handleResize() {
    if (drag && !isHorizontalLayoutActive()) finishDrag(false);
    scheduleRefresh();
  }

  function startLayoutListeners() {
    const options = { capture: true, signal: layoutListeners.signal };
    window.addEventListener("resize", handleResize, { signal: layoutListeners.signal });
    for (const event of ["pointerdown", "mousedown", "click", "dblclick"]) {
      document.addEventListener(event, handleDividerEvent, options);
    }
    document.addEventListener("input", handleEditorInput, options);
  }

  function startObserver() {
    if (typeof MutationObserver === "undefined" || typeof document === "undefined") return;

    // The main window can itself be replaced during navigation.
    const target = document.body;
    if (!target) return;

    mutationObserver = new MutationObserver((records) => {
      if (drag && !drag.handle.isConnected) finishDrag(false);
      if (drag) return;
      const changed = records.some((record) => {
        const element = record.target.nodeType === Node.ELEMENT_NODE
          ? record.target : record.target.parentElement;
        if (element?.closest(INJECTED_SELECTOR)) return false;
        if (!element?.closest(".roam-main")) {
          if (record.type !== "childList") return false;
          return [...record.addedNodes, ...record.removedNodes].some((node) =>
            node.matches?.(".roam-main") || node.querySelector?.(".roam-main")
          );
        }
        if (record.type !== "childList" || record.removedNodes.length) return true;
        return Array.from(record.addedNodes).some((node) => !node.matches?.(INJECTED_SELECTOR));
      });
      if (changed) scheduleRefresh();
    });

    mutationObserver.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
      attributeFilter: ["class", "data-block-uid", "data-page-links"],
    });
  }

  async function createSettingsPanel() {
    const createPanel = extensionAPI?.settings?.panel?.create;
    if (typeof createPanel !== "function") return;

    const panelConfig = {
      tabTitle: "Roam Attribute Columns",
      settings: [
        {
          id: SETTINGS_KEYS.enabled,
          name: "Enable horizontal attributes",
          description: "Align attribute labels and child blocks in a two-column view.",
          action: {
            type: "switch",
            onChange: (eventOrValue) => {
              void updateSetting(
                SETTINGS_KEYS.enabled,
                readSwitchValue(eventOrValue, settings.enabled)
              );
            },
          },
        },
        {
          id: SETTINGS_KEYS.labelWidth,
          name: "Label column width",
          description: "Top-level label width (default 18rem). Drag a divider to resize its level, " +
            "or double-click to reset it.",
          action: {
            type: "input",
            placeholder: DEFAULTS.labelWidth,
            onChange: (eventOrValue) => {
              void updateSetting(
                SETTINGS_KEYS.labelWidth,
                readInputValue(eventOrValue, settings.labelWidth)
              );
            },
          },
        },
        {
          id: "resetColumnWidths",
          name: "Reset column widths",
          description: "Restore the top-level width and all nested widths.",
          action: {
            type: "button",
            content: "Reset column widths",
            onClick: () => Promise.all([
              saveWidth(0, null),
              updateSetting(SETTINGS_KEYS.nestedLabelWidths, {}),
            ]),
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
    await setSettingDefault(SETTINGS_KEYS.labelWidth, DEFAULTS.labelWidth);
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

    layoutListeners.abort();
    removeCommand();
    clearRowMarks();
    clearDocumentSettings();
    summaryCache.clear();

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
