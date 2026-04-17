/* ═══════════════════════════════════════════════════
   Event Manager: Drag, Resize, CRUD
   ═══════════════════════════════════════════════════ */

const EventManager = {
  editingEventId: null,
  dragState: null,
  resizeState: null,

  init() {
    this.setupDragAndDrop();
    this.setupSlotClick();
  },

  // ── Drag & Drop ──
  setupDragAndDrop() {
    const container = Timeline.container;
    if (!container) return;

    container.addEventListener('mousedown', (e) => {
      const block = e.target.closest('.event-block');
      if (!block) return;

      // Check if resize handle
      if (e.target.closest('.event-resize-handle')) {
        this.startResize(e, block);
        return;
      }

      // Don't drag from button
      if (e.target.closest('.event-props-btn')) return;

      this.startDrag(e, block);
    });

    document.addEventListener('mousemove', (e) => {
      if (this.dragState) this.onDrag(e);
      if (this.resizeState) this.onResize(e);
    });

    document.addEventListener('mouseup', (e) => {
      if (this.dragState) this.endDrag(e);
      if (this.resizeState) this.endResize(e);
    });
  },

  startDrag(e, block) {
    const eventId = block.dataset.eventId;
    const evt = AppState.findEvent(eventId);
    if (!evt) return;

    e.preventDefault();
    const startSlot = Timeline.getSlotFromY(e.clientY);
    const evtStartSlot = AppState.minutesToSlot(evt.start_hour * 60 + evt.start_minute);

    this.dragState = {
      eventId,
      startY: e.clientY,
      startX: e.clientX,
      offsetSlot: startSlot - evtStartSlot,
      originalEvent: { ...evt, place_ids: [...evt.place_ids] },
      moved: false
    };

    // Mark all blocks for this event
    document.querySelectorAll(`.event-block[data-event-id="${eventId}"]`).forEach(b => {
      b.classList.add('dragging');
    });
  },

  onDrag(e) {
    const ds = this.dragState;
    if (!ds) return;

    const dx = Math.abs(e.clientX - ds.startX);
    const dy = Math.abs(e.clientY - ds.startY);
    if (!ds.moved && dx < 4 && dy < 4) return;
    ds.moved = true;

    const newSlot = Timeline.getSlotFromY(e.clientY) - ds.offsetSlot;
    const clampedSlot = Math.max(0, Math.min(AppState.getTotalSlots() - 1, newSlot));
    const newMins = AppState.slotToMinutes(clampedSlot);
    const newH = Math.floor(newMins / 60);
    const newM = newMins % 60;

    const evt = ds.originalEvent;
    const duration = evt.event_type === 'task' ? 0 :
      (evt.end_hour * 60 + evt.end_minute) - (evt.start_hour * 60 + evt.start_minute);

    // Also check column change
    const placeIdx = Timeline.getPlaceIndexFromX(e.clientX);
    const places = AppState.getPlacesOrdered();

    // Update visual position of all blocks
    const topPx = Timeline.headerHeight + clampedSlot * Timeline.slotHeight;

    document.querySelectorAll(`.event-block[data-event-id="${ds.eventId}"]`).forEach(b => {
      b.style.top = topPx + 'px';
      if (placeIdx >= 0) {
        const col = Timeline.colPositions[placeIdx];
        if (col) {
          b.style.left = (col.left + 2) + 'px';
          b.style.width = (col.width - 4) + 'px';
          // Remove merge classes visually during drag
          b.classList.remove('merged-left', 'merged-right', 'merged-middle');
        }
      }
    });

    ds.currentSlot = clampedSlot;
    ds.currentPlaceIdx = placeIdx;
  },

  async endDrag(e) {
    const ds = this.dragState;
    this.dragState = null;

    if (!ds) return;

    document.querySelectorAll(`.event-block[data-event-id="${ds.eventId}"]`).forEach(b => {
      b.classList.remove('dragging');
    });

    if (!ds.moved) {
      // Click → open editor
      this.openEventModal(ds.eventId);
      return;
    }

    const evt = ds.originalEvent;
    const newSlot = ds.currentSlot;
    if (newSlot == null) { Timeline.renderEvents(); return; }

    const newMins = AppState.slotToMinutes(newSlot);
    const newH = Math.floor(newMins / 60);
    const newM = newMins % 60;

    const update = { start_hour: newH, start_minute: newM };

    if (evt.event_type !== 'task' && evt.end_hour != null) {
      const duration = (evt.end_hour * 60 + evt.end_minute) - (evt.start_hour * 60 + evt.start_minute);
      const endMins = newMins + duration;
      update.end_hour = Math.floor(endMins / 60);
      update.end_minute = endMins % 60;
    }

    // If dropped on a different column, update place
    if (ds.currentPlaceIdx >= 0) {
      const places = AppState.getPlacesOrdered();
      if (ds.currentPlaceIdx < places.length) {
        const targetPlaceId = places[ds.currentPlaceIdx].id;
        // Always move to the single target place when dragging horizontally
        update.place_ids = [targetPlaceId];
      }
    }

    try {
      setSyncStatus('syncing');
      const updated = await API.updateEvent(ds.eventId, update);
      AppState.updateEventLocal(updated);
      Timeline.renderEvents();
      setSyncStatus('synced');
    } catch (err) {
      showToast('更新に失敗しました', 'error');
      Timeline.renderEvents();
      setSyncStatus('error');
    }
  },

  // ── Resize ──
  startResize(e, block) {
    const eventId = block.dataset.eventId;
    const evt = AppState.findEvent(eventId);
    if (!evt || evt.event_type === 'task') return;

    e.preventDefault();
    e.stopPropagation();

    const isTop = e.target.classList.contains('top');

    this.resizeState = {
      eventId,
      isTop,
      startY: e.clientY,
      originalEvent: { ...evt, place_ids: [...evt.place_ids] }
    };
  },

  onResize(e) {
    const rs = this.resizeState;
    if (!rs) return;

    const evt = rs.originalEvent;
    const slot = Timeline.getSlotFromY(e.clientY);

    if (rs.isTop) {
      const clampedSlot = Math.max(0, Math.min(AppState.getTotalSlots() - 1, slot));
      const endMins = evt.end_hour * 60 + evt.end_minute;
      const endSlot = AppState.minutesToSlot(endMins);

      if (clampedSlot >= endSlot) return;

      const newMins = AppState.slotToMinutes(clampedSlot);
      const topPx = Timeline.headerHeight + clampedSlot * Timeline.slotHeight;
      const heightPx = (endSlot - clampedSlot) * Timeline.slotHeight;

      document.querySelectorAll(`.event-block[data-event-id="${rs.eventId}"]`).forEach(b => {
        b.style.top = topPx + 'px';
        b.style.height = heightPx + 'px';
      });

      rs.currentStartH = Math.floor(newMins / 60);
      rs.currentStartM = newMins % 60;
    } else {
      const clampedSlot = Math.max(0, Math.min(AppState.getTotalSlots(), slot + 1));
      const startMins = evt.start_hour * 60 + evt.start_minute;
      const startSlot = AppState.minutesToSlot(startMins);

      if (clampedSlot <= startSlot) return;

      const newMins = AppState.slotToMinutes(clampedSlot);
      const heightPx = (clampedSlot - startSlot) * Timeline.slotHeight;

      document.querySelectorAll(`.event-block[data-event-id="${rs.eventId}"]`).forEach(b => {
        b.style.height = heightPx + 'px';
      });

      rs.currentEndH = Math.floor(newMins / 60);
      rs.currentEndM = newMins % 60;
    }
  },

  async endResize(e) {
    const rs = this.resizeState;
    this.resizeState = null;
    if (!rs) return;
    if (rs.isTop && rs.currentStartH == null) { Timeline.renderEvents(); return; }
    if (!rs.isTop && rs.currentEndH == null) { Timeline.renderEvents(); return; }

    try {
      setSyncStatus('syncing');
      const update = rs.isTop ? {
        start_hour: rs.currentStartH,
        start_minute: rs.currentStartM
      } : {
        end_hour: rs.currentEndH,
        end_minute: rs.currentEndM
      };

      const updated = await API.updateEvent(rs.eventId, update);
      AppState.updateEventLocal(updated);
      Timeline.renderEvents();
      setSyncStatus('synced');
    } catch (err) {
      showToast('更新に失敗しました', 'error');
      Timeline.renderEvents();
      setSyncStatus('error');
    }
  },

  // ── Slot click → quick create ──
  setupSlotClick() {
    Timeline.container.addEventListener('dblclick', (e) => {
      const slot = e.target.closest('.tg-slot');
      if (!slot) return;

      const slotNum = parseInt(slot.dataset.slot);
      const placeId = slot.dataset.placeId;
      const mins = AppState.slotToMinutes(slotNum);
      const h = Math.floor(mins / 60);
      const m = mins % 60;

      this.openEventModal(null, {
        start_hour: h,
        start_minute: m,
        end_hour: h + 1,
        end_minute: m,
        place_ids: placeId ? [placeId] : []
      });
    });
  },

  // ── Event Modal ──
  openEventModal(eventId, defaults) {
    const modal = document.getElementById('modal-event');
    const isNew = !eventId;
    let evt;

    if (isNew) {
      evt = {
        title: '',
        description: '',
        event_type: 'range',
        start_hour: 9,
        start_minute: 0,
        end_hour: 10,
        end_minute: 0,
        color: '#4A90D9',
        place_ids: [],
        notes_column: '',
        ...defaults
      };
    } else {
      evt = AppState.findEvent(eventId);
      if (!evt) return;
    }

    this.editingEventId = eventId;

    document.getElementById('event-modal-title').innerHTML =
      `<span class="material-icons-round">event</span> ${isNew ? '予定の追加' : '予定の編集'}`;
    document.getElementById('event-title').value = evt.title;
    document.getElementById('event-description').value = evt.description || '';
    document.getElementById('event-start-hour').value = evt.start_hour;
    document.getElementById('event-start-minute').value = evt.start_minute;
    document.getElementById('event-end-hour').value = evt.end_hour ?? evt.start_hour + 1;
    document.getElementById('event-end-minute').value = evt.end_minute ?? 0;
    document.getElementById('event-color').value = evt.color || '#4A90D9';
    document.getElementById('event-notes').value = evt.notes_column || '';

    // Event type
    const isTask = evt.event_type === 'task';
    document.getElementById('event-type-range').classList.toggle('active', !isTask);
    document.getElementById('event-type-task').classList.toggle('active', isTask);
    document.getElementById('event-end-row').style.display = isTask ? 'none' : '';

    // Place checkboxes
    const placeContainer = document.getElementById('event-place-checkboxes');
    placeContainer.innerHTML = '';
    AppState.getPlacesOrdered().forEach(place => {
      const checked = evt.place_ids.includes(place.id);
      const item = document.createElement('label');
      item.className = `checkbox-item ${checked ? 'checked' : ''}`;
      item.innerHTML = `<input type="checkbox" value="${place.id}" ${checked ? 'checked' : ''}>
        <span class="place-color-dot" style="background:${place.color};width:8px;height:8px;border-radius:50%;display:inline-block"></span>
        ${Timeline.escHtml(place.name)}`;
      item.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT') return;
        const cb = item.querySelector('input');
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      });
      item.querySelector('input').addEventListener('change', () => {
        item.classList.toggle('checked', item.querySelector('input').checked);
      });
      placeContainer.appendChild(item);
    });

    // Preset colors
    this.renderPresetColors(evt.color);

    // Delete button visibility
    document.getElementById('btn-delete-event').style.display = isNew ? 'none' : '';

    modal.classList.add('open');
    document.getElementById('event-title').focus();
  },

  renderPresetColors(selected) {
    const colors = [
      '#4A90D9', '#6366F1', '#8B5CF6', '#EC4899', '#EF4444',
      '#F59E0B', '#10B981', '#14B8A6', '#06B6D4', '#3B82F6',
      '#78716C', '#1E293B'
    ];
    const container = document.getElementById('preset-colors');
    container.innerHTML = '';
    colors.forEach(c => {
      const swatch = document.createElement('div');
      swatch.className = `preset-color ${c === selected ? 'selected' : ''}`;
      swatch.style.backgroundColor = c;
      swatch.addEventListener('click', () => {
        document.getElementById('event-color').value = c;
        container.querySelectorAll('.preset-color').forEach(s => s.classList.remove('selected'));
        swatch.classList.add('selected');
      });
      container.appendChild(swatch);
    });
  },

  async saveEvent() {
    const title = document.getElementById('event-title').value.trim();
    if (!title) { showToast('タイトルを入力してください', 'error'); return; }

    const isTask = document.getElementById('event-type-task').classList.contains('active');
    const placeCheckboxes = document.querySelectorAll('#event-place-checkboxes input:checked');
    const placeIds = Array.from(placeCheckboxes).map(cb => cb.value);

    if (placeIds.length === 0) {
      showToast('少なくとも1つの場所を選択してください', 'error');
      return;
    }

    const data = {
      title,
      description: document.getElementById('event-description').value.trim(),
      event_type: isTask ? 'task' : 'range',
      start_hour: parseInt(document.getElementById('event-start-hour').value),
      start_minute: parseInt(document.getElementById('event-start-minute').value),
      end_hour: isTask ? null : parseInt(document.getElementById('event-end-hour').value),
      end_minute: isTask ? null : parseInt(document.getElementById('event-end-minute').value),
      color: document.getElementById('event-color').value,
      place_ids: placeIds,
      notes_column: document.getElementById('event-notes').value.trim()
    };

    try {
      setSyncStatus('syncing');
      if (this.editingEventId) {
        const updated = await API.updateEvent(this.editingEventId, data);
        AppState.updateEventLocal(updated);
      } else {
        const created = await API.addEvent(AppState.currentSchedule.id, data);
        AppState.addEventLocal(created);
      }
      Timeline.renderEvents();
      closeAllModals();
      setSyncStatus('synced');
      showToast(this.editingEventId ? '予定を更新しました' : '予定を追加しました', 'success');
    } catch (err) {
      showToast('保存に失敗しました: ' + err.message, 'error');
      setSyncStatus('error');
    }
  },

  async deleteEvent() {
    if (!this.editingEventId) return;
    if (!confirm('この予定を削除しますか？')) return;

    try {
      setSyncStatus('syncing');
      await API.deleteEvent(this.editingEventId);
      AppState.removeEventLocal(this.editingEventId);
      Timeline.renderEvents();
      closeAllModals();
      setSyncStatus('synced');
      showToast('予定を削除しました', 'success');
    } catch (err) {
      showToast('削除に失敗しました', 'error');
      setSyncStatus('error');
    }
  },

  async duplicateEvent(eventId) {
    const evt = AppState.findEvent(eventId);
    if (!evt) return;

    const data = {
      ...evt,
      title: evt.title + ' (コピー)',
      start_minute: evt.start_minute + 5
    };
    delete data.id;
    delete data.schedule_id;
    delete data.created_at;
    delete data.updated_at;

    try {
      setSyncStatus('syncing');
      const created = await API.addEvent(AppState.currentSchedule.id, data);
      AppState.addEventLocal(created);
      Timeline.renderEvents();
      setSyncStatus('synced');
      showToast('予定を複製しました', 'success');
    } catch (err) {
      showToast('複製に失敗しました', 'error');
      setSyncStatus('error');
    }
  }
};
