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

  // Variables que cualquier fórmula puede usar
  const VARIABLES = [
    ['precio', 'Tarifa del concepto'],
    ['tc', 'Tipo de cambio (MXN por USD)'],
    ['valor_usd', 'Valor de la mercancía en dólares'],
    ['valor_mxn', 'Valor de la mercancía en pesos (valor_usd × tipo de cambio)'],
    ['valor_aduana', 'Valor en aduana (MXN)'],
  ];

  const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
  const num = (x) => { const n = parseFloat(String(x ?? '').replace(/[,$\s]/g, '')); return Number.isFinite(n) ? n : 0; };
  const vacio = (x) => String(x ?? '').trim() === '';

  // Calcula la sección de impuestos aduanales. Valor aduana e IVA se calculan solos si se dejan vacíos.
  // `informativo`: los incrementables solo se muestran (no suman al valor aduana). Hoy aplica a todos los tipos.
  function calcularImpuestos(imp = {}, tcGeneral = 0, informativo = false) {
    const tc = vacio(imp.tc) ? tcGeneral : num(imp.tc);
    const valorUsd = num(imp.valor_usd), incr = informativo ? 0 : num(imp.incrementables);
    const vaAuto = Math.round(valorUsd * tc + incr);
    const valorAduana = vacio(imp.valor_aduana) ? vaAuto : num(imp.valor_aduana);
    const igi = num(imp.igi), dta = num(imp.dta);
    const ivaAuto = Math.round((valorAduana + igi + dta) * 0.16);
    const iva = vacio(imp.iva) ? ivaAuto : num(imp.iva);
    const prev = num(imp.prevalidacion), contra = num(imp.contraprestacion);
    return { tc, valorUsd, incrementables: incr, vaAuto, valorAduana, igi, dta, ivaAuto, iva, prevalidacion: prev, contraprestacion: contra,
      total: r2(igi + dta + iva + prev + contra) };
  }

  // Calcula montos y totales de una cotización.
  function calcular(cot) {
    const tc = num(cot.tc);
    const terrestre = true;   // en todos los tipos de cotización los incrementables son solo informativos
    const imp = calcularImpuestos(cot.impuestos || {}, tc, terrestre);
    const vars = { tc, valor_usd: imp.valorUsd, valor_mxn: r2(imp.valorUsd * imp.tc), valor_aduana: imp.valorAduana };
    const cargos = { USD: 0, MXN: 0 };
    const partidas = (cot.cargos || []).map((p) => {
      const moneda = p.moneda === 'USD' ? 'USD' : 'MXN';
      let monto = 0, error = '';
      if (p.tipo === 'formula' && String(p.formula || '').trim()) {
        try { monto = evaluar(compilar(p.formula), { ...vars, precio: num(p.precio) }); }
        catch (err) { error = err.message; }
      } else monto = num(p.monto);
      monto = r2(monto);
      cargos[moneda] += monto;
      return { ...p, moneda, monto, error };
    });
    cargos.USD = r2(cargos.USD); cargos.MXN = r2(cargos.MXN);
    // Terrestre: los incrementables son el desglose de cargos convertido a pesos. Solo informativo:
    // no entran al valor aduana, al IVA ni a ningún total (el desglose ya se suma por su lado).
    if (terrestre) { imp.incrementables = r2(cargos.USD * imp.tc + cargos.MXN); imp.incrInformativo = true; }
    const totalMXN = r2(cargos.MXN + imp.total);           // todo lo que se cobra en pesos
    const granMXN = tc > 0 ? r2(totalMXN + cargos.USD * tc) : null;
    const granUSD = tc > 0 ? r2(cargos.USD + totalMXN / tc) : null;
    return { partidas, cargos, impuestos: imp, totalMXN, totalUSD: cargos.USD, granMXN, granUSD, vars };
  }

  return { compilar, evaluar, variablesDe, calcular, calcularImpuestos, VARIABLES, FUNCIONES: Object.keys(FUNCIONES) };
});
