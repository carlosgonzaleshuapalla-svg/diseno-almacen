/*!
 * vista3d.js — Vista 3D del almacén (v1.2). UMD sin dependencias: `window.AlmacenVista3D` y `module.exports`.
 *
 * Qué hace
 *   construirEscena(proyecto, opciones)  → { cajas, planos, limites, avisos, leyenda, resumen, simplificada }   (pura, sin DOM)
 *   proyectar(escena, camara)            → polígonos 2D ordenados por profundidad (algoritmo del pintor)           (pura)
 *   dibujar(ctx, ancho, alto, polys, op) → solo pinta en un Canvas 2D
 *   conectar(canvas, op)                 → controlador con el dedo/mouse (girar, zoom, PNG); es lo ÚNICO que toca el DOM.
 *
 * Convenciones
 *   - Las cajas usan las coordenadas del proyecto: x, y en metros con y hacia ABAJO (como el plano), z hacia arriba.
 *     (x, y) es el CENTRO de la caja en planta, z es su base, dx/dy son sus medidas en los ejes locales y `ang` (grados) gira
 *     la caja como gira un rack (eje local x = (cos a, sin a), eje local y = (−sin a, cos a)).
 *   - Proyección ORTOGRÁFICA con giro `azimut` y elevación `elev`. Con elev = 90° y azimut = 0 la imagen es el plano visto desde arriba.
 *   - Honestidad: es una ilustración de lo calculado (posiciones, clase ABC, zona). No añade datos: la altura de una carga es la
 *     del artículo (altoCargaM) si existe; si no, un 80 % de la altura libre de la posición (solo para dibujar).
 */
