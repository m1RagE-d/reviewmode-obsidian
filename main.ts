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
} from "obsidian";

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

interface InsertionSession {
  startLine: number;
  startCh: number;
  content: string;
  meta: string;
}

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

    this.addCommand({ id: "toggle-tracking", name: "Toggle revision tracking", icon: "pencil", callback: () => this.toggleTracking() });
    this.addCommand({ id: "accept-all", name: "Accept all changes", callback: () => this.acceptAllChanges() });
    this.addCommand({ id: "reject-all", name: "Reject all changes", callback: () => this.rejectAllChanges() });
    this.addCommand({ id: "accept-at-cursor", name: "Accept change at cursor", callback: () => this.acceptChangeAtCursor() });
    this.addCommand({ id: "reject-at-cursor", name: "Reject change at cursor", callback: () => this.rejectChangeAtCursor() });
    this.addCommand({ id: "add-comment", name: "Add comment at selection", callback: () => this.addComment() });

    this.addRibbonIcon("pencil", "Toggle revision tracking", () => this.toggleTracking());
    this.addSettingTab(new CriticTrackSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor) => {
        if (this.tracking) {
          menu.addItem((item) => item.setTitle("Accept change at cursor").setIcon("check").onClick(() => this.acceptChangeAtCursor()));
          menu.addItem((item) => item.setTitle("Reject change at cursor").setIcon("x").onClick(() => this.rejectChangeAtCursor()));
          menu.addSeparator();
        }
        menu.addItem((item) => item.setTitle(this.tracking ? "Stop tracking" : "Start tracking").setIcon("pencil").onClick(() => this.toggleTracking()));
      })
    );

    this.registerDomEvent(document, "compositionstart", () => { this.composing = true; }, true);

    this.registerDomEvent(document, "compositionend", (evt: CompositionEvent) => {
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
    }, true);

    this.registerDomEvent(document, "keydown", (evt: KeyboardEvent) => this.handleKeydown(evt), true);
  }

  onunload() {
    this.finalizeSession();
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
    }
  }

  // ── Session management ─────────────────────────────────────────────────────
  // Word-style: consecutive typing = one revision block with one timestamp.

  private finalizeSession() {
    if (!this.session) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) { this.session = null; return; }
    const editor = view.editor;

    // Document currently has: ...{++content...
    // Append: ++}{>>timestamp<<}
    const closeLine = this.session.startLine;
    const closeCh = this.session.startCh + 3 + this.session.content.length; // 3 = "{++".length
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
        // Verify cursor is at the expected position (end of open session)
        const cursor = editor.getCursor();
        const expectedCh = this.session.startCh + 3 + this.session.content.length;
        if (cursor.line === this.session.startLine && cursor.ch === expectedCh) {
          // Continue session: insert char inside the open block
          editor.replaceRange(char, cursor);
          this.session.content += char;
          return;
        }
        // Cursor moved → finalize and start new
        this.intercepting = false;
        this.finalizeSession();
        this.intercepting = true;
      }

      // Start new session
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
    // IME already committed text into editor. Wrap it retroactively.
    // First finalize any open session.
    if (this.session) {
      // Check if IME text was inserted right at end of session
      const cursor = editor.getCursor();
      const expectedCh = this.session.startCh + 3 + this.session.content.length + text.length;
      if (cursor.line === this.session.startLine && cursor.ch === expectedCh) {
        // IME text went right after session content, just extend
        this.session.content += text;
        return;
      }
      this.intercepting = false;
      this.finalizeSession();
      this.intercepting = true;
    }

    // Wrap the IME-committed text
    const cursor = editor.getCursor();
    const startCh = cursor.ch - text.length;
    if (startCh < 0) return;

    const startPos: EditorPosition = { line: cursor.line, ch: startCh };
    const meta = makeMetaComment(this.settings);

    // Insert {++ before and ++}{>>..<<} after
    editor.replaceRange("{++", startPos);
    // Now cursor shifted by 3. The text is at startCh+3 to startCh+3+text.length
    const afterText: EditorPosition = { line: cursor.line, ch: startCh + 3 + text.length };
    const closing = "++}" + meta;
    editor.replaceRange(closing, afterText);

    // Move cursor to after closing
    const finalCh = afterText.ch + closing.length;
    editor.setCursor({ line: cursor.line, ch: finalCh });
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────

  private handleKeydown(evt: KeyboardEvent) {
    if (!this.tracking || this.intercepting || this.composing) return;

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.getMode() !== "source") return;
    const editor = view.editor;

    const editorEl = (view as any).contentEl;
    if (editorEl && !editorEl.contains(evt.target as Node)) return;

    if (evt.ctrlKey || evt.metaKey || evt.altKey) return;

    const navKeys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"];
    if (navKeys.includes(evt.key)) {
      this.finalizeSession();
      return; // let navigation happen normally
    }

    const ignoreKeys = ["Tab", "Escape", "Shift", "Control", "Alt", "Meta", "CapsLock",
      "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"];
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
      // Let enter pass through normally for new lines
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
        let fromPos: EditorPosition;
        if (cursor.ch > 0) {
          fromPos = { line: cursor.line, ch: cursor.ch - 1 };
        } else {
          const prevLine = cursor.line - 1;
          fromPos = { line: prevLine, ch: editor.getLine(prevLine).length };
        }
        const deleted = editor.getRange(fromPos, cursor);
        editor.replaceRange("{--" + deleted + "--}" + meta, fromPos, cursor);
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
        if (cursor.ch >= lineText.length && cursor.line >= editor.lastLine()) return;
        let toPos: EditorPosition;
        if (cursor.ch < lineText.length) {
          toPos = { line: cursor.line, ch: cursor.ch + 1 };
        } else {
          toPos = { line: cursor.line + 1, ch: 0 };
        }
        const deleted = editor.getRange(cursor, toPos);
        editor.replaceRange("{--" + deleted + "--}" + meta, cursor, toPos);
      }
    } finally {
      this.intercepting = false;
    }
  }

  private handleSubstitution(editor: Editor, selected: string, newChar: string) {
    this.intercepting = true;
    try {
      const meta = makeMetaComment(this.settings);
      editor.replaceSelection("{~~" + selected + "~>" + newChar + "~~}" + meta);
    } finally {
      this.intercepting = false;
    }
  }

  // ── Accept / Reject ────────────────────────────────────────────────────────

  acceptAllChanges() {
    this.finalizeSession();
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    let t = view.editor.getValue();
    t = t.replace(/\{\+\+(.+?)\+\+\}/gs, "$1");
    t = t.replace(/\{--(.+?)--\}/gs, "");
    t = t.replace(/\{~~.+?~>(.+?)~~\}/gs, "$1");
    t = t.replace(/\{>>(.+?)<<\}/gs, "");
    view.editor.setValue(t);
    new Notice("All changes accepted");
  }

  rejectAllChanges() {
    this.finalizeSession();
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    let t = view.editor.getValue();
    t = t.replace(/\{\+\+(.+?)\+\+\}/gs, "");
    t = t.replace(/\{--(.+?)--\}/gs, "$1");
    t = t.replace(/\{~~(.+?)~>.+?~~\}/gs, "$1");
    t = t.replace(/\{>>(.+?)<<\}/gs, "");
    view.editor.setValue(t);
    new Notice("All changes rejected");
  }

  private findMarkupAtOffset(doc: string, offset: number): { start: number; end: number; type: "add" | "del" | "sub"; groups: string[] } | null {
    const patterns: { re: RegExp; type: "add" | "del" | "sub" }[] = [
      { re: /\{\+\+(.+?)\+\+\}(\{>>.+?<<\})?/gs, type: "add" },
      { re: /\{--(.+?)--\}(\{>>.+?<<\})?/gs, type: "del" },
      { re: /\{~~(.+?)~>(.+?)~~\}(\{>>.+?<<\})?/gs, type: "sub" },
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
    for (let i = 0; i < pos.line; i++) offset += editor.getLine(i).length + 1;
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
    if (!found) { new Notice("No change found at cursor"); return; }
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
    if (!found) { new Notice("No change found at cursor"); return; }
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
    if (!sel) { new Notice("Select text to comment on"); return; }
    const ts = this.settings.enableTimestamp ? " " + formatTimestamp(this.settings.timestampFormat) : "";
    editor.replaceSelection("{==" + sel + "==}{>>comment" + ts + "<<}");
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class CriticTrackSettingTab extends PluginSettingTab {
  plugin: CriticTrackPlugin;
  constructor(app: App, plugin: CriticTrackPlugin) { super(app, plugin); this.plugin = plugin; }
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Critic Track Settings" });
    new Setting(containerEl).setName("Enable timestamps").setDesc("Attach a timestamp to each change").addToggle((t) => t.setValue(this.plugin.settings.enableTimestamp).onChange(async (v) => { this.plugin.settings.enableTimestamp = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Timestamp format").setDesc("YYYY, MM, DD, HH, mm, ss").addText((t) => t.setPlaceholder("YYYY-MM-DD HH:mm").setValue(this.plugin.settings.timestampFormat).onChange(async (v) => { this.plugin.settings.timestampFormat = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Enable author tag").setDesc("Add your name to each change").addToggle((t) => t.setValue(this.plugin.settings.enableAuthorTag).onChange(async (v) => { this.plugin.settings.enableAuthorTag = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Author tag").setDesc("Your name or identifier").addText((t) => t.setPlaceholder("ldd").setValue(this.plugin.settings.authorTag).onChange(async (v) => { this.plugin.settings.authorTag = v; await this.plugin.saveSettings(); }));
  }
}
