/*!
 * motor.js — Motor de cálculo del «Diseñador de Almacén con Slotting Automático».
 *
 * Lógica pura (sin DOM, sin dependencias). UMD: `window.AlmacenMotor` y `module.exports`.
 * Convenciones (ver CONTRATO.md §2): metros, origen arriba-izquierda, y crece hacia abajo,
 * ángulos en grados; eje local x del rack = (cos a, sin a), eje local y = (−sin a, cos a).
 *
 * Importante (honestidad): todo lo que hace el motor es HEURÍSTICO (no óptimo) y los valores
 * típicos (anchos de pasillo, holguras, penalizaciones) son supuestos a verificar con el
 * responsable de almacén y con la ficha del fabricante. Cada resultado lista sus `supuestos`.
 */
(function (raiz, fabrica) {
  'use strict';
  if (typeof module === 'object' && module && module.exports) {
    module.exports = fabrica();
  } else {
    raiz.AlmacenMotor = fabrica();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ======================================================================
   * 0. UTILIDADES GENERALES
   * ==================================================================== */

  const EPS = 1e-9;
  const VERSION_MOTOR = '1.2.0';

  /**
   * Ancho de pasillo típico por equipo (m): ORDEN DE MAGNITUD [VERIFICAR con la ficha del equipo]. El pasillo
   * real = ancho del equipo + largo del palet + holguras de maniobra (p. ej. guía VDMA 15173 / ficha del
   * fabricante). `manual` = persona o carro de picking (proyectos guardados con «manual» siguen válidos);
   * `transpaleta` = transpaleta eléctrica o manual con palet.
   */
  const PRESETS_EQUIPO = { manual: 1.2, transpaleta: 2.3, apilador: 2.4, retractil: 2.9, contrapesado: 3.8, vna: 1.8 };

  /** Holgura mínima entre la carga y los rociadores por tipo (m). [VERIFICAR con el ingeniero de protección contra incendios; NFPA 13 / RNE A.130] */
  const HOLGURA_ROCIADOR = { estandar: 0.75, esfr: 1.2 };

  /** Nombres legibles de los equipos (para la UI). */
  const NOMBRES_EQUIPO = {
    manual: 'Manual (persona / carro de picking)',
    transpaleta: 'Transpaleta (eléctrica o manual)',
    apilador: 'Apilador',
    retractil: 'Carretilla retráctil',
    contrapesado: 'Montacargas contrapesado',
    vna: 'Pasillo muy estrecho (VNA)'
  };

  const ZONAS_RESTRINGIDAS = ['frio', 'peligrosos', 'alto_valor', 'cuarentena'];

  /** Tipos de ubicación admitidos (v1.1 agrega 'cantilever'). */
  const TIPOS_UBIC = ['palet', 'bin', 'piso', 'cantilever'];

  /** Clases de peligro de la matriz de segregación (v1.1). */
  const CLASES_PELIGRO = ['inflamable', 'oxidante', 'corrosivo_acido', 'corrosivo_base', 'bateria_litio', 'toxico', 'alimento'];

  /**
   * Matriz de segregación por clase de peligro, VALORES TÍPICOS DE PARTIDA. `distMinM:null` = usar
   * `config.separacionIncompatibles` como distancia mínima entre HUELLAS de rack; el mismo rack siempre está prohibido.
   * [VERIFICAR con HDS (hoja de datos de seguridad) y seguridad-sst: la matriz y las distancias reales las fija el
   * responsable de seguridad según la norma aplicable; esto es una referencia, no una norma.]
   */
  const SEGREGACION_DEFECTO = Object.freeze([
    Object.freeze({ a: 'inflamable', b: 'oxidante', distMinM: null }),
    Object.freeze({ a: 'inflamable', b: 'bateria_litio', distMinM: null }),
    Object.freeze({ a: 'corrosivo_acido', b: 'corrosivo_base', distMinM: null }),
    Object.freeze({ a: 'alimento', b: 'inflamable', distMinM: null }),
    Object.freeze({ a: 'alimento', b: 'toxico', distMinM: null }),
    Object.freeze({ a: 'alimento', b: 'corrosivo_acido', distMinM: null }),
    Object.freeze({ a: 'alimento', b: 'corrosivo_base', distMinM: null }),
    Object.freeze({ a: 'alimento', b: 'oxidante', distMinM: null })
  ]);
  const SEGREGACION_REF = '[VERIFICAR con HDS y seguridad-sst] Matriz de segregación de partida (no es una norma); las distancias reales las fija el responsable de seguridad.';

  /** Topes de cordura de los racks de piso. */
  const MAX_PROFUNDIDAD = 30, MAX_APILADO = 6;

  /** Devuelve v si es número finito; si no, el valor por defecto. */
  function num(v, def) {
    return typeof v === 'number' && isFinite(v) ? v : def;
  }

  /** Redondea a n decimales (evita ruido de coma flotante). */
  function redondear(v, n) {
    const f = Math.pow(10, n === undefined ? 6 : n);
    return Math.round(v * f) / f;
  }

  /** Copia profunda de datos JSON. */
  function clonar(o) {
    return JSON.parse(JSON.stringify(o));
  }

  /** PRNG determinista (mulberry32). Devuelve función () → [0,1). */
  function crearPRNG(semilla) {
    let a = (semilla >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Rellena con ceros a la izquierda. */
  function pad(n, ancho) {
    let s = String(n);
    while (s.length < ancho) s = '0' + s;
    return s;
  }

  /** Reloj en ms (performance.now si existe). */
  function ahoraMs() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  }

  /* ======================================================================
   * 1. GEOMETRÍA
   * ==================================================================== */

  /** Área firmada (shoelace). */
  function areaFirmada(poly) {
    let s = 0;
    for (let i = 0, n = poly.length; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      s += a[0] * b[1] - b[0] * a[1];
    }
    return s / 2;
  }

  /** Área absoluta de un polígono (m²). */
  function areaPoligono(poly) {
    if (!poly || poly.length < 3) return 0;
    return Math.abs(areaFirmada(poly));
  }

  /** Distancia de un punto a un segmento. */
  function distPuntoSegmento(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + t * dx, qy = ay + t * dy;
    return Math.hypot(px - qx, py - qy);
  }

  /** ¿Punto dentro del polígono? (borde cuenta como dentro; cualquier forma, convexa o no). */
  function puntoEnPoligono(p, poly) {
    const x = p[0], y = p[1];
    let dentro = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (distPuntoSegmento(x, y, xi, yi, xj, yj) < 1e-9) return true;
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dentro = !dentro;
    }
    return dentro;
  }

  /** ¿Punto estrictamente dentro (a más de `tol` del borde)? */
  function puntoDentroEstricto(p, poly, tol) {
    const t = tol === undefined ? 1e-7 : tol;
    const x = p[0], y = p[1];
    let dentro = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (distPuntoSegmento(x, y, xi, yi, xj, yj) <= t) return false;
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dentro = !dentro;
    }
    return dentro;
  }

  /** Caja envolvente. */
  function bboxPoligono(poly) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < poly.length; i++) {
      const x = poly[i][0], y = poly[i][1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY, ancho: maxX - minX, alto: maxY - minY };
  }

  /** Orientación de la terna (a,b,c). */
  function orient(ax, ay, bx, by, cx, cy) {
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  }

  /** ¿Se cruzan los segmentos ab y cd de forma propia (sin solo tocarse)? */
  function segmentosSeCruzan(a, b, c, d) {
    const o1 = orient(a[0], a[1], b[0], b[1], c[0], c[1]);
    const o2 = orient(a[0], a[1], b[0], b[1], d[0], d[1]);
    const o3 = orient(c[0], c[1], d[0], d[1], a[0], a[1]);
    const o4 = orient(c[0], c[1], d[0], d[1], b[0], b[1]);
    return ((o1 > EPS && o2 < -EPS) || (o1 < -EPS && o2 > EPS)) &&
           ((o3 > EPS && o4 < -EPS) || (o3 < -EPS && o4 > EPS));
  }

  /** ¿Algún borde de A cruza propiamente algún borde de B? */
  function bordesSeCruzan(A, B) {
    for (let i = 0, na = A.length; i < na; i++) {
      const a1 = A[i], a2 = A[(i + 1) % na];
      for (let j = 0, nb = B.length; j < nb; j++) {
        if (segmentosSeCruzan(a1, a2, B[j], B[(j + 1) % nb])) return true;
      }
    }
    return false;
  }

  /** Promedio de vértices (centroide simple, suficiente para pruebas de solape). */
  function mediaVertices(poly) {
    let sx = 0, sy = 0;
    for (let i = 0; i < poly.length; i++) { sx += poly[i][0]; sy += poly[i][1]; }
    return [sx / poly.length, sy / poly.length];
  }

  /** ¿Los polígonos A y B se solapan (área común > 0)? Tocarse por el borde NO es solape. */
  function poligonosSolapan(A, B) {
    if (!A || !B || A.length < 3 || B.length < 3) return false;
    const ba = bboxPoligono(A), bb = bboxPoligono(B);
    if (ba.maxX <= bb.minX + 1e-7 || bb.maxX <= ba.minX + 1e-7 ||
        ba.maxY <= bb.minY + 1e-7 || bb.maxY <= ba.minY + 1e-7) return false;
    if (bordesSeCruzan(A, B)) return true;
    for (let i = 0; i < A.length; i++) if (puntoDentroEstricto(A[i], B)) return true;
    for (let i = 0; i < B.length; i++) if (puntoDentroEstricto(B[i], A)) return true;
    if (puntoDentroEstricto(mediaVertices(A), B) || puntoDentroEstricto(mediaVertices(B), A)) return true;
    return false;
  }

  /** ¿El polígono `sub` está contenido en `cont` (cualquier forma)? */
  function poligonoContenido(sub, cont) {
    for (let i = 0; i < sub.length; i++) if (!puntoEnPoligono(sub[i], cont)) return false;
    if (bordesSeCruzan(sub, cont)) return false;
    for (let i = 0; i < cont.length; i++) if (puntoDentroEstricto(cont[i], sub)) return false;
    return true;
  }

  /** Vértices (4) de un rectángulo orientado: centro, ángulo (grados), largo (local x), fondo (local y). */
  function rectanguloOrientado(cx, cy, angGrados, largo, fondo) {
    const a = (angGrados * Math.PI) / 180;
    const c = Math.cos(a), s = Math.sin(a);
    const hx = largo / 2, hy = fondo / 2;
    const loc = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]];
    return loc.map(function (p) { return [cx + p[0] * c - p[1] * s, cy + p[0] * s + p[1] * c]; });
  }

  /** 4 vértices de la huella de un rack. */
  function poligonoRack(rack) {
    return rectanguloOrientado(rack.cx, rack.cy, rack.ang || 0, rack.largo, rack.fondo);
  }

  /* ======================================================================
   * 2. PROYECTO, CONFIGURACIÓN Y PLANTILLAS
   * ==================================================================== */

  /** Configuración por defecto para un tipo de equipo. */
  function configPorDefecto(equipo) {
    const eq = PRESETS_EQUIPO[equipo] !== undefined ? equipo : 'apilador';
    const ancho = PRESETS_EQUIPO[eq];
    return {
      equipo: eq,
      anchoPasillo: ancho,
      anchoPasilloCruce: Math.max(2.4, ancho),
      flue: 0.15,
      margenMuro: 0.3,
      celdaM: 0.5,
      alturaLibreNave: 8,
      // Altura libre = hasta el obstáculo más bajo (tijeral, tubería, luminaria), NO la altura al alero. [VERIFICAR]
      tipoRociador: 'estandar',      // 'estandar' (0,75 m) | 'esfr' (1,2 m): holgura a rociadores [VERIFICAR NFPA 13 / RNE A.130]
      holguraRociadores: null,       // null = derivar de tipoRociador; un número explícito manda
      perfilViga: 0.12,              // m; el alto de la carga incluye el palet [VERIFICAR ficha del fabricante / EN 15620]
      holguraSobreCarga: 0.1,        // m entre la carga y la viga superior [VERIFICAR EN 15620]
      pesoRecepcion: 0.3,
      factorEntradas: 0.25,
      abc: { a: 0.8, b: 0.95 },
      penalNivelPalet: 2.5,
      separacionIncompatibles: 6,    // m entre HUELLAS de rack [NO VERIFICADO; lo fija la hoja de seguridad (HDS): VERIFICAR con seguridad-sst]
      pesoPesadoKg: 400,             // kg por ubicación de PALET sobre el cual la carga es «pesada» [PROPIO – ajustar]
      pesoPesadoBinKg: 15,           // kg por ubicación de BIN [PROPIO – ajustar; criterio ergonómico del cliente]
      nivelMaxPesado: 2,             // nivel máximo permitido para cargas pesadas en palet (restricción) [PROPIO – ajustar]
      nivelMaxPesadoBin: 1,          // ídem en bin
      pasadasMejora: 3,
      // ---- v1.1 (todos con valor por defecto que reproduce v1.0) ----
      dimensionarPor: 'actual',      // 'actual' | 'maximo' (usa producto.stockMax)
      reposicion: { activa: false, posicionesPicking: 1 },
      segregacion: { usar: true, matriz: null },   // null = SEGREGACION_DEFECTO
      pesoAfinidad: 0.3,
      fechaReferencia: null,         // 'YYYY-MM-DD'; el motor NO lee el reloj
      diasAlertaVencimiento: null,
      evacMaxM: null,                // límites DEL USUARIO: null = no afirmar cumplimiento
      anchoEvacuacionMin: null,
      cargaPisoMaxKgM2: null,
      muelle: { palletsDiaRecepcion: null, palletsDiaDespacho: null, diasPermanenciaRec: 1, diasPermanenciaDesp: 1, m2PorPalet: null, factorManiobra: null },
      // ---- v1.2 ----
      cantileverCombinar: true,      // true = una carga más larga que la bahía ocupa k bahías contiguas del mismo rack y nivel; false = comportamiento v1.1
      pasilloVDMA: null              // null | {radioGiroM, largoCargaM, holguraCargaRackM, holguraSeguridadM}: datos del usuario para calcularPasilloVDMA
    };
  }

  /** Proyecto vacío. */
  function crearProyectoVacio() {
    return {
      version: 2,
      nombre: 'Almacén sin nombre',
      plano: { imagen: null, anchoPx: 0, altoPx: 0, mPorPx: null, x0: 0, y0: 0, opacidad: 0.5 },
      contorno: [],
      huecos: [],
      puertas: [],
      zonas: [],
      racks: [],
      config: configPorDefecto('apilador'),
      productos: [],
      pedidos: [],
      resultado: null,
      marca: { empresa: '', autor: '', logo: null }   // v1.2: marca del informe (opcional)
    };
  }

  /** Proyecto con nave rectangular ancho × largo (m), esquina superior izquierda en (0,0). */
  function crearProyectoRectangular(ancho, largo) {
    const p = crearProyectoVacio();
    p.nombre = 'Nave rectangular ' + ancho + ' × ' + largo + ' m';
    p.contorno = [[0, 0], [ancho, 0], [ancho, largo], [0, largo]];
    return p;
  }

  /**
   * Proyecto en forma de L. Caja total anchoTotal × largoTotal (m).
   * `anchoBrazo` = ancho del brazo vertical (izquierdo, de arriba a abajo);
   * `largoBrazo` = espesor (alto) del brazo horizontal inferior, que se extiende hasta anchoTotal.
   */
  function crearProyectoEnL(anchoTotal, largoTotal, anchoBrazo, largoBrazo) {
    const p = crearProyectoVacio();
    p.nombre = 'Nave en L ' + anchoTotal + ' × ' + largoTotal + ' m';
    p.contorno = [
      [0, 0], [anchoBrazo, 0], [anchoBrazo, largoTotal - largoBrazo],
      [anchoTotal, largoTotal - largoBrazo], [anchoTotal, largoTotal], [0, largoTotal]
    ];
    return p;
  }

  /** Escala del plano: metros por píxel a partir de dos puntos de la imagen y su distancia real. */
  function escalaDesdeCalibracion(p1, p2, metros) {
    if (!p1 || !p2 || !(metros > 0)) return null;
    const dpx = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    if (!(dpx > 0)) return null;
    return metros / dpx;
  }

  /* ======================================================================
   * 3. IMAGEN → FORMA
   * ==================================================================== */

  /** Máscara de «piso libre» (luminancia ≥ umbral); transparencia se compone sobre blanco. */
  function mascaraClara(data, n, umbral) {
    const claro = new Uint8Array(n);
    for (let i = 0, k = 0; i < n; i++, k += 4) {
      let lum = 0.299 * data[k] + 0.587 * data[k + 1] + 0.114 * data[k + 2];
      const a = data[k + 3] === undefined ? 1 : data[k + 3] / 255;
      if (a < 1) lum = lum * a + 255 * (1 - a);
      claro[i] = lum >= umbral ? 1 : 0;
    }
    return claro;
  }

  /** Relleno por inundación (4 vecinos) sobre una máscara. Devuelve región, área y si toca el borde. */
  function inundar(mask, ancho, alto, sx, sy) {
    const n = ancho * alto;
    const region = new Uint8Array(n);
    const pila = new Int32Array(n);
    let tope = 0, area = 0, toca = false;
    const ini = sy * ancho + sx;
    region[ini] = 1;
    pila[tope++] = ini;
    while (tope > 0) {
      const i = pila[--tope];
      area++;
      const x = i % ancho, y = (i - x) / ancho;
      if (x === 0 || y === 0 || x === ancho - 1 || y === alto - 1) toca = true;
      if (x > 0 && mask[i - 1] && !region[i - 1]) { region[i - 1] = 1; pila[tope++] = i - 1; }
      if (x < ancho - 1 && mask[i + 1] && !region[i + 1]) { region[i + 1] = 1; pila[tope++] = i + 1; }
      if (y > 0 && mask[i - ancho] && !region[i - ancho]) { region[i - ancho] = 1; pila[tope++] = i - ancho; }
      if (y < alto - 1 && mask[i + ancho] && !region[i + ancho]) { region[i + ancho] = 1; pila[tope++] = i + ancho; }
    }
    return { region: region, area: area, toca: toca };
  }

  /** Dilata (Chebyshev, radio r) una máscara binaria con dos barridos separables. */
  function dilatar(mask, ancho, alto, r) {
    const n = ancho * alto;
    const INF = 1e9;
    const h = new Int32Array(n);
    for (let y = 0; y < alto; y++) {
      let d = INF;
      for (let x = 0; x < ancho; x++) { const i = y * ancho + x; d = mask[i] ? 0 : d + 1; h[i] = d; }
      d = INF;
      for (let x = ancho - 1; x >= 0; x--) { const i = y * ancho + x; d = mask[i] ? 0 : d + 1; if (d < h[i]) h[i] = d; }
    }
    const out = new Uint8Array(n);
    const v = new Int32Array(n);
    for (let x = 0; x < ancho; x++) {
      let d = INF;
      for (let y = 0; y < alto; y++) { const i = y * ancho + x; d = h[i] <= r ? 0 : d + 1; v[i] = d; }
      d = INF;
      for (let y = alto - 1; y >= 0; y--) { const i = y * ancho + x; d = h[i] <= r ? 0 : d + 1; if (d < v[i]) v[i] = d; }
    }
    for (let i = 0; i < n; i++) out[i] = v[i] <= r ? 1 : 0;
    return out;
  }

  /** Crece una región `pasos` píxeles (8 vecinos = dilatación cuadrada) restringida a la máscara `mask`. */
  function crecerRegion(region, mask, ancho, alto, pasos) {
    let frontera = [];
    const n = ancho * alto;
    for (let i = 0; i < n; i++) {
      if (!region[i]) continue;
      const x = i % ancho, y = (i - x) / ancho;
      let borde = false;
      for (let dy = -1; dy <= 1 && !borde; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < ancho && yy < alto && !region[yy * ancho + xx]) { borde = true; break; }
        }
      }
      if (borde) frontera.push(i);
    }
    for (let p = 0; p < pasos; p++) {
      const nueva = [];
      for (let k = 0; k < frontera.length; k++) {
        const i = frontera[k];
        const x = i % ancho, y = (i - x) / ancho;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= ancho || yy >= alto) continue;
            const j = yy * ancho + xx;
            if (mask[j] && !region[j]) { region[j] = 1; nueva.push(j); }
          }
        }
      }
      frontera = nueva;
      if (!frontera.length) break;
    }
    return region;
  }

  /** Douglas-Peucker sobre polilínea abierta (iterativo). Devuelve puntos conservados. */
  function simplificarDP(pts, tol) {
    const n = pts.length;
    if (n <= 2) return pts.slice();
    const keep = new Uint8Array(n);
    keep[0] = 1; keep[n - 1] = 1;
    const pila = [[0, n - 1]];
    while (pila.length) {
      const seg = pila.pop();
      const a = seg[0], b = seg[1];
      let dmax = -1, idx = -1;
      for (let i = a + 1; i < b; i++) {
        const d = distPuntoSegmento(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1]);
        if (d > dmax) { dmax = d; idx = i; }
      }
      if (dmax > tol && idx > 0) {
        keep[idx] = 1;
        pila.push([a, idx]);
        pila.push([idx, b]);
      }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
    return out;
  }

  /** Douglas-Peucker para polígono cerrado: parte por el vértice 0 y el más lejano a él. */
  function simplificarCerrado(pts, tol) {
    const n = pts.length;
    if (n <= 3) return pts.slice();
    let j = 0, dm = -1;
    for (let i = 1; i < n; i++) {
      const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
      if (d > dm) { dm = d; j = i; }
    }
    const m1 = simplificarDP(pts.slice(0, j + 1), tol);
    const m2 = simplificarDP(pts.slice(j).concat([pts[0]]), tol);
    const out = m1.slice(0, m1.length - 1).concat(m2.slice(0, m2.length - 1));
    return out;
  }

  /** Quita vértices consecutivos repetidos o colineales exactos. */
  function limpiarColineales(pts) {
    let cambio = true;
    let p = pts.slice();
    while (cambio && p.length > 3) {
      cambio = false;
      const q = [];
      for (let i = 0; i < p.length; i++) {
        const a = p[(i + p.length - 1) % p.length], b = p[i], c = p[(i + 1) % p.length];
        if (Math.abs(orient(a[0], a[1], b[0], b[1], c[0], c[1])) < 1e-9 || (a[0] === b[0] && a[1] === b[1])) { cambio = true; continue; }
        q.push(b);
      }
      if (q.length >= 3) p = q; else break;
    }
    return p;
  }

  /**
   * Traza los bucles de borde de una región binaria (R a la izquierda de cada arista).
   * Devuelve lista de {pts:[[x,y]...] (vértices de esquina), areaFirmada}. Negativa = contorno exterior.
   */
  function bordesDeRegion(region, ancho, alto) {
    const W1 = ancho + 1;
    const desde = [], hasta = [];
    const salientes = new Map();
    function agregar(x1, y1, x2, y2) {
      const e = desde.length;
      const v1 = y1 * W1 + x1;
      desde.push(v1);
      hasta.push(y2 * W1 + x2);
      const l = salientes.get(v1);
      if (l) l.push(e); else salientes.set(v1, [e]);
    }
    for (let y = 0; y < alto; y++) {
      for (let x = 0; x < ancho; x++) {
        if (!region[y * ancho + x]) continue;
        if (y === 0 || !region[(y - 1) * ancho + x]) agregar(x + 1, y, x, y);            // arriba: hacia la izquierda
        if (y === alto - 1 || !region[(y + 1) * ancho + x]) agregar(x, y + 1, x + 1, y + 1); // abajo: hacia la derecha
        if (x === 0 || !region[y * ancho + x - 1]) agregar(x, y, x, y + 1);                // izquierda: hacia abajo
        if (x === ancho - 1 || !region[y * ancho + x + 1]) agregar(x + 1, y + 1, x + 1, y); // derecha: hacia arriba
      }
    }
    const E = desde.length;
    const usada = new Uint8Array(E);
    const bucles = [];
    function dirDe(e) {
      const a = desde[e], b = hasta[e];
      const ax = a % W1, ay = (a - ax) / W1, bx = b % W1, by = (b - bx) / W1;
      return [bx - ax, by - ay];
    }
    for (let e0 = 0; e0 < E; e0++) {
      if (usada[e0]) continue;
      const pts = [];
      let e = e0, dirPrev = null, suma = 0;
      let guard = 0;
      do {
        usada[e] = 1;
        const d = dirDe(e);
        const a = desde[e], b = hasta[e];
        const ax = a % W1, ay = (a - ax) / W1, bx = b % W1, by = (b - bx) / W1;
        if (!dirPrev || dirPrev[0] !== d[0] || dirPrev[1] !== d[1]) pts.push([ax, ay]);
        suma += ax * by - bx * ay;
        dirPrev = d;
        // siguiente arista: la más a la izquierda entre las salientes disponibles
        const cand = salientes.get(hasta[e]) || [];
        let sig = -1, mejorCruz = Infinity;
        for (let q = 0; q < cand.length; q++) {
          const c = cand[q];
          if (usada[c] && c !== e0) continue;
          const dc = dirDe(c);
          const cruz = d[0] * dc[1] - d[1] * dc[0]; // < 0 ⇒ giro a la izquierda (y hacia abajo)
          if (cruz < mejorCruz) { mejorCruz = cruz; sig = c; }
        }
        e = sig;
        guard++;
      } while (e !== e0 && e >= 0 && guard <= E + 2);
      bucles.push({ pts: pts, areaFirmada: suma / 2 });
    }
    return bucles;
  }

  /**
   * Imagen → contorno del piso libre.
   * @param {Object} o { data: Uint8ClampedArray RGBA, ancho, alto, semilla:[px,py], umbral (0-255),
   *                     tolerancia (px), areaMinHuecoPx }
   * @returns {{contornoPx:number[][], huecosPx:number[][][], areaPx:number, advertencias:string[]}}
   *   `areaPx` = píxeles de piso libre alcanzados por el relleno (sin los huecos).
   *   El contorno sigue la cara interior de los muros (píxeles claros); coordenadas en píxeles de la imagen.
   */
  function contornoDesdeImagen(o) {
    const adv = [];
    const vacio = function () { return { contornoPx: [], huecosPx: [], areaPx: 0, advertencias: adv }; };
    if (!o || !o.data || !(o.ancho > 0) || !(o.alto > 0)) { adv.push('Imagen inválida: faltan datos, ancho o alto.'); return vacio(); }
    const ancho = o.ancho | 0, alto = o.alto | 0, n = ancho * alto;
    if (o.data.length < n * 4) { adv.push('Imagen inválida: el arreglo de datos es más corto que ancho×alto×4.'); return vacio(); }
    const umbral = num(o.umbral, 128);
    const tol = Math.max(0, num(o.tolerancia, 1.5));
    const areaMin = Math.max(0, num(o.areaMinHuecoPx, 20));
    const claro = mascaraClara(o.data, n, umbral);
    let sx = Math.round(o.semilla ? o.semilla[0] : ancho / 2), sy = Math.round(o.semilla ? o.semilla[1] : alto / 2);
    if (!(sx >= 0 && sx < ancho && sy >= 0 && sy < alto)) { adv.push('La semilla cae fuera de la imagen.'); return vacio(); }
    if (!claro[sy * ancho + sx]) {
      adv.push('La semilla cae sobre una zona oscura (por debajo del umbral ' + umbral + '): haga clic dentro del almacén sobre piso claro o baje el umbral.');
      return vacio();
    }
    let res = inundar(claro, ancho, alto, sx, sy);
    const total = n;
    if (res.toca && res.area > 0.9 * total) {
      adv.push('Posible fuga: el relleno ocupa más del 90 % de la imagen y toca su borde (hay una abertura en el muro o el umbral es muy bajo).');
      let sellado = false;
      for (let r = 1; r <= 8 && !sellado; r++) {
        const oscuroDil = dilatar(claro.map(function (v) { return v ? 0 : 1; }), ancho, alto, r);
        const claro2 = new Uint8Array(n);
        for (let i = 0; i < n; i++) claro2[i] = claro[i] && !oscuroDil[i] ? 1 : 0;
        // semilla en la máscara sellada (la más cercana si la original quedó dentro del halo)
        let s2 = -1;
        if (claro2[sy * ancho + sx]) s2 = sy * ancho + sx;
        else {
          let mejor = Infinity;
          for (let dy = -(r + 2); dy <= r + 2; dy++) {
            for (let dx = -(r + 2); dx <= r + 2; dx++) {
              const x = sx + dx, y = sy + dy;
              if (x < 0 || y < 0 || x >= ancho || y >= alto) continue;
              if (claro2[y * ancho + x] && dx * dx + dy * dy < mejor) { mejor = dx * dx + dy * dy; s2 = y * ancho + x; }
            }
          }
        }
        if (s2 < 0) continue;
        const r2 = inundar(claro2, ancho, alto, s2 % ancho, (s2 - (s2 % ancho)) / ancho);
        if (!r2.toca && r2.area > 0) {
          crecerRegion(r2.region, claro, ancho, alto, r);
          let a2 = 0;
          for (let i = 0; i < n; i++) a2 += r2.region[i];
          res = { region: r2.region, area: a2, toca: false };
          sellado = true;
          adv.push('Se cerraron aberturas de hasta ' + (2 * r) + ' px en el muro para poder trazar el contorno; revise que coincida con el plano y corrija a mano si hace falta.');
        }
      }
      if (!sellado) adv.push('No se pudo cerrar la fuga automáticamente: el contorno devuelto es el mejor posible (probablemente toda la imagen). Cierre la abertura en el plano o suba el umbral.');
    } else if (res.toca) {
      adv.push('El área detectada toca el borde de la imagen: si el contorno no coincide con el plano, hay una abertura en el muro.');
    }
    const bucles = bordesDeRegion(res.region, ancho, alto);
    let exterior = null;
    for (let i = 0; i < bucles.length; i++) {
      if (bucles[i].areaFirmada < 0 && (!exterior || bucles[i].areaFirmada < exterior.areaFirmada)) exterior = bucles[i];
    }
    if (!exterior) { adv.push('No se pudo trazar el contorno.'); return vacio(); }
    let contornoPx = simplificarCerrado(limpiarColineales(exterior.pts), tol);
    if (contornoPx.length < 3) contornoPx = limpiarColineales(exterior.pts);
    const huecosPx = [];
    for (let i = 0; i < bucles.length; i++) {
      const b = bucles[i];
      if (b.areaFirmada <= 0 || b.areaFirmada < areaMin) continue;
      let h = simplificarCerrado(limpiarColineales(b.pts), tol);
      if (h.length < 3) {
        const bb = bboxPoligono(b.pts);
        h = [[bb.minX, bb.minY], [bb.maxX, bb.minY], [bb.maxX, bb.maxY], [bb.minX, bb.maxY]];
      }
      huecosPx.push(h);
    }
    if (huecosPx.length) adv.push('Se detectaron ' + huecosPx.length + ' obstáculo(s) interior(es) (columnas, oficinas, equipos); revise cuáles son reales.');
    return { contornoPx: contornoPx, huecosPx: huecosPx, areaPx: res.area, advertencias: adv };
  }

  /* ======================================================================
   * 4. POSICIONES DE ALMACENAJE
   * ==================================================================== */

  /** Separación (m) entre la cara del rack y el punto de acceso en el pasillo. */
  const OFFSET_ACCESO = 0.5;
  const MAX_NIVELES = 20, MAX_SLOTS = 10, MAX_MODULOS_RACK = 500;
  const MAX_MODULOS_GEN = 60000, MAX_POSICIONES_GEN = 400000;

  /** Zona (tipo) que contiene un punto; 'general' si ninguna. */
  function zonaTipoEn(zonas, x, y) {
    for (let i = 0; i < zonas.length; i++) {
      if (zonas[i].poly && zonas[i].poly.length >= 3 && puntoEnPoligono([x, y], zonas[i].poly)) return zonas[i].tipo || 'general';
    }
    return 'general';
  }

  /**
   * Genera la lista de posiciones de almacenaje de todos los racks.
   * Orden de numeración: rack → módulo → nivel → slot (se usa para el baseline «sin criterio»).
   */
  /** Asigna `o[k] = v` también cuando k es «__proto__» (propiedad propia, sin tocar el prototipo). */
  /** Nombre del lote i-ésimo (0-based) de un SKU: el dado, o «L1», «L2»… si falta o está en blanco. */
  function nombreLote(l, i) {
    const t = l && l.lote !== undefined && l.lote !== null ? String(l.lote).trim() : '';
    return t === '' ? 'L' + (i + 1) : t;
  }
  function loteSinNombre(l) { return !l || l.lote === undefined || l.lote === null || String(l.lote).trim() === ''; }

  function fijarProp(o, k, v) {
    if (k === '__proto__') Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
    else o[k] = v;
  }

  /**
   * Nombre único de cada rack (el de las ubicaciones): `nombre || id || 'Rnn'`; si se repite, el segundo y siguientes
   * llevan sufijo «-2», «-3»… (sin chocar con ningún otro nombre). Devuelve {nombres, renombrados:[{indice, de, a}]}.
   */
  function nombresRacksUnicos(racks) {
    const base = (racks || []).map(function (r, ri) { return String((r && (r.nombre || r.id)) || ('R' + pad(ri + 1, 2))); });
    const usados = new Set(base);
    const vistos = new Set();
    const renombrados = [];
    const nombres = base.map(function (b, ri) {
      if (!vistos.has(b)) { vistos.add(b); return b; }
      let k = 2, n = b + '-' + k;
      while (usados.has(n) || vistos.has(n)) { k++; n = b + '-' + k; }
      usados.add(n); vistos.add(n);
      renombrados.push({ indice: ri, de: b, a: n });
      return n;
    });
    return { nombres: nombres, renombrados: renombrados };
  }

  function posicionesDeRacks(proyecto) {
    const out = [];
    const racks = (proyecto && proyecto.racks) || [];
    const zonas = (proyecto && proyecto.zonas) || [];
    const cfgP = configCompleta(proyecto);
    const nomUnicos = nombresRacksUnicos(racks).nombres;
    for (let ri = 0; ri < racks.length; ri++) {
      const r = racks[ri];
      // cotas de cordura (evitan millones de posiciones por un dato mal digitado)
      const mods = Math.min(MAX_MODULOS_RACK, Math.max(1, r.modulos | 0)), niveles = Math.min(MAX_NIVELES, Math.max(1, r.niveles | 0)), slots = Math.min(MAX_SLOTS, Math.max(1, r.slotsPorModulo | 0));
      const a = ((r.ang || 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      const modLen = r.largo / mods;
      const sgn = r.frente === 'B' ? 1 : -1;
      const off = sgn * (r.fondo / 2 + OFFSET_ACCESO);
      const altoNivel = num(r.altoNivel, 1.6), altoBase = num(r.altoBase, 0.15);
      // alto libre para la carga (que incluye el palet): palet = paso − perfil de viga − holgura sobre la carga
      const libre = (r.tipo || 'palet') === 'palet' ? altoNivel - cfgP.perfilViga - cfgP.holguraSobreCarga : altoNivel - altoBase;
      const nombre = nomUnicos[ri];
      const frente = r.frente === 'B' ? 'B' : 'A';
      // ---- v1.1: capacidad de la ubicación, LIFO, bahía de cantilever, equipo y pasillo del rack ----
      const tipoR = r.tipo || 'palet';
      const prof = tipoR === 'piso' ? Math.max(1, Math.min(MAX_PROFUNDIDAD, Math.floor(num(r.profundidadPalets, 1)))) : 1;
      const apil = tipoR === 'piso' ? Math.max(1, Math.min(MAX_APILADO, Math.floor(num(r.apilado, 1)))) : 1;
      const capUb = prof * apil;
      const lifoR = prof > 1 || apil > 1;
      const bahia = tipoR === 'cantilever' ? r.largo / mods : null;
      const eqR = equipoDeRack(r, cfgP), apR = anchoPasilloDeRack(r, cfgP);
      const cmod = typeof r.cargaMaxModuloKg === 'number' && isFinite(r.cargaMaxModuloKg) && r.cargaMaxModuloKg > 0 ? r.cargaMaxModuloKg : null;
      for (let m = 1; m <= mods; m++) {
        const xm = -r.largo / 2 + (m - 0.5) * modLen;
        const ax = r.cx + xm * c - off * s, ay = r.cy + xm * s + off * c;
        for (let nv = 1; nv <= niveles; nv++) {
          for (let sl = 1; sl <= slots; sl++) {
            const xs = xm - modLen / 2 + (sl - 0.5) * (modLen / slots);
            const px = r.cx + xs * c, py = r.cy + xs * s;
            out.push({
              id: nombre + '-' + frente + '-' + pad(m, 2) + '-' + nv + (slots > 1 ? '-' + sl : ''),
              rackId: r.id, rackNombre: nombre, modulo: m, nivel: nv, slot: sl,
              cx: px, cy: py, ax: ax, ay: ay,
              alturaM: altoBase + (nv - 1) * altoNivel,
              cargaMaxKg: num(r.cargaMaxKg, 1000),
              tipo: r.tipo || 'palet',
              zonaTipo: zonaTipoEn(zonas, px, py),
              // campos adicionales (útiles para el slotting y la UI)
              rackIdx: ri, frente: frente, alturaLibreM: Math.max(0, libre),
              capacidadUb: capUb, lifo: lifoR, apilado: apil, anchoBahiaM: bahia,
              equipoRack: eqR, anchoPasilloRack: apR, cargaMaxModuloKg: cmod
            });
          }
        }
      }
    }
    return out;
  }

  /* ======================================================================
   * 5. MALLA CAMINABLE Y DISTANCIAS REALES (Dijkstra, 8 vecinos)
   * ==================================================================== */

  const MAX_CELDAS = 600000;
  const DX8 = [1, -1, 0, 0, 1, 1, -1, -1];
  const DY8 = [0, 0, 1, -1, 1, -1, 1, -1];
  const RAIZ2 = Math.SQRT2;

  /** Rellena con `valor` las celdas cuyo centro cae dentro de `poly` (scanline par-impar). */
  function rellenarPoligono(m, poly, valor) {
    const n = poly.length;
    if (n < 3) return;
    const bb = bboxPoligono(poly);
    const c = m.celda;
    const iy0 = Math.max(0, Math.floor((bb.minY - m.y0) / c - 0.5));
    const iy1 = Math.min(m.ny - 1, Math.ceil((bb.maxY - m.y0) / c - 0.5));
    const xs = [];
    for (let iy = iy0; iy <= iy1; iy++) {
      const yc = m.y0 + (iy + 0.5) * c;
      xs.length = 0;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const y1 = poly[j][1], y2 = poly[i][1];
        if ((y1 <= yc && y2 > yc) || (y2 <= yc && y1 > yc)) {
          xs.push(poly[j][0] + ((yc - y1) * (poly[i][0] - poly[j][0])) / (y2 - y1));
        }
      }
      xs.sort(function (p, q) { return p - q; });
      for (let k = 0; k + 1 < xs.length; k += 2) {
        let ia = Math.ceil((xs[k] - m.x0) / c - 0.5);
        let ib = Math.ceil((xs[k + 1] - m.x0) / c - 0.5) - 1;
        if (ia < 0) ia = 0;
        if (ib > m.nx - 1) ib = m.nx - 1;
        const base = iy * m.nx;
        for (let ix = ia; ix <= ib; ix++) m.caminable[base + ix] = valor;
      }
    }
  }

  /** Malla base: dentro del contorno y fuera de huecos (sin racks). */
  function mallaBase(proyecto) {
    const adv = [];
    const contorno = proyecto.contorno || [];
    const cfg = proyecto.config || {};
    let celda = num(cfg.celdaM, 0.5);
    if (celda <= 0) celda = 0.5;
    if (contorno.length < 3) {
      return { celda: celda, x0: 0, y0: 0, nx: 0, ny: 0, caminable: new Uint8Array(0), advertencias: ['Contorno inválido (menos de 3 puntos).'] };
    }
    const bb = bboxPoligono(contorno);
    if ((bb.ancho / celda + 2) * (bb.alto / celda + 2) > MAX_CELDAS) {
      const nueva = Math.sqrt((bb.ancho * bb.alto) / MAX_CELDAS) * 1.02;
      adv.push('La malla caminable tendría demasiadas celdas; se aumentó la celda de ' + celda + ' m a ' + redondear(nueva, 2) + ' m.');
      celda = nueva;
    }
    const nx = Math.ceil(bb.ancho / celda) + 2, ny = Math.ceil(bb.alto / celda) + 2;
    const m = { celda: celda, x0: bb.minX - celda, y0: bb.minY - celda, nx: nx, ny: ny, caminable: new Uint8Array(nx * ny), advertencias: adv };
    rellenarPoligono(m, contorno, 1);
    const huecos = proyecto.huecos || [];
    for (let i = 0; i < huecos.length; i++) if (huecos[i].poly) rellenarPoligono(m, huecos[i].poly, 0);
    return m;
  }

  /** Copia superficial de una malla con su propio arreglo caminable. */
  function copiarMalla(m) {
    return { celda: m.celda, x0: m.x0, y0: m.y0, nx: m.nx, ny: m.ny, caminable: new Uint8Array(m.caminable), advertencias: m.advertencias.slice() };
  }

  /** Marca como no caminable la huella de los racks. */
  function estamparRacks(m, racks) {
    for (let i = 0; i < racks.length; i++) rellenarPoligono(m, poligonoRack(racks[i]), 0);
  }

  /**
   * Malla raster caminable: celda = config.celdaM; caminable = dentro del contorno, fuera de huecos y de la
   * huella de racks. Conexión 8 vecinos (costo diagonal √2) sin cortar esquinas bloqueadas.
   */
  function construirMalla(proyecto) {
    const m = mallaBase(proyecto);
    estamparRacks(m, proyecto.racks || []);
    return m;
  }

  /** Índice de celda que contiene (x,y) o −1 si cae fuera de la malla. */
  function indiceCelda(m, x, y) {
    const ix = Math.floor((x - m.x0) / m.celda), iy = Math.floor((y - m.y0) / m.celda);
    if (ix < 0 || iy < 0 || ix >= m.nx || iy >= m.ny) return -1;
    return iy * m.nx + ix;
  }

  /** Celda caminable más cercana a (x,y) dentro de `maxDist` m. → {idx, d} o null. */
  function celdaCaminableCercana(m, x, y, maxDist) {
    const c = m.celda;
    const ix0 = Math.floor((x - m.x0) / c), iy0 = Math.floor((y - m.y0) / c);
    if (ix0 >= 0 && iy0 >= 0 && ix0 < m.nx && iy0 < m.ny && m.caminable[iy0 * m.nx + ix0]) {
      const cxm = m.x0 + (ix0 + 0.5) * c, cym = m.y0 + (iy0 + 0.5) * c;
      return { idx: iy0 * m.nx + ix0, d: Math.hypot(x - cxm, y - cym) };
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
   * Dijkstra multi-fuente con montículo binario. Devuelve Float64Array de distancias (Infinity si inalcanzable).
   * v1.2: `objetivos` (opcional, índices de celda) detiene la búsqueda cuando todos quedaron fijados (las demás celdas
   * quedan parciales: solo son válidas las de los objetivos); `info.pops` (opcional) acumula las celdas fijadas.
   */
  function dijkstraMalla(m, fuentes, distIni, objetivos, info) {
    const nx = m.nx, ny = m.ny, N = nx * ny, cam = m.caminable, c = m.celda;
    const dist = new Float64Array(N).fill(Infinity);
    let cap = 1024;
    let hk = new Float64Array(cap), hv = new Int32Array(cap), hn = 0;
    function empujar(k, v) {
      if (hn === cap) {
        cap *= 2;
        const nk = new Float64Array(cap), nv = new Int32Array(cap);
        nk.set(hk); nv.set(hv); hk = nk; hv = nv;
      }
      let i = hn++;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (hk[p] <= k) break;
        hk[i] = hk[p]; hv[i] = hv[p]; i = p;
      }
      hk[i] = k; hv[i] = v;
    }
    for (let i = 0; i < fuentes.length; i++) {
      const f = fuentes[i], d0 = distIni ? distIni[i] : 0;
      if (d0 < dist[f]) { dist[f] = d0; empujar(d0, f); }
    }
    const diag = c * RAIZ2;
    const pend = objetivos && objetivos.length ? new Set(objetivos) : null;
    while (hn > 0) {
      const k = hk[0], u = hv[0];
      hn--;
      if (hn > 0) {
        const lk = hk[hn], lv = hv[hn];
        let i = 0;
        for (;;) {
          let l = 2 * i + 1;
          if (l >= hn) break;
          if (l + 1 < hn && hk[l + 1] < hk[l]) l++;
          if (hk[l] >= lk) break;
          hk[i] = hk[l]; hv[i] = hv[l]; i = l;
        }
        hk[i] = lk; hv[i] = lv;
      }
      if (k > dist[u]) continue;
      if (info) info.pops++;
      if (pend && pend.delete(u) && pend.size === 0) break;
      const ux = u % nx, uy = (u - ux) / nx;
      for (let q = 0; q < 8; q++) {
        const vx = ux + DX8[q], vy = uy + DY8[q];
        if (vx < 0 || vy < 0 || vx >= nx || vy >= ny) continue;
        const v = vy * nx + vx;
        if (!cam[v]) continue;
        let w = c;
        if (q >= 4) {
          // diagonal: sin cortar esquinas bloqueadas
          if (!cam[uy * nx + vx] || !cam[vy * nx + ux]) continue;
          w = diag;
        }
        const nd = k + w;
        if (nd < dist[v]) { dist[v] = nd; empujar(nd, v); }
      }
    }
    return dist;
  }

  /**
   * Distancias caminando desde uno o varios puntos (mínimo sobre todos). Float32Array por celda
   * (Infinity si inalcanzable). Puntos fuera de zona caminable se proyectan a la celda caminable más
   * cercana (≤ 3 m); si no hay, se agrega una advertencia en `resultado.advertencias`.
   */
  function distanciasDesde(malla, puntosXY) {
    const adv = [];
    const fuentes = [], d0 = [];
    for (let i = 0; i < puntosXY.length; i++) {
      const p = puntosXY[i];
      const cc = celdaCaminableCercana(malla, p[0], p[1], 3);
      if (!cc) adv.push('El punto (' + redondear(p[0], 2) + '; ' + redondear(p[1], 2) + ') está a más de 3 m de una zona caminable y se ignoró.');
      else { fuentes.push(cc.idx); d0.push(cc.d); }
    }
    const d = dijkstraMalla(malla, fuentes, d0);
    const out = new Float32Array(d.length);
    for (let i = 0; i < d.length; i++) out[i] = d[i];
    out.advertencias = adv;
    return out;
  }

  /** Celdas alcanzables (BFS 8 vecinos sin cortar esquinas) desde las fuentes. Uint8Array. */
  function alcanzablesMalla(m, fuentes) {
    const nx = m.nx, ny = m.ny, cam = m.caminable;
    const vis = new Uint8Array(nx * ny);
    const pila = new Int32Array(nx * ny);
    let t = 0;
    for (let i = 0; i < fuentes.length; i++) if (!vis[fuentes[i]]) { vis[fuentes[i]] = 1; pila[t++] = fuentes[i]; }
    while (t > 0) {
      const u = pila[--t];
      const ux = u % nx, uy = (u - ux) / nx;
      for (let q = 0; q < 8; q++) {
        const vx = ux + DX8[q], vy = uy + DY8[q];
        if (vx < 0 || vy < 0 || vx >= nx || vy >= ny) continue;
        const v = vy * nx + vx;
        if (!cam[v] || vis[v]) continue;
        if (q >= 4 && (!cam[uy * nx + vx] || !cam[vy * nx + ux])) continue;
        vis[v] = 1; pila[t++] = v;
      }
    }
    return vis;
  }

  /** Mayor componente conexa (índices de una celda de ella) — fallback cuando no hay puertas. */
  function celdaDeMayorComponente(m) {
    const N = m.nx * m.ny;
    const marca = new Uint8Array(N);
    let mejorCnt = 0, mejorCelda = -1;
    for (let i = 0; i < N; i++) {
      if (!m.caminable[i] || marca[i]) continue;
      const vis = alcanzablesMalla(m, [i]);
      let cnt = 0;
      for (let j = 0; j < N; j++) if (vis[j]) { marca[j] = 1; cnt++; }
      if (cnt > mejorCnt) { mejorCnt = cnt; mejorCelda = i; }
    }
    return mejorCelda;
  }

  /** Una puerta es válida si tiene coordenadas finitas. */
  function puertaValida(p) { return !!p && typeof p.x === 'number' && typeof p.y === 'number' && isFinite(p.x) && isFinite(p.y); }

  /** Puntos de partida por tipo de puerta. */
  function puertasPorTipo(proyecto) {
    const ps = (proyecto.puertas || []).filter(puertaValida);
    let rec = ps.filter(function (p) { return p.tipo === 'recepcion' || p.tipo === 'mixta'; });
    let desp = ps.filter(function (p) { return p.tipo === 'despacho' || p.tipo === 'mixta'; });
    if (!rec.length) rec = desp;
    if (!desp.length) desp = rec;
    return {
      rec: rec.map(function (p) { return [p.x, p.y]; }),
      desp: desp.map(function (p) { return [p.x, p.y]; })
    };
  }

  /** Clave de caché de la geometría que afecta a las distancias. */
  function claveGeometria(proyecto) {
    const cfg = proyecto.config || {};
    return JSON.stringify([
      proyecto.contorno,
      (proyecto.huecos || []).map(function (h) { return h.poly; }),
      (proyecto.puertas || []).map(function (p) { return [p.tipo, String(p.x), String(p.y)]; }),
      (proyecto.racks || []).map(function (r) { return [r.cx, r.cy, r.ang, r.largo, r.fondo, r.modulos, r.niveles, r.slotsPorModulo, r.frente, r.tipo, r.altoNivel, r.altoBase, r.cargaMaxKg]; }),
      cfg.celdaM
    ]);
  }

  let cacheDistancias = null; // {clave, malla, campoRec, campoDesp, advertencias}

  /** Malla + campos de distancia por puerta, con caché de la última geometría. */
  function camposDeDistancia(proyecto) {
    const clave = claveGeometria(proyecto);
    if (cacheDistancias && cacheDistancias.clave === clave) return cacheDistancias;
    const malla = construirMalla(proyecto);
    const adv = malla.advertencias.slice();
    const nInval = (proyecto.puertas || []).filter(function (p) { return !puertaValida(p); }).length;
    if (nInval) adv.push('Puerta inválida: ' + nInval + ' puerta(s) sin coordenadas numéricas se ignoraron.');
    const pt = puertasPorTipo(proyecto);
    let campoRec = null, campoDesp = null;
    if (!pt.rec.length) {
      adv.push('No hay puertas: no se pueden calcular distancias. Agregue al menos una puerta de recepción, despacho o mixta.');
    } else {
      campoRec = distanciasDesde(malla, pt.rec);
      campoDesp = distanciasDesde(malla, pt.desp);
      campoRec.advertencias.forEach(function (a) { adv.push(a); });
      if (campoDesp.advertencias.length && campoDesp.advertencias.join() !== campoRec.advertencias.join()) {
        campoDesp.advertencias.forEach(function (a) { adv.push(a); });
      }
    }
    cacheDistancias = { clave: clave, malla: malla, campoRec: campoRec, campoDesp: campoDesp, advertencias: adv };
    return cacheDistancias;
  }

  /**
   * Distancia leída en el punto de acceso. El punto debe caer en una celda caminable (tolerancia de 1 celda):
   * no se suma una línea recta a través de racks o muros. Si no hay celda caminable tan cerca, la posición
   * queda inaccesible.
   */
  function leerCampo(malla, campo, x, y) {
    const cc = celdaCaminableCercana(malla, x, y, malla.celda * 1.0 + 1e-9);
    if (!cc) return Infinity;
    const d = campo[cc.idx];
    return isFinite(d) ? d + cc.d : Infinity;
  }

  /**
   * Para cada posición, distancia caminando mínima desde la puerta recepción|mixta (`dRec`) y
   * despacho|mixta (`dDesp`) más cercanas. Una sola corrida de Dijkstra por tipo de puerta.
   * `accesible` = alcanzable desde las puertas.
   */
  function calcularDistanciasPosiciones(proyecto) {
    const campos = camposDeDistancia(proyecto);
    const pos = posicionesDeRacks(proyecto);
    const salida = new Array(pos.length);
    let inacc = 0;
    // los módulos comparten punto de acceso: se memoriza por (ax,ay)
    const memo = new Map();
    for (let i = 0; i < pos.length; i++) {
      const p = pos[i];
      let dRec = Infinity, dDesp = Infinity;
      if (campos.campoRec) {
        const k = p.ax + ',' + p.ay;
        let v = memo.get(k);
        if (!v) {
          v = [leerCampo(campos.malla, campos.campoRec, p.ax, p.ay), leerCampo(campos.malla, campos.campoDesp, p.ax, p.ay)];
          memo.set(k, v);
        }
        dRec = v[0]; dDesp = v[1];
      }
      const acc = isFinite(dRec) && isFinite(dDesp);
      if (!acc) inacc++;
      const q = {};
      for (const key in p) q[key] = p[key];
      q.dRec = dRec; q.dDesp = dDesp; q.accesible = acc;
      salida[i] = q;
    }
    const adv = campos.advertencias.slice();
    const dupN = nombresRacksUnicos(proyecto && proyecto.racks).renombrados;
    if (dupN.length) adv.push('Nombre de rack repetido: ' + dupN.map(function (d) { return '«' + d.de + '» → «' + d.a + '»'; }).join(', ') + ' (las ubicaciones se codifican con el nombre renombrado para que sean únicas).');
    if (inacc > 0) adv.push(inacc + ' de ' + pos.length + ' posiciones no son accesibles desde ninguna puerta (rack encerrado, pasillo bloqueado o sin puertas).');
    return { posiciones: salida, advertencias: adv };
  }

  /* ======================================================================
   * 6. GENERACIÓN AUTOMÁTICA DE RACKS
   * ==================================================================== */

  /** Configuración completa (rellena lo que falte con los valores por defecto). */
  function configCompleta(proyecto) {
    const base = configPorDefecto((proyecto && proyecto.config && proyecto.config.equipo) || 'apilador');
    const cfg = Object.assign({}, base, (proyecto && proyecto.config) || {});
    cfg.abc = Object.assign({}, base.abc, (proyecto && proyecto.config && proyecto.config.abc) || {});
    cfg.tipoRociador = cfg.tipoRociador === 'esfr' ? 'esfr' : 'estandar';
    const hExpl = typeof cfg.holguraRociadores === 'number' && isFinite(cfg.holguraRociadores) && cfg.holguraRociadores >= 0;
    cfg.holguraExplicita = hExpl;
    if (!hExpl) cfg.holguraRociadores = HOLGURA_ROCIADOR[cfg.tipoRociador];
    cfg.perfilViga = num(cfg.perfilViga, 0.12);
    cfg.holguraSobreCarga = num(cfg.holguraSobreCarga, 0.1);
    cfg.pesoPesadoBinKg = num(cfg.pesoPesadoBinKg, 15);
    cfg.nivelMaxPesado = Math.max(1, Math.floor(num(cfg.nivelMaxPesado, 2)));
    cfg.nivelMaxPesadoBin = Math.max(1, Math.floor(num(cfg.nivelMaxPesadoBin, 1)));
    // ---- v1.1: los campos ausentes toman el valor que reproduce v1.0 ----
    const cr = (proyecto && proyecto.config) || {};
    cfg.dimensionarPor = cr.dimensionarPor === 'maximo' ? 'maximo' : 'actual';
    const rp = Object.assign({ activa: false, posicionesPicking: 1 }, cr.reposicion && typeof cr.reposicion === 'object' ? cr.reposicion : {});
    rp.activa = rp.activa === true;
    rp.posicionesPicking = Math.max(1, Math.min(10, Math.floor(num(rp.posicionesPicking, 1))));
    cfg.reposicion = rp;
    const sg = Object.assign({ usar: true, matriz: null }, cr.segregacion && typeof cr.segregacion === 'object' ? cr.segregacion : {});
    sg.usar = sg.usar !== false;
    sg.matriz = Array.isArray(sg.matriz) ? sg.matriz : null;
    cfg.segregacion = sg;
    cfg.pesoAfinidad = Math.max(0, num(cfg.pesoAfinidad, 0.3));
    cfg.fechaReferencia = parseFechaISO(cfg.fechaReferencia) !== null ? String(cfg.fechaReferencia) : null;
    cfg.diasAlertaVencimiento = typeof cfg.diasAlertaVencimiento === 'number' && isFinite(cfg.diasAlertaVencimiento) && cfg.diasAlertaVencimiento >= 0 ? cfg.diasAlertaVencimiento : null;
    ['evacMaxM', 'anchoEvacuacionMin', 'cargaPisoMaxKgM2'].forEach(function (k) {
      cfg[k] = typeof cfg[k] === 'number' && isFinite(cfg[k]) && cfg[k] > 0 ? cfg[k] : null;
    });
    const mu = Object.assign({ palletsDiaRecepcion: null, palletsDiaDespacho: null, diasPermanenciaRec: 1, diasPermanenciaDesp: 1, m2PorPalet: null, factorManiobra: null }, cr.muelle && typeof cr.muelle === 'object' ? cr.muelle : {});
    ['palletsDiaRecepcion', 'palletsDiaDespacho', 'm2PorPalet', 'factorManiobra'].forEach(function (k) { mu[k] = typeof mu[k] === 'number' && isFinite(mu[k]) && mu[k] >= 0 ? mu[k] : null; });
    ['diasPermanenciaRec', 'diasPermanenciaDesp'].forEach(function (k) { mu[k] = typeof mu[k] === 'number' && isFinite(mu[k]) && mu[k] >= 0 ? mu[k] : 1; });
    cfg.muelle = mu;
    // ---- v1.2 ----
    cfg.cantileverCombinar = cr.cantileverCombinar !== false;
    cfg.pasilloVDMA = normalizarPasilloVDMA(cr.pasilloVDMA);
    return cfg;
  }

  /** `config.pasilloVDMA` normalizado: null si no es un objeto con algún dato; cada campo = número finito ≥ 0 o null. */
  function normalizarPasilloVDMA(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const out = {};
    let alguno = false;
    ['radioGiroM', 'largoCargaM', 'holguraCargaRackM', 'holguraSeguridadM'].forEach(function (k) {
      const x = v[k];
      const ok = typeof x === 'number' && isFinite(x) && x >= 0;
      out[k] = ok ? x : null;
      if (ok) alguno = true;
    });
    return alguno ? out : null;
  }

  /** Fecha ISO estricta 'YYYY-MM-DD' → ms UTC (sin leer el reloj); null si no es válida. */
  function parseFechaISO(s) {
    if (typeof s !== 'string') return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    const t = Date.UTC(y, mo - 1, d);
    const f = new Date(t);
    if (f.getUTCFullYear() !== y || f.getUTCMonth() !== mo - 1 || f.getUTCDate() !== d) return null;
    return t;
  }

  /** Equipo efectivo de un rack: el propio si es válido, si no el de la configuración. */
  function equipoDeRack(r, cfg) {
    return r && PRESETS_EQUIPO[r.equipo] !== undefined ? r.equipo : cfg.equipo;
  }

  /** Ancho de pasillo efectivo de un rack: override propio > preset de su equipo > configuración. */
  function anchoPasilloDeRack(r, cfg) {
    if (r && typeof r.anchoPasillo === 'number' && isFinite(r.anchoPasillo) && r.anchoPasillo > 0) return r.anchoPasillo;
    if (r && PRESETS_EQUIPO[r.equipo] !== undefined) return PRESETS_EQUIPO[r.equipo];
    return cfg.anchoPasillo;
  }

  /** Dimensiones típicas por tipo de ubicación. [VERIFICAR con ficha del fabricante] */
  function tipicosPorTipo(tipo, cfg, op) {
    const t = tipo || 'palet';
    let d;
    // largoMod = largo de módulo por defecto; slotsDef = posiciones por módulo y nivel por defecto
    const profP = t === 'piso' ? Math.max(1, Math.min(MAX_PROFUNDIDAD, Math.floor(num(op.profundidadPalets, 1)))) : 1;
    if (t === 'bin') d = { fondo: 0.6, altoNivel: 0.45, altoBase: 0.15, carga: 50, topeAlto: 2.0, largoMod: 2.7, slotsDef: 2 };
    else if (t === 'piso') d = { fondo: redondear(1.2 * profP, 4), altoNivel: 1.8, altoBase: 0.0, carga: 1000, topeAlto: 1.8, largoMod: 1.1, slotsDef: 1 };   // carril: 1,1 m de ancho y 1,2 m de fondo por palet [VERIFICAR]
    else if (t === 'cantilever') d = { fondo: 1.0, altoNivel: 1.0, altoBase: 0.3, carga: 1500, topeAlto: 4.0, largoMod: 6.0, slotsDef: 1 };   // brazos de 1,0 m a cada 1,0 m, bahía de 6 m [VERIFICAR con la ficha del fabricante]
    else d = { fondo: 1.1, altoNivel: 1.6, altoBase: 0.15, carga: 1000, topeAlto: Infinity, largoMod: 2.7, slotsDef: 2 };
    const fondo = num(op.fondo, d.fondo);
    let niveles;
    if (op.niveles !== null && op.niveles !== undefined && isFinite(op.niveles)) niveles = Math.max(1, Math.floor(op.niveles));
    else if (t === 'piso') niveles = 1;
    else {
      const alturaUtil = Math.min(cfg.alturaLibreNave - cfg.holguraRociadores, d.topeAlto);
      niveles = Math.min(MAX_NIVELES, Math.max(1, Math.floor((alturaUtil - d.altoBase + 1e-9) / d.altoNivel)));
    }
    return { fondo: fondo, altoNivel: num(op.altoNivel, d.altoNivel), altoBase: num(op.altoBase, d.altoBase), carga: num(op.cargaMaxKg, d.carga), niveles: niveles, largoMod: d.largoMod, slotsDef: d.slotsDef };
  }

  /** Ángulo (grados, 0..180) del borde más largo del contorno. */
  function anguloLadoLargo(contorno) {
    let mejor = 0, ang = 0;
    for (let i = 0; i < contorno.length; i++) {
      const a = contorno[i], b = contorno[(i + 1) % contorno.length];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (l > mejor) { mejor = l; ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI; }
    }
    ang = ((ang % 180) + 180) % 180;
    return redondear(ang, 4);
  }

  /** Lista de ángulos a probar según `orientacion`. */
  function angulosAProbar(orientacion, contorno) {
    const lado = anguloLadoLargo(contorno);
    let l;
    if (orientacion === 'horizontal') l = [0];
    else if (orientacion === 'vertical') l = [90];
    else if (orientacion === 'lado_largo') l = [lado];
    else l = [0, 90, lado, (lado + 90) % 180];
    const u = [];
    l.forEach(function (a) { if (!u.some(function (b) { return Math.abs(a - b) < 0.5; })) u.push(a); });
    return u;
  }

  /** Punto (x,y) en el plano a partir de coordenadas (u,v) del marco girado θ. */
  function uvAXY(u, v, c, s) { return [u * c - v * s, u * s + v * c]; }

  /** Rectángulo [u1,u2]×[v1,v2] del marco θ como polígono en el plano. */
  function rectUV(u1, u2, v1, v2, c, s) {
    return [uvAXY(u1, v1, c, s), uvAXY(u2, v1, c, s), uvAXY(u2, v2, c, s), uvAXY(u1, v2, c, s)];
  }

  /** ¿El polígono está en el contorno y libre de obstáculos? */
  function poligonoLibre(poly, contorno, obstaculos) {
    if (!poligonoContenido(poly, contorno)) return false;
    for (let i = 0; i < obstaculos.length; i++) if (poligonosSolapan(poly, obstaculos[i])) return false;
    return true;
  }

  /** Distancia mínima de un punto (u,v) a un rectángulo alineado [u1,u2]×[v1,v2]. */
  function distPuntoRect(u, v, u1, u2, v1, v2) {
    const dx = u < u1 ? u1 - u : u > u2 ? u - u2 : 0;
    const dy = v < v1 ? v1 - v : v > v2 ? v2 - v : 0;
    return Math.hypot(dx, dy);
  }

  /**
   * Genera los módulos de un candidato (ángulo θ, fases fu y fv) sobre la retícula
   * «pasillo – rack – rack – pasillo». Devuelve la lista de módulos que caben enteros.
   */
  function modulosDeCandidato(ctx, theta, faseU, faseV) {
    const rad = (theta * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad);
    const L = ctx.L, F = ctx.F;
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (let i = 0; i < ctx.contorno.length; i++) {
      const x = ctx.contorno[i][0], y = ctx.contorno[i][1];
      const u = x * c + y * s, v = -x * s + y * c;
      if (u < uMin) uMin = u;
      if (u > uMax) uMax = u;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
    const aisle = ctx.aisle;
    const P = ctx.dobles ? aisle + 2 * F + ctx.flue : aisle + F;
    const T = ctx.M * L, periodoU = T + ctx.cross;
    const u0 = uMin - faseU, v0 = vMin - faseV * P;
    const nT = Math.ceil((uMax - u0) / periodoU) + 1;
    // puertas en el marco girado
    const puertasUV = ctx.puertas.map(function (p) { return [p[0] * c + p[1] * s, -p[0] * s + p[1] * c]; });
    const mg = ctx.margen;
    const cacheStrip = new Map();
    function stripLibre(i, t, k, uS) {
      const key = i + '|' + t + '|' + k;
      let r = cacheStrip.get(key);
      if (r === undefined) {
        const vs = v0 + i * P;
        const poly = rectUV(uS, uS + L, vs, vs + aisle, c, s);
        r = poligonoLibre(poly, ctx.contorno, ctx.obstaculos) && ctx.enGlobal(poly);
        cacheStrip.set(key, r);
      }
      return r;
    }
    function rackLibre(uS, vR) {
      // reserva delante de puertas (distancia a la huella del rack, sin inflar)
      for (let q = 0; q < puertasUV.length; q++) {
        if (distPuntoRect(puertasUV[q][0], puertasUV[q][1], uS, uS + L, vR, vR + F) < ctx.reservaPuerta) return false;
      }
      // muros: margen completo; columnas/huecos/racks manuales: holgura pequeña (0,1 m)
      const cajaMuro = rectUV(uS - mg, uS + L + mg, vR - mg, vR + F + mg, c, s);
      if (!poligonoContenido(cajaMuro, ctx.contorno) || !ctx.enGlobal(cajaMuro)) return false;
      const hh = 0.1;
      const cajaRack = rectUV(uS - hh, uS + L + hh, vR - hh, vR + F + hh, c, s);
      for (let q = 0; q < ctx.obstaculos.length; q++) if (poligonosSolapan(cajaRack, ctx.obstaculos[q])) return false;
      return true;
    }
    const modulos = [];
    for (let i = 0; v0 + i * P <= vMax; i++) {
      const vs = v0 + i * P;
      const vA = vs + aisle;
      const vB = vA + F + ctx.flue;
      for (let t = 0; t <= nT; t++) {
        for (let k = 0; k < ctx.M; k++) {
          const uS = u0 + t * periodoU + k * L;
          if (uS + L < uMin - EPS || uS > uMax + EPS) continue;
          if (stripLibre(i, t, k, uS) && rackLibre(uS, vA)) {
            modulos.push({ blk: i, lado: 'A', t: t, k: k, u: uS, vc: vA + F / 2 });
          }
          if (ctx.dobles) {
            // lado B: mira al pasillo siguiente (tira i+1 en la misma posición u)
            if (stripLibre(i + 1, t, k, uS) && rackLibre(uS, vB)) {
              modulos.push({ blk: i, lado: 'B', t: t, k: k, u: uS, vc: vB + F / 2 });
            }
          }
        }
      }
    }
    return { modulos: modulos, theta: theta, c: c, s: s };
  }

  /** Agrupa módulos consecutivos en racks (una fila por tramo). Devuelve {racks, mapa}. */
  function armarRacksDeModulos(ctx, cand, modulos) {
    const orden = modulos.map(function (m, i) { return { m: m, i: i }; });
    orden.sort(function (a, b) {
      if (a.m.blk !== b.m.blk) return a.m.blk - b.m.blk;
      if (a.m.lado !== b.m.lado) return a.m.lado < b.m.lado ? -1 : 1;
      if (a.m.t !== b.m.t) return a.m.t - b.m.t;
      return a.m.k - b.m.k;
    });
    const racks = [], mapa = new Array(modulos.length);
    let grupo = null;
    function cerrar() {
      if (!grupo) return;
      const n = grupo.items.length;
      const u1 = grupo.items[0].m.u, largo = n * ctx.L;
      const xy = uvAXY(u1 + largo / 2, grupo.items[0].m.vc, cand.c, cand.s);
      const idx = racks.length;
      racks.push({
        cx: xy[0], cy: xy[1], ang: cand.theta, largo: largo, modulos: n, frente: grupo.items[0].m.lado
      });
      grupo.items.forEach(function (it, j) { mapa[it.i] = { rack: idx, mod: j }; });
      grupo = null;
    }
    for (let q = 0; q < orden.length; q++) {
      const it = orden[q];
      if (grupo && grupo.blk === it.m.blk && grupo.lado === it.m.lado && grupo.t === it.m.t &&
          grupo.items[grupo.items.length - 1].m.k + 1 === it.m.k) {
        grupo.items.push(it);
      } else {
        cerrar();
        grupo = { blk: it.m.blk, lado: it.m.lado, t: it.m.t, items: [it] };
      }
    }
    cerrar();
    return { racks: racks, mapa: mapa };
  }

  /** Completa los campos de un rack «mínimo» con el tipo/alturas/carga y nombre. */
  function completarRack(r, idx, ctx) {
    const nombre = 'R' + pad(idx + 1, 2);
    return {
      id: nombre, nombre: nombre, cx: redondear(r.cx, 4), cy: redondear(r.cy, 4), ang: redondear(r.ang, 4),
      largo: redondear(r.largo, 4), fondo: ctx.F, modulos: r.modulos, niveles: ctx.tip.niveles,
      slotsPorModulo: ctx.slots, altoNivel: ctx.tip.altoNivel, altoBase: ctx.tip.altoBase,
      cargaMaxKg: ctx.tip.carga, tipo: ctx.tipo, frente: r.frente, auto: true,
      // v1.1
      zonaId: ctx.zonaId === undefined ? null : ctx.zonaId, equipo: ctx.equipoRack === undefined ? null : ctx.equipoRack,
      anchoPasillo: ctx.anchoRack === undefined ? null : ctx.anchoRack, cargaMaxModuloKg: null,
      profundidadPalets: ctx.tipo === 'piso' ? ctx.prof : 1, apilado: ctx.tipo === 'piso' ? ctx.apil : 1
    };
  }

  /** Puntos de acceso (x,y) de cada módulo de un rack mínimo. */
  function accesosDeRack(r, F) {
    const a = ((r.ang || 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const modLen = r.largo / r.modulos;
    const off = (r.frente === 'B' ? 1 : -1) * (F / 2 + OFFSET_ACCESO);
    const out = [];
    for (let m = 0; m < r.modulos; m++) {
      const xm = -r.largo / 2 + (m + 0.5) * modLen;
      out.push([r.cx + xm * c - off * s, r.cy + xm * s + off * c]);
    }
    return out;
  }

  /**
   * Accesibilidad de cada módulo de una lista de racks mínimos: estampa los racks en la malla base y
   * recorre desde las puertas (o, sin puertas, desde la mayor región conectada).
   * Devuelve arreglo de arreglos booleanos [rack][módulo].
   */
  function accesibilidadDeRacks(ctx, racks) {
    const m = copiarMalla(ctx.mallaBase);
    for (let i = 0; i < racks.length; i++) {
      rellenarPoligono(m, rectanguloOrientado(racks[i].cx, racks[i].cy, racks[i].ang, racks[i].largo, ctx.F), 0);
    }
    for (let i = 0; i < ctx.racksManuales.length; i++) rellenarPoligono(m, poligonoRack(ctx.racksManuales[i]), 0);
    const fuentes = [];
    for (let i = 0; i < ctx.puertas.length; i++) {
      const cc = celdaCaminableCercana(m, ctx.puertas[i][0], ctx.puertas[i][1], 3);
      if (cc) fuentes.push(cc.idx);
    }
    if (!fuentes.length) {
      const f = celdaDeMayorComponente(m);
      if (f >= 0) fuentes.push(f);
    }
    const vis = alcanzablesMalla(m, fuentes);
    return racks.map(function (r) {
      return accesosDeRack(r, ctx.F).map(function (p) {
        const cc = celdaCaminableCercana(m, p[0], p[1], 1.0);
        return !!(cc && vis[cc.idx]);
      });
    });
  }

  /**
   * Relleno de sobrantes: filas simples pegadas a los muros del contorno, solo donde caben enteras,
   * sin tapar el frente de otros racks y sin dejar inaccesible ningún módulo existente.
   */
  function rellenarSobrantesMuro(ctx, racksActuales) {
    const nuevos = [];
    const polis = racksActuales.map(function (r) { return rectanguloOrientado(r.cx, r.cy, r.ang, r.largo, ctx.F); });
    const L = ctx.L, F = ctx.F, mg = ctx.margen;
    const cont = ctx.contorno;
    for (let e = 0; e < cont.length; e++) {
      const A = cont[e], B = cont[(e + 1) % cont.length];
      const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
      if (len < L + 2 * mg) continue;
      const dx = (B[0] - A[0]) / len, dy = (B[1] - A[1]) / len;
      // normal hacia el interior
      const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2;
      let nx = -dy, ny = dx;
      if (!puntoDentroEstricto([mx + nx * 0.1, my + ny * 0.1], cont, 1e-9)) { nx = -nx; ny = -ny; }
      const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
      const frente = nx * (-dy) + ny * dx > 0 ? 'B' : 'A';
      const celdas = [];
      const nMod = Math.floor((len - 2 * mg) / L);
      for (let j = 0; j < nMod; j++) {
        const s0 = mg + j * L + L / 2;
        const cx = A[0] + dx * s0 + nx * (mg + F / 2), cy = A[1] + dy * s0 + ny * (mg + F / 2);
        const huella = rectanguloOrientado(cx, cy, ang, L, F);
        const cajaS = rectanguloOrientado(cx, cy, ang, L + 0.02, F + 0.02);
        let ok = poligonoLibre(cajaS, cont, ctx.obstaculos) && ctx.enGlobal(cajaS);
        if (ok) {
          for (let q = 0; q < ctx.puertas.length && ok; q++) {
            if (puntoEnPoligono(ctx.puertas[q], rectanguloOrientado(cx, cy, ang, L + 2 * ctx.reservaPuerta, F + 2 * ctx.reservaPuerta))) ok = false;
          }
        }
        if (ok) {
          for (let q = 0; q < polis.length && ok; q++) if (poligonosSolapan(huella, polis[q])) ok = false;
        }
        if (ok) {
          // franja libre delante (ancho de pasillo) sin racks ni obstáculos
          const fx = cx + nx * (F / 2 + ctx.aisle / 2), fy = cy + ny * (F / 2 + ctx.aisle / 2);
          const franja = rectanguloOrientado(fx, fy, ang, L, ctx.aisle);
          if (!poligonoContenido(franja, cont)) ok = false;
          for (let q = 0; q < polis.length && ok; q++) if (poligonosSolapan(franja, polis[q])) ok = false;
          for (let q = 0; q < ctx.obstaculos.length && ok; q++) if (poligonosSolapan(franja, ctx.obstaculos[q])) ok = false;
        }
        celdas.push(ok ? { cx: cx, cy: cy } : null);
      }
      // agrupar celdas consecutivas libres en racks de hasta M módulos
      let j = 0;
      while (j < celdas.length) {
        if (!celdas[j]) { j++; continue; }
        let k = j;
        while (k + 1 < celdas.length && celdas[k + 1] && (k + 1 - j) < ctx.M) k++;
        const n = k - j + 1;
        const c0 = celdas[j], c1 = celdas[k];
        const rack = { cx: (c0.cx + c1.cx) / 2, cy: (c0.cy + c1.cy) / 2, ang: ang, largo: n * L, modulos: n, frente: frente };
        const huella = rectanguloOrientado(rack.cx, rack.cy, ang, rack.largo, F);
        let choca = false;
        for (let q = 0; q < polis.length && !choca; q++) if (poligonosSolapan(huella, polis[q])) choca = true;
        if (!choca) {
          const prueba = racksActuales.concat(nuevos, [rack]);
          const acc = accesibilidadDeRacks(ctx, prueba);
          let todo = true;
          for (let a = 0; a < acc.length && todo; a++) for (let b = 0; b < acc[a].length; b++) if (!acc[a][b]) { todo = false; break; }
          if (todo) { nuevos.push(rack); polis.push(huella); }
        }
        j = k + 1;
      }
    }
    return nuevos;
  }

  /**
   * Genera racks automáticamente dentro del contorno (cualquier forma), esquivando columnas/huecos.
   * Heurística: prueba varios ángulos y fases de una retícula «pasillo–rack–rack–pasillo» con pasillos
   * de cruce cada `modulosPorTramo` módulos y elige el candidato con más posiciones ACCESIBLES.
   * No es un óptimo de empaquetado.
   */
  function generarRacksPase(proyecto, opciones, pase) {
    pase = pase || {};
    const t0 = ahoraMs();
    const advertencias = [];
    let conProyecto = true;
    if (!proyecto || typeof proyecto !== 'object') {
      advertencias.push('No se recibió un proyecto: no se pueden generar racks.');
      proyecto = {};
      conProyecto = false;
    }
    const op = Object.assign({}, opciones || {});
    // cotas de cordura: se recorta al rango y se avisa (evita millones de posiciones por un dato mal digitado)
    function acotar(clave, min, max, etiqueta, entero) {
      if (op[clave] === undefined || op[clave] === null) return;
      let v = Number(op[clave]);
      if (!isFinite(v)) { advertencias.push(etiqueta + ' inválido (' + op[clave] + '): se usa el valor por defecto.'); delete op[clave]; return; }
      if (entero) v = Math.floor(v);
      const w = Math.min(max, Math.max(min, v));
      if (w !== v) advertencias.push(etiqueta + ' = ' + v + ' fuera de rango [' + min + '; ' + max + ']: se usó ' + w + '.');
      op[clave] = w;
    }
    acotar('largoModulo', 0.3, 12, 'Largo de módulo', false);
    acotar('fondo', 0.3, 3, 'Fondo de rack', false);
    acotar('niveles', 1, MAX_NIVELES, 'Niveles', true);
    acotar('modulosPorTramo', 1, 50, 'Módulos por tramo', true);
    acotar('slotsPorModulo', 1, MAX_SLOTS, 'Posiciones por módulo', true);
    const cfg = configCompleta(proyecto);
    const tipo = op.tipo || 'palet';
    if (tipo === 'piso') {
      acotar('profundidadPalets', 1, MAX_PROFUNDIDAD, 'Profundidad del carril (palets)', true);
      acotar('apilado', 1, MAX_APILADO, 'Palets apilados', true);
    }
    const prof = tipo === 'piso' ? Math.max(1, Math.floor(num(op.profundidadPalets, 1))) : 1;
    const apil = tipo === 'piso' ? Math.max(1, Math.floor(num(op.apilado, 1))) : 1;
    const tip = tipicosPorTipo(tipo, cfg, op);
    const supuestos = [];
    const contorno = pase.recinto || proyecto.contorno || [];
    const L = num(op.largoModulo, tip.largoMod);
    const slots = Math.max(1, Math.floor(num(op.slotsPorModulo, tip.slotsDef)));
    const M = Math.max(1, Math.floor(num(op.modulosPorTramo, 8)));
    const dobles = op.dobles !== false;
    const reserva = Math.max(0, num(op.reservarFrentePuertas, 3));
    const rellenar = op.rellenarSobrantes !== false && !pase.recinto;   // dentro de una zona el borde no es muro: no se rellenan sobrantes
    // opciones efectivamente aplicadas (tras recortar al rango). `niveles` queda en null si fue automático.
    const opcionesUsadas = {
      tipo: tipo, orientacion: op.orientacion || 'auto', largoModulo: L, fondo: tip.fondo,
      niveles: op.niveles !== undefined && op.niveles !== null ? tip.niveles : null,
      slotsPorModulo: slots, modulosPorTramo: M, dobles: dobles, reservarFrentePuertas: reserva, rellenarSobrantes: rellenar,
      altoNivel: tip.altoNivel, altoBase: tip.altoBase, cargaMaxKg: tip.carga
    };
    if (tipo === 'piso') { opcionesUsadas.profundidadPalets = prof; opcionesUsadas.apilado = apil; }
    // se guarda en el proyecto para poder «regenerar» con las mismas opciones (no es parte del modelo de datos del contrato)
    if (conProyecto && !pase.noGuardar) proyecto.generacion = JSON.parse(JSON.stringify(opcionesUsadas));
    const vacio = function (msg) {
      advertencias.push(msg);
      return { racks: [], resumen: { posiciones: 0, filas: 0, angulo: 0, ocupacionAreaPct: 0, descartados: 0 }, supuestos: supuestos, advertencias: advertencias, opcionesUsadas: opcionesUsadas };
    };
    supuestos.push('Unidades en metros. Módulo de ' + L + ' m, fondo ' + tip.fondo + ' m, ' + tip.niveles + ' nivel(es) de ' + tip.altoNivel + ' m (base ' + tip.altoBase + ' m), ' + slots + ' posición(es) por módulo y nivel: valores típicos [VERIFICAR con ficha del fabricante y con el responsable de almacén].');
    supuestos.push('Niveles = (altura libre de la nave ' + cfg.alturaLibreNave + ' m − holgura a rociadores ' + cfg.holguraRociadores + ' m [' + (cfg.holguraExplicita ? 'valor fijado por el usuario' : 'rociador «' + cfg.tipoRociador + '»: valor por defecto') + '] − altura base) / altura de nivel. La altura libre es hasta el obstáculo más bajo (tijeral, tubería, luminaria), no la altura al alero; la holgura real la fija el ingeniero de protección contra incendios [VERIFICAR NFPA 13 / RNE A.130].');
    supuestos.push('Altura libre para la carga en palet = paso del nivel − perfil de viga (' + cfg.perfilViga + ' m) − holgura sobre la carga (' + cfg.holguraSobreCarga + ' m); el alto de carga incluye el palet [VERIFICAR ficha del fabricante / EN 15620].');
    supuestos.push('Ancho de pasillo de trabajo ' + cfg.anchoPasillo + ' m (equipo «' + cfg.equipo + '»; orden de magnitud [VERIFICAR con la ficha del equipo]: el pasillo real = ancho del equipo + largo del palet + holguras, p. ej. VDMA 15173); pasillos de cruce de ' + cfg.anchoPasilloCruce + ' m cada ' + M + ' módulos; margen a muros/obstáculos ' + cfg.margenMuro + ' m; reserva libre de ' + reserva + ' m delante de cada puerta.');
    supuestos.push('Heurística de retícula con varios ángulos y fases: elige el candidato con más posiciones accesibles; no garantiza el óptimo de empaquetado.');
    supuestos.push('Las zonas especiales (frío, peligrosos, alto valor, cuarentena) no se excluyen: los racks pueden caer dentro de ellas. Los huecos, los racks manuales y las zonas de muelle y staging se tratan como obstáculos.');
    if (tipo === 'piso') supuestos.push('Rack de piso (bloque): cada módulo es un CARRIL de ' + L + ' m de ancho y ' + redondear(tip.fondo, 2) + ' m de fondo (' + prof + ' palet(s) en profundidad × ' + apil + ' apilado(s) = ' + (prof * apil) + ' ubicaciones); lo ocupa UN solo SKU y es LIFO si hay profundidad o apilado > 1. Ancho de carril y 1,2 m por palet en profundidad son típicos [VERIFICAR]; la altura del apilado (alto de la carga × apilado + holgura sobre la carga × (apilado − 1)) se verifica contra la altura libre de la nave menos la holgura a rociadores solo en los SKU que traen altoCargaM [VERIFICAR]; no se verifica la estabilidad de la carga.');
    if (tipo === 'cantilever') supuestos.push('Cantilever: cada módulo es una BAHÍA de ' + L + ' m; los niveles son brazos de ' + tip.fondo + ' m cada ' + tip.altoNivel + ' m y la carga máxima (' + tip.carga + ' kg) se entiende POR BRAZO: valores típicos [VERIFICAR con la ficha del fabricante]. Un SKU entra si su largo (largoM) ≤ largo de la bahía; con `config.cantileverCombinar` (activa por defecto) una carga más larga ocupa k = ⌈largo / bahía⌉ bahías contiguas del mismo rack y nivel, repartiendo su peso entre ellas.');
    if (contorno.length < 3 || areaPoligono(contorno) <= 0) return vacio('El contorno no es válido (menos de 3 puntos o área 0): no se pueden generar racks.');
    if (!(L > 0) || !(tip.fondo > 0)) return vacio('Largo de módulo o fondo inválidos.');
    const bbG = bboxPoligono(contorno);
    if (bbG.ancho > 300 || bbG.alto > 300) advertencias.push('El contorno mide ' + redondear(bbG.ancho, 0) + ' × ' + redondear(bbG.alto, 0) + ' m (más de 300 × 300 m): probablemente la calibración de escala está mal. Revise la escala del plano.');
    const nPuertasInval = (proyecto.puertas || []).filter(function (p) { return !puertaValida(p); }).length;
    if (nPuertasInval) advertencias.push('Puerta inválida: ' + nPuertasInval + ' puerta(s) sin coordenadas numéricas se ignoraron.');
    if (!(proyecto.puertas || []).filter(puertaValida).length) advertencias.push('No hay puertas definidas: la accesibilidad se evaluó desde la mayor región conectada. Agregue puertas para que los pasillos se orienten a ellas.');

    const huecosPolys = (proyecto.huecos || []).map(function (h) { return h.poly; }).filter(function (p) { return p && p.length >= 3; });
    const racksManuales = (proyecto.racks || []).filter(function (r) { return r.auto !== true; }).concat(pase.racksFijos || []);
    // v1.1: el muelle y el staging son piso libre, no se llenan de racks
    const zonasLibres = (proyecto.zonas || []).filter(function (z) { return z && (z.tipo === 'muelle' || z.tipo === 'staging') && Array.isArray(z.poly) && z.poly.length >= 3; }).map(function (z) { return z.poly; });
    const obstaculos = huecosPolys.concat(racksManuales.map(poligonoRack), pase.obstaculosExtra || [], zonasLibres);
    const contornoGlobal = pase.recinto ? (proyecto.contorno || null) : null;
    const puertas = (proyecto.puertas || []).filter(puertaValida).map(function (p) { return [p.x, p.y]; });
    const mallaB = mallaBase(proyecto);
    const ctx = {
      contorno: contorno, obstaculos: obstaculos, puertas: puertas, racksManuales: racksManuales,
      L: L, F: tip.fondo, M: M, aisle: cfg.anchoPasillo, cross: cfg.anchoPasilloCruce, flue: cfg.flue,
      margen: cfg.margenMuro, reservaPuerta: reserva, dobles: dobles, tip: tip, tipo: tipo, slots: slots,
      mallaBase: mallaB, prof: prof, apil: apil,
      zonaId: pase.zonaId, equipoRack: pase.equipoRack, anchoRack: pase.anchoRack,
      enGlobal: function (poly) { return !contornoGlobal || poligonoContenido(poly, contornoGlobal); }
    };

    // 1) generar candidatos (ángulo × fase en u × fase en v) y ordenarlos por posiciones brutas
    const angulos = angulosAProbar(op.orientacion || 'auto', contorno);
    const P = dobles ? ctx.aisle + 2 * ctx.F + ctx.flue : ctx.aisle + ctx.F;
    const periodoU = M * L + ctx.cross;
    const pasoU = L / 2;
    let nFasesU = Math.max(1, Math.round(periodoU / pasoU));
    let nFasesV = 6;
    // tope de trabajo: estimación de módulos de una retícula completa
    const areaGen = areaPoligono(contorno);
    const estModulos = areaGen / (L * (dobles ? P / 2 : P));
    const posPorModEst = tip.niveles * slots;
    if (estModulos > MAX_MODULOS_GEN || estModulos * posPorModEst > MAX_POSICIONES_GEN) {
      return vacio('Con estas medidas saldrían unos ' + Math.round(estModulos) + ' módulos (' + Math.round(estModulos * posPorModEst) + ' posiciones): excede el tope de ' + MAX_MODULOS_GEN + ' módulos / ' + MAX_POSICIONES_GEN + ' posiciones. Revise la escala del plano o aumente el largo de módulo.');
    }
    if (estModulos > 6000) {
      nFasesU = Math.min(nFasesU, 4); nFasesV = 2;
      advertencias.push('Nave muy grande (~' + Math.round(estModulos) + ' módulos): se evaluaron menos disposiciones para acotar el tiempo; el resultado puede ser menos denso.');
    }
    const cands = [];
    for (let a = 0; a < angulos.length; a++) {
      for (let fu = 0; fu < nFasesU; fu++) {
        for (let fv = 0; fv < nFasesV; fv++) {
          const cand = modulosDeCandidato(ctx, angulos[a], fu * pasoU, fv / nFasesV);
          if (cand.modulos.length) cands.push(cand);
        }
      }
    }
    if (!cands.length) return vacio('No cabe ningún módulo con estas medidas (revise contorno, medidas del módulo, pasillos y margen).');
    const posPorModulo = tip.niveles * slots;
    cands.sort(function (x, y) { return y.modulos.length - x.modulos.length; });

    // 2) evaluar accesibilidad de los mejores y elegir
    const K = Math.min(8, cands.length);
    let mejor = null;
    for (let i = 0; i < K; i++) {
      const cand = cands[i];
      const arm = armarRacksDeModulos(ctx, cand, cand.modulos);
      const acc = accesibilidadDeRacks(ctx, arm.racks);
      let ok = 0;
      const buenos = [];
      cand.modulos.forEach(function (m, q) {
        const mp = arm.mapa[q];
        if (acc[mp.rack][mp.mod]) { ok++; buenos.push(m); }
      });
      const puntaje = ok * posPorModulo;
      if (!mejor || puntaje > mejor.puntaje) mejor = { cand: cand, buenos: buenos, puntaje: puntaje, brutos: cand.modulos.length };
    }
    if (!mejor || !mejor.buenos.length) return vacio('Ninguna disposición dejó posiciones accesibles desde las puertas.');
    const descartados = (mejor.brutos - mejor.buenos.length) * posPorModulo;
    const armado = armarRacksDeModulos(ctx, mejor.cand, mejor.buenos);
    let minimos = armado.racks.slice();
    const nLattice = minimos.length;
    const filasSet = {};
    mejor.buenos.forEach(function (m) { filasSet[m.blk + m.lado] = true; });
    let filas = Object.keys(filasSet).length;
    supuestos.push('Se evaluaron ' + cands.length + ' disposiciones (ángulos ' + angulos.map(function (a) { return redondear(a, 1) + '°'; }).join(', ') + ') y se verificó la accesibilidad de las ' + K + ' con más módulos.');

    // 3) sobrantes contra muro
    let sobrantes = 0;
    if (rellenar) {
      const extra = rellenarSobrantesMuro(ctx, minimos);
      extra.forEach(function (r) { minimos.push(r); sobrantes += r.modulos; });
      filas += extra.length;
      if (extra.length) supuestos.push('Se agregaron ' + extra.length + ' fila(s) simple(s) pegadas a muro (' + sobrantes + ' módulos) en sobrantes donde cabían enteras y accesibles.');
    }
    const racks = minimos.map(function (r, i) { return completarRack(r, i, ctx); });
    let posiciones = 0, areaRacks = 0;
    racks.forEach(function (r) { posiciones += r.modulos * r.niveles * r.slotsPorModulo; areaRacks += r.largo * r.fondo; });
    let areaUtil = areaPoligono(contorno);
    huecosPolys.forEach(function (h) { areaUtil -= areaPoligono(h); });
    const resumen = {
      posiciones: posiciones, filas: filas, angulo: redondear(mejor.cand.theta, 2),
      ocupacionAreaPct: areaUtil > 0 ? redondear((100 * areaRacks) / areaUtil, 1) : 0,
      descartados: descartados,
      // extras informativos
      racks: racks.length, modulos: racks.reduce(function (s, r) { return s + r.modulos; }, 0), tiempoMs: Math.round(ahoraMs() - t0),
      racksDeReticula: nLattice, modulosSobrantes: sobrantes
    };
    if (descartados > 0) advertencias.push(descartados + ' posiciones se descartaron por no tener acceso desde las puertas.');
    return { racks: racks, resumen: resumen, supuestos: supuestos, advertencias: advertencias, opcionesUsadas: opcionesUsadas };
  }

  /**
   * Genera racks automáticamente (cualquier forma de nave). Sin zonas `almacenaje` es la generación de v1.0 sobre todo el
   * contorno. Con zonas `almacenaje` genera DENTRO de cada polígono con SU configuración (zona.cfg: equipo, anchoPasillo,
   * tipo, niveles, altoNivel, fondo, largoModulo, slotsPorModulo, profundidadPalets, apilado; lo ausente hereda de `opciones`
   * y de config) y luego, en el resto del plano, con los parámetros globales (las zonas de almacenaje quedan como obstáculo).
   * La malla de caminado y la accesibilidad son GLOBALES. `opciones.zonas` = lista de ids de zona: genera solo en esas zonas
   * (sin pasada global). Cada rack lleva `zonaId`, `equipo` y `anchoPasillo` (null = el de config).
   */
  function generarRacksAuto(proyecto, opciones) {
    const op0 = opciones || {};
    const zonasAlm = proyecto && typeof proyecto === 'object' && Array.isArray(proyecto.zonas)
      ? proyecto.zonas.filter(function (z) { return z && z.tipo === 'almacenaje' && Array.isArray(z.poly) && z.poly.length >= 3; }) : [];
    const ids = Array.isArray(op0.zonas) ? op0.zonas.map(String) : null;
    if (!zonasAlm.length && !ids) return generarRacksPase(proyecto, opciones, null);
    const t0 = ahoraMs();
    const advertencias = [], supuestos = [];
    const vistos = new Set();
    const anotar = function (lista, destino) { (lista || []).forEach(function (a) { if (!vistos.has(a)) { vistos.add(a); destino.push(a); } }); };
    const zSel = ids ? zonasAlm.filter(function (z) { return ids.indexOf(String(z.id)) >= 0; }) : zonasAlm;
    if (ids) ids.forEach(function (id) { if (!zonasAlm.some(function (z) { return String(z.id) === id; })) advertencias.push('La zona «' + id + '» no existe o no es de tipo almacenaje: se ignora.'); });
    if (!zSel.length) {
      advertencias.push('Ninguna zona de almacenaje seleccionada: no se generó nada.');
      return { racks: [], resumen: { posiciones: 0, filas: 0, angulo: 0, ocupacionAreaPct: 0, descartados: 0, porZona: [] }, supuestos: supuestos, advertencias: advertencias, opcionesUsadas: {} };
    }
    const cfg = configCompleta(proyecto);
    const fijos = [];
    const racksOut = [];
    const porZona = [];
    let opcionesUsadas = null, descartados = 0, filas = 0, racksRet = 0, sobrantes = 0, angulo = 0;
    const base = Object.assign({}, op0);
    delete base.zonas;
    zSel.forEach(function (z) {
      const zc = z.cfg && typeof z.cfg === 'object' ? z.cfg : null;
      if (!zc) advertencias.push('ZONA_ALMACENAJE_SIN_CFG: la zona «' + (z.nombre || z.id) + '» no tiene configuración propia; se genera con los parámetros globales.');
      const op = Object.assign({}, base);
      if (zc) ['tipo', 'niveles', 'altoNivel', 'fondo', 'largoModulo', 'slotsPorModulo', 'profundidadPalets', 'apilado'].forEach(function (k) {
        if (zc[k] !== undefined && zc[k] !== null) op[k] = zc[k];
      });
      const cfgZ = Object.assign({}, proyecto.config || {});
      let equipoRack = null, anchoRack = null;
      if (zc && PRESETS_EQUIPO[zc.equipo] !== undefined) {
        equipoRack = zc.equipo; anchoRack = PRESETS_EQUIPO[zc.equipo];
        cfgZ.equipo = equipoRack; cfgZ.anchoPasillo = anchoRack; cfgZ.anchoPasilloCruce = Math.max(2.4, anchoRack);
      }
      if (zc && typeof zc.anchoPasillo === 'number' && isFinite(zc.anchoPasillo) && zc.anchoPasillo > 0) {
        anchoRack = zc.anchoPasillo;
        cfgZ.anchoPasillo = anchoRack; cfgZ.anchoPasilloCruce = Math.max(2.4, anchoRack);
      }
      const proxy = Object.assign({}, proyecto, { config: cfgZ });
      const r = generarRacksPase(proxy, op, { recinto: z.poly, racksFijos: fijos, zonaId: z.id, equipoRack: equipoRack, anchoRack: anchoRack, noGuardar: true });
      anotar(r.advertencias, advertencias);
      if (!opcionesUsadas) opcionesUsadas = r.opcionesUsadas;
      r.racks.forEach(function (rk) { racksOut.push(rk); fijos.push(rk); });
      descartados += r.resumen.descartados || 0; filas += r.resumen.filas || 0; racksRet += r.resumen.racksDeReticula || 0; sobrantes += r.resumen.modulosSobrantes || 0;
      porZona.push({ zonaId: z.id, nombre: z.nombre || z.id, tipo: r.opcionesUsadas.tipo, equipo: equipoRack || cfg.equipo, anchoPasillo: anchoRack !== null ? anchoRack : cfg.anchoPasillo, racks: r.racks.length, posiciones: r.resumen.posiciones || 0 });
      if (!r.racks.length) advertencias.push('La zona «' + (z.nombre || z.id) + '» no recibió ningún rack (revise sus medidas, el pasillo y el margen).');
    });
    if (!ids) {
      const todas = zonasAlm.map(function (z) { return z.poly; });
      const r = generarRacksPase(proyecto, opciones, { obstaculosExtra: todas, racksFijos: fijos });
      anotar(r.advertencias, advertencias);
      opcionesUsadas = r.opcionesUsadas;
      r.racks.forEach(function (rk) { racksOut.push(rk); });
      descartados += r.resumen.descartados || 0; filas += r.resumen.filas || 0; racksRet += r.resumen.racksDeReticula || 0; sobrantes += r.resumen.modulosSobrantes || 0;
      angulo = r.resumen.angulo || 0;
      porZona.push({ zonaId: null, nombre: 'Resto del plano', tipo: r.opcionesUsadas.tipo, equipo: cfg.equipo, anchoPasillo: cfg.anchoPasillo, racks: r.racks.length, posiciones: r.resumen.posiciones || 0 });
      r.supuestos.forEach(function (s) { supuestos.push(s); });
    } else if (opcionesUsadas) {
      if (proyecto) proyecto.generacion = JSON.parse(JSON.stringify(opcionesUsadas));
    }
    racksOut.forEach(function (rk, i) { const n = 'R' + pad(i + 1, 2); rk.id = n; rk.nombre = n; });
    supuestos.unshift('Generación por zonas: ' + zSel.length + ' zona(s) de almacenaje con su propia configuración' + (ids ? ' (solo esas zonas)' : ' + el resto del plano con los parámetros globales') + '. El pasillo y el equipo de cada rack son los de su zona; la accesibilidad se verifica contra las puertas sobre la malla global.');
    let posiciones = 0, areaRacks = 0;
    racksOut.forEach(function (r) { posiciones += r.modulos * r.niveles * r.slotsPorModulo; areaRacks += r.largo * r.fondo; });
    let areaUtil = areaPoligono(proyecto.contorno || []);
    (proyecto.huecos || []).forEach(function (h) { if (h.poly && h.poly.length >= 3) areaUtil -= areaPoligono(h.poly); });
    // verificación final de accesibilidad de TODAS las posiciones (los racks de una pasada pueden tapar a los de otra)
    let inaccesibles = 0;
    if (racksOut.length) {
      const prueba = Object.assign({}, proyecto, { racks: (proyecto.racks || []).filter(function (r) { return r.auto !== true; }).concat(racksOut) });
      const rr = calcularDistanciasPosiciones(prueba);
      const nuevos = new Set(racksOut.map(function (r) { return r.id; }));
      rr.posiciones.forEach(function (q) { if (nuevos.has(q.rackId) && !q.accesible) inaccesibles++; });
      if (inaccesibles) advertencias.push(inaccesibles + ' posiciones generadas quedaron sin acceso desde las puertas (un rack de otra zona tapó el paso): ajuste las zonas o mueva racks.');
    }
    const resumen = {
      posiciones: posiciones, filas: filas, angulo: angulo,
      ocupacionAreaPct: areaUtil > 0 ? redondear((100 * areaRacks) / areaUtil, 1) : 0,
      descartados: descartados, racks: racksOut.length, modulos: racksOut.reduce(function (s, r) { return s + r.modulos; }, 0),
      tiempoMs: Math.round(ahoraMs() - t0), racksDeReticula: racksRet, modulosSobrantes: sobrantes,
      porZona: porZona, inaccesibles: inaccesibles
    };
    return { racks: racksOut, resumen: resumen, supuestos: supuestos, advertencias: advertencias, opcionesUsadas: opcionesUsadas || {} };
  }

  /* ======================================================================
   * 7. SLOTTING (ABC + distancia real + ergonomía + restricciones)
   * ==================================================================== */

  /**
   * Clasificación ABC por Pareto de `picks`. Un SKU es A si la fracción acumulada ANTES de sumarlo es
   * < abc.a; B si < abc.b; C en otro caso (los de picks 0 son siempre C).
   * `porcAcum` está en porcentaje 0–100 e incluye al propio SKU.
   */
  function clasificarABC(productos, abc) {
    const a = num(abc && abc.a, 0.8), b = num(abc && abc.b, 0.95);
    const lista = (productos || []).map(function (p, i) { return { sku: p.sku, picks: Math.max(0, num(p.picks, 0)), i: i }; });
    let total = 0;
    lista.forEach(function (x) { total += x.picks; });
    lista.sort(function (x, y) {
      if (y.picks !== x.picks) return y.picks - x.picks;
      if (String(x.sku) !== String(y.sku)) return String(x.sku) < String(y.sku) ? -1 : 1;
      return x.i - y.i;
    });
    let acum = 0;
    return lista.map(function (x) {
      const antes = total > 0 ? acum / total : 1;
      acum += x.picks;
      let clase = 'C';
      if (total > 0 && x.picks > 0) clase = antes < a - 1e-9 ? 'A' : antes < b - 1e-9 ? 'B' : 'C';
      return { sku: x.sku, clase: clase, picks: x.picks, porcAcum: total > 0 ? redondear((100 * acum) / total, 2) : 0 };
    });
  }

  /** Penalización por nivel/altura (m equivalentes). Bin: por altura de la bandeja; palet/piso: por nivel. */
  function penalNivelPos(pos, cfg) {
    if (pos.tipo === 'bin') {
      const h = pos.alturaM;
      if (h > 1.8 + 1e-9) return 8;
      if (h >= 0.75 - 1e-9 && h <= 1.5 + 1e-9) return 0;
      if (h > 1.5) return 3;
      if (h >= 0.3 - 1e-9) return 3;
      return 5;
    }
    return cfg.penalNivelPalet * (pos.nivel - 1);
  }

  /** Altura (m) de un apilado de `a` cargas de alto `alto` con `holg` m entre cada par: a·alto + holg·(a−1). */
  function alturaApilado(alto, a, holg) { return a * alto + holg * (a - 1); }

  /** Prepara todos los datos de la corrida de slotting (posiciones, productos, elegibilidad, costos). */
  function prepararEntrada(proyecto, opciones) {
    const cfg = configCompleta(proyecto);
    const op = opciones || {};
    const usarPico = op.usarPicksPico === true;
    const dimMax = cfg.dimensionarPor === 'maximo';
    const adv = [];
    let posList;
    if (opciones && opciones.posiciones) posList = opciones.posiciones;
    else {
      const r = calcularDistanciasPosiciones(proyecto);
      posList = r.posiciones;
      r.advertencias.forEach(function (a) { adv.push(a); });
    }
    const nPos = posList.length;
    // v1.2: malla caminable para la distancia reserva → picking (misma malla y caché que las distancias a las puertas)
    const mallaRepo = cfg.reposicion.activa === true && !(opciones && opciones.posiciones) ? camposDeDistancia(proyecto).malla : null;
    // racks (para incompatibilidad por distancia entre huellas de rack)
    const rackIdx = new Int32Array(nPos);
    const idPorRack = new Map();
    for (let i = 0; i < nPos; i++) {
      const p = posList[i];
      if (typeof p.rackIdx === 'number') rackIdx[i] = p.rackIdx;
      else if (p.rackId !== undefined) {
        if (!idPorRack.has(p.rackId)) idPorRack.set(p.rackId, idPorRack.size);
        rackIdx[i] = idPorRack.get(p.rackId);
      } else rackIdx[i] = i;
    }
    let nRacks = 0;
    for (let i = 0; i < nPos; i++) if (rackIdx[i] + 1 > nRacks) nRacks = rackIdx[i] + 1;
    // productos
    if (((proyecto.productos || []).length) * nPos > MAX_CELDAS_SLOTTING) {
      throw new Error('Demasiado grande para asignar: ' + (proyecto.productos || []).length + ' SKU × ' + nPos + ' posiciones supera el tope de ' + MAX_CELDAS_SLOTTING + ' combinaciones. Reduzca productos o posiciones.');
    }
    const productos = (proyecto.productos || []);
    const abc = clasificarABC(productos, cfg.abc);
    const claseDe = new Map();
    abc.forEach(function (x, k) { if (!claseDe.has(x.sku)) claseDe.set(x.sku, x.clase); });
    const porSku = new Map();
    const fams = new Map();
    function famId(f) {
      const k = f === undefined || f === null ? '' : String(f);
      if (!fams.has(k)) fams.set(k, fams.size);
      return fams.get(k);
    }
    const prods = [];
    let nCross = 0, flujoCross = 0;
    productos.forEach(function (p, i) {
      const sku = String(p.sku);
      const crossdock = p.crossdock === true;
      const upu = num(p.unidadesPorUbic, 0), cant = Math.max(0, num(p.cantidad, 0));
      // dimensionado por stock máximo: nunca por debajo del stock actual
      let cantDim = cant;
      if (dimMax && typeof p.stockMax === 'number' && isFinite(p.stockMax) && p.stockMax > cant) cantDim = p.stockMax;
      const picks = Math.max(0, num(p.picks, 0));
      const picksEf = usarPico && typeof p.picksPico === 'number' && isFinite(p.picksPico) && p.picksPico >= 0 ? p.picksPico : picks;
      const ent = typeof p.entradas === 'number' && isFinite(p.entradas) ? Math.max(0, p.entradas) : picksEf * cfg.factorEntradas;
      let ubicReq = 0, invalido = null;
      const malNum = function (v) { return v !== undefined && v !== null && v !== '' && (typeof v !== 'number' || !isFinite(v) || v < 0); };
      const tipoOk = !p.tipoUbic || TIPOS_UBIC.indexOf(p.tipoUbic) >= 0;
      if (!sku.trim()) invalido = { motivo: 'datos', detalle: 'La fila ' + (i + 1) + ' no tiene SKU.' };
      else if (porSku.has(sku)) invalido = { motivo: 'duplicado', detalle: 'SKU «' + sku + '» repetido (fila ' + (i + 1) + '): se ignora esta fila; unifique las cantidades en una sola fila.' };
      else if (crossdock) ubicReq = 0;   // cross-docking: pasa por el muelle, no ocupa rack
      else if (!(upu > 0)) invalido = { motivo: 'datos', detalle: 'SKU «' + sku + '»: unidades por ubicación ≤ 0 o no numérico; no se puede calcular cuántas posiciones necesita.' };
      else if (malNum(p.cantidad) || malNum(p.picks) || (p.entradas !== undefined && p.entradas !== null && malNum(p.entradas))) invalido = { motivo: 'datos', detalle: 'SKU «' + sku + '»: cantidad, picks o entradas no numéricos o negativos.' };
      else if (!tipoOk) invalido = { motivo: 'datos', detalle: 'SKU «' + sku + '»: tipo de ubicación «' + p.tipoUbic + '» desconocido (palet, bin, piso o cantilever).' };
      else ubicReq = Math.ceil(cantDim / upu - 1e-9);
      let faltaInv = 0;
      if (invalido) {
        adv.push(invalido.detalle);
        faltaInv = upu > 0 ? Math.ceil(cant / upu - 1e-9) : 0;
      } else {
        porSku.set(sku, i);
        if (crossdock) { nCross++; flujoCross += Math.max(0, num(p.flujoCrossdock, 0)); }
      }
      const pesoUbic = upu * Math.max(0, num(p.pesoUnitKg, 0));
      const tipoP = p.tipoUbic || 'palet';
      const pesadoP = pesoUbic > (tipoP === 'bin' ? cfg.pesoPesadoBinKg : cfg.pesoPesadoKg);
      let peligro = null;
      if (p.peligro !== undefined && p.peligro !== null && p.peligro !== '') {
        if (CLASES_PELIGRO.indexOf(p.peligro) >= 0) peligro = p.peligro;
        else adv.push('SKU «' + sku + '»: clase de peligro «' + p.peligro + '» desconocida (' + CLASES_PELIGRO.join(', ') + '): se ignora.');
      }
      prods.push({
        idx: i, sku: sku, descripcion: p.descripcion || '', familia: p.familia, fam: famId(p.familia),
        cantidad: cant, upu: upu, posReq: Math.max(0, ubicReq), ubicReq: Math.max(0, ubicReq), capMin: 1,
        picks: picks, picksEf: picksEf, ent: ent, wp: 0, we: 0,
        pesoUbic: pesoUbic, alto: Math.max(0, num(p.altoCargaM, 0)), altoDado: typeof p.altoCargaM === 'number' && isFinite(p.altoCargaM) && p.altoCargaM > 0, tipo: tipoP,
        zona: p.requiereZona || null,
        incompat: Array.isArray(p.incompatibleCon) ? p.incompatibleCon.map(String) : [],
        pesado: pesadoP, nivelMax: pesadoP ? (tipoP === 'bin' ? cfg.nivelMaxPesadoBin : cfg.nivelMaxPesado) : Infinity,
        clase: claseDe.get(p.sku) || 'C', invalido: invalido, faltaInv: faltaInv,
        // v1.1
        crossdock: crossdock && !invalido, peligro: peligro, fefo: p.fefo === true,
        apilableMax: Math.max(1, Math.floor(num(p.apilableMax, 1))),
        largo: typeof p.largoM === 'number' && isFinite(p.largoM) && p.largoM > 0 ? p.largoM : null,
        upl: typeof p.unidadesPorLinea === 'number' && isFinite(p.unidadesPorLinea) && p.unidadesPorLinea > 0 ? p.unidadesPorLinea : null
      });
    });
    const nProd = prods.length;
    // conflictos entre pares de SKU (simétricos), cada uno con su distancia mínima entre HUELLAS de rack:
    // (a) familia (v1.0): la familia de q está en la lista de incompatibles de p; distancia = separacionIncompatibles.
    // (b) peligro (v1.1): el par de clases está en la matriz de segregación; distancia = distMinM de la matriz o, si es null,
    //     separacionIncompatibles. El mismo rack está siempre prohibido (distancia 0 < cualquier mínimo y comprobación explícita).
    let hayIncompat = false;
    const sepFam = cfg.separacionIncompatibles;
    const famTxt = function (pr) { return pr.familia === undefined || pr.familia === null ? '' : String(pr.familia); };
    prods.forEach(function (p) { p.conflictos = []; p.confDist = []; });
    function addConf(a, b, d) {
      [[a, b], [b, a]].forEach(function (par) {
        const x = par[0], y = par[1];
        const k = x.conflictos.indexOf(y.idx);
        if (k < 0) { x.conflictos.push(y.idx); x.confDist.push(d); } else if (d > x.confDist[k]) x.confDist[k] = d;
      });
      hayIncompat = true;
    }
    prods.forEach(function (p) {
      if (p.posReq <= 0 || !p.incompat.length) return;
      prods.forEach(function (q) {
        if (q === p || q.posReq <= 0) return;
        if (p.incompat.indexOf(famTxt(q)) >= 0) addConf(p, q, sepFam);
      });
    });
    const conPeligro = prods.filter(function (p) { return p.posReq > 0 && p.peligro; });
    if (conPeligro.length && cfg.segregacion.usar !== false) {
      const mz = matrizSegregacion(cfg);
      if (mz.size) {
        for (let a = 0; a < conPeligro.length; a++) {
          for (let b = a + 1; b < conPeligro.length; b++) {
            const x = conPeligro[a], y = conPeligro[b];
            const k = x.peligro < y.peligro ? x.peligro + '|' + y.peligro : y.peligro + '|' + x.peligro;
            if (mz.has(k)) { const d = mz.get(k); addConf(x, y, d === null ? sepFam : d); }
          }
        }
      }
    }
    // distancia mínima entre HUELLAS (polígonos) de rack, solo si hay incompatibilidades
    const rackDist = hayIncompat ? distanciasEntreRacks(proyecto, posList, rackIdx, nRacks) : null;
    // capacidad de cada ubicación (unidades de ubicación que caben; 1 salvo carriles de piso)
    const cap = new Int32Array(nPos);
    for (let j = 0; j < nPos; j++) cap[j] = Math.max(1, (posList[j].capacidadUb | 0) || 1);
    // ---- v1.2: filas de cantilever (mismo rack, nivel y slot) para las cargas largas que ocupan k bahías contiguas ----
    const combinar = cfg.cantileverCombinar !== false;
    const hMaxNave = num(cfg.alturaLibreNave, Infinity) - num(cfg.holguraRociadores, 0);
    let filaDe = null, modDe = null, filasPos = null;
    if (combinar && posList.some(function (q) { return q.tipo === 'cantilever'; })) {
      const rackConSlots = new Set();
      posList.forEach(function (q, j) { if (q.tipo === 'cantilever' && (q.slot || 1) > 1) rackConSlots.add(rackIdx[j]); });
      filaDe = new Int32Array(nPos).fill(-1); modDe = new Int32Array(nPos);
      filasPos = [];
      const idFila = new Map();
      for (let j = 0; j < nPos; j++) {
        const q = posList[j];
        // solo racks con 1 posición por módulo: con varios slots por bahía no se modela el tramo
        if (q.tipo !== 'cantilever' || !(q.anchoBahiaM > 0) || typeof q.modulo !== 'number' || q.modulo < 1 || rackConSlots.has(rackIdx[j])) continue;
        const k = rackIdx[j] + ':' + q.nivel;
        let f = idFila.get(k);
        if (f === undefined) { f = filasPos.length; idFila.set(k, f); filasPos.push([]); }
        const fila = filasPos[f];
        while (fila.length < q.modulo) fila.push(-1);
        fila[q.modulo - 1] = j;
        filaDe[j] = f; modDe[j] = q.modulo - 1;
      }
    }
    const cubFila = function (j, k) {
      if (!filasPos || filaDe[j] < 0) return null;
      const fila = filasPos[filaDe[j]], m0 = modDe[j], cub = [];
      for (let t = 0; t < k; t++) { const c = fila[m0 + t]; if (c === undefined || c < 0) return null; cub.push(c); }
      return cub;
    };
    // restricciones duras estáticas de un producto en UNA posición; kk = nº de bahías del tramo (el peso se reparte entre ellas)
    const okEstatico = function (p, q, kk) {
      if (q.tipo !== p.tipo) return false;
      if (p.pesoUbic / kk > q.cargaMaxKg + 1e-9) return false;
      if (p.alto > (q.alturaLibreM === undefined ? Infinity : q.alturaLibreM) + 1e-9) return false;
      if (p.pesado && q.nivel > p.nivelMax) return false;
      if (p.zona) { if (q.zonaTipo !== p.zona) return false; }
      else if (ZONAS_RESTRINGIDAS.indexOf(q.zonaTipo) >= 0) return false;
      if ((q.apilado || 1) > p.apilableMax) return false;
      // v1.2: altura libre del apilado de piso (solo si el SKU trae altoCargaM; si no, no se verifica y se avisa)
      if (q.tipo === 'piso' && p.altoDado && alturaApilado(p.alto, q.apilado || 1, cfg.holguraSobreCarga) > hMaxNave + 1e-9) return false;
      if (p.fefo && q.lifo === true) return false;
      if (!q.accesible) return false;
      return true;
    };
    const algunCant = prods.some(function (p) { return p.tipo === 'cantilever' && p.largo !== null && !p.invalido; });
    const spanK = filasPos && algunCant ? new Uint8Array(nProd * nPos) : null;
    // elegibilidad (restricciones duras estáticas)
    const elig = new Uint8Array(nProd * nPos);
    for (let i = 0; i < nProd; i++) {
      const p = prods[i];
      if (p.posReq <= 0) continue;
      const base = i * nPos;
      for (let j = 0; j < nPos; j++) {
        const q = posList[j];
        let kk = 1;
        if (q.tipo === 'cantilever' && q.tipo === p.tipo) {
          const bh = q.anchoBahiaM === undefined || q.anchoBahiaM === null ? Infinity : q.anchoBahiaM;
          if (p.largo === null) continue;
          if (p.largo > bh + 1e-9) {
            // v1.2: la carga ocupa k bahías contiguas del mismo rack y nivel (todas deben cumplir las restricciones)
            if (!combinar) continue;
            kk = Math.max(2, Math.ceil(p.largo / bh - 1e-9));
            if (kk > 200) continue;
            const cub = cubFila(j, kk);
            if (!cub) continue;
            let todas = true;
            for (let t = 1; t < cub.length && todas; t++) todas = okEstatico(p, posList[cub[t]], kk);
            if (!todas) continue;
          }
        }
        if (!okEstatico(p, q, kk)) continue;
        elig[base + j] = 1;
        if (spanK && q.tipo === 'cantilever') spanK[base + j] = kk;
      }
      // posiciones necesarias = ⌈ubicaciones / capacidad⌉; con ubicaciones de distinta capacidad se usa la MENOR (conservador)
      let mn = Infinity, mx = 0;
      for (let j = 0; j < nPos; j++) if (elig[base + j]) { if (cap[j] < mn) mn = cap[j]; if (cap[j] > mx) mx = cap[j]; }
      p.capMin = mn === Infinity ? 1 : mn;
      if (p.capMin > 1) p.posReq = Math.ceil(p.ubicReq / p.capMin - 1e-9);
      if (mx > mn && mn !== Infinity) adv.push('SKU «' + p.sku + '»: las posiciones elegibles tienen capacidades distintas (' + mn + ' a ' + mx + ' ubicaciones); se dimensiona con la menor (' + mn + ') para no quedarse corto.');
    }
    // v1.2: SKU de piso sin altoCargaM en un almacén con apilado > 1: la altura del apilado no se puede verificar
    if (posList.some(function (q) { return q.tipo === 'piso' && (q.apilado || 1) > 1; })) {
      prods.forEach(function (p) {
        if (p.posReq > 0 && p.tipo === 'piso' && !p.altoDado) adv.push('[FALTA: altoCargaM] SKU «' + p.sku + '»: sin el alto de la carga no se verifica la altura del apilado en piso (alto × apilado frente a la altura libre bajo rociadores); no se inventa un valor.');
      });
    }
    prods.forEach(function (p) {
      p.wp = p.posReq > 0 ? p.picksEf / p.posReq : 0;
      p.we = p.posReq > 0 ? p.ent / p.posReq : 0;
    });
    // costo de cada (producto, posición)
    const cm = new Float64Array(nProd * nPos);
    const pr = cfg.pesoRecepcion;
    const penal = new Float64Array(nPos);
    for (let j = 0; j < nPos; j++) penal[j] = penalNivelPos(posList[j], cfg);
    for (let i = 0; i < nProd; i++) {
      const p = prods[i];
      const base = i * nPos;
      for (let j = 0; j < nPos; j++) {
        const q = posList[j];
        const dd = q.dDesp, dr = q.dRec;
        cm[base + j] = p.wp * (dd * (1 - pr) * 2 + penal[j]) + p.we * (dr * pr * 2 + penal[j]) +
          (p.pesado ? 4 * (q.nivel - 1) * (p.wp + p.we) : 0);
      }
    }
    // módulos (rack + índice de módulo; todos los niveles y slots) y su capacidad de carga si el usuario la dio
    const modMap = new Map();
    const modIdx = new Int32Array(nPos);
    const modLim = [];
    for (let j = 0; j < nPos; j++) {
      const k = rackIdx[j] + ':' + (posList[j].modulo !== undefined ? posList[j].modulo : 'p' + j);
      let m = modMap.get(k);
      if (m === undefined) { m = modLim.length; modMap.set(k, m); modLim.push(Infinity); }
      modIdx[j] = m;
      const lim = posList[j].cargaMaxModuloKg;
      if (typeof lim === 'number' && isFinite(lim) && lim > 0 && lim < modLim[m]) modLim[m] = lim;
    }
    const hayModCap = modLim.some(function (v) { return v < Infinity; });
    // orden de prioridad (§5.3)
    const orden = prods.filter(function (p) { return p.posReq > 0; }).map(function (p) { return p.idx; });
    orden.sort(function (a, b) {
      const pa = prods[a], pb = prods[b];
      // prioridad de colocación: zona obligatoria o carga pesada con nivel máximo 1 (poco espacio donde ir)
      const ra = pa.zona || (pa.pesado && pa.nivelMax <= 1) ? 0 : 1, rb = pb.zona || (pb.pesado && pb.nivelMax <= 1) ? 0 : 1;
      if (ra !== rb) return ra - rb;
      const da = pa.picksEf / pa.posReq, db = pb.picksEf / pb.posReq;
      if (Math.abs(da - db) > 1e-12) return db - da;
      return pa.sku < pb.sku ? -1 : pa.sku > pb.sku ? 1 : a - b;
    });
    // afinidad por co-ocurrencia en pedidos (opcional)
    let afin = null;
    if (Array.isArray(proyecto.pedidos) && proyecto.pedidos.length && cfg.pesoAfinidad > 0) {
      const af = calcularAfinidad(proyecto.pedidos, productos);
      af.advertencias.forEach(function (a) { adv.push(a); });
      const partners = prods.map(function () { return []; });
      const pares = [];
      af.pares.forEach(function (pa) {
        if (!(pa.lift > 1)) return;
        const ia = porSku.get(pa.a), ib = porSku.get(pa.b);
        if (ia === undefined || ib === undefined || prods[ia].posReq <= 0 || prods[ib].posReq <= 0) return;
        const w = Math.min(1, (pa.lift - 1) / 2);
        partners[ia].push({ q: ib, w: w }); partners[ib].push({ q: ia, w: w });
        pares.push({ a: ia, b: ib, soporte: pa.soporte, lift: pa.lift });
      });
      partners.forEach(function (l) { l.sort(function (x, y) { return y.w - x.w || x.q - y.q; }); if (l.length > 12) l.length = 12; });
      if (pares.length) afin = { partners: partners, pares: pares, nPedidos: af.nPedidos };
    }
    return {
      cfg: cfg, pos: posList, nPos: nPos, rackIdx: rackIdx, nRacks: nRacks, rackDist: rackDist,
      prods: prods, nProd: nProd, elig: elig, cm: cm, penal: penal, orden: orden, porSku: porSku,
      nFam: fams.size, hayIncompat: hayIncompat, advertencias: adv,
      cap: cap, modIdx: modIdx, modLim: modLim, hayModCap: hayModCap, afin: afin,
      repo: cfg.reposicion.activa === true, nPick: cfg.reposicion.posicionesPicking,
      dimMax: dimMax, usarPico: usarPico, nCross: nCross, flujoCross: flujoCross, hayPeligro: conPeligro.length > 0,
      // v1.2
      combinar: combinar, hMaxNave: hMaxNave, spanK: spanK, filaDe: filaDe, modDe: modDe, filasPos: filasPos,
      cacheCam: new Map(), trabajoCam: 0, malla: mallaRepo
    };
  }


  /** Distancia mínima entre dos polígonos (0 si se solapan o se tocan). */
  function distPoligonos(A, B) {
    if (poligonosSolapan(A, B)) return 0;
    let d = Infinity;
    for (let i = 0; i < A.length; i++) {
      for (let j = 0; j < B.length; j++) {
        const b1 = B[j], b2 = B[(j + 1) % B.length];
        d = Math.min(d, distPuntoSegmento(A[i][0], A[i][1], b1[0], b1[1], b2[0], b2[1]));
      }
    }
    for (let i = 0; i < B.length; i++) {
      for (let j = 0; j < A.length; j++) {
        const a1 = A[j], a2 = A[(j + 1) % A.length];
        d = Math.min(d, distPuntoSegmento(B[i][0], B[i][1], a1[0], a1[1], a2[0], a2[1]));
      }
    }
    return d;
  }

  /**
   * Matriz de distancias entre HUELLAS de rack (no entre centroides). Si no se conoce la geometría de un
   * rack (posiciones externas), se usa la distancia entre los centros de sus posiciones.
   */
  function distanciasEntreRacks(proyecto, posList, rackIdx, nRacks) {
    const racks = proyecto.racks || [];
    const polis = new Array(nRacks).fill(null);
    const sx = new Float64Array(nRacks), sy = new Float64Array(nRacks), cn = new Int32Array(nRacks);
    const rid = new Array(nRacks).fill(undefined);
    for (let i = 0; i < posList.length; i++) {
      const r = rackIdx[i];
      sx[r] += posList[i].cx; sy[r] += posList[i].cy; cn[r]++;
      if (rid[r] === undefined) rid[r] = posList[i].rackId;
    }
    for (let r = 0; r < nRacks; r++) {
      let rk = null;
      if (rid[r] !== undefined) for (let k = 0; k < racks.length; k++) if (racks[k].id === rid[r]) { rk = racks[k]; break; }
      if (!rk && racks[r]) rk = racks[r];
      if (rk && rk.largo > 0 && rk.fondo > 0) polis[r] = poligonoRack(rk);
    }
    const out = new Float32Array(nRacks * nRacks);
    for (let a = 0; a < nRacks; a++) {
      for (let b = a; b < nRacks; b++) {
        let d;
        if (!cn[a] || !cn[b]) d = Infinity;
        else if (a === b) d = 0;
        else if (polis[a] && polis[b]) d = distPoligonos(polis[a], polis[b]);
        else d = Math.hypot(sx[a] / cn[a] - sx[b] / cn[b], sy[a] / cn[a] - sy[b] / cn[b]);
        out[a * nRacks + b] = d; out[b * nRacks + a] = d;
      }
    }
    return out;
  }

  /** Estado de incompatibilidades: conteo de posiciones por (SKU, rack). Cada par de SKU tiene su distancia mínima. */
  function crearIncompat(E) {
    const cnt = [];
    if (E.hayIncompat) for (let q = 0; q < E.nProd; q++) cnt.push(new Int32Array(E.nRacks));
    return {
      activo: E.hayIncompat,
      poner: function (p, pos) { if (E.hayIncompat) cnt[p][E.rackIdx[pos]]++; },
      quitar: function (p, pos) { if (E.hayIncompat) cnt[p][E.rackIdx[pos]]--; },
      /** ¿Puede el producto p estar en el rack r respetando incompatibilidades? (mismo rack: siempre no) */
      ok: function (p, r) {
        const conf = E.prods[p].conflictos, cd = E.prods[p].confDist;
        for (let a = 0; a < conf.length; a++) {
          const c = cnt[conf[a]];
          const dmin = cd[a];
          for (let k = 0; k < E.nRacks; k++) {
            if (c[k] > 0 && (k === r || E.rackDist[r * E.nRacks + k] < dmin)) return false;
          }
        }
        return true;
      },
      /** Racks bloqueados para p (Uint8Array) o null si p no tiene conflictos. */
      bloqueados: function (p) {
        const conf = E.prods[p].conflictos;
        if (!conf.length) return null;
        const b = new Uint8Array(E.nRacks);
        for (let r = 0; r < E.nRacks; r++) b[r] = this.ok(p, r) ? 0 : 1;
        return b;
      }
    };
  }

  /* ---- v1.2: tramos de cantilever (una carga larga sobre k bahías contiguas) ----
   * Un reparto (`owner`) es un Int32Array posición → SKU. Si hay tramos, lleva adjuntos `spanLen` (k en la posición PRINCIPAL del
   * tramo, 0 en las demás) y `spanPrin` (índice de la principal en TODAS las posiciones cubiertas por un tramo de k ≥ 2; −1 si no).
   * La principal es la primera bahía del tramo: lleva el costo y los picks; las secundarias solo ocupan espacio. */

  /** Reparto vacío (con los arreglos de tramos si la corrida puede tenerlos). */
  function nuevoOwner(E) {
    const o = new Int32Array(E.nPos).fill(-1);
    if (E.spanK) { o.spanLen = new Uint8Array(E.nPos); o.spanPrin = new Int32Array(E.nPos).fill(-1); }
    return o;
  }
  /** ¿La posición j está cubierta por un tramo de k ≥ 2 en este reparto? (principal o secundaria) */
  function enTramo(owner, j) { return !!owner.spanPrin && owner.spanPrin[j] >= 0; }
  /** ¿La posición j es una SECUNDARIA de un tramo (ocupada pero sin costo propio)? */
  function esSecundaria(owner, j) { return !!owner.spanPrin && owner.spanPrin[j] >= 0 && owner.spanPrin[j] !== j; }
  /** Bahías que ocupa el producto p si su principal es j (1 si no hay tramos). */
  function kTramo(E, p, j) { return E.spanK ? (E.spanK[p * E.nPos + j] || 1) : 1; }
  /** Posiciones que cubriría p con principal j (ordenadas por módulo), o null si alguna no existe. NO mira si están libres. */
  function cubiertasDe(E, j, k) {
    if (k <= 1) return [j];
    if (!E.filasPos || E.filaDe[j] < 0) return null;
    const fila = E.filasPos[E.filaDe[j]], m0 = E.modDe[j], cub = [];
    for (let t = 0; t < k; t++) { const c = fila[m0 + t]; if (c === undefined || c < 0) return null; cub.push(c); }
    return cub;
  }
  /** Posiciones que cubriría p en j si TODAS están libres y son elegibles; null si no se puede colocar ahí. */
  function cubLibre(E, owner, p, j) {
    if (owner[j] >= 0 || !E.elig[p * E.nPos + j]) return null;
    const k = kTramo(E, p, j);
    if (k <= 1) return [j];
    const cub = cubiertasDe(E, j, k);
    if (!cub) return null;
    for (let t = 1; t < cub.length; t++) if (owner[cub[t]] >= 0) return null;
    return cub;
  }
  /** Ocupa las posiciones `cub` con el producto p (cub[0] es la principal). */
  function ocuparCub(owner, p, cub) {
    for (let t = 0; t < cub.length; t++) owner[cub[t]] = p;
    if (cub.length > 1 && owner.spanLen) {
      owner.spanLen[cub[0]] = cub.length;
      for (let t = 0; t < cub.length; t++) owner.spanPrin[cub[t]] = cub[0];
    }
  }
  /** Posiciones cubiertas por el tramo cuya principal es j en este reparto (o [j] si no es un tramo). */
  function cubDeReparto(E, owner, j) {
    const k = owner.spanLen ? owner.spanLen[j] : 0;
    return k > 1 ? cubiertasDe(E, j, k) || [j] : [j];
  }

  /** Carga acumulada por módulo (rack + índice de módulo) frente a su `cargaMaxModuloKg` (si el usuario la dio). */
  function crearCargaModulo(E) {
    const activo = E.hayModCap;
    const carga = activo ? new Float64Array(E.modLim.length) : null;
    // en un tramo de k bahías, el peso de la carga se reparte por igual entre los módulos que cubre
    const w = function (p, j, n) { return (E.prods[p].pesoUbic * E.cap[j]) / (n || 1); };
    const aplicar = function (p, j, cub, signo) {
      if (cub && cub.length > 1) { for (let t = 0; t < cub.length; t++) carga[E.modIdx[cub[t]]] += signo * w(p, cub[t], cub.length); }
      else carga[E.modIdx[j]] += signo * w(p, j, 1);
    };
    return {
      activo: activo,
      poner: function (p, j, cub) { if (activo) aplicar(p, j, cub, 1); },
      quitar: function (p, j, cub) { if (activo) aplicar(p, j, cub, -1); },
      okPoner: function (p, j, cub) {
        if (!activo) return true;
        if (cub && cub.length > 1) {
          // los módulos cubiertos son distintos entre sí: se comprueba cada uno
          for (let t = 0; t < cub.length; t++) { const m = E.modIdx[cub[t]]; if (carga[m] + w(p, cub[t], cub.length) > E.modLim[m] + 1e-9) return false; }
          return true;
        }
        const m = E.modIdx[j];
        return carga[m] + w(p, j, 1) <= E.modLim[m] + 1e-9;
      },
      carga: function (m) { return activo ? carga[m] : 0; }
    };
  }

  /** Carga el estado de incompatibilidades y de carga por módulo a partir de un reparto ya hecho (con tramos de cantilever). */
  function cargarEstado(E, owner, inc, mod) {
    for (let j = 0; j < E.nPos; j++) {
      if (owner[j] < 0) continue;
      inc.poner(owner[j], j);
      if (!esSecundaria(owner, j)) mod.poner(owner[j], j, cubDeReparto(E, owner, j));
    }
  }

  const AFIN_RADIO_M = 6;       // m: «cerca» para la bonificación de afinidad (igual que la de familia)
  const AFIN_ESCALA_M = 10;     // m equivalentes por unidad de pesoAfinidad × peso del par [PROPIO – ajustar]

  /** Índice espacial por SKU para la bonificación de afinidad por co-ocurrencia en pedidos. */
  function crearAfinSku(E) {
    if (!E.afin) return null;
    const celdas = E.prods.map(function () { return new Map(); });
    const key = function (bx, by) { return (bx + 4096) * 8192 + (by + 4096); };
    const R = AFIN_RADIO_M;
    const kpos = function (j) { const q = E.pos[j]; return key(Math.floor(q.cx / R), Math.floor(q.cy / R)); };
    function cerca(p, j) {
      const parts = E.afin.partners[p];
      if (!parts.length) return 0;
      const q0 = E.pos[j];
      const bx = Math.floor(q0.cx / R), by = Math.floor(q0.cy / R);
      let mejor = 0;
      for (let t = 0; t < parts.length; t++) {
        const w = parts[t].w;
        if (w <= mejor) continue;
        const m = celdas[parts[t].q];
        if (!m.size) continue;
        let hit = false;
        for (let dx = -1; dx <= 1 && !hit; dx++) {
          for (let dy = -1; dy <= 1 && !hit; dy++) {
            const l = m.get(key(bx + dx, by + dy));
            if (!l) continue;
            for (let i = 0; i < l.length; i++) {
              const o = E.pos[l[i]];
              if (Math.hypot(o.cx - q0.cx, o.cy - q0.cy) < R) { hit = true; break; }
            }
          }
        }
        if (hit) mejor = w;
      }
      return mejor;
    }
    return {
      tiene: function (p) { return E.afin.partners[p].length > 0; },
      agregar: function (p, j) {
        const m = celdas[p], k = kpos(j);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(j);
      },
      quitar: function (p, j) {
        const m = celdas[p], k = kpos(j), l = m.get(k);
        if (!l) return;
        const i = l.indexOf(j);
        if (i >= 0) l.splice(i, 1);
      },
      cerca: cerca,
      /** m equivalentes de bonificación por tener un SKU afín a menos de 6 m */
      bono: function (p, j) { return E.cfg.pesoAfinidad * AFIN_ESCALA_M * cerca(p, j); }
    };
  }


  /** Índice espacial simple por familia para la bonificación de afinidad (celdas de 6 m). */
  function crearAfinidad(E) {
    const porFam = [];
    for (let f = 0; f < E.nFam; f++) porFam.push(new Map());
    const key = function (bx, by) { return (bx + 4096) * 8192 + (by + 4096); };
    return {
      agregar: function (fam, pos) {
        const q = E.pos[pos];
        const k = key(Math.floor(q.cx / 6), Math.floor(q.cy / 6));
        const m = porFam[fam];
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(pos);
      },
      cerca: function (fam, pos) {
        const q = E.pos[pos];
        const bx = Math.floor(q.cx / 6), by = Math.floor(q.cy / 6);
        const m = porFam[fam];
        if (!m.size) return false;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const l = m.get(key(bx + dx, by + dy));
            if (!l) continue;
            for (let i = 0; i < l.length; i++) {
              const o = E.pos[l[i]];
              if (Math.hypot(o.cx - q.cx, o.cy - q.cy) < 6) return true;
            }
          }
        }
        return false;
      }
    };
  }

  /** Costo «unitario» (por movimiento) para ordenar candidatas; usa un pick virtual si el SKU no se mueve. */
  function costoUnitario(E, p, j) {
    const pr = E.prods[p];
    const w = pr.wp + pr.we;
    if (w > 0) return E.cm[p * E.nPos + j] / w;
    const q = E.pos[j];
    return q.dDesp * (1 - E.cfg.pesoRecepcion) * 2 + E.penal[j];
  }

  const TOPE_EVALUACIONES = 8000000;      // presupuesto de la mejora local (no de reloj: resultado reproducible)
  const MAX_CELDAS_SLOTTING = 80000000;   // SKU × posiciones: tope de memoria de las matrices de costo
  const PESO_COMPACIDAD = 0.25;   // m de costo por m de separación respecto de la semilla (§5.3)
  const BONO_AFINIDAD = 0.3;      // m equivalentes por tener un SKU de la misma familia a < 6 m

  /** Fase constructiva: coloca cada producto como clúster compacto (§5.3). */
  function construirAsignacion(E, owner, inc, mod, afs) {
    const af = crearAfinidad(E);
    for (let j = 0; j < E.nPos; j++) if (owner[j] >= 0) { af.agregar(E.prods[owner[j]].fam, j); if (afs) afs.agregar(owner[j], j); }
    const colocadas = new Int32Array(E.nProd);
    for (let j = 0; j < E.nPos; j++) if (owner[j] >= 0 && !esSecundaria(owner, j)) colocadas[owner[j]]++;   // unidades (un tramo = 1)
    for (let oi = 0; oi < E.orden.length; oi++) {
      const p = E.orden[oi];
      const pr = E.prods[p];
      const faltan = pr.posReq - colocadas[p];
      if (faltan <= 0) continue;
      const bloq = inc.activo ? inc.bloqueados(p) : null;
      const base = p * E.nPos;
      const afP = afs && afs.tiene(p);
      const cands = [];
      const cubMap = E.spanK ? new Map() : null;   // principal → posiciones del tramo (solo k ≥ 2)
      for (let j = 0; j < E.nPos; j++) {
        const cub = cubLibre(E, owner, p, j);
        if (!cub) continue;
        if (bloq && bloq[E.rackIdx[j]]) continue;
        if (mod.activo && !mod.okPoner(p, j, cub)) continue;
        cands.push(j);
        if (cubMap && cub.length > 1) cubMap.set(j, cub);
      }
      if (!cands.length) continue;
      // semilla: menor costo (con bonificación de afinidad por pedidos si la hay)
      let seed = cands[0], sc = Infinity;
      for (let k = 0; k < cands.length; k++) {
        let c = costoUnitario(E, p, cands[k]);
        if (afP) c -= afs.bono(p, cands[k]);
        if (c < sc - 1e-12) { sc = c; seed = cands[k]; }
      }
      const elegidas = [seed];
      const tomadas = new Set(cubMap && cubMap.get(seed) ? cubMap.get(seed) : [seed]);
      mod.poner(p, seed, cubMap ? cubMap.get(seed) : null);
      if (faltan > 1 && cands.length > 1) {
        const sp = E.pos[seed];
        const llaves = new Float64Array(cands.length);
        const idx = [];
        for (let k = 0; k < cands.length; k++) {
          const j = cands[k];
          if (j === seed) { llaves[k] = Infinity; idx.push(k); continue; }
          const q = E.pos[j];
          let key = costoUnitario(E, p, j) + PESO_COMPACIDAD * Math.hypot(q.cx - sp.cx, q.cy - sp.cy);
          if (af.cerca(pr.fam, j)) key -= BONO_AFINIDAD;
          if (afP) key -= afs.bono(p, j);
          llaves[k] = key;
          idx.push(k);
        }
        idx.sort(function (a, b) { return llaves[a] - llaves[b] || cands[a] - cands[b]; });
        for (let k = 0; k < idx.length && elegidas.length < faltan; k++) {
          const j = cands[idx[k]];
          if (j === seed) continue;
          const cj = cubMap ? cubMap.get(j) || null : null;
          // un tramo no puede solaparse con otro ya elegido en esta misma pasada
          if (cj ? cj.some(function (c) { return tomadas.has(c); }) : tomadas.has(j)) continue;
          if (mod.activo && !mod.okPoner(p, j, cj)) continue;
          elegidas.push(j);
          (cj || [j]).forEach(function (c) { tomadas.add(c); });
          mod.poner(p, j, cj);
        }
      }
      for (let k = 0; k < elegidas.length; k++) {
        const j = elegidas[k];
        const cub = cubMap && cubMap.get(j) ? cubMap.get(j) : [j];
        ocuparCub(owner, p, cub);
        for (let t = 0; t < cub.length; t++) {
          inc.poner(p, cub[t]);
          af.agregar(pr.fam, cub[t]);
          if (afs) afs.agregar(p, cub[t]);
        }
      }
      colocadas[p] += elegidas.length;
    }
    return colocadas;
  }

  /* ---- v1.2: distancia CAMINADA entre puntos de acceso (reposición reserva → picking) ---- */
  const TOPE_TRABAJO_CAM = 20000000;   // celdas fijadas por Dijkstra en toda la corrida (presupuesto de trabajo, no de reloj: reproducible)

  /**
   * Distancias caminando (m) desde el punto de acceso A hasta cada punto B de `Bs`, sobre la MISMA malla caminable del resto del
   * motor (Dijkstra con parada anticipada al fijar todos los destinos; se guarda en E.cacheCam por par de puntos).
   * Devuelve {d:[…], causa:[…]}: d[i] = Infinity cuando no hay distancia caminada y causa[i] ∈ 'sin_malla' | 'no_alcanzable' |
   * 'presupuesto' (el llamador usa entonces la línea recta como respaldo y lo avisa).
   */
  function caminadasDesde(E, A, Bs) {
    const d = new Array(Bs.length).fill(Infinity), causa = new Array(Bs.length).fill(null);
    const key = function (P) { return P[0] + ',' + P[1]; };
    const faltan = [];
    for (let i = 0; i < Bs.length; i++) {
      if (A[0] === Bs[i][0] && A[1] === Bs[i][1]) { d[i] = 0; continue; }
      const k = key(A) + '|' + key(Bs[i]);
      const c = E.cacheCam.get(k);
      if (c !== undefined) { d[i] = c; if (!isFinite(c)) causa[i] = 'no_alcanzable'; continue; }
      faltan.push(i);
    }
    if (!faltan.length) return { d: d, causa: causa };
    const m = E.malla;
    if (!m || !m.nx) { faltan.forEach(function (i) { causa[i] = 'sin_malla'; }); return { d: d, causa: causa }; }
    if (E.trabajoCam >= TOPE_TRABAJO_CAM) { faltan.forEach(function (i) { causa[i] = 'presupuesto'; }); return { d: d, causa: causa }; }
    const ccA = celdaCaminableCercana(m, A[0], A[1], m.celda * 1.0 + 1e-9);
    const ccB = faltan.map(function (i) { return celdaCaminableCercana(m, Bs[i][0], Bs[i][1], m.celda * 1.0 + 1e-9); });
    let dist = null;
    const objetivos = [];
    ccB.forEach(function (c) { if (c) objetivos.push(c.idx); });
    if (ccA && objetivos.length) {
      const info = { pops: 0 };
      dist = dijkstraMalla(m, [ccA.idx], [ccA.d], objetivos, info);
      E.trabajoCam += info.pops;
    }
    faltan.forEach(function (i, t) {
      const c = ccB[t];
      let v = Infinity;
      if (ccA && c) {
        if (c.idx === ccA.idx) v = Math.hypot(A[0] - Bs[i][0], A[1] - Bs[i][1]);
        else if (isFinite(dist[c.idx])) v = dist[c.idx] + c.d;
      }
      d[i] = v;
      if (!isFinite(v)) causa[i] = 'no_alcanzable';
      E.cacheCam.set(key(A) + '|' + key(Bs[i]), v);
    });
    return { d: d, causa: causa };
  }

  /** Punto de acceso (en el pasillo) de una posición; el centro si no lo trae. */
  function puntoAcceso(q) { return [q.ax !== undefined ? q.ax : q.cx, q.ay !== undefined ? q.ay : q.cy]; }

  /**
   * Construcción con modo picking/reserva (config.reposicion.activa), en dos fases:
   * 1) cada SKU coloca su(s) posición(es) de PICKING: la de menor distancia al despacho entre las de nivel accesible
   *    (penalización de nivel 0: nivel 1 en palet, zona dorada en bin), por orden de picks por posición de picking;
   * 2) los SKU con más de una posición colocan su RESERVA cerca del picking, en el espacio que quedó (niveles altos / más lejos),
   *    por orden de reposiciones. No aplica la mejora local (se declara en los supuestos).
   */
  function construirReposicion(E, owner, inc, mod) {
    const nPos = E.nPos, rec = E.cfg.pesoRecepcion;
    const picksPos = E.prods.map(function () { return []; });
    const ord1 = E.orden.slice();
    const rango = function (p) { const pr = E.prods[p]; return pr.zona || (pr.pesado && pr.nivelMax <= 1) ? 0 : 1; };
    const dens = function (p) { const pr = E.prods[p]; return pr.picksEf / Math.max(1, Math.min(pr.posReq, E.nPick)); };
    ord1.sort(function (a, b) {
      const ra = rango(a), rb = rango(b);
      if (ra !== rb) return ra - rb;
      const da = dens(a), db = dens(b);
      if (Math.abs(da - db) > 1e-12) return db - da;
      return E.prods[a].sku < E.prods[b].sku ? -1 : E.prods[a].sku > E.prods[b].sku ? 1 : a - b;
    });
    for (let oi = 0; oi < ord1.length; oi++) {
      const p = ord1[oi], pr = E.prods[p];
      const nP = pr.posReq > 1 ? Math.min(E.nPick, pr.posReq) : 1;
      const bloq = inc.activo ? inc.bloqueados(p) : null;
      const base = p * nPos;
      for (let t = 0; t < nP; t++) {
        let mejor = -1, mc = Infinity, mflag = 2, mcub = null;
        for (let j = 0; j < nPos; j++) {
          const cub = cubLibre(E, owner, p, j);
          if (!cub) continue;
          if (bloq && bloq[E.rackIdx[j]]) continue;
          if (mod.activo && !mod.okPoner(p, j, cub)) continue;
          const flag = E.penal[j] > 0 ? 1 : 0;
          const c = E.pos[j].dDesp;
          if (flag < mflag || (flag === mflag && c < mc - 1e-12)) { mejor = j; mc = c; mflag = flag; mcub = cub; }
        }
        if (mejor < 0) break;
        ocuparCub(owner, p, mcub); mcub.forEach(function (c) { inc.poner(p, c); }); mod.poner(p, mejor, mcub);
        picksPos[p].push(mejor);
      }
    }
    // fase 2: reservas
    const repos = function (p) { const pr = E.prods[p]; return (pr.picksEf * (pr.upl === null ? 1 : pr.upl)) / pr.upu; };
    const ord2 = ord1.filter(function (p) { return E.prods[p].posReq > 1 && picksPos[p].length > 0; });
    ord2.sort(function (a, b) { return repos(b) - repos(a) || (E.prods[a].sku < E.prods[b].sku ? -1 : E.prods[a].sku > E.prods[b].sku ? 1 : a - b); });
    for (let oi = 0; oi < ord2.length; oi++) {
      const p = ord2[oi], pr = E.prods[p];
      const faltan = pr.posReq - picksPos[p].length;
      if (faltan <= 0) continue;
      const bloq = inc.activo ? inc.bloqueados(p) : null;
      const base = p * nPos;
      const P0 = puntoAcceso(E.pos[picksPos[p][0]]);
      const ax0 = P0[0], ay0 = P0[1];
      const cands = [], llaves = [];
      for (let j = 0; j < nPos; j++) {
        if (owner[j] >= 0 || !E.elig[base + j]) continue;
        if (bloq && bloq[E.rackIdx[j]]) continue;
        const q = E.pos[j];
        const ax = q.ax !== undefined ? q.ax : q.cx, ay = q.ay !== undefined ? q.ay : q.cy;
        cands.push(j); llaves.push(2 * Math.hypot(ax - ax0, ay - ay0) + E.penal[j]);
      }
      const idx = cands.map(function (c, k) { return k; });
      idx.sort(function (a, b) { return llaves[a] - llaves[b] || cands[a] - cands[b]; });
      // v1.2: la cercanía se mide CAMINANDO. La recta es cota inferior de la caminada: se re-ordena con la distancia caminada
      // una ventana de los mejores candidatos por recta (faltan·3 + 30 [PROPIO]); el resto queda después, ordenado por recta.
      const ventana = Math.min(idx.length, faltan * 3 + 30);
      if (E.malla && ventana > 0) {
        const win = idx.slice(0, ventana);
        const cam = caminadasDesde(E, P0, win.map(function (k) { return puntoAcceso(E.pos[cands[k]]); }));
        const claveW = new Map();
        win.forEach(function (k, t) { claveW.set(k, isFinite(cam.d[t]) ? 2 * cam.d[t] + E.penal[cands[k]] : llaves[k]); });
        const ordW = win.slice().sort(function (a, b) { return claveW.get(a) - claveW.get(b) || cands[a] - cands[b]; });
        for (let t = 0; t < ventana; t++) idx[t] = ordW[t];
      }
      let puestas = 0;
      for (let k = 0; k < idx.length && puestas < faltan; k++) {
        const j = cands[idx[k]];
        const cub = cubLibre(E, owner, p, j);
        if (!cub) continue;
        if (mod.activo && !mod.okPoner(p, j, cub)) continue;
        ocuparCub(owner, p, cub); cub.forEach(function (c) { inc.poner(p, c); }); mod.poner(p, j, cub);
        puestas++;
      }
    }
  }

  /**
   * Mejora local (§5.4): intercambios ocupada↔libre y ocupada↔ocupada que bajan el costo total sin romper
   * restricciones duras. El tope es un presupuesto de evaluaciones (no de reloj) para que el resultado sea
   * reproducible. Devuelve el número de movimientos aplicados.
   */
  function mejoraLocal(E, owner, inc, pasadas, semilla, tope, mod, afs) {
    const nPos = E.nPos, cm = E.cm, elig = E.elig, rk = E.rackIdx, cap = E.cap;
    const sp = owner.spanPrin || null, spK = E.spanK || null;   // v1.2: los tramos de cantilever no se mueven ni se intercambian
    let evals = 0, movs = 0, cortado = false;
    for (let pas = 0; pas < pasadas; pas++) {
      const ocup = [];
      for (let j = 0; j < nPos; j++) if (owner[j] >= 0) ocup.push(j);
      // orden determinista: primero las posiciones de mayor movimiento por posición (donde más se gana si el
      // presupuesto de evaluaciones se agota antes de recorrerlas todas)
      ocup.sort(function (x, y) { return (E.prods[owner[y]].wp + E.prods[owner[y]].we) - (E.prods[owner[x]].wp + E.prods[owner[x]].we) || x - y; });
      let mejoroAlgo = false;
      for (let oi = 0; oi < ocup.length; oi++) {
        const a = ocup[oi];
        const p = owner[a];
        if (p < 0 || (sp && sp[a] >= 0)) continue;
        const bp = p * nPos;
        const cA = cm[bp + a];
        let mejorDelta = -1e-9, mejorB = -1;
        for (let b = 0; b < nPos; b++) {
          if (b === a || !elig[bp + b]) continue;
          if (cap[b] !== cap[a]) continue;   // intercambiar ubicaciones de distinta capacidad cambiaría la cobertura del SKU
          if (spK && spK[bp + b] >= 2) continue;   // b sería el inicio de un tramo de k bahías: no cabe un solo hueco
          if (sp && sp[b] >= 0) continue;          // b pertenece a un tramo de otro SKU
          const q = owner[b];
          let delta;
          if (q < 0) delta = cm[bp + b] - cA;
          else {
            if (q === p || !elig[q * nPos + a]) continue;
            if (spK && spK[q * nPos + a] >= 2) continue;
            delta = cm[bp + b] + cm[q * nPos + a] - cA - cm[q * nPos + b];
          }
          if (delta < mejorDelta) {
            if (inc.activo) {
              // comprobar incompatibilidades del movimiento
              inc.quitar(p, a);
              if (q >= 0) inc.quitar(q, b);
              let ok = inc.ok(p, rk[b]);
              if (ok) {
                inc.poner(p, b);
                if (q >= 0) ok = inc.ok(q, rk[a]);
                inc.quitar(p, b);
              }
              inc.poner(p, a);
              if (q >= 0) inc.poner(q, b);
              if (!ok) continue;
            }
            if (mod.activo) {
              // carga por módulo del movimiento
              mod.quitar(p, a);
              if (q >= 0) mod.quitar(q, b);
              let ok = mod.okPoner(p, b);
              if (ok) {
                mod.poner(p, b);
                if (q >= 0) ok = mod.okPoner(q, a);
                mod.quitar(p, b);
              }
              mod.poner(p, a);
              if (q >= 0) mod.poner(q, b);
              if (!ok) continue;
            }
            if (afs) {
              // no deshacer la cercanía a SKU afines que la construcción logró
              if (afs.tiene(p) && afs.cerca(p, b) < afs.cerca(p, a) - 1e-12) continue;
              if (q >= 0 && afs.tiene(q) && afs.cerca(q, a) < afs.cerca(q, b) - 1e-12) continue;
            }
            mejorDelta = delta; mejorB = b;
          }
        }
        evals += nPos;
        if (mejorB >= 0) {
          const b = mejorB, q = owner[b];
          inc.quitar(p, a);
          if (q >= 0) inc.quitar(q, b);
          mod.quitar(p, a);
          if (q >= 0) mod.quitar(q, b);
          if (afs) { afs.quitar(p, a); if (q >= 0) afs.quitar(q, b); }
          owner[b] = p;
          inc.poner(p, b);
          mod.poner(p, b);
          if (afs) afs.agregar(p, b);
          if (q >= 0) { owner[a] = q; inc.poner(q, a); mod.poner(q, a); if (afs) afs.agregar(q, a); } else owner[a] = -1;
          movs++;
          mejoroAlgo = true;
        }
        if (evals > tope) { cortado = true; return { movs: movs, evals: evals, cortado: cortado }; }
      }
      if (!mejoroAlgo) break;
    }
    return { movs: movs, evals: evals, cortado: cortado };
  }

  /** Reparto «sin criterio»: SKU en el orden de ingreso sobre posiciones numeradas (respeta restricciones duras). */
  function repartoBaseline(E) {
    const owner = nuevoOwner(E);
    const inc = crearIncompat(E);
    const mod = crearCargaModulo(E);
    for (let p = 0; p < E.nProd; p++) {
      const pr = E.prods[p];
      if (pr.posReq <= 0) continue;
      const bloq = inc.activo ? inc.bloqueados(p) : null;
      let faltan = pr.posReq;
      for (let j = 0; j < E.nPos && faltan > 0; j++) {
        const cub = cubLibre(E, owner, p, j);
        if (!cub) continue;
        if (bloq && bloq[E.rackIdx[j]]) continue;
        if (mod.activo && !mod.okPoner(p, j, cub)) continue;
        ocuparCub(owner, p, cub); cub.forEach(function (c) { inc.poner(p, c); }); mod.poner(p, j, cub); faltan--;
      }
    }
    return owner;
  }


  /**
   * Roles picking/reserva de un reparto (solo con config.reposicion.activa). Un SKU con posReq > 1 y al menos una posición
   * ubicada se «divide»: su(s) posición(es) de picking = las de menor distancia al despacho entre las de nivel accesible
   * (penalización de nivel 0) y el resto es reserva. Calcula también las reposiciones: repos = picks·unidadesPorLinea/unidadesPorUbic
   * (palets-equivalentes por periodo), repartidas por igual entre las posiciones de reserva.
   */
  function rolesReparto(E, owner) {
    const rol = new Int8Array(E.nPos);     // 0 sin rol · 1 picking · 2 reserva
    const dividido = new Uint8Array(E.nProd);
    const nPickEf = new Int32Array(E.nProd);
    const reposJ = new Float64Array(E.nPos), distJ = new Float64Array(E.nPos);
    const porProd = [];
    for (let p = 0; p < E.nProd; p++) porProd.push([]);
    for (let j = 0; j < E.nPos; j++) if (owner[j] >= 0 && !esSecundaria(owner, j)) porProd[owner[j]].push(j);   // v1.2: un tramo cuenta por su principal
    let reposTot = 0, reposDist = 0, skusConPicking = 0, sinUpl = 0, nCam = 0;
    const respaldo = { sin_malla: 0, no_alcanzable: 0, presupuesto: 0 };
    for (let p = 0; p < E.nProd; p++) {
      const pr = E.prods[p], ps = porProd[p];
      if (pr.posReq <= 1 || !ps.length) continue;
      dividido[p] = 1; skusConPicking++;
      const orden = ps.slice().sort(function (x, y) {
        const fx = E.penal[x] > 0 ? 1 : 0, fy = E.penal[y] > 0 ? 1 : 0;
        return fx - fy || E.pos[x].dDesp - E.pos[y].dDesp || x - y;
      });
      const nP = Math.min(E.nPick, orden.length);
      nPickEf[p] = nP;
      const picks = orden.slice(0, nP), res = orden.slice(nP);
      picks.forEach(function (j) { rol[j] = 1; });
      res.forEach(function (j) { rol[j] = 2; });
      if (!res.length) continue;
      if (pr.upl === null) sinUpl++;
      const repos = (pr.picksEf * (pr.upl === null ? 1 : pr.upl)) / pr.upu;
      const rj = repos / res.length;
      // v1.2: distancia CAMINADA reserva → picking (mínima entre las posiciones de picking); si no existe, línea recta de respaldo
      const resPts = res.map(function (j) { return puntoAcceso(E.pos[j]); });
      const dCam = new Array(res.length).fill(Infinity), causa = new Array(res.length).fill(null);
      picks.forEach(function (k) {
        const cam = caminadasDesde(E, puntoAcceso(E.pos[k]), resPts);
        for (let i = 0; i < res.length; i++) {
          if (cam.d[i] < dCam[i]) dCam[i] = cam.d[i];
          else if (!isFinite(cam.d[i]) && causa[i] === null) causa[i] = cam.causa[i] || 'no_alcanzable';
        }
      });
      res.forEach(function (j, i) {
        const A = resPts[i];
        let d = dCam[i];
        if (isFinite(d)) nCam++;
        else {
          d = Infinity;
          picks.forEach(function (k) { const B = puntoAcceso(E.pos[k]); const dd = Math.hypot(A[0] - B[0], A[1] - B[1]); if (dd < d) d = dd; });
          respaldo[causa[i] || 'no_alcanzable']++;
        }
        reposJ[j] = rj; distJ[j] = d;
        reposTot += rj; reposDist += rj * d;
      });
    }
    return { rol: rol, dividido: dividido, nPickEf: nPickEf, reposJ: reposJ, distJ: distJ, reposTot: reposTot, reposDist: reposDist, skusConPicking: skusConPicking, sinUpl: sinUpl,
      nCaminada: nCam, respaldo: respaldo, nRespaldo: respaldo.sin_malla + respaldo.no_alcanzable + respaldo.presupuesto };
  }

  /** Estadísticas de un reparto: costo, distancia ponderada, por producto y por clase. */
  function estadisticasReparto(E, owner) {
    const porProd = [];
    for (let p = 0; p < E.nProd; p++) porProd.push({ pos: [], costo: 0, dsum: 0, nPrin: 0 });
    let costo = 0, wpSum = 0, wdSum = 0, ocupadas = 0, a1 = 0, aTot = 0;
    const cls = { A: { skus: 0, posiciones: 0, wp: 0, wd: 0, dsum: 0, np: 0 }, B: { skus: 0, posiciones: 0, wp: 0, wd: 0, dsum: 0, np: 0 }, C: { skus: 0, posiciones: 0, wp: 0, wd: 0, dsum: 0, np: 0 } };
    E.prods.forEach(function (pr) { if (pr.posReq > 0) cls[pr.clase].skus++; });
    const roles = E.repo ? rolesReparto(E, owner) : null;
    const rec = E.cfg.pesoRecepcion;
    for (let j = 0; j < E.nPos; j++) {
      const p = owner[j];
      if (p < 0) continue;
      const pr = E.prods[p], q = E.pos[j];
      // v1.2: una posición SECUNDARIA de un tramo de cantilever ocupa espacio pero no lleva costo, picks ni distancia propios (los lleva la principal)
      if (esSecundaria(owner, j)) { ocupadas++; porProd[p].pos.push(j); cls[pr.clase].posiciones++; continue; }
      let c, wpj = pr.wp;
      if (roles && roles.dividido[p]) {
        const dd0 = q.dDesp, dr0 = q.dRec;
        if (roles.rol[j] === 1) {
          wpj = pr.picksEf / roles.nPickEf[p];
          c = wpj * (dd0 * (1 - rec) * 2 + E.penal[j]) + pr.we * (dr0 * rec * 2 + E.penal[j]) + (pr.pesado ? 4 * (q.nivel - 1) * (wpj + pr.we) : 0);
        } else {
          wpj = 0;
          const rj = roles.reposJ[j];
          c = rj * (2 * roles.distJ[j] + E.penal[j]) + pr.we * (dr0 * rec * 2 + E.penal[j]) + (pr.pesado ? 4 * (q.nivel - 1) * (rj + pr.we) : 0);
        }
      } else c = E.cm[p * E.nPos + j];
      ocupadas++;
      porProd[p].pos.push(j);
      porProd[p].nPrin++;
      porProd[p].costo += isFinite(c) ? c : 0;
      porProd[p].dsum += isFinite(q.dDesp) ? q.dDesp : 0;
      if (isFinite(c)) costo += c;
      const dd = isFinite(q.dDesp) ? q.dDesp : 0;
      wpSum += wpj; wdSum += wpj * dd;
      const k = cls[pr.clase];
      k.posiciones++; k.np++; k.wp += wpj; k.wd += wpj * dd; k.dsum += dd;
      if (pr.clase === 'A') { aTot += wpj; if (q.nivel === 1) a1 += wpj; }
    }
    return { costo: costo, wpSum: wpSum, wdSum: wdSum, ocupadas: ocupadas, porProd: porProd, cls: cls, a1Pct: aTot > 0 ? (100 * a1) / aTot : 0, roles: roles };
  }

  /** v1.2: bahías de cantilever que ocuparía la carga del producto `pr` con principal en la posición q (1 si cabe en una bahía o no se combina). */
  function kPorLargo(E, pr, q) {
    if (q.tipo !== 'cantilever' || pr.largo === null || !E.combinar || !(q.anchoBahiaM > 0) || pr.largo <= q.anchoBahiaM + 1e-9) return 1;
    return Math.max(2, Math.ceil(pr.largo / q.anchoBahiaM - 1e-9));
  }

  /** Motivo por el cual un SKU no puede ubicarse (cascada de filtros duros). */
  function motivoFalta(E, p, owner, bloq, faltan, mod) {
    const pr = E.prods[p];
    let n = 0;
    const kPos = function (q) { return kPorLargo(E, pr, q); };
    const f = [function (q) { return q.tipo === pr.tipo; },
      function (q) { return pr.pesoUbic / kPos(q) <= q.cargaMaxKg + 1e-9; },
      function (q) { return pr.alto <= (q.alturaLibreM === undefined ? Infinity : q.alturaLibreM) + 1e-9; },
      function (q) { return pr.zona ? q.zonaTipo === pr.zona : ZONAS_RESTRINGIDAS.indexOf(q.zonaTipo) < 0; },
      function (q) { return !pr.pesado || q.nivel <= pr.nivelMax; },
      function (q) { return (q.apilado || 1) <= pr.apilableMax; },
      function (q) { return q.tipo !== 'piso' || !pr.altoDado || alturaApilado(pr.alto, q.apilado || 1, E.cfg.holguraSobreCarga) <= E.hMaxNave + 1e-9; },
      function (q, j) {
        if (q.tipo !== 'cantilever') return true;
        if (pr.largo === null) return false;
        const k = kPos(q);
        if (k <= 1) return pr.largo <= (q.anchoBahiaM === undefined || q.anchoBahiaM === null ? Infinity : q.anchoBahiaM) + 1e-9;
        return !!cubiertasDe(E, j, k);   // ¿existen k bahías contiguas desde esta posición?
      },
      function (q) { return !(pr.fefo && q.lifo === true); },
      function (q) { return !!q.accesible; }];
    const nombres = [
      ['tipo', 'No existe ninguna posición de tipo «' + pr.tipo + '».'],
      ['peso', 'Ninguna posición del tipo «' + pr.tipo + '» soporta ' + redondear(pr.pesoUbic, 1) + ' kg por ubicación.'],
      ['altura', 'Ninguna posición admite una carga de ' + pr.alto + ' m de alto.'],
      ['zona', pr.zona ? 'No hay posiciones dentro de una zona «' + pr.zona + '».' : 'Solo quedan posiciones en zonas reservadas (frío, peligrosos, alto valor, cuarentena).'],
      ['nivel_pesado', 'Carga pesada (' + redondear(pr.pesoUbic, 1) + ' kg por ubicación): solo puede ir hasta el nivel ' + pr.nivelMax + ' y no quedan posiciones así.'],
      ['apilado', 'La carga solo se puede apilar ' + pr.apilableMax + ' palet(s) (apilableMax) y las posiciones compatibles piden más apilado.'],
      ['altura_apilado', ''],
      ['largo', pr.largo === null ? 'Falta el largo de la carga (largoM) para ubicarla en cantilever.' : (E.combinar ? 'La carga mide ' + pr.largo + ' m de largo y no hay ' + 'bahías contiguas suficientes en ningún rack de cantilever (se combinan bahías contiguas del mismo rack y nivel hasta el máximo de módulos del rack).' : 'La carga mide ' + pr.largo + ' m de largo y ninguna bahía de cantilever lo admite (la combinación de bahías contiguas está desactivada: config.cantileverCombinar = false).')],
      ['fefo_lifo', 'El SKU sale por vencimiento (FEFO) y solo quedan ubicaciones LIFO (carriles profundos o apilados).'],
      ['inaccesible', 'Las posiciones compatibles no son accesibles desde las puertas.']
    ];
    let cur = E.pos.map(function (q, j) { return j; });
    for (let k = 0; k < f.length; k++) {
      const antes = cur.length;
      const previos = cur;
      cur = cur.filter(function (j) { return f[k](E.pos[j], j); });
      n = cur.length;
      if (n === 0) {
        if (nombres[k][0] === 'altura_apilado') {
          // con los números: el apilado MÍNIMO entre las posiciones de piso que pasaron los filtros previos
          let aMin = Infinity;
          previos.forEach(function (j) { const q = E.pos[j]; if (q.tipo === 'piso') aMin = Math.min(aMin, q.apilado || 1); });
          const h = alturaApilado(pr.alto, aMin, E.cfg.holguraSobreCarga);
          return { motivo: 'altura_apilado', detalle: 'Apilar ' + aMin + ' (mínimo disponible) cargas de ' + redondear(pr.alto, 2) + ' m con ' + E.cfg.holguraSobreCarga + ' m de holgura entre ellas da ' + redondear(h, 2) + ' m y la altura libre de la nave menos la holgura a rociadores es ' + redondear(E.hMaxNave, 2) + ' m (altura × apilado + holgura × (apilado − 1) ≤ altura libre − holgura a rociadores) [VERIFICAR NFPA 13 / RNE A.130].' };
        }
        return { motivo: nombres[k][0], detalle: nombres[k][1] };
      }
      // la restricción de nivel de las cargas pesadas es lo que deja corto al SKU
      if (nombres[k][0] === 'nivel_pesado' && n < pr.posReq && antes >= pr.posReq) return { motivo: 'nivel_pesado', detalle: nombres[k][1] + ' Quedan ' + n + ' posiciones de nivel permitido y se necesitan ' + pr.posReq + '.' };
    }
    // v1.2: solo cuentan las posiciones desde las que el SKU realmente puede colocarse (en un tramo, además deben cumplir las k bahías)
    const elegibles = cur.filter(function (j) { return E.elig[p * E.nPos + j]; });
    if (pr.tipo === 'cantilever') {
      if (!elegibles.length) return { motivo: 'largo', detalle: nombres[7][1] + ' Además las bahías contiguas deben cumplir peso, altura, zona y accesibilidad.' };
      cur = elegibles; n = cur.length;
    }
    const libres = cur.filter(function (j) {
      const cub = cubiertasDe(E, j, kTramo(E, p, j));
      return !!cub && cub.every(function (c) { return owner[c] < 0; });
    });
    const libresOk = bloq ? libres.filter(function (j) { return !bloq[E.rackIdx[j]]; }) : libres;
    if (libres.length >= faltan && libresOk.length < faltan) {
      return { motivo: 'incompatibilidad', detalle: 'Hay espacio, pero está a menos de ' + E.cfg.separacionIncompatibles + ' m de familias incompatibles o de clases de peligro que deben segregarse (o en el mismo rack).' };
    }
    if (mod && mod.activo) {
      const libresMod = libresOk.filter(function (j) { return mod.okPoner(p, j, cubiertasDe(E, j, kTramo(E, p, j))); });
      if (libresOk.length >= faltan && libresMod.length < faltan) {
        return { motivo: 'carga_modulo', detalle: 'Hay posiciones libres, pero sus módulos superarían la capacidad de carga por módulo (cargaMaxModuloKg): ' + redondear(pr.pesoUbic, 1) + ' kg por ubicación.' };
      }
    }
    let kmax = 1;
    cur.forEach(function (j) { const k = kTramo(E, p, j); if (k > kmax) kmax = k; });
    if (kmax >= 2) return { motivo: 'capacidad', detalle: 'Se necesitan ' + pr.posReq + ' tramo(s) de ' + kmax + ' bahías contiguas (la carga mide ' + pr.largo + ' m) y solo hay ' + libres.length + ' tramo(s) libres de ' + n + ' posibles.' };
    return { motivo: 'capacidad', detalle: 'Se necesitan ' + pr.posReq + ' posiciones y solo hay ' + n + ' compatibles en total (' + libres.length + ' libres).' };
  }

  /** Centroide (x,y) de las posiciones de cada SKU en un reparto; null si no tiene. */
  function centroidesReparto(E, owner) {
    const sx = new Float64Array(E.nProd), sy = new Float64Array(E.nProd), n = new Int32Array(E.nProd);
    for (let j = 0; j < E.nPos; j++) { const p = owner[j]; if (p < 0 || esSecundaria(owner, j)) continue; sx[p] += E.pos[j].cx; sy[p] += E.pos[j].cy; n[p]++; }
    return { sx: sx, sy: sy, n: n };
  }

  /** Distancia media (soporte-ponderada) entre los centroides de los pares con lift > 1. */
  function distParesAfines(E, owner) {
    if (!E.afin) return { pares: 0, dist: null };
    const c = centroidesReparto(E, owner);
    let sw = 0, sd = 0, np = 0;
    E.afin.pares.forEach(function (pa) {
      if (!c.n[pa.a] || !c.n[pa.b]) return;
      const d = Math.hypot(c.sx[pa.a] / c.n[pa.a] - c.sx[pa.b] / c.n[pa.b], c.sy[pa.a] / c.n[pa.a] - c.sy[pa.b] / c.n[pa.b]);
      sw += pa.soporte; sd += pa.soporte * d; np++;
    });
    return { pares: np, dist: sw > 0 ? redondear(sd / sw, 2) : null };
  }

  /**
   * Reparte las posiciones de cada SKU con `lotes` entre sus lotes (FEFO dentro del SKU): los lotes que vencen antes van a las
   * posiciones de menor distancia de despacho (salen primero); los sin fecha, al final. Una posición puede quedar con más de un
   * lote si las cantidades no cuadran con la capacidad; entonces `lotePorPosicion[pos].lotes` lista la mezcla.
   * NO lee el reloj: los días restantes se calculan solo con `fechaRef`.
   */
  function repartirLotes(E, owner, productosOrig, fechaRef, adv) {
    const lotePorPosicion = {}, vencimientos = [];
    const refMs = fechaRef ? parseFechaISO(fechaRef) : null;
    let hayVence = false;
    const porProd = [];
    for (let p = 0; p < E.nProd; p++) porProd.push([]);
    for (let j = 0; j < E.nPos; j++) if (owner[j] >= 0 && !esSecundaria(owner, j)) porProd[owner[j]].push(j);   // un tramo de cantilever lleva sus lotes en la principal
    E.prods.forEach(function (pr, p) {
      const orig = productosOrig[pr.idx];
      if (pr.invalido || !orig || !Array.isArray(orig.lotes) || !orig.lotes.length) return;
      const lotes = [];
      const sinNom = [];
      orig.lotes.forEach(function (l, i) { if (l && loteSinNombre(l)) sinNom.push(nombreLote(l, i)); });
      if (sinNom.length) adv.push('SKU «' + pr.sku + '»: ' + sinNom.length + ' lote(s) sin nombre se llamaron ' + sinNom.join(', ') + ' (complete el nombre del lote).');
      orig.lotes.forEach(function (l, i) {
        if (!l) return;
        const cantL = typeof l.cantidad === 'number' && isFinite(l.cantidad) && l.cantidad >= 0 ? l.cantidad : null;
        if (cantL === null) { adv.push('SKU «' + pr.sku + '»: el lote «' + nombreLote(l, i) + '» no tiene una cantidad válida: se ignora.'); return; }
        let ven = null;
        if (l.vence !== null && l.vence !== undefined && l.vence !== '') {
          ven = parseFechaISO(String(l.vence));
          if (ven === null) adv.push('SKU «' + pr.sku + '»: el lote «' + nombreLote(l, i) + '» tiene una fecha de vencimiento inválida («' + l.vence + '», use AAAA-MM-DD): se trata como sin fecha.');
        }
        lotes.push({ lote: nombreLote(l, i), cantidad: cantL, vence: ven === null ? null : String(l.vence), venMs: ven, rest: cantL, i: i });
      });
      if (!lotes.length) return;
      const suma = lotes.reduce(function (s, l) { return s + l.cantidad; }, 0);
      if (Math.abs(suma - pr.cantidad) > 1e-6) adv.push('SKU «' + pr.sku + '»: los lotes suman ' + redondear(suma, 3) + ' y la cantidad del SKU es ' + redondear(pr.cantidad, 3) + ': no cuadran.');
      lotes.sort(function (a, b) {
        if (a.venMs === null && b.venMs !== null) return 1;
        if (a.venMs !== null && b.venMs === null) return -1;
        if (a.venMs !== b.venMs && a.venMs !== null) return a.venMs - b.venMs;
        return a.lote < b.lote ? -1 : a.lote > b.lote ? 1 : a.i - b.i;
      });
      const ps = porProd[p].slice().sort(function (x, y) {
        return E.pos[x].dDesp - E.pos[y].dDesp || E.pos[x].nivel - E.pos[y].nivel || (E.pos[x].id < E.pos[y].id ? -1 : E.pos[x].id > E.pos[y].id ? 1 : 0);
      });
      let li = 0;
      ps.forEach(function (j) {
        let capLeft = pr.upu * E.cap[j];
        const partes = [];
        while (capLeft > 1e-9 && li < lotes.length) {
          const l = lotes[li];
          if (l.rest <= 1e-9) { li++; continue; }
          const t = Math.min(capLeft, l.rest);
          partes.push({ lote: l.lote, cantidad: redondear(t, 6), vence: l.vence });
          l.rest -= t; capLeft -= t;
          if (l.rest <= 1e-9) li++;
        }
        if (!partes.length) return;
        const e = { lote: partes[0].lote, cantidad: partes[0].cantidad, vence: partes[0].vence };
        if (partes.length > 1) e.lotes = partes;
        fijarProp(lotePorPosicion, E.pos[j].id, e);
      });
      const sinPos = lotes.reduce(function (s, l) { return s + Math.max(0, l.rest); }, 0);
      if (sinPos > 1e-6) adv.push('SKU «' + pr.sku + '»: ' + redondear(sinPos, 3) + ' unidades de lotes no caben en las posiciones asignadas (revise cantidades o posiciones faltantes).');
      lotes.forEach(function (l) {
        if (l.venMs === null) return;
        hayVence = true;
        vencimientos.push({ sku: pr.sku, lote: l.lote, vence: l.vence, diasRestantes: refMs === null ? null : Math.round((l.venMs - refMs) / 86400000) });
      });
    });
    vencimientos.sort(function (a, b) { return (a.vence < b.vence ? -1 : a.vence > b.vence ? 1 : 0) || (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0) || (a.lote < b.lote ? -1 : a.lote > b.lote ? 1 : 0); });
    if (hayVence && refMs === null) adv.push('Hay lotes con fecha de vencimiento pero no se dio fechaReferencia (config.fechaReferencia u opciones.fechaReferencia): no se calcularon los días restantes. El motor no lee el reloj.');
    return { lotePorPosicion: lotePorPosicion, vencimientos: vencimientos };
  }

  /** Arma el objeto `resultado` (§5.5) a partir de un reparto. */
  function armarResultado(E, owner, base, t0, extra) {
    const ex = extra || {};
    const st = estadisticasReparto(E, owner);
    const sinUbicar = [];
    const asignaciones = [];
    const inc = crearIncompat(E);
    const mod = crearCargaModulo(E);
    for (let j = 0; j < E.nPos; j++) {
      if (owner[j] < 0) continue;
      inc.poner(owner[j], j);
      if (!esSecundaria(owner, j)) mod.poner(owner[j], j, cubDeReparto(E, owner, j));   // el peso de un tramo se reparte entre sus bahías
    }
    E.prods.forEach(function (pr, p) {
      if (pr.posReq <= 0) return;
      const ps = st.porProd[p].pos;
      const nTramos = ps.filter(function (j) { return owner.spanLen && owner.spanLen[j] >= 2; }).length;
      const asig = {
        sku: pr.sku, clase: pr.clase, posReq: pr.posReq,
        posiciones: ps.map(function (j) { return E.pos[j].id; }),
        costo: redondear(st.porProd[p].costo, 3),
        dDespMedia: st.porProd[p].nPrin ? redondear(st.porProd[p].dsum / st.porProd[p].nPrin, 2) : 0
      };
      if (nTramos > 0) asig.spans = nTramos;   // v1.2: nº de tramos de cantilever de k ≥ 2 bahías; `posiciones` incluye TODAS las bahías cubiertas
      asignaciones.push(asig);
      const faltan = pr.posReq - st.porProd[p].nPrin;   // un tramo de k bahías cuenta como UNA ubicación
      if (faltan > 0) {
        const bloq = inc.activo ? inc.bloqueados(p) : null;
        const m = ex.manual ? { motivo: 'sin_asignar', detalle: 'Faltan ' + faltan + ' posiciones por asignar a mano.' } : motivoFalta(E, p, owner, bloq, faltan, mod);
        sinUbicar.push({ sku: pr.sku, faltan: faltan, motivo: m.motivo, detalle: m.detalle });
      }
    });
    // SKU descartados por datos inválidos o duplicados: NO se ignoran en silencio
    let nInvalidos = 0;
    E.prods.forEach(function (pr) {
      if (!pr.invalido) return;
      nInvalidos++;
      sinUbicar.push({ sku: pr.sku, faltan: pr.faltaInv, motivo: pr.invalido.motivo, detalle: pr.invalido.detalle });
    });
    const porPosicion = {};
    for (let j = 0; j < E.nPos; j++) if (owner[j] >= 0) fijarProp(porPosicion, E.pos[j].id, E.prods[owner[j]].sku);
    // v1.2: tramos de cantilever: spanPorPosicion[id] = {principal, ids} para CADA posición cubierta (incluida la principal)
    const spanPorPosicion = {};
    if (owner.spanLen) {
      for (let j = 0; j < E.nPos; j++) {
        if (!(owner.spanLen[j] >= 2)) continue;
        const ids = cubDeReparto(E, owner, j).map(function (c) { return E.pos[c].id; });
        ids.forEach(function (id) { fijarProp(spanPorPosicion, id, { principal: ids[0], ids: ids.slice() }); });
      }
    }
    const rolPorPosicion = {};
    if (st.roles) for (let j = 0; j < E.nPos; j++) if (owner[j] >= 0 && st.roles.rol[j] > 0) fijarProp(rolPorPosicion, E.pos[j].id, st.roles.rol[j] === 1 ? 'picking' : 'reserva');
    const bOwner = base.owner, bst = base.st;
    const dm = function (wd, wp) { return wp > 0 ? redondear(wd / wp, 2) : 0; };
    const clsOut = {};
    ['A', 'B', 'C'].forEach(function (k) {
      const c = st.cls[k];
      clsOut[k] = { skus: c.skus, posiciones: c.posiciones, distMedia: c.wp > 0 ? redondear(c.wd / c.wp, 2) : c.np > 0 ? redondear(c.dsum / c.np, 2) : 0 };
    });
    // la mejora % solo es comparable si ambos repartos ubican exactamente los mismos SKU con el mismo número de posiciones
    const cntA = new Int32Array(E.nProd), cntB = new Int32Array(E.nProd);
    for (let j = 0; j < E.nPos; j++) { if (owner[j] >= 0 && !esSecundaria(owner, j)) cntA[owner[j]]++; if (bOwner[j] >= 0 && !esSecundaria(bOwner, j)) cntB[bOwner[j]]++; }
    let mismoConjunto = true;
    for (let p = 0; p < E.nProd; p++) if (cntA[p] !== cntB[p]) { mismoConjunto = false; break; }
    const mejora = mismoConjunto && bst.costo > 0 ? ((bst.costo - st.costo) / bst.costo) * 100 : null;
    const adv = E.advertencias.slice();
    if (ex.advertencias) ex.advertencias.forEach(function (a) { adv.push(a); });
    if (!mismoConjunto) adv.push('El reparto «sin criterio» (' + bst.ocupadas + ' posiciones) y el asignado (' + st.ocupadas + ') no ubican el mismo conjunto de SKU: no se calcula la mejora % de costo (mejoraPct = null); compare la distancia media ponderada con cautela.');
    if (sinUbicar.length) adv.push(sinUbicar.length + ' SKU no pudieron ubicarse del todo (ver detalle y motivo).');
    // lotes y vencimientos (no leen el reloj: los días restantes salen solo de la fecha de referencia dada)
    const lv = repartirLotes(E, owner, ex.productos || [], ex.fechaRef || null, adv);
    // afinidad por pedidos
    const dpa = distParesAfines(E, owner), dpb = E.afin ? distParesAfines(E, bOwner) : { pares: 0, dist: null };
    const roles = st.roles;
    const kpiRepo = {
      activa: E.repo, skusConPicking: roles ? roles.skusConPicking : 0,
      reposPorPeriodo: roles ? redondear(roles.reposTot, 3) : 0,
      distMediaReposicion: roles && roles.reposTot > 0 ? redondear(roles.reposDist / roles.reposTot, 2) : null,
      skusSinUnidadesPorLinea: roles ? roles.sinUpl : 0,
      // v1.2: la distancia reserva → picking es CAMINADA sobre la malla; si algún par no la tiene se usa la recta de respaldo
      metodoDistancia: !E.repo ? null : (roles && roles.nRespaldo > 0 ? 'mixta-con-respaldo-recta' : 'caminada'),
      paresRespaldoRecta: roles ? roles.nRespaldo : 0
    };
    if (E.repo && roles && roles.nRespaldo > 0) {
      const rs = roles.respaldo, partes = [];
      if (rs.sin_malla) partes.push(rs.sin_malla + ' sin malla del plano (posiciones externas)');
      if (rs.no_alcanzable) partes.push(rs.no_alcanzable + ' sin camino entre reserva y picking');
      if (rs.presupuesto) partes.push(rs.presupuesto + ' por exceder el presupuesto de cálculo de distancias caminadas');
      adv.push('Reposición: ' + roles.nRespaldo + ' posición(es) de reserva usaron la LÍNEA RECTA como respaldo de la distancia caminada (' + partes.join('; ') + '): distMediaReposicion es mixta.');
    }
    if (E.repo && roles && roles.sinUpl > 0) adv.push('[FALTA: unidades por línea de pedido] en ' + roles.sinUpl + ' SKU con reserva: se supone 1 unidad por línea para calcular las reposiciones.');
    return {
      // generadoEn = instante real de la corrida; con fecha de referencia dada NO se fabrica una hora: queda null y la fecha va aparte
      generadoEn: ex.fechaRef ? null : new Date().toISOString(),
      fechaReferencia: ex.fechaRef || null,
      asignaciones: asignaciones,
      porPosicion: porPosicion,
      spanPorPosicion: spanPorPosicion,
      rolPorPosicion: rolPorPosicion,
      lotePorPosicion: lv.lotePorPosicion,
      vencimientos: lv.vencimientos,
      sinUbicar: sinUbicar,
      kpis: {
        posicionesTotales: E.nPos, posicionesOcupadas: st.ocupadas,
        ocupacionPct: E.nPos > 0 ? redondear((100 * st.ocupadas) / E.nPos, 1) : 0,
        distMediaPonderada: dm(st.wdSum, st.wpSum), costoTotal: redondear(st.costo, 2),
        picksA_enNivel1Pct: redondear(st.a1Pct, 1), porClase: clsOut, skusInvalidos: nInvalidos,
        picksUbicados: redondear(st.wpSum, 3),
        skusCrossdock: E.nCross, flujoCrossdock: redondear(E.flujoCross, 3),
        dimensionadoPor: E.dimMax ? 'maximo' : 'actual',
        reposicion: kpiRepo,
        afinidad: { pares: dpa.pares, distMediaParesAltos: dpa.dist, distMediaParesAltosBaseline: dpb.dist, nPedidos: E.afin ? E.afin.nPedidos : 0 },
        tiempoMs: Math.round(ahoraMs() - t0)
      },
      baseline: {
        descripcion: 'Sin criterio: SKU en orden de ingreso sobre posiciones numeradas',
        costoTotal: redondear(bst.costo, 2), distMediaPonderada: dm(bst.wdSum, bst.wpSum),
        picksUbicados: redondear(bst.wpSum, 3), posicionesOcupadas: bst.ocupadas, mismoConjunto: mismoConjunto
      },
      mejoraPct: mejora === null ? null : redondear(mejora, 1),
      supuestos: supuestosSlotting(E.cfg, E),
      advertencias: adv
    };
  }

  /** Supuestos del slotting (se muestran en pantalla). */
  function supuestosSlotting(cfg, E) {
    const pr = cfg.pesoRecepcion;
    const efEnt = pr < 1 ? (cfg.factorEntradas * pr) / (1 - pr) : 0;
    const s = [
      'Unidades: distancias en metros, pesos en kg, alturas en m.',
      'Distancia = recorrido caminando sobre la malla del plano (rodeando racks, columnas y muros), no en línea recta; desde la puerta más cercana de cada tipo. La malla de 8 vecinos sobreestima las distancias hasta ~8 % en direcciones oblicuas (error de la grilla, no del plano).',
      'Costo de una posición = picks·(dDesp·(1−' + pr + ')·2 + penal. de nivel) + entradas·(dRec·' + pr + '·2 + penal. de nivel); ida y vuelta ×2. Si el SKU no trae `entradas`, se estiman como picks×' + cfg.factorEntradas + '.',
      'Peso efectivo de las entradas frente a los picks: ' + cfg.factorEntradas + ' × ' + pr + ' / (1 − ' + pr + ') = ' + redondear(efEnt, 2) + ' (por cada pick, las entradas pesan ~' + redondear(efEnt, 2) + ' en la decisión): la ubicación se decide casi solo por la distancia al despacho.',
      'Los picks y entradas de un SKU se reparten por igual entre las posiciones que ocupa.',
      '`cantidad` = stock actual por SKU: si la ubicación es fija (reserva para el máximo), use el stock máximo, no el de hoy. `picks` = líneas de pedido por periodo (defina el periodo; la estacionalidad no se modela).',
      'Cada pick se modela como un viaje de ida y vuelta (single-command): no se encadenan picks en una misma ruta.',
      'El «ahorro» / mejora compara contra ubicar SIN criterio (orden de ingreso), NO contra la situación actual del usuario: el ahorro real frente a su ubicación de hoy puede ser menor.',
      'Penalización por nivel en rack de palets: ' + cfg.penalNivelPalet + ' m equivalentes por nivel; es un tiempo de equipo (elevación/descenso) [VERIFICAR con la ficha del equipo: velocidades de elevación]. En bins, por altura de bandeja (zona dorada 0,75–1,50 m = 0; 0,30–0,75 y 1,50–1,80 = 3; < 0,30 = 5; > 1,80 = 8): penalizaciones 3/5/8 de calibración propia [PROPIO – ajustar con el responsable de ergonomía].',
      'Carga pesada: palet > ' + cfg.pesoPesadoKg + ' kg por ubicación, bin > ' + cfg.pesoPesadoBinKg + ' kg [PROPIO – ajustar]. Es RESTRICCIÓN: solo puede ir hasta el nivel ' + cfg.nivelMaxPesado + ' (palet) o ' + cfg.nivelMaxPesadoBin + ' (bin), independiente de los picks; además hay una penalización blanda de 4 m eq. por nivel.',
      'Restricciones duras: tipo de ubicación, carga máxima, altura de la carga (que incluye el palet; libre = paso − perfil de viga ' + cfg.perfilViga + ' m − holgura ' + cfg.holguraSobreCarga + ' m [VERIFICAR ficha del fabricante / EN 15620]), nivel máximo de cargas pesadas, zona requerida (y los demás SKU no entran en zonas frío/peligrosos/alto valor/cuarentena), accesibilidad e incompatibilidad de familias (no comparten rack ni quedan a menos de ' + cfg.separacionIncompatibles + ' m entre HUELLAS de rack; distancia [NO VERIFICADO; la fija la hoja de seguridad (HDS): VERIFICAR con seguridad-sst]).',
      'Cargas máximas por posición = valores por defecto del generador (palet 1000 kg, bin 50 kg): la real es la de la placa del fabricante del rack.',
      'NO se calculan: carga admisible del piso/losa, anclaje sísmico, estabilidad del rack ni resistencia de vigas [VERIFICAR con el ingeniero estructural].',
      'Holgura entre racks (flue) ' + cfg.flue + ' m [VERIFICAR NFPA 13 / ficha del fabricante]; holgura a rociadores ' + cfg.holguraRociadores + ' m (rociador «' + cfg.tipoRociador + '») [VERIFICAR con el ingeniero de protección contra incendios; NFPA 13 / RNE A.130]. La altura libre es hasta el obstáculo más bajo (tijeral, tubería, luminaria), no la altura al alero.',
      'Orden de colocación: primero SKU con zona obligatoria o carga pesada de nivel máximo 1, luego por densidad picks/posiciones (criterio COI); cada SKU forma un clúster compacto alrededor de su mejor posición.',
      'Es una HEURÍSTICA (constructiva + ' + cfg.pasadasMejora + ' pasadas de intercambios con tope de evaluaciones): no garantiza el óptimo.',
      'El «sin criterio» ubica los SKU en el orden de la lista sobre las posiciones numeradas (rack → módulo → nivel), respetando las mismas restricciones duras.',
      'Los anchos de pasillo son órdenes de magnitud [VERIFICAR con la ficha del equipo]: el pasillo real = ancho del equipo + largo del palet + holguras de maniobra (p. ej. VDMA 15173). Es una propuesta a validar con el responsable de almacén.'
    ];
    if (E) {
      if (E.dimMax) s.push('Dimensionado por stock MÁXIMO (config.dimensionarPor = «maximo»): posiciones = ⌈máx(stock actual, stockMax) / unidades por ubicación⌉; los picks siguen siendo los del periodo normal' + (E.usarPico ? ', salvo los SKU con `picksPico`, que usan el pico (opciones.usarPicksPico).' : ' (opciones.usarPicksPico = true usa `picksPico`).'));
      else if (E.usarPico) s.push('El costo usa los picks de TEMPORADA ALTA (`picksPico`) en los SKU que lo informan (opciones.usarPicksPico); el dimensionado sigue siendo por stock actual.');
      if (E.nCross > 0) s.push('Cross-docking: ' + E.nCross + ' SKU pasan por el muelle y NO ocupan posiciones de rack; su flujo (' + redondear(E.flujoCross, 2) + ' por periodo) se analiza aparte (muelle/staging), no entra al costo del slotting.');
      if (E.hayPeligro) s.push('Segregación por clase de peligro: dos SKU cuyas clases están en la matriz (por defecto SEGREGACION_DEFECTO) nunca comparten rack y quedan a la distancia mínima entre HUELLAS de rack de la matriz (si no trae distancia: ' + cfg.separacionIncompatibles + ' m). ' + SEGREGACION_REF);
      if (E.cap && E.prods.some(function (p) { return p.capMin > 1 && p.posReq > 0; })) s.push('Carriles de bloque (tipo piso): cada carril tiene profundidadPalets × apilado ubicaciones y lo ocupa UN solo SKU; posiciones = ⌈ubicaciones / capacidad del carril⌉ (con capacidades distintas se usa la menor, para no quedarse corto). Los carriles son LIFO: un SKU `fefo` no puede ir ahí. Estas posiciones no entran a la mejora local si cambian de capacidad.');
      if (E.pos.some(function (q) { return q.tipo === 'cantilever'; })) {
        s.push('Cantilever: la carga entra en una bahía si su largo (`largoM`) ≤ largo de la bahía (largo/módulos del rack). ' + (E.combinar
          ? 'Con `config.cantileverCombinar` activa (por defecto), una carga más larga ocupa k = ⌈largoM / ancho de bahía⌉ bahías contiguas del MISMO rack y nivel (módulos consecutivos, hasta el máximo de módulos del rack; solo racks con 1 posición por módulo), todas ocupadas por ese SKU; su peso por ubicación se reparte entre las k bahías y cada una debe soportar peso/k por brazo (y por módulo si se definió cargaMaxModuloKg) [VERIFICAR con la ficha del fabricante]. Distancia y costo se miden en el punto de acceso de la posición PRINCIPAL (la primera bahía del tramo); las demás bahías solo ocupan espacio. Los tramos no entran a la mejora local.'
          : 'La combinación de bahías contiguas está DESACTIVADA (`config.cantileverCombinar` = false): una carga más larga que la bahía queda sin ubicar. [VERIFICAR con la ficha del fabricante]'));
      }
      if (E.pos.some(function (q) { return q.tipo === 'piso' && (q.apilado || 1) > 1; })) s.push('Altura del apilado en piso: alto de la carga × apilado + holgura sobre la carga (' + cfg.holguraSobreCarga + ' m) × (apilado − 1) debe ser ≤ altura libre de la nave − holgura a rociadores (' + redondear(E.hMaxNave, 2) + ' m); restricción dura (motivo `altura_apilado`) solo para los SKU con `altoCargaM` [FALTA: altoCargaM en los demás: no se verifica y se avisa]. No se verifica la estabilidad de la carga ni la presión sobre la losa [VERIFICAR NFPA 13 / RNE A.130 y con el ingeniero estructural].');
      if (E.hayModCap) s.push('Carga por módulo: la suma del peso asignado a todas las posiciones de un módulo (rack + módulo, todos los niveles y slots) no puede superar su `cargaMaxModuloKg` (dato de la placa del fabricante). Peso de una posición = peso por ubicación × ubicaciones de la posición.');
      if (E.afin) s.push('Afinidad por co-ocurrencia en ' + E.afin.nPedidos + ' pedidos: los pares con lift > 1 se bonifican (peso configurable pesoAfinidad = ' + cfg.pesoAfinidad + ') cuando quedan a < ' + AFIN_RADIO_M + ' m; bonificación = pesoAfinidad × ' + AFIN_ESCALA_M + ' m × min(1, (lift − 1) / 2) [PROPIO – ajustar]. Es una guía de cercanía, no una restricción.' + (E.afin.nPedidos < 30 ? ' Muestra pequeña (< 30 pedidos) [VERIFICAR].' : ''));
      if (E.repo) s.push('Modo picking/reserva (config.reposicion.activa): para cada SKU con más de una posición, ' + cfg.reposicion.posicionesPicking + ' posición(es) de PICKING (la más cercana al despacho a nivel accesible) cargan los picks y la RESERVA carga las reposiciones: repos = picks × unidades por línea / unidades por ubicación (palets-equivalentes por periodo) con costo repos × (2 × distancia reserva→picking + penalización de nivel). La distancia reserva→picking es CAMINADA sobre la malla del plano (camino más corto entre los puntos de acceso de la reserva y del picking, rodeando racks y muros); si algún par no tiene camino (o no hay malla), se usa la línea recta como respaldo y se avisa (`kpis.reposicion.metodoDistancia`). Las entradas se reparten por igual entre todas las posiciones. Construcción en dos fases (primero picking, luego reserva) sin mejora local: es una heurística. Sin «unidades por línea» se supone 1 [FALTA: unidades por línea de pedido].');
      if (E.prods.some(function (p) { return p.fefo; })) s.push('FEFO: un SKU con `fefo` solo va en posiciones NO LIFO (sin profundidad ni apilado > 1); si tiene lotes, los que vencen antes van a las posiciones de menor distancia al despacho (salen primero).');
    }
    return s;
  }

  let cacheEntrada = null; // {clave, E, base}

  /** Clave de caché con todo lo que afecta a la entrada del slotting. */
  function claveEntrada(proyecto, opciones) {
    return JSON.stringify([
      claveGeometria(proyecto), proyecto.racks, proyecto.zonas, proyecto.config, proyecto.productos,
      proyecto.pedidos === undefined ? null : proyecto.pedidos, !!(opciones && opciones.usarPicksPico)
    ]);
  }

  /** Entrada preparada + baseline, con caché de la última (útil para evaluaciones manuales repetidas). */
  function entradaConBaseline(proyecto, opciones) {
    if (opciones && opciones.posiciones) {
      const E0 = prepararEntrada(proyecto, opciones);
      const o0 = repartoBaseline(E0);
      return { E: E0, base: { owner: o0, st: estadisticasReparto(E0, o0) } };
    }
    const clave = claveEntrada(proyecto, opciones);
    if (cacheEntrada && cacheEntrada.clave === clave) return cacheEntrada;
    const E = prepararEntrada(proyecto, opciones);
    const o = repartoBaseline(E);
    cacheEntrada = { clave: clave, E: E, base: { owner: o, st: estadisticasReparto(E, o) } };
    return cacheEntrada;
  }

  /** Fecha de referencia efectiva: opciones.fechaReferencia (si es válida) o config.fechaReferencia; null si no hay. NO lee el reloj. */
  function fechaRefEfectiva(op, cfg) {
    if (op && typeof op.fechaReferencia === 'string' && parseFechaISO(op.fechaReferencia) !== null) return op.fechaReferencia.trim();
    return cfg.fechaReferencia || null;
  }

  /**
   * Asigna ubicaciones a los productos (§5). Determinista (salvo tiempoMs, metadato del reloj; y generadoEn si no se da
   * fechaReferencia). No modifica el proyecto.
   * opciones: { semilla, pasadasMejora, soloSinUbicar:false, posiciones (avanzado: lista ya calculada), topeEvaluaciones,
   *             fechaReferencia ('YYYY-MM-DD'), usarPicksPico:false }
   */
  function asignar(proyecto, opciones) {
    const t0 = ahoraMs();
    const op = opciones || {};
    const ent = entradaConBaseline(proyecto, op);
    const E = ent.E;
    const owner = nuevoOwner(E);
    const extraAdv = [];
    if (op.soloSinUbicar && proyecto.resultado && proyecto.resultado.porPosicion) {
      const idPos = new Map();
      E.pos.forEach(function (q, j) { idPos.set(q.id, j); });
      const cuenta = new Int32Array(E.nProd);
      const pp = proyecto.resultado.porPosicion;
      const spR = proyecto.resultado.spanPorPosicion && typeof proyecto.resultado.spanPorPosicion === 'object' ? proyecto.resultado.spanPorPosicion : {};
      Object.keys(pp).forEach(function (id) {
        const j = idPos.get(id), p = E.porSku.get(String(pp[id]));
        if (j === undefined || p === undefined) return;
        if (!E.elig[p * E.nPos + j] || cuenta[p] >= E.prods[p].posReq) return;
        const k = kTramo(E, p, j);
        if (k >= 2) {
          // un tramo previo solo se conserva entero (misma principal y mismas bahías) y si sus bahías siguen libres
          const t = Object.prototype.hasOwnProperty.call(spR, id) ? spR[id] : null;
          const cub = cubiertasDe(E, j, k);
          if (!t || t.principal !== id || !Array.isArray(t.ids) || !cub || t.ids.length !== k) return;
          if (!cub.every(function (c, i) { return E.pos[c].id === t.ids[i] && owner[c] < 0; })) return;
          ocuparCub(owner, p, cub); cuenta[p]++;
          return;
        }
        if (owner[j] >= 0) return;
        owner[j] = p; cuenta[p]++;
      });
      extraAdv.push('Modo «solo sin ubicar»: se conservaron las ubicaciones previas válidas y solo se colocaron los faltantes (sin mejora local).');
    }
    const inc = crearIncompat(E);
    const mod = crearCargaModulo(E);
    cargarEstado(E, owner, inc, mod);
    const afs = crearAfinSku(E);
    const pasadas = op.pasadasMejora !== undefined ? Math.max(0, Math.floor(op.pasadasMejora)) : Math.max(0, Math.floor(E.cfg.pasadasMejora));
    if (E.repo && !op.soloSinUbicar) {
      construirReposicion(E, owner, inc, mod);
      if (pasadas > 0) extraAdv.push('Modo picking/reserva: la mejora local por intercambios no se aplica (se construye picking primero y reserva después).');
    } else {
      construirAsignacion(E, owner, inc, mod, afs);
      if (!op.soloSinUbicar && pasadas > 0) {
        const tope = num(op.topeEvaluaciones, TOPE_EVALUACIONES);
        const ml = mejoraLocal(E, owner, inc, pasadas, op.semilla === undefined ? 1 : op.semilla, tope, mod, afs);
        if (ml.cortado) extraAdv.push('La mejora local se detuvo al llegar al presupuesto de ' + Math.round(tope / 1e6) + ' millones de evaluaciones (para acotar el tiempo con muchos SKU/posiciones): la distribución es buena pero puede mejorar (opciones.topeEvaluaciones).');
      }
    }
    return armarResultado(E, owner, ent.base, t0, { advertencias: extraAdv, productos: proyecto.productos, fechaRef: fechaRefEfectiva(op, E.cfg) });
  }

  /**
   * KPIs de un reparto dado a mano (mapa posiciónId → SKU), con las mismas fórmulas que `asignar`.
   * Avisa si el reparto rompe alguna restricción dura.
   */
  function evaluarAsignacionManual(proyecto, mapaPosicionASku, opciones) {
    const t0 = ahoraMs();
    const op = opciones || {};
    const ent = entradaConBaseline(proyecto, op);
    const E = ent.E;
    const owner = nuevoOwner(E);
    const idPos = new Map();
    E.pos.forEach(function (q, j) { idPos.set(q.id, j); });
    const adv = [];
    const mapa = mapaPosicionASku || {};
    Object.keys(mapa).forEach(function (id) {
      const j = idPos.get(id), p = E.porSku.get(String(mapa[id]));
      if (j === undefined) { adv.push('La posición «' + id + '» no existe.'); return; }
      if (p === undefined) { adv.push('El SKU «' + mapa[id] + '» no existe o no es válido (posición ' + id + ').'); return; }
      owner[j] = p;
    });
    // v1.2: tramos de cantilever. Un SKU cuya carga necesita k ≥ 2 bahías en la posición j (principal) las ocupa todas: si el reparto
    // dado trae la principal y las contiguas, se agrupan; si faltan y están libres, se completan (y se avisa); si no se puede, se avisa.
    if (E.spanK) {
      for (let j = 0; j < E.nPos; j++) {
        const p = owner[j];
        if (p < 0 || enTramo(owner, j) || !E.elig[p * E.nPos + j]) continue;
        const k = kTramo(E, p, j);
        if (k < 2) continue;
        const cub = cubiertasDe(E, j, k);
        const sec = cub ? cub.slice(1) : [];
        const choca = !cub || sec.some(function (c) { return (owner[c] >= 0 && owner[c] !== p) || enTramo(owner, c); });
        if (choca) { adv.push('SKU «' + E.prods[p].sku + '» en ' + E.pos[j].id + ': su carga de ' + E.prods[p].largo + ' m necesita ' + k + ' bahías contiguas del mismo rack y nivel y no están libres.'); continue; }
        const faltantes = sec.filter(function (c) { return owner[c] < 0; });
        faltantes.forEach(function (c) { owner[c] = p; });
        ocuparCub(owner, p, cub);
        if (faltantes.length) adv.push('SKU «' + E.prods[p].sku + '» en ' + E.pos[j].id + ': su carga necesita ' + k + ' bahías contiguas; se completó el tramo con ' + faltantes.map(function (c) { return E.pos[c].id; }).join(', ') + '.');
      }
    }
    const inc = crearIncompat(E);
    const mod = crearCargaModulo(E);
    cargarEstado(E, owner, inc, mod);
    const unid = new Int32Array(E.nProd);
    for (let j = 0; j < E.nPos; j++) if (owner[j] >= 0 && !esSecundaria(owner, j)) unid[owner[j]]++;
    for (let j = 0; j < E.nPos; j++) {
      const p = owner[j];
      if (p < 0 || esSecundaria(owner, j)) continue;   // las secundarias de un tramo se validan con su principal
      const pr = E.prods[p], q = E.pos[j];
      if (!E.elig[p * E.nPos + j]) {
        let por = 'restricción dura';
        if (q.tipo !== pr.tipo) por = 'tipo de ubicación (' + q.tipo + ' ≠ ' + pr.tipo + ')';
        else if (pr.pesoUbic / kPorLargo(E, pr, q) > q.cargaMaxKg + 1e-9) por = 'peso (' + redondear(pr.pesoUbic / kPorLargo(E, pr, q), 1) + (kPorLargo(E, pr, q) > 1 ? ' kg por bahía' : ' kg') + ' > ' + q.cargaMaxKg + ' kg)';
        else if (pr.alto > (q.alturaLibreM === undefined ? Infinity : q.alturaLibreM) + 1e-9) por = 'altura de la carga';
        else if (pr.pesado && q.nivel > pr.nivelMax) por = 'nivel máximo para cargas pesadas (nivel ' + q.nivel + ' > ' + pr.nivelMax + ')';
        else if (pr.zona ? q.zonaTipo !== pr.zona : ZONAS_RESTRINGIDAS.indexOf(q.zonaTipo) >= 0) por = 'zona (' + q.zonaTipo + ')';
        else if (q.tipo === 'cantilever' && (pr.largo === null || pr.largo > (q.anchoBahiaM === undefined || q.anchoBahiaM === null ? Infinity : q.anchoBahiaM) + 1e-9)) por = pr.largo === null ? 'falta el largo de la carga (largoM) para cantilever' : (E.combinar ? 'largo de la carga (' + pr.largo + ' m): no hay bahías contiguas suficientes que cumplan peso, altura, zona y accesibilidad desde esa posición' : 'largo de la carga (' + pr.largo + ' m) mayor que la bahía de cantilever (la combinación de bahías está desactivada)');
        else if ((q.apilado || 1) > pr.apilableMax) por = 'apilado (' + (q.apilado || 1) + ' > apilableMax ' + pr.apilableMax + ')';
        else if (q.tipo === 'piso' && pr.altoDado && alturaApilado(pr.alto, q.apilado || 1, E.cfg.holguraSobreCarga) > E.hMaxNave + 1e-9) por = 'altura del apilado (' + (q.apilado || 1) + ' × ' + redondear(pr.alto, 2) + ' m + holgura = ' + redondear(alturaApilado(pr.alto, q.apilado || 1, E.cfg.holguraSobreCarga), 2) + ' m > ' + redondear(E.hMaxNave, 2) + ' m de altura libre menos holgura a rociadores) [motivo altura_apilado]';
        else if (pr.fefo && q.lifo === true) por = 'FEFO en una ubicación LIFO';
        else if (!q.accesible) por = 'posición inaccesible';
        adv.push('SKU «' + pr.sku + '» en ' + q.id + ' incumple: ' + por + '.');
      } else if (inc.activo) {
        inc.quitar(p, j);
        if (!inc.ok(p, E.rackIdx[j])) adv.push('SKU «' + pr.sku + '» en ' + q.id + ' está demasiado cerca de una familia o clase de peligro incompatible (o en el mismo rack).');
        inc.poner(p, j);
      }
    }
    if (mod.activo) {
      const visto = new Set();
      for (let j = 0; j < E.nPos; j++) {
        if (owner[j] < 0) continue;
        const m = E.modIdx[j];
        if (visto.has(m)) continue;
        visto.add(m);
        if (mod.carga(m) > E.modLim[m] + 1e-9) adv.push('Carga por módulo excedida en ' + E.pos[j].rackNombre + ' módulo ' + E.pos[j].modulo + ': ' + redondear(mod.carga(m), 1) + ' kg > ' + redondear(E.modLim[m], 1) + ' kg.');
      }
    }
    E.prods.forEach(function (pr, p) {
      if (pr.posReq > 0 && unid[p] > pr.posReq) adv.push('SKU «' + pr.sku + '» tiene ' + unid[p] + ' posiciones y solo necesita ' + pr.posReq + '.');
    });
    return armarResultado(E, owner, ent.base, t0, { manual: true, advertencias: adv, productos: proyecto.productos, fechaRef: fechaRefEfectiva(op, E.cfg) });
  }

  /* ======================================================================
   * 8. VALIDACIÓN DEL PROYECTO
   * ==================================================================== */

  /** Parámetro t (>0) donde el rayo O + t·D corta al segmento AB; Infinity si no lo corta. */
  function tRayoSegmento(ox, oy, dx, dy, ax, ay, bx, by) {
    const ex = bx - ax, ey = by - ay;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) return Infinity;
    const wx = ax - ox, wy = ay - oy;
    const t = (wx * ey - wy * ex) / den;
    const u = (wx * dy - wy * dx) / den;
    return t >= 1e-9 && u >= -1e-9 && u <= 1 + 1e-9 ? t : Infinity;
  }

  /**
   * Ancho libre delante de cada módulo de un rack (hasta el siguiente rack, muro, columna u hueco), medido con
   * un rayo perpendicular a la cara de acceso. Devuelve {min, modulosAngostos} para el rack `i`.
   */
  function anchoLibreFrenteRack(racks, polis, bbs, bordes, i, tope) {
    const r = racks[i];
    const mods = Math.min(MAX_MODULOS_RACK, Math.max(1, r.modulos | 0));
    const a = ((r.ang || 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const sgn = r.frente === 'B' ? 1 : -1;
    const dx = -sgn * s, dy = sgn * c;
    const modLen = r.largo / mods;
    let min = Infinity;
    const anchos = [];
    for (let m = 1; m <= mods; m++) {
      const xm = -r.largo / 2 + (m - 0.5) * modLen;
      const ox = r.cx + xm * c - (sgn * r.fondo / 2) * s, oy = r.cy + xm * s + (sgn * r.fondo / 2) * c;
      const ex = ox + dx * tope, ey = oy + dy * tope;
      const x1 = Math.min(ox, ex) - 0.01, x2 = Math.max(ox, ex) + 0.01, y1 = Math.min(oy, ey) - 0.01, y2 = Math.max(oy, ey) + 0.01;
      let t = tope;
      for (let j = 0; j < racks.length && t > 0; j++) {
        if (j === i || !polis[j]) continue;
        const bb = bbs[j];
        if (bb.maxX < x1 || bb.minX > x2 || bb.maxY < y1 || bb.minY > y2) continue;
        if (puntoEnPoligono([ox + dx * 1e-4, oy + dy * 1e-4], polis[j])) { t = 0; break; }
        const P = polis[j];
        for (let k = 0; k < P.length; k++) {
          const q = P[k], w = P[(k + 1) % P.length];
          const tt = tRayoSegmento(ox, oy, dx, dy, q[0], q[1], w[0], w[1]);
          if (tt < t) t = tt;
        }
      }
      for (let k = 0; k < bordes.length && t > 0; k++) {
        const e = bordes[k];
        const tt = tRayoSegmento(ox, oy, dx, dy, e[0], e[1], e[2], e[3]);
        if (tt < t) t = tt;
      }
      anchos.push(t);
      if (t < min) min = t;
    }
    return { min: min, anchos: anchos };
  }

  /**
   * Revisa el proyecto y devuelve una lista de {nivel:'error'|'aviso'|'info', codigo, mensaje}.
   * opciones.sinAccesibilidad = true omite el cálculo de accesibilidad (más rápido para validar «en vivo»).
   */
  function validarProyecto(proyecto, opciones) {
    const op = opciones || {};
    const out = [];
    function add(nivel, codigo, mensaje) { out.push({ nivel: nivel, codigo: codigo, mensaje: mensaje }); }
    if (!proyecto) { add('error', 'PROYECTO_VACIO', 'No hay proyecto.'); return out; }
    const cfg = configCompleta(proyecto);
    const contorno = proyecto.contorno || [];
    const contornoOk = Array.isArray(contorno) && contorno.length >= 3 && areaPoligono(contorno) > 1e-9;
    if (!contornoOk) add('error', 'CONTORNO_INVALIDO', 'El contorno necesita al menos 3 puntos y un área mayor que 0.');
    else {
      for (let i = 0; i < contorno.length; i++) {
        let cruza = false;
        for (let j = i + 2; j < contorno.length; j++) {
          if (i === 0 && j === contorno.length - 1) continue;
          if (segmentosSeCruzan(contorno[i], contorno[(i + 1) % contorno.length], contorno[j], contorno[(j + 1) % contorno.length])) { cruza = true; break; }
        }
        if (cruza) { add('aviso', 'CONTORNO_AUTOINTERSECTA', 'Los bordes del contorno se cruzan entre sí: revise los vértices.'); break; }
      }
    }
    if (!(cfg.celdaM > 0) || !(cfg.anchoPasillo > 0)) add('error', 'CONFIG_INVALIDA', 'La celda de la malla y el ancho de pasillo deben ser mayores que 0.');
    if (proyecto.plano && proyecto.plano.imagen && !proyecto.plano.mPorPx) add('info', 'SIN_ESCALA', 'El plano no está calibrado a escala (m por píxel).');
    const puertas = proyecto.puertas || [];
    if (!puertas.length) add('error', 'SIN_PUERTAS', 'No hay puertas: se necesitan para medir recorridos (agregue una de recepción, despacho o mixta).');
    puertas.forEach(function (pt) {
      if (contornoOk && !puntoEnPoligono([pt.x, pt.y], contorno)) {
        let dmin = Infinity;
        for (let i = 0; i < contorno.length; i++) {
          const a = contorno[i], b = contorno[(i + 1) % contorno.length];
          dmin = Math.min(dmin, distPuntoSegmento(pt.x, pt.y, a[0], a[1], b[0], b[1]));
        }
        if (dmin > 1) add('aviso', 'PUERTA_FUERA', 'La puerta «' + (pt.nombre || pt.id) + '» está a ' + redondear(dmin, 1) + ' m fuera del contorno.');
      }
    });
    // racks
    const racks = proyecto.racks || [];
    const huecos = (proyecto.huecos || []).filter(function (h) { return h.poly && h.poly.length >= 3; });
    const nombres = Object.create(null), ids = Object.create(null);
    const polis = racks.map(function (r) { return poligonoRack(r); });
    const alturaMax = cfg.alturaLibreNave - cfg.holguraRociadores;
    racks.forEach(function (r, i) {
      const nom = r.nombre || r.id || ('rack ' + (i + 1));
      if (!(r.largo > 0) || !(r.fondo > 0) || !(r.modulos >= 1) || !(r.niveles >= 1) || !(r.slotsPorModulo >= 1)) {
        add('error', 'RACK_INVALIDO', 'El rack «' + nom + '» tiene medidas, módulos, niveles o slots inválidos.');
        return;
      }
      if (r.id !== undefined) { if (ids[r.id]) add('error', 'RACK_ID_DUPLICADO', 'El id de rack «' + r.id + '» está repetido.'); ids[r.id] = true; }
      if (r.nombre !== undefined) { if (nombres[r.nombre]) add('error', 'RACK_NOMBRE_DUPLICADO', 'El nombre de rack «' + r.nombre + '» está repetido: los códigos de ubicación se repetirían.'); nombres[r.nombre] = true; }
      if (contornoOk && !poligonoContenido(polis[i], contorno)) add('error', 'RACK_FUERA_CONTORNO', 'El rack «' + nom + '» sale del contorno de la nave.');
      for (let h = 0; h < huecos.length; h++) {
        if (poligonosSolapan(polis[i], huecos[h].poly)) { add('error', 'RACK_HUECO', 'El rack «' + nom + '» se solapa con un obstáculo (' + (huecos[h].tipo || 'hueco') + ').'); break; }
      }
      const alto = num(r.altoBase, 0.15) + r.niveles * num(r.altoNivel, 1.6);
      if (r.tipo !== 'bin' && alto > alturaMax + 1e-9) add('aviso', 'RACK_ALTURA', 'El rack «' + nom + '» llega a ' + redondear(alto, 2) + ' m y la altura útil bajo rociadores es ' + redondear(alturaMax, 2) + ' m [VERIFICAR norma].');
    });
    racks.forEach(function (r, i) {
      if ((r.niveles | 0) > MAX_NIVELES || (r.slotsPorModulo | 0) > MAX_SLOTS || (r.modulos | 0) > MAX_MODULOS_RACK) {
        add('aviso', 'RACK_FUERA_DE_RANGO', 'El rack «' + (r.nombre || r.id || ('rack ' + (i + 1))) + '» excede los topes (módulos ≤ ' + MAX_MODULOS_RACK + ', niveles ≤ ' + MAX_NIVELES + ', posiciones por módulo ≤ ' + MAX_SLOTS + '): el motor lo recorta.');
      }
    });
    // v1.2: altura del apilado en racks de piso con la carga más alta de los SKU de tipo piso
    const prodsPiso = (proyecto.productos || []).filter(function (q) { return q && q.crossdock !== true && (q.tipoUbic || 'palet') === 'piso'; });
    const altoPisoMax = prodsPiso.reduce(function (m, q) { return typeof q.altoCargaM === 'number' && isFinite(q.altoCargaM) && q.altoCargaM > m ? q.altoCargaM : m; }, 0);
    const pisoSinAlto = prodsPiso.filter(function (q) { return !(typeof q.altoCargaM === 'number' && isFinite(q.altoCargaM) && q.altoCargaM > 0); }).length;
    racks.forEach(function (r, i) {
      if ((r.tipo || 'palet') !== 'piso' || !(r.largo > 0)) return;
      const a = Math.max(1, Math.min(MAX_APILADO, Math.floor(num(r.apilado, 1))));
      const nom = r.nombre || r.id || ('rack ' + (i + 1));
      if (altoPisoMax > 0) {
        const h = alturaApilado(altoPisoMax, a, cfg.holguraSobreCarga);
        if (h > alturaMax + 1e-9) add('aviso', 'PISO_APILADO_ALTURA', 'El rack de piso «' + nom + '» apila ' + a + ' y la carga más alta de los SKU de piso mide ' + altoPisoMax + ' m: ' + a + ' × ' + altoPisoMax + ' + ' + cfg.holguraSobreCarga + ' × ' + (a - 1) + ' = ' + redondear(h, 2) + ' m, más que la altura útil bajo rociadores (' + redondear(alturaMax, 2) + ' m): ese SKU no podrá ubicarse allí [VERIFICAR norma].');
      }
      if (a > 1 && pisoSinAlto > 0) add('info', 'PISO_SIN_ALTO_CARGA', 'El rack de piso «' + nom + '» apila ' + a + ' y ' + pisoSinAlto + ' SKU de piso no traen altoCargaM [FALTA: altoCargaM]: no se puede verificar la altura del apilado.');
    });
    // v1.2: el cantilever más largo (rack completo y bahía) frente al largo de las cargas
    const racksCant = racks.filter(function (r) { return r && r.tipo === 'cantilever' && r.largo > 0 && r.modulos >= 1; });
    const maxLargoCant = racksCant.reduce(function (m, r) { return Math.max(m, r.largo); }, 0);
    const maxBahiaCant = racksCant.reduce(function (m, r) { return Math.max(m, r.largo / Math.min(MAX_MODULOS_RACK, Math.max(1, r.modulos | 0))); }, 0);
    if (contornoOk) {
      const bbC = bboxPoligono(contorno);
      if (bbC.ancho > 300 || bbC.alto > 300) add('aviso', 'ESCALA_SOSPECHOSA', 'El contorno mide ' + redondear(bbC.ancho, 0) + ' × ' + redondear(bbC.alto, 0) + ' m (más de 300 × 300 m): probablemente la calibración de escala está mal.');
    }
    // ancho libre delante de cada rack (pasillo real) frente al ancho de pasillo configurado
    if (contornoOk && racks.length && racks.length <= 3000 && cfg.anchoPasillo > 0) {
      // v1.1: el ancho de pasillo y el equipo son los PROPIOS de cada rack (override > equipo del rack > config)
      const bbs = polis.map(function (p) { return p && p.length ? bboxPoligono(p) : { minX: 0, maxX: 0, minY: 0, maxY: 0 }; });
      const bordes = [];
      const anadir = function (poly) { for (let k = 0; k < poly.length; k++) { const q = poly[k], w = poly[(k + 1) % poly.length]; bordes.push([q[0], q[1], w[0], w[1]]); } };
      anadir(contorno);
      huecos.forEach(function (h) { anadir(h.poly); });
      racks.forEach(function (r, i) {
        if (!(r.largo > 0) || !(r.fondo > 0) || !(r.modulos >= 1)) return;
        const apR = anchoPasilloDeRack(r, cfg), eqR = equipoDeRack(r, cfg);
        const res = anchoLibreFrenteRack(racks, polis, bbs, bordes, i, apR + 0.2);
        if (res.min < apR - 0.05) {
          const nAng = res.anchos.filter(function (t) { return t < apR - 0.05; }).length;
          add('aviso', 'PASILLO_ANGOSTO', 'Delante del rack «' + (r.nombre || r.id || ('rack ' + (i + 1))) + '» quedan solo ' + redondear(res.min, 2) + ' m libres (' + nAng + ' de ' + res.anchos.length + ' módulos) y el ancho de pasillo configurado es ' + redondear(apR, 2) + ' m (equipo «' + eqR + '»): el equipo podría no maniobrar. [VERIFICAR con la ficha del equipo]');
        }
      });
    }
    // v1.1: carga por módulo según el diseño (Σ carga máx. de las posiciones del módulo > cargaMaxModuloKg del fabricante)
    racks.forEach(function (r, i) {
      if (!(typeof r.cargaMaxModuloKg === 'number' && r.cargaMaxModuloKg > 0) || !(r.largo > 0) || !(r.modulos >= 1) || !(r.niveles >= 1) || !(r.slotsPorModulo >= 1)) return;
      const capU = (r.tipo || 'palet') === 'piso' ? Math.max(1, Math.floor(num(r.profundidadPalets, 1))) * Math.max(1, Math.floor(num(r.apilado, 1))) : 1;
      const sumaPos = num(r.cargaMaxKg, 1000) * capU * Math.min(MAX_NIVELES, r.niveles | 0) * Math.min(MAX_SLOTS, r.slotsPorModulo | 0);
      if (sumaPos > r.cargaMaxModuloKg + 1e-9) add('aviso', 'CARGA_MODULO_EXCEDIDA', 'El rack «' + (r.nombre || r.id || ('rack ' + (i + 1))) + '»: la suma de la carga máxima de las posiciones de un módulo (' + redondear(sumaPos, 0) + ' kg) supera la capacidad del módulo (' + redondear(r.cargaMaxModuloKg, 0) + ' kg). Si se llenaran todas con la carga máxima se excedería: el programa limitará la asignación al peso real de los SKU.');
    });
    // v1.1: zonas de almacenaje, muelle, salidas de emergencia
    const zonasV = (proyecto.zonas || []).filter(function (z) { return z && Array.isArray(z.poly) && z.poly.length >= 3; });
    zonasV.forEach(function (z) {
      if (z.tipo === 'almacenaje' && !(z.cfg && typeof z.cfg === 'object')) add('aviso', 'ZONA_ALMACENAJE_SIN_CFG', 'La zona de almacenaje «' + (z.nombre || z.id) + '» no tiene configuración propia (equipo, pasillo, tipo…): se generará con los parámetros globales.');
      if (z.tipo === 'muelle' || z.tipo === 'staging') {
        const cerca = puertas.some(function (pt) {
          if (!puertaValida(pt) || pt.tipo === 'salida_emergencia') return false;
          if (puntoEnPoligono([pt.x, pt.y], z.poly)) return true;
          for (let i = 0; i < z.poly.length; i++) {
            const a = z.poly[i], b = z.poly[(i + 1) % z.poly.length];
            if (distPuntoSegmento(pt.x, pt.y, a[0], a[1], b[0], b[1]) <= 3) return true;
          }
          return false;
        });
        if (!cerca) add('aviso', 'MUELLE_SIN_PUERTA', 'La zona «' + (z.nombre || z.id) + '» (' + z.tipo + ') no tiene ninguna puerta de recepción/despacho a 3 m o menos [PROPIO – ajustar]: revise que el muelle dé a una puerta.');
      }
    });
    if (puertas.length && !puertas.some(function (pt) { return pt.tipo === 'salida_emergencia'; })) add('info', 'SIN_SALIDA_EMERGENCIA', 'No hay ninguna puerta marcada como salida de emergencia: el análisis de evacuación usará todas las puertas. Marque las salidas reales [VERIFICAR RNE A.130 / ITSE].');
    for (let i = 0; i < racks.length; i++) {
      for (let j = i + 1; j < racks.length; j++) {
        if (poligonosSolapan(polis[i], polis[j])) add('error', 'RACK_SOLAPE', 'Los racks «' + (racks[i].nombre || racks[i].id) + '» y «' + (racks[j].nombre || racks[j].id) + '» se solapan.');
      }
    }
    // productos
    const productos = proyecto.productos || [];
    if (!racks.length && productos.length) add('aviso', 'SIN_RACKS', 'Hay productos pero no hay racks: genere o dibuje racks antes de asignar.');
    if (racks.length && !productos.length) add('info', 'SIN_PRODUCTOS', 'No hay productos cargados.');
    let pos = null;
    if (contornoOk && puertas.length && racks.length && !op.sinAccesibilidad) {
      pos = calcularDistanciasPosiciones(proyecto).posiciones;
      const inacc = pos.filter(function (p) { return !p.accesible; }).length;
      if (inacc) add('aviso', 'POSICIONES_INACCESIBLES', inacc + ' de ' + pos.length + ' posiciones no son accesibles desde las puertas (no recibirán productos).');
    }
    if (!pos && racks.length) pos = posicionesDeRacks(proyecto).map(function (p) { p.accesible = true; return p; });
    const vistos = Object.create(null);
    const posReqPorTipo = Object.create(null);
    const disponPorTipo = Object.create(null);
    (pos || []).forEach(function (p) { if (p.accesible !== false) disponPorTipo[p.tipo] = (disponPorTipo[p.tipo] || 0) + 1; });
    const capMinTipo = Object.create(null);   // capacidad (ubicaciones) de la ubicación más chica de cada tipo: dimensiona de forma conservadora
    (pos || []).forEach(function (p) { const c = Math.max(1, (p.capacidadUb | 0) || 1); if (capMinTipo[p.tipo] === undefined || c < capMinTipo[p.tipo]) capMinTipo[p.tipo] = c; });
    const familias = Object.create(null);
    productos.forEach(function (p) { familias[String(p.familia === undefined || p.familia === null ? '' : p.familia)] = true; });
    productos.forEach(function (p, i) {
      const sku = p.sku === undefined || p.sku === null ? '' : String(p.sku).trim();
      const nom = sku || ('fila ' + (i + 1));
      if (!sku) { add('error', 'SKU_VACIO', 'El producto de la fila ' + (i + 1) + ' no tiene SKU.'); return; }
      if (vistos[sku]) add('error', 'SKU_DUPLICADO', 'El SKU «' + sku + '» está repetido.');
      vistos[sku] = true;
      // v1.1: lotes, cross-docking
      if (Array.isArray(p.lotes) && p.lotes.length) {
        let sumaL = 0, ok = true;
        p.lotes.forEach(function (l, li) {
          if (l && loteSinNombre(l)) add('aviso', 'LOTE_SIN_NOMBRE', 'El SKU «' + nom + '» tiene un lote sin nombre: se llamará «' + nombreLote(l, li) + '».');
          if (!l || typeof l.cantidad !== 'number' || !isFinite(l.cantidad) || l.cantidad < 0) ok = false; else sumaL += l.cantidad;
          if (l && l.vence !== null && l.vence !== undefined && l.vence !== '' && parseFechaISO(String(l.vence)) === null) add('aviso', 'LOTE_FECHA_INVALIDA', 'El SKU «' + nom + '» tiene el lote «' + nombreLote(l, li) + '» con fecha de vencimiento inválida («' + l.vence + '», use AAAA-MM-DD).');
        });
        if (!ok) add('aviso', 'LOTES_NO_CUADRAN', 'El SKU «' + nom + '» tiene lotes con cantidad inválida.');
        else if (Math.abs(sumaL - Math.max(0, num(p.cantidad, 0))) > 1e-6) add('aviso', 'LOTES_NO_CUADRAN', 'El SKU «' + nom + '»: los lotes suman ' + redondear(sumaL, 3) + ' y la cantidad es ' + redondear(num(p.cantidad, 0), 3) + ': no cuadran.');
      }
      if (p.crossdock === true) {
        if (p.flujoCrossdock === null || p.flujoCrossdock === undefined) add('info', 'CROSSDOCK_SIN_FLUJO', 'El SKU «' + nom + '» es cross-docking pero no tiene `flujoCrossdock` (palets por periodo): el análisis del muelle no podrá cuantificarlo.');
        return;   // no ocupa rack: no se validan unidades ni tipo
      }
      if (!(num(p.unidadesPorUbic, 0) > 0)) { add('error', 'UNIDADES_INVALIDAS', 'El SKU «' + nom + '» tiene unidades por ubicación ≤ 0.'); return; }
      if (num(p.cantidad, 0) < 0 || num(p.picks, 0) < 0) add('error', 'VALOR_NEGATIVO', 'El SKU «' + nom + '» tiene cantidad o picks negativos.');
      const tipo = p.tipoUbic || 'palet';
      if (tipo === 'cantilever' && !(typeof p.largoM === 'number' && isFinite(p.largoM) && p.largoM > 0)) add('aviso', 'CANTILEVER_SIN_LARGO', 'El SKU «' + nom + '» va en cantilever pero no tiene el largo de la carga (`largoM`): no podrá ubicarse.');
      else if (tipo === 'cantilever' && racksCant.length) {
        if (p.largoM > maxLargoCant + 1e-9) add('aviso', 'CANTILEVER_LARGO_EXCEDE_RACK', 'El SKU «' + nom + '» mide ' + p.largoM + ' m de largo y el rack de cantilever más largo mide ' + redondear(maxLargoCant, 2) + ' m en total: no cabe ni combinando bahías contiguas.');
        else if (cfg.cantileverCombinar === false && p.largoM > maxBahiaCant + 1e-9) add('aviso', 'CANTILEVER_LARGO_EXCEDE_BAHIA', 'El SKU «' + nom + '» mide ' + p.largoM + ' m de largo y la bahía de cantilever más larga mide ' + redondear(maxBahiaCant, 2) + ' m, con la combinación de bahías contiguas desactivada (config.cantileverCombinar = false): no podrá ubicarse.');
      }
      const cantDimV = (cfg.dimensionarPor === 'maximo' && typeof p.stockMax === 'number' && isFinite(p.stockMax) && p.stockMax > num(p.cantidad, 0)) ? p.stockMax : Math.max(0, num(p.cantidad, 0));
      const posReq = Math.ceil(cantDimV / p.unidadesPorUbic / (capMinTipo[tipo] || 1) - 1e-9);
      posReqPorTipo[tipo] = (posReqPorTipo[tipo] || 0) + posReq;
      const delTipo = (pos || []).filter(function (q) { return q.tipo === tipo; });
      if (racks.length && !delTipo.length) { add('error', 'TIPO_SIN_RACK', 'El SKU «' + nom + '» pide ubicación «' + tipo + '» y no hay racks de ese tipo.'); return; }
      if (p.fefo === true && delTipo.length && !delTipo.some(function (q) { return q.lifo !== true; })) add('aviso', 'FEFO_EN_LIFO', 'El SKU «' + nom + '» sale por vencimiento (FEFO) pero todas las posiciones de tipo «' + tipo + '» son LIFO (carriles profundos o apilados): no podrá ubicarse.');
      if (delTipo.length) {
        const pesoUbic = p.unidadesPorUbic * Math.max(0, num(p.pesoUnitKg, 0));
        if (!delTipo.some(function (q) { return pesoUbic <= q.cargaMaxKg + 1e-9; })) add('aviso', 'PESO_EXCEDE', 'El SKU «' + nom + '» pesa ' + redondear(pesoUbic, 1) + ' kg por ubicación y ninguna posición lo soporta.');
        const pesadoV = pesoUbic > (tipo === 'bin' ? cfg.pesoPesadoBinKg : cfg.pesoPesadoKg);
        const nivMaxV = tipo === 'bin' ? cfg.nivelMaxPesadoBin : cfg.nivelMaxPesado;
        if (pesadoV && !delTipo.some(function (q) { return q.nivel <= nivMaxV; })) add('aviso', 'PESADO_SIN_NIVEL_BAJO', 'El SKU «' + nom + '» es pesado (' + redondear(pesoUbic, 1) + ' kg por ubicación) y solo puede ir hasta el nivel ' + nivMaxV + ': no hay posiciones así.');
        if (!delTipo.some(function (q) { return num(p.altoCargaM, 0) <= (q.alturaLibreM === undefined ? Infinity : q.alturaLibreM) + 1e-9; })) add('aviso', 'ALTURA_EXCEDE', 'El SKU «' + nom + '» mide ' + p.altoCargaM + ' m de alto y ninguna posición lo admite.');
        if (p.requiereZona && !delTipo.some(function (q) { return q.zonaTipo === p.requiereZona; })) add('aviso', 'ZONA_SIN_POSICIONES', 'El SKU «' + nom + '» requiere zona «' + p.requiereZona + '» y no hay posiciones de «' + tipo + '» dentro de una.');
      }
      (p.incompatibleCon || []).forEach(function (f) {
        if (!familias[String(f)]) add('info', 'INCOMPATIBLE_SIN_FAMILIA', 'El SKU «' + nom + '» declara incompatible la familia «' + f + '», que no existe entre los productos.');
      });
    });
    Object.keys(posReqPorTipo).forEach(function (t) {
      const disp = disponPorTipo[t] || 0;
      if (racks.length && posReqPorTipo[t] > disp) add('aviso', 'CAPACIDAD_INSUFICIENTE', 'Los SKU de tipo «' + t + '» necesitan ' + posReqPorTipo[t] + ' posiciones y hay ' + disp + ' accesibles.');
    });
    return out;
  }

  /* ======================================================================
   * 9. CSV (productos y ubicaciones)
   * ==================================================================== */

  const COLUMNAS_PRODUCTO = ['sku', 'descripcion', 'familia', 'cantidad', 'unidades_por_ubicacion', 'picks', 'entradas',
    'peso_unit_kg', 'alto_carga_m', 'tipo_ubicacion', 'requiere_zona', 'incompatible_con',
    // v1.1 (opcionales)
    'stock_max', 'picks_pico', 'unidades_por_linea', 'peligro', 'fefo', 'crossdock', 'flujo_crossdock', 'largo_m', 'apilable_max', 'lotes'];

  const ALIAS_COLUMNAS = {
    sku: ['sku', 'codigo', 'cod', 'articulo', 'item'],
    descripcion: ['descripcion', 'desc', 'nombre', 'detalle'],
    familia: ['familia', 'categoria', 'grupo'],
    cantidad: ['cantidad', 'stock', 'qty', 'existencia'],
    unidades_por_ubicacion: ['unidades_por_ubicacion', 'unidades_por_ubic', 'unid_por_ubicacion', 'unidades_ubicacion', 'unidades_x_ubicacion'],
    picks: ['picks', 'rotacion', 'lineas', 'salidas'],
    entradas: ['entradas', 'ingresos'],
    peso_unit_kg: ['peso_unit_kg', 'peso_unitario_kg', 'peso_kg', 'peso'],
    alto_carga_m: ['alto_carga_m', 'alto_carga', 'alto_m', 'alto'],
    tipo_ubicacion: ['tipo_ubicacion', 'tipo_ubic', 'tipo'],
    requiere_zona: ['requiere_zona', 'zona', 'zona_requerida'],
    incompatible_con: ['incompatible_con', 'incompatibles', 'incompatible'],
    stock_max: ['stock_max', 'stock_maximo', 'stockmax', 'maximo'],
    picks_pico: ['picks_pico', 'picks_temporada_alta', 'picks_max', 'pico'],
    unidades_por_linea: ['unidades_por_linea', 'unid_por_linea', 'unidades_linea', 'unidades_x_linea'],
    peligro: ['peligro', 'clase_peligro', 'clase_de_peligro'],
    fefo: ['fefo', 'sale_por_vencimiento'],
    crossdock: ['crossdock', 'cross_docking', 'cross_dock'],
    flujo_crossdock: ['flujo_crossdock', 'flujo_cross_dock', 'flujo_cross_docking'],
    largo_m: ['largo_m', 'largo_carga_m', 'largo_carga', 'largo'],
    apilable_max: ['apilable_max', 'apilable', 'apilado_max'],
    lotes: ['lotes', 'lote_cantidad_vence']
  };

  /** Normaliza un encabezado: minúsculas, sin tildes, solo [a-z0-9_]. */
  function normalizarEncabezado(s) {
    let t = String(s === undefined || s === null ? '' : s).replace(/^﻿/, '').trim().toLowerCase();
    if (t.normalize) t = t.normalize('NFD').replace(/[̀-ͯ]/g, '');
    t = t.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return t;
  }

  /** Detecta el separador (; , tab) mirando la primera línea no vacía fuera de comillas. */
  function detectarSeparador(texto) {
    const lineas = texto.split(/\r?\n/);
    let linea = '';
    for (let i = 0; i < lineas.length; i++) if (lineas[i].trim()) { linea = lineas[i]; break; }
    const cnt = { ';': 0, ',': 0, '\t': 0 };
    let q = false;
    for (let i = 0; i < linea.length; i++) {
      const ch = linea[i];
      if (ch === '"') q = !q;
      else if (!q && cnt[ch] !== undefined) cnt[ch]++;
    }
    if (cnt[';'] >= cnt[','] && cnt[';'] >= cnt['\t'] && cnt[';'] > 0) return ';';
    if (cnt['\t'] > cnt[','] && cnt['\t'] > 0) return '\t';
    return ',';
  }

  /** Divide el texto en registros respetando comillas. Devuelve [{linea, campos}]. */
  function dividirCSV(texto, sep) {
    const regs = [];
    let campos = [], campo = '', q = false, linea = 1, lineaIni = 1;
    let hayContenido = false;
    for (let i = 0; i < texto.length; i++) {
      const ch = texto[i];
      if (q) {
        if (ch === '"') {
          if (texto[i + 1] === '"') { campo += '"'; i++; } else q = false;
        } else { campo += ch; if (ch === '\n') linea++; }
        continue;
      }
      if (ch === '"') { q = true; hayContenido = true; }
      else if (ch === sep) { campos.push(campo); campo = ''; hayContenido = true; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && texto[i + 1] === '\n') i++;
        campos.push(campo);
        if (hayContenido || campos.length > 1 || campos[0] !== '') regs.push({ linea: lineaIni, campos: campos });
        campos = []; campo = ''; hayContenido = false;
        linea++; lineaIni = linea;
      } else { campo += ch; hayContenido = true; }
    }
    campos.push(campo);
    if (hayContenido || campos.length > 1 || campos[0] !== '') regs.push({ linea: lineaIni, campos: campos, sinCerrar: q });
    return regs;
  }

  /**
   * ¿«1,500» / «1.500»? Un solo separador seguido de exactamente 3 dígitos es ambiguo: puede ser miles
   * (1 500) o decimal (1,5). En Perú la coma suele ser separador de miles.
   */
  function esNumeroAmbiguo(s) {
    return /^[+-]?\d{1,3}[.,]\d{3}$/.test(String(s === undefined || s === null ? '' : s).trim().replace(/\s+/g, ''));
  }

  /** Número con coma o punto decimal. '' → null; inválido → NaN. */
  function parseNumeroFlexible(s) {
    if (s === undefined || s === null) return null;
    let t = String(s).trim().replace(/\s+/g, '');
    if (t === '') return null;
    const c = t.lastIndexOf(','), p = t.lastIndexOf('.');
    if (c >= 0 && p >= 0) {
      if (c > p) t = t.replace(/\./g, '').replace(',', '.');
      else t = t.replace(/,/g, '');
    } else if (c >= 0) {
      t = t.replace(',', '.');
    } else if ((t.match(/\./g) || []).length > 1) {
      t = t.replace(/\./g, '');
    }
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return NaN;
    return Number(t);
  }

  /** Normaliza un tipo de ubicación. */
  function normalizarTipoUbic(s) {
    const t = normalizarEncabezado(s);
    if (t === '' ) return 'palet';
    if (t === 'palet' || t === 'pallet' || t === 'paleta' || t === 'palete') return 'palet';
    if (t === 'bin' || t === 'caja' || t === 'estante' || t === 'bandeja') return 'bin';
    if (t === 'piso' || t === 'suelo' || t === 'carril') return 'piso';
    if (t === 'cantilever' || t === 'voladizo' || t === 'brazo' || t === 'brazos') return 'cantilever';
    return null;
  }

  /** Clase de peligro desde texto del usuario. '' → null (válido); desconocida → undefined. */
  function normalizarPeligro(s) {
    const t = normalizarEncabezado(s);
    if (t === '' || t === 'ninguno' || t === 'ninguna' || t === 'no') return null;
    if (CLASES_PELIGRO.indexOf(t) >= 0) return t;
    const al = { corrosivo_base: ['corrosivo_basico', 'base', 'alcalino', 'corrosivo_alcalino'], corrosivo_acido: ['acido', 'corrosivo'], bateria_litio: ['litio', 'bateria', 'baterias', 'baterias_litio'], inflamable: ['inflamables'], oxidante: ['oxidantes', 'comburente'], toxico: ['toxicos', 'veneno'], alimento: ['alimentos', 'comestible'] };
    for (const k in al) if (al[k].indexOf(t) >= 0) return k;
    return undefined;
  }

  /** Booleano flexible (si/sí/true/1/x → true; no/false/0/vacío → false); otro → undefined. */
  function parseBool(s) {
    const t = normalizarEncabezado(s);
    if (t === '' || t === 'no' || t === 'false' || t === '0' || t === 'falso' || t === 'n') return false;
    if (t === 'si' || t === 'true' || t === '1' || t === 'x' || t === 'verdadero' || t === 's') return true;
    return undefined;
  }

  /** Normaliza la zona requerida. '' → null (válido); desconocida → undefined. */
  function normalizarZona(s) {
    const t = normalizarEncabezado(s);
    if (t === '' || t === 'ninguna' || t === 'no' || t === 'general') return null;
    if (t === 'frio' || t === 'refrigerado' || t === 'cadena_de_frio') return 'frio';
    if (t === 'peligrosos' || t === 'peligroso' || t === 'mercancia_peligrosa') return 'peligrosos';
    if (t === 'alto_valor' || t === 'altovalor' || t === 'valor') return 'alto_valor';
    if (t === 'cuarentena') return 'cuarentena';
    return undefined;
  }

  /**
   * Lee un CSV de productos (separador , ; o tab autodetectado; decimales con coma o punto).
   * Si faltan columnas opcionales se usan valores por defecto: unidades_por_ubicacion=1, cantidad=0,
   * picks=0, peso=0, alto_carga=1,2 m (palet/piso) o 0,3 m (bin), tipo=palet.
   */
  function parseCSVProductos(texto) {
    const errores = [];
    const advertencias = [];
    const productos = [];
    let t = String(texto === undefined || texto === null ? '' : texto).replace(/^﻿/, '');
    if (!t.trim()) { errores.push({ linea: 1, mensaje: 'El archivo está vacío.' }); return { productos: productos, errores: errores, advertencias: advertencias }; }
    const sep = detectarSeparador(t);
    const regs = dividirCSV(t, sep);
    if (!regs.length) { errores.push({ linea: 1, mensaje: 'El archivo está vacío.' }); return { productos: productos, errores: errores, advertencias: advertencias }; }
    const cab = regs[0].campos.map(normalizarEncabezado);
    const col = {};
    Object.keys(ALIAS_COLUMNAS).forEach(function (k) {
      for (let i = 0; i < cab.length; i++) {
        if (ALIAS_COLUMNAS[k].indexOf(cab[i]) >= 0 && col[k] === undefined) { col[k] = i; break; }
      }
    });
    if (col.sku === undefined) { errores.push({ linea: regs[0].linea, mensaje: 'Falta la columna «sku» en el encabezado.' }); return { productos: productos, errores: errores, advertencias: advertencias }; }
    const get = function (campos, k) { return col[k] === undefined ? undefined : campos[col[k]]; };
    for (let r = 1; r < regs.length; r++) {
      const campos = regs[r].campos, linea = regs[r].linea;
      if (regs[r].sinCerrar) {
        errores.push({ linea: linea, mensaje: 'Comilla («"») sin cerrar desde esta línea: el resto del archivo se leería como un solo campo. Cierre la comilla o duplique las comillas internas ("") y vuelva a cargar.' });
        break;
      }
      if (campos.every(function (c) { return String(c).trim() === ''; })) continue;
      const falla = function (msg) { errores.push({ linea: linea, mensaje: msg }); };
      const avisa = function (msg) { advertencias.push({ linea: linea, mensaje: msg }); };
      // filas con más o menos columnas que el encabezado: se perdería un dato en silencio
      if (campos.length < cab.length) avisa('La fila tiene ' + campos.length + ' columna(s) y el encabezado ' + cab.length + ': faltan datos (¿separador decimal igual al de columnas, o una celda sin separar?). Los campos faltantes toman su valor por defecto.');
      else if (campos.length > cab.length && campos.slice(cab.length).some(function (c) { return String(c).trim() !== ''; })) avisa('La fila tiene ' + campos.length + ' columnas y el encabezado ' + cab.length + ': sobran datos que se ignoran (¿una coma decimal con separador coma? use «;» o comillas).');
      const sku = quitarPrefijoFormula(String(get(campos, 'sku') === undefined ? '' : get(campos, 'sku'))).trim();
      if (!sku) { falla('Falta el SKU.'); continue; }
      let malo = false;
      const ENTEROS = { cantidad: true, picks: true, entradas: true, unidades_por_ubicacion: true };
      const numero = function (k, def, nombre, nulo) {
        const crudo = get(campos, k);
        let v = parseNumeroFlexible(crudo);
        if (v === null) return nulo ? null : def;
        if (Number.isNaN(v)) { falla('SKU «' + sku + '»: «' + crudo + '» no es un número válido en «' + nombre + '».'); malo = true; return def; }
        if (esNumeroAmbiguo(crudo)) {
          const txt = String(crudo).trim();
          if (ENTEROS[k]) {
            // convención es-PE: en un campo entero, «1.000» / «1,500» = mil / mil quinientos
            v = Number(txt.replace(/[.,]/, ''));
            avisa('SKU «' + sku + '»: «' + txt + '» en «' + nombre + '» (campo entero) se leyó como MILES = ' + v + ' (convención es-PE). Si era un decimal (' + txt.replace(/[.,]/, ',') + '), corrija el valor en el archivo.');
          } else {
            avisa('SKU «' + sku + '»: «' + txt + '» en «' + nombre + '» (campo decimal) se leyó como decimal = ' + String(v).replace('.', ',') + '. Si era 1 000 o más (miles), corrija el valor.');
          }
        }
        if ((k === 'cantidad' || k === 'picks' || k === 'entradas') && Math.abs(v - Math.round(v)) > 1e-9) {
          avisa('SKU «' + sku + '»: «' + nombre + '» = ' + String(v).replace('.', ',') + ' no es un número entero (revise decimales o separador de miles).');
        }
        return v;
      };
      const tipo = normalizarTipoUbic(get(campos, 'tipo_ubicacion'));
      if (tipo === null) { falla('SKU «' + sku + '»: tipo de ubicación «' + get(campos, 'tipo_ubicacion') + '» desconocido (use palet, bin, piso o cantilever).'); continue; }
      const zona = normalizarZona(get(campos, 'requiere_zona'));
      if (zona === undefined) { falla('SKU «' + sku + '»: zona «' + get(campos, 'requiere_zona') + '» desconocida (frio, peligrosos, alto_valor, cuarentena).'); continue; }
      const cantidad = numero('cantidad', 0, 'cantidad');
      const upu = numero('unidades_por_ubicacion', 1, 'unidades_por_ubicacion');
      const picks = numero('picks', 0, 'picks');
      const entradas = numero('entradas', null, 'entradas', true);
      const peso = numero('peso_unit_kg', 0, 'peso_unit_kg');
      const alto = numero('alto_carga_m', tipo === 'bin' ? 0.3 : 1.2, 'alto_carga_m');
      // ---- columnas opcionales v1.1: solo se agregan al producto si la columna existe en el archivo ----
      const nuevos = {};
      const tieneV11 = ['stock_max', 'picks_pico', 'unidades_por_linea', 'peligro', 'fefo', 'crossdock', 'flujo_crossdock', 'largo_m', 'apilable_max', 'lotes'].some(function (k) { return col[k] !== undefined; });
      if (tieneV11) {
        const sm = numero('stock_max', null, 'stock_max', true);
        const pp = numero('picks_pico', null, 'picks_pico', true);
        const ul = numero('unidades_por_linea', null, 'unidades_por_linea', true);
        const fc = numero('flujo_crossdock', null, 'flujo_crossdock', true);
        const lg = numero('largo_m', null, 'largo_m', true);
        const ap = numero('apilable_max', 1, 'apilable_max');
        const pel = normalizarPeligro(get(campos, 'peligro') === undefined ? '' : get(campos, 'peligro'));
        const fe = parseBool(get(campos, 'fefo') === undefined ? '' : get(campos, 'fefo'));
        const cd = parseBool(get(campos, 'crossdock') === undefined ? '' : get(campos, 'crossdock'));
        if (!malo && pel === undefined) { falla('SKU «' + sku + '»: clase de peligro «' + get(campos, 'peligro') + '» desconocida (' + CLASES_PELIGRO.join(', ') + ').'); malo = true; }
        if (!malo && fe === undefined) { falla('SKU «' + sku + '»: «fefo» debe ser sí/no.'); malo = true; }
        if (!malo && cd === undefined) { falla('SKU «' + sku + '»: «crossdock» debe ser sí/no.'); malo = true; }
        if (!malo && (sm !== null && sm < 0 || pp !== null && pp < 0 || ul !== null && !(ul > 0) || fc !== null && fc < 0 || lg !== null && !(lg > 0) || !(ap >= 1))) { falla('SKU «' + sku + '»: stock_max, picks_pico, flujo_crossdock o largo_m inválidos (negativos o cero), unidades_por_linea ≤ 0 o apilable_max < 1.'); malo = true; }
        // lotes: L1:480:2027-03-31|L2:120:
        const lotes = [];
        const lotesTxt = String(get(campos, 'lotes') === undefined ? '' : get(campos, 'lotes')).trim();
        if (!malo && lotesTxt) {
          lotesTxt.split('|').forEach(function (parte) {
            if (malo || !parte.trim()) return;
            const q = parte.split(':').map(function (x) { return quitarPrefijoFormula(x).trim(); });
            if (q.length < 2 || q.length > 3 || !q[0]) { falla('SKU «' + sku + '»: lote «' + parte + '» mal formado (use LOTE:cantidad:AAAA-MM-DD).'); malo = true; return; }
            let cL = parseNumeroFlexible(q[1]);
            if (cL === null || Number.isNaN(cL) || cL < 0) { falla('SKU «' + sku + '»: la cantidad del lote «' + q[0] + '» («' + q[1] + '») no es un número válido.'); malo = true; return; }
            if (esNumeroAmbiguo(q[1])) { cL = Number(q[1].replace(/[.,]/, '')); avisa('SKU «' + sku + '»: cantidad de lote «' + q[1] + '» se leyó como MILES = ' + cL + ' (convención es-PE).'); }
            let ven = null;
            if (q.length === 3 && q[2] !== '') {
              if (parseFechaISO(q[2]) === null) { falla('SKU «' + sku + '»: el vencimiento del lote «' + q[0] + '» («' + q[2] + '») no es una fecha AAAA-MM-DD válida.'); malo = true; return; }
              ven = q[2];
            }
            lotes.push({ lote: q[0], cantidad: cL, vence: ven });
          });
          if (!malo) {
            const suma = lotes.reduce(function (s, l) { return s + l.cantidad; }, 0);
            if (Math.abs(suma - cantidad) > 1e-6) avisa('SKU «' + sku + '»: los lotes suman ' + String(redondear(suma, 6)).replace('.', ',') + ' y la cantidad es ' + String(redondear(cantidad, 6)).replace('.', ',') + ': no cuadran.');
          }
        }
        Object.assign(nuevos, { stockMax: sm, picksPico: pp, unidadesPorLinea: ul, peligro: pel === undefined ? null : pel, fefo: fe === true, lotes: lotes, crossdock: cd === true, flujoCrossdock: fc, largoM: lg, apilableMax: ap >= 1 ? Math.floor(ap) : 1 });
      }
      if (malo) continue;
      if (!(upu > 0)) { falla('SKU «' + sku + '»: unidades por ubicación debe ser mayor que 0.'); continue; }
      if (cantidad < 0 || picks < 0 || (entradas !== null && entradas < 0) || peso < 0 || alto < 0) { falla('SKU «' + sku + '»: hay valores negativos.'); continue; }
      const inc = String(get(campos, 'incompatible_con') === undefined ? '' : get(campos, 'incompatible_con'))
        .split('|').map(function (s) { return quitarPrefijoFormula(s).trim(); }).filter(function (s) { return s; });
      productos.push({
        sku: sku, descripcion: quitarPrefijoFormula(String(get(campos, 'descripcion') === undefined ? '' : get(campos, 'descripcion'))).trim(),
        familia: quitarPrefijoFormula(String(get(campos, 'familia') === undefined ? '' : get(campos, 'familia'))).trim(),
        cantidad: cantidad, unidadesPorUbic: upu, picks: picks, entradas: entradas,
        pesoUnitKg: peso, altoCargaM: alto, tipoUbic: tipo, requiereZona: zona, incompatibleCon: inc
      });
      if (tieneV11) Object.assign(productos[productos.length - 1], nuevos);
    }
    return { productos: productos, errores: errores, advertencias: advertencias };
  }

  /** Quita el apóstrofo de protección que `campoCSV` antepone a textos que parecen fórmulas. */
  function quitarPrefijoFormula(s) {
    return /^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s;
  }

  /**
   * Escapa un campo CSV de TEXTO para el separador `;`. Contra la inyección de fórmulas en Excel/Calc, un
   * texto que empieza con = + - @ tab o CR se antepone con «'» (el lector lo quita al volver a cargar).
   * Los números van por `numCSV`, no por aquí (un -5 legítimo no se toca).
   */
  function campoCSV(v) {
    let s = v === undefined || v === null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    if (/[;"\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /** Número con coma decimal (apto para Excel en español). */
  function numCSV(v) {
    if (v === null || v === undefined || v === '' || (typeof v === 'number' && !isFinite(v))) return '';
    return String(redondear(Number(v), 6)).replace('.', ',');
  }

  const BOM = '﻿';

  /** CSV de productos (separador ;, decimales con coma, con BOM UTF-8 para Excel). */
  function productosACSV(productos) {
    const filas = [COLUMNAS_PRODUCTO.join(';')];
    (productos || []).forEach(function (p) {
      filas.push([
        campoCSV(p.sku), campoCSV(p.descripcion), campoCSV(p.familia), numCSV(p.cantidad), numCSV(p.unidadesPorUbic),
        numCSV(p.picks), numCSV(p.entradas), numCSV(p.pesoUnitKg), numCSV(p.altoCargaM), campoCSV(p.tipoUbic || 'palet'),
        campoCSV(p.requiereZona || ''), campoCSV((p.incompatibleCon || []).join('|')),
        numCSV(p.stockMax), numCSV(p.picksPico), numCSV(p.unidadesPorLinea), campoCSV(p.peligro || ''),
        p.fefo === true ? 'sí' : 'no', p.crossdock === true ? 'sí' : 'no', numCSV(p.flujoCrossdock), numCSV(p.largoM),
        numCSV(p.apilableMax === undefined || p.apilableMax === null ? 1 : p.apilableMax),
        campoCSV((Array.isArray(p.lotes) ? p.lotes : []).filter(function (l) { return l; }).map(function (l, li) {
          return nombreLote(l, li).replace(/[:|]/g, '_') + ':' + numCSV(l.cantidad) + ':' + (l.vence || '');
        }).join('|'))
      ].join(';'));
    });
    return BOM + filas.join('\r\n') + '\r\n';
  }

  /** Plantilla de CSV de productos con dos filas de ejemplo rotuladas. */
  function plantillaCSVProductos() {
    return productosACSV([
      { sku: 'SKU-001', descripcion: 'EJEMPLO – editar: producto de alta rotación', familia: 'Abarrotes', cantidad: 480, unidadesPorUbic: 48, picks: 320, entradas: null, pesoUnitKg: 12.5, altoCargaM: 1.2, tipoUbic: 'palet', requiereZona: null, incompatibleCon: [] },
      { sku: 'SKU-002', descripcion: 'EJEMPLO – editar: producto en frío', familia: 'Lácteos', cantidad: 120, unidadesPorUbic: 40, picks: 45, entradas: 20, pesoUnitKg: 1.1, altoCargaM: 1.0, tipoUbic: 'palet', requiereZona: 'frio', incompatibleCon: ['Químicos'] }
    ]);
  }

  /** CSV de ubicaciones ocupadas, más resumen de no ubicados. Separador ;, decimales con coma. */
  function ubicacionesACSV(proyecto) {
    const res = proyecto.resultado;
    const filas = ['ubicacion;rack;nivel;sku;descripcion;clase_abc;cantidad_en_ubicacion;d_despacho_m;d_recepcion_m;rol;lote;vence'];
    if (!res || !res.porPosicion) {
      filas.push('"(sin asignación: pulse «Asignar ubicaciones» primero)";;;;;;;;;;;');
      return BOM + filas.join('\r\n') + '\r\n';
    }
    const dist = calcularDistanciasPosiciones(proyecto).posiciones;
    const prodPorSku = Object.create(null);
    (proyecto.productos || []).forEach(function (p) { if (!prodPorSku[p.sku]) prodPorSku[p.sku] = p; });
    const clasePorSku = Object.create(null);
    (res.asignaciones || []).forEach(function (a) { clasePorSku[a.sku] = a.clase; });
    // cantidad por ubicación: posiciones llenas con unidadesPorUbic, la última con el resto
    const restante = Object.create(null);
    (proyecto.productos || []).forEach(function (p) { if (restante[p.sku] === undefined) restante[p.sku] = Math.max(0, num(p.cantidad, 0)); });
    dist.forEach(function (q) {
      const sku = res.porPosicion[q.id];
      if (sku === undefined) return;
      const p = prodPorSku[sku] || {};
      const upu = num(p.unidadesPorUbic, 0);
      const capPos = upu * Math.max(1, (q.capacidadUb | 0) || 1);   // un carril de piso guarda profundidad × apilado ubicaciones
      let cant = upu > 0 ? Math.min(capPos, restante[sku] === undefined ? capPos : restante[sku]) : 0;
      if (restante[sku] !== undefined) restante[sku] = Math.max(0, restante[sku] - cant);
      const lp = res.lotePorPosicion && res.lotePorPosicion[q.id];
      let loteTxt = '', venceTxt = '';
      if (lp) {
        const partes = Array.isArray(lp.lotes) && lp.lotes.length ? lp.lotes : [lp];
        loteTxt = partes.map(function (l) { return l.lote; }).join('|');
        const fechas = partes.map(function (l) { return l.vence; }).filter(function (v) { return v; }).sort();
        venceTxt = fechas.length ? fechas[0] : '';
        if (typeof lp.cantidad === 'number') cant = partes.reduce(function (s, l) { return s + l.cantidad; }, 0);
      }
      filas.push([
        campoCSV(q.id), campoCSV(q.rackNombre), q.nivel, campoCSV(sku), campoCSV(p.descripcion || ''), campoCSV(clasePorSku[sku] || ''),
        numCSV(cant), numCSV(redondear(q.dDesp, 2)), numCSV(redondear(q.dRec, 2)),
        campoCSV((res.rolPorPosicion && res.rolPorPosicion[q.id]) || ''), campoCSV(loteTxt), campoCSV(venceTxt)
      ].join(';'));
    });
    if ((res.sinUbicar || []).length) {
      filas.push('');
      filas.push('NO UBICADOS;;;;;;;;;;;');
      filas.push('sku;faltan_posiciones;motivo;detalle');
      res.sinUbicar.forEach(function (s) { filas.push([campoCSV(s.sku), s.faltan, campoCSV(s.motivo), campoCSV(s.detalle || '')].join(';')); });
    }
    return BOM + filas.join('\r\n') + '\r\n';
  }

  /* ======================================================================
   * 10. EJEMPLO DETERMINISTA
   * ==================================================================== */

  /**
   * Proyecto de ejemplo completo y determinista (PRNG con semilla fija): nave en L de unos 40 × 28 m,
   * 2 puertas, columnas, una oficina, 2 zonas, racks automáticos y 45 SKU con rotación tipo Pareto.
   * Todo está rotulado «EJEMPLO – editar»: son datos ilustrativos, no de un cliente.
   */
  function ejemplo() {
    const p = crearProyectoEnL(40, 28, 18, 15);
    p.nombre = 'EJEMPLO – editar: nave en L de 40 × 28 m';
    p.config = configPorDefecto('apilador');
    p.config.alturaLibreNave = 10.5;
    p.puertas = [
      { id: 'P1', nombre: 'EJEMPLO – editar: recepción', tipo: 'recepcion', x: 6, y: 28 },
      { id: 'P2', nombre: 'EJEMPLO – editar: despacho', tipo: 'despacho', x: 40, y: 21 },
      // v1.1: salidas de emergencia (solo para evacuación; no son punto de partida de picks)
      { id: 'P3', nombre: 'EJEMPLO – editar: salida de emergencia oeste', tipo: 'salida_emergencia', x: 0, y: 14 },
      { id: 'P4', nombre: 'EJEMPLO – editar: salida de emergencia norte', tipo: 'salida_emergencia', x: 28, y: 13 }
    ];
    p.config.fechaReferencia = '2026-11-07';          // fecha fija del ejemplo (el motor no lee el reloj)
    p.config.diasAlertaVencimiento = 30;              // EJEMPLO – editar
    p.config.muelle = { palletsDiaRecepcion: 24, palletsDiaDespacho: 30, diasPermanenciaRec: 1, diasPermanenciaDesp: 1, m2PorPalet: null, factorManiobra: null };   // EJEMPLO – editar
    const cols = [[9, 9.5], [9, 21], [25, 21], [31, 21]];
    p.huecos = cols.map(function (c, i) {
      return { id: 'H' + (i + 1), tipo: 'columna', poly: [[c[0] - 0.2, c[1] - 0.2], [c[0] + 0.2, c[1] - 0.2], [c[0] + 0.2, c[1] + 0.2], [c[0] - 0.2, c[1] + 0.2]] };
    });
    p.huecos.push({ id: 'H5', tipo: 'oficina', poly: [[35, 13.4], [39.8, 13.4], [39.8, 17.2], [35, 17.2]] });
    p.zonas = [
      { id: 'Z1', nombre: 'EJEMPLO – editar: zona de frío', tipo: 'frio', poly: [[0.5, 0.5], [9.5, 0.5], [9.5, 6.5], [0.5, 6.5]] },
      { id: 'Z2', nombre: 'EJEMPLO – editar: zona de peligrosos', tipo: 'peligrosos', poly: [[22, 22.5], [32, 22.5], [32, 27.6], [22, 27.6]] },
      // v1.1: muelle y staging (piso libre), y dos zonas de almacenaje con su propia configuración
      { id: 'Z3', nombre: 'EJEMPLO – editar: muelle de recepción', tipo: 'muelle', poly: [[2, 24.2], [10.5, 24.2], [10.5, 27.8], [2, 27.8]] },
      { id: 'Z4', nombre: 'EJEMPLO – editar: staging de despacho', tipo: 'staging', poly: [[36, 18.4], [39.8, 18.4], [39.8, 23.8], [36, 23.8]] },
      { id: 'Z5', nombre: 'EJEMPLO – editar: estantería de cajas (bins)', tipo: 'almacenaje', poly: [[10.6, 0.6], [17.4, 0.6], [17.4, 5.6], [10.6, 5.6]], cfg: { tipo: 'bin', equipo: 'manual', niveles: 5 } },
      { id: 'Z6', nombre: 'EJEMPLO – editar: bloque de piso (carriles)', tipo: 'almacenaje', poly: [[10.5, 6], [17.6, 6], [17.6, 13], [10.5, 13]], cfg: { tipo: 'piso', equipo: 'apilador', profundidadPalets: 3, apilado: 2 } }
    ];
    const gen = generarRacksAuto(p, { orientacion: 'horizontal' });
    p.racks = gen.racks;
    // v1.1: las estanterías de cajas (bin) salen de la zona de almacenaje «Z5» (con su configuración); ya no se convierten filas a mano
    const cand = [];
    // v1.1: un rack cantilever (bahías de ≥ 6 m para mercadería larga) y capacidad de módulo en dos racks de palets
    const yaTocado = {};
    cand.forEach(function (x) { yaTocado[x.i] = true; });
    const despC = p.puertas[1];
    const largos = p.racks.map(function (r, i) { return { i: i, largo: r.largo, d: Math.hypot(r.cx - despC.x, r.cy - despC.y) }; })
      .filter(function (x) {
        const r = p.racks[x.i];
        const poli = poligonoRack(r);
        return !yaTocado[x.i] && !r.zonaId && r.tipo === 'palet' && r.largo >= 12 && !p.zonas.some(function (z) { return poligonosSolapan(poli, z.poly); });
      })
      .sort(function (a, b) { return b.d - a.d || a.i - b.i; });   // el más lejano al despacho: mercadería larga de baja rotación
    if (largos.length) {
      const rc = p.racks[largos[0].i];
      rc.tipo = 'cantilever'; rc.modulos = Math.max(1, Math.floor(rc.largo / 6)); rc.niveles = 3; rc.slotsPorModulo = 1;
      rc.altoNivel = 1.0; rc.altoBase = 0.3; rc.cargaMaxKg = 1500; rc.auto = false;
      yaTocado[largos[0].i] = true;
    }
    let nMod = 0;
    p.racks.forEach(function (r, i) {
      if (nMod < 2 && !yaTocado[i] && r.tipo === 'palet' && !r.zonaId) { r.cargaMaxModuloKg = 5000; nMod++; }   // EJEMPLO – editar (placa del fabricante)
    });
    // productos
    const rnd = crearPRNG(20261107);
    const nombres = ['Arroz', 'Azúcar', 'Aceite', 'Fideos', 'Harina', 'Leche', 'Yogur', 'Queso', 'Detergente', 'Lejía',
      'Jabón', 'Papel higiénico', 'Servilletas', 'Gaseosa', 'Agua', 'Jugo', 'Cerveza', 'Pilas', 'Focos', 'Cable',
      'Tornillos', 'Clavos', 'Pintura', 'Solvente', 'Ácido', 'Cuaderno', 'Lapicero', 'Papel bond', 'Archivador', 'Tinta',
      'Cereal', 'Galletas', 'Atún', 'Menestras', 'Conservas', 'Sal', 'Café', 'Té', 'Mermelada', 'Salsa',
      'Guantes', 'Mascarillas', 'Cinta', 'Bolsas', 'Envases'];
    const familias = ['Abarrotes', 'Bebidas', 'Limpieza', 'Ferretería', 'Papelería', 'Químicos', 'Lácteos', 'Electro'];
    const frio = { 6: 1, 7: 1, 8: 1 }, peligrosos = { 24: 1, 25: 1 }, pesados = { 3: 1, 12: 1, 21: 1 }, bins = {};
    [14, 18, 19, 28, 29, 30, 42, 43, 44].forEach(function (k) { bins[k] = 1; });
    const productos = [];
    for (let i = 1; i <= 45; i++) {
      const picks = Math.max(1, Math.round(950 * Math.pow(i, -1.05) * (0.85 + 0.3 * rnd())));
      const esBin = !!bins[i] && !frio[i] && !peligrosos[i] && !pesados[i];
      const zona = frio[i] ? 'frio' : peligrosos[i] ? 'peligrosos' : null;
      let familia = familias[Math.floor(rnd() * familias.length)];
      if (frio[i]) familia = 'Lácteos';
      if (peligrosos[i]) familia = 'Químicos';
      else if (familia === 'Químicos') familia = 'Limpieza';
      let posReq = Math.round(2 + picks / 18 + rnd() * 5);
      if (zona) posReq = Math.min(posReq, 8);
      if (esBin) posReq = Math.max(1, Math.round(posReq / 3));
      posReq = Math.max(1, Math.min(posReq, 40));
      let upu, peso, alto;
      if (esBin) { upu = 24 + Math.floor(rnd() * 4) * 24; peso = redondear(Math.min(0.05 + rnd() * 0.3, 40 / upu), 2); alto = redondear(0.1 + rnd() * 0.2, 2); }
      else if (pesados[i]) { upu = 1 + Math.floor(rnd() * 2); peso = redondear((480 + rnd() * 300) / upu, 1); alto = redondear(0.9 + rnd() * 0.4, 2); }
      else { upu = [20, 24, 40, 48, 60][Math.floor(rnd() * 5)]; peso = redondear(0.4 + rnd() * 14, 1); alto = redondear(0.8 + rnd() * 0.6, 2); }
      const cantidad = (posReq - 1) * upu + 1 + Math.floor(rnd() * upu);
      const entradas = rnd() > 0.7 ? Math.round(picks * (0.15 + rnd() * 0.3)) : null;
      productos.push({
        sku: 'SKU-' + pad(i, 3),
        descripcion: 'EJEMPLO – editar: ' + nombres[(i - 1) % nombres.length],
        familia: familia, cantidad: cantidad, unidadesPorUbic: upu, picks: picks, entradas: entradas,
        pesoUnitKg: peso, altoCargaM: alto, tipoUbic: esBin ? 'bin' : 'palet', requiereZona: zona,
        incompatibleCon: []
      });
    }
    // ---- v1.1: campos nuevos (la secuencia pseudoaleatoria de arriba no cambia) ----
    const REF = Date.UTC(2026, 10, 7);
    const fechaMas = function (d) { return new Date(REF + d * 86400000).toISOString().slice(0, 10); };
    const pk = function (i) { return productos[i - 1]; };
    productos.forEach(function (q) {
      const bin = q.tipoUbic === 'bin';
      q.unidadesPorLinea = Math.max(1, Math.round(q.unidadesPorUbic / (bin ? 12 : 6)));
      q.stockMax = null; q.picksPico = null; q.peligro = null; q.fefo = false; q.lotes = [];
      q.crossdock = false; q.flujoCrossdock = null; q.largoM = null; q.apilableMax = 1;
    });
    for (let i = 1; i <= 10; i++) {   // los 10 SKU más movidos tienen pico: +50 % de stock y +60 % de picks
      const q = pk(i);
      if (q.tipoUbic === 'palet') { q.stockMax = Math.ceil(q.cantidad * 1.5); q.picksPico = Math.round(q.picks * 1.6); }
    }
    pk(8).pesoUnitKg = 6;   // 60 u × 6 kg = 360 kg por ubicación: no es «pesado» (así cabe en toda la altura de la zona de frío)
    [6, 7, 8].forEach(function (i) { pk(i).peligro = 'alimento'; });
    pk(18).peligro = 'bateria_litio'; pk(24).peligro = 'inflamable'; pk(25).peligro = 'corrosivo_acido';
    // lotes con vencimientos (FEFO): salen primero los que vencen antes
    const conLotes = function (i, dias) {
      const q = pk(i);
      q.fefo = true;
      const c = q.cantidad, l1 = Math.round(c * 0.35), l2 = Math.round(c * 0.4);
      const cants = [l1, l2, c - l1 - l2];
      q.lotes = dias.map(function (d, k) { return { lote: 'L' + (k + 1) + '-' + pad(i, 3), cantidad: cants[k], vence: d === null ? null : fechaMas(d) }; });
    };
    conLotes(6, [9, 70, 160]); conLotes(7, [-5, 25, 120]); conLotes(8, [40, 95, null]); conLotes(4, [200, 365, 480]); conLotes(37, [150, 300, 420]);
    // cantilever (mercadería larga), bloque de piso (apilable) y cross-docking
    productos.push({
      sku: 'SKU-046', descripcion: 'EJEMPLO – editar: Tubería PVC de 6 m', familia: 'Ferretería', cantidad: 90, unidadesPorUbic: 30, picks: 40, entradas: null,
      pesoUnitKg: 8, altoCargaM: 0.4, tipoUbic: 'cantilever', requiereZona: null, incompatibleCon: [],
      unidadesPorLinea: 5, stockMax: null, picksPico: null, peligro: null, fefo: false, lotes: [], crossdock: false, flujoCrossdock: null, largoM: 5.8, apilableMax: 1
    });
    productos.push({
      sku: 'SKU-047', descripcion: 'EJEMPLO – editar: Gaseosa en bloque (piso)', familia: 'Bebidas', cantidad: 720, unidadesPorUbic: 48, picks: 150, entradas: null,
      pesoUnitKg: 1.2, altoCargaM: 1.0, tipoUbic: 'piso', requiereZona: null, incompatibleCon: [],
      unidadesPorLinea: 8, stockMax: 900, picksPico: 240, peligro: null, fefo: false, lotes: [], crossdock: false, flujoCrossdock: null, largoM: null, apilableMax: 2
    });
    productos.push({
      sku: 'SKU-048', descripcion: 'EJEMPLO – editar: Pedido directo a cliente (cross-docking)', familia: 'Abarrotes', cantidad: 0, unidadesPorUbic: 1, picks: 0, entradas: null,
      pesoUnitKg: 0, altoCargaM: 1.0, tipoUbic: 'palet', requiereZona: null, incompatibleCon: [],
      unidadesPorLinea: null, stockMax: null, picksPico: null, peligro: null, fefo: false, lotes: [], crossdock: true, flujoCrossdock: 18, largoM: null, apilableMax: 1
    });
    p.productos = productos;
    // pedidos sintéticos con correlaciones (canastas que se repiten) + ruido
    const rp = crearPRNG(20261108);
    const canastas = [[1, 2, 3], [4, 5], [14, 15, 16], [20, 21, 22], [6, 7], [10, 11]];
    const peso = [0.26, 0.2, 0.13, 0.1, 0.08, 0.05];
    const pedidos = [];
    for (let k = 1; k <= 240; k++) {
      const u = rp();
      let acum = 0, ci = -1;
      for (let c = 0; c < peso.length; c++) { acum += peso[c]; if (u < acum) { ci = c; break; } }
      const set = new Set();
      if (ci >= 0) canastas[ci].forEach(function (s) { if (rp() < 0.85) set.add(s); });
      const extra = Math.floor(rp() * 3);   // 0–2 SKU sueltos entre los 30 más movidos
      for (let e = 0; e < extra; e++) set.add(1 + Math.floor(rp() * 30));
      if (!set.size) set.add(1 + Math.floor(rp() * 30));
      pedidos.push({ id: 'PED-' + pad(k, 4), lineas: Array.from(set).sort(function (a, b) { return a - b; }).map(function (s) { return { sku: 'SKU-' + pad(s, 3), cant: 1 + Math.floor(rp() * 6) }; }) });
    }
    p.pedidos = pedidos;
    p.resultado = null;
    return p;
  }

  /* ======================================================================
   * 11. v1.1 — API DE APOYO (segregación, módulos, afinidad, pedidos, migración)
   * ==================================================================== */

  /** Distancia mínima (m) entre las HUELLAS de dos racks (0 si se tocan o solapan); Infinity si falta la geometría. */
  function huellaMinDistancia(rackA, rackB) {
    if (!rackA || !rackB || !(rackA.largo > 0) || !(rackA.fondo > 0) || !(rackB.largo > 0) || !(rackB.fondo > 0)) return Infinity;
    return distPoligonos(poligonoRack(rackA), poligonoRack(rackB));
  }

  /** Módulo (rack + índice de módulo; todos los niveles y slots) al que pertenece una posición. */
  function moduloDePosicion(pos) {
    return { rackId: pos && pos.rackId !== undefined ? pos.rackId : (pos ? pos.rackNombre : undefined), modulo: pos ? pos.modulo : undefined };
  }

  /** Matriz de segregación efectiva como Map «a|b» (orden alfabético) → distMinM|null. */
  function matrizSegregacion(cfg) {
    const lista = cfg && cfg.segregacion && cfg.segregacion.usar === false ? [] : (cfg && cfg.segregacion && Array.isArray(cfg.segregacion.matriz) ? cfg.segregacion.matriz : SEGREGACION_DEFECTO);
    const m = new Map();
    lista.forEach(function (e) {
      if (!e || typeof e.a !== 'string' || typeof e.b !== 'string') return;
      const k = e.a < e.b ? e.a + '|' + e.b : e.b + '|' + e.a;
      const d = typeof e.distMinM === 'number' && isFinite(e.distMinM) && e.distMinM >= 0 ? e.distMinM : null;
      if (!m.has(k) || (d !== null && (m.get(k) === null || d > m.get(k)))) m.set(k, d);
    });
    return m;
  }

  /**
   * Afinidad por co-ocurrencia en pedidos (análisis de canasta). `pedidos` = [{id, lineas:[{sku, cant}]}].
   * N = pedidos con al menos una línea de SKU conocido; los SKU repetidos en un pedido cuentan una vez; los pedidos de
   * una sola línea cuentan en N pero no aportan pares. soporte = cooc / N; confianzaAB = cooc / pedidos(a);
   * lift = soporte(ab) / (soporte(a)·soporte(b)). Determinista (pares por lift desc, cooc desc, a, b).
   */
  function calcularAfinidad(pedidos, productos) {
    const advertencias = [];
    const conocidos = Array.isArray(productos) ? new Set(productos.map(function (p) { return String(p.sku); })) : null;
    const cntSku = new Map(), cntPar = new Map();
    let N = 0, desconocidas = 0, lineasTotal = 0;
    const desc = new Set();
    (Array.isArray(pedidos) ? pedidos : []).forEach(function (ped) {
      const set = new Set();
      ((ped && Array.isArray(ped.lineas)) ? ped.lineas : []).forEach(function (l) {
        if (!l || l.sku === undefined || l.sku === null) return;
        const s = String(l.sku);
        lineasTotal++;
        if (conocidos && !conocidos.has(s)) { desconocidas++; if (desc.size < 5) desc.add(s); return; }
        set.add(s);
      });
      if (!set.size) return;
      N++;
      const arr = Array.from(set).sort();
      arr.forEach(function (s) { cntSku.set(s, (cntSku.get(s) || 0) + 1); });
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const k = arr[i] + '\u0001' + arr[j];
          cntPar.set(k, (cntPar.get(k) || 0) + 1);
        }
      }
    });
    if (desconocidas) advertencias.push(desconocidas + ' línea(s) de pedido con SKU que no está en la lista de productos se ignoraron (p. ej. ' + Array.from(desc).join(', ') + ').');
    const pares = [];
    cntPar.forEach(function (c, k) {
      const ab = k.split('\u0001'), a = ab[0], b = ab[1];
      const ca = cntSku.get(a), cb = cntSku.get(b);
      pares.push({
        a: a, b: b, coocurrencias: c, soporte: redondear(c / N, 6),
        confianzaAB: redondear(c / ca, 6), confianzaBA: redondear(c / cb, 6), lift: redondear((c * N) / (ca * cb), 6)
      });
    });
    pares.sort(function (x, y) {
      return y.lift - x.lift || y.coocurrencias - x.coocurrencias || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0);
    });
    const mapaSku = new Map();   // Map (no objeto): un SKU llamado «constructor» o «__proto__» no puede chocar con el prototipo
    const agrega = function (s, e) { if (!mapaSku.has(s)) mapaSku.set(s, []); mapaSku.get(s).push(e); };
    pares.forEach(function (p) {
      agrega(p.a, { con: p.b, lift: p.lift, soporte: p.soporte });
      agrega(p.b, { con: p.a, lift: p.lift, soporte: p.soporte });
    });
    const porSku = {};
    Array.from(mapaSku.keys()).sort().forEach(function (s) {
      mapaSku.get(s).sort(function (x, y) { return y.lift - x.lift || y.soporte - x.soporte || (x.con < y.con ? -1 : x.con > y.con ? 1 : 0); });
      fijarProp(porSku, s, mapaSku.get(s));
    });
    return { nPedidos: N, lineas: lineasTotal - desconocidas, pares: pares, porSku: porSku, advertencias: advertencias };
  }

  /** CSV de pedidos `pedido;sku;cant` (cant opcional, 1 por defecto). Devuelve {pedidos, errores, advertencias}. */
  function parseCSVPedidos(texto) {
    const errores = [], advertencias = [], pedidos = [];
    const t = String(texto === undefined || texto === null ? '' : texto).replace(/^﻿/, '');
    if (!t.trim()) { errores.push({ linea: 1, mensaje: 'El archivo está vacío.' }); return { pedidos: pedidos, errores: errores, advertencias: advertencias }; }
    const sep = detectarSeparador(t);
    const regs = dividirCSV(t, sep);
    const cab = regs[0].campos.map(normalizarEncabezado);
    const alias = { pedido: ['pedido', 'id_pedido', 'orden', 'order', 'id', 'nro_pedido'], sku: ['sku', 'codigo', 'cod', 'articulo', 'item'], cant: ['cant', 'cantidad', 'qty', 'unidades'] };
    const col = {};
    Object.keys(alias).forEach(function (k) {
      for (let i = 0; i < cab.length; i++) if (alias[k].indexOf(cab[i]) >= 0 && col[k] === undefined) { col[k] = i; break; }
    });
    if (col.pedido === undefined || col.sku === undefined) {
      errores.push({ linea: regs[0].linea, mensaje: 'Faltan columnas en el encabezado: se necesitan «pedido» y «sku» (y opcional «cant»).' });
      return { pedidos: pedidos, errores: errores, advertencias: advertencias };
    }
    const porId = new Map();
    for (let r = 1; r < regs.length; r++) {
      const c = regs[r].campos, linea = regs[r].linea;
      if (regs[r].sinCerrar) { errores.push({ linea: linea, mensaje: 'Comilla sin cerrar desde esta línea.' }); break; }
      if (c.every(function (x) { return String(x).trim() === ''; })) continue;
      const id = quitarPrefijoFormula(String(c[col.pedido] === undefined ? '' : c[col.pedido])).trim();
      const sku = quitarPrefijoFormula(String(c[col.sku] === undefined ? '' : c[col.sku])).trim();
      if (!id) { errores.push({ linea: linea, mensaje: 'Falta el identificador del pedido.' }); continue; }
      if (!sku) { errores.push({ linea: linea, mensaje: 'Falta el SKU.' }); continue; }
      let cant = null;
      if (col.cant !== undefined) {
        const v = parseNumeroFlexible(c[col.cant]);
        if (v !== null) {
          if (Number.isNaN(v)) { errores.push({ linea: linea, mensaje: 'Pedido «' + id + '»: «' + c[col.cant] + '» no es un número válido en «cant».' }); continue; }
          if (v < 0) { errores.push({ linea: linea, mensaje: 'Pedido «' + id + '»: cantidad negativa.' }); continue; }
          cant = v;
        }
      }
      let ped = porId.get(id);
      if (!ped) { ped = { id: id, lineas: [] }; porId.set(id, ped); pedidos.push(ped); }
      const lin = { sku: sku };
      if (cant !== null) lin.cant = cant;
      ped.lineas.push(lin);
    }
    const solas = pedidos.filter(function (p) { return p.lineas.length < 2; }).length;
    if (pedidos.length && solas === pedidos.length) advertencias.push({ linea: 1, mensaje: 'Todos los pedidos tienen una sola línea: no hay pares de SKU para medir afinidad.' });
    return { pedidos: pedidos, errores: errores, advertencias: advertencias };
  }

  /**
   * Migra un proyecto (v1 o v2) a la versión 2 SIN pérdida: copia profunda, agrega los campos nuevos con valores que
   * reproducen v1.0. Idempotente. No valida rangos (eso lo hace validarProyecto).
   */
  function normalizarProyecto(proyecto) { return normalizarConAvisos(proyecto).proyecto; }

  /** Texto de la marca: string sin saltos de línea ni «<»/«>», recortado a 80 caracteres; '' si no es texto. */
  function textoMarca(v) {
    if (typeof v !== 'string') return '';
    return v.replace(/[\u0000-\u001f\u007f\u2028\u2029<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim();
  }
  const MAX_LOGO_CHARS = 400000;
  /** Marca del informe `{empresa, autor, logo}`: logo solo como data URL base64 png/jpeg/webp de ≤ 400 000 caracteres, o null. */
  function normalizarMarca(m, avisos) {
    const out = { empresa: '', autor: '', logo: null };
    if (!m || typeof m !== 'object' || Array.isArray(m)) return out;
    out.empresa = textoMarca(m.empresa);
    out.autor = textoMarca(m.autor);
    const lg = m.logo;
    if (typeof lg === 'string' && lg !== '') {
      const ok = lg.length <= MAX_LOGO_CHARS && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+\/]+={0,2}$/.test(lg) && (lg.length - lg.indexOf(',') - 1) % 4 === 0;
      if (ok) out.logo = lg;
      else if (avisos) avisos.push('El logo de la marca se descartó: debe ser una imagen PNG, JPEG o WEBP en base64 (data URL) de hasta ' + MAX_LOGO_CHARS + ' caracteres.');
    } else if (lg !== null && lg !== undefined && lg !== '' && avisos) avisos.push('El logo de la marca se descartó: no es una imagen válida.');
    return out;
  }

  /**
   * Ancho de pasillo de apilado a 90° (Ast) con la forma Ast = Wa + l6 + x + a, función pura (sin proyecto). Entradas en metros ≥ 0:
   * radioGiroM (Wa, ficha del equipo; sin valor por defecto), largoCargaM (l6; 1,2 m [VERIFICAR] si el usuario no lo da),
   * holguraCargaRackM (x) y holguraSeguridadM (a): del usuario, sin valores inventados. Si falta Wa, x o a → ok:false y `falta`.
   * Salida: {ok, anchoM, anchoRedondeadoM, formula, formulaSustituida, componentes:{Wa,l6,x,a}, supuestos, avisos, falta}.
   */
  function calcularPasilloVDMA(p) {
    const e = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
    const falta = [], avisos = [], comp = { Wa: null, l6: null, x: null, a: null };
    const fmt = function (v) { return String(redondear(v, 3)); };
    const leer = function (k, etiqueta, positivo) {
      const v = e[k];
      if (v === undefined || v === null || v === '') return null;
      if (typeof v !== 'number' || !isFinite(v) || v < 0 || (positivo && v === 0)) {
        avisos.push('«' + etiqueta + '» no es válido (' + (typeof v === 'number' ? (isFinite(v) ? String(v) : 'no es un número finito') : 'valor no numérico') + '): debe ser un número ' + (positivo ? 'mayor que 0' : '≥ 0') + ' en metros. No se calculó con un valor inventado.');
        falta.push(k);
        return undefined;
      }
      return v;
    };
    const wa = leer('radioGiroM', 'radio de giro Wa', true);
    if (wa === null) falta.push('radioGiroM');
    comp.Wa = wa === null || wa === undefined ? null : wa;
    let l6 = leer('largoCargaM', 'largo de la carga l6', true);
    if (l6 === null) {
      l6 = 1.2;
      avisos.push('No se indicó el largo de la carga (l6): se usó 1,2 m, valor típico de un palet europeo/CHEP en el sentido de la carga [VERIFICAR con la medida real de su palet].');
    }
    comp.l6 = l6 === undefined ? null : l6;
    const x = leer('holguraCargaRackM', 'término x', false);
    if (x === null) falta.push('holguraCargaRackM');
    comp.x = x === null || x === undefined ? null : x;
    const a = leer('holguraSeguridadM', 'holgura de seguridad a', false);
    if (a === null) falta.push('holguraSeguridadM');
    comp.a = a === null || a === undefined ? null : a;
    const supuestos = [
      'Forma usada: Ast = Wa + l6 + x + a (ancho del pasillo de apilado a 90°; Wa = radio de giro del equipo, l6 = largo de la carga, x y a = términos que da el usuario). Fuente consultada el 08/11/2026: guía de ancho de pasillo de Toyota Material Handling (sitio baltic.toyota-forklifts.eu, sección guides/aisle-width-guide), que la escribe «Ast = Wa + x + l6 + a» para carretillas contrapesadas de 4 ruedas cuando b12 ≤ 2·b13, con Wa = radio de giro, l6 = largo de la carga, x = distancia del centro de las ruedas delanteras a la cara de las horquillas y a = holgura de seguridad (la guía cita 200 mm como valor típico de a).',
      'NO se pudo verificar la notación ni la fórmula en el texto de VDMA 15173 (norma de pago, no consultada); la norma FEM 4.005 («Industrial trucks – 90° stacking aisle width», edición 2013) existe y toma el mayor de varios casos geométricos. [VERIFICAR con la norma, con la ficha del equipo y con el fabricante]: las fórmulas de retráctiles, trilaterales y VNA difieren y esta forma no es válida sin revisar para ellos.',
      'El término x se recibe como `holguraCargaRackM` (nombre del contrato): en la fuente consultada x es una cota del EQUIPO (centro de ruedas delanteras a cara de horquillas); ingrese lo que su ficha indique para x. El programa no supone ni x ni a: si faltan, no calcula.',
      'Resultado de orientación de diseño: no afirma cumplimiento de ninguna norma ni de la ficha del equipo; se compara con el ancho configurado, pero el ancho real lo fija el fabricante del equipo y el responsable de seguridad.',
      'No incluye pasillo de doble sentido, cruce con peatones ni holgura de racks con carga sobresaliente. Se calcula con todos los decimales y se redondea a 2 decimales solo para mostrar.'
    ];
    const formula = 'Ast = Wa + l6 + x + a';
    const ok = falta.length === 0;
    const out = { ok: ok, anchoM: null, anchoRedondeadoM: null, formula: formula, formulaSustituida: null, componentes: comp, supuestos: supuestos, avisos: avisos, falta: falta };
    if (ok) {
      const ancho = comp.Wa + comp.l6 + comp.x + comp.a;
      out.anchoM = redondear(ancho, 9);
      out.anchoRedondeadoM = redondear(ancho, 2);
      out.formulaSustituida = 'Ast = ' + fmt(comp.Wa) + ' + ' + fmt(comp.l6) + ' + ' + fmt(comp.x) + ' + ' + fmt(comp.a) + ' = ' + redondear(ancho, 2).toFixed(2) + ' m';
      if (comp.a === 0) avisos.push('La holgura de seguridad a es 0 m: no queda margen de maniobra [VERIFICAR con la ficha del equipo].');
    }
    return out;
  }

  /** Como normalizarProyecto, pero devuelve también {avisos:[…]} (p. ej. racks con nombre repetido que se renombraron). */
  /* Tope TOTAL de posiciones de un proyecto (suma de módulos × niveles × slots de todos los racks). Un archivo, enlace o JSON
     no confiable no puede pedir millones de posiciones: se descartan los racks que excedan y se avisa (auditoría v1.2, A-1). */
  const MAX_POSICIONES_PROYECTO = 150000, MAX_RACKS_PROYECTO = 20000;
  function posicionesDeUnRack(r) {
    const mods = Math.min(MAX_MODULOS_RACK, Math.max(1, Math.floor(num(r && r.modulos, 1))));
    const niv = Math.min(MAX_NIVELES, Math.max(1, Math.floor(num(r && r.niveles, 1))));
    const sl = Math.min(MAX_SLOTS, Math.max(1, Math.floor(num(r && r.slotsPorModulo, 1))));
    return mods * niv * sl;
  }
  function limitarPosicionesRacks(racks) {
    const lista = Array.isArray(racks) ? racks : [];
    const salen = [];
    let acum = 0, descartados = 0;
    for (let i = 0; i < lista.length; i++) {
      const n = posicionesDeUnRack(lista[i]);
      if (salen.length < MAX_RACKS_PROYECTO && acum + n <= MAX_POSICIONES_PROYECTO) { salen.push(lista[i]); acum += n; } else descartados++;
    }
    return { racks: salen, posiciones: acum, descartados: descartados };
  }
  function fijarRango(o, k, lo, hi, def) {
    const v = o[k];
    if (typeof v !== 'number' || !isFinite(v)) { if (v !== undefined && v !== null) o[k] = def; return; }
    o[k] = v < lo ? lo : (v > hi ? hi : v);
  }
  /* Acota valores numéricos absurdos (1e308, negativos donde no caben) para que ningún texto muestre «Infinity» ni se cuelgue el cálculo. */
  function endurecerLimites(out, avisos) {
    let tocados = 0;
    const antes = out.racks.length;
    const lim = limitarPosicionesRacks(out.racks);
    if (lim.descartados > 0) {
      out.racks = lim.racks;
      avisos.push('El proyecto pide demasiadas posiciones: se conservaron los primeros ' + out.racks.length + ' racks (' + lim.posiciones + ' posiciones; tope ' + MAX_POSICIONES_PROYECTO + ') y se descartaron ' + lim.descartados + '.');
    }
    out.racks.forEach(function (r) {
      if (!r || typeof r !== 'object') return;
      const o0 = JSON.stringify([r.modulos, r.niveles, r.slotsPorModulo, r.largo, r.fondo, r.cx, r.cy, r.altoNivel, r.altoBase, r.cargaMaxKg, r.profundidadPalets, r.apilado]);
      fijarRango(r, 'modulos', 1, MAX_MODULOS_RACK, 1); fijarRango(r, 'niveles', 1, MAX_NIVELES, 1); fijarRango(r, 'slotsPorModulo', 1, MAX_SLOTS, 1);
      fijarRango(r, 'largo', 0.1, 500, 1); fijarRango(r, 'fondo', 0.1, 50, 1); fijarRango(r, 'cx', -1e6, 1e6, 0); fijarRango(r, 'cy', -1e6, 1e6, 0);
      fijarRango(r, 'altoNivel', 0.05, 20, 1); fijarRango(r, 'altoBase', 0, 5, 0.15); fijarRango(r, 'cargaMaxKg', 0, 1e6, 1000);
      fijarRango(r, 'profundidadPalets', 1, 50, 1); fijarRango(r, 'apilado', 1, 10, 1);
      if (JSON.stringify([r.modulos, r.niveles, r.slotsPorModulo, r.largo, r.fondo, r.cx, r.cy, r.altoNivel, r.altoBase, r.cargaMaxKg, r.profundidadPalets, r.apilado]) !== o0) tocados++;
    });
    out.productos.forEach(function (q) {
      if (!q || typeof q !== 'object') return;
      ['cantidad', 'unidadesPorUbic', 'picks', 'entradas', 'pesoUnitKg', 'stockMax', 'picksPico', 'unidadesPorLinea', 'flujoCrossdock'].forEach(function (k) { fijarRango(q, k, 0, 1e9, 0); });
      fijarRango(q, 'altoCargaM', 0, 50, 0); fijarRango(q, 'largoM', 0, 500, 0); fijarRango(q, 'apilableMax', 1, 20, 1);
    });
    if (tocados > 0) avisos.push('Se acotaron valores fuera de rango en ' + tocados + ' rack(s) (módulos ≤ ' + MAX_MODULOS_RACK + ', niveles ≤ ' + MAX_NIVELES + ', posiciones por módulo ≤ ' + MAX_SLOTS + ', medidas razonables).');
    return antes;
  }

  function normalizarConAvisos(proyecto) {
    const avisos = [];
    const base = crearProyectoVacio();
    const p = proyecto && typeof proyecto === 'object' ? clonar(proyecto) : {};
    const out = Object.assign({}, base, p);
    out.version = 2;
    ['contorno', 'huecos', 'puertas', 'zonas', 'racks', 'productos', 'pedidos'].forEach(function (k) { if (!Array.isArray(out[k])) out[k] = []; });
    const eq = (p.config && p.config.equipo) || 'apilador';
    out.config = Object.assign({}, configPorDefecto(eq), p.config || {});
    out.config.abc = Object.assign({}, configPorDefecto(eq).abc, (p.config && p.config.abc) || {});
    ['reposicion', 'segregacion', 'muelle'].forEach(function (k) {
      out.config[k] = Object.assign({}, configPorDefecto(eq)[k], (p.config && p.config[k] && typeof p.config[k] === 'object') ? p.config[k] : {});
    });
    // v1.2: combinar bahías de cantilever (por defecto sí) y datos del usuario para el ancho de pasillo VDMA
    out.config.cantileverCombinar = out.config.cantileverCombinar !== false;
    out.config.pasilloVDMA = normalizarPasilloVDMA(out.config.pasilloVDMA);
    out.marca = normalizarMarca(p.marca, avisos);
    out.racks.forEach(function (r) {
      if (r.equipo === undefined) r.equipo = null;
      if (r.anchoPasillo === undefined) r.anchoPasillo = null;
      if (r.cargaMaxModuloKg === undefined) r.cargaMaxModuloKg = null;
      if (r.profundidadPalets === undefined) r.profundidadPalets = 1;
      if (r.apilado === undefined) r.apilado = 1;
      if (r.zonaId === undefined) r.zonaId = null;
    });
    endurecerLimites(out, avisos);
    // racks con NOMBRE repetido: se renombran («R03», «R03-2»…) para que los ids de posición sean únicos; se advierte, no se rechaza
    const dups = nombresRacksUnicos(out.racks);
    dups.renombrados.forEach(function (d) {
      out.racks[d.indice].nombre = d.a;
      avisos.push('El nombre de rack «' + d.de + '» estaba repetido: el rack de la posición ' + (d.indice + 1) + ' se renombró «' + d.a + '».');
    });
    out.productos.forEach(function (q) {
      if (q.stockMax === undefined) q.stockMax = null;
      if (q.picksPico === undefined) q.picksPico = null;
      if (q.unidadesPorLinea === undefined) q.unidadesPorLinea = null;
      if (q.peligro === undefined) q.peligro = null;
      if (q.fefo === undefined) q.fefo = false;
      if (!Array.isArray(q.lotes)) q.lotes = [];
      if (q.crossdock === undefined) q.crossdock = false;
      if (q.flujoCrossdock === undefined) q.flujoCrossdock = null;
      if (q.largoM === undefined) q.largoM = null;
      if (q.apilableMax === undefined) q.apilableMax = 1;
    });
    return { proyecto: out, avisos: avisos };
  }

  /* ======================================================================
   * API PÚBLICA
   * ==================================================================== */

  return {
    VERSION: VERSION_MOTOR,
    TIPOS_UBIC: TIPOS_UBIC,
    CLASES_PELIGRO: CLASES_PELIGRO,
    SEGREGACION_DEFECTO: SEGREGACION_DEFECTO,
    SEGREGACION_REF: SEGREGACION_REF,
    huellaMinDistancia: huellaMinDistancia,
    moduloDePosicion: moduloDePosicion,
    anchoPasilloRack: anchoPasilloDeRack,
    limitarPosicionesRacks: limitarPosicionesRacks,
    MAX_POSICIONES_PROYECTO: MAX_POSICIONES_PROYECTO,
    calcularAfinidad: calcularAfinidad,
    parseCSVPedidos: parseCSVPedidos,
    normalizarProyecto: normalizarProyecto,
    normalizarConAvisos: normalizarConAvisos,
    normalizar: normalizarProyecto,
    calcularPasilloVDMA: calcularPasilloVDMA,
    PRESETS_EQUIPO: PRESETS_EQUIPO,
    NOMBRES_EQUIPO: NOMBRES_EQUIPO,
    COLUMNAS_PRODUCTO: COLUMNAS_PRODUCTO,
    configPorDefecto: configPorDefecto,
    configEfectiva: configCompleta,
    crearProyectoVacio: crearProyectoVacio,
    crearProyectoRectangular: crearProyectoRectangular,
    crearProyectoEnL: crearProyectoEnL,
    areaPoligono: areaPoligono,
    puntoEnPoligono: puntoEnPoligono,
    poligonoRack: poligonoRack,
    bboxPoligono: bboxPoligono,
    poligonosSolapan: poligonosSolapan,
    poligonoContenido: poligonoContenido,
    ejemplo: ejemplo,
    escalaDesdeCalibracion: escalaDesdeCalibracion,
    contornoDesdeImagen: contornoDesdeImagen,
    generarRacksAuto: generarRacksAuto,
    posicionesDeRacks: posicionesDeRacks,
    construirMalla: construirMalla,
    distanciasDesde: distanciasDesde,
    calcularDistanciasPosiciones: calcularDistanciasPosiciones,
    clasificarABC: clasificarABC,
    asignar: asignar,
    evaluarAsignacionManual: evaluarAsignacionManual,
    validarProyecto: validarProyecto,
    parseCSVProductos: parseCSVProductos,
    productosACSV: productosACSV,
    ubicacionesACSV: ubicacionesACSV,
    plantillaCSVProductos: plantillaCSVProductos
  };
});
