import {
  Plugin,
  PluginSettingTab,
  App,
  Setting,
  Notice,
  MarkdownView,
  Editor,
  Menu,
  EditorPosition,
  MarkdownPostProcessorContext,
  editorLivePreviewField,
  ItemView,
  WorkspaceLeaf,
} from "obsidian";

import {
  ViewPlugin,
  DecorationSet,
  Decoration,
  WidgetType,
  EditorView,
  ViewUpdate,
} from "@codemirror/view";

import { RangeSetBuilder } from "@codemirror/state";

// ── Settings ──────────────────────────────────────────────────────────────────

interface CriticTrackSettings {
  timestampFormat: string;
  enableTimestamp: boolean;
  authorTag: string;
  enableAuthorTag: boolean;
}

const DEFAULT_SETTINGS: CriticTrackSettings = {
  timestampFormat: "YYYY-MM-DD HH:mm",
  enableTimestamp: false,
  authorTag: "",
  enableAuthorTag: false,
};

function formatTimestamp(fmt: string): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return fmt
    .replace("YYYY", now.getFullYear().toString())
    .replace("MM", pad(now.getMonth() + 1))
    .replace("DD", pad(now.getDate()))
    .replace("HH", pad(now.getHours()))
    .replace("mm", pad(now.getMinutes()))
    .replace("ss", pad(now.getSeconds()));
}

function makeMetaComment(settings: CriticTrackSettings): string {
  const parts: string[] = [];
  if (settings.enableTimestamp) {
    parts.push(formatTimestamp(settings.timestampFormat));
  }
  if (settings.enableAuthorTag && settings.authorTag) {
    parts.push("@" + settings.authorTag);
  }
  if (parts.length === 0) return "";
  return "{>>" + parts.join(" ") + "<<}";
}

// ── CriticMarkup Patterns ─────────────────────────────────────────────────────

interface CriticMatch {
  type: "addition" | "deletion" | "substitution" | "comment" | "highlight";
  from: number;
  to: number;
  fullMatch: string;
  content?: string;
  oldContent?: string;
  newContent?: string;
}

function findAllCriticMarkup(text: string): CriticMatch[] {
  const matches: CriticMatch[] = [];

  for (const m of text.matchAll(/\{\+\+([\s\S]+?)\+\+\}/g)) {
    matches.push({
      type: "addition",
      from: m.index!,
      to: m.index! + m[0].length,
      fullMatch: m[0],
      content: m[1],
    });
  }

  for (const m of text.matchAll(/\{--([\s\S]+?)--\}/g)) {
    matches.push({
      type: "deletion",
      from: m.index!,
      to: m.index! + m[0].length,
      fullMatch: m[0],
      content: m[1],
    });
  }

  for (const m of text.matchAll(/\{~~([\s\S]+?)~>([\s\S]+?)~~\}/g)) {
    matches.push({
      type: "substitution",
      from: m.index!,
      to: m.index! + m[0].length,
      fullMatch: m[0],
      oldContent: m[1],
      newContent: m[2],
    });
  }

  for (const m of text.matchAll(/\{>>([\s\S]+?)<<\}/g)) {
    matches.push({
      type: "comment",
      from: m.index!,
      to: m.index! + m[0].length,
      fullMatch: m[0],
      content: m[1],
    });
  }

  for (const m of text.matchAll(/\{==([\s\S]+?)==\}/g)) {
    matches.push({
      type: "highlight",
      from: m.index!,
      to: m.index! + m[0].length,
      fullMatch: m[0],
      content: m[1],
    });
  }

  matches.sort((a, b) => a.from - b.from);

  const filtered: CriticMatch[] = [];
  let lastEnd = -1;
  for (const m of matches) {
    if (m.from >= lastEnd) {
      filtered.push(m);
      lastEnd = m.to;
    }
  }

  return filtered;
}

// ── Markup boundary helper ────────────────────────────────────────────────────

