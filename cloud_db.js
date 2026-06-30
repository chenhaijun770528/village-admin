// cloud_db.js - Supabase 云数据库版（anon key + 读写）
(function() {
  var SUPABASE_URL = 'https://eivqbbxyllsorbvgqsju.supabase.co';
  var SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVpdnFiYnh5bGxzb3Jidmdxc2p1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3MTIzMDksImV4cCI6MjA5ODI4ODMwOX0.QeKnbo1cgA0yGMOEydML3PNXatH1V1QXfW0hyxRy7KY';
  var TABLE = 'village_data';
  var ROW_ID = 'init';

  var _syncing = false;

  function api(path, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    opts.headers['apikey'] = SUPABASE_KEY;
    opts.headers['Authorization'] = 'Bearer ' + SUPABASE_KEY;
    opts.headers['Accept-Profile'] = 'public';
    opts.headers['Content-Profile'] = 'public';
    return fetch(SUPABASE_URL + path, opts).then(function(r) {
      return r.text().then(function(t) {
        return { ok: r.ok, status: r.status, body: t };
      });
    });
  }

  // 保存全部数据到云端
  function syncToCloud(callback) {
    if (_syncing) { if (callback) callback(false, 'busy'); return; }
    _syncing = true;
    var allData = {};
    var keys = ['accounts', 'registrations', 'villages', 'products', 'food', 'camps', 'messages'];
    keys.forEach(function(key) {
      try { allData[key] = JSON.parse(localStorage.getItem('village_' + key) || '[]'); }
      catch(e) { allData[key] = []; }
    });
    var body = JSON.stringify({ id: ROW_ID, data: allData });
    // 先尝试PATCH更新
    api('/rest/v1/' + TABLE + '?id=eq.' + ROW_ID, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: body
    }).then(function(res) {
      if (res.ok || res.status === 200 || res.status === 204) {
        console.log('[CloudDB] 云端同步成功');
        if (callback) callback(true);
      } else {
        // PATCH失败则尝试POST插入新行
        return api('/rest/v1/' + TABLE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
          body: body
        }).then(function(res2) {
          if (res2.ok || res2.status === 201) {
            console.log('[CloudDB] 云端同步成功(POST)');
            if (callback) callback(true);
          } else {
            console.warn('[CloudDB] 云端同步失败:', res.status, res.body.substring(0, 100));
            if (callback) callback(false, res.status);
          }
          _syncing = false;
        });
      }
      _syncing = false;
    }).catch(function(e) {
      console.warn('[CloudDB] 云端同步失败:', e.message);
      if (callback) callback(false, e.message);
      _syncing = false;
    });
  }

  // 从云端拉取 → 合并到本地
  function loadFromCloud(timeoutMs, cb) {
    timeoutMs = timeoutMs || 5000;
    var timer = setTimeout(function() {
      console.warn('[CloudDB] 云端拉取超时');
      if (cb) cb(false, 'timeout');
    }, timeoutMs);

    api('/rest/v1/' + TABLE + '?id=eq.' + ROW_ID + '&select=data').then(function(res) {
      clearTimeout(timer);
      if (!res.ok) {
        console.warn('[CloudDB] 拉取失败:', res.status);
        if (cb) cb(false, res.status);
        return;
      }
      try {
        var arr = JSON.parse(res.body);
        var cloudData = arr && arr[0] && arr[0].data ? arr[0].data : null;
        if (!cloudData) { if (cb) cb(true, 'empty'); return; }
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
        if (cb) cb(true, cloudData);
      } catch(e) {
        console.warn('[CloudDB] 解析失败:', e.message);
        if (cb) cb(false, 'parse error');
      }
    }).catch(function(e) {
      clearTimeout(timer);
      console.warn('[CloudDB] 云端拉取异常:', e.message);
      if (cb) cb(false, e.message);
    });
  }

  window.CloudDB = {
    loadFromPublic: function(cb, timeoutMs) {
      loadFromCloud(timeoutMs, cb);
      return { then: function() {} }; // 兼容
    },
    push: function(data, desc) {
      // 1. 立即本地保存
      Object.keys(data).forEach(function(key) {
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
      console.log('[CloudDB] 本地已保存:' + Object.keys(data).join(',') + ' ' + (desc || ''));
      // 2. 后台云端同步
      syncToCloud(function(ok) {
        console.log('[CloudDB] 云端同步' + (ok ? '成功' : '失败（本地已存）') + ':' + (desc || ''));
      });
      return { then: function() {} };
    },
    save: function(cb) { syncToCloud(cb); },
    init: function(cb) { this.loadFromPublic(cb, 5000); }
  };
})();
