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
      ph.innerHTML = `<span class="place-color-dot" style="background:${place.color}"></span>${this.escHtml(place.name)}`;
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

    // Notes cell rendering map: slot -> text
    const notesBySlot = {};

    events.forEach(evt => {
      const startMins = evt.start_hour * 60 + evt.start_minute;
      const topSlot = AppState.minutesToSlot(startMins);
      let heightSlots;

      if (evt.event_type === 'task' || evt.end_hour == null) {
        heightSlots = 2; // task marker = 10 min visual
      } else {
        const endMins = evt.end_hour * 60 + evt.end_minute;
        heightSlots = Math.max(1, AppState.minutesToSlot(endMins) - topSlot);
      }

      // Determine which columns this event spans
      const evtPlaceIds = evt.place_ids || [];
      if (evtPlaceIds.length === 0) return;

      // Find column indices
      const colIndices = evtPlaceIds
        .map(pid => placeIdOrder.indexOf(pid))
        .filter(i => i >= 0)
        .sort((a, b) => a - b);

      if (colIndices.length === 0) return;

      // Group into contiguous runs for merging
      const runs = [];
      let currentRun = [colIndices[0]];
      for (let i = 1; i < colIndices.length; i++) {
        if (colIndices[i] === currentRun[currentRun.length - 1] + 1) {
          currentRun.push(colIndices[i]);
        } else {
          runs.push(currentRun);
          currentRun = [colIndices[i]];
        }
      }
      runs.push(currentRun);

      // Create blocks for each run
      runs.forEach(run => {
        run.forEach((colIdx, runPos) => {
          const col = this.colPositions[colIdx];
          if (!col) return;

          const block = document.createElement('div');
          block.className = `event-block ${evt.event_type === 'task' ? 'task-event' : ''}`;
          block.dataset.eventId = evt.id;
          block.style.backgroundColor = evt.color || '#4A90D9';
          block.style.color = evt.text_color || '#FFFFFF';
          block.style.top = (this.headerHeight + topSlot * this.slotHeight) + 'px';
          block.style.height = (heightSlots * this.slotHeight) + 'px';
          block.style.left = (col.left + 2) + 'px';
          block.style.width = (col.width - 4) + 'px';

          // Merge classes
          if (run.length > 1) {
            if (runPos === 0) {
              block.classList.add('merged-right');
              block.style.width = (col.width) + 'px';
              block.style.left = (col.left + 2) + 'px';
            } else if (runPos === run.length - 1) {
              block.classList.add('merged-left');
              block.style.left = col.left + 'px';
              block.style.width = (col.width - 2) + 'px';
            } else {
              block.classList.add('merged-middle');
              block.style.left = col.left + 'px';
              block.style.width = col.width + 'px';
            }
          }

          // Content (only show on first block of run)
          if (runPos === 0) {
            const title = document.createElement('div');
            title.className = 'event-title';
            title.textContent = evt.title;
            block.appendChild(title);

            if (evt.event_type !== 'task' && heightSlots > 3) {
              const time = document.createElement('div');
              time.className = 'event-time';
              time.textContent = `${AppState.formatTime(evt.start_hour, evt.start_minute)} - ${AppState.formatTime(evt.end_hour, evt.end_minute)}`;
              block.appendChild(time);
            }

            if (evt.description && heightSlots > 5) {
              const desc = document.createElement('div');
              desc.className = 'event-desc';
              desc.textContent = evt.description;
              block.appendChild(desc);
            }
          }

          // Props button (only on first)
          if (runPos === 0) {
            const propsBtn = document.createElement('button');
            propsBtn.className = 'event-props-btn';
            propsBtn.innerHTML = '<span class="material-icons-round">more_vert</span>';
            propsBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              EventManager.openEventModal(evt.id);
            });
            block.appendChild(propsBtn);
          }

          // Resize handles (only for range events, on first block)
          if (evt.event_type !== 'task' && runPos === 0) {
            const handleBottom = document.createElement('div');
            handleBottom.className = 'event-resize-handle bottom';
            block.appendChild(handleBottom);

            const handleTop = document.createElement('div');
            handleTop.className = 'event-resize-handle top';
            block.appendChild(handleTop);
          }

          this.container.querySelector('.timeline-grid').appendChild(block);
        });
      });

      // Notes column
      if (evt.notes_column) {
        const slot = topSlot;
        if (!notesBySlot[slot]) notesBySlot[slot] = [];
        notesBySlot[slot].push(evt.notes_column);
      }
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
