/*!
 * analisis.js — Análisis de espacio, capacidad, movimiento y escenarios de un almacén,
 * con fórmula y números sustituidos visibles.
 *
 * UMD sin DOM: `window.AlmacenAnalisis` / `module.exports`. Usa AlmacenMotor
 * (require('./motor.js') en Node, window.AlmacenMotor en el navegador). No modifica el proyecto.
 *
 * Honestidad: es un análisis de dimensionamiento con datos del proyecto y supuestos declarados
 * (velocidad, segundos por pick, huella de palet). Los escenarios corren la MISMA heurística del
 * motor (no es óptimo). No calcula dinero si no se da `costoHora`. Los umbrales marcados [PROPIO]
 * son criterios de esta herramienta, no normas; los de literatura van como [VERIFICAR].
 */
(function (raiz, fabrica) {
  'use strict';
  if (typeof module === 'object' && module && module.exports) {
    module.exports = fabrica(function () { return require('./motor.js'); });
  } else {
    raiz.AlmacenAnalisis = fabrica(function () { return raiz.AlmacenMotor; });
  }
})(typeof self !== 'undefined' ? self : this, function (cargarMotor) {
  'use strict';

  /* ======================================================================
   * Utilidades
   * ==================================================================== */

  /** Número finito o null. */
  function fin(x) { return typeof x === 'number' && isFinite(x) ? x : null; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function redondear(v, n) { const f = Math.pow(10, n === undefined ? 2 : n); return Math.round(v * f) / f; }
  /** Formato con coma decimal; '—' si no es finito. */
  function f(n, d) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    const dd = d === undefined ? 1 : d;
    return n.toFixed(dd).replace('.', ',');
  }
  function clonar(o) { return JSON.parse(JSON.stringify(o)); }
  function ahora() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }
  function mediana(a) {
    if (!a.length) return null;
    const s = a.slice().sort(function (x, y) { return x - y; });
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function pct(a, b) { return b > 0 ? (100 * a) / b : null; }

  const REF_VERIFICAR = function (t) { return { texto: t, nivel: '[VERIFICAR]' }; };
  const REF_PROPIO = function (t) { return { texto: t, nivel: '[PROPIO]' }; };

  /** Construye una métrica con la forma del contrato. */
  function metrica(id, nombre, valor, unidad, formula, sustitucion, lectura, referencia, estado, extra) {
    const m = {
      id: id, nombre: nombre, valor: fin(valor), unidad: unidad, formula: formula, sustitucion: sustitucion,
      lectura: lectura, referencia: referencia || null, estado: estado || 'info'
    };
    if (extra) for (const k in extra) m[k] = extra[k];
    return m;
  }

  /* ======================================================================
   * Preparación del contexto
   * ==================================================================== */

  /** Opciones con sus valores por defecto (todo supuesto queda rotulado en `supuestos`). Una opción no numérica
   * o fuera de rango se IGNORA con una advertencia (nunca produce NaN ni Infinity en los resultados). */
  function normalizarOpciones(o, cfg, adv) {
    const op = o || {};
    const manual = cfg.equipo === 'manual';
    // devuelve el número válido o null; avisa si se dio un valor inválido
    function leer(k, ok, regla) {
      let v = op[k];
      if (v === undefined || v === null) return null;
      if (typeof v === 'string' && v.trim() !== '') v = Number(v);
      if (typeof v !== 'number' || !isFinite(v) || !ok(v)) {
        if (adv) adv.push('Opción «' + k + '» inválida (' + String(op[k]) + '; debe ser ' + regla + '): se ignoró y se usa el valor por defecto.');
        return null;
      }
      return v;
    }
    const vel = leer('velocidadMs', function (x) { return x > 0; }, 'un número mayor que 0');
    const seg = leer('segPorPick', function (x) { return x >= 0; }, 'un número mayor o igual que 0');
    const per = leer('periodoDias', function (x) { return x > 0; }, 'un número mayor que 0');
    const costo = leer('costoHora', function (x) { return x > 0; }, 'un número mayor que 0');
    const crec = leer('crecimientoPct', function (x) { return x > -100; }, 'un número finito mayor que −100');
    const objetivo = leer('ocupacionObjetivo', function (x) { return x > 0 && x <= 1; }, 'una fracción en (0; 1]');
    const piso = leer('cargaPisoMaxKgM2', function (x) { return x > 0; }, 'un número mayor que 0');
    // v1.1: límites DEL USUARIO (opciones o config del proyecto); null = no afirmar cumplimiento
    function deCfg(k) {
      const v = cfg[k];
      if (v === undefined || v === null || v === '') return null;
      const n = typeof v === 'string' ? Number(v) : v;
      if (typeof n !== 'number' || !isFinite(n) || n <= 0) { if (adv) adv.push('Config «' + k + '» inválida (' + String(v) + '; debe ser un número mayor que 0): se ignoró y no se afirma nada con ese límite.'); return null; }
      return n;
    }
    const evacMax = leer('evacMaxM', function (x) { return x > 0; }, 'un número mayor que 0');
    const anchoEvac = leer('anchoEvacuacionMin', function (x) { return x > 0; }, 'un número mayor que 0');
    const minCo = leer('minCoocurrencias', function (x) { return x >= 1; }, 'un número mayor o igual que 1');
    const topP = leer('topPares', function (x) { return x >= 1; }, 'un número mayor o igual que 1');
    let fechaRef = null;
    if (typeof op.fechaReferencia === 'string' && op.fechaReferencia) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(op.fechaReferencia)) fechaRef = op.fechaReferencia;
      else if (adv) adv.push('Opción «fechaReferencia» inválida (' + op.fechaReferencia + '; debe ser AAAA-MM-DD): se ignoró.');
    }
    return {
      evacMaxM: evacMax !== null ? evacMax : deCfg('evacMaxM'),
      anchoEvacuacionMin: anchoEvac !== null ? anchoEvac : deCfg('anchoEvacuacionMin'),
      minCoocurrencias: minCo !== null ? Math.floor(minCo) : 2,
      topPares: topP !== null ? Math.floor(topP) : 10,
      fechaReferencia: fechaRef,
      sensibilidad: op.sensibilidad === true,
      sensibilidadResultado: op.sensibilidadResultado && typeof op.sensibilidadResultado === 'object' ? op.sensibilidadResultado : null,
      velocidadMs: vel !== null ? vel : (manual ? 1.0 : 1.5),
      velocidadDada: vel !== null,
      segPorPick: seg !== null ? seg : 30,
      segDado: seg !== null,
      periodoDias: per !== null ? per : 30,
      costoHora: costo,
      crecimientoPct: crec,
      ocupacionObjetivo: objetivo !== null ? objetivo : 0.85,
      escenarios: op.escenarios !== false,
      topeMsEscenarios: num(op.topeMsEscenarios, 6000),
      cargaPisoMaxKgM2: piso !== null ? piso : deCfg('cargaPisoMaxKgM2')
    };
  }

  /** Posiciones requeridas por producto (misma regla del motor: ceil(cantidad/unidadesPorUbic), dividido por la capacidad de
   * ubicaciones por posición del tipo —piso/cantilever—; un SKU de cross-docking no ocupa rack; `maximo` usa stockMax). */
  function demanda(productos, capPorTipo, maximo) {
    const vistos = new Map();
    const cap = capPorTipo || {};
    return productos.map(function (p) {
      const upu = num(p.unidadesPorUbic, 0);
      const cant = Math.max(0, num(p.cantidad, 0));
      const sku = String(p.sku);
      const dup = vistos.has(sku);
      vistos.set(sku, true);
      const tipo = p.tipoUbic || 'palet';
      const c = Math.max(1, num(cap[tipo], 1));
      const smOk = typeof p.stockMax === 'number' && isFinite(p.stockMax) && p.stockMax >= 0;
      const ppOk = typeof p.picksPico === 'number' && isFinite(p.picksPico) && p.picksPico >= 0;
      const valido = upu > 0 && !dup;
      const nec = function (u) { return valido ? Math.ceil(Math.ceil(u / upu - 1e-9) / c - 1e-9) : 0; };
      const xd = p.crossdock === true;
      const reqAct = xd ? 0 : nec(cant), reqPico = xd ? 0 : nec(smOk ? p.stockMax : cant);
      const picks = Math.max(0, num(p.picks, 0));
      return {
        sku: sku, familia: p.familia === undefined || p.familia === null ? '' : String(p.familia),
        tipo: tipo, picks: picks, upu: upu,
        req: maximo ? reqPico : reqAct, reqActual: reqAct, reqPico: reqPico, stockMaxDado: smOk, picksPicoDado: ppOk, picksPico: ppOk ? p.picksPico : picks,
        crossdock: xd, valido: valido, duplicado: dup
      };
    });
  }

  /** Nombre de un lote para mostrar: un lote sin nombre no debe verse como «undefined». */
  function nombreLote(x) { return x === undefined || x === null || String(x).trim() === '' ? '(sin nombre)' : String(x); }

  /** ¿Ambos repartos ubican exactamente el mismo número de posiciones de cada SKU? */
  function mismoConjuntoAsignaciones(a, b) {
    const m = new Map();
    a.forEach(function (x) { m.set(x.sku, x.posiciones.length); });
    let ok = true;
    const vistos = new Set();
    b.forEach(function (x) {
      vistos.add(x.sku);
      if ((m.has(x.sku) ? m.get(x.sku) : 0) !== x.posiciones.length) ok = false;
    });
    m.forEach(function (n, k) { if (!vistos.has(k) && n !== 0) ok = false; });
    return ok;
  }

  const COTA_TXT = 'cota superior bajo estos supuestos (no incluyen elevación en racks altos, aceleración ni congestión)';

  /** Niveles de un rack: el motor trata un dato ausente o inválido como 1 nivel. */
  function nivDe(r) { return Math.max(1, (r && r.niveles) | 0); }

  /** Nivel más alto que cada equipo puede servir (hecho físico elemental: transpaleta y manual no elevan). [VERIFICAR con la ficha del equipo] */
  const NIV_MAX_EQUIPO = { manual: 1, transpaleta: 1 };

  /** Mediana de una propiedad de los racks (con valor por defecto). */
  function medianaRacks(racks, fn, def) {
    const v = racks.map(fn).filter(function (x) { return typeof x === 'number' && isFinite(x) && x > 0; });
    const m = mediana(v);
    return m === null ? def : m;
  }

  /** Distancia de un punto a un rack (0 si está dentro) en coordenadas locales. */
  function distARack(r, x, y) {
    const a = ((r.ang || 0) * Math.PI) / 180;
    const c = Math.cos(a), s = Math.sin(a);
    const dx = x - r.cx, dy = y - r.cy;
    const lx = dx * c + dy * s, ly = -dx * s + dy * c;
    const ex = Math.max(Math.abs(lx) - r.largo / 2, 0), ey = Math.max(Math.abs(ly) - r.fondo / 2, 0);
    return Math.hypot(ex, ey);
  }

  /** Áreas reales: contorno (shoelace), huecos, racks y malla caminable. */
  function medirAreas(Mo, proyecto, racks, cfg, adv) {
    const contorno = proyecto.contorno || [];
    const total = contorno.length >= 3 ? Mo.areaPoligono(contorno) : 0;
    let huecos = 0;
    (proyecto.huecos || []).forEach(function (h) { if (h.poly && h.poly.length >= 3) huecos += Mo.areaPoligono(h.poly); });
    const util = Math.max(0, total - huecos);
    let huella = 0;
    racks.forEach(function (r) { huella += num(r.largo, 0) * num(r.fondo, 0); });
    let camin = 0, sinUso = 0, celda = num(cfg.celdaM, 0.5), dividido = false;
    if (total > 0) {
      try {
        const m = Mo.construirMalla(proyecto);
        celda = m.celda;
        let n = 0;
        for (let i = 0; i < m.caminable.length; i++) n += m.caminable[i];
        camin = n * m.celda * m.celda;
        if (n <= 150000 && racks.length) {
          dividido = true;
          const alcance = Math.max(num(cfg.anchoPasillo, 2.4), 0.1);
          const cajas = racks.map(function (r) {
            const rad = (Math.hypot(r.largo, r.fondo) / 2) + alcance;
            return [r.cx - rad, r.cy - rad, r.cx + rad, r.cy + rad];
          });
          let sin = 0;
          for (let iy = 0; iy < m.ny; iy++) {
            for (let ix = 0; ix < m.nx; ix++) {
              if (!m.caminable[iy * m.nx + ix]) continue;
              const x = m.x0 + (ix + 0.5) * m.celda, y = m.y0 + (iy + 0.5) * m.celda;
              let cerca = false;
              for (let k = 0; k < racks.length && !cerca; k++) {
                const b = cajas[k];
                if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
                if (distARack(racks[k], x, y) <= alcance) cerca = true;
              }
              if (!cerca) sin++;
            }
          }
          sinUso = sin * m.celda * m.celda;
        } else if (n > 150000) {
          adv.push('Malla muy grande: no se separó el área sin uso.');
        }
      } catch (e) {
        adv.push('No se pudo construir la malla caminable: ' + e.message);
      }
    }
    return { total: total, huecos: huecos, util: util, racks: huella, circulacion: camin, sinUso: sinUso, sinUsoCalculado: dividido, celda: celda };
  }

  /* ======================================================================
   * Escenarios what-if
   * ==================================================================== */

  /** Corre generarRacksAuto (+ asignar) sobre una copia del proyecto sin racks automáticos. */
  function correrEscenario(Mo, proyecto, def, base, conAsignar) {
    const copia = clonar(proyecto);
    const manuales = (copia.racks || []).filter(function (r) { return r.auto !== true; });
    copia.resultado = null;
    copia.config = Object.assign({}, base.cfg, def.cfg || {});
    copia.racks = manuales;
    const gen = Mo.generarRacksAuto(copia, Object.assign({}, base.genOpts, def.gen || {}));
    const nuevos = gen.racks.map(function (r) {
      const nom = 'G' + r.nombre;
      return Object.assign({}, r, { id: nom, nombre: nom });
    });
    copia.racks = manuales.concat(nuevos);
    // conteo con el MISMO criterio del motor (un dato ausente de niveles/slots vale 1: nunca NaN)
    const posArr = Mo.posicionesDeRacks(copia);
    const pos = posArr.length;
    const capNiv = NIV_MAX_EQUIPO[copia.config.equipo];
    const utiles = capNiv ? posArr.filter(function (q) { return q.nivel <= capNiv; }).length : pos;
    const out = { posiciones: pos, posicionesUtiles: utiles, nivelMaxEquipo: capNiv || null, angulo: gen.resumen.angulo, resultado: null };
    if (conAsignar && (copia.productos || []).length && base.hayPuertas && pos > 0) {
      out.resultado = Mo.asignar(copia, {});
    }
    return out;
  }

  /** Definición de escenarios (cada uno cambia UNA cosa respecto de la configuración actual). */
  function definirEscenarios(Mo, cfg, genOpts, anguloRegen, fuenteGen) {
    const L = [];
    const ancho = cfg.anchoPasillo;
    L.push({ id: 'regenerado', nombre: 'Regenerar con la configuración actual (referencia)', cambio: 'sin cambios; solo vuelve a generar los racks automáticos ' + (fuenteGen || 'con valores por defecto'), cfg: {}, gen: {} });
    Object.keys(Mo.PRESETS_EQUIPO).forEach(function (k) {
      const a = Mo.PRESETS_EQUIPO[k];
      if (k === cfg.equipo || Math.abs(a - ancho) < 1e-9) return;
      L.push({
        id: 'equipo_' + k, nombre: 'Equipo: ' + (Mo.NOMBRES_EQUIPO ? Mo.NOMBRES_EQUIPO[k] : k),
        cambio: 'pasillo de ' + f(ancho, 1) + ' m a ' + f(a, 1) + ' m (valor típico del equipo [VERIFICAR ficha]); NO se verificó el alcance de elevación ni los niveles que el equipo puede servir',
        cfg: { equipo: k, anchoPasillo: a, anchoPasilloCruce: Math.max(2.4, a) }, gen: {}
      });
    });
    [-0.3, 0.3].forEach(function (d) {
      const a = redondear(ancho + d, 2);
      if (a < 1.0) return;
      L.push({
        id: 'pasillo_' + (d > 0 ? 'mas' : 'menos'), nombre: 'Pasillo ' + (d > 0 ? '+' : '−') + '0,3 m',
        cambio: 'ancho de pasillo de ' + f(ancho, 2) + ' m a ' + f(a, 2) + ' m',
        cfg: { anchoPasillo: a, anchoPasilloCruce: Math.max(cfg.anchoPasilloCruce, a) }, gen: {}
      });
    });
    const altoNivel = genOpts.altoNivel || 1.6, altoBase = genOpts.altoBase === undefined ? 0.15 : genOpts.altoBase;
    const nivelesActual = genOpts.niveles || 1;
    if (altoBase + (nivelesActual + 1) * altoNivel <= cfg.alturaLibreNave - cfg.holguraRociadores + 1e-9) {
      L.push({ id: 'nivel_mas', nombre: 'Un nivel más', cambio: 'de ' + nivelesActual + ' a ' + (nivelesActual + 1) + ' niveles', cfg: {}, gen: { niveles: nivelesActual + 1 } });
    }
    const alterna = Math.abs(anguloRegen || 0) < 45 ? 'vertical' : 'horizontal';
    L.push({ id: 'orientacion_' + alterna, nombre: 'Orientación ' + alterna, cambio: 'filas ' + alterna + 'es (ángulo alterno al elegido)', cfg: {}, gen: { orientacion: alterna } });
    const fondo = genOpts.fondo || 1.1;
    const fondoAlt = fondo <= 1.1 ? 1.2 : 1.0;
    L.push({ id: 'fondo_alterno', nombre: 'Fondo de rack ' + f(fondoAlt, 1) + ' m', cambio: 'fondo de ' + f(fondo, 2) + ' m a ' + f(fondoAlt, 2) + ' m', cfg: {}, gen: { fondo: fondoAlt } });
    [6, 10].forEach(function (m) {
      L.push({ id: 'cruce_' + m, nombre: 'Pasillo de cruce cada ' + m + ' módulos', cambio: 'tramos de ' + m + ' módulos (actual: ' + (genOpts.modulosPorTramo || 8) + ')', cfg: {}, gen: { modulosPorTramo: m } });
    });
    return L;
  }

  /* ======================================================================
   * v1.1 — GEOMETRÍA SOBRE LA MALLA (anchos locales, alcance, celdas)
   * ==================================================================== */

  const DX8 = [1, -1, 0, 0, 1, 1, -1, -1];
  const DY8 = [0, 0, 1, -1, 1, -1, 1, -1];
  const RAIZ2 = Math.SQRT2;

  /** Número finito > 0 o null. */
  function numPos(v) { return typeof v === 'number' && isFinite(v) && v > 0 ? v : null; }

  /** Percentil por rango más cercano sobre un arreglo ORDENADO ascendente: elemento ⌈p·n⌉. */
  function percentil(ord, p) {
    const n = ord.length;
    if (!n) return null;
    const k = Math.max(1, Math.min(n, Math.ceil(p * n - 1e-9)));
    return ord[k - 1];
  }
  function media(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null; }

  /** Celda caminable más cercana a (x,y) dentro de `maxDist` m → {idx, d} o null (misma regla que el motor). */
  function celdaCercana(m, x, y, maxDist) {
    const c = m.celda;
    const ix0 = Math.floor((x - m.x0) / c), iy0 = Math.floor((y - m.y0) / c);
    if (ix0 >= 0 && iy0 >= 0 && ix0 < m.nx && iy0 < m.ny && m.caminable[iy0 * m.nx + ix0]) {
      return { idx: iy0 * m.nx + ix0, d: Math.hypot(x - (m.x0 + (ix0 + 0.5) * c), y - (m.y0 + (iy0 + 0.5) * c)) };
    }
    const R = Math.ceil(maxDist / c) + 1;
    let mejor = null;
    for (let r = 1; r <= R; r++) {
      if (mejor && (r - 1) * c > mejor.d + c) break;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const ix = ix0 + dx, iy = iy0 + dy;
          if (ix < 0 || iy < 0 || ix >= m.nx || iy >= m.ny) continue;
          const idx = iy * m.nx + ix;
          if (!m.caminable[idx]) continue;
          const d = Math.hypot(x - (m.x0 + (ix + 0.5) * c), y - (m.y0 + (iy + 0.5) * c));
          if (d <= maxDist && (!mejor || d < mejor.d)) mejor = { idx: idx, d: d };
        }
      }
    }
    return mejor;
  }

  /**
   * Ancho local de paso (m) en cada celda a partir de la cuerda libre que atraviesa la celda: mínimo de las cuerdas
   * horizontal y vertical (en un pasillo recto es exactamente k·celda, de pared a pared; en piso abierto es grande).
   * Una cuerda diagonal solo se usa si es la menor y las dos ortogonales son < 2× ella (pasillo oblicuo): así las
   * esquinas de la nave y las puntas de los racks, donde la diagonal es corta aunque el piso sea abierto, no se
   * confunden con un paso angosto. Resolución ±1 celda. [PROPIO]
   */
  function anchoLocalMalla(m) {
    const nx = m.nx, ny = m.ny, cam = m.caminable, c = m.celda, N = nx * ny;
    function cuerdas(dx, dy, paso) {
      const w = new Float32Array(N).fill(Infinity);
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          if (!cam[iy * nx + ix]) continue;
          const px = ix - dx, py = iy - dy;
          if (px >= 0 && px < nx && py >= 0 && py < ny && cam[py * nx + px]) continue; // no es el inicio de la cuerda
          let n = 0, x = ix, y = iy;
          while (x >= 0 && x < nx && y >= 0 && y < ny && cam[y * nx + x]) { n++; x += dx; y += dy; }
          const len = n * paso;
          x = ix; y = iy;
          for (let k = 0; k < n; k++) { w[y * nx + x] = len; x += dx; y += dy; }
        }
      }
      return w;
    }
    const cx = cuerdas(1, 0, c), cy = cuerdas(0, 1, c), d1 = cuerdas(1, 1, c * RAIZ2), d2 = cuerdas(1, -1, c * RAIZ2);
    const w = new Float32Array(N).fill(Infinity);
    for (let i = 0; i < N; i++) {
      if (!cam[i]) continue;
      let v = Math.min(cx[i], cy[i]);
      const dm = Math.min(d1[i], d2[i]);
      if (dm < v && Math.max(cx[i], cy[i]) <= 2 * dm) v = dm;
      w[i] = v;
    }
    return w;
  }

  /** Celdas alcanzables (8 vecinos, sin cortar esquinas) desde `fuentes`, sin atravesar las celdas de `bloqueo`. */
  function alcanzarMalla(m, fuentes, bloqueo) {
    const nx = m.nx, ny = m.ny, cam = m.caminable;
    const vis = new Uint8Array(nx * ny);
    const pila = new Int32Array(nx * ny);
    let t = 0;
    for (let i = 0; i < fuentes.length; i++) {
      const s = fuentes[i];
      if (!vis[s] && cam[s] && !(bloqueo && bloqueo[s])) { vis[s] = 1; pila[t++] = s; }
    }
    while (t > 0) {
      const u = pila[--t];
      const ux = u % nx, uy = (u - ux) / nx;
      for (let q = 0; q < 8; q++) {
        const vx = ux + DX8[q], vy = uy + DY8[q];
        if (vx < 0 || vy < 0 || vx >= nx || vy >= ny) continue;
        const v = vy * nx + vx;
        if (!cam[v] || vis[v] || (bloqueo && bloqueo[v])) continue;
        if (q >= 4 && (!cam[uy * nx + vx] || !cam[vy * nx + ux])) continue;
        vis[v] = 1; pila[t++] = v;
      }
    }
    return vis;
  }

  /**
   * Propaga a lo largo de la ruta más corta hacia la salida (predecesor de Dijkstra): ancho mínimo de la ruta,
   * longitud de la ruta y longitud con ancho < `limite` (si el usuario lo fijó). Devuelve arreglos por celda.
   */
  function propagarRuta(m, D, ancho, limite) {
    const nx = m.nx, ny = m.ny, cam = m.caminable, c = m.celda, N = nx * ny;
    const idxs = [];
    for (let i = 0; i < N; i++) if (cam[i] && isFinite(D[i])) idxs.push(i);
    idxs.sort(function (a, b) { return D[a] - D[b] || a - b; });
    const wmin = new Float32Array(N).fill(Infinity), lt = new Float32Array(N), ln = new Float32Array(N);
    for (let k = 0; k < idxs.length; k++) {
      const i = idxs[k], ix = i % nx, iy = (i - ix) / nx;
      let mejor = -1, mejorV = Infinity, mejorPaso = 0;
      for (let q = 0; q < 8; q++) {
        const vx = ix + DX8[q], vy = iy + DY8[q];
        if (vx < 0 || vy < 0 || vx >= nx || vy >= ny) continue;
        const j = vy * nx + vx;
        if (!cam[j] || !isFinite(D[j]) || !(D[j] < D[i] - 1e-6)) continue;
        if (q >= 4 && (!cam[iy * nx + vx] || !cam[vy * nx + ix])) continue;
        const paso = q >= 4 ? c * RAIZ2 : c;
        const v = D[j] + paso;
        if (v < mejorV - 1e-9) { mejorV = v; mejor = j; mejorPaso = paso; }
      }
      if (mejor < 0) { wmin[i] = ancho[i]; lt[i] = 0; ln[i] = 0; }
      else {
        wmin[i] = Math.min(ancho[i], wmin[mejor]);
        lt[i] = lt[mejor] + mejorPaso;
        ln[i] = ln[mejor] + (limite !== null && ancho[i] < limite ? mejorPaso : 0);
      }
    }
    return { wmin: wmin, lt: lt, ln: ln };
  }

  /** Fecha ISO estricta 'AAAA-MM-DD' → días enteros desde 1970 (UTC) o null. */
  function diasDeFecha(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const y = +s.slice(0, 4), mo = +s.slice(5, 7), d = +s.slice(8, 10);
    const t = Date.UTC(y, mo - 1, d);
    const dt = new Date(t);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return Math.round(t / 86400000);
  }

  /** Centroide (shoelace) de un polígono. */
  function centroidePoligono(poly) {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const cr = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
      a += cr; cx += (poly[j][0] + poly[i][0]) * cr; cy += (poly[j][1] + poly[i][1]) * cr;
    }
    if (Math.abs(a) < 1e-12) {
      let sx = 0, sy = 0; poly.forEach(function (p) { sx += p[0]; sy += p[1]; });
      return [sx / poly.length, sy / poly.length];
    }
    return [cx / (3 * a), cy / (3 * a)];
  }

  const REF_NORMA_EVAC = '[VERIFICAR RNE A.130 / ITSE] El límite de distancia de evacuación y el ancho mínimo de la ruta los fija USTED (o su inspector ITSE); el programa no los inventa ni afirma cumplimiento.';

  /* ======================================================================
   * A1 — MUELLE Y STAGING
   * ==================================================================== */

  function seccionMuelle(ctx) {
    const Mo = ctx.Mo, P = ctx.P, cfg = ctx.cfg, op = ctx.op, adv = ctx.adv;
    const area = { muelle: 0, staging: 0 }, nZ = { muelle: 0, staging: 0 };
    (P.zonas || []).forEach(function (z) {
      if (z && (z.tipo === 'muelle' || z.tipo === 'staging') && Array.isArray(z.poly) && z.poly.length >= 3) { area[z.tipo] += Mo.areaPoligono(z.poly); nZ[z.tipo]++; }
    });
    const pu = { recepcion: 0, despacho: 0, mixta: 0, salida_emergencia: 0 };
    (P.puertas || []).forEach(function (p) { if (p && pu[p.tipo] !== undefined) pu[p.tipo]++; });
    // se lee la config CRUDA del proyecto (el motor normaliza y descartaría el dato inválido sin avisar); si no, la efectiva
    const crudo = P.config && P.config.muelle && typeof P.config.muelle === 'object' ? P.config.muelle : null;
    const mu = crudo || (cfg.muelle && typeof cfg.muelle === 'object' ? cfg.muelle : {});
    function dato(k) {
      const v = mu[k];
      if (v === undefined || v === null || v === '') return null;
      const n = typeof v === 'string' ? Number(v) : v;
      if (numPos(n) === null) { adv.push('Muelle: «' + k + '» inválido (' + String(v) + '; debe ser un número mayor que 0): se ignoró.'); return null; }
      return n;
    }
    const pRecU = dato('palletsDiaRecepcion'), pDespU = dato('palletsDiaDespacho');
    const diasRec = dato('diasPermanenciaRec'), diasDesp = dato('diasPermanenciaDesp');
    const m2U = dato('m2PorPalet'), fmU = dato('factorManiobra');
    const dRec = diasRec !== null ? diasRec : 1, dDesp = diasDesp !== null ? diasDesp : 1;
    const m2 = m2U !== null ? m2U : 1.2, fm = fmU !== null ? fmU : 1.5;

    // estimación SIN afirmar cuando el usuario no dio los palets/día: 1 palet por entrada/línea (cota superior en picking de cajas)
    let entradas = 0, picks = 0, xd = 0, hayProd = false;
    const vistos = new Set();
    ctx.productos.forEach(function (p) {
      const sku = String(p.sku);
      if (vistos.has(sku) || !(num(p.unidadesPorUbic, 0) > 0)) return;
      vistos.add(sku); hayProd = true;
      const pk = Math.max(0, num(p.picks, 0));
      if (p.crossdock === true) { xd += Math.max(0, num(p.flujoCrossdock, 0)); return; }
      const ent = typeof p.entradas === 'number' && isFinite(p.entradas) ? Math.max(0, p.entradas) : pk * num(cfg.factorEntradas, 0.25);
      entradas += ent; picks += pk;
    });
    const estRec = hayProd && (entradas + xd) > 0 ? (entradas + xd) / op.periodoDias : null;
    const estDesp = hayProd && (picks + xd) > 0 ? (picks + xd) / op.periodoDias : null;
    const pRec = pRecU !== null ? pRecU : estRec, pDesp = pDespU !== null ? pDespU : estDesp;
    // «afirmado» exige los 4 datos del usuario (palets/día de recepción y despacho, m² por palet y factor de maniobra); con cualquier supuesto propio es ESTIMACIÓN
    const supuestosPropios = [];
    if (m2U === null) supuestosPropios.push('m² por palet 1,2 [PROPIO]');
    if (fmU === null) supuestosPropios.push('factor de maniobra 1,5 [PROPIO]');
    const afirmado = pRecU !== null && pDespU !== null && supuestosPropios.length === 0;
    const reqRec = pRec !== null ? pRec * dRec * m2 * fm : null;
    const reqDesp = pDesp !== null ? pDesp * dDesp * m2 * fm : null;
    const reqTot = reqRec !== null && reqDesp !== null ? reqRec + reqDesp : null;
    const disp = area.muelle + area.staging;
    const sinZonas = nZ.muelle + nZ.staging === 0;
    const balance = reqTot !== null ? disp - reqTot : null;
    const balPal = balance !== null ? balance / (m2 * fm) : null;
    const rotRec = pRecU !== null ? ' (dato suyo)' : estRec !== null ? ' (ESTIMADO: ' + f(entradas + xd, 1) + ' entradas + cross-dock por periodo ÷ ' + f(op.periodoDias, 0) + ' días; 1 palet por entrada [VERIFICAR])' : ' (FALTA: palets/día de recepción)';
    const rotDesp = pDespU !== null ? ' (dato suyo)' : estDesp !== null ? ' (ESTIMADO: ' + f(picks + xd, 1) + ' líneas + cross-dock por periodo ÷ ' + f(op.periodoDias, 0) + ' días; 1 palet-equivalente por línea, cota superior en picking de cajas [VERIFICAR])' : ' (FALTA: palets/día de despacho)';
    const supTxt = (m2U === null ? 'huella de palet 1,2×1,0 = 1,2 m² [VERIFICAR]' : 'm² por palet = ' + f(m2, 2) + ' (dato suyo)') + '; ' + (fmU === null ? 'factor de maniobra 1,5 [VERIFICAR / PROPIO: no es norma]' : 'factor de maniobra = ' + f(fm, 2) + ' (dato suyo)');
    const rotulo = afirmado ? '' : 'ESTIMACIÓN CON SUPUESTOS (no afirmada). ' + (supuestosPropios.length ? 'Supuestos propios no confirmados: ' + supuestosPropios.join(' y ') + '. ' : '');

    const metricas = [];
    metricas.push(metrica('muelle_puertas', 'Puertas por tipo', (P.puertas || []).length, 'puertas',
      'conteo de puertas por tipo', 'recepción ' + pu.recepcion + ' · despacho ' + pu.despacho + ' · mixta ' + pu.mixta + ' · salida de emergencia ' + pu.salida_emergencia,
      pu.recepcion + pu.mixta === 0 ? 'No hay puerta de recepción ni mixta: la recepción usa las puertas de despacho (regla del motor).' : pu.despacho + pu.mixta === 0 ? 'No hay puerta de despacho ni mixta: el despacho usa las de recepción (regla del motor).' : 'Puertas operativas definidas.', null, 'info', { porTipo: Object.assign({}, pu) }));
    metricas.push(metrica('staging_req_rec', 'Área de staging requerida — recepción', reqRec, 'm²',
      'A_rec = palets/día × días de permanencia × m²/palet × factor de maniobra',
      pRec !== null ? f(pRec, 1) + rotRec + ' × ' + f(dRec, 1) + ' d × ' + f(m2, 2) + ' × ' + f(fm, 2) + ' = ' + f(reqRec, 1) + ' m²; ' + supTxt : 'FALTA: palets/día de recepción',
      rotulo + 'Superficie para dejar la mercadería recibida hasta su ubicación.', REF_VERIFICAR('El factor de maniobra y la huella de palet son valores típicos a confirmar; el área real depende del equipo y la forma de apilar.'), afirmado ? 'info' : 'atencion', { supuesto: !afirmado }));
    metricas.push(metrica('staging_req_desp', 'Área de staging requerida — despacho', reqDesp, 'm²',
      'A_desp = palets/día × días de permanencia × m²/palet × factor de maniobra',
      pDesp !== null ? f(pDesp, 1) + rotDesp + ' × ' + f(dDesp, 1) + ' d × ' + f(m2, 2) + ' × ' + f(fm, 2) + ' = ' + f(reqDesp, 1) + ' m²' : 'FALTA: palets/día de despacho',
      rotulo + 'Superficie para consolidar pedidos antes de cargar.', REF_VERIFICAR('Ídem recepción.'), afirmado ? 'info' : 'atencion', { supuesto: !afirmado }));
    metricas.push(metrica('staging_req_total', 'Área de staging requerida — total', reqTot, 'm²',
      'A_total = A_rec + A_desp', reqTot !== null ? f(reqRec, 1) + ' + ' + f(reqDesp, 1) + ' = ' + f(reqTot, 1) + ' m²' : 'sin datos suficientes',
      rotulo + 'Suma de ambos flujos.', null, 'info', { supuesto: !afirmado }));
    metricas.push(metrica('staging_disponible', 'Área de muelle + staging dibujada', disp, 'm²',
      'A_disp = Σ área de zonas «muelle» + Σ área de zonas «staging» (shoelace)',
      nZ.muelle + ' zona(s) muelle = ' + f(area.muelle, 1) + ' m² + ' + nZ.staging + ' zona(s) staging = ' + f(area.staging, 1) + ' m² → ' + f(disp, 1) + ' m²',
      sinZonas ? 'No hay zonas «muelle» o «staging» en el plano: dibújelas para compararlas con lo requerido.' : 'Superficie dibujada para recibir y despachar.', null, sinZonas ? 'atencion' : 'info'));
    const estB = balance === null ? 'info' : balance < 0 ? (afirmado && !sinZonas ? 'critico' : 'atencion') : 'ok';
    metricas.push(metrica('staging_balance_m2', 'Superávit / déficit de staging', balance, 'm²',
      'Superávit = A_disp − A_total', balance !== null ? f(disp, 1) + ' − ' + f(reqTot, 1) + ' = ' + f(balance, 1) + ' m²' : 'sin datos suficientes',
      balance === null ? 'FALTA dato: palets/día de recepción y despacho (puede indicarlos en config.muelle).' : rotulo + (balance < 0 ? 'DÉFICIT de ' + f(-balance, 1) + ' m²' + (sinZonas ? ' (no hay zonas dibujadas: es el área completa que habría que destinar).' : '.') : 'Superávit de ' + f(balance, 1) + ' m².'),
      null, estB, { supuesto: !afirmado }));
    metricas.push(metrica('staging_balance_palets', 'Superávit / déficit en palets', balPal, 'palets',
      'Δpalets = Δm² / (m²/palet × factor de maniobra)', balPal !== null ? f(balance, 1) + ' / (' + f(m2, 2) + ' × ' + f(fm, 2) + ') = ' + f(balPal, 1) + ' palets' : 'sin datos suficientes',
      balPal === null ? 'FALTA dato.' : rotulo + (balPal < 0 ? 'Faltan lugares para ' + f(-balPal, 1) + ' palets.' : 'Sobra lugar para ' + f(balPal, 1) + ' palets.'), null, estB, { supuesto: !afirmado }));

    // ancho libre frente a cada puerta (cuerda mínima del paso)
    const frente = [];
    const m = ctx.getMalla();
    if (m) {
      const ancho = ctx.getAncho();
      (P.puertas || []).forEach(function (pt) {
        if (!pt || !isFinite(pt.x) || !isFinite(pt.y)) return;
        const cc = celdaCercana(m, pt.x, pt.y, 3);
        frente.push({ puertaId: pt.id, nombre: pt.nombre || pt.id, tipo: pt.tipo, ancho: cc && isFinite(ancho[cc.idx]) ? ancho[cc.idx] : null });
      });
    }
    const minAncho = frente.filter(function (x) { return x.ancho !== null; }).reduce(function (a, x) { return a === null || x.ancho < a.ancho ? x : a; }, null);
    metricas.push(metrica('muelle_ancho_puertas', 'Ancho libre frente a las puertas (mínimo)', minAncho ? minAncho.ancho : null, 'm',
      'ancho = cuerda libre mínima (4 direcciones) en la celda caminable más cercana a la puerta',
      minAncho ? 'mínimo en «' + minAncho.nombre + '» = ' + f(minAncho.ancho, 2) + ' m (de ' + frente.length + ' puerta(s); resolución ± ' + f(m.celda, 2) + ' m)' : 'sin malla o sin puertas',
      'Ancho de paso disponible junto a la puerta según el plano; no es el ancho de la hoja de la puerta (el modelo guarda la puerta como un punto).', REF_PROPIO('Cuerda en la malla caminable; compare con el equipo y con el ancho real de la puerta.'), 'info'));

    return {
      disponible: reqTot !== null || !sinZonas || (P.puertas || []).length > 0,
      afirmado: afirmado, supuestosPropios: supuestosPropios,
      datosUsuario: { palletsDiaRecepcion: pRecU !== null, palletsDiaDespacho: pDespU !== null, m2PorPalet: m2U !== null, factorManiobra: fmU !== null },
      requerido: reqTot === null ? null : { recepcion: reqRec, despacho: reqDesp, total: reqTot, palletsDiaRecepcion: pRec, palletsDiaDespacho: pDesp, diasPermanenciaRec: dRec, diasPermanenciaDesp: dDesp, m2PorPalet: m2, factorManiobra: fm },
      disponibleM2: { muelle: area.muelle, staging: area.staging, total: disp, zonasMuelle: nZ.muelle, zonasStaging: nZ.staging },
      balanceM2: balance, balancePalets: balPal, sinZonas: sinZonas,
      puertas: pu, anchoFrentePuertas: frente, metricas: metricas
    };
  }

  /* ======================================================================
   * A2 — EVACUACIÓN (distancia caminando a la salida, callejones, ancho de ruta, mapa de calor)
   * ==================================================================== */

  /** Pasillos sin salida: la franja frente a la cara de acceso del rack, cortada, deja conectado a las salidas un solo extremo. */
  function detectarCallejones(ctx, m, fuentes, topeMs) {
    const t0 = ahora();
    const out = [], cfg = ctx.cfg;
    const c = m.celda, nx = m.nx, N = nx * m.ny;
    const bloqueo = new Uint8Array(N);
    const firmas = new Map();
    let truncado = false;
    const fuenteSet = new Set(fuentes);
    for (let k = 0; k < ctx.racks.length; k++) {
      if (ahora() - t0 > topeMs) { truncado = true; break; }
      const r = ctx.racks[k];
      if (!(r.largo > 0) || !(r.fondo > 0)) continue;
      const w = Math.max(0.5, num(ctx.Mo.anchoPasilloRack ? ctx.Mo.anchoPasilloRack(r, cfg) : (r.anchoPasillo || cfg.anchoPasillo), cfg.anchoPasillo));
      const a = ((r.ang || 0) * Math.PI) / 180, co = Math.cos(a), si = Math.sin(a);
      const sgn = r.frente === 'B' ? 1 : -1;     // t = sgn·ly crece hacia el pasillo
      const rad = Math.hypot(r.largo / 2 + 2 * c, r.fondo / 2 + w + 2 * c);
      const ix0 = Math.max(0, Math.floor((r.cx - rad - m.x0) / c)), ix1 = Math.min(m.nx - 1, Math.ceil((r.cx + rad - m.x0) / c));
      const iy0 = Math.max(0, Math.floor((r.cy - rad - m.y0) / c)), iy1 = Math.min(m.ny - 1, Math.ceil((r.cy + rad - m.y0) / c));
      const S = [];
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const i = iy * nx + ix;
          if (!m.caminable[i]) continue;
          const dx = m.x0 + (ix + 0.5) * c - r.cx, dy = m.y0 + (iy + 0.5) * c - r.cy;
          const lx = dx * co + dy * si, ly = -dx * si + dy * co;
          const t = sgn * ly;
          if (Math.abs(lx) <= r.largo / 2 && t >= r.fondo / 2 && t <= r.fondo / 2 + w) S.push(i);
        }
      }
      if (S.length < 3) continue;
      let conSalida = false;
      for (let q = 0; q < S.length; q++) { bloqueo[S[q]] = 1; if (fuenteSet.has(S[q])) conSalida = true; }
      if (!conSalida) {
        const vis = alcanzarMalla(m, fuentes, bloqueo);
        const tp = r.fondo / 2 + w / 2;
        const extremos = [-1, 1].map(function (e) {
          // se prueban 3 puntos justo después del extremo (un paso de 1 celda también es salida)
          for (let k = 0; k < 3; k++) {
            const lx = e * (r.largo / 2 + (0.3 + 0.5 * k) * c), ly = sgn * tp;
            const x = r.cx + lx * co - ly * si, y = r.cy + lx * si + ly * co;
            const ix = Math.floor((x - m.x0) / c), iy = Math.floor((y - m.y0) / c);
            if (ix < 0 || iy < 0 || ix >= m.nx || iy >= m.ny) continue;
            const i = iy * nx + ix;
            if (m.caminable[i] && vis[i]) return true;
          }
          return false;
        });
        const abiertos = (extremos[0] ? 1 : 0) + (extremos[1] ? 1 : 0);
        if (abiertos === 1) {
          const firma = S.length + ':' + S[0] + ':' + S[S.length - 1];
          const reg = { rackId: r.id, rackNombre: r.nombre || r.id, racks: [r.nombre || r.id], largoM: r.largo, anchoPasilloM: w, extremoCerrado: extremos[0] ? 'fin' : 'inicio', celdas: S.length };
          if (firmas.has(firma)) firmas.get(firma).racks.push(r.nombre || r.id);
          else { firmas.set(firma, reg); out.push(reg); }
        }
      }
      for (let q = 0; q < S.length; q++) bloqueo[S[q]] = 0;
    }
    return { callejones: out, truncado: truncado };
  }

  function seccionEvacuacion(ctx) {
    const Mo = ctx.Mo, P = ctx.P, cfg = ctx.cfg, op = ctx.op, adv = ctx.adv;
    const res = { disponible: false, motivo: null, fuente: 'ninguna', salidas: 0, limites: { evacMaxM: op.evacMaxM, anchoEvacuacionMin: op.anchoEvacuacionMin }, metricas: [], mapa: { muestras: [], celdaM: null, paso: null, maxD: null, truncado: false }, callejones: [], advertencias: [] };
    const puertas = (P.puertas || []).filter(function (p) { return p && isFinite(p.x) && isFinite(p.y); });
    const emer = puertas.filter(function (p) { return p.tipo === 'salida_emergencia'; });
    const m = ctx.getMalla();
    if (!ctx.contornoOk || !m || !puertas.length) {
      res.motivo = !puertas.length ? 'No hay puertas ni salidas de emergencia: no se puede calcular la distancia de evacuación.' : 'No hay un contorno válido.';
      res.metricas.push(metrica('evac_max_pos', 'Distancia de evacuación máxima', null, 'm', 'd = distancia caminando a la salida más cercana', res.motivo, res.motivo, REF_VERIFICAR(REF_NORMA_EVAC), 'info'));
      return res;
    }
    let salidas = emer, fuente = 'salida_emergencia';
    if (!emer.length) {
      salidas = puertas; fuente = 'puertas';
      res.advertencias.push('No hay salida de emergencia marcada: la distancia se mide hasta la puerta más cercana de cualquier tipo. Marque las salidas de emergencia reales (tipo «salida_emergencia») para una lectura válida.');
    }
    res.fuente = fuente; res.salidas = salidas.length;
    const pts = salidas.map(function (p) { return [p.x, p.y]; });
    const D = Mo.distanciasDesde(m, pts);
    const fuentes = [];
    salidas.forEach(function (p) { const cc = celdaCercana(m, p.x, p.y, 3); if (cc) fuentes.push(cc.idx); });
    if (!fuentes.length) {
      res.motivo = 'Ninguna salida está a menos de 3 m de una zona caminable.';
      res.metricas.push(metrica('evac_max_pos', 'Distancia de evacuación máxima', null, 'm', 'd = distancia caminando a la salida más cercana', res.motivo, res.motivo, REF_VERIFICAR(REF_NORMA_EVAC), 'atencion'));
      return res;
    }
    res.disponible = true;
    const ancho = ctx.getAncho();
    const ruta = propagarRuta(m, D, ancho, op.anchoEvacuacionMin);
    const N = m.nx * m.ny;
    // celdas
    const dc = [];
    for (let i = 0; i < N; i++) if (m.caminable[i] && isFinite(D[i])) dc.push(D[i]);
    dc.sort(function (a, b) { return a - b; });
    res.celdas = { n: dc.length, max: dc.length ? dc[dc.length - 1] : null, media: media(dc), p95: percentil(dc, 0.95) };
    // posiciones
    const memo = new Map(), lista = [];
    let inalc = 0;
    ctx.posiciones.forEach(function (q) {
      const k = q.ax + ',' + q.ay;
      let v = memo.get(k);
      if (v === undefined) {
        const cc = celdaCercana(m, q.ax, q.ay, m.celda + 1e-9);
        v = !cc || !isFinite(D[cc.idx]) ? null : { d: D[cc.idx] + cc.d, wmin: ruta.wmin[cc.idx], lt: ruta.lt[cc.idx], ln: ruta.ln[cc.idx] };
        memo.set(k, v);
      }
      if (!v) { inalc++; return; }
      lista.push({ id: q.id, rackId: q.rackId, d: v.d, wmin: v.wmin, lt: v.lt, ln: v.ln });
    });
    const ds = lista.map(function (x) { return x.d; }).sort(function (a, b) { return a - b; });
    let pMax = null;
    lista.forEach(function (x) { if (!pMax || x.d > pMax.d) pMax = x; });
    res.posiciones = { n: lista.length, inalcanzables: inalc, max: ds.length ? ds[ds.length - 1] : null, media: media(ds), p95: percentil(ds, 0.95), maxId: pMax ? pMax.id : null };
    const lim = op.evacMaxM;
    if (lim !== null && lista.length) {
      const n = lista.filter(function (x) { return x.d > lim; }).length;
      res.posiciones.sobreLimite = { n: n, pct: (100 * n) / lista.length, limite: lim };
    } else res.posiciones.sobreLimite = null;
    // ancho de ruta
    const wmins = lista.map(function (x) { return x.wmin; }).filter(isFinite);
    const lAn = op.anchoEvacuacionMin;
    res.holgura = { anchoMinRutas: wmins.length ? Math.min.apply(null, wmins) : null, anchoMedioMinRutas: media(wmins), resolucionM: m.celda, limite: lAn, posicionesConTramoAngosto: null, pctPosicionesConTramoAngosto: null, pctLongitudAngosta: null };
    if (lAn !== null && lista.length) {
      const nA = lista.filter(function (x) { return x.ln > 0; }).length;
      const sLn = lista.reduce(function (s, x) { return s + x.ln; }, 0), sLt = lista.reduce(function (s, x) { return s + x.lt; }, 0);
      res.holgura.posicionesConTramoAngosto = nA;
      res.holgura.pctPosicionesConTramoAngosto = (100 * nA) / lista.length;
      res.holgura.pctLongitudAngosta = sLt > 0 ? (100 * sLn) / sLt : 0;
    }
    // callejones
    const cal = detectarCallejones(ctx, m, fuentes, 1500);
    res.callejones = cal.callejones.map(function (cj) {
      const ids = new Set(); ctx.racks.forEach(function (r) { if (cj.racks.indexOf(r.nombre || r.id) >= 0) ids.add(r.id); });
      const ps = lista.filter(function (x) { return ids.has(x.rackId); });
      return Object.assign({}, cj, { posiciones: ps.length, evacMaxM: ps.length ? Math.max.apply(null, ps.map(function (x) { return x.d; })) : null });
    });
    res.callejonesTruncado = cal.truncado;
    if (cal.truncado) res.advertencias.push('La búsqueda de pasillos sin salida se truncó por tiempo: la lista puede estar incompleta.');
    // mapa de calor: ≈ 1 muestra por m², tope 6000
    let paso = Math.max(1, Math.round(1 / m.celda));
    function contar(s) { let n = 0; for (let iy = 0; iy < m.ny; iy += s) for (let ix = 0; ix < m.nx; ix += s) { const i = iy * m.nx + ix; if (m.caminable[i] && isFinite(D[i])) n++; } return n; }
    while (contar(paso) > 6000) paso++;
    const mu = [];
    for (let iy = 0; iy < m.ny; iy += paso) for (let ix = 0; ix < m.nx; ix += paso) {
      const i = iy * m.nx + ix;
      if (!m.caminable[i] || !isFinite(D[i])) continue;
      mu.push({ x: redondear(m.x0 + (ix + 0.5) * m.celda, 2), y: redondear(m.y0 + (iy + 0.5) * m.celda, 2), d: redondear(D[i], 1) });
    }
    res.mapa = { muestras: mu, celdaM: m.celda, paso: paso, maxD: res.celdas.max === null ? null : redondear(res.celdas.max, 1), truncado: paso > Math.max(1, Math.round(1 / m.celda)) };

    // métricas
    const REF = REF_VERIFICAR(REF_NORMA_EVAC);
    const fz = fuente === 'salida_emergencia' ? salidas.length + ' salida(s) de emergencia' : salidas.length + ' puerta(s) (no hay salida de emergencia marcada)';
    const P_ = res.posiciones;
    res.metricas.push(metrica('evac_max_pos', 'Distancia de evacuación máxima (posiciones)', P_.max, 'm',
      'd_evac = distancia caminando (Dijkstra sobre la malla) desde el punto de acceso de la posición hasta la salida más cercana',
      P_.n ? 'de ' + P_.n + ' posiciones → máx = ' + f(P_.max, 1) + ' m en ' + P_.maxId + '; ' + fz + (inalc ? '; ' + inalc + ' sin ruta' : '') : 'sin posiciones con ruta',
      lim === null ? 'Solo se muestra el valor: sin su límite (evacMaxM) el programa no dice si cumple.' : (P_.sobreLimite && P_.sobreLimite.n > 0 ? 'Hay posiciones por encima del límite que usted fijó (' + f(lim, 1) + ' m).' : 'Ninguna posición supera el límite que usted fijó (' + f(lim, 1) + ' m); validar igualmente con ITSE.'),
      REF, lim !== null && P_.sobreLimite && P_.sobreLimite.n > 0 ? 'critico' : 'info'));
    res.metricas.push(metrica('evac_media_pos', 'Distancia de evacuación media (posiciones)', P_.media, 'm',
      'd̄ = Σ d_evac / n', P_.n ? f(P_.media, 1) + ' m (n = ' + P_.n + ')' : 'sin datos', 'Promedio sobre todas las posiciones (ocupadas o no).', REF, 'info'));
    res.metricas.push(metrica('evac_p95_pos', 'Distancia de evacuación p95 (posiciones)', P_.p95, 'm',
      'p95 = elemento ⌈0,95·n⌉ de las distancias ordenadas (rango más cercano)', P_.n ? 'n = ' + P_.n + ', elemento ' + Math.max(1, Math.ceil(0.95 * P_.n - 1e-9)) + ' → ' + f(P_.p95, 1) + ' m' : 'sin datos', 'El 95 % de las posiciones está a esa distancia o menos.', REF, 'info'));
    res.metricas.push(metrica('evac_celdas', 'Distancia de evacuación en el piso caminable (máx.)', res.celdas.max, 'm',
      'd(celda) = distancia caminando a la salida más cercana', res.celdas.n + ' celdas → máx = ' + f(res.celdas.max, 1) + ' m; media = ' + f(res.celdas.media, 1) + ' m; p95 = ' + f(res.celdas.p95, 1) + ' m',
      'Mide todo el piso caminable, no solo las posiciones (base del mapa de calor).', REF, 'info'));
    res.metricas.push(metrica('evac_sobre_limite', 'Posiciones sobre su límite de evacuación', P_.sobreLimite ? P_.sobreLimite.pct : null, '%',
      '% = posiciones con d_evac > evacMaxM / posiciones con ruta · 100',
      P_.sobreLimite ? P_.sobreLimite.n + ' / ' + P_.n + ' = ' + f(P_.sobreLimite.pct, 1) + ' % (límite suyo: ' + f(lim, 1) + ' m)' : 'FALTA: su límite de distancia de evacuación (evacMaxM)',
      lim === null ? 'Sin su límite no se calcula ni se afirma cumplimiento.' : 'Compara con el límite que usted fijó; no es una verificación normativa.', REF, P_.sobreLimite && P_.sobreLimite.n > 0 ? 'critico' : 'info'));
    res.metricas.push(metrica('evac_callejones', 'Pasillos sin salida (callejones)', res.callejones.length, 'pasillos',
      'callejón = franja de acceso de un rack que, al cortarla, queda conectada a las salidas por un solo extremo',
      res.callejones.length ? res.callejones.map(function (cj) { return cj.racks.join('/') + ' (' + f(cj.largoM, 1) + ' m, cerrado al ' + cj.extremoCerrado + ')'; }).slice(0, 5).join('; ') : 'ninguno detectado',
      res.callejones.length ? 'Estos pasillos tienen un único camino de salida: la persona que está al fondo debe recorrer todo el pasillo.' : 'Todos los pasillos de acceso tienen conexión por ambos extremos.',
      REF, res.callejones.length ? 'atencion' : 'ok'));
    res.metricas.push(metrica('evac_ancho_ruta', 'Ancho mínimo en las rutas de evacuación', res.holgura.anchoMinRutas, 'm',
      'ancho = cuerda libre mínima (0°, 90°, 45°, 135°); se toma el mínimo a lo largo de la ruta más corta de cada posición',
      res.holgura.anchoMinRutas !== null ? 'mínimo = ' + f(res.holgura.anchoMinRutas, 2) + ' m; media de los mínimos = ' + f(res.holgura.anchoMedioMinRutas, 2) + ' m (resolución ± ' + f(m.celda, 2) + ' m)' : 'sin rutas',
      lAn === null ? 'Solo se muestra el valor: sin su ancho mínimo (anchoEvacuacionMin) no se compara.' : 'Comparado con el ancho que usted fijó (' + f(lAn, 2) + ' m).', REF,
      lAn !== null && res.holgura.anchoMinRutas !== null && res.holgura.anchoMinRutas < lAn ? 'critico' : 'info'));
    res.metricas.push(metrica('evac_ruta_angosta', 'Rutas con tramos más angostos que su mínimo', res.holgura.pctPosicionesConTramoAngosto, '%',
      '% = posiciones cuya ruta pasa por un tramo con ancho < anchoEvacuacionMin / posiciones con ruta · 100',
      lAn !== null && lista.length ? res.holgura.posicionesConTramoAngosto + ' / ' + lista.length + ' = ' + f(res.holgura.pctPosicionesConTramoAngosto, 1) + ' % de las posiciones; ' + f(res.holgura.pctLongitudAngosta, 1) + ' % de la longitud de las rutas (mínimo suyo: ' + f(lAn, 2) + ' m)' : 'FALTA: su ancho mínimo de pasillo de evacuación (anchoEvacuacionMin)',
      lAn === null ? 'Sin su valor no se calcula ni se afirma cumplimiento.' : 'Fracción de rutas con algún tramo por debajo del mínimo que usted fijó.', REF,
      res.holgura.posicionesConTramoAngosto > 0 ? 'critico' : 'info'));
    return res;
  }

  /* ======================================================================
   * A3 — CARGAS POR MÓDULO Y kg/m²
   * ==================================================================== */

  function seccionCargas(ctx) {
    const Mo = ctx.Mo, P = ctx.P, op = ctx.op, A = ctx.A;
    const asig = ctx.fuenteAsig();
    const out = { disponible: false, motivo: null, fuente: asig ? asig.fuente : null, modulos: [], ranking: [], excedidos: [], metricas: [], aviso: 'La presión real sobre la losa depende de las patas del marco y de la placa del fabricante [VERIFICAR ingeniero estructural]; estos kg/m² son informativos.' };
    if (!asig || !ctx.posiciones.length) {
      out.motivo = 'Sin asignación (faltan puertas, racks o productos): no hay carga asignada que repartir.';
      out.metricas.push(metrica('cargas_modulo_max', 'Carga por módulo (máxima)', null, 'kg', 'P_módulo = Σ kg de las posiciones del módulo', out.motivo, out.motivo, null, 'info'));
      return out;
    }
    const prods = new Map();
    ctx.productos.forEach(function (p) { const k = String(p.sku); if (!prods.has(k)) prods.set(k, p); });
    const rackPorId = new Map(); ctx.racks.forEach(function (r) { if (!rackPorId.has(r.id)) rackPorId.set(r.id, r); });
    // reparto del stock real del SKU entre sus posiciones, llenando en orden (la última queda parcial)
    const porSku = new Map();
    ctx.posiciones.forEach(function (q) { const s = asig.porPosicion[q.id]; if (s !== undefined) { const k = String(s); if (!porSku.has(k)) porSku.set(k, []); porSku.get(k).push(q); } });
    const kgPos = new Map();
    let sinPeso = 0;
    porSku.forEach(function (qs, sku) {
      const p = prods.get(sku);
      if (!p) return;
      const peso = Math.max(0, num(p.pesoUnitKg, 0)), upu = Math.max(0, num(p.unidadesPorUbic, 0));
      if (!(peso > 0)) sinPeso++;
      let resto = Math.max(0, num(p.cantidad, 0));
      qs.forEach(function (q) {
        const cap = (q.capacidadUb > 0 ? q.capacidadUb : 1) * upu;
        const tom = Math.min(resto, cap);
        resto -= tom;
        kgPos.set(q.id, tom * peso);
      });
    });
    const mods = new Map();
    ctx.posiciones.forEach(function (q) {
      const mp = Mo.moduloDePosicion ? Mo.moduloDePosicion(q) : { rackId: q.rackId, modulo: q.modulo };
      const key = String(mp.rackId) + '\u0001' + mp.modulo;
      let e = mods.get(key);
      if (!e) {
        const r = rackPorId.get(mp.rackId);
        e = { rackId: mp.rackId, rackNombre: q.rackNombre, modulo: mp.modulo, kg: 0, capacidadTeoricaKg: 0, posiciones: 0, ocupadas: 0,
          cargaMaxModuloKg: r && numPos(r.cargaMaxModuloKg) !== null ? r.cargaMaxModuloKg : null,
          huellaM2: r && r.modulos > 0 ? (r.largo / Math.max(1, r.modulos | 0)) * r.fondo : null };
        mods.set(key, e);
      }
      e.posiciones++; e.capacidadTeoricaKg += num(q.cargaMaxKg, 0);
      if (kgPos.has(q.id)) { e.ocupadas++; e.kg += kgPos.get(q.id); }
    });
    const lista = Array.from(mods.values()).map(function (e) {
      e.pctModulo = e.cargaMaxModuloKg ? (100 * e.kg) / e.cargaMaxModuloKg : null;
      e.excedido = e.cargaMaxModuloKg ? e.kg > e.cargaMaxModuloKg + 1e-9 : false;
      e.kgM2Huella = e.huellaM2 > 0 ? e.kg / e.huellaM2 : null;
      return e;
    });
    out.modulos = lista;
    out.ranking = lista.slice().sort(function (a, b) { return b.kg - a.kg || (a.rackNombre < b.rackNombre ? -1 : a.rackNombre > b.rackNombre ? 1 : a.modulo - b.modulo); }).slice(0, 10);
    out.excedidos = lista.filter(function (e) { return e.excedido; });
    out.disponible = true;
    const totalKg = lista.reduce(function (s, e) { return s + e.kg; }, 0);
    const top = out.ranking[0] || null;
    const maxHuella = lista.filter(function (e) { return e.kgM2Huella !== null; }).reduce(function (a, e) { return a === null || e.kgM2Huella > a.kgM2Huella ? e : a; }, null);
    const kgPiso = A.util > 0 ? totalKg / A.util : null;
    const limP = op.cargaPisoMaxKgM2;
    out.totalKg = totalKg; out.kgM2Piso = kgPiso; out.maxKgM2Huella = maxHuella ? maxHuella.kgM2Huella : null;
    const lbl = function (e) { return e ? e.rackNombre + ' · módulo ' + e.modulo : '—'; };
    out.metricas.push(metrica('cargas_total_kg', 'Carga total asignada', totalKg, 'kg',
      'P = Σ (unidades en la posición · peso unitario); el stock de cada SKU se reparte llenando sus posiciones en orden',
      lista.reduce(function (s, e) { return s + e.ocupadas; }, 0) + ' posiciones ocupadas → ' + f(totalKg, 0) + ' kg (fuente: asignación ' + asig.fuente + ')' + (sinPeso ? '; ' + sinPeso + ' SKU sin peso unitario cuentan 0 kg' : ''),
      'Peso total del stock asignado.', null, sinPeso ? 'atencion' : 'info'));
    out.metricas.push(metrica('cargas_modulo_max', 'Carga por módulo (máxima)', top ? top.kg : null, 'kg',
      'P_módulo = Σ kg de las posiciones del módulo (todos los niveles y slots)',
      top ? 'máx. en ' + lbl(top) + ' = ' + f(top.kg, 0) + ' kg de ' + f(top.capacidadTeoricaKg, 0) + ' kg de capacidad teórica (Σ cargaMaxKg de sus ' + top.posiciones + ' posiciones); ' + lista.length + ' módulos' : 'sin módulos',
      'Módulo más cargado. La capacidad teórica suma las cargas por posición; la del módulo/bastidor la da la placa del fabricante.', REF_PROPIO('Informativo; sin cargaMaxModuloKg no hay límite del módulo.'), 'info'));
    const conLim = lista.filter(function (e) { return e.cargaMaxModuloKg; });
    const peorPct = conLim.reduce(function (a, e) { return a === null || e.pctModulo > a.pctModulo ? e : a; }, null);
    out.metricas.push(metrica('cargas_modulos_excedidos', 'Módulos sobre su capacidad de placa', conLim.length ? out.excedidos.length : null, 'módulos',
      'excedido ⇔ Σ kg del módulo > cargaMaxModuloKg (dato suyo, placa del fabricante)',
      conLim.length ? out.excedidos.length + ' de ' + conLim.length + ' módulos con límite' + (peorPct ? '; el más cargado: ' + lbl(peorPct) + ' = ' + f(peorPct.kg, 0) + ' / ' + f(peorPct.cargaMaxModuloKg, 0) + ' kg = ' + f(peorPct.pctModulo, 1) + ' %' : '') : 'FALTA: cargaMaxModuloKg en los racks (placa del fabricante)',
      conLim.length ? (out.excedidos.length ? 'Hay módulos por encima de la capacidad que usted declaró.' : 'Ningún módulo supera la capacidad declarada.') : 'Sin el dato de placa no se afirma nada sobre la capacidad del módulo.',
      REF_VERIFICAR('La capacidad del módulo/bastidor es la de la placa del fabricante (depende de la distribución de cargas y de la altura).'), out.excedidos.length ? 'critico' : 'info'));
    out.metricas.push(metrica('cargas_kg_m2_huella', 'Carga por m² de huella (módulo máximo)', maxHuella ? maxHuella.kgM2Huella : null, 'kg/m² de huella',
      'q = Σ kg del módulo / (largo del módulo · fondo)',
      maxHuella ? lbl(maxHuella) + ': ' + f(maxHuella.kg, 0) + ' / ' + f(maxHuella.huellaM2, 2) + ' = ' + f(maxHuella.kgM2Huella, 0) + ' kg/m²' + (limP !== null ? '; límite suyo: ' + f(limP, 0) + ' kg/m²' : '') : 'sin módulos con huella',
      'NO es la presión sobre el piso: la carga baja por las patas del marco, concentrada. ' + (limP === null ? 'Sin cargaPisoMaxKgM2 no se compara con ningún límite.' : 'Se compara con el límite que usted dio, de forma conservadora.'),
      REF_VERIFICAR('Capacidad de la losa y cargas puntuales de las patas: ingeniero estructural.'), limP !== null && maxHuella && maxHuella.kgM2Huella > limP ? 'critico' : 'info'));
    out.metricas.push(metrica('cargas_kg_m2_piso', 'Carga por m² de piso (promedio global)', kgPiso, 'kg/m² de área útil',
      'q_piso = Σ kg asignados / A_útil', kgPiso !== null ? f(totalKg, 0) + ' / ' + f(A.util, 1) + ' = ' + f(kgPiso, 1) + ' kg/m²' : 'sin área útil',
      'Promedio sobre toda el área útil (incluye pasillos). Muy por debajo de lo que carga la losa bajo un rack.', REF_VERIFICAR('Informativo; ingeniero estructural.'), 'info'));
    out.limitePisoDado = limP;
    return out;
  }

  /* ======================================================================
   * A4 — OCUPACIÓN ACTUAL VS PICO
   * ==================================================================== */

  function seccionPico(ctx) {
    const op = ctx.op;
    const out = { disponible: false, motivo: null, porTipo: [], metricas: [], dimensionadoPor: ctx.dimMax ? 'maximo' : 'actual' };
    const conMax = ctx.dem.filter(function (d) { return d.valido && d.crossdock !== true && (d.stockMaxDado || d.picksPicoDado); });
    if (!conMax.length) {
      out.motivo = 'Ningún SKU trae stockMax ni picksPico: el pico es igual a lo actual.';
      out.metricas.push(metrica('pico_posiciones', 'Posiciones en el pico', null, 'posiciones', 'N_pico = Σ ⌈stockMax / (unidadesPorUbic · capacidad)⌉', out.motivo, out.motivo, null, 'info'));
      return out;
    }
    out.disponible = true;
    const tipos = Object.create(null);
    ctx.dem.forEach(function (d) { if (d.valido) tipos[d.tipo] = true; });
    Object.keys(tipos).sort().forEach(function (t) {
      const ds = ctx.dem.filter(function (d) { return d.valido && d.tipo === t && d.crossdock !== true; });
      const act = ds.reduce(function (s, d) { return s + d.reqActual; }, 0), pico = ds.reduce(function (s, d) { return s + d.reqPico; }, 0);
      const info = ctx.capInfo[t] || { disp: 0 };
      const disp = info.disp || 0;
      const defAct = Math.max(0, act - disp), defPico = Math.max(0, pico - disp);
      const ex = ctx.extrasPara(t, defPico);
      out.porTipo.push({ tipo: t, requeridasActual: act, requeridasPico: pico, disponibles: disp, ocupActualPct: disp > 0 ? redondear(100 * act / disp, 1) : null, ocupPicoPct: disp > 0 ? redondear(100 * pico / disp, 1) : null,
        deficitActual: defAct, deficitPico: defPico, m2Adicionales: ex.m2, nivelesAdicionales: ex.nivExtra, nivelesNecesarios: ex.nivNec });
      const est = defPico > 0 ? 'critico' : (disp > 0 && pico / disp > 0.9 ? 'atencion' : 'ok');
      out.metricas.push(metrica('pico_' + t, 'Posiciones actual vs pico (' + t + ')', pico, 'posiciones',
        'N_pico = Σ ⌈⌈stockMax / unidadesPorUbic⌉ / capacidad de ubicación⌉ (stockMax vacío = cantidad)',
        'actual ' + act + ' → pico ' + pico + ' vs ' + disp + ' disponibles: ocupación ' + f(disp > 0 ? 100 * act / disp : null, 1) + ' % → ' + f(disp > 0 ? 100 * pico / disp : null, 1) + ' %' + (defPico > 0 ? '; déficit en el pico = ' + pico + ' − ' + disp + ' = ' + defPico + (ex.m2 !== null && ex.m2 > 0 ? ' (≈ ' + f(ex.m2, 1) + ' m² al rendimiento propio del tipo)' : '') + (ex.nivExtra > 0 ? '; o +' + ex.nivExtra + ' nivel(es)' : '') : ''),
        defPico > 0 ? 'En el pico faltan ' + defPico + ' posiciones de ' + t + '.' : 'El pico cabe en las posiciones existentes.', null, est));
    });
    let pk = 0, pkPico = 0, nPk = 0;
    ctx.dem.forEach(function (d) { if (d.valido && d.crossdock !== true) { pk += d.picks; pkPico += d.picksPico; if (d.picksPicoDado) nPk++; } });
    const ratio = pk > 0 ? pkPico / pk : null;
    out.picks = { actual: pk, pico: pkPico, ratio: ratio };
    out.metricas.push(metrica('pico_picks', 'Picks por periodo: actual vs pico', pkPico, 'líneas/periodo',
      'picks_pico = Σ (picksPico, o picks si está vacío)', f(pk, 0) + ' → ' + f(pkPico, 0) + (ratio !== null ? ' (×' + f(ratio, 2) + ')' : '') + '; ' + nPk + ' SKU con picksPico',
      ratio !== null && ratio > 1 ? 'El trabajo de picking sube ' + f(100 * (ratio - 1), 1) + ' % en el pico (a igual recorrido medio, sube igual el tiempo de caminata).' : 'Sin aumento declarado de picks en el pico.', REF_PROPIO('El recorrido medio del pico podría diferir; no se recalcula.'), 'info'));
    out.recomendar = out.porTipo.some(function (x) { return x.deficitPico > 0; });
    out.conclusion = 'Si las ubicaciones son fijas (cada SKU conserva sus posiciones todo el año), dimensione por el máximo (config.dimensionarPor = «maximo»); si son dinámicas, basta el promedio más un margen.';
    return out;
  }

  /* ======================================================================
   * A5 — CROSS-DOCKING
   * ==================================================================== */

  function seccionCrossdock(ctx) {
    const Mo = ctx.Mo, P = ctx.P, op = ctx.op;
    const out = { disponible: false, motivo: null, skus: [], metricas: [] };
    const xs = ctx.dem.filter(function (d) { return d.valido && d.crossdock === true; });
    if (!xs.length) {
      out.motivo = 'Ningún SKU está marcado como cross-docking.';
      return out;
    }
    out.disponible = true;
    const flujoDe = Object.create(null);
    ctx.productos.forEach(function (p) { if (flujoDe[String(p.sku)] === undefined) flujoDe[String(p.sku)] = numPos(p.flujoCrossdock); });
    out.skus = xs.map(function (d) { return { sku: d.sku, flujo: flujoDe[d.sku] === undefined ? null : flujoDe[d.sku] }; });
    const sinFlujo = out.skus.filter(function (x) { return x.flujo === null; });
    const flujo = out.skus.reduce(function (s, x) { return s + (x.flujo || 0); }, 0);
    out.flujoTotal = flujo; out.sinFlujo = sinFlujo.map(function (x) { return x.sku; });
    const m = ctx.getMalla();
    const puertas = (P.puertas || []).filter(function (p) { return p && isFinite(p.x) && isFinite(p.y); });
    const rec = puertas.filter(function (p) { return p.tipo === 'recepcion' || p.tipo === 'mixta'; });
    const desp = puertas.filter(function (p) { return p.tipo === 'despacho' || p.tipo === 'mixta'; });
    let dRD = null, parRD = null;
    if (m && rec.length && desp.length) {
      rec.forEach(function (r) {
        const camp = Mo.distanciasDesde(m, [[r.x, r.y]]);
        desp.forEach(function (d) {
          if (d === r) return;
          const cc = celdaCercana(m, d.x, d.y, 3);
          if (!cc || !isFinite(camp[cc.idx])) return;
          const v = camp[cc.idx] + cc.d;
          if (dRD === null || v < dRD) { dRD = v; parRD = [r, d]; }
        });
      });
    }
    out.distRecDesp = dRD;
    out.metricas.push(metrica('xd_skus', 'SKU de cross-docking', xs.length, 'SKU',
      'conteo de SKU con crossdock = verdadero', xs.length + ' SKU (' + xs.map(function (d) { return d.sku; }).slice(0, 6).join(', ') + ') no ocupan rack; flujo total declarado = ' + f(flujo, 1) + ' palets/periodo',
      sinFlujo.length ? 'FALTA: flujoCrossdock en ' + sinFlujo.map(function (x) { return x.sku; }).join(', ') + '.' : 'Estos SKU pasan por el muelle sin almacenarse.', null, sinFlujo.length ? 'atencion' : 'info'));
    out.metricas.push(metrica('xd_dist', 'Distancia puerta de recepción → puerta de despacho', dRD, 'm',
      'd = distancia caminando (malla) entre la puerta de recepción y la de despacho más cercanas entre sí',
      dRD !== null ? '«' + (parRD[0].nombre || parRD[0].id) + '» → «' + (parRD[1].nombre || parRD[1].id) + '» = ' + f(dRD, 1) + ' m' : 'FALTA: una puerta de recepción y otra de despacho distintas (o mixtas distintas) con ruta',
      dRD === null ? 'Sin dos puertas distintas no hay recorrido que medir.' : 'Recorrido mínimo que debe hacer un palet que cruza.', null, dRD === null ? 'atencion' : 'info'));
    const metros = dRD !== null && flujo > 0 ? flujo * dRD : null;
    out.metrosPaletPeriodo = metros;
    out.metricas.push(metrica('xd_metros', 'Metros·palet por periodo', metros, 'm·palet/periodo',
      'M = Σ flujoCrossdock · d(recepción→despacho)',
      metros !== null ? f(flujo, 1) + ' palets · ' + f(dRD, 1) + ' m = ' + f(metros, 0) + ' m' + (op.velocidadMs > 0 ? ' → ' + f(metros / op.velocidadMs / 3600, 2) + ' h a ' + f(op.velocidadMs, 1) + ' m/s' : '') : (flujo > 0 ? 'FALTA la distancia' : 'FALTA: flujoCrossdock (palets por periodo)'),
      metros === null ? 'Falta dato.' : 'Trabajo de transporte del cross-docking, un solo sentido; cota inferior (sin esperas ni congestión).', REF_PROPIO('Un palet recorre el trayecto una vez.'), 'info'));
    // staging a mitad de camino: desvío del staging actual respecto del camino directo
    const stagZ = (P.zonas || []).filter(function (z) { return z && z.tipo === 'staging' && Array.isArray(z.poly) && z.poly.length >= 3; });
    let ahorro = null, detalle = null;
    if (m && stagZ.length && parRD && dRD !== null) {
      let mejor = null;
      const dr = Mo.distanciasDesde(m, [[parRD[0].x, parRD[0].y]]), dd = Mo.distanciasDesde(m, [[parRD[1].x, parRD[1].y]]);
      stagZ.forEach(function (z) {
        const c = centroidePoligono(z.poly);
        const cc = celdaCercana(m, c[0], c[1], 3);
        if (!cc) return;
        if (!isFinite(dr[cc.idx]) || !isFinite(dd[cc.idx])) return;
        const tot = dr[cc.idx] + dd[cc.idx] + 2 * cc.d;
        if (!mejor || tot < mejor.tot) mejor = { tot: tot, a: dr[cc.idx] + cc.d, b: dd[cc.idx] + cc.d, nombre: z.nombre || z.id };
      });
      if (mejor) { detalle = mejor; ahorro = Math.max(0, mejor.tot - dRD); }
    }
    out.staging = detalle ? { zona: detalle.nombre, recorridoViaStaging: detalle.tot, desvio: ahorro } : null;
    const ahM = ahorro !== null && flujo > 0 ? ahorro * flujo : null;
    out.ahorroStagingMetros = ahM;
    out.metricas.push(metrica('xd_staging', 'Ahorro al mover el staging al camino directo', ahM, 'm·palet/periodo',
      'ΔM = flujo · [d(recepción→staging) + d(staging→despacho) − d(recepción→despacho)]',
      detalle ? (flujo > 0 ? f(flujo, 1) + ' · [' + f(detalle.a, 1) + ' + ' + f(detalle.b, 1) + ' − ' + f(dRD, 1) + '] = ' + f(ahM, 0) + ' m·palet/periodo' : 'FALTA: flujoCrossdock') : (stagZ.length ? 'no se pudo ubicar el staging en la malla' : 'No hay zona «staging» dibujada: dibújela para medir el desvío'),
      detalle ? (ahorro > 1 ? 'El staging actual obliga a un desvío de ' + f(ahorro, 1) + ' m por palet respecto del camino directo; ubicarlo sobre ese camino lo evitaría.' : 'El staging ya está sobre el camino directo (desvío ≈ 0).') : 'Sin zona staging no se evalúa.', REF_PROPIO('Mover el staging a medio camino no acorta el trayecto total: evita el desvío. Se usa el centroide de la zona.'), ahorro !== null && ahorro > 1 ? 'atencion' : 'info'));
    return out;
  }

  /* ======================================================================
   * A6 — AFINIDAD (co-ocurrencia en pedidos)
   * ==================================================================== */

  /** Respaldo con la misma definición del motor, por si `calcularAfinidad` no existe. */
  function afinidadLocal(pedidos, productos) {
    const conocidos = new Set(productos.map(function (p) { return String(p.sku); }));
    const cntSku = new Map(), cntPar = new Map();
    let N = 0;
    (pedidos || []).forEach(function (ped) {
      const set = new Set();
      ((ped && ped.lineas) || []).forEach(function (l) { if (l && l.sku !== undefined && l.sku !== null && conocidos.has(String(l.sku))) set.add(String(l.sku)); });
      if (!set.size) return;
      N++;
      const arr = Array.from(set).sort();
      arr.forEach(function (s) { cntSku.set(s, (cntSku.get(s) || 0) + 1); });
      for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) { const k = arr[i] + '\u0001' + arr[j]; cntPar.set(k, (cntPar.get(k) || 0) + 1); }
    });
    const pares = [];
    cntPar.forEach(function (c, k) {
      const ab = k.split('\u0001'), ca = cntSku.get(ab[0]), cb = cntSku.get(ab[1]);
      pares.push({ a: ab[0], b: ab[1], coocurrencias: c, soporte: c / N, confianzaAB: c / ca, confianzaBA: c / cb, lift: (c * N) / (ca * cb) });
    });
    pares.sort(function (x, y) { return y.lift - x.lift || y.coocurrencias - x.coocurrencias || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0); });
    return { nPedidos: N, pares: pares, advertencias: [] };
  }

  function seccionAfinidad(ctx) {
    const Mo = ctx.Mo, P = ctx.P, op = ctx.op;
    const out = { disponible: false, motivo: null, nPedidos: 0, pares: [], metricas: [], advertencias: [] };
    const pedidos = Array.isArray(P.pedidos) ? P.pedidos : [];
    if (!pedidos.length) { out.motivo = 'El proyecto no tiene historial de pedidos (proyecto.pedidos): sin él no hay afinidad.'; return out; }
    const af = Mo.calcularAfinidad ? Mo.calcularAfinidad(pedidos, ctx.productos) : afinidadLocal(pedidos, ctx.productos);
    out.nPedidos = af.nPedidos;
    (af.advertencias || []).forEach(function (a) { out.advertencias.push(a); });
    if (af.nPedidos < 30) out.advertencias.push('Muestra pequeña: ' + af.nPedidos + ' pedidos (< 30). Los lift y soportes son poco fiables [VERIFICAR con un historial mayor].');
    const asig = ctx.fuenteAsig(), m = ctx.getMalla();
    const minCo = op.minCoocurrencias, topN = op.topPares;
    const cand = af.pares.filter(function (p) { return p.lift > 1 && p.coocurrencias >= minCo; }).slice(0, topN);
    out.disponible = true;
    out.minCoocurrencias = minCo;
    // distancia real (caminando) entre las posiciones asignadas de cada par
    const ptsDe = new Map();
    if (asig && ctx.posiciones.length) {
      // los puntos de acceso se llevan al centro de su celda caminable: la distancia entre SKU es entre celdas, sin sumar ajustes
      ctx.posiciones.forEach(function (q) {
        const s = asig.porPosicion[q.id];
        if (s === undefined || !m) return;
        const cc = celdaCercana(m, q.ax, q.ay, m.celda + 1e-9);
        if (!cc) return;
        const k = String(s);
        if (!ptsDe.has(k)) ptsDe.set(k, new Map());
        ptsDe.get(k).set(cc.idx, [m.x0 + ((cc.idx % m.nx) + 0.5) * m.celda, m.y0 + (Math.floor(cc.idx / m.nx) + 0.5) * m.celda, cc.idx]);
      });
    }
    const modLens = ctx.racks.filter(function (r) { return r.modulos > 0 && r.largo > 0; }).map(function (r) { return r.largo / Math.max(1, r.modulos | 0); });
    const dObj = mediana(modLens);
    out.distObjetivo = dObj;
    const campos = new Map();
    let evitableHist = 0, calculados = 0;
    out.pares = cand.map(function (p) {
      const e = { a: p.a, b: p.b, coocurrencias: p.coocurrencias, soporte: p.soporte, confianzaAB: p.confianzaAB, confianzaBA: p.confianzaBA, lift: p.lift, distancia: null, metrosEvitablesHistorial: null };
      const pa = ptsDe.get(p.a), pb = ptsDe.get(p.b);
      if (m && pa && pb && dObj !== null) {
        if (!campos.has(p.a)) campos.set(p.a, Mo.distanciasDesde(m, Array.from(pa.values())));
        const campo = campos.get(p.a);
        let best = Infinity;
        pb.forEach(function (pt) { if (isFinite(campo[pt[2]])) best = Math.min(best, campo[pt[2]]); });
        if (isFinite(best)) {
          e.distancia = best;
          e.metrosEvitablesHistorial = p.coocurrencias * Math.max(0, best - dObj);
          evitableHist += e.metrosEvitablesHistorial; calculados++;
        }
      }
      return e;
    });
    out.metrosEvitablesHistorial = calculados ? evitableHist : null;
    out.metrosEvitablesPorPedido = calculados && af.nPedidos > 0 ? evitableHist / af.nPedidos : null;
    out.fuenteAsignacion = asig ? asig.fuente : null;
    out.metricas.push(metrica('afin_pedidos', 'Historial de pedidos', af.nPedidos, 'pedidos',
      'N = pedidos con al menos una línea de SKU conocido', af.nPedidos + ' pedidos; ' + af.pares.length + ' pares co-ocurrentes; ' + cand.length + ' con lift > 1 y ≥ ' + minCo + ' co-ocurrencias',
      af.nPedidos < 30 ? 'Muestra pequeña [VERIFICAR]: no sobre-interprete.' : 'Historial suficiente para una primera lectura.', REF_PROPIO('Ventana mínima de 30 pedidos y ≥ ' + minCo + ' co-ocurrencias son criterios de esta herramienta.'), af.nPedidos < 30 ? 'atencion' : 'info'));
    const top = out.pares[0] || null;
    out.metricas.push(metrica('afin_top_lift', 'Par con mayor afinidad (lift)', top ? top.lift : null, '×',
      'lift = soporte(A,B) / (soporte(A) · soporte(B)) = co-ocurrencias · N / (pedidos con A · pedidos con B)',
      top ? top.a + ' + ' + top.b + ': ' + top.coocurrencias + ' co-ocurrencias en ' + af.nPedidos + ' pedidos → soporte = ' + f(top.soporte, 3) + ', confianza A→B = ' + f(top.confianzaAB, 2) + ', B→A = ' + f(top.confianzaBA, 2) + ', lift = ' + f(top.lift, 2) : 'ningún par con lift > 1 y ≥ ' + minCo + ' co-ocurrencias',
      top ? 'lift > 1: se piden juntos más de lo que daría el azar.' : 'No hay pares que sugieran agrupar.', null, 'info'));
    out.metricas.push(metrica('afin_metros_evitables', 'Metros evitables si los pares se juntaran', out.metrosEvitablesPorPedido, 'm/pedido',
      'ΔM = Σ soporte · máx(0; d_actual − d_objetivo); d_objetivo = módulo adyacente (' + f(dObj, 1) + ' m)',
      calculados ? out.pares.filter(function (e) { return e.distancia !== null; }).slice(0, 3).map(function (e) { return e.a + '+' + e.b + ': ' + f(e.soporte, 3) + ' · (' + f(e.distancia, 1) + ' − ' + f(dObj, 1) + ')'; }).join(' ; ') + ' … → ' + f(out.metrosEvitablesPorPedido, 2) + ' m por pedido (' + f(evitableHist, 0) + ' m en el historial de ' + af.nPedidos + ' pedidos)' : (asig ? 'sin pares con distancia calculable' : 'sin asignación: no hay posiciones que medir'),
      'Caminata que se ahorraría si cada par quedara en módulos contiguos; no incluye el costo de mover ni el conflicto con la rotación ABC.', REF_PROPIO('d_objetivo = largo de un módulo; supone 1 viaje entre los dos SKU por co-ocurrencia.'), 'info'));
    return out;
  }

  /* ======================================================================
   * A7 — PICKING / RESERVA (reposición)
   * ==================================================================== */

  function seccionReposicion(ctx) {
    const Mo = ctx.Mo, P = ctx.P, op = ctx.op;
    const rp = ctx.cfg.reposicion && typeof ctx.cfg.reposicion === 'object' ? ctx.cfg.reposicion : { activa: false };
    const activa = rp.activa === true;
    const out = { disponible: false, activa: activa, motivo: null, comparativa: null, metricas: [], faltaUnidadesPorLinea: [] };
    const multi = ctx.dem.filter(function (d) { return d.valido && d.crossdock !== true && d.req > 1; });
    if (!ctx.rec || !multi.length) {
      out.motivo = !ctx.rec ? 'Sin asignación calculable (faltan puertas, racks o productos).' : 'Ningún SKU ocupa más de una posición: no hay picking/reserva que separar.';
      return out;
    }
    const porSku = new Map(); ctx.productos.forEach(function (p) { if (!porSku.has(String(p.sku))) porSku.set(String(p.sku), p); });
    out.faltaUnidadesPorLinea = multi.filter(function (d) { return !(numPos(porSku.get(d.sku).unidadesPorLinea) !== null); }).map(function (d) { return d.sku; });
    // se corre la otra configuración
    let con = null, sin = null;
    if (activa) con = ctx.rec; else sin = ctx.rec;
    try {
      const c = clonar(P); c.resultado = null; c.config = Object.assign({}, c.config || {}, { reposicion: Object.assign({}, rp, { activa: !activa }) });
      const r = Mo.asignar(c, {});
      if (activa) sin = r; else con = r;
    } catch (e) { out.motivo = 'No se pudo correr la comparación: ' + e.message; return out; }
    const kr = con && con.kpis ? con.kpis.reposicion : null;
    if (!kr || kr.activa !== true) {
      out.motivo = 'El motor no devolvió kpis.reposicion con el modo picking/reserva activo (versión del motor sin esa función).';
      return out;
    }
    out.disponible = true;
    const horasRepos = kr.reposPorPeriodo > 0 && kr.distMediaReposicion > 0 ? (kr.reposPorPeriodo * 2 * kr.distMediaReposicion) / op.velocidadMs / 3600 : 0;
    const cC = con.kpis.costoTotal, cS = sin.kpis.costoTotal;
    // los dos repartos deben ubicar el mismo conjunto de SKU/posiciones; si no, el costo no es comparable (mismo criterio que mejoraPct)
    const mismoConj = !!(con.asignaciones && sin.asignaciones) && mismoConjuntoAsignaciones(con.asignaciones, sin.asignaciones);
    const delta = mismoConj && cS > 0 ? (100 * (cC - cS)) / cS : null;
    if (!mismoConj) ctx.adv.push('Picking/reserva: las corridas con y sin reposición no ubican el mismo conjunto de posiciones (' + (con.kpis.posicionesOcupadas) + ' vs ' + (sin.kpis.posicionesOcupadas) + ' ocupadas; sin ubicar ' + (con.sinUbicar || []).length + ' vs ' + (sin.sinUbicar || []).length + '): el Δ de costo NO es comparable y no se calcula (conviene = indeterminado). Resuelva primero los SKU sin ubicar o libere espacio.');
    out.comparativa = {
      conReposicion: { costoTotal: cC, distMediaPonderada: con.kpis.distMediaPonderada, reposPorPeriodo: kr.reposPorPeriodo, distMediaReposicion: kr.distMediaReposicion, skusConPicking: kr.skusConPicking, horasReposicion: horasRepos },
      sinReposicion: { costoTotal: cS, distMediaPonderada: sin.kpis.distMediaPonderada },
      deltaCostoPct: delta, conviene: delta === null ? null : (delta <= -2 && out.faltaUnidadesPorLinea.length === 0),
      mismoConjunto: mismoConj, sinUbicarCon: (con.sinUbicar || []).length, sinUbicarSin: (sin.sinUbicar || []).length
    };
    out.reposPorPeriodo = kr.reposPorPeriodo; out.distMediaReposicion = kr.distMediaReposicion; out.horasReposicion = horasRepos;
    const falta = out.faltaUnidadesPorLinea.length ? ' [FALTA: unidades por línea de pedido en ' + out.faltaUnidadesPorLinea.length + ' SKU; se supuso 1]' : '';
    out.metricas.push(metrica('repos_por_periodo', 'Reposiciones por periodo', kr.reposPorPeriodo, 'palets-equivalentes/periodo',
      'repos = Σ picks · unidadesPorLinea / unidadesPorUbic (1 unidad por línea si falta el dato)',
      f(kr.reposPorPeriodo, 1) + ' palets-equivalentes/periodo; ' + kr.skusConPicking + ' SKU con picking separado' + falta,
      out.faltaUnidadesPorLinea.length ? 'Cifra provisional: falta unidadesPorLinea y subestima las reposiciones si cada línea saca más de 1 unidad.' : 'Con las unidades por línea declaradas.', null, out.faltaUnidadesPorLinea.length ? 'atencion' : 'info'));
    out.metricas.push(metrica('repos_dist_horas', 'Distancia media y horas de reposición', horasRepos, 'h/periodo',
      'H = repos · 2 · d̄_reserva→picking / v / 3600', f(kr.reposPorPeriodo, 1) + ' · 2 · ' + f(kr.distMediaReposicion, 1) + ' / ' + f(op.velocidadMs, 1) + ' / 3600 = ' + f(horasRepos, 2) + ' h/periodo (solo traslado)',
      'Tiempo de traslado de las reposiciones; no incluye maniobra de carga.', null, 'info'));
    out.metricas.push(metrica('repos_comparativa', 'Costo con vs sin picking/reserva', delta, '%',
      'Δ% = (costo_con − costo_sin) / costo_sin · 100 (mismo costo del motor: m equivalentes por periodo)',
      f(cC, 0) + ' vs ' + f(cS, 0) + (mismoConj ? ' → ' + f(delta, 1) + ' %' : ' → no comparable (conjuntos distintos)') + '; recorrido medio de picks ' + f(con.kpis.distMediaPonderada, 2) + ' vs ' + f(sin.kpis.distMediaPonderada, 2) + ' m',
      !mismoConj ? 'NO COMPARABLE: con y sin picking/reserva se ubican conjuntos distintos de posiciones (' + (con.kpis.posicionesOcupadas) + ' vs ' + (sin.kpis.posicionesOcupadas) + ' ocupadas); el Δ de costo no se calcula y «conviene» queda indeterminado.' : delta === null ? 'Sin costo comparable.' : delta <= -2 ? 'Separar picking y reserva baja el costo bajo estos supuestos.' : delta >= 2 ? 'Separar picking y reserva ENCARECE el costo bajo estos supuestos.' : 'Diferencia pequeña (±2 %).',
      REF_PROPIO('Umbral ±2 % propio. Heurística, no óptimo; la reposición real la define logistica-almacen.'), !mismoConj ? 'atencion' : out.comparativa.conviene ? 'atencion' : 'info'));
    return out;
  }

  /* ======================================================================
   * A8 — LOTES, VENCIMIENTOS Y FEFO
   * ==================================================================== */

  function seccionFefo(ctx) {
    const cfg = ctx.cfg, op = ctx.op;
    const out = { disponible: false, motivo: null, fechaReferencia: null, diasAlerta: null, lotes: [], metricas: [], fefoEnLifo: [], ordenIncumplido: [] };
    const conLotes = [], vistos = new Set();
    ctx.productos.forEach(function (p) {
      const k = String(p.sku);
      if (vistos.has(k)) return; vistos.add(k);
      if ((Array.isArray(p.lotes) && p.lotes.length) || p.fefo === true) conLotes.push(p);
    });
    if (!conLotes.length) { out.motivo = 'Ningún SKU tiene lotes ni está marcado FEFO.'; return out; }
    out.disponible = true;
    const refStr = op.fechaReferencia !== null ? op.fechaReferencia : (typeof cfg.fechaReferencia === 'string' && diasDeFecha(cfg.fechaReferencia) !== null ? cfg.fechaReferencia : null);
    const refD = refStr !== null ? diasDeFecha(refStr) : null;
    out.fechaReferencia = refStr;
    const alerta = numPos(cfg.diasAlertaVencimiento) !== null ? cfg.diasAlertaVencimiento : null;
    out.diasAlerta = alerta;
    let nFechaInval = 0;
    const lotes = [];
    const noCuadran = [];
    conLotes.forEach(function (p) {
      let suma = 0;
      (Array.isArray(p.lotes) ? p.lotes : []).forEach(function (l) {
        if (!l) return;
        const cant = Math.max(0, num(l.cantidad, 0));
        suma += cant;
        let vD = null;
        if (l.vence !== null && l.vence !== undefined && l.vence !== '') { vD = diasDeFecha(String(l.vence)); if (vD === null) nFechaInval++; }
        lotes.push({ sku: String(p.sku), lote: nombreLote(l.lote), cantidad: cant, vence: vD !== null ? String(l.vence) : null, venceD: vD, diasRestantes: vD !== null && refD !== null ? vD - refD : null });
      });
      if (Array.isArray(p.lotes) && p.lotes.length && Math.abs(suma - num(p.cantidad, 0)) > 1e-6) noCuadran.push({ sku: String(p.sku), sumaLotes: suma, cantidad: num(p.cantidad, 0) });
    });
    if (nFechaInval) ctx.adv.push(nFechaInval + ' lote(s) con fecha de vencimiento inválida (se espera AAAA-MM-DD): se ignoró la fecha.');
    out.lotes = lotes.map(function (l) { return { sku: l.sku, lote: l.lote, cantidad: l.cantidad, vence: l.vence, diasRestantes: l.diasRestantes }; });
    out.noCuadran = noCuadran;
    const totalU = lotes.reduce(function (s, l) { return s + l.cantidad; }, 0);
    const conFecha = lotes.filter(function (l) { return l.venceD !== null; });
    out.metricas.push(metrica('fefo_lotes', 'Lotes registrados', lotes.length, 'lotes',
      'conteo de lotes de los SKU con lotes', lotes.length + ' lotes en ' + conLotes.filter(function (p) { return Array.isArray(p.lotes) && p.lotes.length; }).length + ' SKU; ' + conFecha.length + ' con fecha de vencimiento; ' + f(totalU, 0) + ' unidades',
      noCuadran.length ? 'Σ lotes ≠ cantidad en ' + noCuadran.map(function (x) { return x.sku + ' (' + f(x.sumaLotes, 0) + ' vs ' + f(x.cantidad, 0) + ')'; }).slice(0, 5).join(', ') + ': corrija los datos.' : 'Los lotes cuadran con la cantidad de cada SKU.', null, noCuadran.length ? 'atencion' : 'info'));
    if (refD === null) {
      out.motivo = 'Sin fechaReferencia no se calculan días restantes (el análisis nunca lee el reloj). Indique la fecha en la configuración.';
      out.metricas.push(metrica('fefo_vencidos', 'Lotes vencidos', null, 'lotes', 'vencido ⇔ días restantes < 0', 'FALTA: fecha de referencia (config.fechaReferencia)', out.motivo, null, 'atencion'));
    } else {
      const venc = conFecha.filter(function (l) { return l.diasRestantes < 0; });
      const uV = venc.reduce(function (s, l) { return s + l.cantidad; }, 0);
      out.vencidos = venc.map(function (l) { return { sku: l.sku, lote: l.lote, vence: l.vence, diasRestantes: l.diasRestantes, cantidad: l.cantidad }; });
      out.metricas.push(metrica('fefo_vencidos', 'Lotes vencidos', venc.length, 'lotes',
        'vencido ⇔ vence < fecha de referencia (días restantes < 0)', venc.length + ' lotes (' + f(uV, 0) + ' unidades, ' + f(totalU > 0 ? 100 * uV / totalU : null, 1) + ' % del stock con lotes) al ' + refStr,
        venc.length ? 'Stock vencido en el almacén: separar y disponer según el procedimiento de calidad.' : 'No hay lotes vencidos a la fecha de referencia.', null, venc.length ? 'critico' : 'ok'));
      if (alerta === null) {
        out.metricas.push(metrica('fefo_por_vencer', 'Lotes por vencer', null, 'lotes', 'por vencer ⇔ 0 ≤ días restantes ≤ N', 'FALTA: sus días de alerta (diasAlertaVencimiento)', 'Sin su umbral solo se informan los vencidos.', null, 'info'));
      } else {
        const pv = conFecha.filter(function (l) { return l.diasRestantes >= 0 && l.diasRestantes <= alerta; });
        const uP = pv.reduce(function (s, l) { return s + l.cantidad; }, 0);
        const uTot = uP + uV;
        out.porVencer = pv.map(function (l) { return { sku: l.sku, lote: l.lote, vence: l.vence, diasRestantes: l.diasRestantes, cantidad: l.cantidad }; });
        out.pctStockVenceEnN = totalU > 0 ? (100 * uTot) / totalU : null;
        out.metricas.push(metrica('fefo_por_vencer', 'Lotes por vencer', pv.length, 'lotes',
          'por vencer ⇔ 0 ≤ días restantes ≤ N (N = ' + f(alerta, 0) + ', suyo)', pv.length + ' lotes (' + f(uP, 0) + ' unidades); con los vencidos: ' + f(uTot, 0) + ' / ' + f(totalU, 0) + ' = ' + f(out.pctStockVenceEnN, 1) + ' % del stock con vencimiento ≤ ' + f(alerta, 0) + ' días',
          pv.length ? 'Priorizar su salida (FEFO) o promocionarlos.' : 'Ningún lote vence dentro del umbral.', null, pv.length ? 'atencion' : 'ok'));
      }
    }
    // FEFO en ubicaciones LIFO (no debería)
    const asig = ctx.fuenteAsig();
    const fefoSkus = new Set(conLotes.filter(function (p) { return p.fefo === true; }).map(function (p) { return String(p.sku); }));
    if (asig) {
      const lifoPos = new Map(); ctx.posiciones.forEach(function (q) { lifoPos.set(q.id, q.lifo === true); });
      const malos = new Map();
      Object.keys(asig.porPosicion).forEach(function (id) {
        const s = String(asig.porPosicion[id]);
        if (fefoSkus.has(s) && lifoPos.get(id) === true) malos.set(s, (malos.get(s) || 0) + 1);
      });
      malos.forEach(function (n, s) { out.fefoEnLifo.push({ sku: s, posiciones: n }); });
      out.fefoEnLifo.sort(function (a, b) { return a.sku < b.sku ? -1 : 1; });
      out.metricas.push(metrica('fefo_en_lifo', 'SKU FEFO en ubicaciones LIFO', out.fefoEnLifo.length, 'SKU',
        'conteo de SKU con fefo = verdadero que tienen alguna posición con lifo = verdadero',
        fefoSkus.size + ' SKU FEFO; ' + out.fefoEnLifo.length + ' con posiciones LIFO' + (out.fefoEnLifo.length ? ' (' + out.fefoEnLifo.map(function (x) { return x.sku + ': ' + x.posiciones; }).slice(0, 5).join(', ') + ')' : ''),
        out.fefoEnLifo.length ? 'En un carril LIFO el último lote en entrar es el primero en salir: contradice la salida por vencimiento.' : 'Ningún SKU FEFO está en ubicaciones LIFO.', null, out.fefoEnLifo.length ? 'critico' : 'ok'));
      // ¿el lote que vence antes está más cerca del despacho?
      const lpp = asig.lotePorPosicion;
      if (lpp && Object.keys(lpp).length) {
        const porSkuLote = new Map();
        Object.keys(lpp).forEach(function (id) {
          const s = asig.porPosicion[id], q = ctx.posPorId[id], l = lpp[id];
          if (s === undefined || !q || !l || !isFinite(q.dDesp)) return;
          const nl = nombreLote(l.lote);
          const k = String(s) + '\u0001' + nl;
          if (!porSkuLote.has(k)) porSkuLote.set(k, { sku: String(s), lote: nl, vence: l.vence, ds: [] });
          porSkuLote.get(k).ds.push(q.dDesp);
        });
        const porSku = new Map();
        porSkuLote.forEach(function (e) { if (diasDeFecha(e.vence) !== null) { if (!porSku.has(e.sku)) porSku.set(e.sku, []); porSku.get(e.sku).push({ lote: e.lote, venceD: diasDeFecha(e.vence), d: media(e.ds) }); } });
        let evaluados = 0;
        porSku.forEach(function (arr, sku) {
          if (arr.length < 2) return;
          evaluados++;
          arr.sort(function (a, b) { return a.venceD - b.venceD || (a.lote < b.lote ? -1 : 1); });
          for (let i = 1; i < arr.length; i++) if (arr[i].d < arr[i - 1].d - 1e-9) { out.ordenIncumplido.push({ sku: sku, lote: arr[i].lote, venceAntes: arr[i - 1].lote }); break; }
        });
        out.skusEvaluadosOrden = evaluados;
        out.metricas.push(metrica('fefo_orden', 'Lotes ubicados respetando la salida por vencimiento', evaluados ? evaluados - out.ordenIncumplido.length : null, 'SKU',
          'OK ⇔ distancia media al despacho no decrece al ordenar los lotes por vencimiento ascendente',
          evaluados ? (evaluados - out.ordenIncumplido.length) + ' de ' + evaluados + ' SKU con ≥ 2 lotes fechados cumplen' + (out.ordenIncumplido.length ? '; incumplen: ' + out.ordenIncumplido.map(function (x) { return x.sku; }).slice(0, 5).join(', ') : '') : 'ningún SKU con ≥ 2 lotes fechados repartidos en posiciones',
          out.ordenIncumplido.length ? 'En esos SKU un lote que vence después está más cerca del despacho que uno que vence antes.' : 'El lote que vence antes está más cerca del despacho.', null, out.ordenIncumplido.length ? 'atencion' : 'ok'));
      } else {
        out.metricas.push(metrica('fefo_orden', 'Lotes ubicados respetando la salida por vencimiento', null, 'SKU', 'requiere lotePorPosicion del motor', 'la asignación no trae lotePorPosicion (reasigne o actualice el motor)', 'No se pudo evaluar el orden de salida.', null, 'info'));
      }
    }
    return out;
  }

  /* ======================================================================
   * A9 — SENSIBILIDAD DE PARÁMETROS
   * ==================================================================== */

  function firmaAsignacion(porPosicion) {
    const m = new Map();
    Object.keys(porPosicion || {}).forEach(function (id) { const s = String(porPosicion[id]); if (!m.has(s)) m.set(s, []); m.get(s).push(id); });
    const out = new Map();
    m.forEach(function (ids, s) { out.set(s, ids.sort().join('|')); });
    return out;
  }

  const PARAMETROS_SENS = [
    { id: 'penalNivelPalet', nombre: 'Penalización por nivel de altura (palet)', leer: function (c) { return c.penalNivelPalet; }, poner: function (c, v) { c.penalNivelPalet = v; }, lim: [0, Infinity] },
    { id: 'pesoRecepcion', nombre: 'Peso del recorrido desde recepción', leer: function (c) { return c.pesoRecepcion; }, poner: function (c, v) { c.pesoRecepcion = v; }, lim: [0, 1] },
    { id: 'factorEntradas', nombre: 'Entradas estimadas por pick', leer: function (c) { return c.factorEntradas; }, poner: function (c, v) { c.factorEntradas = v; }, lim: [0, Infinity] },
    { id: 'separacionIncompatibles', nombre: 'Separación entre familias incompatibles (m)', leer: function (c) { return c.separacionIncompatibles; }, poner: function (c, v) { c.separacionIncompatibles = v; }, lim: [0, Infinity] },
    { id: 'abc.a', nombre: 'Corte de la clase A (% acumulado de picks)', leer: function (c) { return c.abc && c.abc.a; }, poner: function (c, v) { c.abc = Object.assign({}, c.abc, { a: v }); }, lim: function (c) { return [0.05, (c.abc && c.abc.b !== undefined ? c.abc.b : 0.95) - 0.01]; } },
    { id: 'pesoAfinidad', nombre: 'Peso de la afinidad entre SKU', leer: function (c) { return c.pesoAfinidad; }, poner: function (c, v) { c.pesoAfinidad = v; }, lim: [0, Infinity], soloConPedidos: true },
    { id: 'pesoPesadoKg', nombre: 'Umbral de carga pesada (kg por ubicación)', leer: function (c) { return c.pesoPesadoKg; }, poner: function (c, v) { c.pesoPesadoKg = v; }, lim: [0, Infinity] }
  ];

  /**
   * Sensibilidad de la asignación a los parámetros: ±50 % (y ±25 % si `opciones.fina`) de cada parámetro, corriendo `asignar`
   * por variante. Δcosto = costo de la asignación de la variante EVALUADA con los parámetros base, frente al costo base
   * (cuánto se pierde si se hubiera ajustado el parámetro de otro modo). Presupuesto de tiempo `topeMs` (8 s por defecto).
   */
  function sensibilidad(proyecto, opciones) {
    const t0 = ahora();
    const Mo = cargarMotor();
    const o = opciones || {};
    const P = proyecto || {};
    const adv = [];
    const topeMs = numPos(o.topeMs) !== null ? o.topeMs : 8000;
    const niveles = o.fina === true ? [50, 25] : [50];
    const res = { parametros: [], resumen: [], supuestos: [], advertencias: adv, meta: { tiempoMs: 0, truncado: false, ejecuciones: 0, costoBase: null, umbrales: { skusCambiadosPct: null, deltaCostoPct: 5, skusCambiadosInformativo: true } } };
    res.supuestos.push('Cada parámetro se varía solo (los demás en su valor base) en ±' + niveles.join(' % y ±') + ' %; se corre la misma heurística de asignación del motor (no es óptimo).');
    res.supuestos.push('Δcosto = costo de la asignación de la variante evaluada con los parámetros BASE frente al costo base: mide cuánto se pierde si el parámetro verdadero fuera el base. El costo propio de la variante se informa aparte (costoTotal).');
    res.supuestos.push('«Robusto» = |Δcosto| < 5 % en todas las variaciones COMPARABLES probadas [PROPIO]; es un criterio de esta herramienta, no una norma. El costo manda: el % de SKU que cambian de posición es solo informativo, porque esta heurística (no es óptimo) puede reordenar muchos SKU por un cambio mínimo de un parámetro sin que el costo se mueva.');
    res.supuestos.push('Una variación NO es comparable (queda informativa y no entra al veredicto) si la asignación de la variante incumple una restricción dura del caso base (`violacionesBase` > 0) o si no ubica el mismo conjunto de posiciones por SKU que el caso base: en ambos casos el Δcosto no mide lo mismo.');
    res.supuestos.push('Un Δcosto negativo significa que la asignación de la variante resultó MEJOR que la base con el criterio base: la heurística no es óptima y esa diferencia es ruido del algoritmo, no ahorro asegurado.');
    res.supuestos.push('Si la asignación de una variante incumple una restricción dura del caso base (p. ej. una separación menor), `violacionesBase` > 0 y su Δcosto no es comparable: un parámetro de restricción puede abaratar el costo solo porque permite lo que el caso base prohíbe.');
    res.supuestos.push('Las variaciones se recortan a su rango válido (p. ej. peso de recepción ≤ 1; corte A < corte B); el % real aplicado se informa en cada variación.');
    if (!(P.racks || []).length || !(P.productos || []).length || !(P.puertas || []).length) {
      adv.push('Sin racks, productos o puertas no hay asignación que variar: no se corrió la sensibilidad.');
      res.meta.tiempoMs = Math.round(ahora() - t0);
      return res;
    }
    const base = clonar(P); base.resultado = null;
    const cfgBase = Mo.configEfectiva(base);
    const hayPedidos = Array.isArray(P.pedidos) && P.pedidos.length > 0;
    const lista = PARAMETROS_SENS.filter(function (pr) { return !pr.soloConPedidos || hayPedidos; });
    let rBase;
    try { rBase = Mo.asignar(base, {}); } catch (e) { adv.push('No se pudo asignar el caso base: ' + e.message); res.meta.tiempoMs = Math.round(ahora() - t0); return res; }
    res.meta.ejecuciones = 1;
    res.meta.costoBase = rBase.kpis.costoTotal;
    const firmaBase = firmaAsignacion(rBase.porPosicion);
    const regs = lista.map(function (pr) { const b = pr.leer(cfgBase); return { pr: pr, base: typeof b === 'number' && isFinite(b) ? b : null, variaciones: [] }; });
    regs.forEach(function (rg) { if (rg.base === null) adv.push('«' + rg.pr.id + '» no tiene un valor numérico base: se omitió.'); else if (rg.base === 0) adv.push('«' + rg.pr.id + '» vale 0: una variación porcentual no cambia nada; se omitió.'); });
    let truncado = false;
    outer:
    for (let ni = 0; ni < niveles.length; ni++) {
      for (let i = 0; i < regs.length; i++) {
        const rg = regs[i];
        if (rg.base === null || rg.base === 0) continue;
        const signos = [-1, 1];
        for (let si = 0; si < signos.length; si++) {
          if (ahora() - t0 > topeMs) { truncado = true; break outer; }
          const pct = signos[si] * niveles[ni];
          const lim = typeof rg.pr.lim === 'function' ? rg.pr.lim(cfgBase) : rg.pr.lim;
          let v = rg.base * (1 + pct / 100);
          v = Math.min(lim[1], Math.max(lim[0], v));
          v = redondear(v, 6);
          if (Math.abs(v - rg.base) < 1e-12) continue;
          const c = clonar(P); c.resultado = null;
          c.config = c.config || {};
          rg.pr.poner(c.config, v);
          let r;
          try { r = Mo.asignar(c, {}); } catch (e) { adv.push('Variante ' + rg.pr.id + ' ' + pct + ' %: ' + e.message); continue; }
          res.meta.ejecuciones++;
          let costoBajoBase = null, violaciones = null;
          try {
            const ev = Mo.evaluarAsignacionManual(base, r.porPosicion);
            costoBajoBase = ev.kpis.costoTotal; res.meta.ejecuciones++;
            violaciones = (ev.advertencias || []).filter(function (a) { return /incumple/.test(a); }).length;
          } catch (e) { adv.push('Evaluación de ' + rg.pr.id + ' ' + pct + ' %: ' + e.message); }
          const fv = firmaAsignacion(r.porPosicion);
          let cambiados = 0;
          const claves = new Set(); firmaBase.forEach(function (_, k) { claves.add(k); }); fv.forEach(function (_, k) { claves.add(k); });
          claves.forEach(function (k) { if (firmaBase.get(k) !== fv.get(k)) cambiados++; });
          const nTot = claves.size;
          const delta = costoBajoBase !== null && rBase.kpis.costoTotal > 0 ? (100 * (costoBajoBase - rBase.kpis.costoTotal)) / rBase.kpis.costoTotal : null;
          const mismoConj = !!(rBase.asignaciones && r.asignaciones) && mismoConjuntoAsignaciones(rBase.asignaciones, r.asignaciones);
          const motivoNC = cambiados === 0 ? null : delta === null ? 'sinEvaluar' : (violaciones !== null && violaciones > 0) ? 'violacionesBase' : !mismoConj ? 'conjuntoDistinto' : null;
          rg.variaciones.push({
            valor: v, pct: redondear((100 * (v - rg.base)) / rg.base, 1), pctSolicitado: pct, costoTotal: r.kpis.costoTotal, costoBajoBase: costoBajoBase, violacionesBase: violaciones,
            deltaCostoPct: delta === null ? null : redondear(delta, 3), skusCambiados: cambiados, skusCambiadosPct: nTot > 0 ? redondear((100 * cambiados) / nTot, 1) : 0, mismaAsignacion: cambiados === 0,
            comparable: motivoNC === null, motivoNoComparable: motivoNC
          });
        }
      }
    }
    res.meta.truncado = truncado;
    if (truncado) adv.push('Se truncó la sensibilidad por tiempo (tope ' + f(topeMs / 1000, 0) + ' s): hay parámetros o variaciones sin probar; su veredicto puede ser «indeterminada».');
    regs.forEach(function (rg) {
      if (rg.base === null || rg.base === 0) return;
      const vs = rg.variaciones;
      const completo = vs.length >= 2;
      const comp = vs.filter(function (x) { return x.comparable !== false; });
      const nExc = vs.length - comp.length;
      // informativo: el % de SKU que cambian de posición NO decide el veredicto (la heurística es caótica ante cambios mínimos)
      const maxS = vs.reduce(function (a, x) { return Math.max(a, x.skusCambiadosPct); }, 0);
      const maxD = comp.reduce(function (a, x) { return Math.max(a, x.deltaCostoPct === null ? 0 : Math.abs(x.deltaCostoPct)); }, 0);
      const maxDTodas = vs.reduce(function (a, x) { return Math.max(a, x.deltaCostoPct === null ? 0 : Math.abs(x.deltaCostoPct)); }, 0);
      const nula = vs.length > 0 && vs.every(function (x) { return x.mismaAsignacion; });
      // si la mitad o más de las variaciones no es comparable, un «robusto» no está respaldado: queda sin veredicto (un «sensible» sí vale)
      const robusto = vs.length === 0 || comp.length === 0 ? null : (completo || !truncado) ? (maxD >= 5 ? false : (nExc * 2 >= vs.length ? null : true)) : null;
      const score = comp.length ? maxD / 5 : 0;
      const sens = vs.length === 0 ? 'indeterminada' : nula ? 'nula' : robusto === true ? 'baja' : robusto === null ? 'indeterminada' : (score >= 2 ? 'alta' : 'media');
      const notaSkus = maxS > 0 ? ' Dato informativo: hasta ' + f(maxS, 1) + ' % de los SKU cambian de posición; la heurística es sensible a cambios mínimos y el costo manda, no ese porcentaje.' : '';
      const notaExc = nExc > 0 ? ' ' + nExc + ' variación(es) no comparable(s) (incumplen una restricción del caso base o ubican otro conjunto) quedan como informativas y no entran al veredicto.' : '';
      const lectura = vs.length === 0 ? 'No se probó (tiempo agotado o sin base).' :
        nula ? 'Ninguna variación cambia la asignación: el parámetro no influye en este caso (o su efecto no se activa con estos datos).' :
        comp.length === 0 ? 'Sin veredicto: ninguna variación es comparable con el caso base (incumplen una restricción del caso base o ubican otro conjunto de posiciones).' + notaSkus :
        robusto === true ? 'Robusto: el costo bajo el criterio base cambia hasta ' + f(maxD, 2) + ' % (< 5 % [PROPIO]): el valor exacto no es crítico.' + notaSkus + notaExc :
        robusto === null && comp.length > 0 && (completo || !truncado) ? 'Sin veredicto: la mitad o más de las variaciones no es comparable con el caso base, así que un «robusto» no está respaldado (en las comparables el costo cambia hasta ' + f(maxD, 2) + ' %).' + notaSkus + notaExc :
        robusto === null ? 'Indeterminada por tiempo.' :
        'SENSIBLE: el costo bajo el criterio base cambia hasta ' + f(maxD, 2) + ' % (≥ 5 % [PROPIO]): fije este valor con cuidado y confírmelo con la operación.' + notaSkus + notaExc;
      res.parametros.push({ id: rg.pr.id, nombre: rg.pr.nombre, base: rg.base, variaciones: vs, robusto: robusto, sensibilidad: sens, maxSkusCambiadosPct: maxS, maxDeltaCostoPct: redondear(maxD, 3), maxDeltaCostoPctTodas: redondear(maxDTodas, 3), variacionesComparables: comp.length, variacionesExcluidas: nExc, score: redondear(score, 3), lectura: lectura });
    });
    res.resumen = res.parametros.map(function (p) { return { id: p.id, nombre: p.nombre, sensibilidad: p.sensibilidad, robusto: p.robusto, score: p.score, maxSkusCambiadosPct: p.maxSkusCambiadosPct, maxDeltaCostoPct: p.maxDeltaCostoPct, variacionesExcluidas: p.variacionesExcluidas, lectura: p.lectura }; })
      .sort(function (a, b) { return b.score - a.score || (a.id < b.id ? -1 : 1); });
    res.meta.tiempoMs = Math.round(ahora() - t0);
    return res;
  }

  /* ======================================================================
   * Análisis principal
   * ==================================================================== */

  /**
   * Analiza el proyecto. Devuelve { espacio:{areas, metricas}, capacidad:{porTipo, metricas},
   * movimiento:{metricas}, escenarios, recomendaciones, supuestos, advertencias }.
   */
  function analizar(proyecto, opciones) {
    const t0 = ahora();
    const Mo = cargarMotor();
    const P = proyecto || {};
    const adv = [];
    const cfg = Mo.configEfectiva(P);
    const op = normalizarOpciones(opciones, cfg, adv);
    const racks = P.racks || [];
    const productos = P.productos || [];
    const contornoOk = (P.contorno || []).length >= 3 && Mo.areaPoligono(P.contorno) > 0;
    const hayPuertas = (P.puertas || []).length > 0;
    if (!contornoOk) adv.push('No hay un contorno válido: las áreas y los escenarios quedan en cero o se omiten.');
    if (!hayPuertas) adv.push('No hay puertas: no se pueden calcular distancias, recorridos ni asignación.');
    if (!productos.length) adv.push('No hay productos: capacidad por tipo, movimiento y asignación quedan sin datos.');
    if (!racks.length) adv.push('No hay racks: no hay posiciones de almacenaje.');

    const supuestos = [
      'Velocidad de desplazamiento: ' + f(op.velocidadMs, 1) + ' m/s' + (op.velocidadDada ? ' (dato del usuario)' : ' supuesto por defecto según el equipo (manual 1,0 y resto 1,5 m/s) [VERIFICAR con mediciones en planta]') + '.',
      'Tiempo fijo por pick (búsqueda, toma, registro): ' + f(op.segPorPick, 0) + ' s' + (op.segDado ? ' (dato del usuario)' : ' supuesto [VERIFICAR con cronometraje]') + '.',
      'Los picks del proyecto son líneas de pedido por periodo de ' + f(op.periodoDias, 0) + ' días.',
      'Las horas de recorrido son una ' + COTA_TXT + ': se supone un viaje de ida y vuelta por línea, sin encadenar picks en un mismo recorrido, a velocidad constante.',
      'Huella de palet para la utilización cúbica: 1,2 × 1,0 m (valor típico) [VERIFICAR]; se aplica a todas las posiciones ocupadas, así que en bins sobrestima el volumen.',
      'Ocupación objetivo: ' + f(op.ocupacionObjetivo * 100, 0) + ' % (parámetro; fíjelo con el responsable de almacén).',
      'Cada pick = un viaje de ida y vuelta (single-command). `cantidad` = stock actual por SKU (si la ubicación es fija, use el máximo); `picks` = líneas por periodo de ' + f(op.periodoDias, 0) + ' días, sin estacionalidad.',
      'El «ahorro» compara contra la asignación vigente del proyecto si existe; si no, contra ubicar SIN criterio (orden de ingreso), NO contra la situación real del almacén: puede sobrestimar el ahorro.',
      'NO se calculan: carga admisible del piso/losa, anclaje sísmico, estabilidad ni resistencia de vigas [VERIFICAR con el ingeniero estructural]. Los kg por módulo y kg/m² de huella son informativos, no son presión sobre el piso.',
      'Medidas por defecto [VERIFICAR]: pasillo ' + f(cfg.anchoPasillo, 2) + ' m (orden de magnitud para el equipo «' + cfg.equipo + '»; el real = ancho del equipo + largo del palet + holguras, p. ej. VDMA 15173), flue ' + f(cfg.flue, 2) + ' m (NFPA 13 / ficha), holgura a rociadores ' + f(cfg.holguraRociadores, 2) + ' m (rociador «' + cfg.tipoRociador + '»; NFPA 13 / RNE A.130), perfil de viga ' + f(cfg.perfilViga, 2) + ' m y holgura sobre la carga ' + f(cfg.holguraSobreCarga, 2) + ' m (EN 15620). Cargas máximas por posición = valores por defecto: la real es la placa del fabricante.',
      'La malla de 8 vecinos sobreestima las distancias hasta ~8 % en direcciones oblicuas.',
      'Escenarios: usan la misma heurística de generación de racks y de asignación del motor (no son óptimos); se comparan contra el almacén actual asignado con esa misma lógica.',
      'Los umbrales marcados [PROPIO] son criterios de esta herramienta, no normas; los marcados [VERIFICAR] provienen de práctica o bibliografía a confirmar.'
    ];
    if (op.costoHora === null) supuestos.push('No se dio `costoHora`: el análisis NO calcula valores monetarios.');

    /* ---- datos base ---- */
    const posiciones = racks.length ? Mo.posicionesDeRacks(P) : [];
    // capacidad de ubicaciones por posición, por tipo (piso/cantilever: >1; palet/bin: 1) = mediana de capacidadUb
    const capPorTipo = Object.create(null);
    {
      const por = Object.create(null);
      posiciones.forEach(function (q) { (por[q.tipo] = por[q.tipo] || []).push(q.capacidadUb > 0 ? q.capacidadUb : 1); });
      Object.keys(por).forEach(function (t) { capPorTipo[t] = mediana(por[t]); });
    }
    const dimMax = P.config && P.config.dimensionarPor === 'maximo';
    const dem = demanda(productos, capPorTipo, dimMax);
    const nDup = dem.filter(function (d) { return d.duplicado; }).length;
    if (nDup) adv.push(nDup + ' fila(s) con SKU duplicado se ignoraron en la capacidad y el movimiento (el motor tampoco las asigna): unifique las cantidades.');
    const demValida = dem.filter(function (d) { return d.valido; });
    const nPos = posiciones.length;
    const porTipoDisp = Object.create(null);
    posiciones.forEach(function (q) { porTipoDisp[q.tipo] = (porTipoDisp[q.tipo] || 0) + 1; });
    const A = medirAreas(Mo, P, racks, cfg, adv);

    // distancias, asignación recomendada y estado actual
    let dist = null, rec = null, actual = null, fuenteActual = null;
    let inaccesibles = 0;
    if (contornoOk && hayPuertas && racks.length) {
      try {
        dist = Mo.calcularDistanciasPosiciones(P);
        inaccesibles = dist.posiciones.filter(function (q) { return !q.accesible; }).length;
        if (productos.length) {
          rec = Mo.asignar(P, {});
          const pp = P.resultado && P.resultado.porPosicion;
          if (pp && Object.keys(pp).length) {
            actual = Mo.evaluarAsignacionManual(P, pp);
            fuenteActual = 'asignación vigente del proyecto';
          } else {
            actual = { kpis: { distMediaPonderada: rec.baseline.distMediaPonderada, costoTotal: rec.baseline.costoTotal }, asignaciones: null, baseline: true };
            fuenteActual = 'reparto «sin criterio» (el proyecto aún no tiene asignación)';
          }
        }
      } catch (e) {
        adv.push('No se pudo calcular distancias/asignación: ' + e.message);
      }
    }
    const posPorId = Object.create(null);
    (dist ? dist.posiciones : posiciones).forEach(function (q) { posPorId[q.id] = q; });
    const picksTot = demValida.reduce(function (s, d) { return s + (d.req > 0 ? d.picks : 0); }, 0);

    /* ==================== ESPACIO ==================== */
    const areas = [];
    const pctTotal = function (v) { return pct(v, A.total); };
    areas.push(metrica('area_total', 'Área total del contorno', A.total, 'm²',
      'A = ½·|Σ (xᵢ·yᵢ₊₁ − xᵢ₊₁·yᵢ)| (fórmula del agrimensor)',
      'contorno de ' + (P.contorno || []).length + ' vértices → A = ' + f(A.total, 1) + ' m²',
      'Superficie bruta de la nave medida del polígono trazado.', null, 'info', { pct: 100 }));
    areas.push(metrica('area_huecos', 'Área de huecos (columnas, oficinas, equipos)', A.huecos, 'm²',
      'A_huecos = Σ área(hueco)', (P.huecos || []).length + ' hueco(s) → ' + f(A.huecos, 1) + ' m² (' + f(pctTotal(A.huecos), 1) + ' % del total)',
      'Superficie no caminable ni almacenable.', null, 'info', { pct: fin(pctTotal(A.huecos)) }));
    areas.push(metrica('area_util', 'Área útil', A.util, 'm²',
      'A_útil = A_total − A_huecos', f(A.total, 1) + ' − ' + f(A.huecos, 1) + ' = ' + f(A.util, 1) + ' m²',
      'Superficie disponible para racks y circulación.', null, 'info', { pct: fin(pctTotal(A.util)) }));
    areas.push(metrica('area_racks', 'Huella de racks', A.racks, 'm²',
      'A_racks = Σ largo·fondo', racks.length + ' rack(s) → ' + f(A.racks, 1) + ' m² (' + f(pct(A.racks, A.util), 1) + ' % del área útil)',
      'Superficie ocupada por la estantería.', null, 'info', { pct: fin(pctTotal(A.racks)) }));
    areas.push(metrica('area_circulacion', 'Área de circulación caminable', A.circulacion, 'm²',
      'A_circ = celdas caminables · celda²', 'celda de ' + f(A.celda, 2) + ' m → ' + f(A.circulacion, 1) + ' m² (' + f(pct(A.circulacion, A.util), 1) + ' % del área útil)',
      'Superficie por donde se camina (malla del motor: dentro del contorno, fuera de huecos y racks).', null, 'info', { pct: fin(pctTotal(A.circulacion)) }));
    areas.push(metrica('area_sin_uso', 'Área libre sin uso (a más de un pasillo de cualquier rack)', A.sinUsoCalculado ? A.sinUso : null, 'm²',
      'A_libre = celdas caminables con distancia al rack más cercano > ancho de pasillo · celda²',
      A.sinUsoCalculado ? 'ancho de pasillo ' + f(cfg.anchoPasillo, 2) + ' m → ' + f(A.sinUso, 1) + ' m² (' + f(pct(A.sinUso, A.util), 1) + ' % del área útil)' : 'sin racks o malla demasiado grande: no calculada',
      'Piso abierto que no sirve de pasillo de ningún rack: candidato a ampliar almacenaje, cruce o zona de picking/consolidación.', null,
      A.sinUsoCalculado && pct(A.sinUso, A.util) > 25 ? 'atencion' : 'info', { pct: A.sinUsoCalculado ? fin(pctTotal(A.sinUso)) : null }));
    const residuo = A.util - A.racks - A.circulacion;
    if (A.util > 0 && Math.abs(residuo) / A.util > 0.05) adv.push('El área útil no cierra con racks + circulación (diferencia ' + f(residuo, 1) + ' m², ' + f((100 * residuo) / A.util, 1) + ' %): revise racks que salen del contorno o se solapan, o márgenes de muro/columnas.');

    const met = [];
    const dens = A.util > 0 && nPos > 0 ? nPos / A.util : null;
    met.push(metrica('densidad', 'Densidad de almacenaje', dens, 'posiciones/m²',
      'D = posiciones / A_útil', nPos + ' / ' + f(A.util, 1) + ' = ' + f(dens, 3) + ' pos/m²',
      'Cuántas posiciones de almacenaje rinde cada m² útil; sube con más niveles, menos pasillo o mejor empaque.', null, 'info'));
    met.push(metrica('m2_por_posicion', 'Espacio por posición', dens ? 1 / dens : null, 'm²/posición',
      'e = A_útil / posiciones = 1 / D', f(A.util, 1) + ' / ' + nPos + ' = ' + f(dens ? 1 / dens : null, 3) + ' m²/pos',
      'Inversa de la densidad: superficie útil que "cuesta" cada posición.', null, 'info'));
    const circFactor = A.racks > 0 ? A.circulacion / A.racks : null;
    const F = medianaRacks(racks, function (r) { return r.fondo; }, 1.1);
    // referencia geométrica: un pasillo por cada par de racks espalda con espalda. El flue (separación entre las dos filas)
    // no es rack (A_racks = largo·fondo) ni pasillo caminable: queda fuera de numerador y denominador.
    const circTeorico = F > 0 ? cfg.anchoPasillo / (2 * F) : null;
    met.push(metrica('factor_circulacion', 'Factor de circulación', circFactor, 'm² circulación / m² rack',
      'FC = A_circulación / A_racks', f(A.circulacion, 1) + ' / ' + f(A.racks, 1) + ' = ' + f(circFactor, 2),
      'Cuántos m² de pasillo/circulación hay por cada m² de estantería. Referencia geométrica mínima (un pasillo por cada par de filas espalda con espalda, sin cruces ni perímetro): ancho/(2·fondo) = ' +
        f(cfg.anchoPasillo, 2) + '/(2·' + f(F, 2) + ') = ' + f(circTeorico, 2) + '. El flue (' + f(cfg.flue, 2) + ' m entre las dos filas) no es rack ni pasillo caminable y no entra en la referencia.',
      REF_PROPIO('Se marca «atención» si el factor supera 2 veces la referencia geométrica mínima de la propia configuración; es un criterio de esta herramienta.'),
      circFactor !== null && circTeorico !== null && circFactor > 2 * circTeorico ? 'atencion' : 'info'));
    const utilSup = A.util > 0 ? A.racks / A.util : null;
    met.push(metrica('utilizacion_superficie', 'Utilización de superficie', utilSup === null ? null : utilSup * 100, '%',
      'US = A_racks / A_útil', f(A.racks, 1) + ' / ' + f(A.util, 1) + ' = ' + f(utilSup === null ? null : utilSup * 100, 1) + ' %',
      'Fracción del área útil cubierta por estantería.', REF_VERIFICAR('En almacenes de palets con pasillos para apilador suele hablarse de ~30–45 % de superficie en racks; confirmar en bibliografía antes de usarlo como meta.'),
      utilSup === null ? 'info' : utilSup < 0.2 ? 'atencion' : 'info'));
    // utilización cúbica
    const HUELLA_PALET = 1.2 * 1.0;
    let vol = 0, ocupadasRec = 0;
    if (rec) {
      const altoPorSku = Object.create(null);
      productos.forEach(function (p) { if (altoPorSku[String(p.sku)] === undefined) altoPorSku[String(p.sku)] = Math.max(0, num(p.altoCargaM, 0)); });
      rec.asignaciones.forEach(function (a) { vol += a.posiciones.length * HUELLA_PALET * (altoPorSku[a.sku] || 0); ocupadasRec += a.posiciones.length; });
    }
    const volNave = A.util * cfg.alturaLibreNave;
    const cubica = rec && volNave > 0 ? (vol / volNave) * 100 : null;
    met.push(metrica('utilizacion_cubica', 'Utilización cúbica', cubica, '%',
      'UC = Σ(posiciones ocupadas · 1,2·1,0 m · alto de carga) / (A_útil · altura libre)',
      rec ? f(ocupadasRec, 0) + ' posiciones ocupadas → ' + f(vol, 1) + ' m³ / (' + f(A.util, 1) + ' · ' + f(cfg.alturaLibreNave, 1) + ' = ' + f(volNave, 0) + ' m³) = ' + f(cubica, 1) + ' %' : 'sin asignación calculable (faltan puertas, racks o productos)',
      'Cuánto del volumen de la nave contiene carga. Un valor bajo con superficie ya llena indica altura sin aprovechar.',
      REF_PROPIO('Estimación con huella de palet supuesta de 1,2×1,0 m; no es un volumen medido.'), 'info'));
    // peso por módulo y kg/m² de huella de rack con la asignación recomendada (informativo)
    let pesoInfo = null;
    if (rec && dist) {
      const kgSku = new Map();
      productos.forEach(function (p) {
        const k = String(p.sku);
        if (!kgSku.has(k)) kgSku.set(k, Math.max(0, num(p.unidadesPorUbic, 0)) * Math.max(0, num(p.pesoUnitKg, 0)));
      });
      // se agrupa por IDENTIFICADOR de rack (dos racks pueden compartir nombre); el nombre solo se usa para mostrar
      const porMod = new Map(), porRack = new Map();
      dist.posiciones.forEach(function (q) {
        const sku = rec.porPosicion[q.id];
        if (sku === undefined) return;
        const kg = kgSku.get(String(sku)) || 0;
        const km = String(q.rackId) + '\u0001' + q.modulo;
        const prev = porMod.get(km) || { kg: 0, nombre: q.rackNombre, modulo: q.modulo };
        prev.kg += kg;
        porMod.set(km, prev);
        porRack.set(q.rackId, (porRack.get(q.rackId) || 0) + kg);
      });
      let maxMod = null, sumMod = 0, nMod = 0;
      porMod.forEach(function (v) { if (v.kg > 0) { nMod++; sumMod += v.kg; if (!maxMod || v.kg > maxMod.kg) maxMod = { kg: v.kg, k: v.nombre + ' · módulo ' + v.modulo }; } });
      let maxRack = null, kgTotal = 0;
      porRack.forEach(function (kg, id) {
        kgTotal += kg;
        const r = racks.find(function (x) { return x.id === id; });
        const m2 = r ? r.largo * r.fondo : 0;
        if (m2 > 0 && (!maxRack || kg / m2 > maxRack.v)) maxRack = { v: kg / m2, kg: kg, m2: m2, nombre: r.nombre || r.id };
      });
      pesoInfo = { maxMod: maxMod, medMod: nMod ? sumMod / nMod : null, nMod: nMod, maxRack: maxRack, kgTotal: kgTotal };
    }
    const tieneLimitePiso = op.cargaPisoMaxKgM2 !== null;
    met.push(metrica('peso_modulo', 'Peso por módulo (máximo)', pesoInfo && pesoInfo.maxMod ? pesoInfo.maxMod.kg : null, 'kg/módulo',
      'P_módulo = Σ (unidades por ubicación · peso unitario) de las posiciones del módulo',
      pesoInfo && pesoInfo.maxMod ? 'máximo en ' + pesoInfo.maxMod.k + ' = ' + f(pesoInfo.maxMod.kg, 0) + ' kg; media de ' + pesoInfo.nMod + ' módulos con carga = ' + f(pesoInfo.medMod, 0) + ' kg' : 'sin asignación o sin pesos unitarios',
      'Carga estimada por módulo con la asignación recomendada (cada posición llena). Informativo: compárelo con la capacidad por módulo de la placa del fabricante del rack.',
      REF_PROPIO('Sin límite inventado: la capacidad real la da la placa del fabricante [VERIFICAR].'), 'info'));
    const exceso = tieneLimitePiso && pesoInfo && pesoInfo.maxRack && pesoInfo.maxRack.v > op.cargaPisoMaxKgM2;
    met.push(metrica('kg_m2_huella', 'Carga por m² de huella de rack (máximo)', pesoInfo && pesoInfo.maxRack ? pesoInfo.maxRack.v : null, 'kg/m² de huella',
      'q = Σ peso de las posiciones del rack / (largo · fondo)',
      pesoInfo && pesoInfo.maxRack ? 'rack «' + pesoInfo.maxRack.nombre + '»: ' + f(pesoInfo.maxRack.kg, 0) + ' / ' + f(pesoInfo.maxRack.m2, 1) + ' = ' + f(pesoInfo.maxRack.v, 0) + ' kg/m²' + (A.racks > 0 ? '; total ' + f(pesoInfo.kgTotal, 0) + ' / ' + f(A.racks, 1) + ' = ' + f(pesoInfo.kgTotal / A.racks, 0) + ' kg/m² promedio' : '') + (tieneLimitePiso ? '; límite dado: ' + f(op.cargaPisoMaxKgM2, 0) + ' kg/m²' : '') : 'sin asignación o sin pesos unitarios',
      'NO es la presión sobre el piso: la carga llega a la losa por las patas del marco, concentrada. Sin `cargaPisoMaxKgM2` no se compara con ningún límite.',
      REF_PROPIO('Informativo; la carga admisible del piso/losa la calcula el ingeniero estructural [VERIFICAR].'), exceso ? 'critico' : 'info'));
    if (exceso) adv.push('El rack «' + pesoInfo.maxRack.nombre + '» supera el límite dado (' + f(pesoInfo.maxRack.v, 0) + ' > ' + f(op.cargaPisoMaxKgM2, 0) + ' kg/m² de huella): revise con el ingeniero estructural.');
    const alturaUtil = cfg.alturaLibreNave - cfg.holguraRociadores;
    const racksPalet = racks.filter(function (r) { return (r.tipo || 'palet') === 'palet'; });
    const altoNivel = medianaRacks(racksPalet, function (r) { return r.altoNivel; }, 1.6);
    const altoBase = racksPalet.length ? num(racksPalet[0].altoBase, 0.15) : 0.15;
    const nivMax = Math.max(0, Math.floor((alturaUtil - altoBase + 1e-9) / altoNivel));
    const nivAct = racksPalet.reduce(function (m, r) { return Math.max(m, nivDe(r)); }, 0);
    met.push(metrica('niveles', 'Niveles posibles vs actuales (palet)', nivMax - nivAct, 'niveles sin usar',
      'n_máx = ⌊(H − holgura − altoBase) / altoNivel⌋',
      '⌊(' + f(cfg.alturaLibreNave, 1) + ' − ' + f(cfg.holguraRociadores, 2) + ' − ' + f(altoBase, 2) + ') / ' + f(altoNivel, 2) + '⌋ = ' + nivMax + ' niveles posibles; actuales = ' + nivAct + ' → ' + (nivMax - nivAct) + ' sin usar (altura útil ' + f(alturaUtil, 1) + ' m)',
      nivMax > nivAct ? 'La altura permitiría más niveles: verifique capacidad de viga, alcance del equipo, norma de rociadores y capacidad del piso.' : 'La altura útil ya está aprovechada en niveles.',
      REF_VERIFICAR('La holgura mínima bajo rociadores depende de la norma de protección contra incendios aplicable (p. ej. NFPA 13 / RNE); confirmar.'),
      nivMax > nivAct ? 'atencion' : 'ok'));
    const paso = 2 * F + cfg.flue + cfg.anchoPasillo;
    met.push(metrica('paso_fila', 'Paso de fila (módulo repetitivo transversal)', paso, 'm',
      'p = 2·fondo + flue + ancho de pasillo', '2·' + f(F, 2) + ' + ' + f(cfg.flue, 2) + ' + ' + f(cfg.anchoPasillo, 2) + ' = ' + f(paso, 2) + ' m',
      'Cada p metros hay un par de racks espalda con espalda y un pasillo; la densidad por m² es aproximadamente inversa a p.', null, 'info'));

    // sensibilidad al ancho de pasillo (fórmula + comprobación con el generador)
    const autoRacks = racks.filter(function (r) { return r.auto === true; });
    const basicos = autoRacks.length ? autoRacks : racksPalet;
    const genOpts = {
      tipo: 'palet', fondo: F, largoModulo: medianaRacks(basicos, function (r) { return r.largo / r.modulos; }, 2.7),
      niveles: Math.max(1, basicos.reduce(function (m, r) { return Math.max(m, nivDe(r)); }, 0) || 1),
      slotsPorModulo: Math.max(1, medianaRacks(basicos, function (r) { return r.slotsPorModulo; }, 2) | 0),
      altoNivel: altoNivel, altoBase: altoBase, modulosPorTramo: 8
    };
    // N8: si el proyecto guardó las opciones con que se generaron los racks, «regenerar» las usa; si no, valores por defecto
    const gGuardada = P.generacion && typeof P.generacion === 'object' && !Array.isArray(P.generacion) ? P.generacion : null;
    if (gGuardada) {
      ['tipo', 'orientacion', 'largoModulo', 'fondo', 'slotsPorModulo', 'modulosPorTramo', 'dobles', 'reservarFrentePuertas', 'rellenarSobrantes', 'altoNivel', 'altoBase', 'cargaMaxKg'].forEach(function (k) {
        if (gGuardada[k] !== undefined && gGuardada[k] !== null) genOpts[k] = gGuardada[k];
      });
      if (typeof gGuardada.niveles === 'number' && gGuardada.niveles >= 1) genOpts.niveles = gGuardada.niveles;
    }
    const fuenteGen = gGuardada ? 'con las opciones guardadas de la última generación del proyecto (proyecto.generacion)' : 'con valores por defecto deducidos de los racks existentes (el proyecto no guarda las opciones con que se generó)';
    supuestos.push('Escenarios: la «regeneración» de racks se hace ' + fuenteGen + (gGuardada ? '.' : ': puede diferir de lo que usted generó [VERIFICAR].'));
    const equipoCap = NIV_MAX_EQUIPO[cfg.equipo];
    if (equipoCap && racks.some(function (r) { return nivDe(r) > equipoCap; })) {
      adv.push('El equipo «' + cfg.equipo + '» no eleva carga: solo sirve hasta el nivel ' + equipoCap + ' y hay racks con más niveles; las posiciones de niveles superiores no son alcanzables con ese equipo [VERIFICAR con la ficha del equipo].');
    }
    const baseEsc = { cfg: cfg, genOpts: genOpts, hayPuertas: hayPuertas };
    const cacheEsc = Object.create(null);
    const escDef = contornoOk ? definirEscenarios(Mo, cfg, genOpts, null, fuenteGen) : [];
    let regenGen = null;
    function genSolo(def) {
      if (cacheEsc[def.id]) return cacheEsc[def.id];
      cacheEsc[def.id] = correrEscenario(Mo, P, def, baseEsc, false);
      return cacheEsc[def.id];
    }
    let sensTeor = null, sensEmp = null;
    if (nPos > 0 && paso > 0) {
      sensTeor = -0.1 * nPos / paso;
      if (contornoOk && !(opciones && opciones.sensibilidadEmpirica === false)) {
        try {
          regenGen = genSolo({ id: 'regenerado', cfg: {}, gen: {} });
          const mas = genSolo({ id: 'pasillo_mas', cfg: { anchoPasillo: redondear(cfg.anchoPasillo + 0.3, 2), anchoPasilloCruce: Math.max(cfg.anchoPasilloCruce, cfg.anchoPasillo + 0.3) }, gen: {} });
          sensEmp = (mas.posiciones - regenGen.posiciones) / 3;
        } catch (e) { adv.push('No se pudo verificar la sensibilidad del pasillo con el generador: ' + e.message); }
      }
    }
    met.push(metrica('sensibilidad_pasillo', 'Sensibilidad de la capacidad al ancho de pasillo', sensTeor, 'posiciones por cada +0,1 m de pasillo',
      'P ≈ K/p → dP/da = −P/p; ΔP(0,1 m) ≈ −0,1·P/p',
      sensTeor === null ? 'sin posiciones' : '−0,1·' + nPos + ' / ' + f(paso, 2) + ' = ' + f(sensTeor, 1) + ' posiciones por +0,1 m' +
        (sensEmp !== null ? '. Comprobación con generarRacksAuto (regenerado vs pasillo +0,3 m): (' + regenGen.posiciones + ' → ' + cacheEsc.pasillo_mas.posiciones + ')/3 = ' + f(sensEmp, 1) + ' pos por 0,1 m' : ''),
      'Aproximación de primer orden (la capacidad real cambia a saltos de filas enteras); la comprobación con el generador la contrasta con un caso real.',
      REF_PROPIO('Fórmula geométrica de esta herramienta; el valor empírico varía con la forma de la nave.'), 'info',
      { empirico: fin(sensEmp) }));

    /* ==================== CAPACIDAD ==================== */
    const tipos = Object.create(null);
    Object.keys(porTipoDisp).forEach(function (t) { tipos[t] = true; });
    demValida.forEach(function (d) { tipos[d.tipo] = true; });
    const porTipo = [];
    const capInfo = Object.create(null);
    let reqTotal = 0;
    Object.keys(tipos).sort().forEach(function (t) {
      const req = demValida.filter(function (d) { return d.tipo === t; }).reduce(function (s, d) { return s + d.req; }, 0);
      const disp = porTipoDisp[t] || 0;
      reqTotal += req;
      const ocup = disp > 0 ? req / disp : null;
      const reqObj = req > 0 ? Math.ceil(req / op.ocupacionObjetivo - 1e-9) : 0;
      const deficit = req - disp;
      const deficitObj = reqObj - disp;
      const racksT = racks.filter(function (r) { return (r.tipo || 'palet') === t; });
      const nivT = racksT.reduce(function (m, r) { return Math.max(m, nivDe(r)); }, 0);
      const posPorNivel = nivT > 0 ? disp / nivT : null;
      const deficitRef = deficit > 0 ? deficit : Math.max(0, deficitObj);
      // niveles que la altura permite para ESTE tipo (con el paso y la base de sus propios racks)
      const aNT = racksT.length ? medianaRacks(racksT, function (r) { return r.altoNivel; }, 1.6) : null;
      const aBT = racksT.length ? num(racksT[0].altoBase, 0.15) : null;
      const nivMaxT = aNT ? Math.max(0, Math.floor((alturaUtil - aBT + 1e-9) / aNT)) : 0;
      const nivCaben = Math.max(0, nivMaxT - nivT);
      const nivNecesarios = posPorNivel && deficitRef > 0 ? Math.ceil(deficitRef / posPorNivel - 1e-9) : 0;
      const nivExtra = Math.min(nivNecesarios, nivCaben);
      // N9: densidad PROPIA del tipo = posiciones del tipo / (huella del tipo · A_útil / A_racks); sin posiciones de ese tipo no se estima
      const huellaT = racksT.reduce(function (s, r) { return s + r.largo * r.fondo; }, 0);
      const densT = disp > 0 && huellaT > 0 && A.racks > 0 && A.util > 0 ? disp / (huellaT * (A.util / A.racks)) : null;
      capInfo[t] = { disp: disp, posPorNivel: posPorNivel, densT: densT, nivMaxT: nivMaxT, nivT: nivT };
      const ms = [];
      ms.push(metrica('req_' + t, 'Posiciones necesarias (' + t + ')', req, 'posiciones',
        'N_req = Σ ⌈cantidad / unidadesPorUbic⌉', demValida.filter(function (d) { return d.tipo === t; }).length + ' SKU → ' + req + ' posiciones',
        'Posiciones que exige el stock actual si cada SKU ocupa ubicaciones completas.', null, 'info'));
      ms.push(metrica('ocup_' + t, 'Ocupación (' + t + ')', ocup === null ? null : ocup * 100, '%',
        'Ocupación = N_req / N_disp', req + ' / ' + disp + ' = ' + f(ocup === null ? null : ocup * 100, 1) + ' %',
        ocup === null ? (req > 0 ? 'Hay demanda y ninguna posición de este tipo.' : 'Sin posiciones ni demanda de este tipo.') : ocup > 1 ? 'Falta capacidad: la demanda supera las posiciones.' : ocup > 0.9 ? 'Casi sin holgura para reubicar o reponer.' : ocup < 0.5 ? 'Sobredimensionado respecto de la demanda actual.' : 'Dentro de un rango operable.',
        REF_VERIFICAR('Se suele fijar un tope operativo de 80–85 % para poder reubicar y reponer; confirmar con bibliografía y con la operación.'),
        ocup === null ? (req > 0 ? 'critico' : 'info') : ocup > 1 || ocup > 0.9 ? 'critico' : ocup > op.ocupacionObjetivo || ocup < 0.5 ? 'atencion' : 'ok'));
      ms.push(metrica('objetivo_' + t, 'Posiciones con ocupación objetivo (' + t + ')', reqObj, 'posiciones',
        'N_obj = ⌈N_req / ocupación objetivo⌉', '⌈' + req + ' / ' + f(op.ocupacionObjetivo, 2) + '⌉ = ' + reqObj + ' → ' + (deficitObj > 0 ? 'faltan ' + deficitObj : 'sobran ' + (-deficitObj)),
        deficitObj > 0 ? 'Para operar a la ocupación objetivo faltan posiciones.' : 'Hay capacidad suficiente para la ocupación objetivo.', null, deficitObj > 0 ? 'atencion' : 'ok'));
      ms.push(metrica('balance_' + t, 'Déficit / superávit (' + t + ')', -deficit, 'posiciones',
        'Superávit = N_disp − N_req', disp + ' − ' + req + ' = ' + (disp - req),
        deficit > 0 ? 'DÉFICIT de ' + deficit + ' posiciones.' : 'Superávit de ' + (-deficit) + ' posiciones.', null, deficit > 0 ? 'critico' : 'ok'));
      if (deficitRef > 0) {
        if (densT) {
          ms.push(metrica('m2_extra_' + t, 'Área adicional para cubrir el ' + (deficit > 0 ? 'déficit' : 'objetivo') + ' (' + t + ')', deficitRef / densT, 'm²',
            'ΔA = déficit / D_tipo; D_tipo = posiciones del tipo / (huella del tipo · A_útil / A_racks)',
            deficitRef + ' / (' + disp + ' / (' + f(huellaT, 1) + ' · ' + f(A.util, 1) + ' / ' + f(A.racks, 1) + ') = ' + f(densT, 3) + ' pos/m²) = ' + f(deficitRef / densT, 1) + ' m²',
            'Superficie adicional al rendimiento PROPIO de este tipo (no el promedio de todo el almacén), incluyendo su parte proporcional de circulación.', null, 'info'));
        } else {
          ms.push(metrica('m2_extra_' + t, 'Área adicional para cubrir el ' + (deficit > 0 ? 'déficit' : 'objetivo') + ' (' + t + ')', null, 'm²',
            'ΔA = déficit / D_tipo', 'no estimable: no hay racks de tipo «' + t + '» de los que tomar un rendimiento por m²',
            'Sin posiciones de este tipo no hay una densidad propia: defina primero el tipo de estantería (fondo, niveles, módulo) y estime el área con ese rendimiento.', null, 'atencion'));
        }
        if (nivExtra > 0) {
          const parcial = nivExtra < nivNecesarios;
          ms.push(metrica('niveles_extra_' + t, 'Alternativa en niveles (' + t + ')', nivExtra, 'niveles',
            'Δn = mín(⌈déficit / (posiciones por nivel)⌉; n_máx − n_actual)',
            'mín(⌈' + deficitRef + ' / (' + disp + ' / ' + nivT + ' = ' + f(posPorNivel, 1) + ')⌉ = ' + nivNecesarios + '; ' + nivMaxT + ' − ' + nivT + ' = ' + nivCaben + ') = ' + nivExtra + ' nivel(es)',
            (parcial ? 'La altura solo permite ' + nivCaben + ' de los ' + nivNecesarios + ' nivel(es) que harían falta: el resto debe cubrirse con superficie u otra vía. ' : 'Se necesitan ' + nivNecesarios + ' nivel(es) más. ') + 'Hoy hay ' + nivT + ' y la altura permite ' + nivMaxT + ' (verifique viga, alcance del equipo y rociadores).', null, 'info'));
        }
      }
      let proy = null;
      if (op.crecimientoPct !== null) {
        const reqP = Math.ceil(req * (1 + op.crecimientoPct / 100) - 1e-9);
        proy = metrica('proy_' + t, 'Proyección con crecimiento (' + t + ')', reqP, 'posiciones',
          'N_proy = ⌈N_req·(1 + g)⌉', '⌈' + req + ' · (1 + ' + f(op.crecimientoPct / 100, 3) + ')⌉ = ' + reqP + ' vs ' + disp + ' disponibles → ' + (reqP > disp ? 'déficit de ' + (reqP - disp) : 'alcanza'),
          'Supone que el stock crece ' + f(op.crecimientoPct, 1) + ' % y que se mantiene el mix.', null, reqP > disp ? 'atencion' : 'ok');
        ms.push(proy);
      }
      porTipo.push({
        tipo: t, requeridas: req, disponibles: disp, ocupacionPct: fin(ocup === null ? null : redondear(ocup * 100, 1)),
        requeridasObjetivo: reqObj, balance: disp - req, deficit: Math.max(0, deficit), deficitObjetivo: Math.max(0, deficitObj),
        m2Adicionales: deficitRef > 0 ? (densT ? fin(redondear(deficitRef / densT, 1)) : null) : 0, densidadPosM2: fin(densT),
        nivelesAdicionales: nivExtra, nivelesNecesarios: nivNecesarios, nivelesActuales: nivT, nivelesMaximos: nivMaxT, metricas: ms
      });
    });
    // déficit → superficie / niveles adicionales (misma matemática de la capacidad), reutilizado por el pico
    function extrasPara(t, deficitRef) {
      const ci = capInfo[t];
      if (!ci || !(deficitRef > 0)) return { m2: deficitRef > 0 ? null : 0, nivNec: 0, nivExtra: 0 };
      const nivNec = ci.posPorNivel ? Math.ceil(deficitRef / ci.posPorNivel - 1e-9) : 0;
      const nivExtra = Math.min(nivNec, Math.max(0, ci.nivMaxT - ci.nivT));
      return { m2: ci.densT ? fin(redondear(deficitRef / ci.densT, 1)) : null, nivNec: nivNec, nivExtra: nivExtra };
    }
    const capMet = [];
    capMet.push(metrica('pos_totales', 'Posiciones totales', nPos, 'posiciones', 'Σ módulos·niveles·slots',
      racks.length + ' rack(s) → ' + nPos + ' posiciones', 'Capacidad física de almacenaje.', null, 'info'));
    capMet.push(metrica('ocupacion_global', 'Ocupación global', nPos > 0 ? (100 * reqTotal) / nPos : null, '%',
      'N_req total / N_disp total', reqTotal + ' / ' + nPos + ' = ' + f(nPos > 0 ? (100 * reqTotal) / nPos : null, 1) + ' %',
      'Suma de todos los tipos (puede ocultar déficits por tipo: vea el detalle).', null, nPos > 0 && reqTotal / nPos > 0.9 ? 'critico' : 'info'));
    capMet.push(metrica('inaccesibles', 'Posiciones inaccesibles', dist ? inaccesibles : null, 'posiciones',
      'N_inacc = posiciones sin ruta desde las puertas', dist ? inaccesibles + ' de ' + nPos : 'no calculado',
      'Posiciones que no pueden recibir carga porque no se llega a ellas.', null, inaccesibles > 0 ? 'atencion' : 'ok'));
    if (rec) capMet.push(metrica('sin_ubicar', 'SKU que no caben', rec.sinUbicar.length, 'SKU',
      'conteo de sinUbicar de la asignación', rec.sinUbicar.length + ' SKU' + (rec.sinUbicar.length ? ' (' + rec.sinUbicar.map(function (s) { return s.sku + ': ' + s.motivo; }).slice(0, 5).join('; ') + ')' : ''),
      'SKU para los que no hay posiciones compatibles suficientes.', null, rec.sinUbicar.length ? 'critico' : 'ok'));

    /* ==================== MOVIMIENTO ==================== */
    const mov = [];
    let ahorroH = null, ahorroM = null, dAct = null, dRec = null, mAct = null, mRec = null, picksU = null, mismoConjuntoMov = null;
    const COTA = COTA_TXT;
    const nombreDias = f(op.periodoDias, 0) + ' días';
    mov.push(metrica('picks_periodo', 'Picks por periodo', picksTot, 'líneas/periodo',
      'Σ picks de los SKU con posiciones', demValida.filter(function (d) { return d.req > 0; }).length + ' SKU → ' + f(picksTot, 0) + ' líneas en ' + nombreDias,
      'Volumen de trabajo de picking declarado. Las métricas de metros y horas pesan solo los picks de los SKU realmente ubicados (ver «picks_ubicados»).', null, 'info'));
    if (rec && actual && picksTot > 0) {
      dAct = actual.kpis.distMediaPonderada; dRec = rec.kpis.distMediaPonderada;
      // picks de los SKU REALMENTE ubicados en cada reparto (un SKU parcialmente ubicado pesa lo ubicado / lo requerido)
      const pUbicR = rec.kpis.picksUbicados;
      let pUbicA, mismo;
      if (actual.asignaciones) {
        pUbicA = actual.kpis.picksUbicados;
        mismo = mismoConjuntoAsignaciones(actual.asignaciones, rec.asignaciones);
      } else {
        pUbicA = rec.baseline.picksUbicados;
        mismo = rec.baseline.mismoConjunto === true;
      }
      mismoConjuntoMov = mismo;
      picksU = pUbicR;
      mAct = 2 * dAct * pUbicA; mRec = 2 * dRec * pUbicR;
      const hAct = mAct / op.velocidadMs / 3600 + (pUbicA * op.segPorPick) / 3600;
      const hRec = mRec / op.velocidadMs / 3600 + (pUbicR * op.segPorPick) / 3600;
      mov.push(metrica('picks_ubicados', 'Picks de los SKU ubicados', pUbicR, 'líneas/periodo',
        'picks_ubicados = Σ picks · (posiciones ubicadas / posiciones requeridas)',
        'recomendada: ' + f(pUbicR, 1) + ' de ' + f(picksTot, 0) + '; ' + (actual.asignaciones ? 'vigente' : '«sin criterio»') + ': ' + f(pUbicA, 1) + (mismo ? ' (mismo conjunto de SKU)' : ' (conjunto de SKU DISTINTO)'),
        mismo ? 'Ambos repartos ubican los mismos SKU: la comparación de recorrido es válida.' : 'Los repartos ubican conjuntos distintos de SKU: el ahorro NO es comparable y no se calcula.',
        null, mismo ? 'ok' : 'atencion'));
      if (!mismo) adv.push('La asignación actual y la recomendada no ubican el mismo conjunto de SKU (' + f(pUbicA, 1) + ' vs ' + f(pUbicR, 1) + ' picks ubicados): el ahorro de horas y metros no se calcula (igual que mejoraPct = null). Resuelva primero los SKU sin ubicar.');
      else { ahorroM = mAct - mRec; ahorroH = ahorroM / op.velocidadMs / 3600; }
      mov.push(metrica('dist_media_actual', 'Distancia media ponderada por pick — actual (ida)', dAct, 'm',
        'd̄ = Σ(picks·d) / Σ picks ubicados', 'fuente: ' + fuenteActual + ' → ' + f(dAct, 2) + ' m', 'Recorrido medio de ida hasta la posición, ponderado por rotación de los SKU ubicados.', null, 'info'));
      mov.push(metrica('dist_media_recomendada', 'Distancia media ponderada por pick — recomendada (ida)', dRec, 'm',
        'd̄ = Σ(picks·d) / Σ picks ubicados', 'asignación del motor → ' + f(dRec, 2) + ' m', 'Con el slotting propuesto (heurístico, no óptimo).', null, 'info'));
      mov.push(metrica('ida_vuelta', 'Recorrido de ida y vuelta por pick — actual', 2 * dAct, 'm', 'D = 2·d̄', '2 · ' + f(dAct, 2) + ' = ' + f(2 * dAct, 2) + ' m', 'Se asume regreso por la misma ruta.', null, 'info'));
      mov.push(metrica('metros_actual', 'Metros por periodo — actual', mAct, 'm/periodo',
        'M = Σ picks ubicados · 2 · d̄', f(pUbicA, 1) + ' · 2 · ' + f(dAct, 2) + ' = ' + f(mAct, 0) + ' m', 'Distancia total caminada en el periodo: ' + COTA + '.', null, 'info'));
      mov.push(metrica('metros_recomendada', 'Metros por periodo — recomendada', mRec, 'm/periodo',
        'M = Σ picks ubicados · 2 · d̄', f(pUbicR, 1) + ' · 2 · ' + f(dRec, 2) + ' = ' + f(mRec, 0) + ' m', 'Con la asignación recomendada: ' + COTA + '.', null, 'info'));
      mov.push(metrica('horas_actual', 'Horas por periodo — actual', hAct, 'h/periodo',
        'H = M/v/3600 + picks ubicados·t_pick/3600', f(mAct, 0) + ' / ' + f(op.velocidadMs, 1) + ' / 3600 + ' + f(pUbicA, 1) + ' · ' + f(op.segPorPick, 0) + ' / 3600 = ' + f(hAct, 1) + ' h',
        'Es una ' + COTA + '. v y t_pick son supuestos (ver supuestos).', null, 'info'));
      mov.push(metrica('horas_recomendada', 'Horas por periodo — recomendada', hRec, 'h/periodo',
        'H = M/v/3600 + picks ubicados·t_pick/3600', f(mRec, 0) + ' / ' + f(op.velocidadMs, 1) + ' / 3600 + ' + f(pUbicR, 1) + ' · ' + f(op.segPorPick, 0) + ' / 3600 = ' + f(hRec, 1) + ' h', 'Con la asignación recomendada: ' + COTA + '.', null, 'info'));
      mov.push(metrica('horas_ahorradas', 'Horas de recorrido ahorradas', ahorroH, 'h/periodo',
        'ΔH = (M_actual − M_recomendada) / v / 3600',
        mismo ? '(' + f(mAct, 0) + ' − ' + f(mRec, 0) + ') / ' + f(op.velocidadMs, 1) + ' / 3600 = ' + f(ahorroH, 1) + ' h (' + f(pct(ahorroM, mAct), 1) + ' % del recorrido)' : 'no calculado: los repartos ubican conjuntos distintos de SKU',
        !mismo ? 'No comparable: compare solo cuando ambos repartos ubiquen los mismos SKU.' : ahorroH > 0 ? 'Tiempo de caminata que se evitaría reubicando según la recomendación (el tiempo fijo por pick no cambia).' : 'La disposición actual ya es igual o mejor que la recomendada por el motor.',
        null, mismo && ahorroH > 0 && pct(ahorroM, mAct) > 10 ? 'atencion' : 'info'));
      if (op.costoHora !== null && ahorroH !== null) {
        mov.push(metrica('valor_ahorro', 'Valor de las horas ahorradas', ahorroH * op.costoHora, 'unidad monetaria del costoHora',
          'V = ΔH · costo por hora', f(ahorroH, 1) + ' h · ' + f(op.costoHora, 2) + ' = ' + f(ahorroH * op.costoHora, 2),
          'Solo valora horas de caminata a la tarifa que usted aportó; no incluye otros costos ni inversión.', REF_PROPIO('Depende íntegramente del costoHora dado.'), 'info'));
      }
      // concentración Pareto por posición
      const picksDe = new Map(); dem.forEach(function (d) { if (!picksDe.has(d.sku)) picksDe.set(d.sku, d); });
      const conc = function (asigs) {
        const w = [];
        asigs.forEach(function (a) { const d = picksDe.get(a.sku); if (!d || d.req <= 0) return; a.posiciones.forEach(function () { w.push(d.picks / d.req); }); });
        if (!w.length) return null;
        w.sort(function (x, y) { return y - x; });
        const tot = w.reduce(function (s, x) { return s + x; }, 0);
        const k = Math.max(1, Math.ceil(0.2 * w.length));
        const top = w.slice(0, k).reduce(function (s, x) { return s + x; }, 0);
        return tot > 0 ? { pct: (100 * top) / tot, k: k, n: w.length } : null;
      };
      const cRec = conc(rec.asignaciones);
      mov.push(metrica('pareto_posiciones', 'Concentración: % de picks en el 20 % de las posiciones ocupadas', cRec ? cRec.pct : null, '%',
        'C = Σ picks de las ⌈0,2·n⌉ posiciones más pedidas / Σ picks', cRec ? 'n = ' + cRec.n + ' posiciones ocupadas, top ' + cRec.k + ' → ' + f(cRec.pct, 1) + ' %' : 'sin datos',
        'Mide cuán concentrada está la rotación: a mayor concentración, más rinde acercar esas posiciones a la puerta.', REF_PROPIO('Calculado sobre la asignación recomendada (picks repartidos por igual entre las posiciones de cada SKU).'), 'info'));
      if (actual.asignaciones) {
        const cAct = conc(actual.asignaciones);
        if (cAct) mov.push(metrica('pareto_posiciones_actual', 'Concentración en la asignación vigente', cAct.pct, '%', 'ídem', 'n = ' + cAct.n + ', top ' + cAct.k + ' → ' + f(cAct.pct, 1) + ' %', 'Igual que la anterior sobre el reparto del proyecto.', null, 'info'));
      }
    } else {
      mov.push(metrica('sin_movimiento', 'Movimiento no calculable', null, '', 'requiere puertas, racks, productos y picks', 'faltan datos: ' + (!hayPuertas ? 'puertas; ' : '') + (!racks.length ? 'racks; ' : '') + (!productos.length ? 'productos; ' : '') + (picksTot <= 0 ? 'picks mayores que 0' : ''),
        'Complete esos datos para ver distancias, metros y horas.', null, 'info'));
    }

    /* ==================== v1.1: SECCIONES A1–A8 ==================== */
    const ctx = {
      Mo: Mo, P: P, cfg: cfg, op: op, adv: adv, racks: racks, productos: productos, dem: dem, posiciones: posiciones, posPorId: posPorId,
      rec: rec, A: A, contornoOk: contornoOk, dimMax: dimMax, capInfo: capInfo, extrasPara: extrasPara
    };
    let mallaV = null, mallaHecha = false, anchoV = null, asigV;
    ctx.getMalla = function () {
      if (!mallaHecha) {
        mallaHecha = true;
        try { mallaV = contornoOk ? Mo.construirMalla(P) : null; } catch (e) { mallaV = null; adv.push('No se pudo construir la malla caminable: ' + e.message); }
      }
      return mallaV;
    };
    ctx.getAncho = function () {
      if (!anchoV) { const mm = ctx.getMalla(); anchoV = mm ? anchoLocalMalla(mm) : null; }
      return anchoV;
    };
    // asignación de referencia para cargas, afinidad y vencimientos: la vigente del proyecto o, si no hay, la recomendada
    ctx.fuenteAsig = function () {
      if (asigV !== undefined) return asigV;
      const R_ = P.resultado;
      if (R_ && R_.porPosicion && Object.keys(R_.porPosicion).length) asigV = { porPosicion: R_.porPosicion, lotePorPosicion: R_.lotePorPosicion || null, rolPorPosicion: R_.rolPorPosicion || null, fuente: 'vigente' };
      else if (rec) asigV = { porPosicion: rec.porPosicion, lotePorPosicion: rec.lotePorPosicion || null, rolPorPosicion: rec.rolPorPosicion || null, fuente: 'recomendada' };
      else asigV = null;
      return asigV;
    };
    function seguro(nombre, fn, defecto) {
      try { return fn(); } catch (e) { adv.push('La sección «' + nombre + '» falló: ' + e.message); return Object.assign({ disponible: false, motivo: 'Error interno: ' + e.message, metricas: [] }, defecto || {}); }
    }
    const muelle = seguro('muelle', function () { return seccionMuelle(ctx); });
    const evacuacion = seguro('evacuación', function () { return seccionEvacuacion(ctx); }, { mapa: { muestras: [], celdaM: null, paso: null, maxD: null, truncado: false }, callejones: [] });
    const cargas = seguro('cargas', function () { return seccionCargas(ctx); }, { modulos: [], ranking: [], excedidos: [] });
    const pico = seguro('pico', function () { return seccionPico(ctx); }, { porTipo: [] });
    const crossdock = seguro('cross-docking', function () { return seccionCrossdock(ctx); }, { skus: [] });
    const afinidad = seguro('afinidad', function () { return seccionAfinidad(ctx); }, { pares: [] });
    const reposicion = seguro('picking/reserva', function () { return seccionReposicion(ctx); });
    const fefo = seguro('lotes y FEFO', function () { return seccionFefo(ctx); }, { lotes: [] });
    muelle.advertencias = muelle.advertencias || [];
    [evacuacion.advertencias, afinidad.advertencias].forEach(function (l) { (l || []).forEach(function (a) { adv.push(a); }); });
    supuestos.push('v1.1 — Evacuación: distancia caminando por la malla desde el punto de acceso de cada posición hasta la salida más cercana (si no hay salidas de emergencia marcadas, hasta cualquier puerta, con aviso). Los límites de distancia y de ancho de evacuación son SUYOS (evacMaxM, anchoEvacuacionMin); sin ellos solo se muestran valores y no se afirma cumplimiento [VERIFICAR RNE A.130 / ITSE].');
    supuestos.push('v1.1 — Ancho de paso = cuerda libre mínima de la malla en 4 direcciones (resolución ± la celda); en pasillos oblicuos sobrestima. Muelle/staging: huella de palet 1,2×1,0 m y factor de maniobra 1,5 son valores típicos propios [VERIFICAR] si usted no da los suyos.');
    supuestos.push('v1.1 — Cargas por módulo con la asignación ' + (ctx.fuenteAsig() ? ctx.fuenteAsig().fuente : 'inexistente') + ': el stock de cada SKU se reparte llenando sus posiciones en orden; no es presión sobre la losa [VERIFICAR ingeniero estructural].');
    if (dimMax) supuestos.push('La capacidad se dimensiona por el MÁXIMO (config.dimensionarPor = «maximo»): posiciones necesarias con stockMax (o cantidad si está vacío).');
    if (dem.some(function (d) { return d.crossdock && d.valido; })) supuestos.push('Los SKU de cross-docking no ocupan posiciones de rack: se excluyen de la capacidad y de los picks ubicados.');
    Object.keys(capPorTipo).forEach(function (t) { if (capPorTipo[t] > 1) supuestos.push('Tipo «' + t + '»: ' + f(capPorTipo[t], 0) + ' ubicaciones por posición (mediana de capacidadUb) para convertir stock en posiciones.'); });

    /* ==================== ESCENARIOS ==================== */
    const escenarios = [];
    let truncado = false;
    const actualKpi = rec ? { dist: rec.kpis.distMediaPonderada, ocup: rec.kpis.ocupacionPct } : null;
    if (op.escenarios && contornoOk && hayPuertas) {
      const defs = definirEscenarios(Mo, cfg, genOpts, regenGen ? regenGen.angulo : null, fuenteGen);
      let ref = null;
      for (let i = 0; i < defs.length; i++) {
        if (ahora() - t0 > op.topeMsEscenarios) {
          truncado = true;
          adv.push('Se truncaron los escenarios por tiempo (tope ' + f(op.topeMsEscenarios / 1000, 0) + ' s): faltan ' + defs.slice(i).map(function (d) { return d.id; }).join(', ') + '.');
          break;
        }
        const d = defs[i];
        let r;
        try {
          r = correrEscenario(Mo, P, d, baseEsc, true);
        } catch (e) { adv.push('Escenario «' + d.id + '» falló: ' + e.message); continue; }
        const kp = r.resultado ? r.resultado.kpis : null;
        const dPos = r.posiciones - nPos;
        const dRecorr = kp && actualKpi && actualKpi.dist > 0 ? (100 * (kp.distMediaPonderada - actualKpi.dist)) / actualKpi.dist : null;
        const escn = {
          id: d.id, nombre: d.nombre, cambio: d.cambio, posiciones: r.posiciones,
          posicionesUtiles: r.posicionesUtiles, alcanzables: r.posicionesUtiles === r.posiciones, nivelMaxEquipo: r.nivelMaxEquipo,
          deltaRegenerarPosiciones: null, deltaCambioPosiciones: null, deltaCambioUtiles: null, nota: null,
          densidad: A.util > 0 ? fin(r.posiciones / A.util) : null,
          distMedia: kp ? kp.distMediaPonderada : null, ocupacionPct: kp ? kp.ocupacionPct : null,
          sinUbicar: r.resultado ? r.resultado.sinUbicar.length : null,
          deltaPosiciones: dPos, deltaPosPct: nPos > 0 ? fin(redondear((100 * dPos) / nPos, 1)) : null,
          deltaRecorridoPct: dRecorr === null ? null : redondear(dRecorr, 1), deltaVsRegenPosiciones: null,
          formula: 'Δ% = (valor_escenario − valor_actual) / valor_actual · 100',
          sustitucion: 'posiciones: ' + r.posiciones + ' − ' + nPos + ' = ' + (dPos >= 0 ? '+' : '') + dPos + ' (' + f(nPos > 0 ? (100 * dPos) / nPos : null, 1) + ' %)' +
            (kp && actualKpi ? '; recorrido medio: ' + f(kp.distMediaPonderada, 2) + ' vs ' + f(actualKpi.dist, 2) + ' m → ' + f(dRecorr, 1) + ' %' : ''),
          lectura: '', estado: 'info',
          // lo que la interfaz debe fusionar/aplicar para llevar el proyecto a este escenario con un botón
          aplicar: { config: clonar(d.cfg || {}), racksOpciones: Object.assign({}, genOpts, d.gen || {}) }
        };
        if (d.id === 'regenerado') ref = escn;
        escenarios.push(escn);
      }
      if (ref) {
        escenarios.forEach(function (e) {
          // dos efectos separados: Δ «regenerar» (volver a generar con la configuración actual) y Δ «del cambio» (lo que añade la medida)
          e.deltaRegenerarPosiciones = ref.posiciones - nPos;
          e.deltaCambioPosiciones = e.posiciones - ref.posiciones;
          e.deltaCambioUtiles = e.posicionesUtiles - ref.posicionesUtiles;
          e.deltaVsRegenPosiciones = e.deltaCambioPosiciones; // alias de compatibilidad
          if (e.id === 'regenerado') e.lectura = 'Referencia: separa el efecto de volver a generar los racks (' + (ref.posiciones - nPos >= 0 ? '+' : '') + (ref.posiciones - nPos) + ' posiciones vs el layout actual) del efecto de cada cambio. Positivo = el generador rinde más que el layout actual.';
          else e.lectura = 'Δ regenerar: ' + (e.deltaRegenerarPosiciones >= 0 ? '+' : '') + e.deltaRegenerarPosiciones + ' · Δ del cambio: ' + (e.deltaCambioPosiciones >= 0 ? '+' : '') + e.deltaCambioPosiciones + ' posiciones respecto de regenerar sin cambios' + (e.distMedia !== null && ref.distMedia > 0 ? '; recorrido ' + f((100 * (e.distMedia - ref.distMedia)) / ref.distMedia, 1) + ' % vs regenerado' : '') + '.';
          if (!e.alcanzables) {
            e.nota = 'Con el equipo de este escenario solo se alcanza hasta el nivel ' + e.nivelMaxEquipo + ': ' + e.posicionesUtiles + ' de ' + e.posiciones + ' posiciones son utilizables (ganancia útil respecto de regenerar: ' + (e.deltaCambioUtiles >= 0 ? '+' : '') + e.deltaCambioUtiles + '). No se presenta como el mejor escenario [VERIFICAR con la ficha del equipo].';
            e.lectura += ' ' + e.nota;
            e.estado = 'atencion';
          } else {
            e.estado = e.id !== 'regenerado' && e.deltaCambioPosiciones > 0 && nPos > 0 && e.deltaCambioPosiciones / nPos >= 0.03 ? 'atencion' : 'info';
          }
        });
      }
    }

    /* ==================== RECOMENDACIONES ==================== */
    const recs = [];
    let nRec = 0;
    function R(prioridad, titulo, detalle, formula, sustitucion, impacto, accion, confianza, verificar, orden) {
      nRec++;
      recs.push({
        id: 'R' + String(nRec).padStart(2, '0'), prioridad: prioridad, titulo: titulo, detalle: detalle, formula: formula, sustitucion: sustitucion,
        impacto: { magnitud: fin(impacto.magnitud), unidad: impacto.unidad, texto: impacto.texto }, accion: accion, confianza: confianza, verificar: verificar || [],
        _orden: fin(orden) === null ? 0 : orden
      });
    }
    // el «mejor» escenario solo considera los que dejan TODAS sus posiciones alcanzables por el equipo
    const candEsc = escenarios.filter(function (e) { return e.id !== 'regenerado'; });
    const mejorEsc = candEsc.filter(function (e) { return e.alcanzables !== false; }).sort(function (a, b) { return b.posiciones - a.posiciones; })[0] || null;
    const brutoEsc = candEsc.slice().sort(function (a, b) { return b.posiciones - a.posiciones; })[0] || null;

    // déficit
    porTipo.forEach(function (t) {
      if (t.deficit > 0) {
        const vias = [];
        if (t.nivelesAdicionales > 0) vias.push('+' + t.nivelesAdicionales + ' nivel(es)' + (t.nivelesAdicionales < t.nivelesNecesarios ? ' (de los ' + t.nivelesNecesarios + ' necesarios; la altura no da más)' : '') + ' (hoy ' + t.nivelesActuales + '; la altura permite ' + t.nivelesMaximos + ')');
        if (t.m2Adicionales > 0) vias.push('+' + f(t.m2Adicionales, 1) + ' m² al rendimiento de ' + f(t.densidadPosM2, 3) + ' pos/m² de ese tipo');
        else if (t.m2Adicionales === null) vias.push('superficie adicional: no estimable (no hay racks de tipo «' + t.tipo + '» para tomar un rendimiento por m²)');
        const nivEsc = escenarios.find(function (e) { return e.id === 'nivel_mas'; });
        const pasEsc = mejorEsc;
        if (t.tipo === 'palet' && nivEsc) vias.push('escenario «un nivel más»: ' + (nivEsc.deltaPosiciones >= 0 ? '+' : '') + nivEsc.deltaPosiciones + ' posiciones');
        if (pasEsc && pasEsc.id !== 'nivel_mas') vias.push('escenario «' + pasEsc.nombre + '»: ' + (pasEsc.deltaPosiciones >= 0 ? '+' : '') + pasEsc.deltaPosiciones + ' posiciones (' + (pasEsc.deltaRegenerarPosiciones >= 0 ? '+' : '') + pasEsc.deltaRegenerarPosiciones + ' por regenerar, ' + (pasEsc.deltaCambioPosiciones >= 0 ? '+' : '') + pasEsc.deltaCambioPosiciones + ' por el cambio)');
        R(1, 'Déficit de ' + t.deficit + ' posiciones de ' + t.tipo,
          'La demanda de posiciones (' + t.requeridas + ') supera las disponibles (' + t.disponibles + '). Vías: ' + (vias.join('; ') || 'ampliar capacidad') + '.',
          'Déficit = N_req − N_disp; Δn = ⌈déficit / posiciones por nivel⌉; ΔA = déficit / D',
          'Déficit = ' + t.requeridas + ' − ' + t.disponibles + ' = ' + t.deficit + (t.nivelesAdicionales > 0 ? '; Δn = mín(' + t.nivelesNecesarios + '; ' + (t.nivelesMaximos - t.nivelesActuales) + ') = ' + t.nivelesAdicionales : '') + (t.m2Adicionales > 0 ? '; ΔA = ' + t.deficit + ' / ' + f(t.densidadPosM2, 3) + ' = ' + f(t.m2Adicionales, 1) + ' m²' : ''),
          { magnitud: t.deficit, unidad: 'posiciones', texto: 'Hoy ' + t.deficit + ' posiciones de ' + t.tipo + ' no tienen lugar (' + f(pct(t.deficit, t.requeridas), 1) + ' % de la demanda).' },
          'Elegir la vía (más niveles si la altura y la viga lo permiten, más superficie, o cambio de equipo/layout) y validarla con el responsable de almacén; mientras tanto depurar stock obsoleto.',
          'alta', ['capacidad de viga y rociadores para más niveles', 'ficha del equipo (alcance y ancho de pasillo)', 'capacidad del piso'], 100 * t.deficit / Math.max(1, t.requeridas));
      } else if (t.disponibles > 0 && t.requeridas / t.disponibles > 0.9) {
        R(2, 'Ocupación de ' + t.tipo + ' en ' + f(100 * t.requeridas / t.disponibles, 1) + ' %: sin holgura operativa',
          'Con menos de ' + f(100 - 100 * 0.9, 0) + ' % libre no hay espacio para reubicar, reponer ni absorber picos. Para operar al ' + f(op.ocupacionObjetivo * 100, 0) + ' % se necesitan ' + t.requeridasObjetivo + ' posiciones.',
          'N_obj = ⌈N_req / ocupación objetivo⌉; faltante = N_obj − N_disp',
          '⌈' + t.requeridas + ' / ' + f(op.ocupacionObjetivo, 2) + '⌉ = ' + t.requeridasObjetivo + ' − ' + t.disponibles + ' = ' + t.deficitObjetivo + ' posiciones' + (t.densidadPosM2 && t.deficitObjetivo > 0 ? ' (≈ ' + f(t.deficitObjetivo / t.densidadPosM2, 1) + ' m² al rendimiento de ' + f(t.densidadPosM2, 3) + ' pos/m² de ese tipo)' : ''),
          { magnitud: t.deficitObjetivo, unidad: 'posiciones', texto: 'Faltan ' + t.deficitObjetivo + ' posiciones para la ocupación objetivo.' },
          'Planificar ampliación o depuración de stock antes de que la ocupación llegue a 100 %.', 'media', ['ocupación objetivo con el responsable de almacén'], 60 * t.deficitObjetivo / Math.max(1, t.disponibles));
      } else if (t.disponibles > 0 && t.requeridas / t.disponibles < 0.5) {
        const sobran = t.disponibles - t.requeridasObjetivo;
        R(3, 'Posiciones de ' + t.tipo + ' sobredimensionadas (ocupación ' + f(100 * t.requeridas / t.disponibles, 1) + ' %)',
          'Para la demanda actual a la ocupación objetivo bastan ' + t.requeridasObjetivo + ' de ' + t.disponibles + ' posiciones.',
          'Sobrante = N_disp − ⌈N_req / ocupación objetivo⌉; ΔA = sobrante / D_tipo',
          t.disponibles + ' − ' + t.requeridasObjetivo + ' = ' + sobran + (t.densidadPosM2 && sobran > 0 ? ' posiciones ≈ ' + f(sobran / t.densidadPosM2, 1) + ' m² (a ' + f(t.densidadPosM2, 3) + ' pos/m² de ese tipo)' : ''),
          { magnitud: Math.max(0, sobran), unidad: 'posiciones', texto: 'Hasta ' + Math.max(0, sobran) + ' posiciones podrían liberarse para otro uso.' },
          'Evaluar cerrar filas lejanas o reasignar el espacio (picking, cuarentena, crecimiento) antes de comprar más estantería.', 'media', ['previsión de demanda: no recortar si se espera crecimiento'], 30);
      }
    });
    // proyección
    if (op.crecimientoPct !== null) {
      porTipo.forEach(function (t) {
        const reqP = Math.ceil(t.requeridas * (1 + op.crecimientoPct / 100) - 1e-9);
        if (t.deficit <= 0 && reqP > t.disponibles) {
          R(2, 'Con ' + f(op.crecimientoPct, 1) + ' % de crecimiento, ' + t.tipo + ' se queda corto',
            'La demanda proyectada (' + reqP + ') superaría las posiciones actuales (' + t.disponibles + ').',
            'N_proy = ⌈N_req·(1 + g)⌉ − N_disp', '⌈' + t.requeridas + ' · ' + f(1 + op.crecimientoPct / 100, 3) + '⌉ − ' + t.disponibles + ' = ' + (reqP - t.disponibles),
            { magnitud: reqP - t.disponibles, unidad: 'posiciones', texto: 'Déficit futuro de ' + (reqP - t.disponibles) + ' posiciones.' },
            'Reservar espacio o planificar la ampliación para el horizonte del crecimiento.', 'media', ['el crecimiento es un supuesto del usuario'], 40);
        }
      });
    }
    // reubicación (slotting)
    if (rec && actual && picksTot > 0 && mismoConjuntoMov === true && ahorroM !== null && ahorroM > 0) {
      let det = '', extra = '';
      if (actual.asignaciones) {
        const recPorSku = new Map(); rec.asignaciones.forEach(function (a) { recPorSku.set(a.sku, a); });
        const picksSku = new Map(); dem.forEach(function (d) { if (!picksSku.has(d.sku)) picksSku.set(d.sku, d); });
        const cands = actual.asignaciones.filter(function (a) { return a.clase === 'A' && recPorSku.has(a.sku) && picksSku.has(a.sku); }).map(function (a) {
          const d = picksSku.get(a.sku);
          const ah = d.picks * 2 * (a.dDespMedia - recPorSku.get(a.sku).dDespMedia);
          return { sku: a.sku, dAct: a.dDespMedia, dRec: recPorSku.get(a.sku).dDespMedia, picks: d.picks, ah: ah };
        }).filter(function (c) { return c.ah > 0; }).sort(function (a, b) { return b.ah - a.ah; }).slice(0, 5);
        if (cands.length) {
          det = 'SKU clase A con mayor ahorro: ' + cands.map(function (c) { return c.sku + ' (' + f(c.dAct, 1) + ' → ' + f(c.dRec, 1) + ' m; ' + f(c.ah, 0) + ' m/periodo)'; }).join('; ') + '. ';
          extra = ' Ejemplo ' + cands[0].sku + ': ' + f(cands[0].picks, 0) + ' · 2 · (' + f(cands[0].dAct, 2) + ' − ' + f(cands[0].dRec, 2) + ') = ' + f(cands[0].ah, 0) + ' m/periodo.';
        }
        // niveles altos
        const altosA = actual.asignaciones.filter(function (a) { return a.clase === 'A'; }).reduce(function (acc, a) {
          a.posiciones.forEach(function (id) { acc.n++; if (posPorId[id] && posPorId[id].nivel >= 3) acc.alto++; });
          return acc;
        }, { n: 0, alto: 0 });
        if (altosA.n > 0 && altosA.alto > 0) det += f(altosA.alto, 0) + ' de ' + altosA.n + ' posiciones de SKU clase A están en nivel 3 o superior (' + f(pct(altosA.alto, altosA.n), 1) + ' %). ';
      } else {
        det = 'El proyecto no tiene asignación vigente: se compara el reparto «sin criterio» contra el recomendado. ';
      }
      R(ahorroM / mAct > 0.1 ? 1 : 2, 'Reubicar según rotación (ABC + distancia): −' + f(pct(ahorroM, mAct), 1) + ' % de recorrido',
        det + 'Recorrido actual ' + f(mAct, 0) + ' m/periodo vs ' + f(mRec, 0) + ' m/periodo recomendado (solo picks de SKU ubicados).',
        'ΔM = Σ picks ubicados·2·(d_actual − d_recomendada); ΔH = ΔM / v / 3600',
        f(picksU, 1) + ' · 2 · (' + f(dAct, 2) + ' − ' + f(dRec, 2) + ') = ' + f(ahorroM, 0) + ' m/periodo → ' + f(ahorroM, 0) + ' / ' + f(op.velocidadMs, 1) + ' / 3600 = ' + f(ahorroH, 1) + ' h/periodo' + extra +
          (op.costoHora !== null ? '; valor = ' + f(ahorroH, 1) + ' · ' + f(op.costoHora, 2) + ' = ' + f(ahorroH * op.costoHora, 2) : ''),
        { magnitud: ahorroH, unidad: 'h/periodo', texto: 'Hasta ' + f(ahorroH, 1) + ' h de caminata menos por periodo de ' + nombreDias + ' (' + COTA + '; ' + f(ahorroM, 0) + ' m).' + (op.costoHora === null ? '' : ' Valor: ' + f(ahorroH * op.costoHora, 2) + ' (a su costoHora).') },
        'Aplicar la asignación recomendada por oleadas, empezando por los SKU A de mayor ahorro; medir el recorrido real antes y después.',
        'media', ['velocidad y segundos por pick reales', 'costo de la mudanza (no incluido)', 'restricciones físicas de las cargas'], pct(ahorroM, mAct));
    }
    // obsoletos
    const obsol = demValida.filter(function (d) { return d.picks === 0 && d.req > 0; });
    if (obsol.length) {
      const nObs = obsol.reduce(function (s, d) { return s + d.req; }, 0);
      let cerca = 0, qDesp = null;
      if (dist) {
        const ds = dist.posiciones.filter(function (q) { return q.accesible; }).map(function (q) { return q.dDesp; }).sort(function (a, b) { return a - b; });
        if (ds.length) qDesp = ds[Math.floor(0.25 * (ds.length - 1))];
        if (qDesp !== null && P.resultado && P.resultado.asignaciones) {
          const oSet = new Set(); obsol.forEach(function (d) { oSet.add(d.sku); });
          P.resultado.asignaciones.forEach(function (a) { if (oSet.has(a.sku)) a.posiciones.forEach(function (id) { if (posPorId[id] && posPorId[id].dDesp <= qDesp) cerca++; }); });
        }
      }
      R(nObs / Math.max(1, nPos) > 0.05 ? 2 : 3, nObs + ' posiciones ocupadas por ' + obsol.length + ' SKU sin movimiento',
        'SKU con picks = 0 en el periodo: ' + obsol.slice(0, 6).map(function (d) { return d.sku; }).join(', ') + (obsol.length > 6 ? '…' : '') + '. Liberarlos o llevarlos a zona lejana devuelve espacio' + (cerca ? ' (' + cerca + ' están en el cuarto más cercano a despacho)' : '') + '.',
        'Espacio liberable = Σ posReq(picks = 0); ΔA = posiciones / D',
        nObs + ' posiciones' + (dens ? ' / ' + f(dens, 3) + ' = ' + f(nObs / dens, 1) + ' m²' : '') + '; ' + f(pct(nObs, nPos), 1) + ' % de las posiciones',
        { magnitud: nObs, unidad: 'posiciones', texto: nObs + ' posiciones (' + f(pct(nObs, nPos), 1) + ' % del total) sostienen SKU sin salida.' },
        'Revisar si son obsoletos, estacionales o de proyecto; liquidar, trasladar a reserva lejana o devolver. No eliminar sin validar con el área comercial.', 'media', ['si "picks = 0" es dato real o falta de registro', 'stock de seguridad o estacional'], 100 * nObs / Math.max(1, nPos));
    }
    // forward pick
    const fp = demValida.filter(function (d) { return d.picks > 0 && d.req > 1; });
    if (fp.length && picksTot > 0) {
      const abc = Mo.clasificarABC(productos, cfg.abc);
      const claseDe = Object.create(null); abc.forEach(function (x) { if (!claseDe[x.sku]) claseDe[x.sku] = x.clase; });
      const cand = fp.filter(function (d) { return claseDe[d.sku] === 'A'; }).sort(function (a, b) { return b.picks / b.req - a.picks / a.req; }).slice(0, 3);
      if (cand.length) {
        const c = cand[0];
        const repos = c.picks / c.upu;
        R(3, 'Zona de picking en nivel 1 + reserva para SKU de alta rotación',
          'SKU A con varias posiciones (' + cand.map(function (d) { return d.sku + ': ' + d.req + ' pos'; }).join(', ') + '): dejar 1 posición en nivel 1 cerca de la puerta para picking y mover el resto a reserva alta/lejana, con reposición programada.',
          'Reposiciones/periodo ≈ picks · (unidades por línea) / unidadesPorUbic',
          c.sku + ': ' + f(c.picks, 0) + ' · 1 / ' + f(c.upu, 0) + ' = ' + f(repos, 1) + ' reposiciones/periodo (SUPUESTO: 1 unidad por línea [FALTA: unidades por línea de pedido])',
          { magnitud: repos, unidad: 'reposiciones/periodo', texto: 'Si cada línea saca 1 unidad, ' + c.sku + ' requeriría ≈ ' + f(repos, 1) + ' reposiciones por periodo; con más unidades por línea serían más.' },
          'Definir con logística la posición de picking, el punto de reposición y la frecuencia; medir unidades reales por línea antes de decidir.', 'baja',
          ['unidades promedio por línea de pedido', 'espacio de picking en nivel 1', 'procedimiento de reposición (logistica-almacen)'], 5);
      }
    }
    // familias dispersas
    {
      const asigs = actual && actual.asignaciones ? actual.asignaciones : (rec ? rec.asignaciones : null);
      const fuenteF = actual && actual.asignaciones ? 'asignación vigente' : 'asignación recomendada';
      if (asigs && dens) {
        const famDe = Object.create(null); dem.forEach(function (d) { if (famDe[d.sku] === undefined) famDe[d.sku] = d.familia; });
        const grupos = Object.create(null);
        asigs.forEach(function (a) { const fm = famDe[a.sku]; if (!fm) return; a.posiciones.forEach(function (id) { if (posPorId[id]) { (grupos[fm] = grupos[fm] || []).push(posPorId[id]); } }); });
        const disp = [];
        Object.keys(grupos).forEach(function (fm) {
          const g = grupos[fm];
          if (g.length < 8) return;
          const cx = g.reduce(function (s, q) { return s + q.cx; }, 0) / g.length, cy = g.reduce(function (s, q) { return s + q.cy; }, 0) / g.length;
          const rms = Math.sqrt(g.reduce(function (s, q) { return s + (q.cx - cx) * (q.cx - cx) + (q.cy - cy) * (q.cy - cy); }, 0) / g.length);
          const rCompacto = Math.sqrt(g.length / dens / Math.PI);
          const rmsRef = rCompacto / Math.SQRT2;
          if (rmsRef > 0 && rms / rmsRef > 3) disp.push({ fm: fm, n: g.length, rms: rms, ref: rmsRef, ratio: rms / rmsRef });
        });
        disp.sort(function (a, b) { return b.ratio - a.ratio; });
        if (disp.length) {
          const d = disp[0];
          R(3, 'Familia «' + d.fm + '» dispersa en el almacén',
            'Familias dispersas (' + fuenteF + '): ' + disp.slice(0, 4).map(function (x) { return x.fm + ' (×' + f(x.ratio, 1) + ')'; }).join(', ') + '. Agrupar familias que se piden juntas acorta recorridos y facilita la reposición.',
            'Dispersión = RMS de distancias al centroide / (r_compacto/√2); r_compacto = √(n / (D·π))',
            d.fm + ': n = ' + d.n + ', RMS = ' + f(d.rms, 1) + ' m; r_compacto = √(' + d.n + ' / (' + f(dens, 3) + '·π)) = ' + f(d.ref * Math.SQRT2, 1) + ' m → ' + f(d.ratio, 1) + ' veces lo compacto',
            { magnitud: d.ratio, unidad: '× vs compacto', texto: 'La familia ocupa ' + f(d.ratio, 1) + ' veces el radio de una disposición compacta (umbral propio: 3).' },
            'Confirmar con ventas/logística si la familia se pide junta (afinidad) antes de reagrupar.', 'baja', ['afinidad real entre SKU (pedidos que los combinan)'], 3 * d.ratio);
        }
      }
    }
    // circulación
    if (circFactor !== null && circTeorico !== null && circFactor > 2 * circTeorico) {
      R(3, 'Circulación alta: ' + f(circFactor, 2) + ' m² de pasillo por m² de rack',
        'Es ' + f(circFactor / circTeorico, 1) + ' veces la referencia geométrica mínima (' + f(circTeorico, 2) + '). Puede haber piso sin uso (' + (A.sinUsoCalculado ? f(A.sinUso, 1) + ' m²' : 'no calculado') + ') o pasillos de cruce de más.',
        'FC = A_circ / A_racks vs ancho/(2·fondo)',
        f(A.circulacion, 1) + ' / ' + f(A.racks, 1) + ' = ' + f(circFactor, 2) + ' vs ' + f(cfg.anchoPasillo, 2) + '/(2·' + f(F, 2) + ') = ' + f(circTeorico, 2),
        { magnitud: A.sinUsoCalculado ? A.sinUso : A.circulacion - 2 * circTeorico * A.racks, unidad: 'm²', texto: 'Hasta ' + f(A.sinUsoCalculado ? A.sinUso : Math.max(0, A.circulacion - 2 * circTeorico * A.racks), 1) + ' m² serían recuperables para almacenaje o picking (estimación geométrica).' },
        'Revisar el layout: ¿se puede añadir una fila, ampliar un bloque o convertir el piso libre en zona de picking/consolidación? Respete pasillos de evacuación.', 'baja',
        ['pasillos de evacuación y áreas de maniobra exigidas', 'criterio [PROPIO] de 2× la referencia'], pct(A.sinUsoCalculado ? A.sinUso : 0, A.util) || 5);
    }
    // altura sin usar
    if (nivMax > nivAct && nivAct > 0 && nPos > 0) {
      const pPorNivel = (porTipoDisp.palet || 0) / nivAct;
      const extra = pPorNivel * (nivMax - nivAct);
      const ocupPalet = porTipo.find(function (t) { return t.tipo === 'palet'; });
      R(ocupPalet && ocupPalet.deficit > 0 ? 1 : 3, 'Altura sin usar: caben ' + (nivMax - nivAct) + ' nivel(es) más' + (cubica !== null ? ' (utilización cúbica ' + f(cubica, 1) + ' %)' : ''),
        'La altura útil de ' + f(alturaUtil, 1) + ' m permite ' + nivMax + ' niveles y hoy hay ' + nivAct + '.',
        'Δposiciones = (posiciones por nivel) · (n_máx − n_actual)',
        '(' + (porTipoDisp.palet || 0) + ' / ' + nivAct + ' = ' + f(pPorNivel, 1) + ') · (' + nivMax + ' − ' + nivAct + ') = ' + f(extra, 0) + ' posiciones',
        { magnitud: extra, unidad: 'posiciones', texto: '+' + f(extra, 0) + ' posiciones (' + f(pct(extra, nPos), 1) + ' %) sin ocupar más superficie.' },
        'Evaluar con el proveedor de la estantería y con seguridad el nivel adicional (carga de viga, estabilidad, alcance del equipo y rociadores).', 'media',
        ['capacidad de viga y marco', 'alcance de elevación del equipo', 'holgura a rociadores (norma)'], pct(extra, nPos));
    }
    // utilización cúbica baja con ocupación alta: altura de nivel mayor que la carga
    if (cubica !== null && cubica < 15 && nPos > 0 && reqTotal / nPos >= 0.5 && racksPalet.length) {
      let altoMax = 0;
      productos.forEach(function (p) { if ((p.tipoUbic || 'palet') === 'palet') altoMax = Math.max(altoMax, num(p.altoCargaM, 0)); });
      const SOBRE = cfg.perfilViga + cfg.holguraSobreCarga; // perfil de viga + holgura sobre la carga [VERIFICAR ficha / EN 15620]
      const altoNivelMin = altoMax + SOBRE;
      if (altoMax > 0 && altoNivelMin < altoNivel) {
        const nivAlt = Math.floor((alturaUtil - altoBase + 1e-9) / altoNivelMin);
        // N3: se compara con nivMax (lo que ya cabe con el paso actual y ya cuenta «Altura sin usar»), no con los niveles actuales:
        // así el mismo espacio no se cuenta dos veces.
        if (nivAlt > nivMax) {
          const pPorNivel2 = nivAct > 0 ? (porTipoDisp.palet || 0) / nivAct : 0;
          const extra2 = pPorNivel2 * (nivAlt - nivMax);
          R(3, 'Utilización cúbica baja (' + f(cubica, 1) + ' %): el espacio entre vigas es mayor que la carga',
            'La carga más alta mide ' + f(altoMax, 2) + ' m y el nivel mide ' + f(altoNivel, 2) + ' m. Ajustando el paso de vigas a ' + f(altoNivelMin, 2) + ' m cabrían ' + nivAlt + ' niveles; con el paso actual ya caben ' + nivMax + ' (hoy hay ' + nivAct + '), así que lo adicional de esta medida es ' + (nivAlt - nivMax) + ' nivel(es), sin contar dos veces los de «Altura sin usar».',
            'Δposiciones = (posiciones por nivel) · (n_paso_ajustado − n_máx); n_paso_ajustado = ⌊(H_útil − altoBase) / (alto_carga_máx + holgura_viga)⌋',
            '⌊(' + f(alturaUtil, 1) + ' − ' + f(altoBase, 2) + ') / (' + f(altoMax, 2) + ' + ' + f(SOBRE, 2) + ')⌋ = ' + nivAlt + ' niveles; (' + (porTipoDisp.palet || 0) + ' / ' + nivAct + ' = ' + f(pPorNivel2, 1) + ') · (' + nivAlt + ' − ' + nivMax + ') = +' + f(extra2, 0) + ' posiciones adicionales a las de «Altura sin usar»',
            { magnitud: extra2, unidad: 'posiciones', texto: 'Hasta +' + f(extra2, 0) + ' posiciones sin ocupar más superficie (estimación geométrica).' },
            'Consultar al proveedor del rack el paso mínimo de vigas, la capacidad de carga y el alcance del equipo.', 'baja',
            ['perfil de viga y holgura sobre la carga (' + f(SOBRE, 2) + ' m, supuestos de configuración)', 'capacidad de marco y viga', 'alcance del equipo'], pct(extra2, nPos));
        }
      }
    }
    // pasillo de cruce
    {
      const base0 = escenarios.find(function (e) { return e.id === 'regenerado'; });
      const c6 = escenarios.find(function (e) { return e.id === 'cruce_6'; }), c10 = escenarios.find(function (e) { return e.id === 'cruce_10'; });
      if (base0 && c10 && c10.posiciones > base0.posiciones && (c10.posiciones - base0.posiciones) / Math.max(1, base0.posiciones) >= 0.01) {
        R(3, 'Pasillo de cruce cada 10 módulos: +' + (c10.posiciones - base0.posiciones) + ' posiciones',
          'Menos cruces dan más posiciones, a costa de recorridos más largos entre pasillos' + (c10.distMedia !== null && base0.distMedia !== null ? ' (recorrido medio ' + f(c10.distMedia, 2) + ' vs ' + f(base0.distMedia, 2) + ' m)' : '') + '.',
          'Δpos = pos(cruce cada 10) − pos(cruce cada 8)', c10.posiciones + ' − ' + base0.posiciones + ' = ' + (c10.posiciones - base0.posiciones) + ' (' + f(pct(c10.posiciones - base0.posiciones, base0.posiciones), 1) + ' %)',
          { magnitud: c10.posiciones - base0.posiciones, unidad: 'posiciones', texto: '+' + (c10.posiciones - base0.posiciones) + ' posiciones frente a la configuración actual regenerada.' },
          'Probar en plano; verificar que los tramos largos no entorpezcan el flujo ni las salidas de emergencia.', 'media', ['salidas de emergencia y flujo de equipos', 'heurística de generación, no óptimo'], pct(c10.posiciones - base0.posiciones, base0.posiciones));
      } else if (base0 && c6 && c6.distMedia !== null && base0.distMedia > 0 && (base0.distMedia - c6.distMedia) / base0.distMedia >= 0.03) {
        R(3, 'Pasillo de cruce cada 6 módulos: −' + f(pct(base0.distMedia - c6.distMedia, base0.distMedia), 1) + ' % de recorrido',
          'Tramos más cortos acercan los cruces y acortan caminos, con ' + (c6.posiciones - base0.posiciones) + ' posiciones de diferencia.',
          'Δ% = (d̄_cruce6 − d̄_regenerado) / d̄_regenerado', f(c6.distMedia, 2) + ' vs ' + f(base0.distMedia, 2) + ' m',
          { magnitud: base0.distMedia - c6.distMedia, unidad: 'm por pick', texto: f(base0.distMedia - c6.distMedia, 2) + ' m menos por pick (ida).' },
          'Probar en plano considerando la pérdida de posiciones.', 'baja', ['heurística de generación, no óptimo'], pct(base0.distMedia - c6.distMedia, base0.distMedia));
      }
    }
    // mejor escenario
    if (mejorEsc && nPos > 0 && porTipo.some(function (t) { return t.deficit > 0; }) && mejorEsc.deltaPosiciones / nPos >= 0.05 && mejorEsc.id !== 'nivel_mas' && mejorEsc.id !== 'cruce_10') {
      R(2, 'Escenario «' + mejorEsc.nombre + '»: +' + mejorEsc.deltaPosiciones + ' posiciones',
        mejorEsc.cambio + '. Recorrido medio ' + f(mejorEsc.distMedia, 2) + ' m vs ' + f(actualKpi ? actualKpi.dist : null, 2) + ' m actual (misma lógica de asignación). De las ' + (mejorEsc.deltaPosiciones >= 0 ? '+' : '') + mejorEsc.deltaPosiciones + ' posiciones, ' + (mejorEsc.deltaRegenerarPosiciones >= 0 ? '+' : '') + mejorEsc.deltaRegenerarPosiciones + ' se deben solo a volver a generar el layout y ' + (mejorEsc.deltaCambioPosiciones >= 0 ? '+' : '') + mejorEsc.deltaCambioPosiciones + ' al cambio propuesto.',
        'Δpos = pos(escenario) − pos(actual)', mejorEsc.posiciones + ' − ' + nPos + ' = ' + mejorEsc.deltaPosiciones + ' (' + f(mejorEsc.deltaPosPct, 1) + ' %)',
        { magnitud: mejorEsc.deltaPosiciones, unidad: 'posiciones', texto: '+' + mejorEsc.deltaPosiciones + ' posiciones (' + f(mejorEsc.deltaPosPct, 1) + ' %) al regenerar con ese cambio.' },
        'Analizar la viabilidad del cambio (equipo, inversión, seguridad); la generación es heurística y debe validarla el responsable de almacén.', 'media',
        ['ficha del fabricante del equipo (alcance de elevación y niveles que puede servir)', 'inversión y seguridad del cambio', 'parte del resultado se debe a regenerar: ver «regenerado» en escenarios'], pct(mejorEsc.deltaPosiciones, nPos));
    }
    // un escenario que suma posiciones brutas pero deja niveles inalcanzables NO es una mejora: se avisa
    if (brutoEsc && brutoEsc.alcanzables === false && brutoEsc.deltaPosiciones > 0 && (!mejorEsc || brutoEsc.posiciones > mejorEsc.posiciones)) {
      R(3, 'Escenario «' + brutoEsc.nombre + '»: suma posiciones que el equipo no alcanza',
        brutoEsc.nota,
        'Posiciones útiles = posiciones con nivel ≤ nivel máximo del equipo', brutoEsc.posicionesUtiles + ' de ' + brutoEsc.posiciones + ' posiciones útiles (bruto ' + (brutoEsc.deltaPosiciones >= 0 ? '+' : '') + brutoEsc.deltaPosiciones + ' vs actual)',
        { magnitud: brutoEsc.posiciones - brutoEsc.posicionesUtiles, unidad: 'posiciones', texto: 'De las ' + brutoEsc.posiciones + ' posiciones del escenario, ' + (brutoEsc.posiciones - brutoEsc.posicionesUtiles) + ' no son alcanzables con ese equipo.' },
        'No adoptar el cambio de equipo por la cifra bruta: compare con las posiciones útiles y con el costo de perder altura.', 'media',
        ['ficha del equipo (niveles que puede servir)', 'si el equipo solo sirve el nivel 1, los niveles superiores quedan sin uso'], 1);
    }
    // inaccesibles / sin ubicar
    if (dist && inaccesibles > 0) {
      R(2, inaccesibles + ' posiciones inaccesibles',
        'No hay ruta caminable desde las puertas hasta esas posiciones (' + f(pct(inaccesibles, nPos), 1) + ' % de la capacidad).',
        'Capacidad perdida = posiciones inaccesibles / posiciones totales', inaccesibles + ' / ' + nPos + ' = ' + f(pct(inaccesibles, nPos), 1) + ' %',
        { magnitud: inaccesibles, unidad: 'posiciones', texto: inaccesibles + ' posiciones no pueden usarse.' },
        'Abrir un pasillo, mover un rack o quitar el obstáculo que las encierra.', 'alta', [], pct(inaccesibles, nPos));
    }
    const invalidos = rec ? rec.sinUbicar.filter(function (s) { return s.motivo === 'duplicado' || s.motivo === 'datos'; }) : [];
    if (invalidos.length) {
      R(1, invalidos.length + ' SKU con datos inválidos o duplicados (no se ubican)',
        invalidos.slice(0, 5).map(function (s) { return s.sku + ' (' + s.motivo + '): ' + s.detalle; }).join(' · '),
        'SKU descartados = filas duplicadas + filas con unidades por ubicación ≤ 0 o datos no numéricos', invalidos.length + ' fila(s)',
        { magnitud: invalidos.length, unidad: 'SKU', texto: invalidos.length + ' SKU quedan fuera de la asignación y del cálculo de capacidad.' },
        'Corregir o unificar las filas en la tabla de productos y volver a asignar.', 'alta', [], 200);
    }
    const faltantes = rec ? rec.sinUbicar.filter(function (s) { return s.motivo !== 'duplicado' && s.motivo !== 'datos'; }) : [];
    if (rec && faltantes.length) {
      const faltan = faltantes.reduce(function (s, x) { return s + x.faltan; }, 0);
      R(1, faltantes.length + ' SKU sin ubicación completa (' + faltan + ' posiciones)',
        faltantes.slice(0, 5).map(function (s) { return s.sku + ': faltan ' + s.faltan + ' (' + s.motivo + ')'; }).join('; ') + '.',
        'Faltantes = Σ (posReq − posiciones ubicadas)', faltantes.length + ' SKU → ' + faltan + ' posiciones',
        { magnitud: faltan, unidad: 'posiciones', texto: faltan + ' posiciones de stock sin lugar compatible.' },
        'Revisar el motivo de cada SKU (capacidad, peso, altura, zona, tipo, incompatibilidad) y corregir el dato o ampliar la capacidad.', 'alta', [], 1);
    }

    /* ---- v1.1: recomendaciones nuevas (sin afirmar cumplimiento si falta el límite del usuario) ---- */
    if (muelle.requerido && muelle.balanceM2 !== null && muelle.balanceM2 < 0) {
      const afirm = muelle.afirmado && !muelle.sinZonas, q = muelle.requerido;
      R(afirm ? 1 : 3, 'Déficit de staging: faltan ' + f(-muelle.balanceM2, 1) + ' m²' + (afirm ? '' : ' (estimación con supuestos)'),
        (muelle.sinZonas ? 'No hay zonas «muelle»/«staging» dibujadas. ' : 'El área dibujada (' + f(muelle.disponibleM2.total, 1) + ' m²) no alcanza. ') + (afirm ? 'Calculado con sus datos (palets/día, m² por palet y factor de maniobra); ' : muelle.datosUsuario.palletsDiaRecepcion && muelle.datosUsuario.palletsDiaDespacho ? 'ESTIMACIÓN CON SUPUESTOS: usted dio los palets/día, pero se usaron supuestos propios: ' + muelle.supuestosPropios.join(' y ') + '; ' : 'ESTIMACIÓN: usted no declaró los palets/día, se estimaron desde entradas y picks; ') + 'el m²/palet y el factor de maniobra pueden ser valores típicos [VERIFICAR].',
        'Déficit = A_requerida − A_disponible; A_req = palets/día × días × m²/palet × factor de maniobra',
        f(q.total, 1) + ' − ' + f(muelle.disponibleM2.total, 1) + ' = ' + f(-muelle.balanceM2, 1) + ' m² (≈ ' + f(-muelle.balancePalets, 1) + ' palets)',
        { magnitud: -muelle.balanceM2, unidad: 'm²', texto: 'Faltan ' + f(-muelle.balanceM2, 1) + ' m² de staging' + (afirm ? '.' : ' (no afirmado: depende de supuestos).') },
        'Dibujar/ampliar la zona staging, reducir los días de permanencia o escalonar las recepciones; confirmar los palets/día con la operación.', afirm ? 'media' : 'baja',
        ['palets/día de recepción y despacho', 'días de permanencia', 'm² por palet y factor de maniobra'], -muelle.balanceM2);
    } else if (!muelle.requerido) {
      R(3, 'Muelle y staging: faltan datos para dimensionarlos',
        'No se pudo estimar el área de staging: faltan palets/día de recepción y despacho (config.muelle) y no hay productos desde los cuales estimarlos.',
        'A_staging = palets/día × días de permanencia × m²/palet × factor de maniobra', 'sin datos', { magnitud: null, unidad: 'm²', texto: 'Sin cifra.' },
        'Declarar palets/día de recepción y despacho en la configuración del muelle y dibujar las zonas muelle/staging.', 'baja', ['palets/día', 'zonas dibujadas'], 0);
    }
    if (evacuacion.disponible) {
      const E_ = evacuacion, PE = E_.posiciones;
      if (E_.fuente === 'puertas') {
        R(2, 'No hay salida de emergencia marcada',
          'La distancia de evacuación se midió hasta la puerta más cercana de cualquier tipo. Marque las salidas de emergencia reales para que el mapa de calor y las cifras sean válidas.',
          'd_evac = distancia caminando a la salida más cercana', 'salidas de emergencia marcadas = 0; puertas usadas = ' + E_.salidas, { magnitud: E_.salidas, unidad: 'puertas usadas', texto: 'Lectura provisional hasta marcar las salidas de emergencia.' },
          'Marcar en el plano las salidas de emergencia reales (tipo «salida_emergencia»).', 'alta', ['RNE A.130 / ITSE: salidas y rutas de evacuación reales'], 1);
      }
      if (PE && PE.sobreLimite && PE.sobreLimite.n > 0) {
        R(1, PE.sobreLimite.n + ' posiciones superan su distancia máxima de evacuación (' + f(PE.sobreLimite.limite, 1) + ' m)',
          'Con el límite que usted fijó, ' + f(PE.sobreLimite.pct, 1) + ' % de las posiciones lo excede (máx. ' + f(PE.max, 1) + ' m).',
          '% = posiciones con d_evac > evacMaxM / posiciones con ruta · 100', PE.sobreLimite.n + ' / ' + PE.n + ' = ' + f(PE.sobreLimite.pct, 1) + ' % (máx. ' + f(PE.max, 1) + ' m vs ' + f(PE.sobreLimite.limite, 1) + ' m)',
          { magnitud: PE.sobreLimite.n, unidad: 'posiciones', texto: PE.sobreLimite.n + ' posiciones por encima de su límite; revise el mapa de calor.' },
          'Agregar una salida o un pasillo de evacuación hacia las zonas rojas del mapa, o reubicar el almacenaje en ellas; validar con el inspector ITSE.', 'media', ['RNE A.130 / ITSE', 'el límite es dato suyo'], PE.sobreLimite.pct);
      } else if (PE && PE.max !== null && PE.sobreLimite === null) {
        R(3, 'Distancia de evacuación máxima de ' + f(PE.max, 1) + ' m: fije su límite para evaluarla',
          'El programa no afirma cumplimiento sin su límite. Máx. ' + f(PE.max, 1) + ' m, p95 ' + f(PE.p95, 1) + ' m (posiciones); en el piso, máx. ' + f(E_.celdas.max, 1) + ' m.',
          'd_evac = distancia caminando a la salida más cercana', 'máx = ' + f(PE.max, 1) + ' m en ' + PE.maxId + '; p95 = ' + f(PE.p95, 1) + ' m',
          { magnitud: PE.max, unidad: 'm', texto: 'Dato informativo hasta que usted fije evacMaxM.' },
          'Indicar el límite aplicable en la configuración (evacMaxM) tras consultarlo con el ITSE / RNE A.130.', 'media', ['RNE A.130 / ITSE'], 1);
      }
      if (E_.callejones.length) {
        const c0 = E_.callejones[0];
        R(2, E_.callejones.length + ' pasillo(s) sin salida (callejón)',
          'Pasillos con un único camino de salida: ' + E_.callejones.slice(0, 4).map(function (cj) { return cj.racks.join('/') + ' (' + f(cj.largoM, 1) + ' m, cerrado al ' + cj.extremoCerrado + ')'; }).join('; ') + '. No se afirma incumplimiento: depende de su criterio y de la norma.',
          'callejón = franja de acceso del rack con un solo extremo conectado a las salidas', E_.callejones.length + ' pasillo(s); el mayor: ' + c0.racks.join('/') + ' de ' + f(c0.largoM, 1) + ' m' + (c0.evacMaxM !== null ? ', con una posición a ' + f(c0.evacMaxM, 1) + ' m de la salida' : ''),
          { magnitud: E_.callejones.length, unidad: 'pasillos', texto: 'Quien está al fondo debe recorrer todo el pasillo para salir.' },
          'Evaluar abrir el extremo cerrado (puerta o cruce), acortar la fila o limitar la ocupación del fondo; confirmar con ITSE.', 'media', ['RNE A.130 / ITSE'], E_.callejones.length * 10);
      }
      if (E_.holgura.limite !== null && E_.holgura.posicionesConTramoAngosto > 0) {
        R(1, E_.holgura.posicionesConTramoAngosto + ' posiciones con ruta de evacuación más angosta que ' + f(E_.holgura.limite, 2) + ' m',
          'Ancho mínimo en las rutas: ' + f(E_.holgura.anchoMinRutas, 2) + ' m (resolución ± ' + f(E_.holgura.resolucionM, 2) + ' m); ' + f(E_.holgura.pctLongitudAngosta, 1) + ' % de la longitud de las rutas está por debajo del mínimo que usted fijó.',
          '% = posiciones cuya ruta tiene algún tramo con ancho < anchoEvacuacionMin', E_.holgura.posicionesConTramoAngosto + ' / ' + PE.n + ' = ' + f(E_.holgura.pctPosicionesConTramoAngosto, 1) + ' %',
          { magnitud: E_.holgura.posicionesConTramoAngosto, unidad: 'posiciones', texto: 'Rutas con cuello de botella respecto de su mínimo.' },
          'Ampliar el pasillo o retirar el obstáculo del tramo angosto; medir en planta (la malla tiene resolución de una celda).', 'media', ['RNE A.130 / ITSE', 'medición real del ancho'], E_.holgura.pctPosicionesConTramoAngosto);
      }
    }
    if (cargas.disponible && cargas.excedidos.length) {
      const e0 = cargas.excedidos.slice().sort(function (a, b) { return b.pctModulo - a.pctModulo; })[0];
      R(1, cargas.excedidos.length + ' módulo(s) por encima de su capacidad de placa',
        'Módulos que superan el cargaMaxModuloKg que usted declaró: ' + cargas.excedidos.slice(0, 4).map(function (e) { return e.rackNombre + '·' + e.modulo + ' (' + f(e.pctModulo, 0) + ' %)'; }).join(', ') + '.',
        'excedido ⇔ Σ kg del módulo > cargaMaxModuloKg', e0.rackNombre + ' · módulo ' + e0.modulo + ': ' + f(e0.kg, 0) + ' / ' + f(e0.cargaMaxModuloKg, 0) + ' kg = ' + f(e0.pctModulo, 1) + ' %',
        { magnitud: e0.kg - e0.cargaMaxModuloKg, unidad: 'kg', texto: 'Exceso de ' + f(e0.kg - e0.cargaMaxModuloKg, 0) + ' kg en el módulo más cargado.' },
        'Redistribuir las cargas pesadas a otros módulos o consultar al fabricante por la capacidad real del bastidor.', 'media', ['placa del fabricante', 'ingeniero estructural'], e0.pctModulo);
    }
    if (cargas.disponible && cargas.limitePisoDado !== null && cargas.maxKgM2Huella > cargas.limitePisoDado) {
      R(1, 'Carga por m² de huella (' + f(cargas.maxKgM2Huella, 0) + ' kg/m²) sobre el límite de piso que usted dio',
        'Comparación conservadora con la huella del módulo; no es la presión real sobre la losa, que depende de las patas del marco.',
        'q = Σ kg del módulo / (largo del módulo · fondo) vs cargaPisoMaxKgM2', f(cargas.maxKgM2Huella, 0) + ' vs ' + f(cargas.limitePisoDado, 0) + ' kg/m²',
        { magnitud: cargas.maxKgM2Huella - cargas.limitePisoDado, unidad: 'kg/m²', texto: 'Exceso respecto de su límite.' },
        'Repartir cargas o consultar al ingeniero estructural la capacidad de la losa y las cargas puntuales.', 'baja', ['ingeniero estructural', 'capacidad de la losa'], 50);
    }
    if (pico.disponible && pico.recomendar) {
      const tp = pico.porTipo.filter(function (x) { return x.deficitPico > 0; });
      const t0_ = tp[0];
      R(2, 'Déficit en el pico: faltan ' + tp.reduce(function (s, x) { return s + x.deficitPico; }, 0) + ' posiciones',
        'Con stockMax, ' + tp.map(function (x) { return x.tipo + ' pide ' + x.requeridasPico + ' vs ' + x.disponibles; }).join('; ') + '. ' + pico.conclusion,
        'Déficit_pico = N_pico − N_disp', t0_.tipo + ': ' + t0_.requeridasPico + ' − ' + t0_.disponibles + ' = ' + t0_.deficitPico + (t0_.m2Adicionales ? ' (≈ ' + f(t0_.m2Adicionales, 1) + ' m²)' : '') + (t0_.nivelesAdicionales ? ' o +' + t0_.nivelesAdicionales + ' nivel(es)' : ''),
        { magnitud: t0_.deficitPico, unidad: 'posiciones', texto: 'En el pico no caben ' + t0_.deficitPico + ' posiciones de ' + t0_.tipo + '.' },
        'Si la ubicación de cada SKU es fija, dimensionar por el máximo; si es dinámica, planificar espacio temporal (staging, tercero) para el pico.', 'media', ['stockMax realista (no un pico excepcional)'], 100 * t0_.deficitPico / Math.max(1, t0_.disponibles));
    }
    if (fefo.disponible) {
      if (fefo.vencidos && fefo.vencidos.length) {
        R(1, fefo.vencidos.length + ' lote(s) vencido(s)', 'Lotes vencidos al ' + fefo.fechaReferencia + ': ' + fefo.vencidos.slice(0, 5).map(function (l) { return l.sku + '/' + l.lote + ' (' + l.vence + ')'; }).join(', ') + '.',
          'vencido ⇔ vence < fecha de referencia', fefo.vencidos.length + ' lotes, ' + f(fefo.vencidos.reduce(function (s, l) { return s + l.cantidad; }, 0), 0) + ' unidades',
          { magnitud: fefo.vencidos.length, unidad: 'lotes', texto: 'Stock vencido ocupando posiciones.' }, 'Separar en cuarentena y disponer según el procedimiento de calidad.', 'alta', ['procedimiento de calidad del cliente'], 200);
      }
      if (fefo.porVencer && fefo.porVencer.length) {
        R(2, fefo.porVencer.length + ' lote(s) por vencer en ≤ ' + f(fefo.diasAlerta, 0) + ' días',
          'Lotes: ' + fefo.porVencer.slice(0, 5).map(function (l) { return l.sku + '/' + l.lote + ' (' + l.diasRestantes + ' d)'; }).join(', ') + '. ' + f(fefo.pctStockVenceEnN, 1) + ' % del stock con vencimiento ≤ ' + f(fefo.diasAlerta, 0) + ' días (incluye vencidos).',
          'por vencer ⇔ 0 ≤ días restantes ≤ N', fefo.porVencer.length + ' lotes; N = ' + f(fefo.diasAlerta, 0) + ' días (suyo)',
          { magnitud: fefo.porVencer.length, unidad: 'lotes', texto: 'Priorizar su salida.' }, 'Priorizar su despacho (FEFO), promocionarlos o devolverlos al proveedor.', 'alta', ['días de alerta definidos por el cliente'], 100);
      }
      if (fefo.fefoEnLifo.length) {
        R(1, fefo.fefoEnLifo.length + ' SKU FEFO en ubicaciones LIFO', 'SKU: ' + fefo.fefoEnLifo.map(function (x) { return x.sku; }).slice(0, 5).join(', ') + '. En un carril LIFO sale primero lo último que entró: contradice FEFO.',
          'conteo de SKU fefo con posiciones lifo', fefo.fefoEnLifo.length + ' SKU', { magnitud: fefo.fefoEnLifo.length, unidad: 'SKU', texto: 'Riesgo de vencimientos por salida fuera de orden.' },
          'Reubicar en posiciones no LIFO (palet selectivo, flujo por gravedad) o cambiar la regla del SKU.', 'alta', [], 150);
      }
      if (fefo.ordenIncumplido.length) {
        R(3, fefo.ordenIncumplido.length + ' SKU con lotes mal ordenados respecto del despacho', 'En ' + fefo.ordenIncumplido.map(function (x) { return x.sku; }).slice(0, 5).join(', ') + ' un lote que vence después queda más cerca del despacho que uno que vence antes.',
          'OK ⇔ distancia al despacho no decrece con el vencimiento', fefo.ordenIncumplido.length + ' de ' + fefo.skusEvaluadosOrden + ' SKU evaluados', { magnitud: fefo.ordenIncumplido.length, unidad: 'SKU', texto: 'Reordenar lotes.' },
          'Reasignar o reordenar físicamente los lotes por vencimiento.', 'media', [], 20);
      }
    }
    if (afinidad.disponible && afinidad.metrosEvitablesHistorial > 0) {
      const a0 = afinidad.pares.filter(function (e) { return e.metrosEvitablesHistorial > 0; }).sort(function (x, y) { return y.metrosEvitablesHistorial - x.metrosEvitablesHistorial; })[0];
      R(3, 'Afinidad: juntar pares de SKU ahorraría ' + f(afinidad.metrosEvitablesPorPedido, 2) + ' m por pedido',
        'Pares con lift > 1 y ≥ ' + afinidad.minCoocurrencias + ' co-ocurrencias están lejos entre sí. ' + (afinidad.nPedidos < 30 ? 'Muestra pequeña (' + afinidad.nPedidos + ' pedidos) [VERIFICAR]. ' : '') + 'No considera el conflicto con la rotación ABC.',
        'ΔM = Σ soporte · (d_actual − d_objetivo)', a0.a + '+' + a0.b + ': ' + a0.coocurrencias + ' co-ocurrencias · (' + f(a0.distancia, 1) + ' − ' + f(afinidad.distObjetivo, 1) + ') m = ' + f(a0.metrosEvitablesHistorial, 0) + ' m en el historial; total ' + f(afinidad.metrosEvitablesHistorial, 0) + ' m en ' + afinidad.nPedidos + ' pedidos',
        { magnitud: afinidad.metrosEvitablesHistorial, unidad: 'm en el historial', texto: f(afinidad.metrosEvitablesPorPedido, 2) + ' m por pedido en promedio.' },
        'Probar con config.pesoAfinidad > 0 y comparar el recorrido; validar con el área de pedidos.', afinidad.nPedidos < 30 ? 'baja' : 'media', ['historial de pedidos representativo'], afinidad.metrosEvitablesPorPedido);
    }
    if (reposicion.disponible && reposicion.comparativa) {
      const cp = reposicion.comparativa;
      if (!reposicion.activa && cp.conviene) {
        R(3, 'Picking/reserva conviene: −' + f(-cp.deltaCostoPct, 1) + ' % de costo',
          'Separar 1 posición de picking en nivel accesible y dejar el resto en reserva baja el costo bajo los supuestos del motor (incluye ' + f(reposicion.reposPorPeriodo, 1) + ' reposiciones/periodo).',
          'Δ% = (costo_con − costo_sin) / costo_sin', f(cp.conReposicion.costoTotal, 0) + ' vs ' + f(cp.sinReposicion.costoTotal, 0) + ' → ' + f(cp.deltaCostoPct, 1) + ' %',
          { magnitud: -cp.deltaCostoPct, unidad: '% del costo', texto: 'Reducción de costo estimada con reposición incluida.' }, 'Activar config.reposicion.activa y definir con logística el punto y la frecuencia de reposición.', 'media', ['unidades por línea de pedido', 'procedimiento de reposición'], -cp.deltaCostoPct);
      } else if (reposicion.activa && cp.deltaCostoPct !== null && cp.deltaCostoPct >= 2) {
        R(3, 'El modo picking/reserva encarece el costo en ' + f(cp.deltaCostoPct, 1) + ' %', 'Con reposición incluida, separar picking y reserva cuesta más que no separar, bajo estos supuestos.',
          'Δ% = (costo_con − costo_sin) / costo_sin', f(cp.conReposicion.costoTotal, 0) + ' vs ' + f(cp.sinReposicion.costoTotal, 0) + ' → ' + f(cp.deltaCostoPct, 1) + ' %',
          { magnitud: cp.deltaCostoPct, unidad: '% del costo', texto: 'Mayor costo con picking/reserva.' }, 'Revisar unidades por línea y desactivar el modo si no se justifica.', 'media', ['unidades por línea de pedido'], cp.deltaCostoPct);
      }
      if (reposicion.faltaUnidadesPorLinea.length) {
        R(3, 'Faltan unidades por línea en ' + reposicion.faltaUnidadesPorLinea.length + ' SKU de varias posiciones', 'Sin ese dato las reposiciones se estiman con 1 unidad por línea [FALTA: unidades por línea de pedido].',
          'repos = picks · unidadesPorLinea / unidadesPorUbic', 'SKU: ' + reposicion.faltaUnidadesPorLinea.slice(0, 5).join(', '), { magnitud: reposicion.faltaUnidadesPorLinea.length, unidad: 'SKU', texto: 'Dato faltante.' },
          'Medir el promedio de unidades por línea de pedido y cargarlo en cada SKU.', 'alta', [], 2);
      }
    }
    if (crossdock.disponible && crossdock.ahorroStagingMetros > 0) {
      R(3, 'Cross-docking: el staging obliga a un desvío de ' + f(crossdock.staging.desvio, 1) + ' m por palet',
        'Mover el staging al camino directo entre recepción y despacho evita ese desvío.', 'ΔM = flujo · [d(rec→staging) + d(staging→desp) − d(rec→desp)]', f(crossdock.flujoTotal, 1) + ' palets · ' + f(crossdock.staging.desvio, 1) + ' m = ' + f(crossdock.ahorroStagingMetros, 0) + ' m·palet/periodo',
        { magnitud: crossdock.ahorroStagingMetros, unidad: 'm·palet/periodo', texto: 'Metros·palet que se evitarían.' }, 'Reubicar la zona staging sobre la ruta recepción→despacho.', 'media', ['flujo de cross-docking real'], 5);
    }
    let sensRes = op.sensibilidadResultado;
    if (!sensRes && op.sensibilidad) { sensRes = seguro('sensibilidad', function () { return sensibilidad(P, {}); }, {}); }
    if (sensRes && Array.isArray(sensRes.resumen)) {
      const sensibles = sensRes.resumen.filter(function (x) { return x.sensibilidad === 'alta' || x.sensibilidad === 'media'; });
      if (sensibles.length) {
        const s0 = sensibles[0];
        R(3, 'Parámetros sensibles: ' + sensibles.slice(0, 3).map(function (x) { return x.id; }).join(', '),
          'Variar estos parámetros ±50 % cambia el costo bajo el criterio base en 5 % o más (umbral propio [PROPIO]): ' + sensibles.map(function (x) { return x.nombre; }).join('; ') + '. Confírmelos con la operación antes de decidir.',
          'sensible ⇔ |Δcosto| ≥ 5 % con el criterio base (±50 %, variaciones comparables); el % de SKU que cambian es solo informativo', s0.id + ': hasta ' + f(s0.maxDeltaCostoPct, 2) + ' % de costo (informativo: ' + f(s0.maxSkusCambiadosPct, 1) + ' % de SKU cambian de posición)',
          { magnitud: sensibles.length, unidad: 'parámetros', texto: sensibles.length + ' parámetro(s) condicionan el resultado.' }, 'Fijar estos valores con datos de planta (tiempos, pesos, reglas) y repetir el análisis.', 'media', ['criterios [PROPIO] de robustez'], sensibles.length * 5);
      }
    }

    recs.sort(function (a, b) { return a.prioridad - b.prioridad || b._orden - a._orden || (a.id < b.id ? -1 : 1); });
    recs.forEach(function (r) { delete r._orden; });
    // los ids siguen el orden final
    recs.forEach(function (r, i) { r.id = 'R' + String(i + 1).padStart(2, '0'); });
    if (!recs.length) adv.push('No se detectó ninguna recomendación con los datos actuales (o faltan datos para evaluarlas).');
    if (truncado) supuestos.push('La lista de escenarios está TRUNCADA por el tope de tiempo.');

    return {
      espacio: { areas: areas, metricas: met },
      capacidad: { porTipo: porTipo, metricas: capMet },
      movimiento: { metricas: mov },
      escenarios: escenarios,
      muelle: muelle, evacuacion: evacuacion, cargas: cargas, pico: pico, crossdock: crossdock, afinidad: afinidad, reposicion: reposicion, fefo: fefo,
      sensibilidad: sensRes && Array.isArray(sensRes.resumen) ? sensRes : null,
      recomendaciones: recs,
      supuestos: supuestos,
      supuestosAsignacion: rec && Array.isArray(rec.supuestos) ? rec.supuestos.slice() : [],
      advertencias: adv,
      meta: { generacion: { fuente: gGuardada ? 'proyecto' : 'por_defecto', opciones: clonar(genOpts) }, tiempoMs: Math.round(ahora() - t0), truncado: truncado, opciones: { velocidadMs: op.velocidadMs, segPorPick: op.segPorPick, periodoDias: op.periodoDias, costoHora: op.costoHora, crecimientoPct: op.crecimientoPct, ocupacionObjetivo: op.ocupacionObjetivo, evacMaxM: op.evacMaxM, anchoEvacuacionMin: op.anchoEvacuacionMin, cargaPisoMaxKgM2: op.cargaPisoMaxKgM2, fechaReferencia: op.fechaReferencia, minCoocurrencias: op.minCoocurrencias, topPares: op.topPares } }
    };
  }

  return { analizar: analizar, sensibilidad: sensibilidad };
});
