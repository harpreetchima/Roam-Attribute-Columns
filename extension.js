const GLOBAL_KEY = "__roamAttributeColumns";
const COMMAND_LABEL = "Roam Attribute Columns: Toggle horizontal attributes";
const SUMMARY_PULL_PATTERN = "[:block/uid {:block/children ...}]";
const FALLBACK_SUMMARY = "Blocks folded";
const FOLDED_SUMMARY_BLOCK_ATTRIBUTE = "data-rc-folded-summary-block";
const TRAILING_BODY_BLOCK_ATTRIBUTE = "data-rc-trailing-body-block";
const TRAILING_BODY_PENDING_ATTRIBUTE = "data-rc-trailing-body-pending";
const HORIZONTAL_LAYOUT_MEDIA_QUERY = "(min-width: 900px)";

const SETTINGS_KEYS = {
  enabled: "enabled",
  labelWidth: "labelWidth",
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
  let resizeListenerAttached = false;

  let settings = {
    ...DEFAULTS,
  };

  const summaryCache = new Map();

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
      !child.hasAttribute?.(FOLDED_SUMMARY_BLOCK_ATTRIBUTE) &&
      !child.hasAttribute?.(TRAILING_BODY_BLOCK_ATTRIBUTE)
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
    return `${count} ${count === 1 ? "block" : "blocks"} folded`;
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
      (block) => !block.hasAttribute?.(FOLDED_SUMMARY_BLOCK_ATTRIBUTE)
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
    const count = countPulledDescendants(blockData);
    if (!Number.isFinite(count)) return null;
    return buildSummaryFromCount(count);
  }

  function pullClosedRowSummary(uid) {
    const api = typeof window !== "undefined" ? window.roamAlphaAPI : null;
    const dataApi = api?.data;
    const pull = dataApi?.pull || api?.pull;
    if (typeof pull !== "function") return null;

    try {
      const blockData = pull.call(dataApi || api, SUMMARY_PULL_PATTERN, [":block/uid", uid]);
      return buildApiRowSummary(blockData);
    } catch (error) {
      warn(`Could not pull folded row summary for block ${uid}.`, error);
      return null;
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
    const summary = pullClosedRowSummary(uid);
    if (summary) {
      summaryCache.set(uid, summary);
      return summary;
    }

    return fallbackClosedSummary(uid);
  }

  function getSetting(key) {
    try {
      return extensionAPI?.settings?.get?.(key);
    } catch (error) {
      warn(`Could not read setting "${key}".`, error);
      return undefined;
    }
  }

  async function setSetting(key, value) {
    try {
      const result = extensionAPI?.settings?.set?.(key, value);
      if (result && typeof result.then === "function") await result;
    } catch (error) {
      warn(`Could not save setting "${key}".`, error);
    }
  }

  async function setSettingDefault(key, value) {
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
    const candidate = String(value || "").trim();
    if (!candidate) return fallback;

    try {
      if (typeof CSS !== "undefined" && CSS.supports?.("width", candidate)) {
        return candidate;
      }
    } catch (_) {}

    return fallback;
  }

  function readSettings() {
    settings = {
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
    let nextValue = rawValue;
    if (key === SETTINGS_KEYS.enabled || key === SETTINGS_KEYS.rowDividers) {
      nextValue = normalizeBoolean(rawValue, DEFAULTS[key]);
    }
    if (key === SETTINGS_KEYS.labelWidth) {
      nextValue = normalizeCssLength(rawValue, DEFAULTS.labelWidth);
    }

    settings[key] = nextValue;
    await setSetting(key, nextValue);
    applyDocumentSettings();
    scheduleRefresh();
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

    body.classList.toggle(CLASSES.enabled, settings.enabled);
    body.classList.toggle(CLASSES.rowDividers, settings.enabled && settings.rowDividers);

    if (!settings.enabled) clearRowMarks();
  }

  function clearDocumentSettings() {
    if (typeof document === "undefined") return;

    document.body?.classList.remove(CLASSES.enabled, CLASSES.rowDividers);
    document.documentElement?.style.removeProperty(CSS_VARS.labelWidthSetting);
  }

  function getAttributeRowDescriptor(block) {
    if (!block?.matches?.(".roam-block-container")) return { eligible: false };
    if (
      block.hasAttribute?.(FOLDED_SUMMARY_BLOCK_ATTRIBUTE) ||
      block.hasAttribute?.(TRAILING_BODY_BLOCK_ATTRIBUTE)
    ) {
      return { eligible: false };
    }

    const main = directChildMatching(block, ".rm-block-main");
    const children = directChildMatching(block, ".rm-block-children");
    if (!main || !children) return { eligible: false };

    const blockText = directChildMatching(main, ".rm-block-text");
    const attrRef = blockText?.querySelector?.(".rm-attr-ref");
    if (!blockText || !attrRef) return { eligible: false };

    const parentText = visibleText(blockText);
    const attrText = visibleText(attrRef);
    if (!attrText || parentText !== attrText) return { eligible: false };

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

    const roots = Array.from(
      document.querySelectorAll(".roam-main .roam-body-main .roam-article")
    );
    const seen = new Set();
    const blocks = [];

    roots.forEach((root) => {
      root.querySelectorAll(".roam-block-container").forEach((block) => {
        if (!seen.has(block)) {
          seen.add(block);
          blocks.push(block);
        }
      });
    });

    return blocks;
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
    if (!container?.children) return [];

    return Array.from(container.children).filter(
      (child) =>
        child.matches?.(".roam-block-container") &&
        !child.hasAttribute?.(TRAILING_BODY_BLOCK_ATTRIBUTE)
    );
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

  function generateUid() {
    const generate = getRoamAlphaApi()?.util?.generateUID;
    return typeof generate === "function" ? generate() : "";
  }

  function delay(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  async function waitForBlockToRender(uid) {
    if (!uid || typeof document === "undefined") return;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (document.querySelector(`[data-block-uid="${uid}"]`)) return;
      await delay(40);
    }
  }

  async function focusBlock(uid) {
    const uiApi = getRoamUiApi();
    const focus = uiApi?.setBlockFocusAndSelection;
    if (!uid || typeof focus !== "function") return;

    await waitForBlockToRender(uid);

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

  async function createTrailingBodyBlockInGraph() {
    const dataApi = getRoamDataApi();
    const createBlock = dataApi?.block?.create;
    if (typeof createBlock !== "function") {
      throw new Error("Roam block creation API is unavailable.");
    }

    const parentUid = await getOpenPageOrBlockUid();
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
    removeTrailingBodyBlocks();

    try {
      const uid = await createTrailingBodyBlockInGraph();
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

  function markRow(row, descriptor) {
    const parts = getRowParts(row);
    row.classList.add(CLASSES.row);
    row.classList.toggle(CLASSES.closed, Boolean(descriptor?.closed));
    row.classList.toggle(CLASSES.summaryPending, Boolean(descriptor?.summary?.pending));
    parts.label?.classList.add(CLASSES.label);
    parts.values?.classList.add(CLASSES.values);

    if (descriptor?.closed) {
      applyRowSummary(row, descriptor.summary);
      ensureFoldedSummaryBlock(parts.values, descriptor.summary);
    } else {
      clearRowData(row);
      removeFoldedSummaryBlock(parts.values);
    }
  }

  function unmarkRow(row) {
    const parts = getRowParts(row);
    row.classList.remove(CLASSES.row, CLASSES.closed, CLASSES.summaryPending);
    clearRowData(row);
    removeFoldedSummaryBlock(parts.values);
    parts.label?.classList.remove(CLASSES.label);
    parts.values?.classList.remove(CLASSES.values);
  }

  function clearStrayPartMarks() {
    document
      .querySelectorAll(`.${CLASSES.label}, .${CLASSES.values}`)
      .forEach((element) => {
        if (!element.closest?.(`.${CLASSES.row}`)) {
          element.classList.remove(CLASSES.label, CLASSES.values);
        }
      });
    document.querySelectorAll(`[${FOLDED_SUMMARY_BLOCK_ATTRIBUTE}]`).forEach((element) => {
      if (!element.closest?.(`.${CLASSES.row}`)) element.remove();
    });
  }

  function refreshRows() {
    refreshTimeout = null;
    if (unloaded) return;

    readSettings();
    applyDocumentSettings();

    if (!settings.enabled) {
      clearRowMarks();
      return;
    }

    const blocks = collectMainWindowBlocks();
    const eligibilityCache = new WeakMap();
    const candidateRows = new Map();

    const getDescriptorCached = (block) => {
      if (!eligibilityCache.has(block)) {
        eligibilityCache.set(block, getAttributeRowDescriptor(block));
      }
      return eligibilityCache.get(block);
    };

    const isEligibleCached = (block) => Boolean(getDescriptorCached(block).eligible);

    const hasEligibleAttributeAncestor = (block) => {
      let ancestor = block.parentElement?.closest?.(".roam-block-container");
      while (ancestor) {
        if (isEligibleCached(ancestor)) return true;
        ancestor = ancestor.parentElement?.closest?.(".roam-block-container");
      }
      return false;
    };

    blocks.forEach((block) => {
      const descriptor = getDescriptorCached(block);
      if (descriptor.eligible && !hasEligibleAttributeAncestor(block)) {
        candidateRows.set(block, descriptor);
      }
    });

    document.querySelectorAll(`.${CLASSES.row}`).forEach((row) => {
      if (!candidateRows.has(row)) unmarkRow(row);
    });

    candidateRows.forEach((descriptor, row) => {
      markRow(row, descriptor);
    });

    clearStrayPartMarks();
    syncTrailingBodyBlocks();
  }

  function scheduleRefresh() {
    if (unloaded || refreshTimeout !== null) return;
    refreshTimeout = window.setTimeout(refreshRows, 80);
  }

  function clearRowMarks() {
    if (typeof document === "undefined") return;
    document.querySelectorAll(`.${CLASSES.row}`).forEach((row) => {
      unmarkRow(row);
    });
    document
      .querySelectorAll(`.${CLASSES.label}, .${CLASSES.values}`)
      .forEach((element) => {
        element.classList.remove(CLASSES.label, CLASSES.values);
      });
    document.querySelectorAll(`[${FOLDED_SUMMARY_BLOCK_ATTRIBUTE}]`).forEach((element) => {
      element.remove();
    });
    removeTrailingBodyBlocks();
  }

  function handleResize() {
    scheduleRefresh();
  }

  function startResizeListener() {
    if (typeof window === "undefined" || resizeListenerAttached) return;
    window.addEventListener("resize", handleResize);
    resizeListenerAttached = true;
  }

  function stopResizeListener() {
    if (typeof window === "undefined" || !resizeListenerAttached) return;
    window.removeEventListener("resize", handleResize);
    resizeListenerAttached = false;
  }

  function startObserver() {
    if (typeof MutationObserver === "undefined" || typeof document === "undefined") return;

    const target = document.querySelector(".roam-main") || document.body;
    if (!target) return;

    mutationObserver = new MutationObserver(() => {
      scheduleRefresh();
    });

    mutationObserver.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
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
          description: "CSS width for the left property column. Default: 18rem.",
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

    readSettings();
    await createSettingsPanel();
    await registerCommand();

    applyDocumentSettings();
    startObserver();
    startResizeListener();
    scheduleRefresh();

    console.log("[Roam Attribute Columns] Loaded.");
  }

  function unload() {
    unloaded = true;

    if (refreshTimeout !== null) {
      window.clearTimeout(refreshTimeout);
      refreshTimeout = null;
    }

    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }

    stopResizeListener();
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