/**
 * Check if a character position is inside or part of CriticMarkup syntax.
 * Uses inclusive boundaries: returns true for positions from `{` through `}`.
 */
function isPartOfCriticMarkup(doc: string, charOffset: number): boolean {
  const matches = findAllCriticMarkup(doc);
  for (const m of matches) {
    if (charOffset >= m.from && charOffset < m.to) {
      return true;
    }
  }
  return false;
}

// ── CodeMirror 6 Widgets ──────────────────────────────────────────────────────

class AcceptRejectWidget extends WidgetType {
  constructor(
    private matchFrom: number,
    private matchTo: number,
    private acceptText: string,
    private rejectText: string
  ) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
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
          insert: this.acceptText,
        },
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
          insert: this.rejectText,
        },
      });
    });

    container.appendChild(acceptBtn);
    container.appendChild(rejectBtn);
    return container;
  }

  eq(other: AcceptRejectWidget): boolean {
    return (
      this.matchFrom === other.matchFrom &&
      this.matchTo === other.matchTo &&
      this.acceptText === other.acceptText &&
      this.rejectText === other.rejectText
    );
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// ── CodeMirror 6 ViewPlugin for Live Preview ──────────────────────────────────

function buildDecorations(view: EditorView): DecorationSet {
  const isLivePreview = view.state.field(editorLivePreviewField);
  const text = view.state.doc.toString();
  const matches = findAllCriticMarkup(text);

  const decos: { from: number; to: number; deco: Decoration }[] = [];

  for (const match of matches) {
    switch (match.type) {
      case "addition": {
        const openEnd = match.from + 3;
        const closeStart = match.to - 3;
        if (isLivePreview) {
          decos.push({ from: match.from, to: openEnd, deco: Decoration.replace({}) });
          decos.push({
            from: openEnd,
            to: closeStart,
            deco: Decoration.mark({ class: "critic-track-addition" }),
          });
          decos.push({ from: closeStart, to: match.to, deco: Decoration.replace({}) });
          decos.push({
            from: match.to,
            to: match.to,
            deco: Decoration.widget({
              widget: new AcceptRejectWidget(match.from, match.to, match.content || "", ""),
              side: 1,
            }),
          });
        } else {
          decos.push({
            from: match.from,
            to: match.to,
            deco: Decoration.mark({ class: "critic-track-addition-source" }),
          });
        }
        break;
      }

      case "deletion": {
        const openEnd = match.from + 3;
        const closeStart = match.to - 3;
        if (isLivePreview) {
          decos.push({ from: match.from, to: openEnd, deco: Decoration.replace({}) });
          decos.push({
            from: openEnd,
            to: closeStart,
            deco: Decoration.mark({ class: "critic-track-deletion" }),
          });
          decos.push({ from: closeStart, to: match.to, deco: Decoration.replace({}) });
          decos.push({
            from: match.to,
            to: match.to,
            deco: Decoration.widget({
              widget: new AcceptRejectWidget(match.from, match.to, "", match.content || ""),
              side: 1,
            }),
          });
        } else {
          decos.push({
            from: match.from,
            to: match.to,
            deco: Decoration.mark({ class: "critic-track-deletion-source" }),
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
          decos.push({ from: match.from, to: openEnd, deco: Decoration.replace({}) });
          decos.push({
            from: openEnd,
            to: arrowFrom,
            deco: Decoration.mark({ class: "critic-track-deletion" }),
          });
          decos.push({ from: arrowFrom, to: arrowTo, deco: Decoration.replace({}) });
          decos.push({
            from: arrowTo,
            to: closeStart,
            deco: Decoration.mark({ class: "critic-track-addition" }),
          });
          decos.push({ from: closeStart, to: match.to, deco: Decoration.replace({}) });
          decos.push({
            from: match.to,
            to: match.to,
            deco: Decoration.widget({
              widget: new AcceptRejectWidget(
                match.from,
                match.to,
                match.newContent || "",
                match.oldContent || ""
              ),
              side: 1,
            }),
          });
        } else {
          decos.push({
            from: match.from,
            to: match.to,
            deco: Decoration.mark({ class: "critic-track-substitution-source" }),
          });
        }
        break;
      }

      case "comment": {
        const openEnd = match.from + 3;
        const closeStart = match.to - 3;
        if (isLivePreview) {
          decos.push({ from: match.from, to: openEnd, deco: Decoration.replace({}) });
          decos.push({
            from: openEnd,
            to: closeStart,
            deco: Decoration.mark({ class: "critic-track-comment" }),
          });
          decos.push({ from: closeStart, to: match.to, deco: Decoration.replace({}) });
        } else {
          decos.push({
            from: match.from,
            to: match.to,
            deco: Decoration.mark({ class: "critic-track-comment-source" }),
          });
        }
        break;
      }

      case "highlight": {
        const openEnd = match.from + 3;
        const closeStart = match.to - 3;
        if (isLivePreview) {
          decos.push({ from: match.from, to: openEnd, deco: Decoration.replace({}) });
          decos.push({
            from: openEnd,
            to: closeStart,
            deco: Decoration.mark({ class: "critic-track-highlight" }),
          });
          decos.push({ from: closeStart, to: match.to, deco: Decoration.replace({}) });
        } else {
          decos.push({
            from: match.from,
            to: match.to,
            deco: Decoration.mark({ class: "critic-track-highlight-source" }),
          });
        }
        break;
      }
    }
  }

  decos.sort((a, b) => a.from - b.from || a.to - b.to);

  const builder = new RangeSetBuilder<Decoration>();
  for (const d of decos) {
    if (d.from <= d.to && d.from >= 0 && d.to <= text.length) {
      builder.add(d.from, d.to, d.deco);
    }
  }
  return builder.finish();
}

const criticMarkupViewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

// ── Reading View Post Processor ───────────────────────────────────────────────

function criticMarkupPostProcessor(
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext
) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodesToReplace: { node: Text; html: string }[] = [];

  const criticRegex =
    /\{\+\+([\s\S]+?)\+\+\}|\{--([\s\S]+?)--\}|\{~~([\s\S]+?)~>([\s\S]+?)~~\}|\{>>([\s\S]+?)<<\}|\{==([\s\S]+?)==\}/g;

  let textNode: Text | null;
  while ((textNode = walker.nextNode() as Text | null)) {
    const text = textNode.textContent || "";
    if (!criticRegex.test(text)) {
      criticRegex.lastIndex = 0;
      continue;
    }
    criticRegex.lastIndex = 0;

    const html = text.replace(
      criticRegex,
      (
        _match: string,
        add: string | undefined,
        del: string | undefined,
        subOld: string | undefined,
        subNew: string | undefined,
        comment: string | undefined,
        highlight: string | undefined
      ) => {
        if (add !== undefined) {
          return '<span class="critic-track-addition">' + escapeHtml(add) + "</span>";
        }
        if (del !== undefined) {
          return '<span class="critic-track-deletion">' + escapeHtml(del) + "</span>";
        }
        if (subOld !== undefined && subNew !== undefined) {
          return (
            '<span class="critic-track-deletion">' +
            escapeHtml(subOld) +
            '</span><span class="critic-track-addition">' +
            escapeHtml(subNew) +
            "</span>"
          );
        }
        if (comment !== undefined) {
          return '<span class="critic-track-comment">' + escapeHtml(comment) + "</span>";
        }
        if (highlight !== undefined) {
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
    node.parentNode?.replaceChild(wrapper, node);
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Sidebar Panel (Tracked Changes) ──────────────────────────────────────────

const VIEW_TYPE_CHANGES = "critic-track-changes";

class ChangesView extends ItemView {
  plugin: CriticTrackPlugin;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: CriticTrackPlugin) {
    super(leaf);
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
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
  }

  private scheduleRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.renderChanges(), 300);
  }

  renderChanges() {
    const container = this.contentEl;
    container.empty();

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      container.createEl("div", {
        text: "No active document",
        cls: "critic-track-panel-empty",
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
        cls: "critic-track-panel-empty",
      });
      return;
    }

    // Header
    const header = container.createEl("div", { cls: "critic-track-panel-header" });
    header.createEl("span", {
      text: actionable.length + " change" + (actionable.length > 1 ? "s" : ""),
      cls: "critic-track-panel-count",
    });

    const headerBtns = header.createEl("div", { cls: "critic-track-panel-header-btns" });

    const acceptAllBtn = headerBtns.createEl("button", {
      cls: "critic-track-panel-btn critic-track-panel-btn-accept",
    });
    acceptAllBtn.textContent = "Accept All";
    acceptAllBtn.addEventListener("click", () => {
      this.plugin.acceptAllChanges();
      this.renderChanges();
    });

    const rejectAllBtn = headerBtns.createEl("button", {
      cls: "critic-track-panel-btn critic-track-panel-btn-reject",
    });
    rejectAllBtn.textContent = "Reject All";
    rejectAllBtn.addEventListener("click", () => {
      this.plugin.rejectAllChanges();
      this.renderChanges();
    });

    // Change list
    const list = container.createEl("div", { cls: "critic-track-panel-list" });

    for (let i = 0; i < actionable.length; i++) {
      const change = actionable[i];
      const item = list.createEl("div", { cls: "critic-track-panel-item" });

      // Type indicator
      const typeBadge = item.createEl("span", {
        cls: "critic-track-panel-badge critic-track-panel-badge-" + change.type,
      });
      typeBadge.textContent =
        change.type === "addition" ? "+" : change.type === "deletion" ? "\u2212" : "\u223C";

      // Content
      const content = item.createEl("div", { cls: "critic-track-panel-content" });
      if (change.type === "substitution") {
        const oldEl = content.createEl("span", { cls: "critic-track-panel-del-text" });
        oldEl.textContent = truncate(change.oldContent || "", 50);
        content.createEl("span", { text: " \u2192 ", cls: "critic-track-panel-arrow" });
        const newEl = content.createEl("span", { cls: "critic-track-panel-add-text" });
        newEl.textContent = truncate(change.newContent || "", 50);
      } else {
        const textEl = content.createEl("span", {
          cls:
            change.type === "addition"
              ? "critic-track-panel-add-text"
              : "critic-track-panel-del-text",
        });
        textEl.textContent = truncate(change.content || "", 80);
      }

      // Action buttons
      const actions = item.createEl("div", { cls: "critic-track-panel-item-actions" });

      const acceptBtn = actions.createEl("button", {
        cls: "critic-track-panel-btn-sm critic-track-panel-btn-accept",
        title: "Accept",
      });
      acceptBtn.textContent = "\u2713";
      acceptBtn.addEventListener("click", () => {
        this.plugin.applyChangeByIndex(i, "accept");
        this.renderChanges();
      });

      const rejectBtn = actions.createEl("button", {
        cls: "critic-track-panel-btn-sm critic-track-panel-btn-reject",
        title: "Reject",
      });
      rejectBtn.textContent = "\u2717";
      rejectBtn.addEventListener("click", () => {
        this.plugin.applyChangeByIndex(i, "reject");
        this.renderChanges();
      });

      // Click item to scroll to change in editor
      item.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).tagName === "BUTTON") return;
        const editor = view.editor;
        const pos = this.plugin.offsetToPos(editor, change.from);
        editor.setCursor(pos);
        editor.focus();
      });
    }
  }
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "\u2026";
}

