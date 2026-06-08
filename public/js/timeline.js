/* ═══════════════════════════════════════════════════
   Timeline Renderer
   ═══════════════════════════════════════════════════ */

const Timeline = {
  container: null,
  slotHeight: 10,  // px per 5-min slot
  colPositions: [], // { placeId, left, width }
  notesColPos: null,
  gridTop: 0,
  headerHeight: 0,
  nowLineTimer: null,

  init(container) {
    this.container = container;
  },

  render() {
    if (!this.container || !AppState.currentSchedule) return;
    this.container.innerHTML = '';

    const places = AppState.getPlacesOrdered();
    const totalSlots = AppState.getTotalSlots();
    const startMin = AppState.getStartMinutes();

    // Column count: time + places + notes
    const colCount = 1 + places.length + 1;
    const colTemplate = `var(--time-col-width) ${places.map(() => 'var(--place-col-width)').join(' ')} var(--notes-col-width)`;

    const grid = document.createElement('div');
    grid.className = 'timeline-grid';
    grid.style.gridTemplateColumns = colTemplate;

    // ── HEADER ──
    const header = document.createElement('div');
    header.className = 'tg-header';
    header.style.display = 'contents';

    const timeH = document.createElement('div');
    timeH.className = 'tg-header-cell time-header';
    timeH.textContent = '時間';
    header.appendChild(timeH);

    places.forEach(place => {
      const ph = document.createElement('div');
      ph.className = 'tg-header-cell place-header';
      ph.innerHTML = `<span class="place-color-dot" style="background:${place.color}"></span><span class="place-name-label">${this.escHtml(place.name)}</span>`;
      ph.title = place.name;
      ph.dataset.placeId = place.id;
      header.appendChild(ph);
    });

    const notesH = document.createElement('div');
    notesH.className = 'tg-header-cell notes-header';
    notesH.textContent = '備考';
    header.appendChild(notesH);

    grid.appendChild(header);

    // ── BODY ROWS (one per 5-min slot) ──
    for (let slot = 0; slot < totalSlots; slot++) {
      const mins = startMin + slot * 5;
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      const isHour = m === 0;
      const isHalf = m === 30;

      let rowClass = 'tg-row-normal';
      if (isHour) rowClass = 'tg-row-hour';
      else if (isHalf) rowClass = 'tg-row-half';

      // Time cell
      const timeCell = document.createElement('div');
      timeCell.className = `tg-time-cell ${rowClass} ${isHour ? 'hour-mark' : ''}`;
      timeCell.style.gridRow = slot + 2; // +2 for header
      timeCell.style.gridColumn = 1;
      if (isHour || isHalf) {
        timeCell.textContent = AppState.formatTime(h, m);
      }
      grid.appendChild(timeCell);

      // Place cells
      places.forEach((place, pi) => {
        const cell = document.createElement('div');
        cell.className = `tg-body-cell tg-slot ${rowClass}`;
        cell.style.gridRow = slot + 2;
        cell.style.gridColumn = pi + 2;
        cell.dataset.placeId = place.id;
        cell.dataset.slot = slot;
        cell.dataset.placeIndex = pi;
        grid.appendChild(cell);
      });

      // Notes cell
      const notesCell = document.createElement('div');
      notesCell.className = `tg-body-cell tg-notes-cell ${rowClass}`;
      notesCell.style.gridRow = slot + 2;
      notesCell.style.gridColumn = colCount;
      notesCell.dataset.slot = slot;
      grid.appendChild(notesCell);
    }

    this.container.appendChild(grid);

    // Calculate positions after render
    requestAnimationFrame(() => {
      this.calculatePositions();
      this.renderEvents();
      this.renderNowLine();
      this.setupNowLineTimer();
    });
  },

  calculatePositions() {
    const grid = this.container.querySelector('.timeline-grid');
    if (!grid) return;

    const headerCells = grid.querySelectorAll('.tg-header-cell.place-header');
    const gridRect = grid.getBoundingClientRect();
    this.gridTop = 0;
    this.colPositions = [];

    // Find first body cell row to get header height
    const firstSlot = grid.querySelector('.tg-slot');
    if (firstSlot) {
      this.headerHeight = firstSlot.getBoundingClientRect().top - gridRect.top;
    }

    headerCells.forEach(cell => {
      const rect = cell.getBoundingClientRect();
      this.colPositions.push({
        placeId: cell.dataset.placeId,
        left: rect.left - gridRect.left,
        width: rect.width
      });
    });

    // Notes col
    const notesHeader = grid.querySelector('.notes-header');
    if (notesHeader) {
      const rect = notesHeader.getBoundingClientRect();
      this.notesColPos = {
        left: rect.left - gridRect.left,
        width: rect.width
      };
    }
  },

  renderEvents() {
    // Remove existing event blocks
    this.container.querySelectorAll('.event-block, .drop-ghost, .now-line').forEach(el => {
      if (!el.classList.contains('now-line')) el.remove();
    });

    const events = AppState.getEvents();
    const places = AppState.getPlacesOrdered();
    const placeIdOrder = places.map(p => p.id);
    const gridEl = this.container.querySelector('.timeline-grid');
    if (!gridEl) return;

    // Notes cell rendering map: slot -> text
    const notesBySlot = {};

    // ── Phase 1: build "segments" ──
    // A segment is one event restricted to a *contiguous run* of columns. An
    // event that spans non-contiguous places (e.g. col 0 and col 2) yields one
    // segment per run, each rendered as a fully-labelled block. This fixes the
    // bug where a multi-place task showed a pin in every column but the title
    // only once.
    const segments = [];

    events.forEach(evt => {
      const startMins = evt.start_hour * 60 + evt.start_minute;
      const topSlot = AppState.minutesToSlot(startMins);
      const isTask = evt.event_type === 'task' || evt.end_hour == null;

      let heightSlots, endMins;
      if (isTask) {
        heightSlots = 2; // task marker = 10 min visual
        endMins = startMins; // zero-duration for overlap math
      } else {
        endMins = evt.end_hour * 60 + evt.end_minute;
        heightSlots = Math.max(1, AppState.minutesToSlot(endMins) - topSlot);
      }

      const evtPlaceIds = evt.place_ids || [];
      if (evtPlaceIds.length === 0) return;

      // Column indices this event occupies, de-duplicated and ordered.
      const colIndices = [...new Set(
        evtPlaceIds.map(pid => placeIdOrder.indexOf(pid)).filter(i => i >= 0)
      )].sort((a, b) => a - b);
      if (colIndices.length === 0) return;

      // Split into contiguous runs.
      const runs = [];
      let run = [colIndices[0]];
      for (let i = 1; i < colIndices.length; i++) {
        if (colIndices[i] === run[run.length - 1] + 1) run.push(colIndices[i]);
        else { runs.push(run); run = [colIndices[i]]; }
      }
      runs.push(run);

      runs.forEach(r => {
        segments.push({
          evt,
          isTask,
          topSlot,
          heightSlots,
          startMins,
          // For tasks give a small effective duration so overlap detection
          // groups a task with anything starting at the same minute.
          effEndMins: isTask ? startMins + 10 : endMins,
          colStart: r[0],
          colEnd: r[r.length - 1],
          // lane assignment filled during overlap resolution (per column)
          lane: 0,
          lanes: 1
        });
      });

      if (evt.notes_column) {
        if (!notesBySlot[topSlot]) notesBySlot[topSlot] = [];
        notesBySlot[topSlot].push(evt.notes_column);
      }
    });

    // ── Phase 2: resolve time-overlaps per column ──
    // Two segments collide when their column ranges intersect AND their time
    // ranges intersect. We assign each colliding segment a "lane" so they can
    // be drawn side-by-side instead of stacked on top of each other. This is
    // what makes a 10:00 task and a 10:00– range no longer overlap visually.
    const overlaps = (a, b) =>
      a.colStart <= b.colEnd && b.colStart <= a.colEnd &&  // columns intersect
      a.startMins < b.effEndMins && b.startMins < a.effEndMins; // times intersect

    // Build collision graph and group into connected clusters.
    const n = segments.length;
    const adj = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (overlaps(segments[i], segments[j])) { adj[i].push(j); adj[j].push(i); }
      }
    }

    const visited = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
      if (visited[i]) continue;
      // BFS to collect the connected cluster.
      const cluster = [];
      const queue = [i];
      visited[i] = true;
      while (queue.length) {
        const cur = queue.shift();
        cluster.push(cur);
        adj[cur].forEach(nb => { if (!visited[nb]) { visited[nb] = true; queue.push(nb); } });
      }
      if (cluster.length <= 1) continue; // no overlap, single lane

      // Greedy lane assignment within the cluster (sorted by start time).
      cluster.sort((x, y) => segments[x].startMins - segments[y].startMins || x - y);
      const laneEnds = []; // laneEnds[k] = latest effEndMins occupying lane k
      cluster.forEach(idx => {
        const seg = segments[idx];
        let placed = -1;
        for (let k = 0; k < laneEnds.length; k++) {
          if (seg.startMins >= laneEnds[k]) { placed = k; break; }
        }
        if (placed === -1) { placed = laneEnds.length; laneEnds.push(0); }
        laneEnds[placed] = seg.effEndMins;
        seg.lane = placed;
      });
      const laneCount = laneEnds.length;
      cluster.forEach(idx => { segments[idx].lanes = laneCount; });
    }

    // ── Phase 3: draw each segment ──
    segments.forEach(seg => {
      const { evt, isTask, topSlot, heightSlots, colStart, colEnd, lane, lanes } = seg;
      const startCol = this.colPositions[colStart];
      const endCol = this.colPositions[colEnd];
      if (!startCol || !endCol) return;

      // Full horizontal span of this contiguous run.
      const runLeft = startCol.left;
      const runRight = endCol.left + endCol.width;
      const runWidth = runRight - runLeft;
      const multiCol = colEnd > colStart;

      // Lane subdivision within the run (side-by-side for overlaps).
      const gap = 2;
      const laneWidth = (runWidth - gap * (lanes + 1)) / lanes;
      const left = runLeft + gap + lane * (laneWidth + gap);
      const width = laneWidth;

      const block = document.createElement('div');
      block.className = `event-block ${isTask ? 'task-event' : ''}`;
      block.dataset.eventId = evt.id;
      block.style.backgroundColor = evt.color || '#4A90D9';
      const textColor = (typeof pickTextColor === 'function')
        ? pickTextColor(evt.color || '#4A90D9')
        : (evt.text_color || '#FFFFFF');
      block.style.color = textColor;
      block.style.top = (this.headerHeight + topSlot * this.slotHeight) + 'px';
      block.style.height = (heightSlots * this.slotHeight) + 'px';
      block.style.left = left + 'px';
      block.style.width = Math.max(8, width) + 'px';

      // Visual hint that a block spans several columns.
      if (multiCol && lanes === 1) block.classList.add('spans-cols');

      // ── Content (rendered once per segment / run) ──
      const title = document.createElement('div');
      title.className = 'event-title';
      title.textContent = evt.title || '(無題)';
      block.appendChild(title);

      if (!isTask && heightSlots > 3) {
        const time = document.createElement('div');
        time.className = 'event-time';
        time.textContent = `${AppState.formatTime(evt.start_hour, evt.start_minute)} – ${AppState.formatTime(evt.end_hour, evt.end_minute)}`;
        block.appendChild(time);
      }

      if (evt.description && !isTask && heightSlots > 5) {
        const desc = document.createElement('div');
        desc.className = 'event-desc';
        desc.textContent = evt.description;
        block.appendChild(desc);
      }

      const fullTime = isTask
        ? `${AppState.formatTime(evt.start_hour, evt.start_minute)}`
        : `${AppState.formatTime(evt.start_hour, evt.start_minute)} – ${AppState.formatTime(evt.end_hour, evt.end_minute)}`;
      block.title = `${evt.title || ''}\n${fullTime}${evt.description ? '\n' + evt.description : ''}`;

      const propsBtn = document.createElement('button');
      propsBtn.className = 'event-props-btn';
      propsBtn.innerHTML = '<span class="material-icons-round">more_vert</span>';
      propsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        EventManager.openEventModal(evt.id);
      });
      block.appendChild(propsBtn);

      if (!isTask) {
        const handleBottom = document.createElement('div');
        handleBottom.className = 'event-resize-handle bottom';
        block.appendChild(handleBottom);
        const handleTop = document.createElement('div');
        handleTop.className = 'event-resize-handle top';
        block.appendChild(handleTop);
      }

      gridEl.appendChild(block);
    });

    // Fill notes cells
    const notesCells = this.container.querySelectorAll('.tg-notes-cell');
    notesCells.forEach(cell => {
      const slot = parseInt(cell.dataset.slot);
      if (notesBySlot[slot]) {
        cell.textContent = notesBySlot[slot].join(' / ');
        cell.classList.add('has-text');
      } else {
        cell.textContent = '';
        cell.classList.remove('has-text');
      }
    });
  },

  renderNowLine() {
    // Remove existing
    this.container.querySelectorAll('.now-line').forEach(el => el.remove());

    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const startMins = AppState.getStartMinutes();
    const endMins = AppState.getEndMinutes();

    if (nowMins < startMins || nowMins > endMins) return;

    const slot = (nowMins - startMins) / 5;
    const top = this.headerHeight + slot * this.slotHeight;

    const line = document.createElement('div');
    line.className = 'now-line';
    line.style.top = top + 'px';

    const grid = this.container.querySelector('.timeline-grid');
    if (grid) grid.appendChild(line);
  },

  setupNowLineTimer() {
    if (this.nowLineTimer) clearInterval(this.nowLineTimer);
    this.nowLineTimer = setInterval(() => this.renderNowLine(), 60000);
  },

  escHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  },

  // Get slot from Y position
  getSlotFromY(y) {
    const gridRect = this.container.querySelector('.timeline-grid')?.getBoundingClientRect();
    if (!gridRect) return 0;
    const relY = y - gridRect.top - this.headerHeight;
    return Math.max(0, Math.min(AppState.getTotalSlots() - 1, Math.floor(relY / this.slotHeight)));
  },

  // Get place index from X position
  getPlaceIndexFromX(x) {
    const gridRect = this.container.querySelector('.timeline-grid')?.getBoundingClientRect();
    if (!gridRect) return -1;
    const relX = x - gridRect.left;
    for (let i = 0; i < this.colPositions.length; i++) {
      const col = this.colPositions[i];
      if (relX >= col.left && relX < col.left + col.width) return i;
    }
    return -1;
  }
};
