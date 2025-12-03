
export function getWebviewContent() {
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
    .display-row{display:flex;gap:16px;padding:16px;flex-wrap:wrap;align-items:flex-start;background:#050505}
    .display-row__canvas{flex:0 0 auto;display:flex;justify-content:center;align-items:center}
    .display-row__canvas canvas{display:block;background:#111;border:1px solid #222;max-width:100%;height:auto}
    @media (min-width:900px){
      .display-row__canvas canvas{max-width:512px}
    }
    @media (max-width:768px){
      .display-row{flex-direction:column}
      .display-row__canvas{width:100%}
    }
    .memory-dump{background:#080808;border-top:1px solid #333;padding:8px 12px 16px;font-size:11px;color:#eee}
    .memory-dump__header{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px}
    .memory-dump__title{font-weight:bold;letter-spacing:0.05em;text-transform:uppercase;font-size:11px}
    .memory-dump__header label{display:flex;align-items:center;gap:4px;font-size:11px}
    .memory-dump__header input[type="text"]{background:#111;border:1px solid #444;color:#fff;padding:2px 4px;font-family:Consolas,monospace;font-size:11px;width:72px;text-transform:uppercase}
    .memory-dump__header input[type="checkbox"]{accent-color:#b4ffb0}
    .memory-dump__controls{display:flex;gap:4px;flex-wrap:wrap}
    .memory-dump__controls button{background:#1e1e1e;border:1px solid #555;color:#fff;padding:2px 6px;border-radius:3px;font-size:10px;cursor:pointer}
    .memory-dump__controls button:hover:not(:disabled){background:#333}
    .memory-dump__content{background:#000;border:1px solid #333;font-family:Consolas,monospace;font-size:12px;padding:8px;overflow:auto;max-height:240px;line-height:1.4;white-space:pre-wrap}
    .memory-dump__content .pc-row{background:rgba(180,255,176,0.12)}
    .memory-dump__content .pc-byte{color:#000;background:#b4ffb0;padding:0 1px;border-radius:2px}
    .memory-dump__content .anchor-row{background:rgba(255,209,121,0.12)}
    .memory-dump__content .anchor-byte{color:#000;background:#ffd77a;padding:0 1px;border-radius:2px}
    .memory-dump__content .addr{color:#9ad0ff;margin-right:6px;display:inline-block;width:54px}
    .memory-dump__content .anchor-addr{color:#ffd77a}
    .memory-dump__pc-hint{font-size:11px;color:#b4ffb0;font-family:Consolas,monospace;letter-spacing:0.03em}
    .hw-stats{background:#050505;padding:12px;border-top:1px solid #222;border-bottom:1px solid #222;display:grid;gap:12px;flex:1 1 360px;min-width:300px;max-width:420px}
    .hw-stats__group{background:#0b0b0b;border:1px solid #1f1f1f;padding:10px;border-radius:4px}
    .hw-stats__group-title{font-weight:bold;text-transform:uppercase;font-size:10px;letter-spacing:0.08em;color:#9ad0ff;margin-bottom:6px}
    .hw-regs__grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:6px;font-size:12px}
    .hw-regs__item{background:#000;padding:6px;border:1px solid #222;border-radius:3px;display:flex;justify-content:space-between;align-items:center}
    .hw-regs__item span{color:#888;font-size:10px;text-transform:uppercase}
    .hw-regs__item strong{font-family:Consolas,monospace;color:#fff}
    .hw-regs__flags{margin-top:8px;display:flex;gap:4px;flex-wrap:wrap}
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
  </div>
  <div class="display-row">
    <div class="display-row__canvas">
      <canvas id="screen" width="256" height="256"></canvas>
    </div>
    <div class="hw-stats">
    <div class="hw-stats__group">
      <div class="hw-stats__group-title">Registers</div>
      <div id="hw-regs" class="hw-regs__grid">Waiting for data...</div>
    </div>
    <div class="hw-stats__group">
      <div class="hw-stats__group-title">Stack</div>
      <table class="hw-stack-table">
        <thead>
          <tr><th>Offset</th><th>Addr</th><th>Value</th></tr>
        </thead>
        <tbody id="hw-stack-body"><tr><td colspan="3">Waiting for data...</td></tr></tbody>
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
        <button type="button" data-mem-delta="-256">-0x100</button>
        <button type="button" data-mem-delta="-16">-0x10</button>
        <button type="button" data-mem-delta="16">+0x10</button>
        <button type="button" data-mem-delta="256">+0x100</button>
        <button type="button" data-mem-action="refresh">Refresh</button>
      </div>
    </div>
    <div class="memory-dump__content" id="memory-dump">Waiting for data...</div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const canvas = document.getElementById('screen');
    const ctx = canvas.getContext('2d');
    const toolbar = document.querySelector('.toolbar');
    const pauseRunButton = toolbar ? toolbar.querySelector('button[data-action="pause"]') : null;
    const stepButtonActions = ['stepOver','stepInto','stepOut','stepFrame','step256'];
    const memoryDumpContent = document.getElementById('memory-dump');
    const memoryFollowCheckbox = document.getElementById('memory-follow');
    const memoryStartInput = document.getElementById('memory-start');
    const memoryDeltaButtons = document.querySelectorAll('[data-mem-delta]');
    const memoryRefreshButton = document.querySelector('[data-mem-action="refresh"]');
    const memoryPcHint = document.getElementById('memory-pc-hint');
    const hwRegsEl = document.getElementById('hw-regs');
    const hwStackBody = document.getElementById('hw-stack-body');
    const hwMetricsEl = document.getElementById('hw-metrics');
    const hwRamdiskSummary = document.getElementById('hw-ramdisk-summary');
    const hwRamdiskModes = document.getElementById('hw-ramdisk-modes');
    const hwRamdiskTableBody = document.getElementById('hw-ramdisk-table-body');
    const bytesPerRow = 16;
    let memoryDumpState = { startAddr: 0, anchorAddr: 0, bytes: [], pc: 0, followPc: true };

    const setStepButtonsEnabled = (shouldEnable) => {
      if (!toolbar) return;
      stepButtonActions.forEach(action => {
        const btn = toolbar.querySelector('button[data-action="' + action + '"]');
        if (btn instanceof HTMLButtonElement) {
          btn.disabled = !shouldEnable;
        }
      });
    };

    const setRunButtonState = (isRunning) => {
      setStepButtonsEnabled(!isRunning);
      if (!(pauseRunButton instanceof HTMLButtonElement)) return;
      if (isRunning) {
        pauseRunButton.textContent = 'Pause';
        pauseRunButton.setAttribute('data-action', 'pause');
      } else {
        pauseRunButton.textContent = 'Run';
        pauseRunButton.setAttribute('data-action', 'run');
      }
    };

    const clamp16 = (value) => (Number(value) >>> 0) & 0xffff;
    const formatAddress = (value) => clamp16(value).toString(16).toUpperCase().padStart(4, '0');
    const formatAddressWithPrefix = (value) => '0x' + formatAddress(value);
    const formatByte = (value) => ((Number(value) >>> 0) & 0xff).toString(16).toUpperCase().padStart(2, '0');
    const formatSigned = (value) => {
      if (value === 0) return '0';
      return value > 0 ? '+' + value : value.toString();
    };
    const formatNumber = (value) => {
      const num = Number(value);
      if (!Number.isFinite(num)) return '—';
      return num.toLocaleString('en-US');
    };
    const formatDuration = (ms = 0) => {
      if (!Number.isFinite(ms) || ms <= 0) return '0s';
      const totalSeconds = Math.floor(ms / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      const millis = Math.floor(ms % 1000);
      const hh = String(hours).padStart(2, '0');
      const mm = String(minutes).padStart(2, '0');
      const ss = String(seconds).padStart(2, '0');
      const mmm = String(millis).padStart(3, '0');
      return hh + ':' + mm + ':' + ss + '.' + mmm;
    };
    const escapeHtml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const wrapByte = (text, addr) => {
      const normalized = clamp16(addr);
      const classes = [];
      if (normalized === clamp16(memoryDumpState.pc)) classes.push('pc-byte');
      const anchorTarget = memoryDumpState.anchorAddr ?? memoryDumpState.startAddr;
      if (normalized === clamp16(anchorTarget)) classes.push('anchor-byte');
      if (!classes.length) return text;
      return '<span class="' + classes.join(' ') + '">' + text + '</span>';
    };
    const postMemoryCommand = (command, extra = {}) => {
      vscode.postMessage({ type: 'memoryDumpControl', command, ...extra });
    };
    const syncMemoryControls = () => {
      if (memoryFollowCheckbox instanceof HTMLInputElement) {
        memoryFollowCheckbox.checked = memoryDumpState.followPc;
      }
      if (memoryStartInput instanceof HTMLInputElement) {
        const isEditing = document.activeElement === memoryStartInput && !memoryDumpState.followPc;
        if (!isEditing || memoryStartInput.value === '') {
          const baseValue = memoryDumpState.anchorAddr ?? memoryDumpState.startAddr;
          memoryStartInput.value = formatAddressWithPrefix(baseValue);
        }
        memoryStartInput.disabled = memoryDumpState.followPc;
        if (memoryDumpState.followPc && document.activeElement === memoryStartInput) {
          memoryStartInput.blur();
        }
      }
      if (memoryPcHint instanceof HTMLElement) {
        memoryPcHint.textContent = memoryDumpState.followPc ? '' : 'PC: ' + formatAddressWithPrefix(memoryDumpState.pc);
      }
    };
    const renderMemoryDump = () => {
      if (!(memoryDumpContent instanceof HTMLElement)) return;
      if (!Array.isArray(memoryDumpState.bytes) || memoryDumpState.bytes.length === 0) {
        memoryDumpContent.textContent = memoryDumpState.followPc ? 'Waiting for data...' : 'No data';
        return;
      }
      const rows = [];
      const normalizedStart = clamp16(memoryDumpState.startAddr);
      const anchorTarget = clamp16(memoryDumpState.anchorAddr ?? memoryDumpState.startAddr);
      const normalizedPc = clamp16(memoryDumpState.pc);
      for (let offset = 0; offset < memoryDumpState.bytes.length; offset += bytesPerRow) {
        const rowStart = clamp16(memoryDumpState.startAddr + offset);
        const rowBytes = memoryDumpState.bytes.slice(offset, offset + bytesPerRow);
        const lineHasPc = normalizedPc >= rowStart && normalizedPc < rowStart + rowBytes.length;
        const lineHasAnchor = anchorTarget >= rowStart && anchorTarget < rowStart + rowBytes.length;
        const hexParts = rowBytes.map((value, idx) => {
          const addr = clamp16(rowStart + idx);
          return wrapByte(formatByte(value ?? 0), addr);
        });
        const asciiParts = rowBytes.map((value, idx) => {
          const addr = clamp16(rowStart + idx);
          const char = value >= 0x20 && value <= 0x7e ? String.fromCharCode(value) : '.';
          return wrapByte(escapeHtml(char), addr);
        });
        const rowClasses = ['dump-row'];
        if (lineHasPc) rowClasses.push('pc-row');
        if (lineHasAnchor) rowClasses.push('anchor-row');
        const addrClasses = ['addr'];
        if (lineHasAnchor) addrClasses.push('anchor-addr');
        rows.push('<div class="' + rowClasses.join(' ') + '"><span class="' + addrClasses.join(' ') + '">' + formatAddress(rowStart) + ':</span> ' + hexParts.join(' ') + '  ' + asciiParts.join('') + '</div>');
      }
      memoryDumpContent.innerHTML = rows.join('');
    };
    const renderRegs = (stats) => {
      if (!(hwRegsEl instanceof HTMLElement)) return;
      if (!stats || !stats.regs) {
        hwRegsEl.textContent = 'Waiting for data...';
        return;
      }
      const regs = stats.regs;
      const items = [
        ['PC', formatAddressWithPrefix(regs.pc)],
        ['SP', formatAddressWithPrefix(regs.sp)],
        ['AF', formatAddressWithPrefix(regs.af)],
        ['BC', formatAddressWithPrefix(regs.bc)],
        ['DE', formatAddressWithPrefix(regs.de)],
        ['HL', formatAddressWithPrefix(regs.hl)],
        ['M', regs.m === null || regs.m === undefined ? '—' : '0x' + formatByte(regs.m)]
      ];
      hwRegsEl.innerHTML = items.map(([label, value]) => '<div class="hw-regs__item"><span>' + label + '</span><strong>' + value + '</strong></div>').join('');
      const flags = stats.flags || {};
      const flagOrder = [
        { key: 's', label: 'S' },
        { key: 'z', label: 'Z' },
        { key: 'ac', label: 'AC' },
        { key: 'p', label: 'P' },
        { key: 'cy', label: 'CY' }
      ];
      const flagHtml = flagOrder.map(flag => '<span class="hw-flag ' + (flags[flag.key] ? 'hw-flag--on' : '') + '">' + flag.label + '</span>').join('');
      hwRegsEl.insertAdjacentHTML('beforeend', '<div class="hw-regs__flags" title="Flags">' + flagHtml + '</div>');
    };
    const renderStack = (stats) => {
      if (!(hwStackBody instanceof HTMLElement)) return;
      const stack = stats?.stack;
      const entries = Array.isArray(stack?.entries) ? stack.entries : [];
      if (!entries.length) {
        hwStackBody.innerHTML = '<tr><td colspan="3">No stack data</td></tr>';
        return;
      }
      hwStackBody.innerHTML = entries.map(entry => {
        const offset = formatSigned(entry.offset ?? 0);
        const addr = formatAddressWithPrefix(entry.addr ?? 0);
        const value = formatAddressWithPrefix(entry.value ?? 0);
        const rowClass = entry.offset === 0 ? ' class="is-sp"' : '';
        return '<tr' + rowClass + '><td>' + offset + '</td><td>' + addr + '</td><td>' + value + '</td></tr>';
      }).join('');
    };
    const renderHardwareMetrics = (stats) => {
      if (!(hwMetricsEl instanceof HTMLElement)) return;
      const hw = stats?.hardware;
      if (!hw) {
        hwMetricsEl.textContent = 'Waiting for data...';
        return;
      }
      const metrics = [
        ['Up Time', formatDuration(stats?.uptimeMs ?? 0)],
        ['Δ Update', (stats?.deltaMs ?? 0) > 0 ? Math.round(stats.deltaMs) + ' ms' : '—'],
        ['CPU Cycles', formatNumber(hw.cycles)],
        ['Frames', formatNumber(hw.frames)],
        ['Frame CC', formatNumber(hw.frameCc)],
        ['Raster', hw.rasterLine + ':' + hw.rasterPixel],
        ['Scroll', '0x' + formatByte(hw.scrollIdx ?? 0)],
        ['Display', hw.displayMode + ' px'],
        ['Rus/Lat', hw.rusLat ? 'LAT' : 'RUS'],
        ['INT', hw.inte ? 'Enabled' : 'Disabled'],
        ['IFF', hw.iff ? 'Pending' : 'Idle'],
        ['HLT', hw.hlta ? 'HLT' : 'RUN']
      ];
      hwMetricsEl.innerHTML = metrics.map(([label, value]) => '<dt>' + label + '</dt><dd>' + value + '</dd>').join('');
    };
    const renderRamDisk = (stats) => {
      if (!(hwRamdiskSummary instanceof HTMLElement)) return;
      const ramDisk = stats?.peripherals?.ramDisk;
      if (!ramDisk) {
        hwRamdiskSummary.innerHTML = '<div><span>Active</span><strong>—</strong></div>';
        if (hwRamdiskModes instanceof HTMLElement) {
          hwRamdiskModes.innerHTML = '';
        }
        if (hwRamdiskTableBody instanceof HTMLElement) {
          hwRamdiskTableBody.innerHTML = '<tr><td colspan="5">No RAM Disk info</td></tr>';
        }
        return;
      }
      const active = ramDisk.activeMapping;
      const summaryItems = [
        { label: 'Active', value: ramDisk.activeIndex !== undefined ? '#' + ramDisk.activeIndex : '—' },
        { label: 'Status', value: active ? (active.enabled ? 'Enabled' : 'Disabled') : '—' },
        { label: 'RAM Page', value: active && active.pageRam !== undefined ? active.pageRam.toString() : '—' },
        { label: 'Stack Page', value: active && active.pageStack !== undefined ? active.pageStack.toString() : '—' },
        { label: 'Mapping Byte', value: active ? '0x' + formatByte(active.byte) : '—' }
      ];
      hwRamdiskSummary.innerHTML = summaryItems.map(item => '<div><span>' + item.label + '</span><strong>' + item.value + '</strong></div>').join('');
      if (hwRamdiskModes instanceof HTMLElement) {
        if (active) {
          const chips = [
            { label: 'Stack', enabled: active.modeStack },
            { label: '0x8000', enabled: active.modeRam8 },
            { label: '0xA000', enabled: active.modeRamA },
            { label: '0xE000', enabled: active.modeRamE }
          ];
          hwRamdiskModes.innerHTML = chips.map(chip => '<span class="hw-chip ' + (chip.enabled ? 'hw-chip--on' : '') + '">' + chip.label + '</span>').join('');
        } else {
          hwRamdiskModes.innerHTML = '<span class="hw-chip">No mapping</span>';
        }
      }
      if (hwRamdiskTableBody instanceof HTMLElement) {
        const mappings = Array.isArray(ramDisk.mappings) ? ramDisk.mappings : [];
        if (!mappings.length) {
          hwRamdiskTableBody.innerHTML = '<tr><td colspan="5">No mappings</td></tr>';
        } else {
          hwRamdiskTableBody.innerHTML = mappings.map(mapping => {
            const rowClass = mapping.idx === ramDisk.activeIndex ? ' class="is-active"' : '';
            const enabled = mapping.enabled ? 'ON' : 'OFF';
            return '<tr' + rowClass + '><td>' + mapping.idx + '</td><td>' + enabled + '</td><td>' + mapping.pageRam + '</td><td>' + mapping.pageStack + '</td><td>0x' + formatByte(mapping.byte) + '</td></tr>';
          }).join('');
        }
      }
    };
    const renderHardwareStats = (stats) => {
      if (!stats) return;
      renderRegs(stats);
      renderStack(stats);
      renderHardwareMetrics(stats);
      renderRamDisk(stats);
    };
    const updateMemoryDumpState = (payload) => {
      if (!payload || typeof payload !== 'object') return;
      memoryDumpState = {
        startAddr: clamp16(payload.startAddr ?? 0),
        anchorAddr: clamp16(payload.anchorAddr ?? (payload.startAddr ?? 0)),
        bytes: Array.isArray(payload.bytes)
          ? payload.bytes.map(value => {
              const normalized = Number(value);
              return Number.isFinite(normalized) ? (normalized & 0xff) : 0;
            })
          : [],
        pc: clamp16(payload.pc ?? 0),
        followPc: !!payload.followPc
      };
      syncMemoryControls();
      renderMemoryDump();
    };
    const submitMemoryStart = () => {
      if (!(memoryStartInput instanceof HTMLInputElement)) return;
      const raw = memoryStartInput.value.trim();
      if (!raw) return;
      postMemoryCommand('setBase', { addr: raw });
    };

    syncMemoryControls();
    renderMemoryDump();
    setStepButtonsEnabled(false);

    if (memoryStartInput instanceof HTMLInputElement) {
      memoryStartInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          submitMemoryStart();
        }
      });
      memoryStartInput.addEventListener('blur', () => {
        if (!memoryDumpState.followPc) {
          submitMemoryStart();
        }
      });
    }

    if (memoryFollowCheckbox instanceof HTMLInputElement) {
      memoryFollowCheckbox.addEventListener('change', () => {
        postMemoryCommand('follow', { value: memoryFollowCheckbox.checked });
        if (!memoryFollowCheckbox.checked && memoryPcHint instanceof HTMLElement) {
          memoryPcHint.textContent = 'PC: ' + formatAddressWithPrefix(memoryDumpState.pc);
        }
      });
    }

    Array.from(memoryDeltaButtons).forEach(btn => {
      if (!(btn instanceof HTMLButtonElement)) return;
      btn.addEventListener('click', () => {
        const delta = Number(btn.getAttribute('data-mem-delta'));
        if (Number.isFinite(delta) && delta !== 0) {
          postMemoryCommand('delta', { offset: delta });
        }
      });
    });

    if (memoryRefreshButton instanceof HTMLButtonElement) {
      memoryRefreshButton.addEventListener('click', () => postMemoryCommand('refresh'));
    }

    const shouldForwardKey = (event) => {
      const target = event.target;
      if (!target) return true;
      if (target instanceof HTMLInputElement) return false;
      if (target instanceof HTMLTextAreaElement) return false;
      if (target instanceof HTMLElement && target.isContentEditable) return false;
      return true;
    };

    if (toolbar) {
      toolbar.addEventListener('click', event => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const btn = target.closest('button');
        if (!(btn instanceof HTMLButtonElement)) return;
        const action = btn.getAttribute('data-action');
        if (!action || btn.disabled) return;
        vscode.postMessage({ type: 'debugAction', action });
      });
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'frame') {
          const w = msg.width, h = msg.height;
          // msg.data is an ArrayBuffer containing native RGBA bytes (R,G,B,A per pixel)
          try {
            const buf = new Uint8ClampedArray(msg.data);
            const img = new ImageData(buf, w, h);
            // scale canvas to fit container
            canvas.width = w; canvas.height = h;
            ctx.putImageData(img, 0, 0);
          } catch (e) {
            // If that fails, try interpreting data as a 32-bit view and fall back
            try {
              const src32 = new Uint32Array(msg.data);
              const buf = new Uint8ClampedArray(src32.buffer);
              const img = new ImageData(buf, w, h);
              canvas.width = w; canvas.height = h;
              ctx.putImageData(img, 0, 0);
            } catch (ee) { /* ignore */ }
          }
        } else if (msg.type === 'instr') {
        try {
          const a = msg.addr.toString(16).padStart(4,'0');
          const o = (msg.opcode & 0xff).toString(16).padStart(2,'0');
          const regs = msg.regs || {};
          const flagsStr = 'S=' + ((regs.flags && regs.flags.S) ? '1' : '0') + ' Z=' + ((regs.flags && regs.flags.Z) ? '1' : '0') + ' AC=' + ((regs.flags && regs.flags.AC) ? '1' : '0') + ' P=' + ((regs.flags && regs.flags.P) ? '1' : '0') + ' CY=' + ((regs.flags && regs.flags.CY) ? '1' : '0');
          const mHex = (msg.m !== undefined) ? msg.m.toString(16).padStart(2,'0') : '??';
          const pcHex = (msg.pc !== undefined) ? (msg.pc & 0xffff).toString(16).padStart(4,'0') : ((msg.regs && msg.regs.PC) ? (msg.regs.PC & 0xffff).toString(16).padStart(4,'0') : '????');
          console.log('CPU ' + a + ': ' + o + ' PC=' + pcHex + ' M=' + mHex + ' ' + flagsStr, msg.regs);
        } catch (e) { /* ignore malformed messages */ }
      } else if (msg.type === 'pause') {
        try {
          const a = msg.addr.toString(16).padStart(4,'0');
          const o = (msg.opcode & 0xff).toString(16).padStart(2,'0');
          const regs = msg.regs || {};
          const flagsStr = 'S=' + ((regs.flags && regs.flags.S) ? '1' : '0') + ' Z=' + ((regs.flags && regs.flags.Z) ? '1' : '0') + ' AC=' + ((regs.flags && regs.flags.AC) ? '1' : '0') + ' P=' + ((regs.flags && regs.flags.P) ? '1' : '0') + ' CY=' + ((regs.flags && regs.flags.CY) ? '1' : '0');
          const mHex = (msg.m !== undefined) ? msg.m.toString(16).padStart(2,'0') : '??';
          const pcHex = (msg.pc !== undefined) ? (msg.pc & 0xffff).toString(16).padStart(4,'0') : ((msg.regs && msg.regs.PC) ? (msg.regs.PC & 0xffff).toString(16).padStart(4,'0') : '????');
          console.log('--- PAUSED --- CPU ' + a + ': ' + o + ' PC=' + pcHex + ' M=' + mHex + ' ' + flagsStr, msg.regs);
        } catch (e) { /* ignore malformed messages */ }
      } else if (msg.type === 'toolbarState') {
        setRunButtonState(!!msg.isRunning);
      } else if (msg.type === 'memoryDump') {
        updateMemoryDumpState(msg);
      } else if (msg.type === 'hardwareStats') {
        renderHardwareStats(msg);
      } else if (msg.type === 'romLoaded') {
        try {
          console.log('ROM loaded: ' + (msg.path || '<unknown>') + ' size=' + (msg.size || 0) + ' addr=0x' + (msg.addr !== undefined ? msg.addr.toString(16).padStart(4,'0') : '0100'));
        } catch (e) { }
      }
    });
    // keyboard forwarding
    window.addEventListener('keydown', e => {
      if (!shouldForwardKey(e)) return;
      vscode.postMessage({ type: 'key', kind: 'down', key: e.key, code: e.code });
      e.preventDefault();
    });
    window.addEventListener('keyup', e => {
      if (!shouldForwardKey(e)) return;
      vscode.postMessage({ type: 'key', kind: 'up', key: e.key, code: e.code });
      e.preventDefault();
    });

    postMemoryCommand('refresh');
  </script>
</body>
</html>`;
}
