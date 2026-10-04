// Evaluador de fórmulas del cotizador (se usa igual en el navegador y en el servidor).
// Admite: números, variables, + - * / ^, paréntesis, comparaciones (> < >= <= == !=)
// y funciones: min, max, redondear/round, techo/ceil, piso/floor, abs, si(condicion, valor_si, valor_no).
// Ejemplos:  precio * tarimas * dias
//            max(precio * peso_kg / 1000, 1500)
//            si(peso_kg > 10000, 9500, 7800)
(function (raiz, crear) {
  if (typeof module === 'object' && module.exports) module.exports = crear();
  else raiz.Formula = crear();
})(typeof self !== 'undefined' ? self : this, function () {
  const FUNCIONES = {
    min: (...a) => Math.min(...a), max: (...a) => Math.max(...a),
    redondear: (x, d = 0) => { const f = 10 ** d; return Math.round(x * f) / f; },
    round: (x, d = 0) => { const f = 10 ** d; return Math.round(x * f) / f; },
    techo: Math.ceil, ceil: Math.ceil, piso: Math.floor, floor: Math.floor, abs: Math.abs,
    si: (c, a, b) => (c ? a : b), if: (c, a, b) => (c ? a : b),
  };

  function tokens(txt) {
    const out = [];
    const re = /\s*(?:(\d+(?:\.\d+)?|\.\d+)|([A-Za-z_áéíóúñÁÉÍÓÚÑ][\wáéíóúñÁÉÍÓÚÑ]*)|(>=|<=|==|!=|[-+*/^(),<>]))/y;
    let i = 0;
    const s = String(txt ?? '');
    while (i < s.length) {
      if (/^\s*$/.test(s.slice(i))) break;
      re.lastIndex = i;
      const m = re.exec(s);
      if (!m) throw new Error(`No entiendo "${s.slice(i).trim().slice(0, 12)}"`);
      if (m[1] !== undefined) out.push({ t: 'n', v: Number(m[1]) });
      else if (m[2] !== undefined) out.push({ t: 'id', v: m[2].toLowerCase() });
      else out.push({ t: 'op', v: m[3] });
      i = re.lastIndex;
    }
    return out;
  }

  // Convierte el texto en un árbol; así se valida una vez y se evalúa muchas.
  function compilar(txt) {
    const tk = tokens(txt);
    if (!tk.length) throw new Error('La fórmula está vacía');
    let p = 0;
    const ver = () => tk[p];
    const es = (v) => tk[p] && tk[p].t === 'op' && tk[p].v === v;
    const pide = (v) => { if (!es(v)) throw new Error(`Falta "${v}"`); p++; };
    const NIVELES = [['==', '!='], ['>', '<', '>=', '<='], ['+', '-'], ['*', '/']];
    function binario(n) {
      if (n === NIVELES.length) return potencia();
      let izq = binario(n + 1);
      while (tk[p] && tk[p].t === 'op' && NIVELES[n].includes(tk[p].v)) {
        const op = tk[p++].v;
        izq = { op, a: izq, b: binario(n + 1) };
      }
      return izq;
    }
    function potencia() {
      const base = unario();
      if (es('^')) { p++; return { op: '^', a: base, b: potencia() }; }
      return base;
    }
    function unario() {
      if (es('-')) { p++; return { op: 'neg', a: unario() }; }
      if (es('+')) { p++; return unario(); }
      return primario();
    }
    function primario() {
      const x = ver();
      if (!x) throw new Error('La fórmula termina antes de tiempo');
      if (x.t === 'n') { p++; return { n: x.v }; }
      if (x.t === 'id') {
        p++;
        if (es('(')) {
          if (!FUNCIONES[x.v]) throw new Error(`No existe la función "${x.v}"`);
          p++;
          const args = [];
          if (!es(')')) { args.push(binario(0)); while (es(',')) { p++; args.push(binario(0)); } }
          pide(')');
          return { fn: x.v, args };
        }
        return { v: x.v };
      }
      if (es('(')) { p++; const e = binario(0); pide(')'); return e; }
      throw new Error(`No esperaba "${x.v}"`);
    }
    const arbol = binario(0);
    if (p < tk.length) throw new Error(`Sobra "${tk[p].v}"`);
    return arbol;
  }

  function variablesDe(arbol, set = new Set()) {
    if (arbol.v) set.add(arbol.v);
    if (arbol.a) variablesDe(arbol.a, set);
    if (arbol.b) variablesDe(arbol.b, set);
    if (arbol.args) arbol.args.forEach((x) => variablesDe(x, set));
    return set;
  }

  function evaluar(arbol, vars) {
    const ev = (n) => {
      if ('n' in n) return n.n;
      if (n.v) {
        if (!(n.v in vars)) throw new Error(`No existe la variable "${n.v}"`);
        const x = Number(vars[n.v]);
        return Number.isFinite(x) ? x : 0;
      }
      if (n.fn) return FUNCIONES[n.fn](...n.args.map(ev));
      if (n.op === 'neg') return -ev(n.a);
      const a = ev(n.a), b = ev(n.b);
      switch (n.op) {
        case '+': return a + b; case '-': return a - b; case '*': return a * b;
        case '/': return b === 0 ? 0 : a / b; case '^': return a ** b;
        case '>': return a > b ? 1 : 0; case '<': return a < b ? 1 : 0;
        case '>=': return a >= b ? 1 : 0; case '<=': return a <= b ? 1 : 0;
        case '==': return a === b ? 1 : 0; case '!=': return a !== b ? 1 : 0;
      }
      return 0;
    };
    const r = ev(arbol);
    return Number.isFinite(r) ? r : 0;
  }

  // Variables que cualquier fórmula puede usar (datos del embarque + la partida)
  const VARIABLES = [
    ['precio', 'Precio unitario de la partida'],
    ['cantidad', 'Cantidad de la partida'],
    ['peso_kg', 'Peso en kilogramos'],
    ['peso_lb', 'Peso en libras'],
    ['tarimas', 'Número de tarimas'],
    ['bultos', 'Número de bultos'],
    ['dias', 'Días (almacenaje)'],
    ['km', 'Kilómetros'],
    ['valor', 'Valor de la mercancía'],
    ['tc', 'Tipo de cambio (MXN por USD)'],
  ];

  const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;

  // Calcula importes, IVA y totales de una cotización.
  function calcular(cot) {
    const e = cot.embarque || {};
    const num = (x) => { const n = parseFloat(String(x ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
    const tc = num(cot.tc);
    const base = {
      peso_kg: num(e.peso_kg), peso_lb: r2(num(e.peso_kg) * 2.20462), tarimas: num(e.tarimas), bultos: num(e.bultos),
      dias: num(e.dias), km: num(e.km), valor: num(e.valor), tc,
    };
    const tot = { MXN: { subtotal: 0, iva: 0, total: 0 }, USD: { subtotal: 0, iva: 0, total: 0 } };
    const partidas = (cot.partidas || []).map((p) => {
      const cantidad = num(p.cantidad), precio = num(p.precio), iva = num(p.iva);
      const moneda = p.moneda === 'USD' ? 'USD' : 'MXN';
      let importe = 0, error = '';
      if (p.tipo === 'formula' && String(p.formula || '').trim()) {
        try { importe = evaluar(compilar(p.formula), { ...base, precio, cantidad }); }
        catch (err) { error = err.message; }
      } else importe = cantidad * precio;
      importe = r2(importe);
      const ivaMonto = r2(importe * iva / 100);
      tot[moneda].subtotal += importe; tot[moneda].iva += ivaMonto;
      return { ...p, moneda, importe, iva_monto: ivaMonto, error };
    });
    for (const m of ['MXN', 'USD']) {
      tot[m].subtotal = r2(tot[m].subtotal); tot[m].iva = r2(tot[m].iva);
      tot[m].total = r2(tot[m].subtotal + tot[m].iva);
    }
    const granMXN = tc > 0 ? r2(tot.MXN.total + tot.USD.total * tc) : null;
    const granUSD = tc > 0 ? r2(tot.USD.total + tot.MXN.total / tc) : null;
    return { partidas, totales: tot, granMXN, granUSD, vars: base };
  }

  return { compilar, evaluar, variablesDe, calcular, VARIABLES, FUNCIONES: Object.keys(FUNCIONES) };
});
