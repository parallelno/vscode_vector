import * as path from 'path';
import * as fs from 'fs';

export function getWebviewContent() {
  const scriptPath = path.join(__dirname, 'webviewScript.js');
  const scriptContent = fs.readFileSync(scriptPath, 'utf8');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body{margin:0;background:#000;color:#fff;font-family:Consolas,monospace;display:flex;flex-direction:column;height:100vh}
    .toolbar{display:flex;gap:8px;padding:8px;background:#111;border-bottom:1px solid #333;flex-wrap:wrap}
    .toolbar button{background:#1e1e1e;border:1px solid #555;color:#fff;padding:3px 5px;border-radius:3px;cursor:pointer;font-size:10px;text-transform:uppercase;letter-spacing:0.05em}
    .toolbar button[data-toggle="run-pause"]{min-width:72px;text-align:center}
    .toolbar button:hover:not(:disabled){background:#2c2c2c}
    .toolbar button:disabled{opacity:0.4;cursor:not-allowed}
    .toolbar select{background:#1e1e1e;border:1px solid #555;color:#fff;padding:3px 5px;border-radius:3px;cursor:pointer;font-size:10px;font-family:Consolas,monospace}
    .toolbar select:hover{background:#2c2c2c}
    .toolbar label{display:flex;align-items:center;gap:4px;font-size:10px;text-transform:uppercase;letter-spacing:0.05em}
    .display-row{display:flex;flex-direction:column;gap:16px;padding:16px;align-items:stretch;background:#050505}
    .display-row__canvas{display:flex;justify-content:center;align-items:center}
    .display-row__canvas canvas{display:block;background:#111;border:1px solid #222;max-width:100%;height:auto}
    @media (min-width:900px){
      .display-row__canvas canvas{max-width:512px}
    }
    .hw-stats{display:flex;flex-wrap:wrap;gap:12px;background:#050505;border-top:1px solid #222;border-bottom:1px solid #222;padding:12px}
    .hw-stats__group{flex:1 1 220px;background:#0b0b0b;border:1px solid #1f1f1f;padding:10px;border-radius:4px}
    .hw-stats__group--narrow{flex:0 0 75px;max-width:130px}
    .memory-dump{background:#080808;border-top:1px solid #333;padding:8px 12px 16px;font-size:11px;color:#eee}
    .memory-dump__header{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px}
    .memory-dump__title{font-weight:bold;letter-spacing:0.05em;text-transform:uppercase;font-size:11px}
    .memory-dump__header label{display:flex;align-items:center;gap:4px;font-size:11px}
    .memory-dump__header input[type="text"]{background:#111;border:1px solid #444;color:#fff;padding:2px 4px;font-family:Consolas,monospace;font-size:11px;width:72px;text-transform:uppercase}
    .memory-dump__header input[type="checkbox"]{accent-color:#b4ffb0}
    .memory-dump__controls{display:flex;gap:4px;flex-wrap:wrap}
    .memory-dump__controls button{background:#1e1e1e;border:1px solid #555;color:#fff;padding:2px 6px;border-radius:3px;font-size:10px;cursor:pointer}
    .memory-dump__controls button:hover:not(:disabled){background:#333}
    .memory-dump__content{background:#000;border:1px solid #333;font-family:Consolas,monospace;font-size:12px;padding:8px;line-height:1.4;white-space:pre-wrap}
    .memory-dump__content .pc-row{background:rgba(180,255,176,0.12)}
    .memory-dump__content .pc-byte{color:#000;background:#b4ffb0;padding:0 1px;border-radius:2px}
    .memory-dump__content .anchor-row{background:rgba(255,209,121,0.12)}
    .memory-dump__content .anchor-byte{color:#000;background:#ffd77a;padding:0 1px;border-radius:2px}
    .memory-dump__content .addr{color:#9ad0ff;margin-right:6px;display:inline-block;width:54px}
    .memory-dump__content .anchor-addr{color:#ffd77a}
    .memory-dump__pc-hint{font-size:11px;color:#b4ffb0;font-family:Consolas,monospace;letter-spacing:0.03em}
    .hw-stats__group-title{font-weight:bold;text-transform:uppercase;font-size:10px;letter-spacing:0.08em;color:#9ad0ff;margin-bottom:6px}
    .hw-regs__grid{display:flex;flex-direction:column;gap:6px;font-size:12px}
    .hw-regs__item{background:#000;padding:6px;border:1px solid #222;border-radius:3px;display:flex;justify-content:space-between;align-items:center}
    .hw-regs__item span{color:#888;font-size:10px;text-transform:uppercase}
    .hw-regs__item strong{font-family:Consolas,monospace;color:#fff}
    .hw-regs__flags{margin-bottom:8px;display:flex;gap:4px;flex-wrap:wrap}
    .hw-flag{border:1px solid #333;padding:2px 4px;border-radius:3px;font-size:10px;letter-spacing:0.03em;color:#888}
    .hw-flag--on{border-color:#4caf50;color:#4caf50}
    .hw-stack-table{width:100%;border-collapse:collapse;font-size:12px}
    .hw-stack-table th,.hw-stack-table td{border:1px solid #1e1e1e;padding:4px 6px;text-align:left;font-family:Consolas,monospace}
    .hw-stack-table thead th{background:#111;color:#bbb;font-size:10px;text-transform:uppercase;letter-spacing:0.08em}
    .hw-stack-table tbody tr.is-sp{background:rgba(180,255,176,0.08)}
    .hw-stack-table tbody tr:hover{background:rgba(154,208,255,0.08)}
    .hw-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:6px;font-size:11px}
    .hw-metrics dt{font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.05em}
    .hw-metrics dd{margin:0 0 4px;font-family:Consolas,monospace;color:#fff}
    .hw-peripherals{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
    .hw-peripheral{background:#060606;border:1px solid #1c1c1c;border-radius:3px;padding:8px}
    .hw-peripheral__title{text-transform:uppercase;font-size:10px;color:#ffd77a;margin-bottom:6px;letter-spacing:0.05em}
    .hw-peripheral__placeholder{color:#666;font-size:11px;font-style:italic}
    .hw-chip{border:1px solid #333;padding:2px 6px;border-radius:999px;font-size:10px;text-transform:uppercase;color:#888;display:inline-block;margin:2px 4px 2px 0}
    .hw-chip--on{border-color:#4caf50;color:#4caf50}
    .hw-ramdisk__grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:6px;margin-bottom:6px;font-size:11px}
    .hw-ramdisk__grid span{color:#999;font-size:10px;text-transform:uppercase;letter-spacing:0.05em}
    .hw-ramdisk__grid strong{display:block;font-family:Consolas,monospace;color:#fff}
    .hw-ramdisk__modes{margin-bottom:6px}
    .hw-ramdisk__details{position:relative;margin-top:8px;font-size:11px;color:#bbb}
    .hw-ramdisk__details-note{display:inline-block;padding:4px 6px;border:1px dashed #555;border-radius:3px;background:#111;cursor:help}
    .hw-ramdisk__table-wrapper{display:none;position:absolute;top:110%;left:0;z-index:20;background:#050505;border:1px solid #333;border-radius:4px;padding:8px;box-shadow:0 4px 12px rgba(0,0,0,0.4);min-width:320px;max-height:240px;overflow:auto}
    .hw-ramdisk__details:hover .hw-ramdisk__table-wrapper{display:block}
    .hw-ramdisk__table{width:100%;border-collapse:collapse;font-size:11px}
    .hw-ramdisk__table th,.hw-ramdisk__table td{border:1px solid #1a1a1a;padding:3px 4px;text-align:left;font-family:Consolas,monospace}
    .hw-ramdisk__table th{background:#101010;color:#bbb;font-size:10px;text-transform:uppercase;letter-spacing:0.06em}
    .hw-ramdisk__table tr.is-active{background:rgba(255,215,122,0.08)}
  </style>
</head>
<body>
  <div class="toolbar">
    <button type="button" data-action="pause" data-toggle="run-pause">Pause</button>
    <button type="button" data-action="stepOver">Step Over</button>
    <button type="button" data-action="stepInto">Step Into</button>
    <button type="button" data-action="stepOut">Step Out</button>
    <button type="button" data-action="step256">Step 256</button>
    <button type="button" data-action="stepFrame">Step Frame</button>
    <button type="button" data-action="restart">Restart</button>
    <label>
      Speed:
      <select id="speed-select">
        <option value="0.1">0.1x</option>
        <option value="1" selected>1x</option>
        <option value="2">2x</option>
        <option value="4">4x</option>
        <option value="8">8x</option>
        <option value="max">Max</option>
      </select>
    </label>
    <label>
      Save RAM Disk
      <input type="checkbox" id="ram-disk-save-on-restart" />
    </label>
    <label>
      View:
      <select id="view-select">
        <option value="noBorder" selected>No Border</option>
        <option value="full">Full</option>
      </select>
    </label>
  </div>
  <div class="display-row">
    <div class="display-row__canvas">
      <canvas id="screen" width="256" height="256"></canvas>
    </div>
    <div class="hw-stats">
    <div class="hw-stats__group hw-stats__group--narrow">
      <div class="hw-stats__group-title">Registers</div>
      <div id="hw-regs" class="hw-regs__grid">Waiting for data...</div>
    </div>
    <div class="hw-stats__group hw-stats__group--narrow">
      <div class="hw-stats__group-title">Stack</div>
      <table class="hw-stack-table">
        <thead>
          <tr><th>Addr</th><th>Value</th></tr>
        </thead>
        <tbody id="hw-stack-body"><tr><td colspan="2">Waiting for data...</td></tr></tbody>
      </table>
    </div>
    <div class="hw-stats__group">
      <div class="hw-stats__group-title">Hardware</div>
      <dl id="hw-metrics" class="hw-metrics"></dl>
    </div>
    <div class="hw-stats__group">
      <div class="hw-stats__group-title">Peripherals</div>
      <div class="hw-peripherals">
        <div class="hw-peripheral">
          <div class="hw-peripheral__title">RAM Disk</div>
          <div id="hw-ramdisk">
            <div id="hw-ramdisk-summary" class="hw-ramdisk__grid">
              <div><span>Active</span><strong>—</strong></div>
              <div><span>Status</span><strong>—</strong></div>
              <div><span>RAM Page</span><strong>—</strong></div>
              <div><span>Stack Page</span><strong>—</strong></div>
              <div><span>Mapping Byte</span><strong>—</strong></div>
            </div>
            <div id="hw-ramdisk-modes" class="hw-ramdisk__modes"></div>
              <div class="hw-ramdisk__details">
                <span class="hw-ramdisk__details-note">Hover to view all RAM Disk mappings</span>
                <div class="hw-ramdisk__table-wrapper" role="tooltip" aria-label="RAM Disk mapping details">
                  <table class="hw-ramdisk__table">
                    <thead>
                      <tr><th>Idx</th><th>Enabled</th><th>RAM</th><th>Stack</th><th>Byte</th></tr>
                    </thead>
                    <tbody id="hw-ramdisk-table-body">
                      <tr><td colspan="5">Waiting for data...</td></tr>
                    </tbody>
                  </table>
                </div>
              </div>
          </div>
        </div>
        <div class="hw-peripheral">
          <div class="hw-peripheral__title">FDC</div>
          <div class="hw-peripheral__placeholder">Not implemented</div>
        </div>
      </div>
    </div>
    </div>
  </div>
  <div class="memory-dump">
    <div class="memory-dump__header">
      <span class="memory-dump__title">Memory Dump</span>
      <label><input type="checkbox" id="memory-follow" checked /> Follow PC</label>
      <label>Start <input type="text" id="memory-start" value="0000" maxlength="6" spellcheck="false" /></label>
      <span id="memory-pc-hint" class="memory-dump__pc-hint"></span>
      <div class="memory-dump__controls">
        <button type="button" data-mem-delta="-256">-100</button>
        <button type="button" data-mem-delta="-16">-10</button>
        <button type="button" data-mem-delta="16">+10</button>
        <button type="button" data-mem-delta="256">+100</button>
        <button type="button" data-mem-action="refresh">Refresh</button>
      </div>
    </div>
    <div class="memory-dump__content" id="memory-dump">Waiting for data...</div>
  </div>
  <script>
    ${scriptContent}
  </script>
</body>
</html>`;
}