// ── Insertion Session ─────────────────────────────────────────────────────────

interface InsertionSession {
  startLine: number;
  startCh: number;
  content: string;
  meta: string;
}

// ── Main Plugin ───────────────────────────────────────────────────────────────

export default class CriticTrackPlugin extends Plugin {
  settings: CriticTrackSettings = DEFAULT_SETTINGS;
  tracking = false;
  private statusBarEl: HTMLElement | null = null;
  private intercepting = false;
  private composing = false;
  private session: InsertionSession | null = null;

  async onload() {
    await this.loadSettings();

    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar();

    // Register sidebar view
    this.registerView(VIEW_TYPE_CHANGES, (leaf) => new ChangesView(leaf, this));

    // Commands
    this.addCommand({
      id: "toggle-tracking",
      name: "Toggle revision tracking",
      icon: "pencil",
      callback: () => this.toggleTracking(),
    });
    this.addCommand({
      id: "accept-all",
      name: "Accept all changes",
      callback: () => this.acceptAllChanges(),
    });
    this.addCommand({
      id: "reject-all",
      name: "Reject all changes",
      callback: () => this.rejectAllChanges(),
    });
    this.addCommand({
      id: "accept-at-cursor",
      name: "Accept change at cursor",
      callback: () => this.acceptChangeAtCursor(),
    });
    this.addCommand({
      id: "reject-at-cursor",
      name: "Reject change at cursor",
      callback: () => this.rejectChangeAtCursor(),
    });
    this.addCommand({
      id: "add-comment",
      name: "Add comment at selection",
      callback: () => this.addComment(),
    });
    this.addCommand({
      id: "show-changes-panel",
      name: "Show tracked changes panel",
      callback: () => this.activateChangesPanel(),
    });

    this.addRibbonIcon("pencil", "Toggle revision tracking", () =>
      this.toggleTracking()
    );
    this.addSettingTab(new CriticTrackSettingTab(this.app, this));

    // Register CodeMirror 6 extension for live preview rendering
    this.registerEditorExtension(criticMarkupViewPlugin);

    // Register post-processor for reading view rendering
    this.registerMarkdownPostProcessor(criticMarkupPostProcessor);

    // Context menu
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor) => {
        if (this.tracking) {
          menu.addItem((item) =>
            item
              .setTitle("Accept change at cursor")
              .setIcon("check")
              .onClick(() => this.acceptChangeAtCursor())
          );
          menu.addItem((item) =>
            item
              .setTitle("Reject change at cursor")
              .setIcon("x")
              .onClick(() => this.rejectChangeAtCursor())
          );
          menu.addSeparator();
        }
        menu.addItem((item) =>
          item
            .setTitle(this.tracking ? "Stop tracking" : "Start tracking")
            .setIcon("pencil")
            .onClick(() => this.toggleTracking())
        );
      })
    );

    // IME composition events for non-English input
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
      (evt: CompositionEvent) => {
        this.composing = false;
        if (!this.tracking || this.intercepting) return;
        const text = evt.data;
        if (!text) return;
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || view.getMode() !== "source") return;
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
      (evt: KeyboardEvent) => this.handleKeydown(evt),
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
    new Notice(this.tracking ? "Revision tracking ON" : "Revision tracking OFF");
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

  private finalizeSession() {
    if (!this.session) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      this.session = null;
      return;
    }
    const editor = view.editor;

    const closeLine = this.session.startLine;
    const closeCh = this.session.startCh + 3 + this.session.content.length;
    const closePos: EditorPosition = { line: closeLine, ch: closeCh };
    const closing = "++}" + this.session.meta;

    this.intercepting = true;
    editor.replaceRange(closing, closePos);
    // Move cursor to after the closing marker
    editor.setCursor({ line: closeLine, ch: closeCh + closing.length });
    this.intercepting = false;
    this.session = null;
  }

  private handleSessionInsertion(editor: Editor, char: string) {
    this.intercepting = true;
    try {
      if (this.session) {
        const cursor = editor.getCursor();
        const expectedCh =
          this.session.startCh + 3 + this.session.content.length;
        if (
          cursor.line === this.session.startLine &&
          cursor.ch === expectedCh
        ) {
          // Extend the current session
          editor.replaceRange(char, cursor);
          // Explicitly move cursor after the inserted char
          editor.setCursor({
            line: cursor.line,
            ch: cursor.ch + char.length,
          });
          this.session.content += char;
          return;
        }
        // Cursor moved away - finalize old session and start new
        this.intercepting = false;
        this.finalizeSession();
        this.intercepting = true;
      }

      // Start new session
      const cursor = editor.getCursor();
      editor.replaceRange("{++" + char, cursor);
      // Explicitly set cursor after "{++X"
      editor.setCursor({
        line: cursor.line,
        ch: cursor.ch + 3 + char.length,
      });
      this.session = {
        startLine: cursor.line,
        startCh: cursor.ch,
        content: char,
        meta: makeMetaComment(this.settings),
      };
    } finally {
      this.intercepting = false;
    }
  }

  private handleCompositionInsert(editor: Editor, text: string) {
    // After IME commits, the text is already in the document.
    // We need to wrap it with {++ ... ++} retroactively.
    const cursor = editor.getCursor();
    const startCh = cursor.ch - text.length;
    if (startCh < 0) return;

    // If there's an open session right before this text, extend it
    if (this.session) {
      const expectedCh =
        this.session.startCh + 3 + this.session.content.length;
      if (
        cursor.line === this.session.startLine &&
        startCh === expectedCh
      ) {
        this.session.content += text;
        return;
      }
      this.intercepting = false;
      this.finalizeSession();
      this.intercepting = true;
    }

    // Wrap the committed IME text
    const startPos: EditorPosition = { line: cursor.line, ch: startCh };

    // Insert closing marker first (so positions don't shift for the opening)
    editor.replaceRange("++}", cursor);
    // Then insert opening marker
    editor.replaceRange("{++", startPos);

    // Position cursor after the closing marker
    const finalCh = startCh + 3 + text.length + 3;
    editor.setCursor({ line: cursor.line, ch: finalCh });
  }

  // ── Keyboard ─────────────────────────────────────────────────────────────

  private handleKeydown(evt: KeyboardEvent) {
    if (!this.tracking || this.intercepting || this.composing) return;

    // Detect IME composition - isComposing catches active composition,
    // keyCode 229 catches the first keydown before compositionstart fires
    if (evt.isComposing || evt.keyCode === 229) return;

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.getMode() !== "source") return;
    const editor = view.editor;

    const editorEl = (view as any).contentEl;
    if (editorEl && !editorEl.contains(evt.target as Node)) return;

    if (evt.ctrlKey || evt.metaKey || evt.altKey) return;

    const navKeys = [
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown",
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
      "Process",
    ];
    if (ignoreKeys.includes(evt.key)) return;

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

  private handleBackspace(editor: Editor) {
    this.intercepting = true;
    try {
      const sel = editor.getSelection();
      const meta = makeMetaComment(this.settings);
      if (sel && sel.length > 0) {
        editor.replaceSelection("{--" + sel + "--}" + meta);
        return;
      }

      const cursor = editor.getCursor();
      if (cursor.ch === 0 && cursor.line === 0) return;

      const doc = editor.getValue();
      const offset = this.cursorToOffset(editor, cursor);

      // Check if the character to be deleted (at offset-1) is inside CriticMarkup
      if (offset > 0 && isPartOfCriticMarkup(doc, offset - 1)) {
        // Don't wrap CriticMarkup syntax characters - just let it be
        // (prevent the cascading {--}-- chain)
        return;
      }

      let fromPos: EditorPosition;
      if (cursor.ch > 0) {
        fromPos = { line: cursor.line, ch: cursor.ch - 1 };
      } else {
        const prevLine = cursor.line - 1;
        fromPos = {
          line: prevLine,
          ch: editor.getLine(prevLine).length,
        };
      }
      const deleted = editor.getRange(fromPos, cursor);
      const replacement = "{--" + deleted + "--}" + meta;
      editor.replaceRange(replacement, fromPos, cursor);
      // Set cursor after the replacement
      editor.setCursor({
        line: fromPos.line,
        ch: fromPos.ch + replacement.length,
      });
    } finally {
      this.intercepting = false;
    }
  }

  private handleDelete(editor: Editor) {
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

      // Check if the character to be deleted (at offset) is inside CriticMarkup
      if (isPartOfCriticMarkup(doc, offset)) {
        return;
      }

      let toPos: EditorPosition;
      if (cursor.ch < lineText.length) {
        toPos = { line: cursor.line, ch: cursor.ch + 1 };
      } else {
        toPos = { line: cursor.line + 1, ch: 0 };
      }
      const deleted = editor.getRange(cursor, toPos);
      const replacement = "{--" + deleted + "--}" + meta;
      editor.replaceRange(replacement, cursor, toPos);
      // Set cursor after the replacement
      editor.setCursor({
        line: cursor.line,
        ch: cursor.ch + replacement.length,
      });
    } finally {
      this.intercepting = false;
    }
  }

  private handleSubstitution(
    editor: Editor,
    selected: string,
    newChar: string
  ) {
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
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    let t = view.editor.getValue();
    t = t.replace(/\{\+\+([\s\S]+?)\+\+\}/g, "$1");
    t = t.replace(/\{--([\s\S]+?)--\}/g, "");
    t = t.replace(/\{~~[\s\S]+?~>([\s\S]+?)~~\}/g, "$1");
    t = t.replace(/\{>>([\s\S]+?)<<\}/g, "");
    view.editor.setValue(t);
    new Notice("All changes accepted");
  }

  rejectAllChanges() {
    this.finalizeSession();
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    let t = view.editor.getValue();
    t = t.replace(/\{\+\+([\s\S]+?)\+\+\}/g, "");
    t = t.replace(/\{--([\s\S]+?)--\}/g, "$1");
    t = t.replace(/\{~~([\s\S]+?)~>[\s\S]+?~~\}/g, "$1");
    t = t.replace(/\{>>([\s\S]+?)<<\}/g, "");
    view.editor.setValue(t);
    new Notice("All changes rejected");
  }

  /**
   * Accept or reject a specific change by its index among actionable changes.
   * Used by the sidebar panel.
   */
  applyChangeByIndex(index: number, action: "accept" | "reject") {
    this.finalizeSession();
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    const doc = view.editor.getValue();
    const changes = findAllCriticMarkup(doc);
    const actionable = changes.filter(
      (c) => c.type === "addition" || c.type === "deletion" || c.type === "substitution"
    );
    if (index < 0 || index >= actionable.length) return;

    const change = actionable[index];
    let replacement = "";
    if (action === "accept") {
      if (change.type === "addition") replacement = change.content || "";
      else if (change.type === "deletion") replacement = "";
      else if (change.type === "substitution") replacement = change.newContent || "";
    } else {
      if (change.type === "addition") replacement = "";
      else if (change.type === "deletion") replacement = change.content || "";
      else if (change.type === "substitution") replacement = change.oldContent || "";
    }

    view.editor.setValue(
      doc.slice(0, change.from) + replacement + doc.slice(change.to)
    );
  }

  private findMarkupAtOffset(
    doc: string,
    offset: number
  ): {
    start: number;
    end: number;
    type: "add" | "del" | "sub";
    groups: string[];
  } | null {
    const patterns: { re: RegExp; type: "add" | "del" | "sub" }[] = [
      { re: /\{\+\+([\s\S]+?)\+\+\}(\{>>[\s\S]+?<<\})?/g, type: "add" },
      { re: /\{--([\s\S]+?)--\}(\{>>[\s\S]+?<<\})?/g, type: "del" },
      {
        re: /\{~~([\s\S]+?)~>([\s\S]+?)~~\}(\{>>[\s\S]+?<<\})?/g,
        type: "sub",
      },
    ];
    for (const p of patterns) {
      for (const m of doc.matchAll(p.re)) {
        const start = m.index!;
        const end = start + m[0].length;
        if (offset >= start && offset <= end) {
          return { start, end, type: p.type, groups: [...m].slice(1) };
        }
      }
    }
    return null;
  }

  cursorToOffset(editor: Editor, pos: EditorPosition): number {
    let offset = 0;
    for (let i = 0; i < pos.line; i++) offset += editor.getLine(i).length + 1;
    offset += pos.ch;
    return offset;
  }

  offsetToPos(editor: Editor, offset: number): EditorPosition {
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
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    const editor = view.editor;
    const doc = editor.getValue();
    const offset = this.cursorToOffset(editor, editor.getCursor());
    const found = this.findMarkupAtOffset(doc, offset);
    if (!found) {
      new Notice("No change found at cursor");
      return;
    }
    let r = "";
    if (found.type === "add") r = found.groups[0];
    else if (found.type === "del") r = "";
    else if (found.type === "sub") r = found.groups[1];
    editor.setValue(doc.slice(0, found.start) + r + doc.slice(found.end));
    new Notice("Change accepted");
  }

  rejectChangeAtCursor() {
    this.finalizeSession();
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    const editor = view.editor;
    const doc = editor.getValue();
    const offset = this.cursorToOffset(editor, editor.getCursor());
    const found = this.findMarkupAtOffset(doc, offset);
    if (!found) {
      new Notice("No change found at cursor");
      return;
    }
    let r = "";
    if (found.type === "add") r = "";
    else if (found.type === "del") r = found.groups[0];
    else if (found.type === "sub") r = found.groups[0];
    editor.setValue(doc.slice(0, found.start) + r + doc.slice(found.end));
    new Notice("Change rejected");
  }

  addComment() {
    this.finalizeSession();
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    const editor = view.editor;
    const sel = editor.getSelection();
    if (!sel) {
      new Notice("Select text to comment on");
      return;
    }
    const ts = this.settings.enableTimestamp
      ? " " + formatTimestamp(this.settings.timestampFormat)
      : "";
    editor.replaceSelection("{==" + sel + "==}{>>comment" + ts + "<<}");
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

// ── Settings Tab ──────────────────────────────────────────────────────────────

class CriticTrackSettingTab extends PluginSettingTab {
  plugin: CriticTrackPlugin;

  constructor(app: App, plugin: CriticTrackPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Critic Track Settings" });

    new Setting(containerEl)
      .setName("Enable timestamps")
      .setDesc("Attach a timestamp to each change")
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.enableTimestamp)
          .onChange(async (v) => {
            this.plugin.settings.enableTimestamp = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Timestamp format")
      .setDesc("YYYY, MM, DD, HH, mm, ss")
      .addText((t) =>
        t
          .setPlaceholder("YYYY-MM-DD HH:mm")
          .setValue(this.plugin.settings.timestampFormat)
          .onChange(async (v) => {
            this.plugin.settings.timestampFormat = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Enable author tag")
      .setDesc("Add your name to each change")
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.enableAuthorTag)
          .onChange(async (v) => {
            this.plugin.settings.enableAuthorTag = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Author tag")
      .setDesc("Your name or identifier")
      .addText((t) =>
        t
          .setPlaceholder("ldd")
          .setValue(this.plugin.settings.authorTag)
          .onChange(async (v) => {
            this.plugin.settings.authorTag = v;
            await this.plugin.saveSettings();
          })
      );
  }
}
