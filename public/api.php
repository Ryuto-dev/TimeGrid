<?php
/* ═══════════════════════════════════════════════════
   TimeGrid API (PHP Backend)
   File-based JSON storage for collaborative editing
   Compatible with shared hosting (no DB required)
   ═══════════════════════════════════════════════════ */

declare(strict_types=1);

// ── Error handling: never leak HTML; always JSON ──
ini_set('display_errors', '0');
ini_set('log_errors', '1');
error_reporting(E_ALL);

set_exception_handler(function ($e) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => 'Internal error', 'message' => $e->getMessage()]);
    exit;
});

set_error_handler(function ($severity, $message, $file, $line) {
    if (!(error_reporting() & $severity)) return false;
    throw new ErrorException($message, 0, $severity, $file, $line);
});

// ── CORS / JSON headers ──
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-Client-Id');
header('Cache-Control: no-store, no-cache, must-revalidate');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// ── Storage location ──
// Use a "data" sibling directory, OUTSIDE the webroot if possible.
// On cloudfree.jp the structure is public_html/timegrid/ so we place
// data/ one level up from api.php to keep JSON file hidden-ish,
// but fall back to a local data/ if we cannot write there.
$baseDir    = __DIR__;
$dataDirCandidate1 = dirname($baseDir) . '/timegrid_data';
$dataDirCandidate2 = $baseDir . '/data';

function ensureDir(string $dir): bool {
    if (is_dir($dir)) return is_writable($dir);
    if (@mkdir($dir, 0775, true) && is_writable($dir)) return true;
    return false;
}

$DATA_DIR = ensureDir($dataDirCandidate1) ? $dataDirCandidate1 :
            (ensureDir($dataDirCandidate2) ? $dataDirCandidate2 : sys_get_temp_dir() . '/timegrid_data');
ensureDir($DATA_DIR);

$DB_FILE      = $DATA_DIR . '/db.json';
$CHANGES_FILE = $DATA_DIR . '/changes.json';
$LOCK_FILE    = $DATA_DIR . '/db.lock';

// Protect from direct download (htaccess-style protection is also good)
$HTACCESS = $DATA_DIR . '/.htaccess';
if (!file_exists($HTACCESS)) {
    @file_put_contents($HTACCESS, "Require all denied\nDeny from all\n");
}
$INDEXHTML = $DATA_DIR . '/index.html';
if (!file_exists($INDEXHTML)) {
    @file_put_contents($INDEXHTML, '');
}

/* ── DB helpers ─────────────────────────────────── */

function db_load(): array {
    global $DB_FILE;
    $empty = ['schedules' => [], 'places' => [], 'events' => []];
    if (!file_exists($DB_FILE)) return $empty;
    $raw = @file_get_contents($DB_FILE);
    if ($raw === false || $raw === '') return $empty;
    $data = json_decode($raw, true);
    if (!is_array($data)) return $empty;
    foreach (['schedules', 'places', 'events'] as $k) {
        if (!isset($data[$k]) || !is_array($data[$k])) $data[$k] = [];
    }
    return $data;
}

function db_save(array $data): void {
    global $DB_FILE;
    // Use atomic write: write to temp file, then rename
    $tmp = $DB_FILE . '.tmp.' . bin2hex(random_bytes(4));
    // Preserve objects in JSON even when arrays are empty
    $encoded = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    if ($encoded === false) {
        throw new RuntimeException('JSON encoding failed');
    }
    if (@file_put_contents($tmp, $encoded) === false) {
        throw new RuntimeException('Failed to write DB file');
    }
    if (!@rename($tmp, $DB_FILE)) {
        @unlink($tmp);
        throw new RuntimeException('Failed to replace DB file');
    }
    @chmod($DB_FILE, 0664);
}

function with_lock(callable $fn) {
    global $LOCK_FILE;
    $fp = @fopen($LOCK_FILE, 'c');
    if (!$fp) {
        // Fallback: no lock (rare)
        return $fn();
    }
    try {
        @flock($fp, LOCK_EX);
        return $fn();
    } finally {
        @flock($fp, LOCK_UN);
        @fclose($fp);
    }
}

function new_id(): string {
    // UUID v4
    $data = random_bytes(16);
    $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
    $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
}

function now_iso(): string {
    return gmdate('Y-m-d\TH:i:s\Z');
}

