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
} from "obsidian";

import {
  ViewPlugin,
  DecorationSet,
  Decoration,
  WidgetType,
  EditorView,
  ViewUpdate,
} from "@codemirror/view";

import { RangeSetBuilder, EditorState } from "@codemirror/state";

// ── Settings ──────────────────────────────────────────────────────────────────

interface CriticTrackSettings {
  timestampFormat: string;
  enableTimestamp: boolean;
  authorTag: string;
  enableAuthorTag: boolean;
}

const DEFAULT_SETTINGS: CriticTrackSettings = {
  timestampFormat: "YYYY-MM-DD HH:mm",
  enableTimestamp: true,
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
  // Content groups
  content?: string;
  oldContent?: string;
  newContent?: string;
}

function findAllCriticMarkup(text: string): CriticMatch[] {
  const matches: CriticMatch[] = [];

  // Addition: {++text++}
  for (const m of text.matchAll(/\{\+\+([\s\S]+?)\+\+\}/g)) {
    matches.push({
      type: "addition",
      from: m.index!,
      to: m.index! + m[0].length,
      fullMatch: m[0],
      content: m[1],
    });
  }

  // Deletion: {--text--}
  for (const m of text.matchAll(/\{--([\s\S]+?)--\}/g)) {
    matches.push({
      type: "deletion",
      from: m.index!,
      to: m.index! + m[0].length,
      fullMatch: m[0],
      content: m[1],
    });
  }

  // Substitution: {~~old~>new~~}
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

  // Comment: {>>text<<}
  for (const m of text.matchAll(/\{>>([\s\S]+?)<<\}/g)) {
    matches.push({
      type: "comment",
      from: m.index!,
      to: m.index! + m[0].length,
      fullMatch: m[0],
      content: m[1],
    });
  }

  // Highlight: {==text==}
  for (const m of text.matchAll(/\{==([\s\S]+?)==\}/g)) {
    matches.push({
      type: "highlight",
      from: m.index!,
      to: m.index! + m[0].length,
      fullMatch: m[0],
      content: m[1],
    });
  }

  // Sort by position
  matches.sort((a, b) => a.from - b.from);

  // Filter out overlapping matches (later matches that overlap with earlier ones)
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
    acceptBtn.textContent = "✓";
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
    rejectBtn.textContent = "✗";
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
        // {++ = 3 chars, ++} = 3 chars
        const openEnd = match.from + 3;
        const closeStart = match.to - 3;
        if (isLivePreview) {
          // Hide delimiters in live preview
          decos.push({ from: match.from, to: openEnd, deco: Decoration.replace({}) });
          decos.push({
            from: openEnd,
            to: closeStart,
            deco: Decoration.mark({ class: "critic-track-addition" }),
          });
          decos.push({ from: closeStart, to: match.to, deco: Decoration.replace({}) });
          // Add accept/reject widget
          decos.push({
            from: match.to,
            to: match.to,
            deco: Decoration.widget({
              widget: new AcceptRejectWidget(
                match.from,
                match.to,
                match.content || "",
                ""
              ),
              side: 1,
            }),
          });
        } else {
          // Source mode: style entire block
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
              widget: new AcceptRejectWidget(
                match.from,
                match.to,
                "",
                match.content || ""
              ),
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
        // {~~ = 3 chars, ~~} = 3 chars, ~> = 2 chars
        const openEnd = match.from + 3;
        const arrowIdx = match.fullMatch.indexOf("~>");
        const arrowFrom = match.from + arrowIdx;
        const arrowTo = arrowFrom + 2;
        const closeStart = match.to - 3;
        if (isLivePreview) {
          // Hide {~~
          decos.push({ from: match.from, to: openEnd, deco: Decoration.replace({}) });
          // Old content with deletion style
          decos.push({
            from: openEnd,
            to: arrowFrom,
            deco: Decoration.mark({ class: "critic-track-deletion" }),
          });
          // Hide ~>
          decos.push({ from: arrowFrom, to: arrowTo, deco: Decoration.replace({}) });
          // New content with addition style
          decos.push({
            from: arrowTo,
            to: closeStart,
            deco: Decoration.mark({ class: "critic-track-addition" }),
          });
          // Hide ~~}
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

  // Sort decorations by from position (required by RangeSetBuilder)
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
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet
      ) {
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
  // Process text nodes to find and render CriticMarkup
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
          return `<span class="critic-track-addition">${escapeHtml(add)}</span>`;
        }
        if (del !== undefined) {
          return `<span class="critic-track-deletion">${escapeHtml(del)}</span>`;
        }
        if (subOld !== undefined && subNew !== undefined) {
          return `<span class="critic-track-deletion">${escapeHtml(subOld)}</span><span class="critic-track-addition">${escapeHtml(subNew)}</span>`;
        }
        if (comment !== undefined) {
          return `<span class="critic-track-comment">${escapeHtml(comment)}</span>`;
        }
        if (highlight !== undefined) {
          return `<span class="critic-track-highlight">${escapeHtml(highlight)}</span>`;
        }
        return _match;
      }
    );

    if (html !== text) {
      nodesToReplace.push({ node: textNode, html });
    }
  }

  // Replace text nodes with styled HTML
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

    // Register commands
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
      this.app.workspace.on(
        "editor-menu",
        (menu: Menu, editor: Editor) => {
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
              .setTitle(
                this.tracking ? "Stop tracking" : "Start tracking"
              )
              .setIcon("pencil")
              .onClick(() => this.toggleTracking())
          );
        }
      )
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

  toggleTracking() {
    this.finalizeSession();
    this.tracking = !this.tracking;
    this.updateStatusBar();
    new Notice(
      this.tracking ? "Revision tracking ON" : "Revision tracking OFF"
    );
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
    const closeCh =
      this.session.startCh + 3 + this.session.content.length;
    const closePos: EditorPosition = { line: closeLine, ch: closeCh };
    const closing = "++}" + this.session.meta;

    this.intercepting = true;
    editor.replaceRange(closing, closePos);
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
          editor.replaceRange(char, cursor);
          this.session.content += char;
          return;
        }
        this.intercepting = false;
        this.finalizeSession();
        this.intercepting = true;
      }

      const cursor = editor.getCursor();
      editor.replaceRange("{++" + char, cursor);
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
    if (this.session) {
      const cursor = editor.getCursor();
      const expectedCh =
        this.session.startCh +
        3 +
        this.session.content.length +
        text.length;
      if (
        cursor.line === this.session.startLine &&
        cursor.ch === expectedCh
      ) {
        this.session.content += text;
        return;
      }
      this.intercepting = false;
      this.finalizeSession();
      this.intercepting = true;
    }

    const cursor = editor.getCursor();
    const startCh = cursor.ch - text.length;
    if (startCh < 0) return;

    const startPos: EditorPosition = { line: cursor.line, ch: startCh };
    const meta = makeMetaComment(this.settings);

    editor.replaceRange("{++", startPos);
    const afterText: EditorPosition = {
      line: cursor.line,
      ch: startCh + 3 + text.length,
    };
    const closing = "++}" + meta;
    editor.replaceRange(closing, afterText);

    const finalCh = afterText.ch + closing.length;
    editor.setCursor({ line: cursor.line, ch: finalCh });
  }

  // ── Keyboard ─────────────────────────────────────────────────────────────

  private handleKeydown(evt: KeyboardEvent) {
    if (!this.tracking || this.intercepting || this.composing) return;

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
      } else {
        const cursor = editor.getCursor();
        if (cursor.ch === 0 && cursor.line === 0) return;

        // Check if cursor is inside existing CriticMarkup - if so, skip
        const lineText = editor.getLine(cursor.line);
        const doc = editor.getValue();
        const offset = this.cursorToOffset(editor, cursor);

        // Check if we're inside an existing critic markup tag
        if (this.isInsideCriticMarkup(doc, offset)) {
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
        editor.replaceRange(
          "{--" + deleted + "--}" + meta,
          fromPos,
          cursor
        );
      }
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
      } else {
        const cursor = editor.getCursor();
        const lineText = editor.getLine(cursor.line);
        if (
          cursor.ch >= lineText.length &&
          cursor.line >= editor.lastLine()
        )
          return;

        const doc = editor.getValue();
        const offset = this.cursorToOffset(editor, cursor);

        if (this.isInsideCriticMarkup(doc, offset)) {
          return;
        }

        let toPos: EditorPosition;
        if (cursor.ch < lineText.length) {
          toPos = { line: cursor.line, ch: cursor.ch + 1 };
        } else {
          toPos = { line: cursor.line + 1, ch: 0 };
        }
        const deleted = editor.getRange(cursor, toPos);
        editor.replaceRange(
          "{--" + deleted + "--}" + meta,
          cursor,
          toPos
        );
      }
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

  // ── Helper: check if offset is inside CriticMarkup ──────────────────────

  private isInsideCriticMarkup(doc: string, offset: number): boolean {
    const patterns = [
      /\{\+\+[\s\S]+?\+\+\}/g,
      /\{--[\s\S]+?--\}/g,
      /\{~~[\s\S]+?~>[\s\S]+?~~\}/g,
      /\{>>[\s\S]+?<<\}/g,
      /\{==[\s\S]+?==\}/g,
    ];
    for (const re of patterns) {
      for (const m of doc.matchAll(re)) {
        const start = m.index!;
        const end = start + m[0].length;
        if (offset > start && offset < end) {
          return true;
        }
      }
    }
    return false;
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

  private cursorToOffset(editor: Editor, pos: EditorPosition): number {
    let offset = 0;
    for (let i = 0; i < pos.line; i++)
      offset += editor.getLine(i).length + 1;
    offset += pos.ch;
    return offset;
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
    editor.replaceSelection(
      "{==" + sel + "==}{>>comment" + ts + "<<}"
    );
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    );
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
