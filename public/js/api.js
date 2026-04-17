/* ═══════════════════════════════════════════════════
   API Client (PHP Backend)
   Collaborative sync via polling the changes endpoint
   ═══════════════════════════════════════════════════ */

const API = {
  // Resolve endpoint relative to current script location so it works
  // both at site root and in a subdirectory (e.g. /timegrid/).
  endpoint: (() => {
    try {
      const base = new URL('.', window.location.href);
      return base.pathname.replace(/\/$/, '') + '/api.php';
    } catch {
      return 'api.php';
    }
  })(),

  clientId: (() => {
    // Stable client id per tab (survives reloads via sessionStorage)
    try {
      let id = sessionStorage.getItem('timegrid_cid');
      if (!id) {
        id = 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        sessionStorage.setItem('timegrid_cid', id);
      }
      return id;
    } catch {
      return 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    }
  })(),

  async _request(action, { method = 'GET', query = {}, body = null } = {}) {
    const params = new URLSearchParams({ action, ...query });
    const url = `${this.endpoint}?${params.toString()}`;
    const options = {
      method,
      headers: {
        'Accept': 'application/json',
        'X-Client-Id': this.clientId,
      },
      credentials: 'same-origin',
    };
    if (body != null) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    const res = await fetch(url, options);
    let json = null;
    const ct = res.headers.get('Content-Type') || '';
    if (ct.includes('application/json')) {
      json = await res.json().catch(() => null);
    } else {
      const text = await res.text().catch(() => '');
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0,200)}`);
      throw new Error('Expected JSON response');
    }
    if (!res.ok) {
      throw new Error((json && (json.error || json.message)) || `HTTP ${res.status}`);
    }
    return json;
  },

  // ── Schedules ──
  async listSchedules() {
    return this._request('list_schedules');
  },

  async createSchedule(name = '新しいスケジュール') {
    return this._request('create_schedule', { method: 'POST', body: { name } });
  },

  async getSchedule(id) {
    try {
      return await this._request('get_schedule', { query: { id } });
    } catch (e) {
      if (String(e.message).includes('Not found')) return null;
      throw e;
    }
  },

  async updateSchedule(id, updates) {
    return this._request('update_schedule', { method: 'POST', query: { id }, body: updates });
  },

  async deleteSchedule(id) {
    return this._request('delete_schedule', { method: 'POST', query: { id } });
  },

  async duplicateSchedule(id) {
    return this._request('duplicate_schedule', { method: 'POST', query: { id } });
  },

  // ── Places ──
  async addPlace(scheduleId, name, color = '#4A90D9') {
    return this._request('add_place', {
      method: 'POST',
      body: { schedule_id: scheduleId, name, color }
    });
  },

  async updatePlace(id, updates) {
    return this._request('update_place', { method: 'POST', query: { id }, body: updates });
  },

  async deletePlace(id) {
    return this._request('delete_place', { method: 'POST', query: { id } });
  },

  async reorderPlaces(scheduleId, placeIds) {
    return this._request('reorder_places', {
      method: 'POST',
      body: { schedule_id: scheduleId, place_ids: placeIds }
    });
  },

  // ── Events ──
  async addEvent(scheduleId, data) {
    return this._request('add_event', {
      method: 'POST',
      body: { schedule_id: scheduleId, ...data }
    });
  },

  async updateEvent(id, updates) {
    return this._request('update_event', { method: 'POST', query: { id }, body: updates });
  },

  async deleteEvent(id) {
    return this._request('delete_event', { method: 'POST', query: { id } });
  },

  // ── Realtime (polling) ──
  _pollTimer: null,
  _pollCallback: null,
  _currentScheduleId: null,
  _since: 0,
  _pollInterval: 2500,
  _pollActive: false,
  _pollPaused: false,
  _consecutiveErrors: 0,

  connectSSE(scheduleId, onMessage) {
    this.disconnectSSE();
    this._currentScheduleId = scheduleId;
    this._pollCallback = onMessage;
    this._since = 0;
    this._pollActive = true;
    this._consecutiveErrors = 0;

    // Initialize: set _since to current latest via a no-op call
    this._initPollCursor().then(() => {
      // Emit "connected" so UI knows
      if (this._pollCallback) this._pollCallback({ type: 'connected' });
      this._schedulePoll(0);
    });

    // Pause polling when tab is in background to save battery
    document.addEventListener('visibilitychange', this._onVisibility);
    window.addEventListener('online', this._onOnline);
  },

  async _initPollCursor() {
    try {
      const r = await this._request('changes', {
        query: { since: 0, schedule_id: this._currentScheduleId }
      });
      this._since = r.latest || 0;
    } catch (e) {
      this._since = 0;
    }
  },

  disconnectSSE() {
    this._pollActive = false;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    this._pollCallback = null;
    this._currentScheduleId = null;
    document.removeEventListener('visibilitychange', this._onVisibility);
    window.removeEventListener('online', this._onOnline);
  },

  _onVisibility: () => {
    if (document.hidden) {
      API._pollPaused = true;
    } else {
      API._pollPaused = false;
      // Resume immediately to catch up
      if (API._pollActive) API._schedulePoll(0);
    }
  },

  _onOnline: () => {
    if (API._pollActive) API._schedulePoll(0);
  },

  _schedulePoll(delay) {
    if (!this._pollActive) return;
    if (this._pollTimer) clearTimeout(this._pollTimer);
    this._pollTimer = setTimeout(() => this._poll(), delay);
  },

  async _poll() {
    if (!this._pollActive) return;
    if (this._pollPaused || document.hidden) {
      this._schedulePoll(this._pollInterval * 2);
      return;
    }
    try {
      const r = await this._request('changes', {
        query: { since: this._since, schedule_id: this._currentScheduleId }
      });
      if (typeof r.latest === 'number') this._since = r.latest;
      if (Array.isArray(r.entries) && r.entries.length > 0 && this._pollCallback) {
        for (const entry of r.entries) {
          this._pollCallback({
            type: entry.type,
            data: entry.data,
            scheduleId: entry.schedule_id,
            clientId: entry.client_id,
          });
        }
      }
      this._consecutiveErrors = 0;
      this._schedulePoll(this._pollInterval);
    } catch (e) {
      this._consecutiveErrors++;
      // Exponential backoff on error, capped at 30s
      const delay = Math.min(30000, this._pollInterval * Math.pow(2, this._consecutiveErrors));
      if (this._pollCallback) this._pollCallback({ type: '_error', error: e.message });
      this._schedulePoll(delay);
    }
  },
};
