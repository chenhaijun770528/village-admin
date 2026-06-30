// cloud_db.js - Supabase 云数据库版（localStorage优先，云端后台同步）
// service_role key 有完全读写权限
(function() {
  var SUPABASE_URL = 'https://eivqbbxyllsorbvgqsju.supabase.co';
  var SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVpdnFiYnh5bGxzb3Jidmdxc2p1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MjcxMjMwOSwiZXhwIjoyMDk4Mjg4MzA5fQ.druJ-whOvHcA5fGrTaEvzRChB3sV4WRMf6cWR3Ru3fw';
  var TABLE = 'village_data';
  var ROW_ID = 'init';
  var SCHEMA = 'public';

  var _cloudSyncing = false;
  var _localPending = false;

  function makeHeaders(extra) {
    var h = {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Accept-Profile': SCHEMA,
      'Content-Profile': SCHEMA
    };
    if (extra) Object.keys(extra).forEach(function(k) { h[k] = extra[k]; });
    return h;
  }

  function fetchJSON(url, opts) {
    return fetch(url, opts).then(function(r) {
      if (!r.ok) return r.text().then(function(t) { throw new Error('HTTP ' + r.status + ': ' + t.substring(0, 100)); });
      return r.json().catch(function() { return null; });
    }).catch(function(e) { throw e; });
  }

  // 保存全部数据到云端（后台执行，不阻塞）
  function syncToCloud(callback) {
    if (_cloudSyncing) { _localPending = true; if (callback) callback(false, 'busy'); return; }
    _cloudSyncing = true;
    var allData = {};
    var keys = ['accounts', 'registrations', 'villages', 'products', 'food', 'camps', 'messages'];
    keys.forEach(function(key) {
      try { allData[key] = JSON.parse(localStorage.getItem('village_' + key) || '[]'); }
      catch(e) { allData[key] = []; }
    });
    fetchJSON(SUPABASE_URL + '/rest/v1/' + TABLE + '?id=eq.' + ROW_ID + '&select=data', {
      headers: makeHeaders({ 'Accept': 'application/json' })
    }).then(function(arr) {
      var sha = arr && arr[0] && arr[0].data ? arr[0] : null;
      var body = JSON.stringify({ id: ROW_ID, data: allData });
      return fetch(SUPABASE_URL + '/rest/v1/' + TABLE, {
        method: 'POST',
        headers: makeHeaders({ 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' }),
        body: body
      }).then(function(r) {
        if (r.ok) { console.log('[CloudDB] 云端同步成功'); if (callback) callback(true); }
        else { console.warn('[CloudDB] 云端同步失败:', r.status); if (callback) callback(false); }
        _cloudSyncing = false;
        if (_localPending) { _localPending = false; syncToCloud(); }
      });
    }).catch(function(e) {
      console.warn('[CloudDB] 云端同步失败:', e.message);
      if (callback) callback(false, e.message);
      _cloudSyncing = false;
    });
  }

  window.CloudDB = {
    // 从云端拉取 → 合并写入 localStorage（云端优先，本地新增保留）
    loadFromPublic: function(callback, timeoutMs) {
      var self = this;
      timeoutMs = timeoutMs || 3000;
      var timedOut = false;
      var timer = setTimeout(function() {
        timedOut = true;
        console.warn('[CloudDB] 云端拉取超时(' + timeoutMs + 'ms)，使用本地数据');
        if (callback) callback(false); // false = 超时/失败，但仍有本地数据
      }, timeoutMs);

      fetchJSON(SUPABASE_URL + '/rest/v1/' + TABLE + '?id=eq.' + ROW_ID + '&select=data', {
        headers: makeHeaders({ 'Accept': 'application/json' })
      }).then(function(arr) {
        if (timedOut) return;
        clearTimeout(timer);
        var cloudData = arr && arr[0] && arr[0].data ? arr[0].data : null;
        if (!cloudData) { if (callback) callback(true); return; }
        console.log('[CloudDB] 拉取云端数据, keys:', Object.keys(cloudData).join(', '));
        var keys = ['accounts', 'registrations', 'villages', 'products', 'food', 'camps', 'messages'];
        keys.forEach(function(key) {
          try {
            var localRaw = localStorage.getItem('village_' + key);
            var localArr = localRaw ? JSON.parse(localRaw) : [];
            var cloudArr = cloudData[key] || [];
            var seen = {};
            cloudArr.forEach(function(item) { if (item && item.id) seen[item.id] = true; });
            var merged = cloudArr.slice();
            localArr.forEach(function(item) { if (item && item.id && !seen[item.id]) merged.push(item); });
            localStorage.setItem('village_' + key, JSON.stringify(merged));
          } catch(e) {}
        });
        if (callback) callback(true);
      }).catch(function(e) {
        if (timedOut) return;
        clearTimeout(timer);
        console.warn('[CloudDB] 拉取云端数据失败:', e.message);
        if (callback) callback(false);
      });
      // 返回一个 Promise（兼容旧代码）
      return { then: function(ok, fail) { /* 已在上面的回调处理 */ } };
    },

    // 推送数据（本地优先，后台云端同步，永远不阻塞）
    push: function(data, description) {
      var self = this;
      // 1. 立即保存到本地 localStorage（同步）
      var keys = Object.keys(data);
      keys.forEach(function(key) {
        try {
          var existing = JSON.parse(localStorage.getItem('village_' + key) || '[]');
          var incoming = Array.isArray(data[key]) ? data[key] : [data[key]];
          var ids = {};
          existing.forEach(function(item) { if (item.id) ids[item.id] = item; });
          incoming.forEach(function(item) { if (item.id) ids[item.id] = item; });
          var merged = Object.keys(ids).map(function(k) { return ids[k]; });
          localStorage.setItem('village_' + key, JSON.stringify(merged));
        } catch(e) {}
      });
      console.log('[CloudDB] 已本地保存:' + keys.join(',') + ' ' + (description || ''));
      // 2. 后台异步同步到云端（不等待）
      syncToCloud(function(ok, err) {
        if (ok) console.log('[CloudDB] 云端同步成功:', description);
        else console.log('[CloudDB] 云端同步失败（本地已保存）:', description, err);
      });
      // 3. 立即返回成功（不等待云端）
      return Promise.resolve();
    },

    // 主动触发云端全量同步
    save: function(callback) {
      syncToCloud(callback);
    },

    // 兼容旧接口
    init: function(callback) { this.loadFromPublic(callback, 5000); },
    load: function(callback) { this.loadFromPublic(callback, 5000); }
  };
})();