(function (raiz, fabrica) {
  'use strict';
  if (typeof module === 'object' && module && module.exports) {
    module.exports = fabrica(function () { try { return require('./motor.js'); } catch (e) { return null; } });
  } else {
    raiz.AlmacenVista3D = fabrica(function () { return raiz.AlmacenMotor || null; });
  }
})(typeof self !== 'undefined' ? self : this, function (cargarMotor) {
  'use strict';

  var TOPE_CAJAS = 12000;          // sobre esto se simplifica (ver simplificar)
  var TOPE_POSICIONES = 150000;    // sobre esto ni se arma el detalle
  var TOPE_MUROS = 800;
  var COLOR_ABC = { A: '#e5484d', B: '#f5c518', C: '#3da66a' };
  var NOMBRE_ABC = { A: 'A · alta rotación', B: 'B · media', C: 'C · baja' };
  var COLOR_ZONA = { frio: '#2fa8e0', peligrosos: '#f2711c', alto_valor: '#a855f7', cuarentena: '#d4a600', general: '#7a8aa0', almacenaje: '#4f6bd6', muelle: '#0f8f8f', staging: '#c2410c' };
  var NOMBRE_ZONA = { frio: 'Frío', peligrosos: 'Peligrosos', alto_valor: 'Alto valor', cuarentena: 'Cuarentena', general: 'General', almacenaje: 'Almacenaje', muelle: 'Muelle', staging: 'Staging' };
  var COLOR_OCUPADA = '#2f7de1', COLOR_VACIA = '#9aa7b8';
  var COLOR_POSTE = '#2f5fa8', COLOR_VIGA = '#e08a2e', COLOR_PISO = '#cfd6e2', COLOR_MURO = '#8793a6';

  /* ---------------------------------------------------------------- utilidades */
  function fin(v, d) { v = Number(v); return isFinite(v) ? v : d; }
  function pos(v, d) { v = Number(v); return isFinite(v) && v > 0 ? v : d; }
  function entero(v, a, b, d) { v = Math.round(Number(v)); return isFinite(v) ? Math.max(a, Math.min(b, v)) : d; }
  function esObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
  function tiene(o, k) { return !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k); }
  function motor() { try { return cargarMotor(); } catch (e) { return null; } }

  /* ---------------------------------------------------------------- escena */
  function nuevaCaja(o) {
    return {
      x: fin(o.x, 0), y: fin(o.y, 0), z: fin(o.z, 0), dx: pos(o.dx, 0.01), dy: pos(o.dy, 0.01), dz: pos(o.dz, 0.01), ang: fin(o.ang, 0),
      color: typeof o.color === 'string' ? o.color : '#999999', tipo: o.tipo || 'estructura',
      id: o.id == null ? null : String(o.id), sku: o.sku == null ? null : String(o.sku), clase: o.clase || null
    };
  }

  /** Cajas de la caja de una posición/tramo; `lx` = centro local en el eje del rack (para poder fusionar). */
  function construirEscena(proyecto, opciones) {
    var op = esObj(opciones) ? opciones : {};
    var P = esObj(proyecto) ? proyecto : {};
    var avisos = [];
    var colorPor = op.colorPor === 'zona' || op.colorPor === 'ocupacion' ? op.colorPor : 'abc';
    var tope = pos(op.tope, TOPE_CAJAS);
    var racks = Array.isArray(P.racks) ? P.racks : [];
    var M = motor();
    var posiciones = Array.isArray(op.posiciones) ? op.posiciones : [];
    if (!Array.isArray(op.posiciones) && M && typeof M.posicionesDeRacks === 'function' && racks.length) {
      try { posiciones = M.posicionesDeRacks(P) || []; } catch (e) { posiciones = []; avisos.push('No se pudieron calcular las posiciones de los racks: ' + (e && e.message ? e.message : 'error')); }
    }
    var cfg = esObj(P.config) ? P.config : {};
    var res = esObj(P.resultado) && esObj(P.resultado.porPosicion) ? P.resultado : null;
    var por = res ? res.porPosicion : null;
    var spans = res && esObj(res.spanPorPosicion) ? res.spanPorPosicion : null;

    // producto por SKU y clase ABC (igual que el mapa 2D: sin dato → C)
    var prodPorSku = new Map();
    (Array.isArray(P.productos) ? P.productos : []).forEach(function (q) { if (esObj(q) && q.sku != null && !prodPorSku.has(String(q.sku))) prodPorSku.set(String(q.sku), q); });
    var claseSku = new Map();
    if (typeof op.claseDeSku === 'function') { /* se usa tal cual */ }
    else if (M && typeof M.clasificarABC === 'function' && res) {
      try { (M.clasificarABC(Array.isArray(P.productos) ? P.productos : [], cfg.abc) || []).forEach(function (c) { claseSku.set(String(c.sku), c.clase); }); } catch (e) { /* sin clase */ }
    }
    function claseDe(sku) {
      var c = typeof op.claseDeSku === 'function' ? op.claseDeSku(sku) : claseSku.get(String(sku));
      return c === 'A' || c === 'B' || c === 'C' ? c : 'C';
    }

    var cajas = [], planos = [], zonasVistas = new Set();
    var resumen = { ocupadas: 0, cajasCarga: 0, vacias: 0, estructura: 0, muros: 0, spans: 0, racks: 0 };
    var infoRacks = [];

    // ---- planos planos (suelo, zonas, huecos) ----
    function polyOk(poly) {
      if (!Array.isArray(poly)) return null;
      var out = [];
      for (var i = 0; i < poly.length && i < 5000; i++) {
        var p = poly[i];
        if (Array.isArray(p) && isFinite(Number(p[0])) && isFinite(Number(p[1]))) out.push([Number(p[0]), Number(p[1])]);
      }
      return out.length >= 3 ? out : null;
    }
    var contorno = polyOk(P.contorno);
    if (contorno) planos.push({ poly: contorno, tipo: 'suelo', color: null, alpha: 1, z: 0 });
    (Array.isArray(P.zonas) ? P.zonas : []).slice(0, 500).forEach(function (z) {
      var pl = esObj(z) ? polyOk(z.poly) : null;
      if (!pl) return;
      var t = typeof z.tipo === 'string' && tiene(COLOR_ZONA, z.tipo) ? z.tipo : 'general';
      planos.push({ poly: pl, tipo: 'zona', color: COLOR_ZONA[t], alpha: 0.28, z: 0.01 });
    });
    (Array.isArray(P.huecos) ? P.huecos : []).slice(0, 2000).forEach(function (h) {
      var pl = esObj(h) ? polyOk(h.poly) : null;
      if (pl) planos.push({ poly: pl, tipo: 'hueco', color: null, alpha: 1, z: 0.02 });
    });

    // ---- muros bajos del contorno ----
    if (contorno) {
      var nMuros = 0;
      for (var i = 0; i < contorno.length && nMuros < TOPE_MUROS; i++) {
        var a = contorno[i], b = contorno[(i + 1) % contorno.length];
        var len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (!(len > 1e-6)) continue;
        var n = Math.max(1, Math.ceil(len / 6)), ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
        for (var s = 0; s < n && nMuros < TOPE_MUROS; s++) {
          var t0 = s / n, t1 = (s + 1) / n, tm = (t0 + t1) / 2;
          cajas.push(nuevaCaja({ x: a[0] + (b[0] - a[0]) * tm, y: a[1] + (b[1] - a[1]) * tm, z: 0, dx: len * (t1 - t0), dy: 0.2, dz: 0.6, ang: ang, color: COLOR_MURO, tipo: 'muro' }));
          nMuros++; resumen.muros++;
        }
      }
      if (nMuros >= TOPE_MUROS) avisos.push('El contorno tiene muchos tramos: solo se dibujan los primeros ' + TOPE_MUROS + ' de pared.');
    }

    // ---- estructura de cada rack ----
    var estim = posiciones.length;
    var detalle = estim <= TOPE_POSICIONES;
    if (!detalle) avisos.push('Hay ' + estim + ' posiciones: la vista 3D dibuja solo los racks como bloques para mantenerse fluida.');
    racks.forEach(function (r, ri) {
      if (!esObj(r)) return;
      var L = pos(r.largo, 2.7), F = pos(r.fondo, 1.1), mods = entero(r.modulos, 1, 1000, 1), niv = entero(r.niveles, 1, 30, 1);
      var ab = Math.max(0, fin(r.altoBase, 0.15)), an = pos(r.altoNivel, 1.6), ang = fin(r.ang, 0), cx = fin(r.cx, 0), cy = fin(r.cy, 0);
      var tipo = typeof r.tipo === 'string' ? r.tipo : 'palet';
      var ca = Math.cos(ang * Math.PI / 180), sa = Math.sin(ang * Math.PI / 180);
      var H = ab + niv * an;
      infoRacks[ri] = { cx: cx, cy: cy, ang: ang, largo: L, fondo: F, alto: H, mods: mods, tipo: tipo, ca: ca, sa: sa };
      resumen.racks++;
      function pt(lx, ly) { return [cx + lx * ca - ly * sa, cy + lx * sa + ly * ca]; }
      if (tipo === 'piso') {
        var c0 = pt(0, 0);
        cajas.push(Object.assign(nuevaCaja({ x: c0[0], y: c0[1], z: 0, dx: L, dy: F, dz: 0.03, ang: ang, color: COLOR_PISO, tipo: 'estructura' }), { rack: ri, lx: 0 }));
        resumen.estructura++;
        return;
      }
      if (!detalle) {
        var c1 = pt(0, 0);
        cajas.push(Object.assign(nuevaCaja({ x: c1[0], y: c1[1], z: 0, dx: L, dy: F, dz: H, ang: ang, color: COLOR_POSTE, tipo: 'estructura' }), { rack: ri, lx: 0, marco: true }));
        resumen.estructura++;
        return;
      }
      var ml = L / mods;
      for (var i2 = 0; i2 <= mods; i2++) {
        for (var lado = -1; lado <= 1; lado += 2) {
          var pp = pt(-L / 2 + i2 * ml, lado * (F / 2 - 0.04));
          cajas.push(Object.assign(nuevaCaja({ x: pp[0], y: pp[1], z: 0, dx: 0.08, dy: 0.08, dz: H, ang: ang, color: COLOR_POSTE, tipo: 'estructura' }), { rack: ri, lx: -L / 2 + i2 * ml }));
          resumen.estructura++;
        }
      }
      for (var m = 0; m < mods; m++) {
        var lxm = -L / 2 + (m + 0.5) * ml;
        for (var nv = 0; nv < niv; nv++) {
          // dos largueros por nivel (frente y fondo) para que se vea la carga entre ellos
          for (var lado2 = -1; lado2 <= 1; lado2 += 2) {
            var pc = pt(lxm, lado2 * (F / 2 - 0.04));
            cajas.push(Object.assign(nuevaCaja({ x: pc[0], y: pc[1], z: ab + nv * an - 0.04, dx: ml, dy: 0.08, dz: 0.1, ang: ang, color: COLOR_VIGA, tipo: 'estructura' }), { rack: ri, lx: lxm, nivel: nv + 1 }));
            resumen.estructura++;
          }
        }
      }
    });

    // ---- cargas ----
    if (detalle && posiciones.length) {
      var posPorId = new Map();
      posiciones.forEach(function (p) { if (p && p.id != null) posPorId.set(String(p.id), p); });
      var consumidas = new Set();
      posiciones.forEach(function (p) {
        if (!esObj(p)) return;
        var id = String(p.id);
        if (consumidas.has(id)) return;
        var ri = fin(p.rackIdx, -1), r = racks[ri], inf = infoRacks[ri];
        if (!esObj(r) || !inf) return;
        var sku = por && tiene(por, id) && typeof por[id] === 'string' ? por[id] : null;
        var vacio = !sku;
        if (vacio && colorPor !== 'ocupacion') return;
        var mods = inf.mods, slots = entero(r.slotsPorModulo, 1, 20, 1), slotW = inf.largo / mods / slots;
        var lx = (fin(p.cx, 0) - inf.cx) * inf.ca + (fin(p.cy, 0) - inf.cy) * inf.sa;
        var ancho = slotW * 0.9, lxc = lx, esSpan = false;
        var sp = sku && spans && tiene(spans, id) ? spans[id] : null;
        if (sp && esObj(sp) && Array.isArray(sp.ids) && sp.ids.length >= 2 && String(sp.principal) === id) {
          var minL = Infinity, maxL = -Infinity, okS = true;
          sp.ids.forEach(function (q) {
            var pq = posPorId.get(String(q));
            if (!pq || fin(pq.rackIdx, -1) !== ri) { okS = false; return; }
            var l2 = (fin(pq.cx, 0) - inf.cx) * inf.ca + (fin(pq.cy, 0) - inf.cy) * inf.sa;
            minL = Math.min(minL, l2 - slotW / 2); maxL = Math.max(maxL, l2 + slotW / 2);
          });
          if (okS && isFinite(minL) && isFinite(maxL) && maxL > minL) {
            lxc = (minL + maxL) / 2; ancho = Math.max(slotW * 0.9, (maxL - minL) - slotW * 0.1); esSpan = true;
            sp.ids.forEach(function (q) { consumidas.add(String(q)); });
          }
        }
        var alturaLibre = Math.max(0.1, fin(p.alturaLibreM, 1.2));
        var pr = sku ? prodPorSku.get(sku) : null;
        var apil = r.tipo === 'piso' ? entero(r.apilado, 1, 10, 1) : 1;
        var alto = pr && pos(pr.altoCargaM, 0) > 0 ? pos(pr.altoCargaM, 0) * apil : alturaLibre * 0.8;
        if (r.tipo !== 'piso') alto = Math.min(alto, alturaLibre);
        if (vacio) alto = alturaLibre * 0.7;
        var z0 = r.tipo === 'piso' ? 0.03 : fin(p.alturaM, 0) + 0.06;
        var clase = sku ? claseDe(sku) : null, color;
        if (vacio) color = COLOR_VACIA;
        else if (colorPor === 'zona') { var zt = tiene(COLOR_ZONA, p.zonaTipo) ? p.zonaTipo : 'general'; color = COLOR_ZONA[zt]; zonasVistas.add(zt); }
        else if (colorPor === 'ocupacion') color = COLOR_OCUPADA;
        else color = COLOR_ABC[clase];
        var c = [inf.cx + lxc * inf.ca, inf.cy + lxc * inf.sa];
        var caja = nuevaCaja({ x: c[0], y: c[1], z: z0, dx: ancho, dy: inf.fondo * (r.tipo === 'piso' ? 0.92 : 0.86), dz: alto, ang: inf.ang, color: color, tipo: 'carga', id: id, sku: sku, clase: clase });
        caja.rack = ri; caja.lx = lxc; caja.nivel = fin(p.nivel, 1);
        if (vacio) { caja.vacio = true; caja.alpha = 0.22; resumen.vacias++; }
        else { resumen.cajasCarga++; resumen.ocupadas += esSpan ? sp.ids.length : 1; if (esSpan) { caja.span = sp.ids.length; resumen.spans++; } }   // ocupadas = POSICIONES cubiertas (un tramo de k bahías suma k), igual que los KPI
        cajas.push(caja);
      });
    }

    // ---- leyenda ----
    var leyenda = [];
    if (colorPor === 'zona') {
      Object.keys(COLOR_ZONA).forEach(function (k) { if (zonasVistas.has(k)) leyenda.push({ etiqueta: NOMBRE_ZONA[k], color: COLOR_ZONA[k] }); });
    } else if (colorPor === 'ocupacion') {
      leyenda.push({ etiqueta: 'Posición ocupada', color: COLOR_OCUPADA }, { etiqueta: 'Posición libre', color: COLOR_VACIA });
    } else {
      ['A', 'B', 'C'].forEach(function (k) { leyenda.push({ etiqueta: NOMBRE_ABC[k], color: COLOR_ABC[k] }); });
    }
    leyenda.push({ etiqueta: 'Estructura del rack', color: COLOR_VIGA });
    if (!res) avisos.push('Todavía no hay asignación: se muestra solo la estructura. Asigna ubicaciones para ver las cargas.');

    var escena = { cajas: cajas, planos: planos, limites: null, avisos: avisos, leyenda: leyenda, resumen: resumen, colorPor: colorPor, simplificada: false, racks: infoRacks };
    if (cajas.length > tope) escena = simplificar(escena, tope);
    escena.limites = calcularLimites(escena);
    return escena;
  }

  function esquinasXY(c) {
    var a = c.ang * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a), hx = c.dx / 2, hy = c.dy / 2;
    return [[-hx, -hy], [hx, -hy], [-hx, hy], [hx, hy]].map(function (q) { return [c.x + q[0] * ca - q[1] * sa, c.y + q[0] * sa + q[1] * ca]; });
  }
  function calcularLimites(escena) {
    var mnX = Infinity, mxX = -Infinity, mnY = Infinity, mxY = -Infinity, mnZ = 0, mxZ = 0;
    function p(x, y) { if (isFinite(x) && isFinite(y)) { mnX = Math.min(mnX, x); mxX = Math.max(mxX, x); mnY = Math.min(mnY, y); mxY = Math.max(mxY, y); } }
    (escena.cajas || []).forEach(function (c) { esquinasXY(c).forEach(function (q) { p(q[0], q[1]); }); if (isFinite(c.z + c.dz)) mxZ = Math.max(mxZ, c.z + c.dz); });
    (escena.planos || []).forEach(function (pl) { pl.poly.forEach(function (q) { p(q[0], q[1]); }); });
    if (!isFinite(mnX)) { mnX = 0; mxX = 1; mnY = 0; mxY = 1; }
    return { minX: mnX, maxX: mxX, minY: mnY, maxY: mxY, minZ: mnZ, maxZ: mxZ };
  }

  /**
   * Tope de rendimiento. Si hay más de `tope` cajas: la estructura de cada rack pasa a UN solo prisma (solo contorno)
   * y las cargas contiguas del mismo rack, nivel y color se fusionan en una caja larga. Si aun así sobran, se
   * conservan solo las del nivel más bajo (las más visibles) hasta el tope. Siempre avisa.
   */
  function simplificar(escena, tope) {
    tope = pos(tope, TOPE_CAJAS);
    if (!escena || escena.simplificada) return escena;
    var antes = escena.cajas.length, racks = escena.racks || [];
    var salida = [], cargas = new Map(), vistos = new Set();
    escena.cajas.forEach(function (c) {
      if (c.tipo === 'estructura') {
        if (c.marco) { salida.push(c); vistos.add(c.rack); }
        return;
      }
      if (c.tipo === 'carga' && c.rack != null && racks[c.rack] && !c.span) {
        var k = c.rack + '|' + c.nivel + '|' + c.color + '|' + (c.vacio ? 'v' : 'o') + '|' + c.z.toFixed(3) + '|' + c.dz.toFixed(3);
        if (!cargas.has(k)) cargas.set(k, []);
        cargas.get(k).push(c);
        return;
      }
      salida.push(c);
    });
    racks.forEach(function (inf, ri) {
      if (!inf || vistos.has(ri) || inf.tipo === 'piso') return;
      var o = nuevaCaja({ x: inf.cx, y: inf.cy, z: 0, dx: inf.largo, dy: inf.fondo, dz: inf.alto, ang: inf.ang, color: COLOR_POSTE, tipo: 'estructura' });
      o.rack = ri; o.lx = 0; o.marco = true; salida.push(o);
    });
    // los pisos conservan su losa fina
    escena.cajas.forEach(function (c) { if (c.tipo === 'estructura' && !c.marco && racks[c.rack] && racks[c.rack].tipo === 'piso') salida.push(c); });
    cargas.forEach(function (lista) {
      lista.sort(function (a, b) { return a.lx - b.lx; });
      var cur = null;
      lista.forEach(function (c) {
        if (cur && c.lx - c.dx / 2 - cur.lxFin <= 0.12 * c.dx + 0.02) {
          cur.lxFin = c.lx + c.dx / 2; cur.n++;
        } else {
          if (cur) salida.push(cerrarFusion(cur, racks));
          cur = { base: c, lxIni: c.lx - c.dx / 2, lxFin: c.lx + c.dx / 2, n: 1 };
        }
      });
      if (cur) salida.push(cerrarFusion(cur, racks));
    });
    var extra = [];
    if (salida.length > tope) {
      var fijas = salida.filter(function (c) { return c.tipo !== 'carga'; });
      var cg = salida.filter(function (c) { return c.tipo === 'carga'; }).sort(function (a, b) { return (a.nivel || 1) - (b.nivel || 1); });
      var cupo = Math.max(0, tope - fijas.length);
      if (cg.length > cupo) extra.push('Aun simplificada, la escena tiene demasiadas cargas: se muestran solo las ' + cupo + ' de los niveles más bajos.');
      salida = fijas.concat(cg.slice(0, cupo));
    }
    var avisos = escena.avisos.slice();
    avisos.push('La escena tenía ' + antes + ' cajas (más de ' + tope + '): se simplificó. Cada rack se dibuja como un bloque de contorno y las cargas contiguas del mismo nivel y clase se funden en una sola caja.');
    extra.forEach(function (t) { avisos.push(t); });
    var nueva = Object.assign({}, escena, { cajas: salida, avisos: avisos, simplificada: true });
    nueva.limites = calcularLimites(nueva);
    return nueva;
  }
  function cerrarFusion(cur, racks) {
    var c = cur.base;
    if (cur.n === 1) return c;
    var inf = racks[c.rack], lxm = (cur.lxIni + cur.lxFin) / 2;
    var o = nuevaCaja({ x: inf.cx + lxm * inf.ca, y: inf.cy + lxm * inf.sa, z: c.z, dx: cur.lxFin - cur.lxIni - 0.05, dy: c.dy, dz: c.dz, ang: c.ang, color: c.color, tipo: 'carga', clase: c.clase });
    o.rack = c.rack; o.nivel = c.nivel; o.lx = lxm; o.fusion = cur.n;
    if (c.vacio) { o.vacio = true; o.alpha = c.alpha; }
    return o;
  }

  /* ---------------------------------------------------------------- proyección */
  function camaraInicial() { return { azimut: 35, elev: 35, zoom: 1, panX: 0, panY: 0 }; }
  function normCam(c, ancho, alto) {
    c = esObj(c) ? c : {};
    var az = fin(c.azimut, 35) % 360; if (az < 0) az += 360;
    return {
      azimut: az, elev: Math.max(5, Math.min(90, fin(c.elev, 35))), zoom: Math.max(0.2, Math.min(60, fin(c.zoom, 1))),
      panX: fin(c.panX, 0), panY: fin(c.panY, 0), escala: pos(c.escala, 0), ancho: pos(c.ancho, ancho || 800), alto: pos(c.alto, alto || 600)
    };
  }

  var cacheRGB = new Map(), cacheSombra = new Map();
  function rgb(hex) {
    var v = cacheRGB.get(hex);
    if (v) return v;
    var m = /^#([0-9a-f]{6})$/i.exec(hex);
    v = m ? [parseInt(m[1].substr(0, 2), 16), parseInt(m[1].substr(2, 2), 16), parseInt(m[1].substr(4, 2), 16)] : [153, 153, 153];
    cacheRGB.set(hex, v);
    return v;
  }
  function sombrear(hex, f) {
    var q = Math.round(f * 40), k = hex + '|' + q, v = cacheSombra.get(k);
    if (v) return v;
    var c = rgb(hex), ff = q / 40;
    v = 'rgb(' + Math.min(255, Math.round(c[0] * ff)) + ',' + Math.min(255, Math.round(c[1] * ff)) + ',' + Math.min(255, Math.round(c[2] * ff)) + ')';
    if (cacheSombra.size > 4000) cacheSombra.clear();
    cacheSombra.set(k, v);
    return v;
  }
  var LUZ = (function () { var l = [-0.35, -0.45, 0.82], n = Math.hypot(l[0], l[1], l[2]); return [l[0] / n, l[1] / n, l[2] / n]; })();

  var CARAS = [
    { v: [1, 3, 7, 5], lado: 'x', s: 1 }, { v: [0, 2, 6, 4], lado: 'x', s: -1 },
    { v: [2, 3, 7, 6], lado: 'y', s: 1 }, { v: [0, 1, 5, 4], lado: 'y', s: -1 },
    { v: [4, 5, 7, 6], lado: 'z', s: 1 }
  ];

  /**
   * Polígonos 2D ordenados de atrás hacia delante. Cada polígono: { pts:[[x,y]×n], color, prof, tipo, id, sku, alpha, borde }.
   * Primero van los planos (suelo, zonas, huecos). El arreglo trae `.k` (px por metro), `.avisos` y `.simplificada`.
   */
  function proyectar(escena, camara) {
    var out = [];
    out.avisos = []; out.simplificada = false; out.k = 0;
    if (!esObj(escena)) return out;
    var C = normCam(camara);
    if (!Array.isArray(escena.cajas)) escena = Object.assign({}, escena, { cajas: [] });
    if (!Array.isArray(escena.planos)) escena = Object.assign({}, escena, { planos: [] });
    if (escena.cajas.length > TOPE_CAJAS && !escena.simplificada) escena = simplificar(escena, TOPE_CAJAS);
    out.avisos = (escena.avisos || []).slice(); out.simplificada = !!escena.simplificada;
    var lim = escena.limites || calcularLimites(escena);
    var th = C.azimut * Math.PI / 180, ph = C.elev * Math.PI / 180;
    var cth = Math.cos(th), sth = Math.sin(th), cph = Math.cos(ph), sph = Math.sin(ph);
    var Xc = (lim.minX + lim.maxX) / 2, Yc = -((lim.minY + lim.maxY) / 2), Zc = (lim.minZ + lim.maxZ) / 2;
    var Rh = Math.max(0.5, Math.hypot(lim.maxX - lim.minX, lim.maxY - lim.minY) / 2), Hz = Math.max(0.1, lim.maxZ - lim.minZ);
    var kfit = Math.min(C.ancho / (2 * Rh * 1.06), C.alto / (2 * Rh * sph + Hz * cph + 0.2)) * 0.92;
    var k = C.escala > 0 ? C.escala : kfit * C.zoom;
    out.k = k;
    var ox = C.ancho / 2 + C.panX, oy = C.alto / 2 + C.panY;
    // vector hacia la cámara (mundo con Y = −y_plano)
    var vd = [cph * sth, -cph * cth, sph];

    function proj(X, Y, Z, res) {
      X -= Xc; Y -= Yc; Z -= Zc;
      var xr = X * cth + Y * sth, yr = -X * sth + Y * cth;
      res[0] = ox + xr * k; res[1] = oy - (Z * cph + yr * sph) * k; res[2] = -yr * cph + Z * sph;
    }

    var tmp = [0, 0, 0];
    // planos
    escena.planos.forEach(function (pl) {
      var pts = pl.poly.map(function (q) { proj(q[0], -q[1], fin(pl.z, 0), tmp); return [tmp[0], tmp[1]]; });
      out.push({ pts: pts, color: pl.color, prof: -1e9, tipo: pl.tipo, id: null, sku: null, alpha: pl.alpha == null ? 1 : pl.alpha, borde: pl.tipo === 'suelo' });
    });

    var solidos = [];
    var ps = new Array(8);
    for (var j = 0; j < 8; j++) ps[j] = [0, 0, 0];
    escena.cajas.forEach(function (c, idx) {
      var a = c.ang * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a), hx = c.dx / 2, hy = c.dy / 2;
      if (!isFinite(c.x + c.y + c.z + hx + hy + c.dz + ca)) return;
      for (var i = 0; i < 8; i++) {
        var lx = (i & 1) ? hx : -hx, ly = (i & 2) ? hy : -hy, lz = (i & 4) ? c.z + c.dz : c.z;
        var X = c.x + lx * ca - ly * sa, Yp = c.y + lx * sa + ly * ca;
        proj(X, -Yp, lz, ps[i]);
      }
      var vx = vd[0] * ca - vd[1] * sa, vy = -vd[0] * sa - vd[1] * ca, vz = vd[2];
      proj(c.x, -c.y, c.z + c.dz / 2, tmp);
      var prof = tmp[2];
      var nx = [ca, -sa, 0], ny = [-sa, -ca, 0];
      var caras = [];
      CARAS.forEach(function (f) {
        var d = f.lado === 'x' ? vx * f.s : f.lado === 'y' ? vy * f.s : vz;
        if (d <= 1e-9) return;
        var n = f.lado === 'x' ? [nx[0] * f.s, nx[1] * f.s, 0] : f.lado === 'y' ? [ny[0] * f.s, ny[1] * f.s, 0] : [0, 0, 1];
        var luz = Math.max(0, n[0] * LUZ[0] + n[1] * LUZ[1] + n[2] * LUZ[2]);
        var pts = f.v.map(function (iv) { return [ps[iv][0], ps[iv][1]]; });
        caras.push({ pts: pts, color: sombrear(c.color, 0.5 + 0.5 * luz) });
      });
      if (caras.length) solidos.push({ c: c, prof: prof, idx: idx, caras: caras });
    });
    solidos.sort(function (p, q) { return p.prof - q.prof || p.c.z - q.c.z || p.idx - q.idx; });
    solidos.forEach(function (s) {
      var c = s.c;
      s.caras.forEach(function (f) {
        out.push({ pts: f.pts, color: f.color, prof: s.prof, tipo: c.tipo, id: c.id, sku: c.sku, alpha: c.alpha == null ? 1 : c.alpha, borde: true, marco: !!c.marco });
      });
    });
    return out;
  }

  /* ---------------------------------------------------------------- pintado */
  var PALETA_CLARA = { fondo: '#f4f6fa', suelo: '#e4e9f1', zona: '#7a8aa0', hueco: '#b7c0cd', linea: 'rgba(20,30,50,.30)', texto: '#18212c' };
  var PALETA_OSCURA = { fondo: '#10161d', suelo: '#222c38', zona: '#7a8aa0', hueco: '#3a4757', linea: 'rgba(0,0,0,.55)', texto: '#e7ecf3' };
  function dibujar(ctx, ancho, alto, polys, opciones) {
    var op = esObj(opciones) ? opciones : {};
    var pal = Object.assign({}, op.oscuro ? PALETA_OSCURA : PALETA_CLARA, esObj(op.paleta) ? op.paleta : {});
    ctx.save();
    ctx.fillStyle = pal.fondo; ctx.fillRect(0, 0, ancho, alto);
    ctx.lineJoin = 'round'; ctx.lineWidth = 0.6; ctx.strokeStyle = pal.linea;
    var rapido = !!op.rapido;
    var n = polys ? polys.length : 0;
    for (var i = 0; i < n; i++) {
      var p = polys[i], pts = p.pts;
      if (!pts || pts.length < 3) continue;
      ctx.globalAlpha = p.alpha == null ? 1 : p.alpha;
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (var j = 1; j < pts.length; j++) ctx.lineTo(pts[j][0], pts[j][1]);
      ctx.closePath();
      if (!p.marco) { ctx.fillStyle = p.color || pal[p.tipo] || '#cccccc'; ctx.fill(); }
      if (p.borde && !(rapido && p.tipo === 'carga')) { ctx.strokeStyle = p.marco ? 'rgba(47,95,168,.8)' : pal.linea; ctx.stroke(); }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /** Título y leyenda sobre la imagen (para el PNG). */
  function dibujarRotulo(ctx, ancho, alto, titulo, leyenda, opciones) {
    var op = esObj(opciones) ? opciones : {};
    var pal = op.oscuro ? PALETA_OSCURA : PALETA_CLARA;
    var u = Math.max(10, Math.round(Math.min(ancho, alto) / 55));
    ctx.save();
    ctx.textBaseline = 'top'; ctx.fillStyle = pal.texto; ctx.font = '600 ' + Math.round(u * 1.5) + 'px system-ui, sans-serif';
    if (titulo) ctx.fillText(String(titulo).slice(0, 120), u, u);
    ctx.font = Math.round(u * 1.05) + 'px system-ui, sans-serif';
    var y = alto - u * 1.9 * ((leyenda || []).length) - u * 0.5;
    (leyenda || []).forEach(function (it, i) {
      var yy = y + i * u * 1.9;
      ctx.fillStyle = it.color; ctx.fillRect(u, yy, u * 1.4, u * 1.2);
      ctx.fillStyle = pal.texto; ctx.fillText(String(it.etiqueta), u * 3, yy);
    });
    ctx.restore();
  }

  /* ---------------------------------------------------------------- controlador con el dedo / mouse (único código con DOM) */
  function conectar(canvas, opciones) {
    var op = esObj(opciones) ? opciones : {};
    var ctrl = { cam: camaraInicial(), escena: null, destruido: false };
    var pun = new Map(), previo = null, pendiente = false;
    var oscuro = typeof op.oscuro === 'function' ? op.oscuro : function () { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); };

    function tam() {
      var r = canvas.getBoundingClientRect();
      return { w: Math.max(50, Math.round(r.width)), h: Math.max(50, Math.round(r.height)) };
    }
    function pintar(rapido) {
      if (ctrl.destruido) return;
      var t = tam(), dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(t.w * dpr) || canvas.height !== Math.round(t.h * dpr)) { canvas.width = Math.round(t.w * dpr); canvas.height = Math.round(t.h * dpr); }
      var g = canvas.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      var polys = ctrl.escena ? proyectar(ctrl.escena, Object.assign({}, ctrl.cam, { ancho: t.w, alto: t.h })) : [];
      dibujar(g, t.w, t.h, polys, { oscuro: oscuro(), rapido: !!rapido && polys.length > 6000 });
      canvas.setAttribute('data-poligonos', String(polys.length));
      canvas.setAttribute('data-azimut', ctrl.cam.azimut.toFixed(1));
      canvas.setAttribute('data-elev', ctrl.cam.elev.toFixed(1));
      canvas.setAttribute('data-zoom', ctrl.cam.zoom.toFixed(2));
      if (typeof op.alCambiar === 'function') op.alCambiar(ctrl.cam);
    }
    ctrl.redibujar = function (rapido) {
      if (pendiente) return;
      pendiente = true;
      requestAnimationFrame(function () { pendiente = false; pintar(rapido); });
    };
    ctrl.poner = function (escena) { ctrl.escena = escena; ctrl.redibujar(); };
    ctrl.reiniciar = function () { ctrl.cam = camaraInicial(); ctrl.redibujar(); };
    ctrl.girar = function (dAz, dEl) { ctrl.cam = normCam(Object.assign({}, ctrl.cam, { azimut: ctrl.cam.azimut + dAz, elev: ctrl.cam.elev + dEl })); ctrl.redibujar(true); };
    ctrl.zoomear = function (f) { ctrl.cam = normCam(Object.assign({}, ctrl.cam, { zoom: ctrl.cam.zoom * f })); ctrl.redibujar(true); };
    ctrl.png = function (titulo, ancho, alto) {
      return new Promise(function (resolve) {
        var w = ancho || 1600, h = alto || 1000, c = document.createElement('canvas');
        c.width = w; c.height = h;
        var g = c.getContext('2d'), os = oscuro();
        var polys = ctrl.escena ? proyectar(ctrl.escena, Object.assign({}, ctrl.cam, { ancho: w, alto: h })) : [];
        dibujar(g, w, h, polys, { oscuro: os });
        dibujarRotulo(g, w, h, titulo, ctrl.escena ? ctrl.escena.leyenda : [], { oscuro: os });
        c.toBlob(function (b) { resolve(b); }, 'image/png');
      });
    };

    function onDown(e) {
      canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
      pun.set(e.pointerId, { x: e.clientX, y: e.clientY });
      previo = null;
      try { canvas.focus({ preventScroll: true }); } catch (x) { /* nada */ }
    }
    function onMove(e) {
      var p = pun.get(e.pointerId);
      if (!p) return;
      var dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (pun.size >= 2) {
        var ids = Array.from(pun.values()), d = Math.hypot(ids[0].x - ids[1].x, ids[0].y - ids[1].y), mx = (ids[0].x + ids[1].x) / 2, my = (ids[0].y + ids[1].y) / 2;
        if (previo && previo.d > 0 && d > 0) {
          ctrl.cam = normCam(Object.assign({}, ctrl.cam, { zoom: ctrl.cam.zoom * d / previo.d, panX: ctrl.cam.panX + (mx - previo.mx), panY: ctrl.cam.panY + (my - previo.my) }));
          ctrl.redibujar(true);
        }
        previo = { d: d, mx: mx, my: my };
        return;
      }
      if (e.shiftKey || e.buttons === 2 || e.buttons === 4) { ctrl.cam = normCam(Object.assign({}, ctrl.cam, { panX: ctrl.cam.panX + dx, panY: ctrl.cam.panY + dy })); ctrl.redibujar(true); }
      else ctrl.girar(-dx * 0.45, dy * 0.35);
      e.preventDefault();
    }
    function onUp(e) { pun.delete(e.pointerId); previo = null; ctrl.redibujar(false); }
    function onWheel(e) { e.preventDefault(); ctrl.zoomear(Math.exp(-e.deltaY * 0.0015)); clearTimeout(ctrl._t); ctrl._t = setTimeout(function () { ctrl.redibujar(false); }, 120); }
    function onKey(e) {
      var k = e.key, hecho = true;
      if (k === 'ArrowLeft') ctrl.girar(-10, 0); else if (k === 'ArrowRight') ctrl.girar(10, 0);
      else if (k === 'ArrowUp') ctrl.girar(0, 5); else if (k === 'ArrowDown') ctrl.girar(0, -5);
      else if (k === '+' || k === '=') ctrl.zoomear(1.2); else if (k === '-' || k === '_') ctrl.zoomear(1 / 1.2);
      else if (k === '0') ctrl.reiniciar(); else hecho = false;
      if (hecho) e.preventDefault();
    }
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('keydown', onKey);
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    var ro = typeof ResizeObserver === 'function' ? new ResizeObserver(function () { ctrl.redibujar(false); }) : null;
    if (ro) ro.observe(canvas);
    ctrl.destruir = function () {
      ctrl.destruido = true;
      canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel); canvas.removeEventListener('keydown', onKey);
      if (ro) ro.disconnect();
    };
    return ctrl;
  }

  return {
    construirEscena: construirEscena,
    proyectar: proyectar,
    dibujar: dibujar,
    dibujarRotulo: dibujarRotulo,
    simplificar: simplificar,
    conectar: conectar,
    camaraInicial: camaraInicial,
    TOPE_CAJAS: TOPE_CAJAS,
    COLOR_ABC: COLOR_ABC
  };
});