/* ── Change log (for polling-based sync) ──────────
   Keeps a capped list of recent change events so that
   other clients can poll /changes?since=<id> and catch up.
─────────────────────────────────────────────────── */

function changes_load(): array {
    global $CHANGES_FILE;
    if (!file_exists($CHANGES_FILE)) return ['next_id' => 1, 'entries' => []];
    $raw = @file_get_contents($CHANGES_FILE);
    $d = json_decode($raw ?: 'null', true);
    if (!is_array($d)) return ['next_id' => 1, 'entries' => []];
    if (!isset($d['next_id'])) $d['next_id'] = 1;
    if (!isset($d['entries']) || !is_array($d['entries'])) $d['entries'] = [];
    return $d;
}

function changes_save(array $d): void {
    global $CHANGES_FILE;
    $tmp = $CHANGES_FILE . '.tmp.' . bin2hex(random_bytes(4));
    $encoded = json_encode($d, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($encoded === false) throw new RuntimeException('JSON encoding failed');
    @file_put_contents($tmp, $encoded);
    @rename($tmp, $CHANGES_FILE);
}

function log_change(string $type, array $data, ?string $scheduleId, string $clientId): int {
    $c = changes_load();
    $id = $c['next_id']++;
    $c['entries'][] = [
        'id'          => $id,
        'type'        => $type,
        'data'        => $data,
        'schedule_id' => $scheduleId,
        'client_id'   => $clientId,
        't'           => now_iso(),
    ];
    // Cap to last 500 entries
    if (count($c['entries']) > 500) {
        $c['entries'] = array_slice($c['entries'], -500);
    }
    changes_save($c);
    return $id;
}

/* ── Input helpers ──────────────────────────────── */

function read_json_body(): array {
    $raw = file_get_contents('php://input');
    if ($raw === '' || $raw === false) return [];
    $d = json_decode($raw, true);
    return is_array($d) ? $d : [];
}

function client_id(): string {
    $cid = $_SERVER['HTTP_X_CLIENT_ID'] ?? '';
    if ($cid === '') $cid = $_GET['clientId'] ?? '';
    if ($cid === '' || !preg_match('/^[A-Za-z0-9_\-]{1,64}$/', $cid)) {
        // Generate a pseudo-id based on remote to at least partition anon clients
        $cid = 'anon_' . substr(hash('sha256', ($_SERVER['REMOTE_ADDR'] ?? '') . ($_SERVER['HTTP_USER_AGENT'] ?? '')), 0, 12);
    }
    return $cid;
}

function json_response($data, int $code = 200) {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function safe_strlen(string $v): int {
    if (function_exists('mb_strlen')) return mb_strlen($v, 'UTF-8');
    return strlen($v);
}
function safe_substr(string $v, int $start, int $len): string {
    if (function_exists('mb_substr')) return mb_substr($v, $start, $len, 'UTF-8');
    return (string)substr($v, $start, $len);
}
function get_str(array $d, string $key, ?string $default = null, int $maxLen = 200): ?string {
    if (!array_key_exists($key, $d)) return $default;
    if ($d[$key] === null) return null;
    $v = (string)$d[$key];
    if (safe_strlen($v) > $maxLen) $v = safe_substr($v, 0, $maxLen);
    return $v;
}

function get_int(array $d, string $key, ?int $default = null): ?int {
    if (!array_key_exists($key, $d) || $d[$key] === null) return $default;
    if (!is_numeric($d[$key])) return $default;
    return (int)$d[$key];
}

function sanitize_color(?string $c, string $default = '#4A90D9'): string {
    if ($c && preg_match('/^#[0-9A-Fa-f]{6}$/', $c)) return $c;
    return $default;
}

/* ── Routing ────────────────────────────────────── */

$action = $_GET['action'] ?? '';
$method = $_SERVER['REQUEST_METHOD'];
$clientId = client_id();

try {
    switch ($action) {
        // ── Schedules ──
        case 'list_schedules':
            handle_list_schedules();
            break;
        case 'create_schedule':
            handle_create_schedule($clientId);
            break;
        case 'get_schedule':
            handle_get_schedule();
            break;
        case 'update_schedule':
            handle_update_schedule($clientId);
            break;
        case 'delete_schedule':
            handle_delete_schedule($clientId);
            break;
        case 'duplicate_schedule':
            handle_duplicate_schedule($clientId);
            break;

        // ── Places ──
        case 'add_place':
            handle_add_place($clientId);
            break;
        case 'update_place':
            handle_update_place($clientId);
            break;
        case 'delete_place':
            handle_delete_place($clientId);
            break;
        case 'reorder_places':
            handle_reorder_places($clientId);
            break;

        // ── Events ──
        case 'add_event':
            handle_add_event($clientId);
            break;
        case 'update_event':
            handle_update_event($clientId);
            break;
        case 'delete_event':
            handle_delete_event($clientId);
            break;

        // ── Changes (polling) ──
        case 'changes':
            handle_changes();
            break;

        // ── Diagnostic ──
        case 'ping':
            json_response(['ok' => true, 'storage' => basename($DATA_DIR), 'time' => now_iso()]);
            break;

        default:
            json_response(['error' => 'Unknown action'], 400);
    }
} catch (Throwable $e) {
    json_response(['error' => $e->getMessage()], 400);
}

/* ── Handlers ───────────────────────────────────── */

function handle_list_schedules(): void {
    $data = db_load();
    $list = array_values($data['schedules']);
    // Also include count info for the list view
    foreach ($list as &$s) {
        $sid = $s['id'];
        $eventCount = 0;
        foreach ($data['events'] as $e) {
            if ($e['schedule_id'] === $sid) $eventCount++;
        }
        $placeCount = 0;
        foreach ($data['places'] as $p) {
            if ($p['schedule_id'] === $sid) $placeCount++;
        }
        $s['event_count'] = $eventCount;
        $s['place_count'] = $placeCount;
    }
    unset($s);
    usort($list, fn($a, $b) => strcmp($b['updated_at'] ?? '', $a['updated_at'] ?? ''));
    json_response($list);
}

function handle_create_schedule(string $clientId): void {
    $body = read_json_body();
    $name = get_str($body, 'name', '新しいスケジュール', 120);

    with_lock(function () use ($name, $clientId) {
        $data = db_load();
        $id = new_id();
        $now = now_iso();

        $data['schedules'][$id] = [
            'id'           => $id,
            'name'         => $name,
            'start_hour'   => 6,
            'start_minute' => 0,
            'end_hour'     => 22,
            'end_minute'   => 0,
            'created_at'   => $now,
            'updated_at'   => $now,
        ];

        $defaults = [
            ['name' => 'Stage A', 'color' => '#4A90D9'],
            ['name' => 'Stage B', 'color' => '#E8913A'],
            ['name' => 'Stage C', 'color' => '#50B83C'],
        ];
        foreach ($defaults as $i => $p) {
            $pid = new_id();
            $data['places'][$pid] = [
                'id'          => $pid,
                'schedule_id' => $id,
                'name'        => $p['name'],
                'sort_order'  => $i,
                'color'       => $p['color'],
                'created_at'  => $now,
            ];
        }

        db_save($data);
        log_change('schedule_created', $data['schedules'][$id], $id, $clientId);

        json_response(schedule_full($id, $data));
    });
}

function schedule_full(string $id, array $data): ?array {
    if (!isset($data['schedules'][$id])) return null;
    $s = $data['schedules'][$id];
    $s['places'] = array_values(array_filter($data['places'], fn($p) => $p['schedule_id'] === $id));
    usort($s['places'], fn($a, $b) => ($a['sort_order'] ?? 0) - ($b['sort_order'] ?? 0));
    $s['events'] = array_values(array_filter($data['events'], fn($e) => $e['schedule_id'] === $id));
    foreach ($s['events'] as &$e) {
        if (!isset($e['place_ids']) || !is_array($e['place_ids'])) $e['place_ids'] = [];
    }
    unset($e);
    return $s;
}

function handle_get_schedule(): void {
    $id = $_GET['id'] ?? '';
    if ($id === '') json_response(['error' => 'Missing id'], 400);
    $data = db_load();
    $s = schedule_full($id, $data);
    if (!$s) json_response(['error' => 'Not found'], 404);
    json_response($s);
}

function handle_update_schedule(string $clientId): void {
    $id = $_GET['id'] ?? '';
    $body = read_json_body();
    if ($id === '') json_response(['error' => 'Missing id'], 400);

    with_lock(function () use ($id, $body, $clientId) {
        $data = db_load();
        if (!isset($data['schedules'][$id])) json_response(['error' => 'Not found'], 404);

        foreach (['name'] as $k) {
            $v = get_str($body, $k, null, 200);
            if ($v !== null) $data['schedules'][$id][$k] = $v;
        }
        foreach (['start_hour', 'start_minute', 'end_hour', 'end_minute'] as $k) {
            $v = get_int($body, $k, null);
            if ($v !== null) $data['schedules'][$id][$k] = $v;
        }
        $data['schedules'][$id]['updated_at'] = now_iso();
        db_save($data);
        log_change('schedule_updated', $data['schedules'][$id], $id, $clientId);

        json_response(schedule_full($id, $data));
    });
}

function handle_delete_schedule(string $clientId): void {
    $id = $_GET['id'] ?? '';
    if ($id === '') json_response(['error' => 'Missing id'], 400);

    with_lock(function () use ($id, $clientId) {
        $data = db_load();
        if (!isset($data['schedules'][$id])) json_response(['success' => true]);
        unset($data['schedules'][$id]);
        foreach ($data['places'] as $pid => $p) {
            if ($p['schedule_id'] === $id) unset($data['places'][$pid]);
        }
        foreach ($data['events'] as $eid => $e) {
            if ($e['schedule_id'] === $id) unset($data['events'][$eid]);
        }
        db_save($data);
        log_change('schedule_deleted', ['id' => $id], $id, $clientId);
        json_response(['success' => true]);
    });
}

function handle_duplicate_schedule(string $clientId): void {
    $id = $_GET['id'] ?? '';
    if ($id === '') json_response(['error' => 'Missing id'], 400);

    with_lock(function () use ($id, $clientId) {
        $data = db_load();
        if (!isset($data['schedules'][$id])) json_response(['error' => 'Not found'], 404);
        $orig = $data['schedules'][$id];
        $newId = new_id();
        $now = now_iso();
        $data['schedules'][$newId] = array_merge($orig, [
            'id' => $newId,
            'name' => $orig['name'] . ' (Copy)',
            'created_at' => $now,
            'updated_at' => $now,
        ]);
        $placeMap = [];
        $origPlaces = array_filter($data['places'], fn($p) => $p['schedule_id'] === $id);
        foreach ($origPlaces as $p) {
            $newPid = new_id();
            $placeMap[$p['id']] = $newPid;
            $data['places'][$newPid] = array_merge($p, [
                'id' => $newPid,
                'schedule_id' => $newId,
                'created_at' => $now,
            ]);
        }
        $origEvents = array_filter($data['events'], fn($e) => $e['schedule_id'] === $id);
        foreach ($origEvents as $e) {
            $newEid = new_id();
            $newPlaceIds = [];
            foreach (($e['place_ids'] ?? []) as $oldPid) {
                if (isset($placeMap[$oldPid])) $newPlaceIds[] = $placeMap[$oldPid];
            }
            $data['events'][$newEid] = array_merge($e, [
                'id' => $newEid,
                'schedule_id' => $newId,
                'place_ids' => $newPlaceIds,
                'created_at' => $now,
                'updated_at' => $now,
            ]);
        }
        db_save($data);
        log_change('schedule_created', $data['schedules'][$newId], $newId, $clientId);
        json_response(schedule_full($newId, $data));
    });
}

function handle_add_place(string $clientId): void {
    $body = read_json_body();
    $schedId = get_str($body, 'schedule_id', null, 64);
    $name = get_str($body, 'name', '新しい場所', 120);
    $color = sanitize_color(get_str($body, 'color', '#4A90D9', 7));
    if (!$schedId) json_response(['error' => 'Missing schedule_id'], 400);

    with_lock(function () use ($schedId, $name, $color, $clientId) {
        $data = db_load();
        if (!isset($data['schedules'][$schedId])) json_response(['error' => 'Schedule not found'], 404);
        $maxOrder = -1;
        foreach ($data['places'] as $p) {
            if ($p['schedule_id'] === $schedId) $maxOrder = max($maxOrder, (int)($p['sort_order'] ?? 0));
        }
        $pid = new_id();
        $data['places'][$pid] = [
            'id' => $pid,
            'schedule_id' => $schedId,
            'name' => $name,
            'sort_order' => $maxOrder + 1,
            'color' => $color,
            'created_at' => now_iso(),
        ];
        $data['schedules'][$schedId]['updated_at'] = now_iso();
        db_save($data);
        log_change('place_added', $data['places'][$pid], $schedId, $clientId);
        json_response($data['places'][$pid]);
    });
}

function handle_update_place(string $clientId): void {
    $id = $_GET['id'] ?? '';
    $body = read_json_body();
    if ($id === '') json_response(['error' => 'Missing id'], 400);

    with_lock(function () use ($id, $body, $clientId) {
        $data = db_load();
        if (!isset($data['places'][$id])) json_response(['error' => 'Not found'], 404);
        $name = get_str($body, 'name', null, 120);
        if ($name !== null) $data['places'][$id]['name'] = $name;
        if (isset($body['color'])) $data['places'][$id]['color'] = sanitize_color((string)$body['color']);
        $so = get_int($body, 'sort_order', null);
        if ($so !== null) $data['places'][$id]['sort_order'] = $so;
        $schedId = $data['places'][$id]['schedule_id'];
        if (isset($data['schedules'][$schedId])) $data['schedules'][$schedId]['updated_at'] = now_iso();
        db_save($data);
        log_change('place_updated', $data['places'][$id], $schedId, $clientId);
        json_response($data['places'][$id]);
    });
}

function handle_delete_place(string $clientId): void {
    $id = $_GET['id'] ?? '';
    if ($id === '') json_response(['error' => 'Missing id'], 400);

    with_lock(function () use ($id, $clientId) {
        $data = db_load();
        if (!isset($data['places'][$id])) json_response(['success' => true]);
        $schedId = $data['places'][$id]['schedule_id'];
        unset($data['places'][$id]);
        foreach ($data['events'] as &$e) {
            if ($e['schedule_id'] === $schedId && isset($e['place_ids'])) {
                $e['place_ids'] = array_values(array_filter($e['place_ids'], fn($pid) => $pid !== $id));
            }
        }
        unset($e);
        if (isset($data['schedules'][$schedId])) $data['schedules'][$schedId]['updated_at'] = now_iso();
        db_save($data);
        log_change('place_deleted', ['id' => $id], $schedId, $clientId);
        json_response(['success' => true]);
    });
}

function handle_reorder_places(string $clientId): void {
    $body = read_json_body();
    $schedId = get_str($body, 'schedule_id', null, 64);
    $placeIds = isset($body['place_ids']) && is_array($body['place_ids']) ? $body['place_ids'] : null;
    if (!$schedId || !$placeIds) json_response(['error' => 'Missing params'], 400);

    with_lock(function () use ($schedId, $placeIds, $clientId) {
        $data = db_load();
        foreach ($placeIds as $i => $pid) {
            if (isset($data['places'][$pid])) $data['places'][$pid]['sort_order'] = $i;
        }
        if (isset($data['schedules'][$schedId])) $data['schedules'][$schedId]['updated_at'] = now_iso();
        db_save($data);
        $updated = array_values(array_filter($data['places'], fn($p) => $p['schedule_id'] === $schedId));
        usort($updated, fn($a, $b) => ($a['sort_order'] ?? 0) - ($b['sort_order'] ?? 0));
        log_change('places_reordered', $updated, $schedId, $clientId);
        json_response($updated);
    });
}

function handle_add_event(string $clientId): void {
    $body = read_json_body();
    $schedId = get_str($body, 'schedule_id', null, 64);
    if (!$schedId) json_response(['error' => 'Missing schedule_id'], 400);

    with_lock(function () use ($schedId, $body, $clientId) {
        $data = db_load();
        if (!isset($data['schedules'][$schedId])) json_response(['error' => 'Schedule not found'], 404);
        $eid = new_id();
        $now = now_iso();
        $type = get_str($body, 'event_type', 'range', 16);
        $placeIds = [];
        if (isset($body['place_ids']) && is_array($body['place_ids'])) {
            foreach ($body['place_ids'] as $pid) {
                if (is_string($pid) && isset($data['places'][$pid]) && $data['places'][$pid]['schedule_id'] === $schedId) {
                    $placeIds[] = $pid;
                }
            }
        }
        $ev = [
            'id' => $eid,
            'schedule_id' => $schedId,
            'title' => get_str($body, 'title', 'New Event', 200) ?? 'New Event',
            'description' => get_str($body, 'description', '', 2000) ?? '',
            'event_type' => ($type === 'task' ? 'task' : 'range'),
            'start_hour' => get_int($body, 'start_hour', 9),
            'start_minute' => get_int($body, 'start_minute', 0),
            'end_hour' => ($type === 'task') ? null : get_int($body, 'end_hour', 10),
            'end_minute' => ($type === 'task') ? null : get_int($body, 'end_minute', 0),
            'color' => sanitize_color(get_str($body, 'color', '#4A90D9', 7)),
            'text_color' => sanitize_color(get_str($body, 'text_color', '#FFFFFF', 7), '#FFFFFF'),
            'icon' => get_str($body, 'icon', '', 64) ?? '',
            'place_ids' => $placeIds,
            'notes_column' => get_str($body, 'notes_column', '', 500) ?? '',
            'created_at' => $now,
            'updated_at' => $now,
        ];
        $data['events'][$eid] = $ev;
        $data['schedules'][$schedId]['updated_at'] = $now;
        db_save($data);
        log_change('event_added', $ev, $schedId, $clientId);
        json_response($ev);
    });
}

function handle_update_event(string $clientId): void {
    $id = $_GET['id'] ?? '';
    $body = read_json_body();
    if ($id === '') json_response(['error' => 'Missing id'], 400);

    with_lock(function () use ($id, $body, $clientId) {
        $data = db_load();
        if (!isset($data['events'][$id])) json_response(['error' => 'Not found'], 404);
        $e = &$data['events'][$id];
        $schedId = $e['schedule_id'];

        foreach (['title' => 200, 'description' => 2000, 'notes_column' => 500, 'icon' => 64] as $k => $max) {
            $v = get_str($body, $k, null, $max);
            if ($v !== null) $e[$k] = $v;
        }
        if (array_key_exists('event_type', $body)) {
            $e['event_type'] = ($body['event_type'] === 'task') ? 'task' : 'range';
        }
        foreach (['start_hour', 'start_minute', 'end_hour', 'end_minute'] as $k) {
            if (array_key_exists($k, $body)) {
                $e[$k] = ($body[$k] === null) ? null : (int)$body[$k];
            }
        }
        if ($e['event_type'] === 'task') {
            $e['end_hour'] = null;
            $e['end_minute'] = null;
        }
        if (isset($body['color'])) $e['color'] = sanitize_color((string)$body['color']);
        if (isset($body['text_color'])) $e['text_color'] = sanitize_color((string)$body['text_color'], '#FFFFFF');
        if (isset($body['place_ids']) && is_array($body['place_ids'])) {
            $e['place_ids'] = [];
            foreach ($body['place_ids'] as $pid) {
                if (is_string($pid) && isset($data['places'][$pid]) && $data['places'][$pid]['schedule_id'] === $schedId) {
                    $e['place_ids'][] = $pid;
                }
            }
        }
        $e['updated_at'] = now_iso();
        if (isset($data['schedules'][$schedId])) $data['schedules'][$schedId]['updated_at'] = $e['updated_at'];
        $saved = $e;
        unset($e);
        db_save($data);
        log_change('event_updated', $saved, $schedId, $clientId);
        json_response($saved);
    });
}

function handle_delete_event(string $clientId): void {
    $id = $_GET['id'] ?? '';
    if ($id === '') json_response(['error' => 'Missing id'], 400);

    with_lock(function () use ($id, $clientId) {
        $data = db_load();
        if (!isset($data['events'][$id])) json_response(['success' => true]);
        $schedId = $data['events'][$id]['schedule_id'];
        unset($data['events'][$id]);
        if (isset($data['schedules'][$schedId])) $data['schedules'][$schedId]['updated_at'] = now_iso();
        db_save($data);
        log_change('event_deleted', ['id' => $id], $schedId, $clientId);
        json_response(['success' => true]);
    });
}

function handle_changes(): void {
    $since = (int)($_GET['since'] ?? 0);
    $schedId = $_GET['schedule_id'] ?? '';
    $clientId = client_id();
    $c = changes_load();

    // If "since" is very old or 0, reset to latest to avoid huge payloads
    $latestId = $c['next_id'] - 1;
    if ($since === 0) {
        json_response(['latest' => $latestId, 'entries' => []]);
    }

    $out = [];
    foreach ($c['entries'] as $entry) {
        if ($entry['id'] <= $since) continue;
        if ($schedId !== '' && $entry['schedule_id'] !== $schedId && $entry['schedule_id'] !== null) continue;
        if ($entry['client_id'] === $clientId) continue; // skip own changes
        $out[] = $entry;
    }
    json_response(['latest' => $latestId, 'entries' => $out]);
}
