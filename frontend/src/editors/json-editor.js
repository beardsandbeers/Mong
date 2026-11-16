import {
  EditorState,
  EditorView,
  Prec,
  acceptCompletion,
  autocompletion,
  bracketMatching,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  defaultHighlightStyle,
  defaultKeymap,
  drawSelection,
  dropCursor,
  foldGutter,
  foldKeymap,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  history,
  historyKeymap,
  indentOnInput,
  indentUnit,
  indentWithTab,
  json,
  keymap,
  lineNumbers,
  lintGutter,
  lintKeymap,
  linter,
  placeholder,
  syntaxHighlighting,
} from "./codemirror.js";
import { addResizeGrip } from "./resize-grip.js";

export function formatJson(text) {
  return JSON.stringify(JSON.parse(text), null, 2);
}

function keepTabInEditor() {
  return Prec.lowest(EditorView.domEventHandlers({
    keydown(event, view) {
      if (event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey) {
        view.inputState.tabFocusMode = -1;
        if (!event.shiftKey && acceptCompletion(view)) return true;
        const command = event.shiftKey ? indentWithTab.shift : indentWithTab.run;
        command(view);
        return true;
      }
      if (event.key === "Escape") {
        setTimeout(() => {
          if (!view.destroyed) view.inputState.tabFocusMode = -1;
        }, 0);
      }
      return false;
    },
    focus(_event, view) {
      view.inputState.tabFocusMode = -1;
      return false;
    },
  }));
}

function editorTheme() {
  return EditorView.theme({
    "&": {
      fontSize: "0.86rem",
      fontFamily: "var(--font-mono), ui-monospace, monospace",
      border: "1px solid var(--line-strong)",
      borderRadius: "8px",
      backgroundColor: "var(--editor-bg)",
      color: "var(--ink)",
    },
    "&.cm-focused": {
      outline: "2px solid var(--accent-soft)",
      outlineOffset: "1px",
    },
    ".cm-scroller": {
      fontFamily: "inherit",
      overflow: "auto",
    },
    ".cm-content": {
      padding: "8px 0",
    },
    ".cm-gutters": {
      backgroundColor: "var(--editor-gutter)",
      color: "var(--muted)",
      border: "none",
      borderRight: "1px solid var(--line)",
      borderRadius: "8px 0 0 8px",
    },
    ".cm-activeLine": { backgroundColor: "var(--hover)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--hover)" },
    ".cm-tooltip": { zIndex: "40" },
  });
}

export function renderStatus(status, issues) {
  if (!status) return;
  const first = issues?.[0];
  status.textContent = first ? first.message : "";
  status.dataset.severity = first ? (first.severity || "error") : "";
}

/**
 * CodeMirror JSON editor shared by the query box and the index definition box.
 * `completionSource` and `lintSource` are optional. `onRun` handles Ctrl+Enter.
 * `height` is the initial pixel height; the user can drag it, and `resizeKey`
 * remembers their choice in localStorage.
 */
export function createJsonEditor({
  parent,
  doc = "",
  completionSource = null,
  lintSource = null,
  lintNeedsRefresh = null,
  placeholder: placeholderText = "",
  ariaLabel = "",
  minHeight = "110px",
  height = 240,
  resizeKey = "",
  onDocChange = null,
  onRun = null,
  onFormat = null,
  extensions = [],
}) {
  const status = document.createElement("p");
  status.className = "query-editor__status";
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        ...extensions,
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        indentOnInput(),
        indentUnit.of("  "),
        EditorState.tabSize.of(2),
        bracketMatching(),
        closeBrackets(),
        completionSource
          ? autocompletion({
            override: [completionSource],
            activateOnTyping: true,
            maxRenderedOptions: 60,
          })
          : [],
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        highlightActiveLine(),
        json(),
        lintSource ? lintGutter() : [],
        lintSource
          ? linter((editor) => lintSource(editor), {
            delay: 150,
            ...(lintNeedsRefresh ? { needsRefresh: lintNeedsRefresh } : {}),
          })
          : [],
        EditorView.lineWrapping,
        placeholder(placeholderText),
        EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
        keepTabInEditor(),
        Prec.high(keymap.of([
          onRun
            ? {
              key: "Mod-Enter",
              run() {
                onRun();
                return true;
              },
            }
            : [],
          onFormat
            ? {
              key: "Alt-Shift-f",
              run() {
                onFormat();
                return true;
              },
            }
            : [],
        ].flat())),
        keymap.of([
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...lintKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...foldKeymap,
          indentWithTab,
        ]),
        editorTheme(),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onDocChange?.(update);
        }),
      ],
    }),
  });
  addResizeGrip(view.dom, {
    height,
    minHeight: parseFloat(minHeight) || 110,
    fitHeight: () => view.contentHeight + 2,
    storageKey: resizeKey,
    onResize: () => view.requestMeasure(),
  });
  // Short documents leave empty scroller space below the content, which CodeMirror ignores.
  view.scrollDOM.addEventListener("mousedown", (event) => {
    if (event.target !== view.scrollDOM || event.button !== 0) return;
    event.preventDefault();
    view.focus();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
  });
  parent.append(status);
  parent.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
    view.inputState.tabFocusMode = -1;
  }, true);
  const resize = new ResizeObserver(() => view.requestMeasure());
  return { view, status, resize };
}
