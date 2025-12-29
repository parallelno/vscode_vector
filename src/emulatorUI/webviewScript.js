    const vscode = acquireVsCodeApi();
    const canvas = document.getElementById('screen');
    const ctx = canvas.getContext('2d');
    const toolbar = document.querySelector('.toolbar');
    const pauseRunButton = toolbar ? toolbar.querySelector('button[data-action="pause"]') : null;
    const stepButtonActions = ['stepOver','stepInto','stepOut','stepFrame','step256'];
    const speedSelect = document.getElementById('speed-select');
    const viewSelect = document.getElementById('view-select');
    const memoryDumpContent = document.getElementById('memory-dump');
    const memoryFollowCheckbox = document.getElementById('memory-follow');
    const memoryStartInput = document.getElementById('memory-start');
    const memoryDeltaButtons = document.querySelectorAll('[data-mem-delta]');
    const memoryRefreshButton = document.querySelector('[data-mem-action="refresh"]');
    const memoryPcHint = document.getElementById('memory-pc-hint');
    const ramDiskSaveOnRestart = document.getElementById('ram-disk-save-on-restart');
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
        memoryPcHint.textContent = memoryDumpState.followPc ? '' : 'PC: ' + formatAddress(memoryDumpState.pc);
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
      const flags = stats.flags || {};
      const flagOrder = [
        { key: 's', label: 'S' },
        { key: 'z', label: 'Z' },
        { key: 'ac', label: 'AC' },
        { key: 'p', label: 'P' },
        { key: 'cy', label: 'CY' }
      ];
      const flagHtml = flagOrder.map(flag => '<span class="hw-flag ' + (flags[flag.key] ? 'hw-flag--on' : '') + '">' + flag.label + '</span>').join('');
      const bodyItems = [
        ['AF', formatAddress(regs.af)],
        ['BC', formatAddress(regs.bc)],
        ['DE', formatAddress(regs.de)],
        ['HL', formatAddress(regs.hl)],
        ['SP', formatAddress(regs.sp)],
        ['PC', formatAddress(regs.pc)],
        ['M', regs.m === null || regs.m === undefined ? '—' : formatByte(regs.m)]
      ];
      const bodyHtml = bodyItems.map(([label, value]) => '<div class="hw-regs__item"><span>' + label + '</span><strong>' + value + '</strong></div>').join('');
      hwRegsEl.innerHTML = '<div class="hw-regs__flags" title="Flags">' + flagHtml + '</div>' + bodyHtml;
    };
    const renderStack = (stats) => {
      if (!(hwStackBody instanceof HTMLElement)) return;
      const stack = stats?.stack;
      const entries = Array.isArray(stack?.entries) ? stack.entries : [];
      if (!entries.length) {
        hwStackBody.innerHTML = '<tr><td colspan="2">No stack data</td></tr>';
        return;
      }
      const sp = stack?.sp ?? 0;
      hwStackBody.innerHTML = entries.map(entry => {
        const addr = formatAddress(clamp16(sp + (entry.offset ?? 0)));
        const value = formatAddress(entry.value ?? 0);
        const rowClass = entry.offset === 0 ? ' class="is-sp"' : '';
        return '<tr' + rowClass + '><td>' + addr + '</td><td>' + value + '</td></tr>';
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
        ['Scroll', formatByte(hw.scrollIdx ?? 0)],
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
        { label: 'Mapping Byte', value: active ? formatByte(active.byte) : '—' }
      ];
      hwRamdiskSummary.innerHTML = summaryItems.map(item => '<div><span>' + item.label + '</span><strong>' + item.value + '</strong></div>').join('');
      if (hwRamdiskModes instanceof HTMLElement) {
        if (active) {
          const chips = [
            { label: 'Stack', enabled: active.modeStack },
            { label: '8000', enabled: active.modeRam8 },
            { label: 'A000', enabled: active.modeRamA },
            { label: 'E000', enabled: active.modeRamE }
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
            return '<tr' + rowClass + '><td>' + mapping.idx + '</td><td>' + enabled + '</td><td>' + mapping.pageRam + '</td><td>' + mapping.pageStack + '</td><td>' + formatByte(mapping.byte) + '</td></tr>';
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
          memoryPcHint.textContent = 'PC: ' + formatAddress(memoryDumpState.pc);
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

    if (speedSelect instanceof HTMLSelectElement) {
      speedSelect.addEventListener('change', () => {
        vscode.postMessage({ type: 'speedChange', speed: speedSelect.value });
      });
    }

    if (viewSelect instanceof HTMLSelectElement) {
      viewSelect.addEventListener('change', () => {
        vscode.postMessage({ type: 'viewModeChange', viewMode: viewSelect.value });
      });
    }

    if (ramDiskSaveOnRestart instanceof HTMLInputElement) {
      ramDiskSaveOnRestart.addEventListener('change', () => {
        vscode.postMessage({ type: 'ramDiskSaveOnRestartChange', value: ramDiskSaveOnRestart.checked });
      });
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
      switch (msg.type) {
      case 'frame':
        const w = msg.width, h = msg.height;
        const crop = msg.crop;
        // msg.data is an ArrayBuffer containing native RGBA bytes (R,G,B,A per pixel)
        try {
          const buf = new Uint8ClampedArray(msg.data);
          const img = new ImageData(buf, w, h);

          // Create an offscreen canvas to hold the original image
          const offscreen = document.createElement('canvas');
          offscreen.width = crop.w;
          offscreen.height = crop.h;
          offscreen.getContext('2d').putImageData(img, -crop.x, -crop.y);

          // Draw the offscreen canvas scaled to the visible canvas
          canvas.width = crop.w; canvas.height = crop.w / msg.aspect;
          ctx.drawImage(offscreen, 0, 0, canvas.width, canvas.height);
        } catch (e) { /* ignore frame rendering errors */ }
        break;
      case 'instr':
        try {
          const a = msg.addr.toString(16).padStart(4,'0');
          const o = (msg.opcode & 0xff).toString(16).padStart(2,'0');
          const regs = msg.regs || {};
          const flagsStr = 'S=' + ((regs.flags && regs.flags.S) ? '1' : '0') + ' Z=' + ((regs.flags && regs.flags.Z) ? '1' : '0') + ' AC=' + ((regs.flags && regs.flags.AC) ? '1' : '0') + ' P=' + ((regs.flags && regs.flags.P) ? '1' : '0') + ' CY=' + ((regs.flags && regs.flags.CY) ? '1' : '0');
          const mHex = (msg.m !== undefined) ? msg.m.toString(16).padStart(2,'0') : '??';
          const pcHex = (msg.pc !== undefined) ? (msg.pc & 0xffff).toString(16).padStart(4,'0') : ((msg.regs && msg.regs.PC) ? (msg.regs.PC & 0xffff).toString(16).padStart(4,'0') : '????');
          console.log('CPU ' + a + ': ' + o + ' PC=' + pcHex + ' M=' + mHex + ' ' + flagsStr, msg.regs);
        } catch (e) { /* ignore malformed messages */ }
        break;
      case 'pause':
        try {
          const a = msg.addr.toString(16).padStart(4,'0');
          const o = (msg.opcode & 0xff).toString(16).padStart(2,'0');
          const regs = msg.regs || {};
          const flagsStr = 'S=' + ((regs.flags && regs.flags.S) ? '1' : '0') + ' Z=' + ((regs.flags && regs.flags.Z) ? '1' : '0') + ' AC=' + ((regs.flags && regs.flags.AC) ? '1' : '0') + ' P=' + ((regs.flags && regs.flags.P) ? '1' : '0') + ' CY=' + ((regs.flags && regs.flags.CY) ? '1' : '0');
          const mHex = (msg.m !== undefined) ? msg.m.toString(16).padStart(2,'0') : '??';
          const pcHex = (msg.pc !== undefined) ? (msg.pc & 0xffff).toString(16).padStart(4,'0') : ((msg.regs && msg.regs.PC) ? (msg.regs.PC & 0xffff).toString(16).padStart(4,'0') : '????');
          console.log('--- PAUSED --- CPU ' + a + ': ' + o + ' PC=' + pcHex + ' M=' + mHex + ' ' + flagsStr, msg.regs);
        } catch (e) { /* ignore malformed messages */ }
        break;
      case 'toolbarState':
        setRunButtonState(!!msg.isRunning);
        break;
      case 'memoryDump':
        updateMemoryDumpState(msg);
        break;
      case 'hardwareStats':
        renderHardwareStats(msg);
        break;
      case 'romLoaded':
        try {
          console.log('File loaded: ' + (msg.path || '<unknown>') + ' size=' + (msg.size || 0) + ' addr=0x' + (msg.addr !== undefined ? msg.addr.toString(16).padStart(4,'0') : '0100'));
        } catch (e) { }
        break;
      case 'setSpeed':
        if (speedSelect instanceof HTMLSelectElement && msg.speed !== undefined) {
          speedSelect.value = String(msg.speed);
        }
        break;
      case 'setViewMode':
        if (viewSelect instanceof HTMLSelectElement && msg.viewMode !== undefined) {
          viewSelect.value = String(msg.viewMode);
        }
        break;
      case 'setRamDiskSaveOnRestart':
        if (ramDiskSaveOnRestart instanceof HTMLInputElement && msg.value !== undefined) {
          ramDiskSaveOnRestart.checked = !!msg.value;
        }
        break;
      default:
        // Unknown message type
        break;
      }
    });
    // keyboard forwarding
    // Capture events before VS Code so Alt/menus never steal focus when emulator is active.
    const forwardKeyEvent = (kind) => (event) => {
      if (!shouldForwardKey(event)) return;
      vscode.postMessage({ type: 'key', kind, key: event.key, code: event.code });
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    window.addEventListener('keydown', forwardKeyEvent('down'), true);
    window.addEventListener('keyup', forwardKeyEvent('up'), true);

    postMemoryCommand('refresh');
