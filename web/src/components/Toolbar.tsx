import type { ViewMode } from '../contracts';
import {
  IconDownload,
  IconEye,
  IconFit,
  IconMoon,
  IconRefresh,
  IconSidebar,
  IconSplit,
  IconSun,
  IconVisual,
  IconZoomIn,
  IconZoomOut,
} from './Icons';

export interface ToolbarProps {
  mode: ViewMode;
  workspaceTitle: string;
  activePath: string | null;
  theme: 'dark' | 'light';
  sidebarOpen: boolean;
  zoom: number;
  pending: boolean;
  dirty: boolean;
  onMode(mode: ViewMode): void;
  onToggleSidebar(): void;
  onToggleTheme(): void;
  onRefresh(): void;
  onExportPdf(): void;
  onZoom(zoom: number): void;
}

const MODES: Array<{ id: ViewMode; label: string; hint: string; icon: typeof IconSplit }> = [
  { id: 'split', label: 'Split', hint: '⌥1', icon: IconSplit },
  { id: 'visual', label: 'Visual', hint: '⌥2', icon: IconVisual },
  { id: 'preview', label: 'Preview', hint: '⌥3', icon: IconEye },
];

export function Toolbar(props: ToolbarProps) {
  const fileTitle = props.activePath?.split('/').pop() ?? 'No file';
  return (
    <header className="toolbar">
      <div className="toolbar__brand">
        <span className="toolbar__mark">T</span>
        <span className="toolbar__title">Typsidian</span>
        <span className="toolbar__sub">
          {props.workspaceTitle}
          {props.activePath ? ` / ${fileTitle}` : ''}
          {props.dirty ? ' •' : ''}
        </span>
      </div>

      <div className="toolbar__divider" />

      <button
        className="icon-button"
        aria-pressed={props.sidebarOpen}
        title="Toggle sidebar (⌘\)"
        onClick={props.onToggleSidebar}
      >
        <IconSidebar />
      </button>

      <div className="toolbar__spacer" />

      <div className="segmented" role="tablist" aria-label="Editor mode">
        {MODES.map((entry) => {
          const Icon = entry.icon;
          return (
            <button
              key={entry.id}
              className="segmented__item"
              role="tab"
              aria-pressed={props.mode === entry.id}
              title={`${entry.label} mode (${entry.hint})`}
              onClick={() => props.onMode(entry.id)}
            >
              <Icon />
              {entry.label}
              <span className="segmented__key">{entry.hint}</span>
            </button>
          );
        })}
      </div>

      <div className="toolbar__spacer" />

      {props.mode !== 'split' ? (
        <div className="toolbar__group">
          <button
            className="icon-button"
            title="Zoom out"
            onClick={() => props.onZoom(props.zoom - 0.1)}
          >
            <IconZoomOut />
          </button>
          <button
            className="icon-button"
            title="Reset zoom"
            onClick={() => props.onZoom(1)}
          >
            <IconFit />
          </button>
          <button
            className="icon-button"
            title="Zoom in"
            onClick={() => props.onZoom(props.zoom + 0.1)}
          >
            <IconZoomIn />
          </button>
          <div className="toolbar__divider" />
        </div>
      ) : null}

      <div className="toolbar__group">
        <button className="icon-button" title="Reload workspace" onClick={props.onRefresh}>
          <IconRefresh />
        </button>
        <button className="icon-button" title="Export PDF (⌘⇧E)" onClick={props.onExportPdf}>
          <IconDownload />
        </button>
        <button
          className="icon-button"
          title={props.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          onClick={props.onToggleTheme}
        >
          {props.theme === 'dark' ? <IconSun /> : <IconMoon />}
        </button>
      </div>
    </header>
  );
}
