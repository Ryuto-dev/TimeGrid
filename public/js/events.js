/* ═══════════════════════════════════════════════════
   Event Manager: Drag, Resize, CRUD
   Touch-friendly with long-press context menu
   ═══════════════════════════════════════════════════ */

const EventManager = {
  editingEventId: null,
  dragState: null,
  resizeState: null,
  _longPressTimer: null,

  init() {
    this.setupDragAndDrop();
    this.setupSlotClick();
  },

  // ── Pointer helpers (mouse + touch unified) ──
  _pt(e) {
    if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    if (e.changedTouches && e.changedTouches[0]) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
    return { x: e.clientX, y: e.clientY };
  },

  // ── Drag & Drop ──
  setupDragAndDrop() {
    const container = Timeline.container;
    if (!container || container._emDragBound) return;
    container._emDragBound = true;

    const onDown = (e) => {
      const block = e.target.closest('.event-block');
      if (!block) return;

      if (e.target.closest('.event-resize-handle')) {
        this.startResize(e, block);
        return;
      }
      if (e.target.closest('.event-props-btn')) return;

      this.startDrag(e, block);

      // Long-press for touch context menu
      if (e.type === 'touchstart') {
        this._longPressTimer = setTimeout(() => {
          const eventId = block.dataset.eventId;
          const menu = document.getElementById('context-menu');
          const p = this._pt(e);
          menu.dataset.eventId = eventId;
          menu.style.left = Math.min(window.innerWidth - 200, p.x) + 'px';
          menu.style.top  = Math.min(window.innerHeight - 180, p.y) + 'px';
          menu.classList.add('open');
          this.cancelDrag();
        }, 500);
      }
    };

    const onMove = (e) => {
      if (this._longPressTimer) {
        const p = this._pt(e);
        if (this.dragState && (Math.abs(p.x - this.dragState.startX) > 6 || Math.abs(p.y - this.dragState.startY) > 6)) {
          clearTimeout(this._longPressTimer);
          this._longPressTimer = null;
        }
      }
      if (this.dragState) this.onDrag(e);
      if (this.resizeState) this.onResize(e);
    };

    const onUp = (e) => {
      if (this._longPressTimer) { clearTimeout(this._longPressTimer); this._longPressTimer = null; }
      if (this.dragState) this.endDrag(e);
      if (this.resizeState) this.endResize(e);
    };

    container.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);

    container.addEventListener('touchstart', onDown, { passive: false });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);
    document.addEventListener('touchcancel', () => this.cancelDrag());
  },

  cancelDrag() {
    if (this.dragState) {
      document.querySelectorAll(`.event-block[data-event-id="${this.dragState.eventId}"]`)
        .forEach(b => b.classList.remove('dragging'));
      this.dragState = null;
      Timeline.renderEvents();
    }
    if (this.resizeState) {
      this.resizeState = null;
      Timeline.renderEvents();
    }
  },

  startDrag(e, block) {
    const eventId = block.dataset.eventId;
    const evt = AppState.findEvent(eventId);
    if (!evt) return;

    // Prevent native scroll during touch drag
    if (e.cancelable) e.preventDefault();

    const p = this._pt(e);
    const startSlot = Timeline.getSlotFromY(p.y);
    const evtStartSlot = AppState.minutesToSlot(evt.start_hour * 60 + evt.start_minute);

    this.dragState = {
      eventId,
      startY: p.y,
      startX: p.x,
      offsetSlot: startSlot - evtStartSlot,
      originalEvent: { ...evt, place_ids: [...(evt.place_ids || [])] },
      moved: false
    };

    document.querySelectorAll(`.event-block[data-event-id="${eventId}"]`).forEach(b => {
      b.classList.add('dragging');
    });
  },

  onDrag(e) {
    const ds = this.dragState;
    if (!ds) return;
    if (e.cancelable) e.preventDefault();

    const p = this._pt(e);
    const dx = Math.abs(p.x - ds.startX);
    const dy = Math.abs(p.y - ds.startY);
    if (!ds.moved && dx < 4 && dy < 4) return;
    ds.moved = true;

    const newSlot = Timeline.getSlotFromY(p.y) - ds.offsetSlot;
    const evt = ds.originalEvent;
    const duration = evt.event_type === 'task' ? 0 :
      (evt.end_hour * 60 + evt.end_minute) - (evt.start_hour * 60 + evt.start_minute);
    const durationSlots = duration / 5;
    const maxStart = AppState.getTotalSlots() - Math.max(1, durationSlots);
    const clampedSlot = Math.max(0, Math.min(maxStart, newSlot));

    const placeIdx = Timeline.getPlaceIndexFromX(p.x);
    const topPx = Timeline.headerHeight + clampedSlot * Timeline.slotHeight;

    document.querySelectorAll(`.event-block[data-event-id="${ds.eventId}"]`).forEach(b => {
      b.style.top = topPx + 'px';
      if (placeIdx >= 0) {
        const col = Timeline.colPositions[placeIdx];
        if (col) {
          b.style.left = (col.left + 2) + 'px';
          b.style.width = (col.width - 4) + 'px';
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

    if (ds.currentPlaceIdx != null && ds.currentPlaceIdx >= 0) {
      const places = AppState.getPlacesOrdered();
      if (ds.currentPlaceIdx < places.length) {
        const targetPlaceId = places[ds.currentPlaceIdx].id;
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

    if (e.cancelable) e.preventDefault();
    e.stopPropagation();

    const isTop = e.target.classList.contains('top');
    const p = this._pt(e);

    this.resizeState = {
      eventId,
      isTop,
      startY: p.y,
      originalEvent: { ...evt, place_ids: [...(evt.place_ids || [])] }
    };
  },

  onResize(e) {
    const rs = this.resizeState;
    if (!rs) return;
    if (e.cancelable) e.preventDefault();

    const evt = rs.originalEvent;
    const p = this._pt(e);
    const slot = Timeline.getSlotFromY(p.y);

    if (rs.isTop) {
      const endMins = evt.end_hour * 60 + evt.end_minute;
      const endSlot = AppState.minutesToSlot(endMins);
      const clampedSlot = Math.max(0, Math.min(endSlot - 1, slot));

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
      const startMins = evt.start_hour * 60 + evt.start_minute;
      const startSlot = AppState.minutesToSlot(startMins);
      const clampedSlot = Math.max(startSlot + 1, Math.min(AppState.getTotalSlots(), slot + 1));

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
    if (Timeline.container._emSlotBound) return;
    Timeline.container._emSlotBound = true;

    Timeline.container.addEventListener('dblclick', (e) => {
      const slot = e.target.closest('.tg-slot');
      if (!slot) return;

      const slotNum = parseInt(slot.dataset.slot);
      const placeId = slot.dataset.placeId;
      const mins = AppState.slotToMinutes(slotNum);
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      const endMins = Math.min(AppState.getEndMinutes(), mins + 60);
      const eh = Math.floor(endMins / 60);
      const em = endMins % 60;

      this.openEventModal(null, {
        start_hour: h,
        start_minute: m,
        end_hour: eh,
        end_minute: em,
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
      // Default to first available place if none specified
      const firstPlaceId = (AppState.getPlacesOrdered()[0] || {}).id;
      evt = {
        title: '',
        description: '',
        event_type: 'range',
        start_hour: 9,
        start_minute: 0,
        end_hour: 10,
        end_minute: 0,
        color: '#4A90D9',
        place_ids: firstPlaceId ? [firstPlaceId] : [],
        notes_column: '',
        ...(defaults || {})
      };
      // Ensure place_ids from defaults is at least the first place
      if (!evt.place_ids || evt.place_ids.length === 0) {
        if (firstPlaceId) evt.place_ids = [firstPlaceId];
      }
    } else {
      evt = AppState.findEvent(eventId);
      if (!evt) return;
      evt = { ...evt, place_ids: [...(evt.place_ids || [])] };
    }

    this.editingEventId = eventId;

    document.getElementById('event-modal-title').innerHTML =
      `<span class="material-icons-round">event</span> ${isNew ? '予定の追加' : '予定の編集'}`;
    document.getElementById('event-title').value = evt.title || '';
    document.getElementById('event-description').value = evt.description || '';
    document.getElementById('event-start-hour').value = evt.start_hour;
    document.getElementById('event-start-minute').value = evt.start_minute;
    document.getElementById('event-end-hour').value = evt.end_hour ?? (evt.start_hour + 1);
    document.getElementById('event-end-minute').value = evt.end_minute ?? 0;
    document.getElementById('event-color').value = evt.color || '#4A90D9';
    document.getElementById('event-notes').value = evt.notes_column || '';

    const isTask = evt.event_type === 'task';
    document.getElementById('event-type-range').classList.toggle('active', !isTask);
    document.getElementById('event-type-task').classList.toggle('active', isTask);
    document.getElementById('event-end-row').style.display = isTask ? 'none' : '';

    // Render place checkboxes (FIX: ensure single-source-of-truth for state)
    this.renderPlaceCheckboxes(evt.place_ids || []);

    this.renderPresetColors(evt.color);

    document.getElementById('btn-delete-event').style.display = isNew ? 'none' : '';

    modal.classList.add('open');

    // Focus title only if new (avoid stealing focus on mobile during edit)
    if (isNew) {
      setTimeout(() => document.getElementById('event-title').focus(), 50);
    }
  },

  renderPlaceCheckboxes(selectedIds) {
    const placeContainer = document.getElementById('event-place-checkboxes');
    placeContainer.innerHTML = '';
    const places = AppState.getPlacesOrdered();

    if (places.length === 0) {
      const notice = document.createElement('div');
      notice.className = 'form-notice';
      notice.textContent = '先に「場所」を1つ以上追加してください。';
      placeContainer.appendChild(notice);
      return;
    }

    const selected = new Set(selectedIds);

    places.forEach(place => {
      const label = document.createElement('label');
      label.className = 'checkbox-item' + (selected.has(place.id) ? ' checked' : '');
      label.dataset.placeId = place.id;

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = place.id;
      input.checked = selected.has(place.id);

      const dot = document.createElement('span');
      dot.className = 'place-color-dot';
      dot.style.background = place.color;

      const text = document.createElement('span');
      text.className = 'place-name-text';
      text.textContent = place.name;

      label.appendChild(input);
      label.appendChild(dot);
      label.appendChild(text);

      // Single source of truth: native checkbox change
      input.addEventListener('change', () => {
        label.classList.toggle('checked', input.checked);
      });

      placeContainer.appendChild(label);
    });

    // "All / None" helper buttons
    const helper = document.createElement('div');
    helper.className = 'checkbox-helper-row';
    helper.innerHTML = `
      <button type="button" class="btn btn-ghost btn-xs" data-helper="all">すべて選択</button>
      <button type="button" class="btn btn-ghost btn-xs" data-helper="none">選択解除</button>
    `;
    helper.querySelector('[data-helper="all"]').addEventListener('click', () => {
      placeContainer.querySelectorAll('input[type=checkbox]').forEach(cb => {
        cb.checked = true;
        cb.closest('.checkbox-item').classList.add('checked');
      });
    });
    helper.querySelector('[data-helper="none"]').addEventListener('click', () => {
      placeContainer.querySelectorAll('input[type=checkbox]').forEach(cb => {
        cb.checked = false;
        cb.closest('.checkbox-item').classList.remove('checked');
      });
    });
    placeContainer.appendChild(helper);
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
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = `preset-color ${c.toLowerCase() === String(selected || '').toLowerCase() ? 'selected' : ''}`;
      swatch.style.backgroundColor = c;
      swatch.setAttribute('aria-label', `Color ${c}`);
      swatch.addEventListener('click', () => {
        document.getElementById('event-color').value = c;
        container.querySelectorAll('.preset-color').forEach(s => s.classList.remove('selected'));
        swatch.classList.add('selected');
      });
      container.appendChild(swatch);
    });
  },

  async saveEvent() {
    const titleEl = document.getElementById('event-title');
    const title = titleEl.value.trim();
    if (!title) {
      showToast('タイトルを入力してください', 'error');
      titleEl.focus();
      return;
    }

    const isTask = document.getElementById('event-type-task').classList.contains('active');
    const placeCheckboxes = document.querySelectorAll('#event-place-checkboxes input[type=checkbox]:checked');
    const placeIds = Array.from(placeCheckboxes).map(cb => cb.value);

    if (placeIds.length === 0) {
      showToast('少なくとも1つの場所を選択してください', 'error');
      return;
    }

    const sh = parseInt(document.getElementById('event-start-hour').value, 10);
    const sm = parseInt(document.getElementById('event-start-minute').value, 10);
    const eh = parseInt(document.getElementById('event-end-hour').value, 10);
    const em = parseInt(document.getElementById('event-end-minute').value, 10);

    if ([sh, sm].some(n => Number.isNaN(n))) {
      showToast('開始時刻が無効です', 'error');
      return;
    }
    if (!isTask) {
      if ([eh, em].some(n => Number.isNaN(n))) {
        showToast('終了時刻が無効です', 'error');
        return;
      }
      if (eh * 60 + em <= sh * 60 + sm) {
        showToast('終了時刻は開始時刻より後にしてください', 'error');
        return;
      }
    }

    const color = document.getElementById('event-color').value || '#4A90D9';
    const data = {
      title,
      description: document.getElementById('event-description').value.trim(),
      event_type: isTask ? 'task' : 'range',
      start_hour: sh,
      start_minute: sm,
      end_hour: isTask ? null : eh,
      end_minute: isTask ? null : em,
      color,
      text_color: pickTextColor(color),
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
    };
    // Shift 5 min later, clamped
    const startMins = evt.start_hour * 60 + evt.start_minute + 5;
    const endMaxMins = AppState.getEndMinutes();
    if (evt.event_type !== 'task' && evt.end_hour != null) {
      const endMins = evt.end_hour * 60 + evt.end_minute + 5;
      if (endMins <= endMaxMins) {
        data.start_hour = Math.floor(startMins / 60);
        data.start_minute = startMins % 60;
        data.end_hour = Math.floor(endMins / 60);
        data.end_minute = endMins % 60;
      }
    } else {
      if (startMins <= endMaxMins) {
        data.start_hour = Math.floor(startMins / 60);
        data.start_minute = startMins % 60;
      }
    }
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

/* ── Auto text color based on background luminance ── */
function pickTextColor(hex) {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return '#FFFFFF';
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Relative luminance (WCAG)
  const toLinear = (c) => {
    c = c / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const L = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  return L > 0.55 ? '#111827' : '#FFFFFF';
}
