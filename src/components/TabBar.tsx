import { tabLabel, tabTitle, type Tab } from "../tabs";

type Props = {
  tabs: Tab[];
  activeId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
};

/** タブの帯。ホームは先頭固定で閉じられない */
export function TabBar({ tabs, activeId, onActivate, onClose }: Props) {
  return (
    <div className="tab-strip" role="tablist">
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            className={`tab-strip-item${active ? " active" : ""} kind-${tab.kind}`}
            title={tabTitle(tab)}
            onClick={() => onActivate(tab.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onActivate(tab.id);
              }
            }}
            onAuxClick={(e) => {
              // 中クリックで閉じる
              if (e.button === 1 && tab.kind !== "home") onClose(tab.id);
            }}
          >
            <span className="tab-strip-label">{tabLabel(tab)}</span>
            {tab.kind !== "home" && (
              <button
                type="button"
                className="tab-strip-close"
                title="タブを閉じる"
                aria-label="タブを閉じる"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
