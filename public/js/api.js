/* ═══════════════════════════════════════════════════
   API Client & Real-time Sync
   ═══════════════════════════════════════════════════ */

const API = {
  clientId: 'client_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36),
  eventSource: null,

  async request(method, url, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (body) {
      body._clientId = this.clientId;
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(err.error || 'Request failed');
    }
    return res.json();
  },

  // Schedules
  listSchedules()       { return this.request('GET', 'api/schedules'); },
  createSchedule(name)  { return this.request('POST', 'api/schedules', { name }); },
  getSchedule(id)       { return this.request('GET', `api/schedules/${id}`); },
  updateSchedule(id, d) { return this.request('PUT', `api/schedules/${id}`, d); },
  deleteSchedule(id)    { return this.request('DELETE', `api/schedules/${id}`); },
  duplicateSchedule(id) { return this.request('POST', `api/schedules/${id}/duplicate`); },

  // Places
  addPlace(schedId, name, color) {
    return this.request('POST', `api/schedules/${schedId}/places`, { name, color });
  },
  updatePlace(id, data) { return this.request('PUT', `api/places/${id}`, data); },
  deletePlace(id)       { return this.request('DELETE', `api/places/${id}?clientId=${this.clientId}`); },
  reorderPlaces(schedId, placeIds) {
    return this.request('PUT', `api/schedules/${schedId}/places/reorder`, { placeIds });
  },

  // Events
  addEvent(schedId, data) {
    return this.request('POST', `api/schedules/${schedId}/events`, data);
  },
  updateEvent(id, data)  { return this.request('PUT', `api/events/${id}`, data); },
  deleteEvent(id)        { return this.request('DELETE', `api/events/${id}?clientId=${this.clientId}`); },

  // SSE
  connectSSE(scheduleId, onMessage) {
    this.disconnectSSE();
    const url = `api/schedules/${scheduleId}/stream?clientId=${this.clientId}`;
    this.eventSource = new EventSource(url);
    this.eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        onMessage(data);
      } catch (err) {
        console.warn('SSE parse error', err);
      }
    };
    this.eventSource.onerror = () => {
      console.warn('SSE connection error, will retry...');
    };
  },

  disconnectSSE() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }
};
