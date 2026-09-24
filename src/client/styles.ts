/**
 * Plugin stylesheet, injected once by apply() and removed on unload. Colors
 * come from DSH's --dsw-alias-* tokens so light and dark themes follow the
 * shell; fallbacks only apply outside DSH.
 */
export const CSS = `
.rwf {
  --rwf-fg: var(--dsw-alias-label-primary, #1f2329);
  --rwf-sub: var(--dsw-alias-label-secondary, #5b6068);
  --rwf-muted: var(--dsw-alias-label-tertiary, #8f959e);
  --rwf-border: var(--dsw-alias-border-l3, rgba(128,128,128,.22));
  --rwf-border-strong: var(--dsw-alias-border-l2, rgba(128,128,128,.35));
  --rwf-layer: var(--dsw-alias-bg-layer-1, transparent);
  --rwf-layer2: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.06));
  --rwf-hover: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.08));
  --rwf-active: var(--dsw-alias-interactive-bg-active, rgba(128,128,128,.14));
  --rwf-brand: var(--dsw-alias-brand-primary, #4d6bfe);
  --rwf-ok: var(--dsw-alias-state-success-primary, #1f9d55);
  --rwf-warn: var(--dsw-alias-state-warn-primary, #d98a00);
  --rwf-err: var(--dsw-alias-state-error-primary, #d64545);
  --rwf-info: var(--dsw-alias-state-business-primary, var(--rwf-brand));
  --rwf-run: var(--dsw-alias-state-business-primary, #3b82f6);
  --rwf-code: var(--dsw-alias-markdown-code-block, rgba(128,128,128,.08));
  --rwf-radius: 10px;
  color: var(--rwf-fg); font-size: 13px; line-height: 1.6;
}
.rwf *, .rwf *::before, .rwf *::after { box-sizing: border-box; }
.rwf code { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; background: var(--rwf-code); padding: 0 4px; border-radius: 4px; }
.rwf .small { font-size: 12px; }
.rwf-muted { color: var(--rwf-muted); }
.rwf-sub { color: var(--rwf-sub); }
.rwf-spacer { flex: 1; }
.rwf-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.rwf-ok-text { color: var(--rwf-ok); } .rwf-err-text, .rwf-error { color: var(--rwf-err); } .rwf-warn-text { color: var(--rwf-warn); }

/* view shell */
.rwf-view { height: 100%; overflow: auto; padding: 16px 24px 180px; }
.rwf-card { border: 1px solid var(--rwf-border); border-radius: var(--rwf-radius); padding: 12px 14px; margin: 10px 0; background: var(--rwf-layer); }
.rwf-run-head h3 { margin: 0; font-size: 16px; font-weight: 600; }
.rwf-meta { display: flex; flex-wrap: wrap; gap: 4px 14px; color: var(--rwf-muted); font-size: 12px; margin-top: 4px; }
.rwf-progress { height: 3px; border-radius: 3px; background: var(--rwf-border); margin: 10px 0 4px; overflow: hidden; }
.rwf-progress > span { display: block; height: 100%; background: var(--rwf-run); transition: width .5s ease; }
.rwf-progress > span.t-done { background: var(--rwf-ok); }
.rwf-live { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--rwf-muted); }
.rwf-live::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--rwf-muted); }
.rwf-live.on::before { background: var(--rwf-ok); box-shadow: 0 0 0 0 var(--rwf-ok); animation: rwf-ping 2s infinite; }
.rwf-count { display: inline-flex; align-items: center; justify-content: center; min-width: 17px; height: 17px; padding: 0 5px; margin-left: 6px; border-radius: 9px; background: var(--rwf-err); color: #fff; font-size: 11px; font-weight: 600; line-height: 1; }

/* callouts */
.rwf-callout { border-radius: 8px; padding: 8px 12px; margin: 8px 0; border: 1px solid transparent; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.rwf-callout ul { margin: 4px 0 0 18px; padding: 0; flex-basis: 100%; }
.rwf-callout.warn { background: color-mix(in srgb, var(--rwf-warn) 9%, transparent); border-color: color-mix(in srgb, var(--rwf-warn) 28%, transparent); }
.rwf-callout.err { background: color-mix(in srgb, var(--rwf-err) 9%, transparent); border-color: color-mix(in srgb, var(--rwf-err) 28%, transparent); color: var(--rwf-err); }
.rwf-callout.ok { background: color-mix(in srgb, var(--rwf-ok) 9%, transparent); border-color: color-mix(in srgb, var(--rwf-ok) 28%, transparent); }
.rwf-callout.info { background: color-mix(in srgb, var(--rwf-brand) 7%, transparent); border-color: color-mix(in srgb, var(--rwf-brand) 22%, transparent); }

/* flow graph */
.rwf-graph { width: 100%; overflow-x: auto; overflow-y: hidden; margin: 4px 0 0; padding-bottom: 6px; }
.rwf-graph svg { display: block; width: 100%; min-width: 1080px; height: auto; margin: 0 auto; font-family: inherit; overflow: visible; }
.rwf-graph .card { fill: var(--rwf-layer); stroke: var(--rwf-border-strong); stroke-width: 1.3; transition: stroke .25s, fill .25s; }
.rwf-graph .n.click { cursor: pointer; outline: none; }
.rwf-graph .n.click:hover .card, .rwf-graph .n.click:focus-visible .card { fill: var(--rwf-hover); }
.rwf-graph .n.sel .card { stroke: var(--rwf-fg); stroke-width: 2.2; }
.rwf-graph .label { fill: var(--rwf-fg); font-size: 14px; font-weight: 600; }
.rwf-graph .sub { fill: var(--rwf-muted); font-size: 12px; }
.rwf-graph .icon-bg { fill: var(--rwf-layer2); }
.rwf-graph .icon { fill: none; stroke: var(--rwf-muted); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.rwf-graph .t-done .icon-bg { fill: color-mix(in srgb, var(--rwf-ok) 16%, transparent); } .rwf-graph .t-done .icon { stroke: var(--rwf-ok); } .rwf-graph .t-done .sub { fill: var(--rwf-ok); }
.rwf-graph .t-run .icon-bg { fill: color-mix(in srgb, var(--rwf-run) 18%, transparent); } .rwf-graph .t-run .icon { stroke: var(--rwf-run); } .rwf-graph .t-run .sub { fill: var(--rwf-run); font-weight: 600; }
.rwf-graph .t-run .card { stroke: var(--rwf-run); stroke-width: 2; fill: color-mix(in srgb, var(--rwf-run) 6%, var(--rwf-layer)); animation: rwf-breathe 1.6s ease-in-out infinite; }
.rwf-graph .t-wait .card { stroke: var(--rwf-warn); stroke-width: 2; fill: color-mix(in srgb, var(--rwf-warn) 8%, var(--rwf-layer)); }
.rwf-graph .t-wait .icon-bg { fill: color-mix(in srgb, var(--rwf-warn) 20%, transparent); } .rwf-graph .t-wait .icon { stroke: var(--rwf-warn); } .rwf-graph .t-wait .sub { fill: var(--rwf-warn); font-weight: 600; }
.rwf-graph .t-warn .icon { stroke: var(--rwf-warn); } .rwf-graph .t-warn .sub { fill: var(--rwf-warn); }
.rwf-graph .t-err .icon { stroke: var(--rwf-err); } .rwf-graph .t-err .sub { fill: var(--rwf-err); } .rwf-graph .t-err .card { stroke: var(--rwf-err); }
.rwf-graph .t-idle .label { fill: var(--rwf-sub); } .rwf-graph .t-idle .card { stroke-dasharray: 0; opacity: .9; }
.rwf-graph .pulse { fill: none; stroke: var(--rwf-run); stroke-width: 2; transform-box: fill-box; transform-origin: center; animation: rwf-pulse 1.6s ease-out infinite; }
.rwf-graph .ver { fill: var(--rwf-layer2); stroke: var(--rwf-border); } .rwf-graph .ver-text { fill: var(--rwf-sub); font-size: 10.5px; font-weight: 600; }
.rwf-graph .attention-dot { fill: var(--rwf-warn); } .rwf-graph .attention-text { fill: #fff; font-size: 11px; font-weight: 700; }
.rwf-graph .attention-ring { fill: none; stroke: var(--rwf-warn); stroke-width: 2; transform-box: fill-box; transform-origin: center; animation: rwf-ring 1.4s ease-out infinite; }
.rwf-graph .sub-dot { fill: var(--rwf-muted); } .rwf-graph .sub-dot.t-done { fill: var(--rwf-ok); } .rwf-graph .sub-dot.t-run { fill: var(--rwf-run); animation: rwf-blink 1.2s infinite; } .rwf-graph .sub-dot.t-err { fill: var(--rwf-err); }
.rwf-graph .edge { stroke: var(--rwf-border-strong); stroke-width: 1.6; fill: none; }
.rwf-graph .edge.done { stroke: color-mix(in srgb, var(--rwf-ok) 65%, transparent); }
.rwf-graph .edge.flowing { stroke: var(--rwf-run); stroke-width: 2; stroke-dasharray: 6 5; animation: rwf-flow .7s linear infinite; }
.rwf-graph .loop .edge { stroke: color-mix(in srgb, var(--rwf-warn) 50%, transparent); stroke-width: 1.8; stroke-dasharray: 5 4; }
.rwf-graph .loop.active .edge { stroke: var(--rwf-warn); animation: rwf-flow-back 1s linear infinite; }
.rwf-graph .loop-pill { fill: var(--rwf-layer); stroke: color-mix(in srgb, var(--rwf-warn) 55%, transparent); }
.rwf-graph .loop-text { fill: var(--rwf-warn); font-size: 12px; font-weight: 600; }
.rwf-graph .back .edge { stroke: var(--rwf-muted); stroke-width: 1.2; stroke-dasharray: 3 4; opacity: .55; }
.rwf-graph .back .back-text { fill: var(--rwf-muted); font-size: 11px; opacity: .8; }
.rwf-graph .back.active .edge { stroke: var(--rwf-warn); opacity: 1; } .rwf-graph .back.active .back-text { fill: var(--rwf-warn); opacity: 1; }
.rwf-graph .rwf-arrowhead { fill: var(--rwf-border-strong); } .rwf-graph .rwf-arrowhead.loop { fill: var(--rwf-warn); } .rwf-graph .rwf-arrowhead.back { fill: var(--rwf-muted); }
@keyframes rwf-breathe { 0%, 100% { stroke-opacity: 1; stroke-width: 2; } 50% { stroke-opacity: .45; stroke-width: 3.2; } }
@keyframes rwf-pulse { 0% { opacity: .6; transform: scale(1); } 100% { opacity: 0; transform: scale(1.12, 1.4); } }
@keyframes rwf-ring { 0% { opacity: .8; transform: scale(1); } 100% { opacity: 0; transform: scale(1.9); } }
@keyframes rwf-flow { to { stroke-dashoffset: -22; } }
@keyframes rwf-flow-back { to { stroke-dashoffset: 18; } }
@keyframes rwf-blink { 50% { opacity: .35; } }
@keyframes rwf-ping { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--rwf-ok) 50%, transparent); } 70% { box-shadow: 0 0 0 5px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
@keyframes rwf-spin { to { transform: rotate(360deg); } }
@keyframes rwf-shimmer { 0% { background-position: -300px 0; } 100% { background-position: 300px 0; } }
@keyframes rwf-toast { 0% { opacity: 0; transform: translateY(8px); } 12%, 85% { opacity: 1; transform: none; } 100% { opacity: 0; } }
@keyframes rwf-leave { to { opacity: 0; transform: translateX(-12px); max-height: 0; padding-top: 0; padding-bottom: 0; } }
@media (prefers-reduced-motion: reduce) { .rwf-graph .pulse, .rwf-graph .attention-ring, .rwf-graph .edge.flowing, .rwf-graph .t-run .card, .rwf-spinner, .rwf-live.on::before { animation: none; } }

/* tabs */
.rwf-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--rwf-border); margin: 14px 0 12px; }
.rwf-tab { background: none; border: none; border-bottom: 2px solid transparent; margin-bottom: -1px; padding: 7px 10px; cursor: pointer; color: var(--rwf-sub); font: inherit; display: inline-flex; align-items: center; }
.rwf-tab:hover { color: var(--rwf-fg); }
.rwf-tab[aria-selected="true"] { color: var(--rwf-fg); border-bottom-color: var(--rwf-brand); font-weight: 600; }
.rwf-segments { margin: 14px 0 10px; max-width: 520px; }

/* node detail */
.rwf-detail-head h4 { margin: 0; font-size: 15px; }
.rwf-status-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--rwf-muted); flex: none; display: inline-block; }
.rwf-status-dot.t-done { background: var(--rwf-ok); } .rwf-status-dot.t-run { background: var(--rwf-run); animation: rwf-blink 1.2s infinite; }
.rwf-status-dot.t-wait, .rwf-status-dot.t-warn { background: var(--rwf-warn); } .rwf-status-dot.t-err { background: var(--rwf-err); }
.rwf-activity { margin-top: 8px; display: flex; align-items: center; gap: 8px; color: var(--rwf-sub); font-size: 12px; background: color-mix(in srgb, var(--rwf-run) 7%, transparent); border-radius: 8px; padding: 6px 10px; }
.rwf-activity.wait { background: color-mix(in srgb, var(--rwf-warn) 9%, transparent); color: var(--rwf-fg); }
.rwf-spinner { width: 12px; height: 12px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--rwf-run) 25%, transparent); border-top-color: var(--rwf-run); animation: rwf-spin .8s linear infinite; display: inline-block; vertical-align: -2px; flex: none; }
.rwf-summary-text { white-space: pre-wrap; margin: 4px 0; }
.rwf-confidence { display: inline-flex; align-items: center; gap: 6px; color: var(--rwf-muted); font-size: 12px; }
.rwf-confidence .bar { width: 64px; height: 5px; border-radius: 3px; background: var(--rwf-border); overflow: hidden; }
.rwf-confidence .bar > span { display: block; height: 100%; background: var(--rwf-ok); } .rwf-confidence .bar > span.low { background: var(--rwf-warn); }
.rwf-section { min-height: 120px; }
.rwf-toolbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 6px 0 10px; }
.rwf-doc { border: 1px solid var(--rwf-border); border-radius: var(--rwf-radius); padding: 14px 18px; background: var(--rwf-layer); max-height: 640px; overflow: auto; }
.rwf-list { display: flex; flex-direction: column; }
.rwf-list-row { display: flex; align-items: center; gap: 10px; padding: 8px 4px; border-bottom: 1px solid var(--rwf-border); }
.rwf-list-row .grow { flex: 1; min-width: 0; }
.rwf-table { border-collapse: collapse; width: 100%; margin: 6px 0; }
.rwf-table th { text-align: left; font-weight: 500; color: var(--rwf-muted); font-size: 12px; border-bottom: 1px solid var(--rwf-border); padding: 5px 8px; }
.rwf-table td { border-bottom: 1px solid var(--rwf-border); padding: 6px 8px; vertical-align: top; }
.rwf-table .mono, .rwf-evidence { font-family: var(--dsw-font-mono, ui-monospace, Menlo, monospace); font-size: 12px; word-break: break-word; }
.rwf-calls td:first-child { white-space: nowrap; }
.rwf-pre { white-space: pre-wrap; word-break: break-word; font-family: var(--dsw-font-mono, ui-monospace, Menlo, monospace); font-size: 12px; background: var(--rwf-code); border-radius: 8px; padding: 10px 12px; max-height: 480px; overflow: auto; margin: 6px 0; }

/* skeleton & empty */
.rwf-skeleton { display: flex; flex-direction: column; gap: 8px; padding: 4px 0; }
.rwf-skeleton .bar { height: 10px; border-radius: 5px; background: linear-gradient(90deg, var(--rwf-layer2) 25%, var(--rwf-hover) 50%, var(--rwf-layer2) 75%); background-size: 600px 100%; animation: rwf-shimmer 1.4s infinite linear; }
.rwf-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 6px; color: var(--rwf-muted); padding: 40px 20px; }
.rwf-empty svg { color: var(--rwf-border-strong); }
.rwf-empty .title { color: var(--rwf-fg); font-weight: 600; font-size: 14px; }
.rwf-empty.small { padding: 18px; font-size: 12px; }
.rwf-steps { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin: 12px 0; }
.rwf-steps span { display: inline-flex; gap: 6px; align-items: center; border: 1px solid var(--rwf-border); border-radius: 14px; padding: 2px 10px 2px 3px; color: var(--rwf-sub); }
.rwf-steps b { width: 18px; height: 18px; border-radius: 50%; background: var(--rwf-layer2); display: inline-flex; align-items: center; justify-content: center; font-size: 11px; }

/* loop trend & events */
.rwf-trend { display: flex; flex-direction: column; gap: 6px; margin: 8px 0; }
.rwf-trend-row { display: grid; grid-template-columns: 56px 160px 86px auto 1fr; gap: 10px; align-items: center; font-size: 12px; }
.rwf-trend .bar { height: 8px; border-radius: 4px; background: var(--rwf-border); overflow: hidden; }
.rwf-trend .bar .fail { display: block; height: 100%; background: var(--rwf-err); } .rwf-trend .bar .pass { display: block; height: 100%; background: var(--rwf-ok); }
.rwf-trend .summary { color: var(--rwf-sub); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rwf-loop-mini { display: flex; gap: 6px; flex-wrap: wrap; font-size: 12px; color: var(--rwf-muted); margin: 6px 0; }
.rwf-loop-mini span { padding: 0 7px; border-radius: 10px; border: 1px solid var(--rwf-border); } .rwf-loop-mini .ok { color: var(--rwf-ok); } .rwf-loop-mini .bad { color: var(--rwf-err); }
.rwf-events { display: flex; flex-direction: column; }
.rwf-event { display: grid; grid-template-columns: 64px 14px minmax(160px, auto) 1fr; gap: 8px; align-items: baseline; padding: 4px 0; font-size: 12px; border-bottom: 1px dashed var(--rwf-border); }
.rwf-event .time { color: var(--rwf-muted); font-variant-numeric: tabular-nums; }
.rwf-event .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--rwf-muted); align-self: center; }
.rwf-event.t-done .dot { background: var(--rwf-ok); } .rwf-event.t-run .dot { background: var(--rwf-run); } .rwf-event.t-wait .dot, .rwf-event.t-warn .dot { background: var(--rwf-warn); } .rwf-event.t-err .dot { background: var(--rwf-err); }
.rwf-event .payload { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 11px; }

/* inbox */
.rwf-panel { height: 100%; display: flex; flex-direction: column; }
.rwf-panel-head { display: flex; align-items: center; gap: 12px; padding: 14px 20px 10px; border-bottom: 1px solid var(--rwf-border); }
.rwf-panel-head h3 { margin: 0; font-size: 16px; }
.rwf-panel-body { flex: 1; min-height: 0; }
.rwf-inbox { display: grid; grid-template-columns: minmax(280px, 34%) 1fr; height: 100%; }
.rwf-inbox.embedded { height: 560px; border: 1px solid var(--rwf-border); border-radius: var(--rwf-radius); overflow: hidden; }
.rwf-inbox-list { border-right: 1px solid var(--rwf-border); overflow: auto; outline: none; display: flex; flex-direction: column; }
.rwf-inbox-list:focus-visible { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--rwf-brand) 35%, transparent); }
.rwf-inbox-detail { overflow: auto; padding: 16px 22px 24px; position: relative; }
.rwf-filters { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; padding: 10px 12px; border-bottom: 1px solid var(--rwf-border); position: sticky; top: 0; background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-module-platform, Canvas)); z-index: 1; }
.rwf-seg { display: inline-flex; border: 1px solid var(--rwf-border); border-radius: 8px; overflow: hidden; }
.rwf-seg button { font: inherit; font-size: 12px; background: none; border: none; color: var(--rwf-sub); padding: 3px 10px; cursor: pointer; display: inline-flex; align-items: center; }
.rwf-seg button + button { border-left: 1px solid var(--rwf-border); }
.rwf-seg button[aria-pressed="true"] { background: var(--rwf-active); color: var(--rwf-fg); font-weight: 600; }
.rwf-start .rwf-seg { margin: 2px 0 6px; }
.rwf-guide { border-color: color-mix(in srgb, var(--rwf-brand) 45%, var(--rwf-border)); }
.rwf-guide .rwf-doc { max-height: 360px; overflow: auto; margin-top: 6px; }
.rwf-seg .rwf-count { height: 15px; min-width: 15px; font-size: 10px; margin-left: 4px; }
.rwf-check { display: inline-flex; gap: 4px; align-items: center; color: var(--rwf-sub); font-size: 12px; cursor: pointer; }
.rwf-group-block { padding-bottom: 4px; }
.rwf-group { display: flex; flex-direction: column; padding: 10px 14px 4px; font-size: 12px; }
.rwf-group .name { font-weight: 600; color: var(--rwf-fg); }
.rwf-group-progress { display: flex; align-items: center; gap: 8px; margin-top: 3px; }
.rwf-group-progress .bar { width: 64px; height: 4px; border-radius: 2px; background: var(--rwf-border); overflow: hidden; flex: none; }
.rwf-group-progress .bar > span { display: block; height: 100%; background: var(--rwf-ok); }
.rwf-item { display: flex; gap: 10px; padding: 8px 14px; cursor: pointer; align-items: flex-start; border-left: 3px solid transparent; }
.rwf-item:hover { background: var(--rwf-hover); }
.rwf-item[aria-selected="true"] { background: var(--rwf-active); border-left-color: var(--rwf-brand); }
.rwf-item.closed { opacity: .62; }
.rwf-item.leaving { animation: rwf-leave .32s ease forwards; overflow: hidden; }
.rwf-item .body { flex: 1; min-width: 0; }
.rwf-item .line1 { display: flex; gap: 6px; align-items: center; font-size: 12px; }
.rwf-item .kind { font-weight: 600; }
.rwf-item .time { margin-left: auto; white-space: nowrap; }
.rwf-item .who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rwf-item .txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--rwf-sub); }
.rwf-kind-icon { flex: none; margin-top: 2px; color: var(--rwf-muted); }
.rwf-kind-icon.k-question { color: var(--rwf-warn); } .rwf-kind-icon.k-review { color: var(--rwf-run); } .rwf-kind-icon.k-loop_stall { color: var(--rwf-err); }
.rwf-blocking { font-size: 10px; font-weight: 600; color: var(--rwf-err); border: 1px solid color-mix(in srgb, var(--rwf-err) 40%, transparent); border-radius: 4px; padding: 0 4px; line-height: 15px; }
.rwf-done-mark { color: var(--rwf-ok); font-weight: 700; }
.rwf-keys { margin-top: auto; padding: 8px 14px; font-size: 11px; color: var(--rwf-muted); border-top: 1px solid var(--rwf-border); }
.rwf-detail-source { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding-bottom: 10px; margin-bottom: 12px; border-bottom: 1px solid var(--rwf-border); }
.rwf-detail-source .kind { font-weight: 600; }
.rwf-detail-foot { display: flex; align-items: center; gap: 6px; margin-top: 20px; padding-top: 10px; border-top: 1px solid var(--rwf-border); font-size: 12px; }
.rwf-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
.rwf-q { border: none; padding: 0; margin: 0 0 16px; }
.rwf-q-header { font-size: 11px; font-weight: 600; letter-spacing: .04em; color: var(--rwf-run); margin-bottom: 2px; }
.rwf-q-title { font-size: 14px; font-weight: 600; padding: 0; margin-bottom: 4px; }
.rwf-options { display: flex; flex-direction: column; gap: 6px; margin: 8px 0; }
.rwf-option { display: flex; gap: 10px; align-items: center; border: 1px solid var(--rwf-border); border-radius: 8px; padding: 8px 12px; cursor: pointer; transition: border-color .15s, background .15s; }
.rwf-option:hover { background: var(--rwf-hover); }
.rwf-option.on { border-color: var(--rwf-brand); background: color-mix(in srgb, var(--rwf-brand) 7%, transparent); }
.rwf-option input { accent-color: var(--rwf-brand); margin: 0; }
.rwf-option kbd { font: 11px var(--dsw-font-mono, ui-monospace, monospace); color: var(--rwf-muted); border: 1px solid var(--rwf-border); border-radius: 4px; padding: 0 4px; }
.rwf-option .opt-label { font-weight: 500; }
.rwf-q:disabled .rwf-option { cursor: default; }
.rwf-answer { color: var(--rwf-sub); margin: 6px 0; }
.rwf-input, .rwf-textarea, .rwf-select { font: inherit; color: var(--rwf-fg); background: var(--rwf-layer); border: 1px solid var(--rwf-border-strong); border-radius: 8px; padding: 6px 10px; outline: none; transition: border-color .15s, box-shadow .15s; }
.rwf-input:focus, .rwf-textarea:focus, .rwf-select:focus { border-color: var(--rwf-brand); box-shadow: 0 0 0 3px color-mix(in srgb, var(--rwf-brand) 16%, transparent); }
.rwf-input.wide { width: 100%; }
.rwf-select { padding: 3px 8px; font-size: 12px; }
.rwf-textarea { width: 100%; min-height: 84px; resize: vertical; }
.rwf-bubble { border: 1px solid var(--rwf-border); background: var(--rwf-layer2); border-radius: 12px 12px 12px 4px; padding: 10px 14px; margin-bottom: 10px; max-width: 92%; }
.rwf-bubble.mine { margin-left: auto; border-radius: 12px 12px 4px 12px; background: color-mix(in srgb, var(--rwf-brand) 8%, transparent); }
.rwf-chip { font: inherit; font-size: 12px; border: 1px solid var(--rwf-border); background: none; color: var(--rwf-sub); border-radius: 14px; padding: 2px 10px; cursor: pointer; }
.rwf-chip:hover { background: var(--rwf-hover); }
.rwf-chip[aria-pressed="true"] { border-color: var(--rwf-brand); color: var(--rwf-brand); background: color-mix(in srgb, var(--rwf-brand) 6%, transparent); }
.rwf-review-title { margin: 0 0 4px; font-size: 15px; }
.rwf-decision { position: sticky; bottom: -24px; background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-module-platform, Canvas)); padding: 8px 0 4px; margin-top: 10px; border-top: 1px solid var(--rwf-border); }
.rwf-prereview { border-style: dashed; }
.rwf-trend-row .ids { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rwf-toast { position: sticky; bottom: 8px; margin: 16px auto 0; width: fit-content; background: var(--dsw-alias-toast-bg, #1f2329); color: var(--dsw-alias-label-primary-foreground, #fff); padding: 7px 14px; border-radius: 18px; font-size: 12px; box-shadow: 0 4px 16px rgba(0,0,0,.18); animation: rwf-toast 2.6s ease forwards; }

/* sidebar icon + tool card */
.rwf-inbox-icon { position: relative; display: inline-flex; align-items: center; justify-content: center; }
.rwf-inbox-icon .rwf-badge { position: absolute; top: -9px; left: 13px; min-width: 12px; height: 12px; padding: 0 3px; border-radius: 6px; background: var(--dsw-alias-state-error-primary, #e5484d); color: #fff; font-size: 9px; font-weight: 700; line-height: 12px; text-align: center; font-variant-numeric: tabular-nums; box-shadow: 0 0 0 1.5px var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-1, #fff)); pointer-events: none; }
.rwf-inbox-icon .rwf-badge.soft { background: var(--rwf-muted); }
.rwf-tool-card { display: flex; align-items: center; gap: 12px; border: 1px solid var(--rwf-border); border-radius: 12px; padding: 10px 14px; margin: 6px 0; background: var(--rwf-layer); }
.rwf-tool-card.err { color: var(--rwf-err); }
.rwf-tail-card { cursor: pointer; margin: 4px 0 0; transition: background .12s; } .rwf-tail-card:hover { background: var(--rwf-active); } .rwf-tail-card:focus-visible { outline: 2px solid var(--rwf-run); outline-offset: 1px; }
.rwf-tool-card .logo { color: var(--rwf-run); flex: none; }
.rwf-tool-card .grow { flex: 1; min-width: 0; }
.rwf-tool-card .title { font-weight: 600; }
.rwf-tool-card .mini-steps { display: flex; gap: 3px; margin-top: 6px; }
.rwf-tool-card .mini-steps span { width: 22px; height: 4px; border-radius: 2px; background: var(--rwf-border-strong); }
.rwf-tool-card .mini-steps span.done { background: var(--rwf-ok); } .rwf-tool-card .mini-steps span.cur { background: var(--rwf-run); animation: rwf-blink 1.2s infinite; }

/* node detail v2 */
.rwf-detail { display: flex; flex-direction: column; gap: 4px; }
.rwf-detail-head { border: 1px solid var(--rwf-border); border-radius: var(--rwf-radius); padding: 14px 16px; background: var(--rwf-layer); }
.rwf-facts { display: flex; flex-wrap: wrap; gap: 6px 28px; margin-top: 10px; }
.rwf-facts > div { display: flex; flex-direction: column; gap: 1px; min-width: 90px; }
.rwf-facts span { font-size: 11px; color: var(--rwf-muted); }
.rwf-facts b { font-weight: 500; font-size: 13px; }
.rwf-facts .mono, .rwf .mono { font-family: var(--dsw-font-mono, ui-monospace, Menlo, monospace); }
.rwf-sec { margin-top: 18px; }
.rwf-sec-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.rwf-sec-head h5 { margin: 0; font-size: 13px; font-weight: 600; color: var(--rwf-sub); letter-spacing: .02em; }
.rwf-sec-head .rwf-confidence { margin-left: auto; }
.rwf-inline-item { padding: 14px 16px; }
.rwf-fail-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.rwf-fail-list li { display: flex; gap: 10px; align-items: baseline; }
.rwf-timeline { list-style: none; margin: 0; padding: 0 0 0 4px; border-left: 1px solid var(--rwf-border); margin-left: 10px; }
.rwf-tl-item { display: flex; gap: 10px; padding: 6px 0 6px 0; position: relative; }
.rwf-tl-icon { width: 22px; height: 22px; border-radius: 50%; background: var(--rwf-layer); border: 1px solid var(--rwf-border); display: inline-flex; align-items: center; justify-content: center; color: var(--rwf-sub); flex: none; margin-left: -16px; }
.rwf-tl-item[data-tool="write"] .rwf-tl-icon, .rwf-tl-item[data-tool="edit"] .rwf-tl-icon,
.rwf-tl-item[data-tool="wf_write"] .rwf-tl-icon, .rwf-tl-item[data-tool="wf_edit"] .rwf-tl-icon { color: var(--rwf-run); }
.rwf-tl-item[data-tool="bash"] .rwf-tl-icon, .rwf-tl-item[data-tool="wf_exec"] .rwf-tl-icon { color: var(--rwf-fg); }
.rwf-tl-item[data-tool="wf_ask"] .rwf-tl-icon, .rwf-tl-item[data-tool="wf_message"] .rwf-tl-icon { color: var(--rwf-warn); }
.rwf-tl-item[data-tool="wf_report"] .rwf-tl-icon { color: var(--rwf-ok); }
.rwf-tl-item.failed .rwf-tl-icon { color: var(--rwf-err); border-color: color-mix(in srgb, var(--rwf-err) 40%, transparent); }
.rwf-tl-item.live .rwf-tl-icon { border-color: color-mix(in srgb, var(--rwf-run) 40%, transparent); }
.rwf-tl-body { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.rwf-tl-head { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
.rwf-tl-head b { font-weight: 600; flex: none; }
.rwf-tl-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--rwf-sub); }
.rwf-tl-cmd { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.rwf-tl-meta { display: flex; gap: 10px; font-size: 11px; color: var(--rwf-muted); }

/* empty state start form */
.rwf-start { max-width: 640px; margin: 24px auto; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 8px; }
.rwf-start .logo { color: var(--rwf-run); }
.rwf-start h3 { margin: 4px 0 0; font-size: 18px; }
.rwf-start > p { margin: 0 0 6px; }
.rwf-start-steps { list-style: none; margin: 8px 0 12px; padding: 0; width: 100%; display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; text-align: left; }
.rwf-start-steps li { border: 1px solid var(--rwf-border); border-radius: 10px; padding: 8px 10px; display: grid; grid-template-columns: 22px 1fr; column-gap: 8px; row-gap: 2px; align-items: center; background: var(--rwf-layer); }
.rwf-start-steps b { grid-row: span 2; width: 22px; height: 22px; border-radius: 50%; background: var(--rwf-active); color: var(--rwf-fg); display: inline-flex; align-items: center; justify-content: center; font-size: 11px; }
.rwf-start-steps .name { font-weight: 600; } .rwf-start-steps .rwf-muted { font-size: 11.5px; }
.rwf-start .rwf-textarea { min-height: 96px; text-align: left; }
.rwf-start .rwf-actions { width: 100%; justify-content: flex-start; text-align: left; }
@media (max-width: 720px) { .rwf-start-steps { grid-template-columns: repeat(2, 1fr); } }
.rwf-local-runs { max-width: 640px; margin: 0 auto 24px; display: flex; flex-direction: column; gap: 6px; }
.rwf-local-runs-head { font-weight: 600; display: flex; align-items: baseline; gap: 8px; margin-bottom: 2px; }
.rwf-local-run { display: flex; align-items: center; gap: 10px; border: 1px solid var(--rwf-border); border-radius: 10px; padding: 8px 12px; background: var(--rwf-layer); }
.rwf-local-run .grow { flex: 1; min-width: 0; }
.rwf-local-run .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rwf-view .rwf-decision { bottom: 150px; }

/* right sidebar: toolbar buttons (DSH's own button class does size and hover) and tab bodies */
.rwf-aside-toolbar { display: contents; }
.rwf-aside-btn .rwf-inbox-icon { width: 15px; height: 15px; }
.rwf-aside-btn .rwf-inbox-icon .rwf-badge { top: -7px; left: 9px; }
.rwf-aside-tab { height: 100%; min-height: 0; container-type: inline-size; }
.rwf-aside-tab .rwf-view { padding: 12px 14px 48px; }
.rwf-aside-tab .rwf-panel-head { padding: 10px 14px 8px; flex-wrap: wrap; }
@container (max-width: 640px) {
  .rwf-start { margin: 8px auto; }
  .rwf-start-steps { grid-template-columns: repeat(2, 1fr); }
  .rwf-view .rwf-decision { bottom: 16px; }
}
@container (max-width: 380px) { .rwf-start-steps { grid-template-columns: 1fr; } }
`
