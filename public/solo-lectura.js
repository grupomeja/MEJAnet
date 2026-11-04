// Modo solo consulta: si el usuario es de solo lectura, muestra un aviso y oculta los botones para crear.
// El servidor de todos modos rechaza cualquier cambio; esto solo evita que se intente.
(function () {
  fetch('/api/sesion', { credentials: 'same-origin' }).then((r) => r.ok ? r.json() : null).then((s) => {
    if (!s || !s.soloLectura) return;
    window.MEJA_SOLO_LECTURA = true;
    document.dispatchEvent(new Event('meja:solo-lectura'));
    const css = document.createElement('style');
    css.textContent = 'a.nuevo,a[href$="/nueva"],a[href="/nueva-orden"],a[href^="/cotizador/nueva"]{display:none!important}' +
      '.meja-sl{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:9999;background:#0b1a33;color:#fff;' +
      'font:600 13px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:9px 16px;border-radius:999px;box-shadow:0 6px 18px rgba(0,0,0,.25);' +
      'pointer-events:none;white-space:nowrap;opacity:.92}';
    document.head.appendChild(css);
    const aviso = document.createElement('div');
    aviso.className = 'meja-sl';
    aviso.textContent = '👁 Modo solo consulta · ' + s.usuario;
    document.body.appendChild(aviso);
  }).catch(() => {});
})();
