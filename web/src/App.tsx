import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAppState, store } from './store';
import { lineColumn } from '../../shared/doc';
import type { SourceRange } from '../../shared/doc';
import type { RevealRequest, ViewMode } from './contracts';
import { Toolbar } from './components/Toolbar';
import { TabStrip } from './components/TabStrip';
import { StatusBar } from './components/StatusBar';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { Toasts } from './components/Toasts';
import { Splash } from './components/Splash';
import { EditorPane } from './editor/EditorPane';
import { PreviewSurface } from './preview/PreviewSurface';
import { FileTree, OutlinePanel, useVaultEvents } from './sidebar';

const SPLIT_MIN = 0.22;
const SPLIT_MAX = 0.78;

export default function App() {
  const state = useAppState();
  const [splitRatio, setSplitRatio] = useState(0.46);
  const draggingRef = useRef(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void store.init();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = state.theme;
  }, [state.theme]);

  // Vault watcher: react to files changed outside the app (external editor, git).
  const { connected: vaultConnected } = useVaultEvents((events) => {
    void store.handleVaultEvents(events);
  });

  const tab = state.tabs.find((candidate) => candidate.path === state.activePath) ?? null;
  const render = state.activePath ? state.renders[state.activePath] ?? null : null;
  const language = store.language;
  const dirtyPaths = useMemo(
    () => state.tabs.filter((entry) => entry.source !== entry.savedSource).map((entry) => entry.path),
    [state.tabs],
  );

  // ------------------------------------------------------------ shortcuts --
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (event.altKey && !meta && (event.key === '1' || event.key === '2' || event.key === '3')) {
        event.preventDefault();
        const modes: ViewMode[] = ['split', 'visual', 'preview'];
        store.setMode(modes[Number(event.key) - 1]);
        return;
      }
      if (meta && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void store.save();
        return;
      }
      if (meta && event.shiftKey && event.key.toLowerCase() === 'e') {
        event.preventDefault();
        void store.exportPdf();
        return;
      }
      if (meta && event.key === '\\') {
        event.preventDefault();
        store.toggleSidebar();
        return;
      }
      if (event.key === 'Escape') {
        if (state.diagnosticsOpen) store.toggleDiagnostics();
        else if (state.editingBlockId) store.cancelEdit();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [state.diagnosticsOpen, state.editingBlockId]);

  // ------------------------------------------------------------- splitter --
  const onSplitterDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    draggingRef.current = true;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!draggingRef.current || !bodyRef.current) return;
      const rect = bodyRef.current.getBoundingClientRect();
      const ratio = (event.clientX - rect.left) / rect.width;
      setSplitRatio(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, ratio)));
    };
    const onUp = () => {
      draggingRef.current = false;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  // -------------------------------------------------------------- render ---
  if (!state.ready) return <Splash error={null} />;
  if (state.fatalError) return <Splash error={state.fatalError} />;

  const cursor = tab ? lineColumn(tab.source, tab.cursor.offset) : { line: 1, column: 1 };
  const diagnostics = render?.diagnostics ?? [];
  const reveal: RevealRequest | null = state.reveal;

  const editorPane = tab ? (
    <EditorPane
      path={tab.path}
      source={tab.source}
      language={language}
      diagnostics={diagnostics}
      reveal={reveal}
      blocks={render?.blocks ?? []}
      blockActions={store.blockActions.bind(store)}
      onChange={(next) => store.setSource(next)}
      onSave={() => void store.save()}
      onCursor={(next) => store.setCursor(next)}
      onVisibleRange={(range: SourceRange) => store.setVisibleRange(range)}
      onActiveBlock={(block) => store.setActiveBlockId(block ? block.id : null)}
    />
  ) : null;

  const previewPane = (
    <PreviewSurface
      render={render}
      source={tab?.source ?? ''}
      language={language}
      mode={state.mode}
      zoom={state.zoom}
      pending={state.pending}
      error={state.renderError}
      activeBlockId={state.activeBlockId}
      revealBlockId={state.revealBlockId}
      editingBlockId={state.editingBlockId}
      onRequestEdit={(blockId) => store.requestEdit(blockId)}
      onActivateBlock={(block) => {
        store.setReveal(block.range, false);
        if (state.mode === 'visual') store.requestEdit(block.id);
      }}
      onRunBlockAction={(blockId, actionId) => store.runBlockAction(blockId, actionId)}
      onEditBlockText={(blockId, text) => store.editBlockText(blockId, text)}
      onCommitEdit={() => store.cancelEdit()}
      onZoom={(zoom) => store.setZoom(zoom)}
      onVisibleBlock={() => undefined}
    />
  );

  return (
    <div className={`app${store.isDragging ? ' app--dragging' : ''}`}>
      <Toolbar
        mode={state.mode}
        workspaceTitle={state.workspace?.title ?? ''}
        activePath={state.activePath}
        theme={state.theme}
        sidebarOpen={state.sidebarOpen}
        zoom={state.zoom}
        pending={state.pending}
        dirty={dirtyPaths.length > 0}
        onMode={(mode) => store.setMode(mode)}
        onToggleSidebar={() => store.toggleSidebar()}
        onToggleTheme={() => store.toggleTheme()}
        onRefresh={() => void store.refreshWorkspace()}
        onExportPdf={() => void store.exportPdf()}
        onZoom={(zoom) => store.setZoom(zoom)}
      />

      <div className="app__body">
        <div className="workspace">
          <aside className={`sidebar${state.sidebarOpen ? '' : ' sidebar--collapsed'}`}>
            <div className="sidebar-tabs" role="tablist">
              <button
                className="sidebar-tab"
                role="tab"
                aria-selected={state.sidebarTab === 'files'}
                onClick={() => store.setSidebarTab('files')}
              >
                Files
              </button>
              <button
                className="sidebar-tab"
                role="tab"
                aria-selected={state.sidebarTab === 'outline'}
                onClick={() => store.setSidebarTab('outline')}
              >
                Outline
              </button>
            </div>
            <div className="sidebar__body">
              {state.sidebarTab === 'files' ? (
                <FileTree
                  workspace={state.workspace}
                  activePath={state.activePath}
                  dirtyPaths={dirtyPaths}
                  onOpen={(path) => void store.openFile(path)}
                  onCreateFile={(path) => store.createFile(path)}
                  onRename={(from, to) => store.renameFile(from, to)}
                  onDelete={(path) => store.deleteFile(path)}
                  onRefresh={() => void store.refreshWorkspace()}
                />
              ) : (
                <OutlinePanel
                  outline={render?.outline ?? []}
                  activeBlockId={state.activeBlockId}
                  onJump={(item) => {
                    store.setReveal(item.range, false);
                    if (state.mode === 'visual') store.requestEdit(item.blockId);
                  }}
                />
              )}
            </div>
            <div className="sidebar__foot">
              <div
                title={state.workspace?.root ?? ''}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '3px 4px',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  color: 'var(--fg-subtle)',
                  overflow: 'hidden',
                }}
              >
                <span
                  className="statusbar__dot"
                  style={{ background: vaultConnected ? 'var(--success)' : 'var(--fg-subtle)' }}
                />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {state.workspace?.root ?? 'no vault'}
                </span>
              </div>
            </div>
          </aside>

          <div className="main">
            <TabStrip
              tabs={state.tabs.map((entry) => ({
                path: entry.path,
                title: entry.path.split('/').pop() ?? entry.path,
                dirty: entry.source !== entry.savedSource,
              }))}
              activePath={state.activePath}
              onSelect={(path) => void store.openFile(path)}
              onClose={(path) => store.closeTab(path)}
              onNew={() => {
                const name = `note-${Date.now().toString(36).slice(-4)}.typ`;
                void store.createFile(name);
              }}
            />

            <div className="panes" ref={bodyRef}>
              {!tab ? (
                <div className="empty-state">
                  <div className="empty-state__title">No document open</div>
                  <div className="empty-state__hint">
                    Pick a note in the sidebar, create a new one, or press{' '}
                    <kbd>⌘S</kbd> to save. Documents are plain <code>.typ</code> files in your vault.
                  </div>
                </div>
              ) : state.mode === 'split' ? (
                <>
                  <div className="pane pane--editor" style={{ flex: `0 0 ${splitRatio * 100}%` }}>
                    <div className="pane__header">
                      <span>Source</span>
                      <span className="badge">{language}</span>
                      <span className="spacer" />
                      {dirtyPaths.includes(tab.path) ? (
                        <span className="badge badge--warning">unsaved</span>
                      ) : (
                        <span className="badge badge--success">saved</span>
                      )}
                    </div>
                    <div className="pane__body">{editorPane}</div>
                  </div>
                  <div
                    className="splitter"
                    role="separator"
                    aria-orientation="vertical"
                    onPointerDown={onSplitterDown}
                  />
                  <div className="pane pane--preview" style={{ flex: '1 1 auto' }}>
                    <div className="pane__header">
                      <span>Preview</span>
                      <span className="badge">{render?.pages.length ?? 0} pages</span>
                      <span className="spacer" />
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>
                        {render ? `${render.stats.renderMs.toFixed(0)} ms` : ''}
                      </span>
                    </div>
                    <div className="pane__body">{previewPane}</div>
                  </div>
                </>
              ) : (
                <div className="pane pane--preview pane--full">
                  <div className="pane__body">{previewPane}</div>
                </div>
              )}

              {state.diagnosticsOpen ? (
                <DiagnosticsPanel
                  diagnostics={diagnostics}
                  source={tab?.source ?? ''}
                  onJump={(diagnostic) => {
                    if (diagnostic.range) store.setReveal(diagnostic.range, true);
                    store.setMode(state.mode === 'split' ? 'split' : 'split');
                  }}
                  onClose={() => store.toggleDiagnostics()}
                />
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <StatusBar
        path={state.activePath}
        language={language}
        cursor={cursor}
        pageCount={render?.pages.length ?? 0}
        blockCount={render?.blocks.length ?? 0}
        renderMs={render?.stats.renderMs ?? 0}
        pending={state.pending}
        diagnostics={diagnostics}
        mode={state.mode}
        wordCount={store.wordCount}
        onToggleDiagnostics={() => store.toggleDiagnostics()}
      />

      <Toasts toasts={state.toasts} onDismiss={(id) => store.dismissToast(id)} />
    </div>
  );
}
