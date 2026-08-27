/* 转盘抽奖 · 管理后台前端逻辑 */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var token = localStorage.getItem('lottery_admin_token') || '';
  var username = localStorage.getItem('lottery_admin_user') || '';
  var activities = [];
  var editingId = null;
  var recPage = 1, recTotal = 0, recPageSize = 20;

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    var sep = path.indexOf('?') >= 0 ? '&' : '?';
    return fetch(path + sep + 'token=' + encodeURIComponent(token), opts)
      .then(function (r) {
        if (r.status === 401) { logout(true); throw new Error('未登录或登录已过期'); }
        return r.json().then(function (j) { return { ok: r.ok, status: r.status, data: j }; });
      });
  }

  /* ================= 登录 ================= */
  function tryAutoLogin() {
    if (!token) { showLogin(); return; }
    api('/api/admin/me').then(function (r) {
      if (r.ok) { username = r.data.username; enterMain(); } else showLogin();
    }).catch(showLogin);
  }
  function showLogin() {
    $('loginView').style.display = 'flex';
    $('mainView').style.display = 'none';
  }
  function enterMain() {
    localStorage.setItem('lottery_admin_token', token);
    localStorage.setItem('lottery_admin_user', username);
    $('loginView').style.display = 'none';
    $('mainView').style.display = 'flex';
    $('whoAmI').textContent = '👤 ' + username;
    switchView('activities');
    loadActivities();
  }
  $('loginBtn').onclick = function () {
    $('loginErr').textContent = '';
    fetch('/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('loginUser').value.trim(), password: $('loginPass').value })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, data: j }; }); })
      .then(function (r) {
        if (r.ok) { token = r.data.token; username = r.data.username; enterMain(); }
        else $('loginErr').textContent = r.data.error || '登录失败';
      });
  };
  $('loginPass').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('loginBtn').click(); });
  function logout(silent) {
    if (!silent) api('/api/admin/logout', { method: 'POST' }).catch(function () {});
    token = ''; username = '';
    localStorage.removeItem('lottery_admin_token');
    localStorage.removeItem('lottery_admin_user');
    showLogin();
  }
  $('logoutBtn').onclick = function () { logout(false); };

  /* 修改密码 */
  $('changePwdLink').onclick = function () { $('pwdErr').textContent = ''; $('oldPwd').value = ''; $('newPwd').value = ''; $('pwdModal').classList.add('show'); };
  $('pwdClose').onclick = function () { $('pwdModal').classList.remove('show'); };
  $('pwdSubmit').onclick = function () {
    api('/api/admin/change-password', { method: 'POST', body: JSON.stringify({ oldPassword: $('oldPwd').value, newPassword: $('newPwd').value }) })
      .then(function (r) {
        if (r.ok) { $('pwdModal').classList.remove('show'); toast('密码修改成功，下次登录请使用新密码'); }
        else $('pwdErr').textContent = r.data.error;
      });
  };

  /* ================= 视图切换 ================= */
  function switchView(name) {
    document.querySelectorAll('.nav-item').forEach(function (n) { n.classList.toggle('active', n.dataset.view === name); });
    document.querySelectorAll('.view').forEach(function (v) { v.style.display = 'none'; });
    var v = $('view-' + name); if (v) v.style.display = 'block';
    if (name === 'records') { recPage = 1; loadRecords(); }
    if (name === 'stats') loadStats();
  }
  document.querySelectorAll('.nav-item').forEach(function (n) {
    n.onclick = function () { switchView(n.dataset.view); };
  });

  /* ================= 活动管理 ================= */
  function loadActivities() {
    return api('/api/admin/activities').then(function (r) {
      if (!r.ok) return;
      activities = r.data;
      renderActivities();
      fillActivitySelects();
    });
  }
  var statusText = { published: '已发布', draft: '草稿/未发布', stopped: '已停用' };
  function renderActivities() {
    var tb = $('actTable').querySelector('tbody');
    tb.innerHTML = activities.length ? '' : '<tr><td colspan="9" class="empty-tip">暂无活动，点击右上角「新建活动」创建</td></tr>';
    activities.forEach(function (a) {
      var tr = document.createElement('tr');
      var ops = '';
      if (a.status !== 'published') ops += '<button class="btn primary" data-act="publish" data-id="' + a.id + '">发布</button>';
      else ops += '<button class="btn primary" data-act="qr" data-id="' + a.id + '">二维码</button>';
      ops += '<button class="btn ghost" data-act="edit" data-id="' + a.id + '">编辑</button>';
      ops += '<button class="btn ghost" data-act="dup" data-id="' + a.id + '">复制副本</button>';
      if (a.status === 'published') ops += '<button class="btn ghost" data-act="stop" data-id="' + a.id + '">停用</button>';
      tr.innerHTML = '<td>' + a.id + '</td>' +
        '<td><b>' + esc(a.title) + '</b>' + (a.draft ? ' <span class="badge draft">有未发布草稿</span>' : '') + '</td>' +
        '<td><span class="badge ' + a.status + '">' + statusText[a.status] + '</span></td>' +
        '<td>' + a.scans + '</td><td>' + a.draws + '</td><td>' + a.winners + '</td>' +
        '<td>¥' + a.total_amount + '</td>' +
        '<td>' + (a.created_at || '') + '</td>' +
        '<td><div class="op-btns">' + ops + '</div></td>';
      tb.appendChild(tr);
    });
    tb.querySelectorAll('button[data-act]').forEach(function (b) {
      b.onclick = function () {
        var act = b.dataset.act, id = +b.dataset.id;
        if (act === 'edit') openEditor(id);
        else if (act === 'publish') doPublish(id);
        else if (act === 'stop') doStop(id);
        else if (act === 'dup') doDuplicate(id);
        else if (act === 'qr') showQr(id);
      };
    });
  }
  function fillActivitySelects() {
    ['rActivity', 'sActivity'].forEach(function (id) {
      var sel = $(id);
      var val = sel.value;
      sel.innerHTML = '<option value="">全部活动</option>' + activities.map(function (a) {
        return '<option value="' + a.id + '">' + esc(a.title) + ' (ID:' + a.id + ')</option>';
      }).join('');
      if (val) sel.value = val;
    });
  }
  $('newActivityBtn').onclick = function () {
    api('/api/admin/activities', { method: 'POST' }).then(function (r) {
      if (r.ok) { toast('已创建新活动（默认概率已初始化）'); loadActivities().then(function () { openEditor(r.data.id); }); }
    });
  };
  function doPublish(id) {
    if (!confirm('确认发布该活动？发布后用户扫码即可参与抽奖。')) return;
    api('/api/admin/activities/' + id + '/publish', { method: 'POST' }).then(function (r) {
      if (r.ok) { toast('发布成功！'); loadActivities(); showQr(id); }
      else toast(r.data.error || '发布失败');
    });
  }
  function doStop(id) {
    if (!confirm('确认停用该活动？停用后用户扫码将提示「活动已结束」。')) return;
    api('/api/admin/activities/' + id + '/stop', { method: 'POST' }).then(function (r) {
      if (r.ok) { toast('活动已停用'); loadActivities(); }
    });
  }
  function doDuplicate(id) {
    api('/api/admin/activities/' + id + '/duplicate', { method: 'POST' }).then(function (r) {
      if (r.ok) { toast('已复制副本（草稿状态）'); loadActivities(); }
    });
  }

  /* 二维码弹窗 */
  function showQr(id) {
    var a = activities.find(function (x) { return x.id === id; });
    if (!a || !a.link) { toast('该活动未发布，请先发布生成访问链接'); return; }
    $('qrImg').src = '/api/admin/activities/' + id + '/qrcode.png?token=' + encodeURIComponent(token) + '&t=' + Date.now();
    $('qrLink').value = a.link;
    $('downloadQrBtn').href = '/api/admin/activities/' + id + '/qrcode.png?token=' + encodeURIComponent(token);
    $('qrModal').classList.add('show');
  }
  $('qrClose').onclick = function () { $('qrModal').classList.remove('show'); };
  $('copyLinkBtn').onclick = function () {
    $('qrLink').select();
    if (navigator.clipboard) navigator.clipboard.writeText($('qrLink').value).then(function () { toast('链接已复制'); });
    else { document.execCommand('copy'); toast('链接已复制'); }
  };

  /* ================= 活动编辑器 ================= */
  var editorImages = {};
  function openEditor(id) {
    editingId = id;
    switchView('editorView');
    document.querySelectorAll('.view').forEach(function (v) { v.style.display = 'none'; });
    $('view-editor').style.display = 'block';
    document.querySelectorAll('.nav-item').forEach(function (n) { n.classList.remove('active'); });
    api('/api/admin/activities/' + id).then(function (r) {
      if (!r.ok) return;
      var a = r.data;
      $('editorTitle').textContent = '编辑活动（ID:' + a.id + ' · ' + statusText[a.status] + '）';
      // 优先加载未发布的草稿
      var src = a.draft || { title: a.title, description: a.description, rules: a.rules, images: a.images, prizes: a.prizes };
      $('fTitle').value = src.title || '';
      $('fDesc').value = src.description || '';
      $('fRules').value = src.rules || '';
      editorImages = Object.assign({}, src.images || {});
      renderUploadGrid();
      renderPrizeRows((src.prizes || []).map(function (p) {
        return { name: p.name, amount: p.amount, prob_num: p.prob_num, prob_den: p.prob_den, is_blank: p.is_blank };
      }));
    });
  }
  $('backBtn').onclick = function () { switchView('activities'); loadActivities(); };

  function renderUploadGrid() {
    document.querySelectorAll('.upload-item').forEach(function (item) {
      var key = item.dataset.key;
      item.innerHTML = '<span>' + item.querySelector('span') ? item.dataset.key : '' + '</span>';
      var labels = { header: '活动头图', wheel: '转盘底图', button: '抽奖按钮图', popup: '弹窗背景图' };
      item.innerHTML = '';
      if (editorImages[key]) {
        var img = document.createElement('img'); img.src = editorImages[key];
        item.appendChild(img);
        var del = document.createElement('div'); del.className = 'del'; del.textContent = '×';
        del.onclick = function (e) { e.stopPropagation(); delete editorImages[key]; renderUploadGrid(); };
        item.appendChild(del);
      } else {
        var sp = document.createElement('span'); sp.textContent = '＋ 上传 ' + labels[key];
        item.appendChild(sp);
      }
      item.onclick = function () { pickImage(key); };
    });
  }
  function pickImage(key) {
    var input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/png,image/jpeg,image/gif,image/webp';
    input.onchange = function () {
      var f = input.files[0];
      if (!f) return;
      if (f.size > 3 * 1024 * 1024) { toast('图片不能超过 3MB'); return; }
      var fr = new FileReader();
      fr.onload = function () {
        api('/api/admin/upload', { method: 'POST', body: JSON.stringify({ dataUrl: fr.result }) })
          .then(function (r) {
            if (r.ok) { editorImages[key] = r.data.url; renderUploadGrid(); toast('素材已上传（保存草稿/发布后生效）'); }
            else toast(r.data.error || '上传失败');
          });
      };
      fr.readAsDataURL(f);
    };
    input.click();
  }

  function renderPrizeRows(prizes) {
    var tb = $('prizeBody');
    tb.innerHTML = '';
    prizes.forEach(function (p, i) {
      addPrizeRow(p);
    });
  }
  function addPrizeRow(p) {
    p = p || { name: '', amount: 0, prob_num: 1, prob_den: 100, is_blank: 0 };
    var tb = $('prizeBody');
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td><input class="p-name" type="text" value="' + esc(String(p.name || '')) + '" placeholder="奖品名称"></td>' +
      '<td><input class="p-amt" type="number" step="0.5" min="0" value="' + p.amount + '"></td>' +
      '<td><input class="p-num" type="number" min="0" value="' + p.prob_num + '"></td>' +
      '<td><input class="p-den" type="number" min="1" value="' + p.prob_den + '"></td>' +
      '<td style="text-align:center"><input class="p-blank" type="checkbox"' + (p.is_blank ? ' checked' : '') + '></td>' +
      '<td class="del-row" title="删除">✕</td>';
    tr.querySelector('.del-row').onclick = function () { tr.remove(); };
    tb.appendChild(tr);
  }
  $('addPrizeBtn').onclick = function () { addPrizeRow(); };

  function collectEditorData() {
    var prizes = [];
    var rows = $('prizeBody').querySelectorAll('tr');
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var name = r.querySelector('.p-name').value.trim();
      if (!name) throw new Error('第 ' + (i + 1) + ' 个奖项名称不能为空');
      prizes.push({
        name: name,
        amount: Number(r.querySelector('.p-amt').value) || 0,
        prob_num: Number(r.querySelector('.p-num').value) || 0,
        prob_den: Number(r.querySelector('.p-den').value) || 1,
        is_blank: r.querySelector('.p-blank').checked ? 1 : 0
      });
    }
    return {
      title: $('fTitle').value.trim(),
      description: $('fDesc').value,
      rules: $('fRules').value,
      images: editorImages,
      prizes: prizes
    };
  }
  function saveDraft(cb) {
    try {
      var data = collectEditorData();
      api('/api/admin/activities/' + editingId + '/draft', { method: 'PUT', body: JSON.stringify(data) })
        .then(function (r) {
          if (r.ok) { toast('草稿已保存（未发布不影响线上页面）'); cb && cb(true); }
          else { toast(r.data.error || '保存失败'); cb && cb(false); }
        })
        .catch(function (e) { toast(e.message); cb && cb(false); });
    } catch (e) { toast(e.message); cb && cb(false); }
  }
  $('saveDraftBtn').onclick = function () { saveDraft(); };
  $('publishBtn').onclick = function () {
    try { collectEditorData(); } catch (e) { toast(e.message); return; }
    if (!confirm('确认发布活动？发布后配置立即生效，用户扫码即可参与。')) return;
    var data = collectEditorData();
    api('/api/admin/activities/' + editingId + '/publish', { method: 'POST', body: JSON.stringify(data) })
      .then(function (r) {
        if (r.ok) { toast('发布成功！'); loadActivities(); showQr(editingId); }
        else toast(r.data.error || '发布失败');
      })
      .catch(function (e) { toast(e.message); });
  };

  /* ================= 数据明细 ================= */
  function recordsQuery() {
    var q = [];
    if ($('rActivity').value) q.push('activityId=' + $('rActivity').value);
    if ($('rFrom').value) q.push('from=' + $('rFrom').value);
    if ($('rTo').value) q.push('to=' + $('rTo').value);
    if ($('rPhone').value.trim()) q.push('phone=' + encodeURIComponent($('rPhone').value.trim()));
    if ($('rDrawn').value) q.push('drawn=' + $('rDrawn').value);
    if ($('rWinner').value) q.push('winner=' + $('rWinner').value);
    return q.join('&');
  }
  function loadRecords() {
    var q = recordsQuery();
    api('/api/admin/records?' + q + '&page=' + recPage + '&pageSize=' + recPageSize)
      .then(function (r) {
        if (!r.ok) return;
        recTotal = r.data.total;
        $('recTotal').textContent = '共 ' + recTotal + ' 条';
        $('recPage').textContent = '第 ' + recPage + ' / ' + Math.max(1, Math.ceil(recTotal / recPageSize)) + ' 页';
        var tb = $('recTable').querySelector('tbody');
        tb.innerHTML = r.data.rows.length ? '' : '<tr><td colspan="7" class="empty-tip">暂无数据</td></tr>';
        r.data.rows.forEach(function (p) {
          var tr = document.createElement('tr');
          tr.innerHTML =
            '<td>' + p.scanned_at + '</td>' +
            '<td>' + esc(p.nickname) + '</td>' +
            '<td>' + p.phone + '</td>' +
            '<td>' + (p.drew_at ? '<span class="badge published">是</span>' : '<span class="badge stopped">否</span>') + '</td>' +
            '<td>' + (p.drew_at ? (p.is_winner ? '<span class="badge win">中奖 ¥' + p.prize_amount + '</span>' : '谢谢惠顾') : '—') + '</td>' +
            '<td>' + (p.repeat_flag ? '<span class="badge rep">是</span>' : '否') + '</td>' +
            '<td title="' + esc(p.user_agent || '') + '">' + uaShort(p.user_agent) + '</td>';
          tb.appendChild(tr);
        });
      });
  }
  $('rSearch').onclick = function () { recPage = 1; loadRecords(); };
  $('recPrev').onclick = function () { if (recPage > 1) { recPage--; loadRecords(); } };
  $('recNext').onclick = function () { if (recPage < Math.ceil(recTotal / recPageSize)) { recPage++; loadRecords(); } };
  $('exportRecordsBtn').onclick = function () {
    window.open('/api/admin/export/records?' + recordsQuery() + '&token=' + encodeURIComponent(token));
  };

  /* ================= 统计看板 ================= */
  function statsQuery() {
    var q = [];
    if ($('sActivity').value) q.push('activityId=' + $('sActivity').value);
    if ($('sFrom').value) q.push('from=' + $('sFrom').value);
    if ($('sTo').value) q.push('to=' + $('sTo').value);
    return q.join('&');
  }
  function loadStats() {
    api('/api/admin/stats?' + statsQuery()).then(function (r) {
      if (!r.ok) return;
      $('stScans').textContent = r.data.totals.scans || 0;
      $('stDraws').textContent = r.data.totals.draws || 0;
      $('stWinners').textContent = r.data.totals.winners || 0;
      $('stAmount').textContent = '¥' + (r.data.totals.amount || 0);
      $('stDup').textContent = r.data.duplicates.attempts || 0;
      var tb = $('dailyTable').querySelector('tbody');
      tb.innerHTML = r.data.daily.length ? '' : '<tr><td colspan="5" class="empty-tip">暂无数据</td></tr>';
      r.data.daily.forEach(function (d) {
        var tr = document.createElement('tr');
        tr.innerHTML = '<td>' + d.d + '</td><td>' + d.scans + '</td><td>' + d.draws + '</td><td>' + d.winners + '</td><td>¥' + d.amount + '</td>';
        tb.appendChild(tr);
      });
      var tb2 = $('tierTable').querySelector('tbody');
      tb2.innerHTML = r.data.tiers.length ? '' : '<tr><td colspan="3" class="empty-tip">暂无中奖记录</td></tr>';
      r.data.tiers.forEach(function (t) {
        var tr = document.createElement('tr');
        tr.innerHTML = '<td>' + esc(t.name) + '</td><td>' + t.cnt + '</td><td>¥' + t.total + '</td>';
        tb2.appendChild(tr);
      });
    });
  }
  $('sSearch').onclick = loadStats;
  $('exportStatsBtn').onclick = function () {
    window.open('/api/admin/export/stats?' + statsQuery() + '&token=' + encodeURIComponent(token));
  };

  /* ================= 工具 ================= */
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function uaShort(ua) {
    ua = ua || '';
    if (/MicroMessenger/i.test(ua)) return '微信内置浏览器';
    if (/iPhone|iPad/i.test(ua)) return 'iOS 浏览器';
    if (/Android/i.test(ua)) return 'Android 浏览器';
    if (/Windows|Macintosh/i.test(ua)) return 'PC 浏览器';
    return ua ? '其他' : '—';
  }

  tryAutoLogin();
})();
