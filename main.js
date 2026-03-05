var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => CriticTrackPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var import_view = require("@codemirror/view");
var import_state = require("@codemirror/state");
var DEFAULT_SETTINGS = {
  timestampFormat: "YYYY-MM-DD HH:mm",
  enableTimestamp: false,
  authorTag: "",
  enableAuthorTag: false
};
function formatTimestamp(fmt) {
  const now = /* @__PURE__ */ new Date();
  const pad = (n) => n.toString().padStart(2, "0");
  return fmt.replace("YYYY", now.getFullYear().toString()).replace("MM", pad(now.getMonth() + 1)).replace("DD", pad(now.getDate())).replace("HH", pad(now.getHours())).replace("mm", pad(now.getMinutes())).replace("ss", pad(now.getSeconds()));
}
function makeMetaComment(settings) {
  const parts = [];
  if (settings.enableTimestamp) {
    parts.push(formatTimestamp(settings.timestampFormat));
  }
  if (settings.enableAuthorTag && settings.authorTag) {
    parts.push("@" + settings.authorTag);
  }
  if (parts.length === 0)
    return "";
  return "{>>" + parts.join(" ") + "<<}";
}
function findAllCriticMarkup(text) {
  const matches = [];
  for (const m of text.matchAll(/\{\+\+([\s\S]+?)\+\+\}/g)) {
    matches.push({
      type: "addition",
      from: m.index,
      to: m.index + m[0].length,
      fullMatch: m[0],
      content: m[1]
    });
  }
  for (const m of text.matchAll(/\{--([\s\S]+?)--\}/g)) {
    matches.push({
      type: "deletion",
      from: m.index,
      to: m.index + m[0].length,
      fullMatch: m[0],
      content: m[1]
    });
  }
  for (const m of text.matchAll(/\{~~([\s\S]+?)~>([\s\S]+?)~~\}/g)) {
    matches.push({
      type: "substitution",
      from: m.index,
      to: m.index + m[0].length,
      fullMatch: m[0],
      oldContent: m[1],
      newContent: m[2]
    });
  }
  for (const m of text.matchAll(/\{>>([\s\S]+?)<<\}/g)) {
    matches.push({
      type: "comment",
      from: m.index,
      to: m.index + m[0].length,
      fullMatch: m[0],
      content: m[1]
    });
  }
  for (const m of text.matchAll(/\{==([\s\S]+?)==\}/g)) {
    matches.push({
      type: "highlight",
      from: m.index,
      to: m.index + m[0].length,
      fullMatch: m[0],
      content: m[1]
    });
  }
  matches.sort((a, b) => a.from - b.from);
  const filtered = [];
  let lastEnd = -1;
  for (const m of matches) {
    if (m.from >= lastEnd) {
      filtered.push(m);
      lastEnd = m.to;
    }
  }
  return filtered;
}
function isPartOfCriticMarkup(doc, charOffset) {
  const matches = findAllCriticMarkup(doc);
  for (const m of matches) {
    if (charOffset >= m.from && charOffset < m.to) {
      return true;
    }
  }
  return false;
}
var AcceptRejectWidget = class extends import_view.WidgetType {
  constructor(matchFrom, matchTo, acceptText, rejectText) {
    super();
    this.matchFrom = matchFrom;
    this.matchTo = matchTo;
    this.acceptText = acceptText;
    this.rejectText = rejectText;
  }
  toDOM(view) {
    const container = document.createElement("span");
    container.className = "critic-track-actions";
    const acceptBtn = document.createElement("span");
    acceptBtn.className = "critic-track-btn critic-track-accept-btn";
    acceptBtn.textContent = "\u2713";
    acceptBtn.title = "Accept";
    acceptBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      view.dispatch({
        changes: {
          from: this.matchFrom,
          to: this.matchTo,
          insert: this.acceptText
        }
      });
    });
    const rejectBtn = document.createElement("span");
    rejectBtn.className = "critic-track-btn critic-track-reject-btn";
    rejectBtn.textContent = "\u2717";
    rejectBtn.title = "Reject";
    rejectBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      view.dispatch({
        changes: {
          from: this.matchFrom,
          to: this.matchTo,
          insert: this.rejectText
        }
      });
    });
    container.appendChild(acceptBtn);
    container.appendChild(rejectBtn);
    return container;
  }
  eq(other) {
    return this.matchFrom === other.matchFrom && this.matchTo === other.matchTo && this.acceptText === other.acceptText && this.rejectText === other.rejectText;
  }
  ignoreEvent() {
    return false;
  }
};
function buildDecorations(view) {
  const isLivePreview = view.state.field(import_obsidian.editorLivePreviewField);
  const text = view.state.doc.toString();
  const matches = findAllCriticMarkup(text);
  const decos = [];
  for (const match of matches) {
    switch (match.type) {
      case "addition": {
        const openEnd = match.from + 3;
        const closeStart = match.to - 3;
        if (isLivePreview) {
          decos.push({ from: match.from, to: openEnd, deco: import_view.Decoration.replace({}) });
          decos.push({
            from: openEnd,
            to: closeStart,
            deco: import_view.Decoration.mark({ class: "critic-track-addition" })
          });
          decos.push({ from: closeStart, to: match.to, deco: import_view.Decoration.replace({}) });
          decos.push({
            from: match.to,
            to: match.to,
            deco: import_view.Decoration.widget({
              widget: new AcceptRejectWidget(match.from, match.to, match.content || "", ""),
              side: 1
            })
          });
        } else {
          decos.push({
            from: match.from,
            to: match.to,
            deco: import_view.Decoration.mark({ class: "critic-track-addition-source" })
          });
        }
        break;
      }
      case "deletion": {
        const openEnd = match.from + 3;
        const closeStart = match.to - 3;
        if (isLivePreview) {
          decos.push({ from: match.from, to: openEnd, deco: import_view.Decoration.replace({}) });
          decos.push({
            from: openEnd,
            to: closeStart,
            deco: import_view.Decoration.mark({ class: "critic-track-deletion" })
          });
          decos.push({ from: closeStart, to: match.to, deco: import_view.Decoration.replace({}) });
          decos.push({
            from: match.to,
            to: match.to,
            deco: import_view.Decoration.widget({
              widget: new AcceptRejectWidget(match.from, match.to, "", match.content || ""),
              side: 1
            })
          });
        } else {
          decos.push({
            from: match.from,
            to: match.to,
            deco: import_view.Decoration.mark({ class: "critic-track-deletion-source" })
          });
        }
        break;
      }
      case "substitution": {
        const openEnd = match.from + 3;
        const arrowIdx = match.fullMatch.indexOf("~>");
        const arrowFrom = match.from + arrowIdx;
        const arrowTo = arrowFrom + 2;
        const closeStart = match.to - 3;
        if (isLivePreview) {
          decos.push({ from: match.from, to: openEnd, deco: import_view.Decoration.replace({}) });
          decos.push({
            from: openEnd,
            to: arrowFrom,
            deco: import_view.Decoration.mark({ class: "critic-track-deletion" })
          });
          decos.push({ from: arrowFrom, to: arrowTo, deco: import_view.Decoration.replace({}) });
          decos.push({
            from: arrowTo,
            to: closeStart,
            deco: import_view.Decoration.mark({ class: "critic-track-addition" })
          });
          decos.push({ from: closeStart, to: match.to, deco: import_view.Decoration.replace({}) });
          decos.push({
            from: match.to,
            to: match.to,
            deco: import_view.Decoration.widget({
              widget: new AcceptRejectWidget(
                match.from,
                match.to,
                match.newContent || "",
                match.oldContent || ""
              ),
              side: 1
            })
          });
        } else {
          decos.push({
            from: match.from,
            to: match.to,
            deco: import_view.Decoration.mark({ class: "critic-track-substitution-source" })
          });
        }
        break;
      }
      case "comment": {
        const openEnd = match.from + 3;
        const closeStart = match.to - 3;
        if (isLivePreview) {
          decos.push({ from: match.from, to: openEnd, deco: import_view.Decoration.replace({}) });
          decos.push({
            from: openEnd,
            to: closeStart,
            deco: import_view.Decoration.mark({ class: "critic-track-comment" })
          });
          decos.push({ from: closeStart, to: match.to, deco: import_view.Decoration.replace({}) });
        } else {
          decos.push({
            from: match.from,
            to: match.to,
            deco: import_view.Decoration.mark({ class: "critic-track-comment-source" })
          });
        }
        break;
      }
      case "highlight": {
        const openEnd = match.from + 3;
        const closeStart = match.to - 3;
        if (isLivePreview) {
          decos.push({ from: match.from, to: openEnd, deco: import_view.Decoration.replace({}) });
          decos.push({
            from: openEnd,
            to: closeStart,
            deco: import_view.Decoration.mark({ class: "critic-track-highlight" })
          });
          decos.push({ from: closeStart, to: match.to, deco: import_view.Decoration.replace({}) });
        } else {
          decos.push({
            from: match.from,
            to: match.to,
            deco: import_view.Decoration.mark({ class: "critic-track-highlight-source" })
          });
        }
        break;
      }
    }
  }
  decos.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new import_state.RangeSetBuilder();
  for (const d of decos) {
    if (d.from <= d.to && d.from >= 0 && d.to <= text.length) {
      builder.add(d.from, d.to, d.deco);
    }
  }
  return builder.finish();
}
var criticMarkupViewPlugin = import_view.ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildDecorations(view);
    }
    update(update) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations
  }
);
function criticMarkupPostProcessor(el, ctx) {
  var _a;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodesToReplace = [];
  const criticRegex = /\{\+\+([\s\S]+?)\+\+\}|\{--([\s\S]+?)--\}|\{~~([\s\S]+?)~>([\s\S]+?)~~\}|\{>>([\s\S]+?)<<\}|\{==([\s\S]+?)==\}/g;
  let textNode;
  while (textNode = walker.nextNode()) {
    const text = textNode.textContent || "";
    if (!criticRegex.test(text)) {
      criticRegex.lastIndex = 0;
      continue;
    }
    criticRegex.lastIndex = 0;
    const html = text.replace(
      criticRegex,
      (_match, add, del, subOld, subNew, comment, highlight) => {
        if (add !== void 0) {
          return '<span class="critic-track-addition">' + escapeHtml(add) + "</span>";
        }
        if (del !== void 0) {
          return '<span class="critic-track-deletion">' + escapeHtml(del) + "</span>";
        }
        if (subOld !== void 0 && subNew !== void 0) {
          return '<span class="critic-track-deletion">' + escapeHtml(subOld) + '</span><span class="critic-track-addition">' + escapeHtml(subNew) + "</span>";
        }
        if (comment !== void 0) {
          return '<span class="critic-track-comment">' + escapeHtml(comment) + "</span>";
        }
        if (highlight !== void 0) {
          return '<span class="critic-track-highlight">' + escapeHtml(highlight) + "</span>";
        }
        return _match;
      }
    );
    if (html !== text) {
      nodesToReplace.push({ node: textNode, html });
    }
  }
  for (const { node, html } of nodesToReplace) {
    const wrapper = document.createElement("span");
    wrapper.innerHTML = html;
    (_a = node.parentNode) == null ? void 0 : _a.replaceChild(wrapper, node);
  }
}
function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
var VIEW_TYPE_CHANGES = "critic-track-changes";
var ChangesView = class extends import_obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.refreshTimer = null;
    this.plugin = plugin;
  }
  getViewType() {
    return VIEW_TYPE_CHANGES;
  }
  getDisplayText() {
    return "Tracked Changes";
  }
  getIcon() {
    return "pencil";
  }
  async onOpen() {
    this.renderChanges();
    this.registerEvent(
      this.app.workspace.on("editor-change", () => this.scheduleRefresh())
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.renderChanges())
    );
  }
  async onClose() {
    if (this.refreshTimer)
      clearTimeout(this.refreshTimer);
  }
  scheduleRefresh() {
    if (this.refreshTimer)
      clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.renderChanges(), 300);
  }
  renderChanges() {
    const container = this.contentEl;
    container.empty();
    const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
    if (!view) {
      container.createEl("div", {
        text: "No active document",
        cls: "critic-track-panel-empty"
      });
      return;
    }
    const doc = view.editor.getValue();
    const changes = findAllCriticMarkup(doc);
    const actionable = changes.filter(
      (c) => c.type === "addition" || c.type === "deletion" || c.type === "substitution"
    );
    if (actionable.length === 0) {
      container.createEl("div", {
        text: "No tracked changes",
        cls: "critic-track-panel-empty"
      });
      return;
    }
    const header = container.createEl("div", { cls: "critic-track-panel-header" });
    header.createEl("span", {
      text: actionable.length + " change" + (actionable.length > 1 ? "s" : ""),
      cls: "critic-track-panel-count"
    });
    const headerBtns = header.createEl("div", { cls: "critic-track-panel-header-btns" });
    const acceptAllBtn = headerBtns.createEl("button", {
      cls: "critic-track-panel-btn critic-track-panel-btn-accept"
    });
    acceptAllBtn.textContent = "Accept All";
    acceptAllBtn.addEventListener("click", () => {
      this.plugin.acceptAllChanges();
      this.renderChanges();
    });
    const rejectAllBtn = headerBtns.createEl("button", {
      cls: "critic-track-panel-btn critic-track-panel-btn-reject"
    });
    rejectAllBtn.textContent = "Reject All";
    rejectAllBtn.addEventListener("click", () => {
      this.plugin.rejectAllChanges();
      this.renderChanges();
    });
    const list = container.createEl("div", { cls: "critic-track-panel-list" });
    for (let i = 0; i < actionable.length; i++) {
      const change = actionable[i];
      const item = list.createEl("div", { cls: "critic-track-panel-item" });
      const typeBadge = item.createEl("span", {
        cls: "critic-track-panel-badge critic-track-panel-badge-" + change.type
      });
      typeBadge.textContent = change.type === "addition" ? "+" : change.type === "deletion" ? "\u2212" : "\u223C";
      const content = item.createEl("div", { cls: "critic-track-panel-content" });
      if (change.type === "substitution") {
        const oldEl = content.createEl("span", { cls: "critic-track-panel-del-text" });
        oldEl.textContent = truncate(change.oldContent || "", 50);
        content.createEl("span", { text: " \u2192 ", cls: "critic-track-panel-arrow" });
        const newEl = content.createEl("span", { cls: "critic-track-panel-add-text" });
        newEl.textContent = truncate(change.newContent || "", 50);
      } else {
        const textEl = content.createEl("span", {
          cls: change.type === "addition" ? "critic-track-panel-add-text" : "critic-track-panel-del-text"
        });
        textEl.textContent = truncate(change.content || "", 80);
      }
      const actions = item.createEl("div", { cls: "critic-track-panel-item-actions" });
      const acceptBtn = actions.createEl("button", {
        cls: "critic-track-panel-btn-sm critic-track-panel-btn-accept",
        title: "Accept"
      });
      acceptBtn.textContent = "\u2713";
      acceptBtn.addEventListener("click", () => {
        this.plugin.applyChangeByIndex(i, "accept");
        this.renderChanges();
      });
      const rejectBtn = actions.createEl("button", {
        cls: "critic-track-panel-btn-sm critic-track-panel-btn-reject",
        title: "Reject"
      });
      rejectBtn.textContent = "\u2717";
      rejectBtn.addEventListener("click", () => {
        this.plugin.applyChangeByIndex(i, "reject");
        this.renderChanges();
      });
      item.addEventListener("click", (e) => {
        if (e.target.tagName === "BUTTON")
          return;
        const editor = view.editor;
        const pos = this.plugin.offsetToPos(editor, change.from);
        editor.setCursor(pos);
        editor.focus();
      });
    }
  }
};
function truncate(str, max) {
  if (str.length <= max)
    return str;
  return str.slice(0, max) + "\u2026";
}
var CriticTrackPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.settings = DEFAULT_SETTINGS;
    this.tracking = false;
    this.statusBarEl = null;
    this.intercepting = false;
    this.composing = false;
    this.session = null;
  }
  async onload() {
    await this.loadSettings();
    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar();
    this.registerView(VIEW_TYPE_CHANGES, (leaf) => new ChangesView(leaf, this));
    this.addCommand({
      id: "toggle-tracking",
      name: "Toggle revision tracking",
      icon: "pencil",
      callback: () => this.toggleTracking()
    });
    this.addCommand({
      id: "accept-all",
      name: "Accept all changes",
      callback: () => this.acceptAllChanges()
    });
    this.addCommand({
      id: "reject-all",
      name: "Reject all changes",
      callback: () => this.rejectAllChanges()
    });
    this.addCommand({
      id: "accept-at-cursor",
      name: "Accept change at cursor",
      callback: () => this.acceptChangeAtCursor()
    });
    this.addCommand({
      id: "reject-at-cursor",
      name: "Reject change at cursor",
      callback: () => this.rejectChangeAtCursor()
    });
    this.addCommand({
      id: "add-comment",
      name: "Add comment at selection",
      callback: () => this.addComment()
    });
    this.addCommand({
      id: "show-changes-panel",
      name: "Show tracked changes panel",
      callback: () => this.activateChangesPanel()
    });
    this.addRibbonIcon(
      "pencil",
      "Toggle revision tracking",
      () => this.toggleTracking()
    );
    this.addSettingTab(new CriticTrackSettingTab(this.app, this));
    this.registerEditorExtension(criticMarkupViewPlugin);
    this.registerMarkdownPostProcessor(criticMarkupPostProcessor);
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        if (this.tracking) {
          menu.addItem(
            (item) => item.setTitle("Accept change at cursor").setIcon("check").onClick(() => this.acceptChangeAtCursor())
          );
          menu.addItem(
            (item) => item.setTitle("Reject change at cursor").setIcon("x").onClick(() => this.rejectChangeAtCursor())
          );
          menu.addSeparator();
        }
        menu.addItem(
          (item) => item.setTitle(this.tracking ? "Stop tracking" : "Start tracking").setIcon("pencil").onClick(() => this.toggleTracking())
        );
      })
    );
    this.registerDomEvent(
      document,
      "compositionstart",
      () => {
        this.composing = true;
      },
      true
    );
    this.registerDomEvent(
      document,
      "compositionend",
      (evt) => {
        this.composing = false;
        if (!this.tracking || this.intercepting)
          return;
        const text = evt.data;
        if (!text)
          return;
        const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
        if (!view || view.getMode() !== "source")
          return;
        this.intercepting = true;
        try {
          this.handleCompositionInsert(view.editor, text);
        } finally {
          this.intercepting = false;
        }
      },
      true
    );
    this.registerDomEvent(
      document,
      "keydown",
      (evt) => this.handleKeydown(evt),
      true
    );
  }
  onunload() {
    this.finalizeSession();
  }
  async activateChangesPanel() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHANGES);
    if (existing.length) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const rightLeaf = this.app.workspace.getRightLeaf(false);
    if (rightLeaf) {
      await rightLeaf.setViewState({ type: VIEW_TYPE_CHANGES, active: true });
      this.app.workspace.revealLeaf(rightLeaf);
    }
  }
  toggleTracking() {
    this.finalizeSession();
    this.tracking = !this.tracking;
    this.updateStatusBar();
    new import_obsidian.Notice(this.tracking ? "Revision tracking ON" : "Revision tracking OFF");
  }
  updateStatusBar() {
    if (this.statusBarEl) {
      this.statusBarEl.setText(this.tracking ? "Tracking" : "");
      if (this.tracking) {
        this.statusBarEl.addClass("critic-track-active");
      } else {
        this.statusBarEl.removeClass("critic-track-active");
      }
    }
  }
  // ── Session management ───────────────────────────────────────────────────
  finalizeSession() {
    if (!this.session)
      return;
    const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
    if (!view) {
      this.session = null;
      return;
    }
    const editor = view.editor;
    const closeLine = this.session.startLine;
    const closeCh = this.session.startCh + 3 + this.session.content.length;
    const closePos = { line: closeLine, ch: closeCh };
    const closing = "++}" + this.session.meta;
    this.intercepting = true;
    editor.replaceRange(closing, closePos);
    editor.setCursor({ line: closeLine, ch: closeCh + closing.length });
    this.intercepting = false;
    this.session = null;
  }
  handleSessionInsertion(editor, char) {
    this.intercepting = true;
    try {
      if (this.session) {
        const cursor2 = editor.getCursor();
        const expectedCh = this.session.startCh + 3 + this.session.content.length;
        if (cursor2.line === this.session.startLine && cursor2.ch === expectedCh) {
          editor.replaceRange(char, cursor2);
          editor.setCursor({
            line: cursor2.line,
            ch: cursor2.ch + char.length
          });
          this.session.content += char;
          return;
        }
        this.intercepting = false;
        this.finalizeSession();
        this.intercepting = true;
      }
      const cursor = editor.getCursor();
      editor.replaceRange("{++" + char, cursor);
      editor.setCursor({
        line: cursor.line,
        ch: cursor.ch + 3 + char.length
      });
      this.session = {
        startLine: cursor.line,
        startCh: cursor.ch,
        content: char,
        meta: makeMetaComment(this.settings)
      };
    } finally {
      this.intercepting = false;
    }
  }
  handleCompositionInsert(editor, text) {
    const cursor = editor.getCursor();
    const startCh = cursor.ch - text.length;
    if (startCh < 0)
      return;
    if (this.session) {
      const expectedCh = this.session.startCh + 3 + this.session.content.length;
      if (cursor.line === this.session.startLine && startCh === expectedCh) {
        this.session.content += text;
        return;
      }
      this.intercepting = false;
      this.finalizeSession();
      this.intercepting = true;
    }
    const startPos = { line: cursor.line, ch: startCh };
    editor.replaceRange("++}", cursor);
    editor.replaceRange("{++", startPos);
    const finalCh = startCh + 3 + text.length + 3;
    editor.setCursor({ line: cursor.line, ch: finalCh });
  }
  // ── Keyboard ─────────────────────────────────────────────────────────────
  handleKeydown(evt) {
    if (!this.tracking || this.intercepting || this.composing)
      return;
    if (evt.isComposing || evt.keyCode === 229)
      return;
    const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
    if (!view || view.getMode() !== "source")
      return;
    const editor = view.editor;
    const editorEl = view.contentEl;
    if (editorEl && !editorEl.contains(evt.target))
      return;
    if (evt.ctrlKey || evt.metaKey || evt.altKey)
      return;
    const navKeys = [
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown"
    ];
    if (navKeys.includes(evt.key)) {
      this.finalizeSession();
      return;
    }
    const ignoreKeys = [
      "Tab",
      "Escape",
      "Shift",
      "Control",
      "Alt",
      "Meta",
      "CapsLock",
      "F1",
      "F2",
      "F3",
      "F4",
      "F5",
      "F6",
      "F7",
      "F8",
      "F9",
      "F10",
      "F11",
      "F12",
      "Process"
    ];
    if (ignoreKeys.includes(evt.key))
      return;
    if (evt.key === "Backspace") {
      this.finalizeSession();
      evt.preventDefault();
      evt.stopPropagation();
      this.handleBackspace(editor);
      return;
    }
    if (evt.key === "Delete") {
      this.finalizeSession();
      evt.preventDefault();
      evt.stopPropagation();
      this.handleDelete(editor);
      return;
    }
    if (evt.key === "Enter") {
      this.finalizeSession();
      return;
    }
    if (evt.key.length === 1) {
      const sel = editor.getSelection();
      if (sel && sel.length > 0) {
        this.finalizeSession();
        evt.preventDefault();
        evt.stopPropagation();
        this.handleSubstitution(editor, sel, evt.key);
        return;
      }
      evt.preventDefault();
      evt.stopPropagation();
      this.handleSessionInsertion(editor, evt.key);
      return;
    }
  }
  handleBackspace(editor) {
    this.intercepting = true;
    try {
      const sel = editor.getSelection();
      const meta = makeMetaComment(this.settings);
      if (sel && sel.length > 0) {
        editor.replaceSelection("{--" + sel + "--}" + meta);
        return;
      }
      const cursor = editor.getCursor();
      if (cursor.ch === 0 && cursor.line === 0)
        return;
      const doc = editor.getValue();
      const offset = this.cursorToOffset(editor, cursor);
      if (offset > 0 && isPartOfCriticMarkup(doc, offset - 1)) {
        return;
      }
      let fromPos;
      if (cursor.ch > 0) {
        fromPos = { line: cursor.line, ch: cursor.ch - 1 };
      } else {
        const prevLine = cursor.line - 1;
        fromPos = {
          line: prevLine,
          ch: editor.getLine(prevLine).length
        };
      }
      const deleted = editor.getRange(fromPos, cursor);
      const replacement = "{--" + deleted + "--}" + meta;
      editor.replaceRange(replacement, fromPos, cursor);
      editor.setCursor({
        line: fromPos.line,
        ch: fromPos.ch + replacement.length
      });
    } finally {
      this.intercepting = false;
    }
  }
  handleDelete(editor) {
    this.intercepting = true;
    try {
      const sel = editor.getSelection();
      const meta = makeMetaComment(this.settings);
      if (sel && sel.length > 0) {
        editor.replaceSelection("{--" + sel + "--}" + meta);
        return;
      }
      const cursor = editor.getCursor();
      const lineText = editor.getLine(cursor.line);
      if (cursor.ch >= lineText.length && cursor.line >= editor.lastLine())
        return;
      const doc = editor.getValue();
      const offset = this.cursorToOffset(editor, cursor);
      if (isPartOfCriticMarkup(doc, offset)) {
        return;
      }
      let toPos;
      if (cursor.ch < lineText.length) {
        toPos = { line: cursor.line, ch: cursor.ch + 1 };
      } else {
        toPos = { line: cursor.line + 1, ch: 0 };
      }
      const deleted = editor.getRange(cursor, toPos);
      const replacement = "{--" + deleted + "--}" + meta;
      editor.replaceRange(replacement, cursor, toPos);
      editor.setCursor({
        line: cursor.line,
        ch: cursor.ch + replacement.length
      });
    } finally {
      this.intercepting = false;
    }
  }
  handleSubstitution(editor, selected, newChar) {
    this.intercepting = true;
    try {
      const meta = makeMetaComment(this.settings);
      editor.replaceSelection(
        "{~~" + selected + "~>" + newChar + "~~}" + meta
      );
    } finally {
      this.intercepting = false;
    }
  }
  // ── Accept / Reject ──────────────────────────────────────────────────────
  acceptAllChanges() {
    this.finalizeSession();
    const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
    if (!view)
      return;
    let t = view.editor.getValue();
    t = t.replace(/\{\+\+([\s\S]+?)\+\+\}/g, "$1");
    t = t.replace(/\{--([\s\S]+?)--\}/g, "");
    t = t.replace(/\{~~[\s\S]+?~>([\s\S]+?)~~\}/g, "$1");
    t = t.replace(/\{>>([\s\S]+?)<<\}/g, "");
    view.editor.setValue(t);
    new import_obsidian.Notice("All changes accepted");
  }
  rejectAllChanges() {
    this.finalizeSession();
    const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
    if (!view)
      return;
    let t = view.editor.getValue();
    t = t.replace(/\{\+\+([\s\S]+?)\+\+\}/g, "");
    t = t.replace(/\{--([\s\S]+?)--\}/g, "$1");
    t = t.replace(/\{~~([\s\S]+?)~>[\s\S]+?~~\}/g, "$1");
    t = t.replace(/\{>>([\s\S]+?)<<\}/g, "");
    view.editor.setValue(t);
    new import_obsidian.Notice("All changes rejected");
  }
  /**
   * Accept or reject a specific change by its index among actionable changes.
   * Used by the sidebar panel.
   */
  applyChangeByIndex(index, action) {
    this.finalizeSession();
    const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
    if (!view)
      return;
    const doc = view.editor.getValue();
    const changes = findAllCriticMarkup(doc);
    const actionable = changes.filter(
      (c) => c.type === "addition" || c.type === "deletion" || c.type === "substitution"
    );
    if (index < 0 || index >= actionable.length)
      return;
    const change = actionable[index];
    let replacement = "";
    if (action === "accept") {
      if (change.type === "addition")
        replacement = change.content || "";
      else if (change.type === "deletion")
        replacement = "";
      else if (change.type === "substitution")
        replacement = change.newContent || "";
    } else {
      if (change.type === "addition")
        replacement = "";
      else if (change.type === "deletion")
        replacement = change.content || "";
      else if (change.type === "substitution")
        replacement = change.oldContent || "";
    }
    view.editor.setValue(
      doc.slice(0, change.from) + replacement + doc.slice(change.to)
    );
  }
  findMarkupAtOffset(doc, offset) {
    const patterns = [
      { re: /\{\+\+([\s\S]+?)\+\+\}(\{>>[\s\S]+?<<\})?/g, type: "add" },
      { re: /\{--([\s\S]+?)--\}(\{>>[\s\S]+?<<\})?/g, type: "del" },
      {
        re: /\{~~([\s\S]+?)~>([\s\S]+?)~~\}(\{>>[\s\S]+?<<\})?/g,
        type: "sub"
      }
    ];
    for (const p of patterns) {
      for (const m of doc.matchAll(p.re)) {
        const start = m.index;
        const end = start + m[0].length;
        if (offset >= start && offset <= end) {
          return { start, end, type: p.type, groups: [...m].slice(1) };
        }
      }
    }
    return null;
  }
  cursorToOffset(editor, pos) {
    let offset = 0;
    for (let i = 0; i < pos.line; i++)
      offset += editor.getLine(i).length + 1;
    offset += pos.ch;
    return offset;
  }
  offsetToPos(editor, offset) {
    let remaining = offset;
    const lineCount = editor.lineCount();
    for (let i = 0; i < lineCount; i++) {
      const lineLen = editor.getLine(i).length;
      if (remaining <= lineLen) {
        return { line: i, ch: remaining };
      }
      remaining -= lineLen + 1;
    }
    return { line: lineCount - 1, ch: editor.getLine(lineCount - 1).length };
  }
  acceptChangeAtCursor() {
    this.finalizeSession();
    const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
    if (!view)
      return;
    const editor = view.editor;
    const doc = editor.getValue();
    const offset = this.cursorToOffset(editor, editor.getCursor());
    const found = this.findMarkupAtOffset(doc, offset);
    if (!found) {
      new import_obsidian.Notice("No change found at cursor");
      return;
    }
    let r = "";
    if (found.type === "add")
      r = found.groups[0];
    else if (found.type === "del")
      r = "";
    else if (found.type === "sub")
      r = found.groups[1];
    editor.setValue(doc.slice(0, found.start) + r + doc.slice(found.end));
    new import_obsidian.Notice("Change accepted");
  }
  rejectChangeAtCursor() {
    this.finalizeSession();
    const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
    if (!view)
      return;
    const editor = view.editor;
    const doc = editor.getValue();
    const offset = this.cursorToOffset(editor, editor.getCursor());
    const found = this.findMarkupAtOffset(doc, offset);
    if (!found) {
      new import_obsidian.Notice("No change found at cursor");
      return;
    }
    let r = "";
    if (found.type === "add")
      r = "";
    else if (found.type === "del")
      r = found.groups[0];
    else if (found.type === "sub")
      r = found.groups[0];
    editor.setValue(doc.slice(0, found.start) + r + doc.slice(found.end));
    new import_obsidian.Notice("Change rejected");
  }
  addComment() {
    this.finalizeSession();
    const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
    if (!view)
      return;
    const editor = view.editor;
    const sel = editor.getSelection();
    if (!sel) {
      new import_obsidian.Notice("Select text to comment on");
      return;
    }
    const ts = this.settings.enableTimestamp ? " " + formatTimestamp(this.settings.timestampFormat) : "";
    editor.replaceSelection("{==" + sel + "==}{>>comment" + ts + "<<}");
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
};
var CriticTrackSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Critic Track Settings" });
    new import_obsidian.Setting(containerEl).setName("Enable timestamps").setDesc("Attach a timestamp to each change").addToggle(
      (t) => t.setValue(this.plugin.settings.enableTimestamp).onChange(async (v) => {
        this.plugin.settings.enableTimestamp = v;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Timestamp format").setDesc("YYYY, MM, DD, HH, mm, ss").addText(
      (t) => t.setPlaceholder("YYYY-MM-DD HH:mm").setValue(this.plugin.settings.timestampFormat).onChange(async (v) => {
        this.plugin.settings.timestampFormat = v;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Enable author tag").setDesc("Add your name to each change").addToggle(
      (t) => t.setValue(this.plugin.settings.enableAuthorTag).onChange(async (v) => {
        this.plugin.settings.enableAuthorTag = v;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Author tag").setDesc("Your name or identifier").addText(
      (t) => t.setPlaceholder("ldd").setValue(this.plugin.settings.authorTag).onChange(async (v) => {
        this.plugin.settings.authorTag = v;
        await this.plugin.saveSettings();
      })
    );
  }
};
