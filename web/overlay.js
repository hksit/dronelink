/* DroneLink on-screen info: a broadcast-style overlay drawn over the drone video.
   Shared by the app preview, the OBS Browser source and viewers on the Wi-Fi,
   so all three look the same. Sizes are relative to the video width. */
(function (root) {
  'use strict';

  var CSS = [
    '.dlo{position:absolute;inset:0;pointer-events:none;container-type:size;font-family:"Segoe UI Variable Display","Segoe UI",-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;color:#fff;transition:opacity .25s}',
    '.dlo[data-on="false"]{opacity:0}',
    '.dlo-frame{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(100cqw,177.78cqh);height:min(100cqh,56.25cqw);container-type:inline-size}',
    '.dlo-tl{position:absolute;left:3.2cqw;top:3.2cqw;display:flex;gap:1cqw;align-items:center}',
    '.dlo-live{display:flex;align-items:center;gap:.8cqw;background:#e5251b;border-radius:.45cqw;padding:.45cqw 1.1cqw;font-weight:700;font-size:1.55cqw;letter-spacing:.06em}',
    '.dlo-live i{width:.85cqw;height:.85cqw;border-radius:50%;background:#fff;animation:dlo-pulse 1.6s ease-in-out infinite}',
    '.dlo-time{background:rgba(10,16,22,.62);border-radius:.45cqw;padding:.45cqw 1cqw;font-size:1.55cqw;font-weight:600;font-variant-numeric:tabular-nums}',
    '.dlo-tr{position:absolute;right:3.2cqw;top:3.2cqw;background:rgba(10,16,22,.62);border-radius:.45cqw;padding:.45cqw 1cqw;font-size:1.55cqw;font-weight:600;font-variant-numeric:tabular-nums}',
    '.dlo-lt{position:absolute;left:3.2cqw;bottom:4cqw;display:flex;max-width:62cqw}',
    '.dlo-lt b{width:.6cqw;background:#ff8a1f;border-radius:.3cqw 0 0 .3cqw}',
    '.dlo-lt>div{background:rgba(10,16,22,.74);padding:1cqw 1.8cqw 1.1cqw 1.4cqw;border-radius:0 .45cqw .45cqw 0}',
    '.dlo-title{font-size:2.5cqw;font-weight:700;line-height:1.15;letter-spacing:-.01em}',
    '.dlo-sub{font-size:1.5cqw;font-weight:500;opacity:.86;margin-top:.35cqw}',
    '.dlo-br{position:absolute;right:3.2cqw;bottom:4cqw;background:rgba(10,16,22,.55);border-radius:.45cqw;padding:.4cqw .9cqw;font-size:1.2cqw;font-weight:600;font-variant-numeric:tabular-nums;opacity:.9}',
    '.dlo [hidden]{display:none!important}',
    '@keyframes dlo-pulse{50%{opacity:.35}}',
    '@media (prefers-reduced-motion:reduce){.dlo-live i{animation:none}}',
  ].join('');

  function el(tag, cls, parent) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function elapsed(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    return (h ? h + ':' + pad(m) : pad(m)) + ':' + pad(s % 60);
  }

  function create(container) {
    if (!document.getElementById('dlo-style')) {
      var st = document.createElement('style');
      st.id = 'dlo-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    var wrap = el('div', 'dlo', container);
    wrap.setAttribute('aria-hidden', 'true');
    var frame = el('div', 'dlo-frame', wrap);
    var tl = el('div', 'dlo-tl', frame);
    var live = el('span', 'dlo-live', tl);
    el('i', '', live);
    live.appendChild(document.createTextNode('LIVE'));
    var time = el('span', 'dlo-time', tl);
    var clock = el('div', 'dlo-tr', frame);
    var lt = el('div', 'dlo-lt', frame);
    el('b', '', lt);
    var ltText = el('div', '', lt);
    var title = el('div', 'dlo-title', ltText);
    var sub = el('div', 'dlo-sub', ltText);
    var details = el('div', 'dlo-br', frame);
    var state = null;

    function render() {
      var s = state || {};
      var o = s.overlay || {};
      var on = !!o.enabled && s.status === 'publishing';
      wrap.dataset.on = String(on);
      if (!on) return;
      live.hidden = !o.live;
      time.hidden = !o.live || !s.since;
      if (s.since) time.textContent = elapsed(Date.now() - s.since);
      clock.hidden = !o.clock;
      var d = new Date();
      clock.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
      var hasTitle = !!(o.title || o.subtitle);
      lt.hidden = !hasTitle;
      title.textContent = o.title || '';
      title.hidden = !o.title;
      sub.textContent = o.subtitle || '';
      sub.hidden = !o.subtitle;
      details.hidden = !o.details || !s.width;
      if (s.width) {
        var mbps = s.kbps ? (s.kbps / 1000).toFixed(1) + ' Mbps' : '';
        details.textContent = [s.height + 'p', s.fps ? s.fps + ' fps' : '', mbps].filter(Boolean).join('  ·  ');
      }
    }

    setInterval(render, 500);
    return {
      update: function (next) {
        state = next;
        render();
      },
    };
  }

  root.DroneLinkOverlay = { create: create };
})(window);
