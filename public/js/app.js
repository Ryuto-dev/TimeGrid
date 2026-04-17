/* ═══════════════════════════════════════════════════
   App Controller – Initialization & Routing
   ═══════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

async function initApp() {
  setupModalHandlers();
  setupSettingsModal();
  setupPlaceModal();
  setupEventModal();
  setupContextMenu();
  setupEditorActions();
  setupKeyboard();
  setupPWA();

  // Route
  const hash = window.location.hash;
  if (hash && hash.startsWith('#schedule/')) {
    const id = hash.replace('#schedule/', '');
    await openSchedule(id);
  } else {
    showScreen('schedule-list-screen');
    await loadScheduleList();
  }

  window.addEventListener('hashchange', async () => {
    const h = window.location.hash;
    if (h.startsWith('#schedule/')) {
      await openSchedule(h.replace('#schedule/', ''));
    } else {
      showScreen('schedule-list-screen');
      API.disconnectSSE();
      await loadScheduleList();
    }
  });
}

// ── Screen switching ──
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
  // Scroll top for small screens
  window.scrollTo({ top: 0 });
}

// ── Schedule List ──
async function loadScheduleList() {
  const container = document.getElementById('schedule-list');
  const empty = document.getElementById('empty-state');
  container.innerHTML = '<div class="list-loading"><span class="material-icons-round spin">autorenew</span> 読み込み中…</div>';
  empty.style.display = 'none';

  try {
    const schedules = await API.listSchedules();
    container.innerHTML = '';

    if (!schedules || schedules.length === 0) {
      empty.style.display = '';
      return;
    }
    empty.style.display = 'none';

    schedules.forEach(s => {
      const card = document.createElement('div');
      card.className = 'schedule-card';
      card.innerHTML = `
        <h3>${escHtml(s.name)}</h3>
        <div class="meta">
          <span><span class="material-icons-round">event</span> ${s.event_count ?? 0} 件</span>
          <span><span class="material-icons-round">place</span> ${s.place_count ?? 0} 場所</span>
          <span><span class="material-icons-round">update</span> ${formatDate(s.updated_at)}</span>
        </div>
        <div class="card-actions">
          <button class="btn btn-icon btn-sm" data-action="duplicate" title="複製">
            <span class="material-icons-round">content_copy</span>
          </button>
          <button class="btn btn-icon btn-sm" data-action="delete" title="削除">
            <span class="material-icons-round">delete</span>
          </button>
        </div>
      `;

      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-action]')) return;
        window.location.hash = `#schedule/${s.id}`;
      });

      card.querySelector('[data-action="duplicate"]').addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await API.duplicateSchedule(s.id);
          showToast('スケジュールを複製しました', 'success');
          await loadScheduleList();
        } catch (err) {
          showToast('複製に失敗しました: ' + err.message, 'error');
        }
      });

      card.querySelector('[data-action="delete"]').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`「${s.name}」を削除しますか？\nこの操作は取り消せません。`)) return;
        try {
          await API.deleteSchedule(s.id);
          showToast('スケジュールを削除しました', 'success');
          await loadScheduleList();
        } catch (err) {
          showToast('削除に失敗しました: ' + err.message, 'error');
        }
      });

      container.appendChild(card);
    });
  } catch (err) {
    container.innerHTML = '';
    empty.style.display = '';
    showToast('スケジュール一覧の取得に失敗しました: ' + err.message, 'error');
  }
}

document.getElementById('btn-new-schedule').addEventListener('click', async () => {
  try {
    const schedule = await API.createSchedule('新しいスケジュール');
    window.location.hash = `#schedule/${schedule.id}`;
  } catch (err) {
    showToast('作成に失敗しました: ' + err.message, 'error');
  }
});

// ── Open Schedule ──
async function openSchedule(id) {
  try {
    const schedule = await API.getSchedule(id);
    if (!schedule) {
      showToast('スケジュールが見つかりません', 'error');
      window.location.hash = '';
      return;
    }

    AppState.setSchedule(schedule);
    showScreen('editor-screen');

    document.getElementById('schedule-title').value = schedule.name;

    Timeline.init(document.getElementById('timeline-container'));
    Timeline.render();
    EventManager.init();

    // Connect polling sync
    API.connectSSE(id, handleSSEMessage);
    setSyncStatus('synced');
  } catch (err) {
    showToast('スケジュールの読み込みに失敗しました: ' + err.message, 'error');
    console.error(err);
  }
}

// ── Realtime handler ──
function handleSSEMessage(msg) {
  if (msg.type === 'connected') {
    setSyncStatus('synced');
    return;
  }
  if (msg.type === '_error') {
    setSyncStatus('error');
    return;
  }

  // Only handle messages for the current schedule
  const currentId = AppState.currentSchedule?.id;
  if (msg.scheduleId && currentId && msg.scheduleId !== currentId) return;

  switch (msg.type) {
    case 'event_added':
      // Avoid duplicating if we already have it
      if (!AppState.findEvent(msg.data.id)) {
        AppState.addEventLocal(msg.data);
        Timeline.renderEvents();
      }
      break;
    case 'event_updated':
      AppState.updateEventLocal(msg.data);
      Timeline.renderEvents();
      break;
    case 'event_deleted':
      AppState.removeEventLocal(msg.data.id);
      Timeline.renderEvents();
      break;
    case 'place_added':
      if (!AppState.findPlace(msg.data.id)) {
        AppState.addPlaceLocal(msg.data);
        Timeline.render();
      }
      break;
    case 'place_updated':
      AppState.updatePlaceLocal(msg.data);
      Timeline.render();
      break;
    case 'place_deleted':
      AppState.removePlaceLocal(msg.data.id);
      Timeline.render();
      break;
    case 'places_reordered':
      if (AppState.currentSchedule && Array.isArray(msg.data)) {
        AppState.currentSchedule.places = msg.data;
        Timeline.render();
      }
      break;
    case 'schedule_updated':
      if (AppState.currentSchedule) {
        Object.assign(AppState.currentSchedule, msg.data);
        const titleInput = document.getElementById('schedule-title');
        if (document.activeElement !== titleInput) {
          titleInput.value = msg.data.name;
        }
        Timeline.render();
      }
      break;
    case 'schedule_deleted':
      showToast('このスケジュールは他のユーザーによって削除されました', 'error');
      window.location.hash = '';
      break;
  }
  blinkSync();
}

function blinkSync() {
  const ind = document.getElementById('sync-indicator');
  if (!ind) return;
  ind.classList.add('syncing');
  setTimeout(() => {
    ind.classList.remove('syncing');
    setSyncStatus('synced');
  }, 400);
}

// ── Editor actions ──
function setupEditorActions() {
  document.getElementById('btn-back').addEventListener('click', () => {
    window.location.hash = '';
  });

  // Title auto-save
  let titleTimer;
  document.getElementById('schedule-title').addEventListener('input', (e) => {
    clearTimeout(titleTimer);
    setSyncStatus('syncing');
    titleTimer = setTimeout(async () => {
      try {
        await API.updateSchedule(AppState.currentSchedule.id, { name: e.target.value });
        AppState.currentSchedule.name = e.target.value;
        setSyncStatus('synced');
      } catch (err) {
        setSyncStatus('error');
        showToast('タイトルの保存に失敗しました', 'error');
      }
    }, 600);
  });

  document.getElementById('btn-add-event').addEventListener('click', () => {
    if (AppState.getPlacesOrdered().length === 0) {
      showToast('先に「場所」を1つ以上追加してください', 'error');
      document.getElementById('btn-manage-places').click();
      return;
    }
    EventManager.openEventModal(null);
  });

  document.getElementById('btn-settings').addEventListener('click', () => {
    const s = AppState.currentSchedule;
    document.getElementById('settings-start-hour').value = s.start_hour;
    document.getElementById('settings-start-minute').value = s.start_minute;
    document.getElementById('settings-end-hour').value = s.end_hour;
    document.getElementById('settings-end-minute').value = s.end_minute;
    document.getElementById('modal-settings').classList.add('open');
  });

  document.getElementById('btn-manage-places').addEventListener('click', () => {
    renderPlaceList();
    document.getElementById('modal-places').classList.add('open');
  });

  document.getElementById('btn-export').addEventListener('click', () => {
    if (!AppState.currentSchedule) return;
    const data = JSON.stringify(AppState.currentSchedule, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (AppState.currentSchedule.name || 'schedule').replace(/[^\w\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF-]+/g, '_') + '.json';
    a.click();
    URL.revokeObjectURL(url);
    showToast('エクスポートしました', 'success');
  });

  document.getElementById('btn-print').addEventListener('click', () => {
    // Ensure modals are closed before print
    closeAllModals();
    setTimeout(() => window.print(), 50);
  });

  // Wire share button if present
  const btnShare = document.getElementById('btn-share');
  if (btnShare) {
    btnShare.addEventListener('click', async () => {
      const url = window.location.href;
      if (navigator.share) {
        try {
          await navigator.share({ title: AppState.currentSchedule?.name || 'TimeGrid', url });
        } catch {}
      } else if (navigator.clipboard) {
        try {
          await navigator.clipboard.writeText(url);
          showToast('URLをコピーしました', 'success');
        } catch {
          showToast('URLのコピーに失敗しました', 'error');
        }
      }
    });
  }
}

// ── Settings Modal ──
function setupSettingsModal() {
  document.getElementById('btn-save-settings').addEventListener('click', async () => {
    const sh = parseInt(document.getElementById('settings-start-hour').value);
    const sm = parseInt(document.getElementById('settings-start-minute').value);
    const eh = parseInt(document.getElementById('settings-end-hour').value);
    const em = parseInt(document.getElementById('settings-end-minute').value);

    if ([sh, sm, eh, em].some(n => Number.isNaN(n))) {
      showToast('数値を正しく入力してください', 'error');
      return;
    }
    if (sh * 60 + sm >= eh * 60 + em) {
      showToast('終了時刻は開始時刻より後にしてください', 'error');
      return;
    }
    // Snap to 5-min grid
    const startMins = sh * 60 + Math.round(sm / 5) * 5;
    const endMins   = eh * 60 + Math.round(em / 5) * 5;

    try {
      setSyncStatus('syncing');
      const updated = await API.updateSchedule(AppState.currentSchedule.id, {
        start_hour: Math.floor(startMins / 60), start_minute: startMins % 60,
        end_hour: Math.floor(endMins / 60),     end_minute: endMins % 60
      });
      AppState.setSchedule(updated);
      Timeline.render();
      closeAllModals();
      setSyncStatus('synced');
      showToast('時間範囲を更新しました', 'success');
    } catch (err) {
      showToast('更新に失敗しました: ' + err.message, 'error');
      setSyncStatus('error');
    }
  });
}

// ── Place Management ──
function setupPlaceModal() {
  document.getElementById('btn-add-place').addEventListener('click', async () => {
    try {
      const colors = ['#4A90D9','#E8913A','#50B83C','#8B5CF6','#EC4899','#06B6D4','#F59E0B','#EF4444'];
      const color = colors[AppState.getPlacesOrdered().length % colors.length];
      setSyncStatus('syncing');
      const place = await API.addPlace(
        AppState.currentSchedule.id,
        `場所 ${AppState.getPlacesOrdered().length + 1}`,
        color
      );
      AppState.addPlaceLocal(place);
      renderPlaceList();
      Timeline.render();
      setSyncStatus('synced');
    } catch (err) {
      showToast('場所の追加に失敗しました: ' + err.message, 'error');
      setSyncStatus('error');
    }
  });
}

function renderPlaceList() {
  const container = document.getElementById('place-list');
  container.innerHTML = '';

  const places = AppState.getPlacesOrdered();
  if (places.length === 0) {
    const n = document.createElement('div');
    n.className = 'form-notice';
    n.textContent = '場所がまだありません。「場所を追加」をクリックして作成してください。';
    container.appendChild(n);
  }

  places.forEach(place => {
    const item = document.createElement('div');
    item.className = 'place-item';
    item.dataset.placeId = place.id;
    item.innerHTML = `
      <span class="drag-handle material-icons-round" title="ドラッグで並び替え">drag_indicator</span>
      <div class="place-color-swatch" style="background:${place.color}">
        <input type="color" value="${place.color}" title="色を変更">
      </div>
      <input type="text" value="${escHtml(place.name)}" placeholder="場所名">
      <button class="btn btn-icon btn-sm" data-action="delete" title="削除">
        <span class="material-icons-round">close</span>
      </button>
    `;

    item.querySelector('input[type="color"]').addEventListener('change', async (e) => {
      try {
        const updated = await API.updatePlace(place.id, { color: e.target.value });
        AppState.updatePlaceLocal(updated);
        item.querySelector('.place-color-swatch').style.background = e.target.value;
        Timeline.render();
      } catch (err) { showToast('色の更新に失敗しました', 'error'); }
    });

    let nameTimer;
    item.querySelector('input[type="text"]').addEventListener('input', (e) => {
      clearTimeout(nameTimer);
      setSyncStatus('syncing');
      nameTimer = setTimeout(async () => {
        try {
          const updated = await API.updatePlace(place.id, { name: e.target.value });
          AppState.updatePlaceLocal(updated);
          Timeline.render();
          setSyncStatus('synced');
        } catch (err) {
          setSyncStatus('error');
          showToast('名前の更新に失敗しました', 'error');
        }
      }, 500);
    });

    item.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      if (!confirm(`「${place.name}」を削除しますか？\nこの場所の予定も削除されます。`)) return;
      try {
        setSyncStatus('syncing');
        await API.deletePlace(place.id);
        AppState.removePlaceLocal(place.id);
        renderPlaceList();
        Timeline.render();
        setSyncStatus('synced');
      } catch (err) {
        showToast('削除に失敗しました', 'error');
        setSyncStatus('error');
      }
    });

    const handle = item.querySelector('.drag-handle');
    handle.addEventListener('mousedown', (e) => startPlaceDrag(e, item));
    handle.addEventListener('touchstart', (e) => startPlaceDrag(e, item), { passive: false });

    container.appendChild(item);
  });
}

let placeDragState = null;

function startPlaceDrag(e, item) {
  if (e.cancelable) e.preventDefault();
  const container = document.getElementById('place-list');
  const items = Array.from(container.children).filter(c => c.classList.contains('place-item'));
  const startIdx = items.indexOf(item);

  const pt = (ev) => ev.touches ? { x: ev.touches[0].clientX, y: ev.touches[0].clientY } : { x: ev.clientX, y: ev.clientY };

  placeDragState = { item, startIdx, startY: pt(e).y };
  item.style.opacity = '0.5';

  const onMove = (ev) => {
    if (ev.cancelable) ev.preventDefault();
    const y = pt(ev).y;
    const containerRect = container.getBoundingClientRect();
    const itemHeight = item.getBoundingClientRect().height + 8;
    const relY = y - containerRect.top;
    let newIdx = Math.max(0, Math.min(items.length - 1, Math.floor(relY / itemHeight)));

    if (newIdx !== placeDragState.startIdx) {
      const ref = newIdx > placeDragState.startIdx ? items[newIdx].nextSibling : items[newIdx];
      container.insertBefore(item, ref);
      items.splice(placeDragState.startIdx, 1);
      items.splice(newIdx, 0, item);
      placeDragState.startIdx = newIdx;
    }
  };

  const onUp = async () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onUp);
    item.style.opacity = '';

    const newItems = Array.from(container.children).filter(c => c.classList.contains('place-item'));
    const placeIds = newItems.map(el => el.dataset.placeId);

    try {
      setSyncStatus('syncing');
      const updated = await API.reorderPlaces(AppState.currentSchedule.id, placeIds);
      AppState.currentSchedule.places = updated;
      Timeline.render();
      setSyncStatus('synced');
    } catch (err) {
      showToast('並び替えに失敗しました', 'error');
      setSyncStatus('error');
    }
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('touchend', onUp);
}

// ── Event Modal wiring ──
function setupEventModal() {
  document.getElementById('btn-save-event').addEventListener('click', () => EventManager.saveEvent());
  document.getElementById('btn-delete-event').addEventListener('click', () => EventManager.deleteEvent());

  document.getElementById('event-type-range').addEventListener('click', () => {
    document.getElementById('event-type-range').classList.add('active');
    document.getElementById('event-type-task').classList.remove('active');
    document.getElementById('event-end-row').style.display = '';
  });
  document.getElementById('event-type-task').addEventListener('click', () => {
    document.getElementById('event-type-task').classList.add('active');
    document.getElementById('event-type-range').classList.remove('active');
    document.getElementById('event-end-row').style.display = 'none';
  });

  document.getElementById('event-color').addEventListener('input', (e) => {
    const val = e.target.value.toLowerCase();
    document.querySelectorAll('#preset-colors .preset-color').forEach(s => {
      const bg = (s.style.backgroundColor || '').toLowerCase();
      // Compare via hex conversion
      const m = bg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
      let hex = '';
      if (m) hex = '#' + [m[1],m[2],m[3]].map(n => Number(n).toString(16).padStart(2,'0')).join('');
      s.classList.toggle('selected', hex === val);
    });
  });

  // Enter on title saves
  document.getElementById('event-title').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      EventManager.saveEvent();
    }
  });
}

// ── Context Menu ──
function setupContextMenu() {
  const menu = document.getElementById('context-menu');

  document.getElementById('timeline-container').addEventListener('contextmenu', (e) => {
    const block = e.target.closest('.event-block');
    if (!block) return;
    e.preventDefault();

    const eventId = block.dataset.eventId;
    menu.dataset.eventId = eventId;
    menu.style.left = Math.min(window.innerWidth - 200, e.clientX) + 'px';
    menu.style.top = Math.min(window.innerHeight - 180, e.clientY) + 'px';
    menu.classList.add('open');
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#context-menu')) menu.classList.remove('open');
  });
  document.addEventListener('scroll', () => menu.classList.remove('open'), true);

  menu.querySelector('[data-action="edit"]').addEventListener('click', () => {
    EventManager.openEventModal(menu.dataset.eventId);
    menu.classList.remove('open');
  });

  menu.querySelector('[data-action="duplicate"]').addEventListener('click', () => {
    EventManager.duplicateEvent(menu.dataset.eventId);
    menu.classList.remove('open');
  });

  menu.querySelector('[data-action="delete"]').addEventListener('click', async () => {
    const id = menu.dataset.eventId;
    menu.classList.remove('open');
    if (!confirm('この予定を削除しますか？')) return;
    try {
      setSyncStatus('syncing');
      await API.deleteEvent(id);
      AppState.removeEventLocal(id);
      Timeline.renderEvents();
      setSyncStatus('synced');
      showToast('予定を削除しました', 'success');
    } catch (err) {
      showToast('削除に失敗しました', 'error');
      setSyncStatus('error');
    }
  });
}

// ── Modal helpers ──
function setupModalHandlers() {
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeAllModals();
    });
    overlay.querySelectorAll('.modal-close, .modal-cancel').forEach(btn => {
      btn.addEventListener('click', () => closeAllModals());
    });
  });
}

function closeAllModals() {
  document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('open'));
}

// ── Keyboard shortcuts ──
function setupKeyboard() {
  document.addEventListener('keydown', (e) => {
    // Escape: close modals / context menu
    if (e.key === 'Escape') {
      closeAllModals();
      const m = document.getElementById('context-menu');
      if (m) m.classList.remove('open');
      return;
    }
    // Skip if typing in input / textarea
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;

    // N: new event
    if ((e.key === 'n' || e.key === 'N') && AppState.currentSchedule) {
      e.preventDefault();
      document.getElementById('btn-add-event').click();
    }
    // P: print
    if ((e.ctrlKey || e.metaKey) && e.key === 'p' && AppState.currentSchedule) {
      // Let browser handle natively; ensure modals closed first
      closeAllModals();
    }
    // /: quick search focus (future)
  });
}

// ── PWA ──
function setupPWA() {
  // Register service worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      // Resolve path relative to current location
      const swPath = new URL('sw.js', window.location.href).pathname;
      navigator.serviceWorker.register(swPath).catch(() => {
        // silent: offline mode unavailable
      });
    });
  }

  // Offline indicator
  const showOfflineIndicator = (online) => {
    let el = document.getElementById('offline-indicator');
    if (!el) {
      el = document.createElement('div');
      el.id = 'offline-indicator';
      el.className = 'offline-indicator';
      el.innerHTML = '<span class="material-icons-round">wifi_off</span> オフラインです — 変更は保存されません';
      document.body.appendChild(el);
    }
    el.classList.toggle('visible', !online);
  };
  window.addEventListener('online', () => showOfflineIndicator(true));
  window.addEventListener('offline', () => showOfflineIndicator(false));
  if (!navigator.onLine) showOfflineIndicator(false);

  // Install prompt handling
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const btn = document.getElementById('btn-install-pwa');
    if (btn) {
      btn.style.display = '';
      btn.addEventListener('click', async () => {
        btn.style.display = 'none';
        if (deferredPrompt) {
          deferredPrompt.prompt();
          await deferredPrompt.userChoice;
          deferredPrompt = null;
        }
      }, { once: true });
    }
  });
}

// ── Utilities ──
function setSyncStatus(status) {
  const ind = document.getElementById('sync-indicator');
  if (!ind) return;
  ind.className = 'sync-indicator';
  if (status === 'syncing') {
    ind.classList.add('syncing');
    ind.title = '同期中...';
    ind.innerHTML = '<span class="material-icons-round">sync</span>';
  } else if (status === 'error') {
    ind.classList.add('error');
    ind.title = '同期エラー';
    ind.innerHTML = '<span class="material-icons-round">cloud_off</span>';
  } else {
    ind.title = '同期済み';
    ind.innerHTML = '<span class="material-icons-round">cloud_done</span>';
  }
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icons = { success: 'check_circle', error: 'error', info: 'info' };
  toast.innerHTML = `<span class="material-icons-round">${icons[type] || 'info'}</span> ${escHtml(message)}`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    toast.style.transition = '300ms ease';
    setTimeout(() => toast.remove(), 300);
  }, 3200);
}

function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str == null ? '' : String(str);
  return d.innerHTML;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  // Accept both "...Z" and "..." by appending Z if missing
  const s = /Z$|[+-]\d{2}:?\d{2}$/.test(dateStr) ? dateStr : dateStr + 'Z';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric' });
}
