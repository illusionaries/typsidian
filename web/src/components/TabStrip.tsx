import type { TabStripProps } from '../contracts';
import { IconClose, IconPlus } from './Icons';

export interface TabStripFullProps extends TabStripProps {
  onNew(): void;
}

export function TabStrip({ tabs, activePath, onSelect, onClose, onNew }: TabStripFullProps) {
  return (
    <div className="tabs" role="tablist" aria-label="Open documents">
      {tabs.map((tab) => (
        <div
          key={tab.path}
          className="tab"
          role="tab"
          data-active={tab.path === activePath}
          aria-selected={tab.path === activePath}
          title={tab.path}
          onClick={() => onSelect(tab.path)}
          onAuxClick={(event) => {
            if (event.button === 1) onClose(tab.path);
          }}
        >
          <span className="tab__label">{tab.title}</span>
          {tab.dirty ? <span className="tab__dirty" title="Unsaved changes" /> : null}
          <button
            className="tab__close"
            title="Close tab"
            onClick={(event) => {
              event.stopPropagation();
              onClose(tab.path);
            }}
          >
            <IconClose />
          </button>
        </div>
      ))}
      <button className="tab tab--new" title="New note" onClick={onNew}>
        <IconPlus />
      </button>
    </div>
  );
}
