/* ═══════════════════════════════════════════════════
   API Client (localStorage Version)
   ═══════════════════════════════════════════════════ */

const API = {
  clientId: 'client_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36),
  _storageKey: 'timegrid_db',

  // ── Storage Helpers ──
  _getData() {
    const data = localStorage.getItem(this._storageKey);
    if (!data) {
      return { schedules: {}, places: {}, events: {} };
    }
    return JSON.parse(data);
  },

  _saveData(data) {
    localStorage.setItem(this._storageKey, JSON.stringify(data));
    // Trigger storage event for same-window listeners if needed,
    // though 'storage' event only fires for OTHER windows.
  },

  _generateId() {
    return crypto.randomUUID();
  },

  // ── Schedules ──
  async listSchedules() {
    const data = this._getData();
    return Object.values(data.schedules).sort((a, b) =>
      new Date(b.updated_at) - new Date(a.updated_at)
    );
  },

  async createSchedule(name = '新しいスケジュール') {
    const data = this._getData();
    const id = this._generateId();
    const now = new Date().toISOString();

    const newSchedule = {
      id,
      name,
      start_hour: 6,
      start_minute: 0,
      end_hour: 22,
      end_minute: 0,
      created_at: now,
      updated_at: now
    };

    data.schedules[id] = newSchedule;

    // Default places
    const defaultPlaces = [
      { name: 'Stage A', color: '#4A90D9' },
      { name: 'Stage B', color: '#E8913A' },
      { name: 'Stage C', color: '#50B83C' }
    ];

    defaultPlaces.forEach((p, i) => {
      const pid = this._generateId();
      data.places[pid] = {
        id: pid,
        schedule_id: id,
        name: p.name,
        sort_order: i,
        color: p.color,
        created_at: now
      };
    });

    this._saveData(data);
    return this.getSchedule(id);
  },

  async getSchedule(id) {
    const data = this._getData();
    const schedule = data.schedules[id];
    if (!schedule) return null;

    const result = { ...schedule };
    result.places = Object.values(data.places)
      .filter(p => p.schedule_id === id)
      .sort((a, b) => a.sort_order - b.sort_order);

    result.events = Object.values(data.events)
      .filter(e => e.schedule_id === id)
      .map(e => ({ ...e, place_ids: e.place_ids || [] }));

    return result;
  },

  async updateSchedule(id, updates) {
    const data = this._getData();
    if (!data.schedules[id]) throw new Error('Schedule not found');

    const allowed = ['name', 'start_hour', 'start_minute', 'end_hour', 'end_minute'];
    allowed.forEach(key => {
      if (updates[key] !== undefined) data.schedules[id][key] = updates[key];
    });

    data.schedules[id].updated_at = new Date().toISOString();
    this._saveData(data);
    this._notify('schedule_updated', data.schedules[id], id);
    return this.getSchedule(id);
  },

  async deleteSchedule(id) {
    const data = this._getData();
    delete data.schedules[id];

    // Cascade delete
    Object.keys(data.places).forEach(pid => {
      if (data.places[pid].schedule_id === id) delete data.places[pid];
    });
    Object.keys(data.events).forEach(eid => {
      if (data.events[eid].schedule_id === id) delete data.events[eid];
    });

    this._saveData(data);
    return { success: true };
  },

  async duplicateSchedule(id) {
    const original = await this.getSchedule(id);
    if (!original) throw new Error('Not found');

    const newSched = await this.createSchedule(original.name + ' (Copy)');

    // createSchedule adds default places, we want to replace them with original's places
    const data = this._getData();
    // Remove the default places created by createSchedule
    Object.keys(data.places).forEach(pid => {
      if (data.places[pid].schedule_id === newSched.id) delete data.places[pid];
    });

    const placeMap = {};
    original.places.forEach(p => {
      const pid = this._generateId();
      placeMap[p.id] = pid;
      data.places[pid] = {
        ...p,
        id: pid,
        schedule_id: newSched.id,
        created_at: new Date().toISOString()
      };
    });

    original.events.forEach(e => {
      const eid = this._generateId();
      data.events[eid] = {
        ...e,
        id: eid,
        schedule_id: newSched.id,
        place_ids: e.place_ids.map(pid => placeMap[pid] || pid),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
    });

    // Copy settings
    data.schedules[newSched.id].start_hour = original.start_hour;
    data.schedules[newSched.id].start_minute = original.start_minute;
    data.schedules[newSched.id].end_hour = original.end_hour;
    data.schedules[newSched.id].end_minute = original.end_minute;

    this._saveData(data);
    return this.getSchedule(newSched.id);
  },

  // ── Places ──
  async addPlace(schedId, name, color = '#4A90D9') {
    const data = this._getData();
    const id = this._generateId();

    const siblingPlaces = Object.values(data.places).filter(p => p.schedule_id === schedId);
    const maxOrder = siblingPlaces.reduce((max, p) => Math.max(max, p.sort_order), -1);

    const newPlace = {
      id,
      schedule_id: schedId,
      name,
      sort_order: maxOrder + 1,
      color,
      created_at: new Date().toISOString()
    };

    data.places[id] = newPlace;
    this._saveData(data);
    this._notify('place_added', newPlace, schedId);
    return newPlace;
  },

  async updatePlace(id, updates) {
    const data = this._getData();
    if (!data.places[id]) throw new Error('Place not found');

    const allowed = ['name', 'sort_order', 'color'];
    allowed.forEach(key => {
      if (updates[key] !== undefined) data.places[id][key] = updates[key];
    });

    this._saveData(data);
    this._notify('place_updated', data.places[id], data.places[id].schedule_id);
    return data.places[id];
  },

  async deletePlace(id) {
    const data = this._getData();
    const place = data.places[id];
    if (!place) return { success: true };

    const schedId = place.schedule_id;
    delete data.places[id];

    // Clean up place_ids in events
    Object.values(data.events).forEach(e => {
      if (e.schedule_id === schedId) {
        e.place_ids = e.place_ids.filter(pid => pid !== id);
      }
    });

    this._saveData(data);
    this._notify('place_deleted', { id }, schedId);
    return { success: true };
  },

  async reorderPlaces(schedId, placeIds) {
    const data = this._getData();
    placeIds.forEach((id, index) => {
      if (data.places[id]) data.places[id].sort_order = index;
    });
    this._saveData(data);

    const updatedPlaces = Object.values(data.places)
      .filter(p => p.schedule_id === schedId)
      .sort((a, b) => a.sort_order - b.sort_order);

    this._notify('places_reordered', updatedPlaces, schedId);
    return updatedPlaces;
  },

  // ── Events ──
  async addEvent(schedId, eventData) {
    const data = this._getData();
    const id = this._generateId();
    const now = new Date().toISOString();

    const newEvent = {
      id,
      schedule_id: schedId,
      title: eventData.title || 'New Event',
      description: eventData.description || '',
      event_type: eventData.event_type || 'range',
      start_hour: eventData.start_hour ?? 9,
      start_minute: eventData.start_minute ?? 0,
      end_hour: eventData.event_type === 'task' ? null : (eventData.end_hour ?? 10),
      end_minute: eventData.event_type === 'task' ? null : (eventData.end_minute ?? 0),
      color: eventData.color || '#4A90D9',
      text_color: eventData.text_color || '#FFFFFF',
      icon: eventData.icon || '',
      place_ids: eventData.place_ids || [],
      notes_column: eventData.notes_column || '',
      created_at: now,
      updated_at: now
    };

    data.events[id] = newEvent;
    this._saveData(data);
    this._notify('event_added', newEvent, schedId);
    return newEvent;
  },

  async updateEvent(id, updates) {
    const data = this._getData();
    if (!data.events[id]) throw new Error('Event not found');

    const allowed = ['title', 'description', 'event_type', 'start_hour', 'start_minute',
      'end_hour', 'end_minute', 'color', 'text_color', 'icon', 'notes_column', 'place_ids'];

    allowed.forEach(key => {
      if (updates[key] !== undefined) data.events[id][key] = updates[key];
    });

    data.events[id].updated_at = new Date().toISOString();
    this._saveData(data);
    this._notify('event_updated', data.events[id], data.events[id].schedule_id);
    return data.events[id];
  },

  async deleteEvent(id) {
    const data = this._getData();
    const event = data.events[id];
    if (!event) return { success: true };

    const schedId = event.schedule_id;
    delete data.events[id];
    this._saveData(data);
    this._notify('event_deleted', { id }, schedId);
    return { success: true };
  },

  // ── SSE Mock ──
  _sseCallback: null,
  _currentScheduleId: null,

  connectSSE(scheduleId, onMessage) {
    this._currentScheduleId = scheduleId;
    this._sseCallback = onMessage;

    // Real-time sync across tabs using 'storage' event
    window.addEventListener('storage', this._handleStorageChange.bind(this));

    // Initial connected message
    setTimeout(() => {
      onMessage({ type: 'connected', latestChangeId: 0 });
    }, 10);
  },

  disconnectSSE() {
    window.removeEventListener('storage', this._handleStorageChange.bind(this));
    this._sseCallback = null;
    this._currentScheduleId = null;
  },

  _handleStorageChange(e) {
    if (e.key !== this._storageKey || !e.newValue) return;
    // The storage event doesn't tell us WHAT changed easily without comparing.
    // However, our _notify sends a custom event for the current window.
  },

  _notify(type, data, scheduleId) {
    const payload = { type, data, scheduleId, _clientId: this.clientId };

    // Notify other tabs
    localStorage.setItem('timegrid_notify', JSON.stringify({ ...payload, _t: Date.now() }));

    // Notify current tab (if it's the right schedule)
    if (this._sseCallback && this._currentScheduleId === scheduleId) {
      this._sseCallback(payload);
    }
  }
};

// Listener for cross-tab notifications
window.addEventListener('storage', (e) => {
  if (e.key === 'timegrid_notify' && e.newValue) {
    const payload = JSON.parse(e.newValue);
    if (payload._clientId !== API.clientId && API._sseCallback && API._currentScheduleId === payload.scheduleId) {
      API._sseCallback(payload);
    }
  }
});
