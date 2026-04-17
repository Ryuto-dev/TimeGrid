const express = require('express');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ── SSE clients management ──
const sseClients = new Map(); // scheduleId -> Set of { res, clientId }

function broadcastChange(scheduleId, change, excludeClientId) {
  const clients = sseClients.get(scheduleId);
  if (!clients) return;
  const data = JSON.stringify(change);
  for (const client of clients) {
    if (client.clientId !== excludeClientId) {
      client.res.write(`data: ${data}\n\n`);
    }
  }
}

// ── API Router ──
const apiRouter = express.Router();

// ── SSE endpoint ──
apiRouter.get('/schedules/:id/stream', (req, res) => {
  const scheduleId = req.params.id;
  const clientId = req.query.clientId;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  // Send current latest change id
  const latestId = db.getLatestChangeId(scheduleId);
  res.write(`data: ${JSON.stringify({ type: 'connected', latestChangeId: latestId })}\n\n`);

  const client = { res, clientId };
  if (!sseClients.has(scheduleId)) {
    sseClients.set(scheduleId, new Set());
  }
  sseClients.get(scheduleId).add(client);

  // Heartbeat every 15s
  const heartbeat = setInterval(() => {
    res.write(`: heartbeat\n\n`);
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const clients = sseClients.get(scheduleId);
    if (clients) {
      clients.delete(client);
      if (clients.size === 0) sseClients.delete(scheduleId);
    }
  });
});

// ── Schedule endpoints ──

apiRouter.get('/schedules', (req, res) => {
  try {
    const schedules = db.listSchedules();
    res.json(schedules);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/schedules', (req, res) => {
  try {
    const schedule = db.createSchedule(req.body.name);
    res.json(schedule);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get('/schedules/:id', (req, res) => {
  try {
    const schedule = db.getSchedule(req.params.id);
    if (!schedule) return res.status(404).json({ error: 'Not found' });
    schedule.latestChangeId = db.getLatestChangeId(req.params.id);
    res.json(schedule);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.put('/schedules/:id', (req, res) => {
  try {
    const schedule = db.updateSchedule(req.params.id, req.body);
    const clientId = req.body._clientId;
    const change = { type: 'schedule_updated', data: schedule };
    db.logChange(req.params.id, 'update', 'schedule', req.params.id, schedule, clientId);
    broadcastChange(req.params.id, change, clientId);
    res.json(schedule);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.delete('/schedules/:id', (req, res) => {
  try {
    db.deleteSchedule(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Place endpoints ──

apiRouter.post('/schedules/:id/places', (req, res) => {
  try {
    const place = db.addPlace(req.params.id, req.body.name, req.body.color);
    const clientId = req.body._clientId;
    const change = { type: 'place_added', data: place };
    db.logChange(req.params.id, 'add', 'place', place.id, place, clientId);
    broadcastChange(req.params.id, change, clientId);
    res.json(place);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.put('/places/:id', (req, res) => {
  try {
    const place = db.updatePlace(req.params.id, req.body);
    const clientId = req.body._clientId;
    if (place) {
      const change = { type: 'place_updated', data: place };
      db.logChange(place.schedule_id, 'update', 'place', place.id, place, clientId);
      broadcastChange(place.schedule_id, change, clientId);
    }
    res.json(place);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.delete('/places/:id', (req, res) => {
  try {
    const clientId = req.query.clientId;
    // Get place before deleting to know schedule_id
    const d = db.getDb();
    const place = d.prepare('SELECT * FROM places WHERE id = ?').get(req.params.id);
    db.deletePlace(req.params.id);
    if (place) {
      const change = { type: 'place_deleted', data: { id: req.params.id } };
      db.logChange(place.schedule_id, 'delete', 'place', req.params.id, {}, clientId);
      broadcastChange(place.schedule_id, change, clientId);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.put('/schedules/:id/places/reorder', (req, res) => {
  try {
    const places = db.reorderPlaces(req.params.id, req.body.placeIds);
    const clientId = req.body._clientId;
    const change = { type: 'places_reordered', data: places };
    db.logChange(req.params.id, 'reorder', 'places', req.params.id, places, clientId);
    broadcastChange(req.params.id, change, clientId);
    res.json(places);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Event endpoints ──

apiRouter.post('/schedules/:id/events', (req, res) => {
  try {
    const event = db.addEvent(req.params.id, req.body);
    const clientId = req.body._clientId;
    const change = { type: 'event_added', data: event };
    db.logChange(req.params.id, 'add', 'event', event.id, event, clientId);
    broadcastChange(req.params.id, change, clientId);
    res.json(event);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.put('/events/:id', (req, res) => {
  try {
    const event = db.updateEvent(req.params.id, req.body);
    const clientId = req.body._clientId;
    if (event) {
      const change = { type: 'event_updated', data: event };
      db.logChange(event.schedule_id, 'update', 'event', event.id, event, clientId);
      broadcastChange(event.schedule_id, change, clientId);
    }
    res.json(event);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.delete('/events/:id', (req, res) => {
  try {
    const clientId = req.query.clientId;
    const d = db.getDb();
    const event = d.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    db.deleteEvent(req.params.id);
    if (event) {
      const change = { type: 'event_deleted', data: { id: req.params.id } };
      db.logChange(event.schedule_id, 'delete', 'event', req.params.id, {}, clientId);
      broadcastChange(event.schedule_id, change, clientId);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Poll endpoint for changes ──
apiRouter.get('/schedules/:id/changes', (req, res) => {
  try {
    const sinceId = parseInt(req.query.since) || 0;
    const changes = db.getChangesSince(req.params.id, sinceId);
    res.json(changes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Duplicate schedule ──
apiRouter.post('/schedules/:id/duplicate', (req, res) => {
  try {
    const original = db.getSchedule(req.params.id);
    if (!original) return res.status(404).json({ error: 'Not found' });
    const newSchedule = db.createSchedule(original.name + ' (Copy)');
    // Delete default places
    for (const p of newSchedule.places) {
      db.deletePlace(p.id);
    }
    // Copy places
    const placeMap = {};
    for (const p of original.places) {
      const np = db.addPlace(newSchedule.id, p.name, p.color);
      placeMap[p.id] = np.id;
    }
    // Copy events
    for (const e of original.events) {
      db.addEvent(newSchedule.id, {
        ...e,
        place_ids: e.place_ids.map(pid => placeMap[pid] || pid)
      });
    }
    // Update time range
    db.updateSchedule(newSchedule.id, {
      start_hour: original.start_hour,
      start_minute: original.start_minute,
      end_hour: original.end_hour,
      end_minute: original.end_minute
    });
    const result = db.getSchedule(newSchedule.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Export schedule as JSON ──
apiRouter.get('/schedules/:id/export', (req, res) => {
  try {
    const schedule = db.getSchedule(req.params.id);
    if (!schedule) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Content-Disposition', `attachment; filename="${schedule.name}.json"`);
    res.json(schedule);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mount the API router
app.use(['/api', '/timegrid/api'], apiRouter);

// Static files
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/timegrid', express.static(path.join(__dirname, '..', 'public')));

// ── Fallback ──
app.get(['/', '/index.html', '/timegrid', '/timegrid/index.html'], (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Schedule app running on http://0.0.0.0:${PORT}`);
});
