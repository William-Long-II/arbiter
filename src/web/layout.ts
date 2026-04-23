import { html, raw, type RawHtml } from "./html.ts";

const CSS = `
*,*::before,*::after{box-sizing:border-box}
:root{
  --fg:#e8ecf1;--muted:#9aa4b2;--bg:#0d1117;--panel:#161b22;--panel-2:#1f2630;
  --line:#2d333b;--accent:#58a6ff;--ok:#3fb950;--warn:#d29922;--err:#f85149;
  --nit:#8b949e;
}
html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{border-bottom:1px solid var(--line);background:var(--panel)}
header .inner{max-width:1100px;margin:0 auto;padding:10px 16px;display:flex;align-items:center;gap:20px}
header h1{font-size:14px;font-weight:600;margin:0;letter-spacing:.3px}
nav a{color:var(--muted);padding:6px 10px;border-radius:6px}
nav a.active,nav a:hover{color:var(--fg);background:var(--panel-2);text-decoration:none}
main{max-width:1100px;margin:20px auto;padding:0 16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin-bottom:16px}
.card h2{font-size:13px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:0 0 10px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
/* Make each grid cell a flex column so the label sits at the top and the
   control pins to the bottom. When one label in a row wraps (e.g. "Include
   (comma-separated, used when mode=include)"), the whole row grows to match,
   and inputs still line up across the row instead of one dropping below the
   others by a line-height. */
.grid > div{display:flex;flex-direction:column}
.grid > div > label:first-child{margin-top:0}
.grid > div > input,.grid > div > select,.grid > div > textarea{margin-top:auto}
.stat{background:var(--panel-2);border:1px solid var(--line);border-radius:6px;padding:10px 12px}
.stat .k{color:var(--muted);font-size:12px}
.stat .v{font-size:18px;font-weight:600;margin-top:4px}
table{width:100%;border-collapse:collapse}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);font-weight:600}
td.mono,th.mono,code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px}
.tag{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600;letter-spacing:.3px}
.tag.approve{background:rgba(63,185,80,.15);color:var(--ok)}
.tag.request_changes{background:rgba(248,81,73,.15);color:var(--err)}
.tag.dry_run{background:rgba(88,166,255,.15);color:var(--accent)}
.tag.skipped,.tag.nit{background:rgba(139,148,158,.18);color:var(--nit)}
.tag.suggestion{background:rgba(88,166,255,.15);color:var(--accent)}
.tag.issue{background:rgba(210,153,34,.18);color:var(--warn)}
.tag.blocker{background:rgba(248,81,73,.18);color:var(--err)}
.lvl-info{color:var(--muted)}.lvl-warn{color:var(--warn)}.lvl-error{color:var(--err)}
form.inline{display:inline}
button,input[type=submit]{
  background:var(--panel-2);color:var(--fg);border:1px solid var(--line);
  border-radius:6px;padding:6px 12px;font:inherit;cursor:pointer;line-height:1.4
}
button:hover,input[type=submit]:hover{border-color:var(--accent);color:var(--accent)}
button.danger:hover{border-color:var(--err);color:var(--err)}
button.metrics-win{padding:3px 10px;font-size:12px;color:var(--muted)}
button.metrics-win-active{border-color:var(--accent);color:var(--accent)}

/* Tight, right-aligned cluster of row actions (edit link + delete button, etc).
   Matches anchor and button dimensions so they line up as a unit. */
.actions{display:flex;gap:8px;align-items:center;justify-content:flex-end}
.actions a{
  background:var(--panel-2);color:var(--fg);border:1px solid var(--line);
  border-radius:6px;padding:6px 12px;font:inherit;text-decoration:none;line-height:1.4
}
.actions a:hover{border-color:var(--accent);color:var(--accent);text-decoration:none}

/* Inline form where an input + a single button sit on one row.
   Prevents the base input[type=text]{width:100%} rule from pushing the
   button to wrap when flex-wrap is on. */
.inline-form{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.inline-form input[type=text]{flex:1 1 240px;max-width:420px;width:auto}
.inline-form button{flex:0 0 auto}
input[type=text],input[type=number],select,textarea{
  width:100%;background:var(--bg);color:var(--fg);border:1px solid var(--line);
  border-radius:6px;padding:6px 10px;font:inherit
}
textarea{min-height:72px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px}
label{display:block;color:var(--muted);font-size:12px;margin:10px 0 4px}
.banner{border-radius:6px;padding:10px 12px;margin-bottom:14px;border:1px solid}
.banner.warn{background:rgba(210,153,34,.1);border-color:rgba(210,153,34,.4);color:var(--warn)}
.banner.ok{background:rgba(63,185,80,.1);border-color:rgba(63,185,80,.4);color:var(--ok)}
.banner.err{background:rgba(248,81,73,.1);border-color:rgba(248,81,73,.4);color:var(--err)}
pre{
  background:var(--bg);border:1px solid var(--line);border-radius:6px;
  padding:10px;margin:0;overflow:auto;
  /* Wrap long lines instead of scrolling sideways. pre-wrap preserves the
     newlines/indentation we care about but lets the renderer break lines at
     whitespace; overflow-wrap:break-word forces a break inside unbreakable
     tokens (long URLs, code identifiers) rather than pushing the container
     wider, which was blowing review-detail line-comment cells past their
     containing card. */
  white-space:pre-wrap;
  overflow-wrap:break-word;
}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.row > *{flex:1 1 auto}
.row > button{flex:0 0 auto}
.muted{color:var(--muted)}
.right{text-align:right}
.flex{display:flex;gap:10px;align-items:center}
.space{margin-top:14px}
`;

export type Banner = { kind: "ok" | "warn" | "err"; message: string };

export function layout(args: {
  title: string;
  active?: "dashboard" | "config" | "events";
  banner?: Banner | null;
  body: RawHtml;
  /** Inline script injected before </body>. Use raw() — content is not escaped. */
  footScript?: RawHtml;
}): RawHtml {
  const active = args.active;
  const cls = (k: typeof active) => (active === k ? "active" : "");
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${args.title} — Auto-Reviewer</title>
  <style>${raw(CSS)}</style>
</head>
<body>
  <header><div class="inner">
    <h1>Auto-Reviewer</h1>
    <nav>
      <a class="${cls("dashboard")}" href="/">Dashboard</a>
      <a class="${cls("config")}" href="/config">Config</a>
      <a class="${cls("events")}" href="/events">Events</a>
    </nav>
  </div></header>
  <main>
    ${args.banner ? html`<div class="banner ${args.banner.kind}">${args.banner.message}</div>` : ""}
    ${args.body}
  </main>
  ${args.footScript ? html`<script>${args.footScript}</script>` : ""}
</body>
</html>`;
}
