export const panelCss = `
:host {
  all: initial;
  color-scheme: dark;
  --bg: #080808;
  --bg2: #161616;
  --panel: #161616;
  --surface: #242424;
  --surface-2: #2e2e2e;
  --line: rgba(255,255,255,.10);
  --line-soft: rgba(255,255,255,.078);
  --line-strong: rgba(255,255,255,.20);
  --fg: #fafafa;
  --muted: #aeaeae;
  --faint: #808080;
  --accent: #a2bcff;
  --blue: #7698fd;
  --green: #6bd586;
  --yellow: #f2cf76;
  --violet: #9e99f7;
  --danger: #f17471;
  --radius: 8px;
  --shadow-raised: 0 2px 4px rgba(0,0,0,.3), 0 1px 2px rgba(0,0,0,.3), 0 0 0 .5px rgba(255,255,255,.16), 0 -.5px 0 rgba(255,255,255,.06);
  --shadow-floating: 0 16px 32px rgba(0,0,0,.3), 0 8px 16px rgba(0,0,0,.3), 0 0 0 .5px rgba(255,255,255,.16), 0 -.5px 0 rgba(255,255,255,.06);
  font: 12px/1.48 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
* { box-sizing: border-box; }
button, select, input { font: inherit; }
.ocgo-fab {
  position: fixed; right: 20px; bottom: 20px; width: 48px; height: 48px; border-radius: 50%;
  border: 1px solid rgba(255,255,255,.20); background: #080808; color: #fafafa; cursor: grab;
  z-index: 2147483647; display: grid; place-items: center; box-shadow: 0 8px 16px rgba(0,0,0,.3), 0 0 0 .5px rgba(255,255,255,.16);
  touch-action: none; user-select: none;
  transition: transform .12s ease, box-shadow .12s ease, border-color .12s ease;
}
.ocgo-fab:hover { transform: scale(1.04); border-color: rgba(255,255,255,.33); box-shadow: 0 8px 16px rgba(0,0,0,.4), 0 0 0 .5px rgba(255,255,255,.20); }
.ocgo-fab.ocgo-open { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(118,152,253,.18), 0 8px 16px rgba(0,0,0,.4); }
.ocgo-fab.ocgo-dragging { cursor: grabbing; transform: none; }
.ocgo-fab svg { width: 32px; height: 32px; display: block; }
.ocgo-panel {
  position: fixed; right: 20px; bottom: 80px; z-index: 2147483646;
  width: min(980px, calc(100vw - 32px)); height: min(760px, calc(100vh - 104px));
  min-width: 680px; min-height: 480px; display: flex; flex-direction: column;
  color: var(--fg); background: var(--panel);
  border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden;
  box-shadow: var(--shadow-floating);
}
.ocgo-panel.ocgo-hidden, .ocgo-error.ocgo-hidden, .ocgo-chart-tooltip.ocgo-hidden { display: none; }
.ocgo-header { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--line); cursor: grab; background: #161616; user-select: none; }
.ocgo-header:active { cursor: grabbing; }
.ocgo-brand { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.ocgo-title { font-size: 13px; font-weight: 720; letter-spacing: .15px; }
.ocgo-subtitle { color: var(--faint); font-size: 10px; letter-spacing: .35px; text-transform: uppercase; }
.ocgo-workspace { color: var(--muted); max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 3px 8px; border: 1px solid var(--line-soft); border-radius: 999px; background: rgba(255,255,255,.025); }
.ocgo-icon-btn, .ocgo-btn, .ocgo-tab, .ocgo-sync-btn, .ocgo-danger-btn {
  border: 1px solid var(--line); background: rgba(255,255,255,.045); color: var(--fg); border-radius: 7px; cursor: pointer;
}
.ocgo-icon-btn { width: 28px; height: 28px; display: grid; place-items: center; padding: 0; color: var(--muted); }
.ocgo-icon-btn:hover, .ocgo-btn:hover, .ocgo-tab:hover { background: rgba(255,255,255,.09); color: #fff; }
.ocgo-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--line-soft); background: #161616; }
.ocgo-toolbar label { display: flex; align-items: center; gap: 4px; color: var(--faint); font-size: 10px; text-transform: uppercase; letter-spacing: .35px; }
select, input[type="datetime-local"] {
  background: #080808; border: 1px solid var(--line); color: var(--fg); border-radius: 6px; padding: 4px 7px; outline: none; max-width: 190px;
}
select:focus, input:focus { border-color: rgba(118,152,253,.75); }
.ocgo-sync-btn { padding: 5px 10px; background: #fafafa; color: #161616; border-color: #fafafa; font-weight: 650; }
.ocgo-sync-btn:hover { background: #ffffff; }
.ocgo-sync-btn:disabled { opacity: .55; cursor: wait; }
.ocgo-sync-btn.ocgo-stop { background: var(--yellow); border-color: var(--yellow); }
.ocgo-btn { padding: 5px 9px; }
.ocgo-danger-btn { padding: 5px 9px; border-color: rgba(241,116,113,.45); color: #f29b96; background: rgba(241,116,113,.08); }
.ocgo-danger-btn.ocgo-confirm { background: #f17471; color: #161616; font-weight: 700; }
.ocgo-custom-range { display: none; align-items: center; gap: 6px; }
.ocgo-custom-range.ocgo-show { display: flex; }
.ocgo-tabs { display: flex; padding: 0 12px; border-bottom: 1px solid var(--line); background: #161616; }
.ocgo-tab { flex: 1; border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; padding: 8px 4px; color: var(--muted); }
.ocgo-tab.ocgo-active { color: #fafafa; border-bottom-color: #fafafa; }
.ocgo-statusbar { min-height: 29px; display: flex; align-items: center; gap: 8px; padding: 5px 12px; border-bottom: 1px solid var(--line-soft); color: var(--muted); font-size: 11px; }
.ocgo-status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); flex: 0 0 auto; }
.ocgo-status-dot.ok { background: var(--green); box-shadow: 0 0 8px rgba(107,213,134,.55); }
.ocgo-status-dot.busy { background: var(--yellow); animation: ocgoPulse 1s ease-in-out infinite; }
.ocgo-status-dot.err { background: var(--danger); }
@keyframes ocgoPulse { 50% { opacity: .35; } }
.ocgo-body { flex: 1; min-height: 0; overflow: auto; padding: 12px; }
.ocgo-view { display: none; flex-direction: column; gap: 12px; }
.ocgo-view.ocgo-active { display: flex; }
.ocgo-error { margin: 8px 12px 0; border: 1px solid rgba(241,116,113,.35); background: rgba(241,116,113,.08); color: #f29b96; border-radius: 8px; padding: 7px 9px; }
.ocgo-cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.ocgo-card { border: 1px solid var(--line-soft); background: var(--surface); border-radius: 8px; padding: 10px 11px; min-width: 0; box-shadow: 0 0 0 .5px rgba(255,255,255,.08) inset; }
.ocgo-card-label { color: var(--faint); font-size: 10px; text-transform: uppercase; letter-spacing: .45px; }
.ocgo-card-value { margin-top: 3px; font: 600 17px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: -.2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ocgo-card-sub { margin-top: 3px; color: var(--faint); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ocgo-card.accent .ocgo-card-value { color: var(--green); }
.ocgo-card.blue .ocgo-card-value { color: var(--blue); }
.ocgo-card.violet .ocgo-card-value { color: var(--violet); }
.ocgo-section { border: 1px solid var(--line-soft); border-radius: 8px; background: var(--surface); padding: 10px; box-shadow: var(--shadow-raised); }
.ocgo-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.ocgo-section-title { font-size: 12px; font-weight: 680; color: var(--fg); }
.ocgo-section-note { color: var(--faint); font-size: 10px; }
.ocgo-chart-controls { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.ocgo-chart-zoom-label { color: var(--faint); font-size: 10px; text-transform: uppercase; letter-spacing: .35px; }
.ocgo-chart-zoom { display: inline-flex; align-items: stretch; border: 1px solid var(--line); border-radius: 7px; overflow: hidden; background: #161616; }
.ocgo-zoom-btn, .ocgo-zoom-value { border: 0; background: transparent; color: var(--muted); cursor: pointer; padding: 3px 8px; min-width: 28px; }
.ocgo-zoom-btn:hover, .ocgo-zoom-value:hover { background: rgba(255,255,255,.08); color: var(--fg); }
.ocgo-zoom-btn:disabled { opacity: .35; cursor: default; }
.ocgo-zoom-value { min-width: 52px; border-left: 1px solid var(--line); border-right: 1px solid var(--line); color: var(--fg); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ocgo-chart-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.ocgo-chart-grid.ocgo-chart-zoomed { grid-template-columns: 1fr; }
.ocgo-chart-box { min-height: var(--ocgo-chart-box-height, 250px); display: flex; flex-direction: column; }
.ocgo-chart-host { flex: 0 0 auto; display: flex; flex-direction: column; overflow: visible; }
.ocgo-chart-svg { width: var(--ocgo-chart-width, 100%); height: var(--ocgo-chart-height, 195px); overflow: visible; flex: 0 0 auto; }
.ocgo-chart-title-group { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 9px; min-width: 0; }
.ocgo-section-average { color: var(--faint); font-size: 10px; font-weight: 400; }
.ocgo-grid-line { stroke: rgba(255,255,255,.07); stroke-width: 1; }
.ocgo-grid-line-v { stroke-dasharray: 3 5; }
.ocgo-axis-label { fill: var(--faint); font-size: 9px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ocgo-point { cursor: default; }
.ocgo-bar { opacity: .92; }
.ocgo-hover-band { fill: rgba(255,255,255,.055); pointer-events: none; }
.ocgo-hover-target { fill: transparent; pointer-events: all; }
.ocgo-hover-target:focus { outline: none; }
.ocgo-legend { display: flex; gap: 10px; flex-wrap: wrap; color: var(--muted); font-size: 9px; padding: 0 6px; }
.ocgo-legend span { display: inline-flex; align-items: center; gap: 4px; }
.ocgo-legend i { width: 7px; height: 7px; border-radius: 2px; display: inline-block; }
.ocgo-chart-empty { flex: 1; display: grid; place-items: center; color: var(--faint); min-height: 170px; text-align: center; }
.ocgo-table-wrap { overflow: auto; border: 1px solid var(--line-soft); border-radius: 9px; max-height: 420px; }
.ocgo-table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
.ocgo-table th, .ocgo-table td { padding: 6px 7px; border-bottom: 1px solid var(--line-soft); text-align: right; white-space: nowrap; }
.ocgo-table th { position: sticky; top: 0; z-index: 1; background: var(--surface-2); color: var(--muted); font-size: 9px; text-transform: uppercase; letter-spacing: .35px; }
.ocgo-table td { color: #dbdbdb; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ocgo-table th:first-child, .ocgo-table td:first-child, .ocgo-table th.left, .ocgo-table td.left { text-align: left; font-family: inherit; }
.ocgo-table tr:last-child td { border-bottom: 0; }
.ocgo-table tbody tr:hover td { background: rgba(255,255,255,.025); }
.ocgo-table a { color: var(--accent); text-decoration: none; }
.ocgo-table a:hover { text-decoration: underline; }
.ocgo-muted { color: var(--muted); }
.ocgo-pill { display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px; border-radius: 999px; font: 600 9px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; border: 1px solid var(--line); }
.ocgo-pill.succeeded { color: #b8e9c1; border-color: rgba(107,213,134,.28); background: rgba(107,213,134,.07); }
.ocgo-pill.failed, .ocgo-pill.rejected { color: #f29b96; border-color: rgba(241,116,113,.28); background: rgba(241,116,113,.07); }
.ocgo-pill.cancelled { color: #f2cf76; border-color: rgba(242,207,118,.28); background: rgba(242,207,118,.07); }
.ocgo-pill.legacy { color: var(--muted); border-color: var(--line); background: rgba(255,255,255,.04); }
.ocgo-empty { border: 1px dashed var(--line); border-radius: 10px; padding: 34px 16px; text-align: center; color: var(--muted); }
.ocgo-empty strong { display: block; color: var(--fg); margin-bottom: 4px; }
.ocgo-toolbar-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.ocgo-pager { display: flex; align-items: center; justify-content: flex-end; gap: 6px; color: var(--muted); font-size: 10px; }
.ocgo-data-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.ocgo-kv { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 6px 10px; font-size: 11px; }
.ocgo-kv dt { color: var(--faint); }
.ocgo-kv dd { margin: 0; color: var(--fg); overflow-wrap: anywhere; }
.ocgo-note { color: var(--muted); font-size: 10.5px; line-height: 1.5; }
.ocgo-warning { border: 1px solid rgba(242,207,118,.35); background: rgba(242,207,118,.07); color: #f2cf76; border-radius: 8px; padding: 7px 9px; font-size: 10.5px; }
.ocgo-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.ocgo-pricing-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; color: var(--faint); font-size: 10px; }
.ocgo-pricing-meta a { color: var(--accent); text-decoration: none; }
.ocgo-pricing-meta a:hover { text-decoration: underline; }
.ocgo-pricing-table-wrap { max-height: 260px; }
.ocgo-price-period { display: inline-flex; align-items: center; padding: 1px 6px; border: 1px solid var(--line); border-radius: 999px; font: 600 9px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ocgo-price-period.peak { color: #f2cf76; border-color: rgba(242,207,118,.28); background: rgba(242,207,118,.07); }
.ocgo-price-period.off-peak { color: #b8e9c1; border-color: rgba(107,213,134,.28); background: rgba(107,213,134,.07); }
.ocgo-price-period.all { color: var(--muted); background: rgba(255,255,255,.04); }
.ocgo-log-list { max-height: 190px; overflow: auto; border: 1px solid var(--line-soft); border-radius: 8px; padding: 6px; background: #080808; font: 10px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ocgo-log-row { display: grid; grid-template-columns: 54px 44px minmax(0, 1fr); gap: 6px; padding: 1px 0; border-bottom: 1px solid rgba(255,255,255,.04); }
.ocgo-log-row:last-child { border-bottom: 0; }
.ocgo-log-time { color: var(--faint); }
.ocgo-log-level { color: var(--muted); text-transform: uppercase; }
.ocgo-log-level.error { color: var(--danger); }
.ocgo-log-level.warn { color: var(--yellow); }
.ocgo-log-msg { color: #dbdbdb; overflow-wrap: anywhere; }
.ocgo-resize-handle { position: absolute; z-index: 5; touch-action: none; }
.ocgo-resize-n, .ocgo-resize-s { left: 10px; right: 10px; height: 8px; }
.ocgo-resize-e, .ocgo-resize-w { top: 10px; bottom: 10px; width: 8px; }
.ocgo-resize-n { top: 0; cursor: n-resize; }
.ocgo-resize-s { bottom: 0; cursor: s-resize; }
.ocgo-resize-e { right: 0; cursor: e-resize; }
.ocgo-resize-w { left: 0; cursor: w-resize; }
.ocgo-resize-ne, .ocgo-resize-nw, .ocgo-resize-se, .ocgo-resize-sw { width: 14px; height: 14px; }
.ocgo-resize-ne { top: 0; right: 0; cursor: ne-resize; }
.ocgo-resize-nw { top: 0; left: 0; cursor: nw-resize; }
.ocgo-resize-se { right: 0; bottom: 0; cursor: nwse-resize; }
.ocgo-resize-se::after { content: ""; position: absolute; right: 3px; bottom: 3px; width: 7px; height: 7px; border-right: 1px solid var(--muted); border-bottom: 1px solid var(--muted); }
.ocgo-resize-sw { left: 0; bottom: 0; cursor: nesw-resize; }
.ocgo-chart-tooltip {
  position: fixed; z-index: 2147483647; width: 296px; max-width: calc(100vw - 32px);
  pointer-events: none; border: 1px solid var(--line-strong); border-radius: 8px;
  background: var(--surface); color: var(--fg); padding: 9px 10px;
  box-shadow: var(--shadow-floating);
  font-size: 10px; line-height: 1.45;
}
.ocgo-tooltip-head { color: #fafafa; font-weight: 650; padding-bottom: 5px; margin-bottom: 5px; border-bottom: 1px solid var(--line-soft); }
.ocgo-tooltip-grid { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 2px 8px; margin: 0; }
.ocgo-tooltip-grid dt { color: var(--faint); }
.ocgo-tooltip-grid dd { margin: 0; color: #dbdbdb; text-align: right; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ocgo-tooltip-note { margin-top: 6px; padding-top: 5px; border-top: 1px solid var(--line-soft); color: var(--faint); line-height: 1.4; }
.ocgo-toast {
  position: absolute; left: 50%; top: 10px; z-index: 8; width: max-content; max-width: min(280px, calc(100% - 36px));
  padding: 6px 10px; border: 1px solid var(--line-strong); border-radius: 10px;
  background: var(--surface); color: var(--fg); box-shadow: var(--shadow-floating);
  font-size: 10.5px; line-height: 1.4; text-align: center; pointer-events: none;
  transform: translateX(-50%);
}
.ocgo-toast.ocgo-hidden { display: none; }
.ocgo-toast.ocgo-toast-in { animation: ocgoToastDrop .22s cubic-bezier(.2,.8,.2,1); }
@keyframes ocgoToastDrop {
  from { opacity: 0; transform: translate(-50%, -10px) scale(.98); }
  to { opacity: 1; transform: translate(-50%, 0) scale(1); }
}
.ocgo-metric-hover { cursor: help; text-decoration: underline; text-decoration-style: dotted; text-decoration-color: var(--line-strong); text-underline-offset: 3px; }
.ocgo-metric-hover:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
.ocgo-body, .ocgo-table-wrap, .ocgo-log-list, .ocgo-chart-host {
  scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent;
}
.ocgo-body::-webkit-scrollbar, .ocgo-table-wrap::-webkit-scrollbar, .ocgo-log-list::-webkit-scrollbar, .ocgo-chart-host::-webkit-scrollbar {
  width: 8px; height: 8px;
}
.ocgo-body::-webkit-scrollbar-track, .ocgo-table-wrap::-webkit-scrollbar-track, .ocgo-log-list::-webkit-scrollbar-track, .ocgo-chart-host::-webkit-scrollbar-track {
  background: transparent;
}
.ocgo-body::-webkit-scrollbar-thumb, .ocgo-table-wrap::-webkit-scrollbar-thumb, .ocgo-log-list::-webkit-scrollbar-thumb, .ocgo-chart-host::-webkit-scrollbar-thumb {
  background: #5c5c5c; border: 2px solid transparent; border-radius: 999px; background-clip: padding-box;
}
.ocgo-body::-webkit-scrollbar-thumb:hover, .ocgo-table-wrap::-webkit-scrollbar-thumb:hover, .ocgo-log-list::-webkit-scrollbar-thumb:hover, .ocgo-chart-host::-webkit-scrollbar-thumb:hover {
  background: #808080; border: 2px solid transparent; border-radius: 999px; background-clip: padding-box;
}
.ocgo-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
@media (max-width: 820px) {
  .ocgo-panel { left: 8px !important; right: 8px !important; top: 8px !important; bottom: 8px !important; width: auto !important; height: auto !important; min-width: 0; min-height: 0; }
  .ocgo-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ocgo-chart-grid, .ocgo-data-grid { grid-template-columns: 1fr; }
  .ocgo-resize-handle { display: none; }
  .ocgo-workspace { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .ocgo-status-dot.busy { animation: none; }
  .ocgo-fab { transition: none; }
}
`;
