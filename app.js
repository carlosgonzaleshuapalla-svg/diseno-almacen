/* Diseñador de Almacén — lógica de interfaz.
   Script clásico (sin módulos). Usa window.AlmacenMotor (motor.js) para todo el cálculo.
   Unidades: metros; y crece hacia abajo. */
(function () {
'use strict';

var M = window.AlmacenMotor;
var $ = function (s, r) { return (r || document).querySelector(s); };
var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

if (!M) {
  document.addEventListener('DOMContentLoaded', function () {
    var d = document.createElement('div');
    d.className = 'alerta';
    d.style.margin = '20px';
    d.textContent = 'No se pudo cargar motor.js. Verifica que el archivo esté en la misma carpeta que index.html.';
    document.body.insertBefore(d, document.body.firstChild);
  });
  return;
}

/* ------------------------------------------------------------------ utilidades */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function fmt(n, d) {   // coma decimal y espacio fino como separador de miles (igual que los textos del motor)
  if (n == null || typeof n !== 'number' || !isFinite(n)) return '—';
  d = d == null ? 1 : d;
  var s = Math.abs(n).toFixed(d), p = s.split('.');
  p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
  return (n < 0 && Number(s) !== 0 ? '−' : '') + p.join(',');
}
function num(v, def) {
  if (v == null) return def;
  var x = parseFloat(String(v).replace(',', '.'));
  return isFinite(x) ? x : def;
}
function N(x) { x = Number(x); return isFinite(x) ? x : 0; }   // número seguro para HTML
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function esperar(ms) { return new Promise(function (r) { setTimeout(r, ms == null ? 20 : ms); }); }
function hoy() { var d = new Date(); return d.toLocaleDateString('es-PE') + ' ' + d.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' }); }
function slug(s) { return String(s || 'almacen').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'almacen'; }
function clonar(o) { return JSON.parse(JSON.stringify(o)); }

var NOMBRES_TIPO_HUECO = { columna: 'Columna', muro: 'Muro', oficina: 'Oficina', equipo: 'Equipo', otro: 'Otro' };
var NOMBRES_ZONA = { general: 'General', frio: 'Frío', peligrosos: 'Peligrosos', alto_valor: 'Alto valor', cuarentena: 'Cuarentena', almacenaje: 'Almacenaje (con su propia configuración)', muelle: 'Muelle (andén)', staging: 'Staging (zona de preparación)' };
var NOMBRES_PUERTA = { recepcion: 'Recepción', despacho: 'Despacho', mixta: 'Mixta', salida_emergencia: 'Salida de emergencia' };
var TIPOS_UBIC = ['palet', 'bin', 'piso', 'cantilever'];
var NOMBRES_UBIC = { palet: 'Palet', bin: 'Bin (bandeja)', piso: 'Piso (carril de bloque)', cantilever: 'Cantilever (carga larga)' };
var PELIGROS = ['inflamable', 'oxidante', 'corrosivo_acido', 'corrosivo_base', 'bateria_litio', 'toxico', 'alimento'];
var NOMBRES_PELIGRO = { inflamable: 'Inflamable', oxidante: 'Oxidante', corrosivo_acido: 'Corrosivo ácido', corrosivo_base: 'Corrosivo base', bateria_litio: 'Batería de litio', toxico: 'Tóxico', alimento: 'Alimento' };
var EQUIPOS_VALIDOS = ['manual', 'transpaleta', 'apilador', 'retractil', 'contrapesado', 'vna'];
var NOMBRES_MOTIVO = {
  nivel_pesado: 'Carga pesada: solo cabe hasta cierto nivel y no quedan', inaccesible: 'Las posiciones compatibles no son accesibles desde las puertas', sin_asignar: 'Falta asignar a mano',
  capacidad: 'No hay posiciones libres suficientes', peso: 'Ninguna posición soporta el peso', altura: 'Ninguna posición tiene la altura necesaria', zona: 'No hay posiciones en la zona exigida',
  tipo: 'No hay posiciones del tipo de ubicación pedido', incompatibilidad: 'Incompatible con los vecinos disponibles', duplicado: 'SKU repetido', datos: 'Datos inválidos',
  carga_modulo: 'Se superaría la carga máxima del módulo (dato suyo, según placa del fabricante)', lifo: 'FEFO exige una ubicación sin LIFO y solo hay posiciones LIFO', fefo_lifo: 'FEFO exige una ubicación sin LIFO y solo hay posiciones LIFO',
  segregacion: 'Segregación por peligro: no hay lugar a la distancia mínima de los incompatibles', largo: 'La carga es más larga que la bahía cantilever', apilado: 'El apilado pedido supera lo que permite la carga', crossdock: 'Cross-docking: no ocupa rack'
};
function ymdValido(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v; }
function ymdHoy() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
var NOMBRES_EQUIPO = Object.assign({ manual: 'Manual (persona o carro de picking)', apilador: 'Apilador', retractil: 'Retráctil', contrapesado: 'Contrapesado', vna: 'VNA' }, M.NOMBRES_EQUIPO || {});
var PRESETS_EQUIPO = M.PRESETS_EQUIPO || { manual: 1.2, apilador: 2.4, retractil: 2.9, contrapesado: 3.6, vna: 1.8 };
function llenarEquipos() {
  var sel = $('#sel-equipo');
  if (!sel) return;
  sel.innerHTML = Object.keys(PRESETS_EQUIPO).map(function (k) { return '<option value="' + esc(k) + '">' + esc(NOMBRES_EQUIPO[k] || k) + ' · pasillo típico ' + esc(fmt(Number(PRESETS_EQUIPO[k]), 1)) + ' m</option>'; }).join('');
}

/* ------------------------------------------------------------------ estado */
var S = {
  proy: null,
  tab: 'plano',
  herr: 'seleccionar',
  v: { k: 12, ox: 40, oy: 40 },
  sel: null,            // {tipo:'contorno'|'hueco'|'puerta'|'zona'|'rack', id}
  selVert: null,
  hover: null,
  rackElev: null,       // id del rack mostrado en la elevación
  rackHover: null,
  posSel: null,         // id de la posición seleccionada
  moviendo: null,       // id de posición origen mientras se elige destino
  vistaMapa: 'abc',
  busqueda: null,       // {sku, posIds, ruta, rutaRec, info}
  calib: null,          // {pts:[[px,py],...]}
  traza: null,          // {semilla, res, pendiente}
  dib: null,            // dibujo en curso
  cursor: null,
  espacio: false,
  drag: null,
  img: null,
  pix: null,
  undo: [], redo: [],
  ver: 0,
  genInfo: null,
  valid: null,
  validVer: -1,
  pagArt: 0,
  filtroArt: '',
  ocupado: false,
  guardadoEn: null,
  opcionesCambiadas: false,
  erroresCSV: null,
  artSel: null,         // índice del artículo abierto en «Avanzado»
  capas: { evac: false, rol: false, carga: false }   // capas conmutables del plano (v1.1)
};
var C = {};   // cachés por clave
/* Diccionario sin prototipo: las claves vienen de datos (SKU, ids) y no deben chocar con 'constructor', 'toString', '__proto__'… */
function dic() { return Object.create(null); }
function protegerResultado(res) {
  ['porPosicion', 'rolPorPosicion', 'lotePorPosicion'].forEach(function (key) {
    if (res && res[key] && typeof res[key] === 'object' && Object.getPrototypeOf(res[key]) !== null) res[key] = Object.assign(dic(), res[key]);
  });
  return res;
}
function cache(nombre, clave, fn) {
  var c = C[nombre];
  if (c && c.clave === clave) return c.val;
  var val = fn();
  C[nombre] = { clave: clave, val: val };
  return val;
}
function tocar() { S.ver++; }

/* Saneamiento de proyectos externos (archivo .json, autoguardado, historial): fuerza el tipo de cada campo. */
function nn(v, def) {
  if (typeof v === 'number') return isFinite(v) ? v : def;
  if (typeof v === 'string' && v.trim() !== '' && v.length < 40) { var x = Number(v); return isFinite(x) ? x : def; }
  return def;
}
function ss(v, def, max) {
  if (v == null) return def;
  if (typeof v === 'object') return def;
  return String(v).slice(0, max || 200);
}
function enLista(v, lista, def) { v = ss(v, '', 40); return lista.indexOf(v) >= 0 ? v : def; }
function polyLimpio(poly) {
  if (!Array.isArray(poly)) return [];
  var out = [];
  poly.slice(0, 5000).forEach(function (pt) {
    if (Array.isArray(pt) && pt.length >= 2) {
      var x = nn(pt[0], null), y = nn(pt[1], null);
      if (x !== null && y !== null) out.push([x, y]);
    }
  });
  return out;
}
function arr(v, max) { return Array.isArray(v) ? v.slice(0, max || 100000) : []; }
function mapaStr(o, max) {
  var out = dic(), n = 0;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
  Object.keys(o).forEach(function (k) {
    if (n >= max) return;
    if (typeof o[k] === 'string' || typeof o[k] === 'number') { out[k] = String(o[k]).slice(0, 100); n++; }
  });
  return out;
}
function planoPrimitivo(o) {
  var out = {}, n = 0;
  Object.keys(o).forEach(function (key) {
    if (n >= 40 || key === '__proto__' || !/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(key)) return;
    var v = o[key];
    if (v === null || typeof v === 'boolean') { out[key] = v; n++; }
    else if (typeof v === 'number') { out[key] = isFinite(v) ? v : null; n++; }
    else if (typeof v === 'string') { out[key] = v.slice(0, 120); n++; }
  });
  return out;
}
function sanearResultado(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  if (!r.kpis || typeof r.kpis !== 'object' || !r.porPosicion || typeof r.porPosicion !== 'object') return null;
  var o = {};
  o.generadoEn = (typeof r.generadoEn === 'string' && !isNaN(Date.parse(r.generadoEn))) ? r.generadoEn.slice(0, 40) : '';
  o.asignaciones = arr(r.asignaciones).map(function (a) {
    a = a && typeof a === 'object' ? a : {};
    return {
      sku: ss(a.sku, ''), clase: enLista(a.clase, ['A', 'B', 'C'], 'C'), posReq: nn(a.posReq, 0), costo: nn(a.costo, 0), dDespMedia: nn(a.dDespMedia, null),
      posiciones: arr(a.posiciones).map(function (id) { return ss(id, '', 80); })
    };
  });
  o.porPosicion = mapaStr(r.porPosicion, 200000);
  o.sinUbicar = arr(r.sinUbicar).map(function (s) {
    s = s && typeof s === 'object' ? s : {};
    return { sku: ss(s.sku, ''), faltan: nn(s.faltan, 0), motivo: ss(s.motivo, '', 40), detalle: ss(s.detalle, '', 400) };
  });
  var k = {};
  Object.keys(r.kpis).forEach(function (key) {
    if (key === '__proto__' || key === 'porClase') return;
    var v = r.kpis[key];
    if (v === null || typeof v === 'number') k[key] = nn(v, null);
    else if (typeof v === 'string') k[key] = ss(v, '', 80);
    else if (typeof v === 'boolean') k[key] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v) && /^[A-Za-z_]{1,40}$/.test(key)) k[key] = planoPrimitivo(v);
  });
  var pc = r.kpis.porClase;
  if (pc && typeof pc === 'object') {
    k.porClase = {};
    ['A', 'B', 'C'].forEach(function (c) {
      var x = pc[c];
      if (x && typeof x === 'object') k.porClase[c] = { skus: nn(x.skus, 0), posiciones: nn(x.posiciones, 0), distMedia: nn(x.distMedia, null) };
    });
  }
  o.kpis = k;
  /* v1.1 */
  var rp = dic();
  if (r.rolPorPosicion && typeof r.rolPorPosicion === 'object') Object.keys(r.rolPorPosicion).slice(0, 200000).forEach(function (id) { var v = r.rolPorPosicion[id]; if (v === 'picking' || v === 'reserva') rp[id] = v; });
  o.rolPorPosicion = rp;
  var lp = dic();
  if (r.lotePorPosicion && typeof r.lotePorPosicion === 'object') Object.keys(r.lotePorPosicion).slice(0, 200000).forEach(function (id) {
    var v = r.lotePorPosicion[id]; if (v && typeof v === 'object') lp[id] = { lote: ss(v.lote, '', 40), cantidad: nn(v.cantidad, 0), vence: ymdValido(v.vence) ? v.vence : null };
  });
  o.lotePorPosicion = lp;
  o.vencimientos = arr(r.vencimientos, 5000).map(function (v) {
    v = v && typeof v === 'object' ? v : {};
    return { sku: ss(v.sku, ''), lote: ss(v.lote, '', 40), vence: ymdValido(v.vence) ? v.vence : null, diasRestantes: nn(v.diasRestantes, null) };
  });
  var b = r.baseline && typeof r.baseline === 'object' ? r.baseline : {};
  o.baseline = { descripcion: ss(b.descripcion, '', 300), costoTotal: nn(b.costoTotal, null), distMediaPonderada: nn(b.distMediaPonderada, null) };
  o.mejoraPct = nn(r.mejoraPct, null);
  o.supuestos = arr(r.supuestos, 200).map(function (t) { return ss(t, '', 600); });
  o.advertencias = arr(r.advertencias, 200).map(function (t) { return ss(t, '', 600); });
  o.modificadoManual = r.modificadoManual === true;
  ['mejoraNota', 'mejoraCausa', 'comparable'].forEach(function (key) {
    if (typeof r[key] === 'string') o[key] = r[key].slice(0, 400); else if (typeof r[key] === 'boolean') o[key] = r[key];
  });
  return o;
}
function nnPos(v) { var x = nn(v, null); return x !== null && x >= 0 ? x : null; }
function nnPosEstricto(v) { var x = nn(v, null); return x !== null && x > 0 ? x : null; }
function lotesLimpios(l) {
  return arr(l, 200).map(function (x) {
    x = x && typeof x === 'object' ? x : {};
    return { lote: ss(x.lote, '', 40), cantidad: Math.max(0, nn(x.cantidad, 0)), vence: ymdValido(x.vence) ? x.vence : null };
  }).filter(function (x) { return x.lote !== '' || x.cantidad > 0; });
}
function pedidosLimpios(ped) {
  var total = 0;
  return arr(ped, 20000).map(function (o, i) {
    o = o && typeof o === 'object' ? o : {};
    var ls = arr(o.lineas, 500).map(function (l) {
      l = l && typeof l === 'object' ? l : {};
      var sku = ss(l.sku, '', 60), c = nn(l.cant, null);
      return sku === '' ? null : (c !== null && c > 0 ? { sku: sku, cant: c } : { sku: sku });
    }).filter(Boolean);
    total += ls.length;
    return total > 200000 ? null : { id: ss(o.id, 'P' + (i + 1), 40), lineas: ls };
  }).filter(function (o) { return o && o.lineas.length; });
}
function matrizSegLimpia(m) {
  if (!Array.isArray(m)) return null;
  var out = [];
  m.slice(0, 100).forEach(function (e) {
    e = e && typeof e === 'object' ? e : {};
    var a = enLista(e.a, PELIGROS, null), b = enLista(e.b, PELIGROS, null);
    if (!a || !b) return;
    var d = nn(e.distMinM, null);
    out.push({ a: a, b: b, distMinM: d !== null && d >= 0 ? clamp(d, 0, 500) : null });
  });
  return out;
}
function cfgZonaLimpia(c) {
  c = c && typeof c === 'object' && !Array.isArray(c) ? c : {};
  var o = {}, v;
  if (c.equipo != null) { v = enLista(c.equipo, EQUIPOS_VALIDOS, null); if (v) o.equipo = v; }
  if (c.tipo != null) { v = enLista(c.tipo, TIPOS_UBIC, null); if (v) o.tipo = v; }
  [['anchoPasillo', 0.5, 12], ['altoNivel', 0.05, 20], ['fondo', 0.1, 50], ['largoModulo', 0.3, 50]].forEach(function (d) {
    v = nn(c[d[0]], null); if (v !== null) o[d[0]] = clamp(v, d[1], d[2]);
  });
  [['niveles', 1, 30], ['slotsPorModulo', 1, 20], ['profundidadPalets', 1, 50], ['apilado', 1, 10]].forEach(function (d) {
    v = nn(c[d[0]], null); if (v !== null) o[d[0]] = Math.round(clamp(v, d[1], d[2]));
  });
  return o;
}
function proyectoNormalizado(p) {
  var base = M.crearProyectoVacio();
  if (!p || typeof p !== 'object' || Array.isArray(p)) p = {};
  var r = {};
  r.version = 2;   // migración v1 → v2 sin pérdida: los campos nuevos toman valores que reproducen v1.0
  r.nombre = ss(p.nombre, '', 120) || 'Almacén sin nombre';
  var pl = p.plano && typeof p.plano === 'object' ? p.plano : {};
  var im = (typeof pl.imagen === 'string' && /^data:image\/(png|jpeg|jpg|gif|webp|bmp);base64,[A-Za-z0-9+\/=]*$/i.test(pl.imagen)) ? pl.imagen : null;
  var mpp = nn(pl.mPorPx, null);
  r.plano = {
    imagen: im, anchoPx: clamp(nn(pl.anchoPx, 0), 0, 20000), altoPx: clamp(nn(pl.altoPx, 0), 0, 20000),
    mPorPx: mpp !== null && mpp > 0 ? mpp : null, x0: nn(pl.x0, 0), y0: nn(pl.y0, 0), opacidad: clamp(nn(pl.opacidad, 0.5), 0, 1)
  };
  r.contorno = polyLimpio(p.contorno);
  r.huecos = arr(p.huecos, 2000).map(function (h, i) {
    h = h && typeof h === 'object' ? h : {};
    var oh = { id: ss(h.id, 'H' + (i + 1), 40), tipo: enLista(h.tipo, Object.keys(NOMBRES_TIPO_HUECO), 'otro'), poly: polyLimpio(h.poly) };
    if (h.auto === true) oh.auto = true;
    return oh;
  }).filter(function (h) { return h.poly.length >= 3; });
  r.puertas = arr(p.puertas, 200).map(function (d, i) {
    d = d && typeof d === 'object' ? d : {};
    return { id: ss(d.id, 'P' + (i + 1), 40), nombre: ss(d.nombre, 'Puerta ' + (i + 1), 80), tipo: enLista(d.tipo, Object.keys(NOMBRES_PUERTA), 'mixta'), x: nn(d.x, 0), y: nn(d.y, 0) };
  });
  r.zonas = arr(p.zonas, 500).map(function (z, i) {
    z = z && typeof z === 'object' ? z : {};
    var oz = { id: ss(z.id, 'Z' + (i + 1), 40), nombre: ss(z.nombre, 'Zona ' + (i + 1), 80), tipo: enLista(z.tipo, Object.keys(NOMBRES_ZONA), 'general'), poly: polyLimpio(z.poly) };
    if (oz.tipo === 'almacenaje') oz.cfg = cfgZonaLimpia(z.cfg);
    return oz;
  }).filter(function (z) { return z.poly.length >= 3; });
  r.racks = arr(p.racks, 20000).map(function (k, i) {
    k = k && typeof k === 'object' ? k : {};
    var tipo = enLista(k.tipo, TIPOS_UBIC, 'palet');
    var o = {
      id: ss(k.id, 'R' + (i + 1), 40), nombre: ss(k.nombre, 'R' + (i + 1), 80),
      cx: nn(k.cx, 0), cy: nn(k.cy, 0), ang: nn(k.ang, 0),
      largo: clamp(nn(k.largo, 2.7), 0.1, 500), fondo: clamp(nn(k.fondo, 1.1), 0.1, 50),
      modulos: Math.round(clamp(nn(k.modulos, 1), 1, 1000)), niveles: Math.round(clamp(nn(k.niveles, 1), 1, 30)), slotsPorModulo: Math.round(clamp(nn(k.slotsPorModulo, 1), 1, 20)),
      altoNivel: clamp(nn(k.altoNivel, tipo === 'bin' ? 0.45 : 1.6), 0.05, 20), altoBase: clamp(nn(k.altoBase, 0.15), 0, 5),
      cargaMaxKg: clamp(nn(k.cargaMaxKg, 1000), 0, 1e6), tipo: tipo, frente: enLista(k.frente, ['A', 'B'], 'A'), auto: k.auto === true,
      equipo: enLista(k.equipo, EQUIPOS_VALIDOS, null), anchoPasillo: (function () { var a = nnPosEstricto(k.anchoPasillo); return a === null ? null : clamp(a, 0.5, 12); })(),
      cargaMaxModuloKg: (function () { var a = nnPosEstricto(k.cargaMaxModuloKg); return a === null ? null : Math.min(a, 1e7); })(),
      profundidadPalets: Math.round(clamp(nn(k.profundidadPalets, 1), 1, 50)), apilado: Math.round(clamp(nn(k.apilado, 1), 1, 10)), zonaId: k.zonaId == null ? null : ss(k.zonaId, null, 40)
    };
    return o;
  });
  var c = p.config && typeof p.config === 'object' ? p.config : {};
  var cfg = {};
  Object.keys(base.config).forEach(function (key) {
    var d = base.config[key];
    if (key === 'abc') return;
    if (typeof d === 'number') cfg[key] = nn(c[key], d);
    else if (typeof d === 'string') cfg[key] = /^[a-z_]{1,24}$/.test(String(c[key])) ? String(c[key]) : d;
    else if (typeof d === 'boolean') cfg[key] = typeof c[key] === 'boolean' ? c[key] : d;
  });
  Object.keys(c).forEach(function (key) {   // claves nuevas que el motor pueda añadir
    if (key in cfg || key === 'abc' || key === '__proto__' || !/^[A-Za-z]{1,30}$/.test(key)) return;
    var v = c[key];
    if (typeof v === 'number' && isFinite(v)) cfg[key] = v;
    else if (typeof v === 'string' && /^[a-z_]{1,24}$/.test(v)) cfg[key] = v;
    else if (typeof v === 'boolean') cfg[key] = v;
  });
  var ab = c.abc && typeof c.abc === 'object' ? c.abc : {}, ab0 = base.config.abc || { a: 0.8, b: 0.95 };
  cfg.abc = { a: clamp(nn(ab.a, ab0.a), 0.01, 1), b: clamp(nn(ab.b, ab0.b), 0.01, 1) };
  /* v1.1: claves que pueden ser nulas (dato del usuario) o ser objetos */
  cfg.dimensionarPor = enLista(c.dimensionarPor, ['actual', 'maximo'], 'actual');
  cfg.reposicion = { activa: !!(c.reposicion && typeof c.reposicion === 'object' && c.reposicion.activa === true), posicionesPicking: Math.round(clamp(nn(c.reposicion && c.reposicion.posicionesPicking, 1), 1, 10)) };
  var sg = c.segregacion && typeof c.segregacion === 'object' ? c.segregacion : {};
  cfg.segregacion = { usar: sg.usar !== false, matriz: matrizSegLimpia(sg.matriz) };
  cfg.pesoAfinidad = clamp(nn(c.pesoAfinidad, 0.3), 0, 1);
  cfg.fechaReferencia = ymdValido(c.fechaReferencia) ? c.fechaReferencia : null;
  var dav = nn(c.diasAlertaVencimiento, null); cfg.diasAlertaVencimiento = dav !== null && dav >= 0 ? Math.round(Math.min(dav, 3650)) : null;
  cfg.evacMaxM = nnPosEstricto(c.evacMaxM); cfg.anchoEvacuacionMin = nnPosEstricto(c.anchoEvacuacionMin); cfg.cargaPisoMaxKgM2 = nnPosEstricto(c.cargaPisoMaxKgM2);
  var mu = c.muelle && typeof c.muelle === 'object' ? c.muelle : {};
  cfg.muelle = {
    palletsDiaRecepcion: nnPos(mu.palletsDiaRecepcion), palletsDiaDespacho: nnPos(mu.palletsDiaDespacho),
    diasPermanenciaRec: clamp(nn(mu.diasPermanenciaRec, 1), 0, 365), diasPermanenciaDesp: clamp(nn(mu.diasPermanenciaDesp, 1), 0, 365),
    m2PorPalet: nnPosEstricto(mu.m2PorPalet), factorManiobra: nnPosEstricto(mu.factorManiobra)
  };
  r.config = cfg;
  r.productos = arr(p.productos, 50000).map(function (q) {
    q = q && typeof q === 'object' ? q : {};
    var inc = Array.isArray(q.incompatibleCon) ? q.incompatibleCon.slice(0, 50).map(function (f) { return ss(f, '', 60); }).filter(Boolean) : [];
    var ent = nn(q.entradas, null);
    return {
      sku: ss(q.sku, '', 60), descripcion: ss(q.descripcion, '', 200), familia: ss(q.familia, '', 60),
      cantidad: Math.max(0, nn(q.cantidad, 0)), unidadesPorUbic: Math.max(0, nn(q.unidadesPorUbic, 1)), picks: Math.max(0, nn(q.picks, 0)),
      entradas: ent === null ? null : Math.max(0, ent), pesoUnitKg: Math.max(0, nn(q.pesoUnitKg, 0)), altoCargaM: Math.max(0, nn(q.altoCargaM, 0)),
      tipoUbic: enLista(q.tipoUbic, TIPOS_UBIC, 'palet'),
      requiereZona: enLista(q.requiereZona, ['frio', 'peligrosos', 'alto_valor', 'cuarentena'], null), incompatibleCon: inc,
      /* v1.1 (todos opcionales; los valores por defecto reproducen v1.0) */
      stockMax: nnPos(q.stockMax), picksPico: nnPos(q.picksPico), unidadesPorLinea: nnPos(q.unidadesPorLinea),
      peligro: enLista(q.peligro, PELIGROS, null), fefo: q.fefo === true || q.fefo === 'true', crossdock: q.crossdock === true || q.crossdock === 'true',
      flujoCrossdock: nnPos(q.flujoCrossdock), largoM: nnPos(q.largoM), apilableMax: Math.round(clamp(nn(q.apilableMax, 1), 1, 20)),
      lotes: lotesLimpios(q.lotes)
    };
  });
  r.pedidos = pedidosLimpios(p.pedidos);
  r.resultado = sanearResultado(p.resultado);
  return r;
}

function nuevoId(arr, pref) {
  var mx = 0;
  arr.forEach(function (e) {
    var m = String(e.id || '').match(/(\d+)$/);
    if (m) mx = Math.max(mx, parseInt(m[1], 10));
  });
  var n = mx + 1, id;
  do { id = pref + n; n++; } while (arr.some(function (e) { return e.id === id; }));
  return id;
}

/* ------------------------------------------------------------------ historial */
function snap() {
  var pl = S.proy.plano, im = pl.imagen, s;
  pl.imagen = null;
  try { s = JSON.stringify(S.proy); } finally { pl.imagen = im; }
  return { s: s, im: im, w: pl.anchoPx, h: pl.altoPx };   // la imagen va por referencia (no se copia ni se serializa)
}
function pushUndo(s) {
  S.undo.push(s);
  if (S.undo.length > 40) S.undo.shift();
  S.redo.length = 0;
}
function restaurar(e) {
  var p = proyectoNormalizado(JSON.parse(e.s));
  var cambioImg = S.proy.plano.imagen !== e.im;
  p.plano.imagen = e.im || null; p.plano.anchoPx = e.w || 0; p.plano.altoPx = e.h || 0;
  S.proy = p;
  if (cambioImg) { S.traza = null; S.calib = null; S.pix = null; var tp = $('#trz-panel'), fc = $('#form-calib'); if (tp) tp.hidden = true; if (fc) fc.hidden = true; }
  limpiarSeleccionInvalida();
}
function limpiarSeleccionInvalida() {
  var p = S.proy;
  if (S.sel) {
    var ok = true;
    if (S.sel.tipo === 'contorno') ok = p.contorno.length >= 3;
    else {
      var lista = { hueco: p.huecos, puerta: p.puertas, zona: p.zonas, rack: p.racks }[S.sel.tipo] || [];
      ok = lista.some(function (e) { return e.id === S.sel.id; });
    }
    if (!ok) { S.sel = null; S.selVert = null; }
  }
  if (S.rackElev && !p.racks.some(function (r) { return r.id === S.rackElev; })) S.rackElev = null;
  if (S.posSel && !(p.resultado && p.resultado.porPosicion && (S.posSel in p.resultado.porPosicion) || posPorId()[S.posSel])) S.posSel = null;
  S.moviendo = null;
  if (!p.resultado) S.busqueda = null;
}
function mutar(fn, opt) {
  opt = opt || {};
  var antes = snap();
  fn();
  if (opt.inv !== false) invalidarResultado();
  pushUndo(antes);
  tocar();
  trasCambio(opt);
}
function invalidarResultado() {
  var p = S.proy;
  if (p.resultado) { p.resultado = null; }
  S.busqueda = null; S.moviendo = null;
  S.posSel = null;
}
function deshacer() {
  if (!S.undo.length) return;
  S.redo.push(snap());
  restaurar(S.undo.pop());
  tocar();
  trasCambio({ cancelar: true });
  aviso('Deshecho.', 'info', 1500);
}
function rehacer() {
  if (!S.redo.length) return;
  S.undo.push(snap());
  restaurar(S.redo.pop());
  tocar();
  trasCambio({ cancelar: true });
  aviso('Rehecho.', 'info', 1500);
}
function trasCambio(opt) {
  opt = opt || {};
  guardarAutoDif();
  sincronizarCampos();
  refrescarTodo();
}

/* ------------------------------------------------------------------ avisos y diálogo */
function aviso(txt, tipo, ms) {
  var cont = $('#avisos');
  var d = document.createElement('div');
  d.className = 'aviso ' + (tipo === 'ok' ? 'ok' : tipo === 'warn' ? 'aviso-w' : tipo === 'error' ? 'error' : '');
  d.textContent = txt;
  cont.appendChild(d);
  while (cont.children.length > 4) cont.removeChild(cont.firstChild);
  setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, ms || (tipo === 'error' || tipo === 'warn' ? 7000 : 3500));
}
function preguntar(titulo, texto, botones) {
  return new Promise(function (resolve) {
    var dlg = $('#dlg');
    $('#dlg-titulo').textContent = titulo;
    $('#dlg-texto').textContent = texto;
    var acc = $('#dlg-acc');
    acc.innerHTML = '';
    var resuelto = false;
    botones.forEach(function (b, i) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn' + (b.primario ? ' primario' : '') + (b.peligro ? ' peligro' : '');
      btn.textContent = b.texto;
      btn.addEventListener('click', function () { resuelto = true; dlg.close(); resolve(b.valor); });
      acc.appendChild(btn);
    });
    dlg.addEventListener('close', function once() {
      dlg.removeEventListener('close', once);
      if (!resuelto) resolve(null);
    });
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    var pb = acc.querySelector('.primario') || acc.querySelector('button');
    if (pb) pb.focus();
  });
}
async function conEspera(msg, fn) {
  if (S.ocupado) return null;
  S.ocupado = true;
  $('#espera-txt').textContent = msg || 'Calculando…';
  $('#espera').hidden = false;
  await esperar(30);
  try { return fn(); }
  catch (e) {
    /* M-2: ninguna excepción del motor/análisis queda sin aviso; el proyecto no se toca (quien llama recibe null) */
    console.error(e);
    var que = String(msg || 'el cálculo').replace(/…$/, '').replace(/^./, function (c) { return c.toLowerCase(); });
    aviso('No se pudo completar «' + que + '»: ' + (e && e.message ? e.message : String(e)) + '. El proyecto no se modificó; revise los datos (nombres de SKU o ids repetidos o inusuales) e intente de nuevo.', 'error', 12000);
    return null;
  }
  finally { $('#espera').hidden = true; S.ocupado = false; }
}

/* ------------------------------------------------------------------ persistencia */
var CLAVE_LS = 'almacen_proyecto_v1';
var tAuto = null;
function guardarAutoDif() {
  clearTimeout(tAuto);
  $('#estado-guardado').textContent = 'Guardando…';
  tAuto = setTimeout(guardarAuto, 700);
}
function guardarAuto() {
  var p = S.proy, texto, nota = '';
  try {
    texto = JSON.stringify(p);
    localStorage.setItem(CLAVE_LS, texto);
  } catch (e1) {
    try {
      var im = p.plano.imagen;
      p.plano.imagen = null;
      try { texto = JSON.stringify(p); } finally { p.plano.imagen = im; }
      localStorage.setItem(CLAVE_LS, texto);
      nota = ' (sin la imagen: no cabe en el navegador)';
      if (!S.avisoImagenLS && im) { S.avisoImagenLS = true; aviso('La imagen del plano es muy grande para el autoguardado: se guardó el proyecto sin la imagen. Usa «Guardar proyecto (.json)» para conservarla.', 'warn'); }
    } catch (e2) {
      try {
        var q = clonar(Object.assign({}, p, { resultado: null }));
        q.plano.imagen = null;
        localStorage.setItem(CLAVE_LS, JSON.stringify(q));
        nota = ' (sin imagen ni resultado)';
      } catch (e3) {
        $('#estado-guardado').textContent = 'No se pudo autoguardar';
        return;
      }
    }
  }
  S.guardadoEn = new Date();
  $('#estado-guardado').textContent = 'Guardado ' + S.guardadoEn.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' }) + nota;
  var ra = $('#rep-auto'); if (ra) ra.textContent = 'Autoguardado en este navegador: ' + S.guardadoEn.toLocaleTimeString('es-PE') + nota;
}
function leerAutoguardado() {
  try {
    var t = localStorage.getItem(CLAVE_LS);
    if (!t) return null;
    var p = JSON.parse(t);
    if (!p || typeof p !== 'object') return null;
    return p;
  } catch (e) { return null; }
}

/* ------------------------------------------------------------------ geometría */
function rackEjes(r) {
  var a = (r.ang || 0) * Math.PI / 180;
  return { ex: [Math.cos(a), Math.sin(a)], ey: [-Math.sin(a), Math.cos(a)] };
}
function rackPt(r, lx, ly) {
  var e = rackEjes(r);
  return [r.cx + lx * e.ex[0] + ly * e.ey[0], r.cy + lx * e.ex[1] + ly * e.ey[1]];
}
function rackEsquinas(r) {
  var L = r.largo / 2, F = r.fondo / 2;
  return [rackPt(r, -L, -F), rackPt(r, L, -F), rackPt(r, L, F), rackPt(r, -L, F)];
}
function centroide(poly) {
  var sx = 0, sy = 0;
  poly.forEach(function (p) { sx += p[0]; sy += p[1]; });
  return [sx / poly.length, sy / poly.length];
}
function bboxPts(pts) {
  var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  pts.forEach(function (p) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; });
  return [x0, y0, x1, y1];
}
function enPoly(pt, poly) {
  if (!poly || poly.length < 3) return false;
  return M.puntoEnPoligono(pt, poly);
}
function segCruza(a, b, c, d) {
  function o(p, q, r) { return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]); }
  var o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  var e = 1e-9;
  return ((o1 > e && o2 < -e) || (o1 < -e && o2 > e)) && ((o3 > e && o4 < -e) || (o3 < -e && o4 > e));
}
function distPtSeg(p, a, b) {
  var dx = b[0] - a[0], dy = b[1] - a[1];
  var l2 = dx * dx + dy * dy;
  var t = l2 ? clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2, 0, 1) : 0;
  var qx = a[0] + t * dx, qy = a[1] + t * dy;
  return { d: Math.hypot(p[0] - qx, p[1] - qy), t: t, q: [qx, qy] };
}
function polyCruzaPoly(a, b) {
  var i, j, n = a.length, m = b.length;
  for (i = 0; i < n; i++) for (j = 0; j < m; j++) if (segCruza(a[i], a[(i + 1) % n], b[j], b[(j + 1) % m])) return true;
  return false;
}
function polysSeTocan(a, b) {
  if (polyCruzaPoly(a, b)) return true;
  var i;
  for (i = 0; i < a.length; i++) if (enPoly(a[i], b)) return true;
  for (i = 0; i < b.length; i++) if (enPoly(b[i], a)) return true;
  return enPoly(centroide(a), b) || enPoly(centroide(b), a);
}
function satSolape(a, b, tol) {
  var polys = [a, b], k, i;
  for (k = 0; k < 2; k++) {
    var p = polys[k];
    for (i = 0; i < p.length; i++) {
      var q = p[(i + 1) % p.length];
      var nx = -(q[1] - p[i][1]), ny = q[0] - p[i][0];
      var l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
      var mn1 = Infinity, mx1 = -Infinity, mn2 = Infinity, mx2 = -Infinity;
      a.forEach(function (v) { var d = v[0] * nx + v[1] * ny; if (d < mn1) mn1 = d; if (d > mx1) mx1 = d; });
      b.forEach(function (v) { var d = v[0] * nx + v[1] * ny; if (d < mn2) mn2 = d; if (d > mx2) mx2 = d; });
      if (mx1 <= mn2 + tol || mx2 <= mn1 + tol) return false;
    }
  }
  return true;
}
function perimetro(poly) {
  var s = 0, i;
  for (i = 0; i < poly.length; i++) { var a = poly[i], b = poly[(i + 1) % poly.length]; s += Math.hypot(b[0] - a[0], b[1] - a[1]); }
  return s;
}
function areaAbs(poly) { return poly && poly.length >= 3 ? Math.abs(M.areaPoligono(poly)) : 0; }

/* ------------------------------------------------------------------ cachés derivadas */
function sigRacks() {
  return cache('sigRacks', S.ver, function () { return JSON.stringify([S.proy.racks, S.proy.zonas]); });
}
function sigGeom() {
  return cache('sigGeom', S.ver, function () {
    var p = S.proy;
    return JSON.stringify([p.contorno, p.huecos, p.puertas, p.racks, p.zonas, p.config.celdaM, p.config.anchoPasillo, p.config.anchoPasilloCruce, p.config.flue, p.config.margenMuro]);
  });
}
function getPos() {
  return cache('pos', sigRacks(), function () {
    try { return M.posicionesDeRacks(S.proy) || []; } catch (e) { console.error(e); return []; }
  });
}
function posPorId() {
  return cache('posId', sigRacks(), function () {
    var o = dic();
    getPos().forEach(function (p) { o[p.id] = p; });
    return o;
  });
}
function posPorRack() {
  return cache('posRack', sigRacks(), function () {
    var o = dic();
    getPos().forEach(function (p) { (o[p.rackId] = o[p.rackId] || []).push(p); });
    return o;
  });
}
function distListo() { return !!(C.dist && C.dist.clave === sigGeom()); }
function getDist() {
  // Calcula (si hace falta) las distancias caminando. Puede tardar: llamar desde conEspera cuando sea posible.
  return cache('dist', sigGeom(), function () {
    var r;
    try { r = M.calcularDistanciasPosiciones(S.proy) || { posiciones: [], advertencias: [] }; }
    catch (e) { console.error(e); r = { posiciones: [], advertencias: ['No se pudieron calcular las distancias: ' + e.message] }; }
    var m = dic();
    (r.posiciones || []).forEach(function (p) { m[p.id] = p; });
    r.porId = m;
    return r;
  });
}
function distPos(id) {
  if (!distListo()) return null;
  return getDist().porId[id] || null;
}
function productoPorSku() {
  return cache('prodSku', S.ver, function () {
    var o = dic();
    S.proy.productos.forEach(function (p) { if (!(p.sku in o)) o[p.sku] = p; });
    return o;
  });
}
function mapaABC() {
  return cache('abc', S.ver, function () {
    var o = dic();
    try {
      (M.clasificarABC(S.proy.productos, S.proy.config.abc) || []).forEach(function (c) { o[c.sku] = c; });
    } catch (e) { console.error(e); }
    return o;
  });
}
function problemasRacks() {
  return cache('probRacks', S.ver, function () {
    var p = S.proy, res = dic();
    function marca(id, t) { (res[id] = res[id] || []).indexOf(t) < 0 && res[id].push(t); }
    var info = p.racks.map(function (r) { var poly = rackEsquinas(r); return { r: r, poly: poly, bb: bboxPts(poly) }; });
    var i, j;
    for (i = 0; i < info.length; i++) {
      for (j = i + 1; j < info.length; j++) {
        var a = info[i], b = info[j];
        if (a.bb[2] < b.bb[0] || b.bb[2] < a.bb[0] || a.bb[3] < b.bb[1] || b.bb[3] < a.bb[1]) continue;
        if (satSolape(a.poly, b.poly, 0.02)) { marca(a.r.id, 'solape'); marca(b.r.id, 'solape'); }
      }
    }
    info.forEach(function (a) {
      if (p.contorno.length >= 3) {
        var fuera = a.poly.some(function (v) { return !enPoly(v, p.contorno); });
        if (!fuera) fuera = polyCruzaPoly(a.poly, p.contorno);
        if (fuera) marca(a.r.id, 'fuera');
      }
      p.huecos.forEach(function (h) {
        if (h.poly && h.poly.length >= 3 && polysSeTocan(a.poly, h.poly)) marca(a.r.id, 'hueco');
      });
    });
    return res;
  });
}

/* ------------------------------------------------------------------ vista y coordenadas */
var cv = null, ctx = null, W = 0, H = 0, DPR = 1;
function w2s(x, y) { return [x * S.v.k + S.v.ox, y * S.v.k + S.v.oy]; }
function s2w(sx, sy) { return [(sx - S.v.ox) / S.v.k, (sy - S.v.oy) / S.v.k]; }
function mPorPxEff() {
  var pl = S.proy.plano;
  return pl.mPorPx || (pl.anchoPx ? 60 / pl.anchoPx : 0.05);
}
function pxAm(px, py) { var s = mPorPxEff(), pl = S.proy.plano; return [(pl.x0 || 0) + px * s, (pl.y0 || 0) + py * s]; }
function mApx(x, y) { var s = mPorPxEff(), pl = S.proy.plano; return [(x - (pl.x0 || 0)) / s, (y - (pl.y0 || 0)) / s]; }
function imagenLista() { return !!(S.img && S.img.complete && S.img.naturalWidth); }

function limitesEscena() {
  var p = S.proy, pts = [];
  p.contorno.forEach(function (q) { pts.push(q); });
  p.racks.forEach(function (r) { rackEsquinas(r).forEach(function (q) { pts.push(q); }); });
  p.puertas.forEach(function (d) { pts.push([d.x, d.y]); });
  p.zonas.forEach(function (z) { (z.poly || []).forEach(function (q) { pts.push(q); }); });
  if (imagenLista() && p.plano.imagen) {
    var s = mPorPxEff(), x0 = p.plano.x0 || 0, y0 = p.plano.y0 || 0;
    pts.push([x0, y0]); pts.push([x0 + (p.plano.anchoPx || S.img.naturalWidth) * s, y0 + (p.plano.altoPx || S.img.naturalHeight) * s]);
  }
  if (!pts.length) return [0, 0, 50, 35];
  return bboxPts(pts);
}
function encajar(solo) {
  var b = solo || limitesEscena();
  var bw = Math.max(1, b[2] - b[0]), bh = Math.max(1, b[3] - b[1]);
  var w = W || 800, h = H || 500, m = 36;
  var k = Math.min((w - 2 * m) / bw, (h - 2 * m) / bh);
  k = clamp(k, 0.5, 500);
  S.v.k = k;
  S.v.ox = w / 2 - ((b[0] + b[2]) / 2) * k;
  S.v.oy = h / 2 - ((b[1] + b[3]) / 2) * k;
  pedirDibujo();
}
function zoomEn(factor, sx, sy) {
  if (sx == null) { sx = W / 2; sy = H / 2; }
  var w = s2w(sx, sy);
  var k = clamp(S.v.k * factor, 0.4, 600);
  S.v.k = k;
  S.v.ox = sx - w[0] * k;
  S.v.oy = sy - w[1] * k;
  pedirDibujo();
}

/* ------------------------------------------------------------------ imagen y píxeles */
function sincronizarImagen() {
  var src = S.proy.plano.imagen;
  if (!src) { S.img = null; S.imgSrc = null; S.pix = null; return; }
  if (S.imgSrc === src && S.img) return;
  S.imgSrc = src;
  S.pix = null;
  var im = new Image();
  im.onload = function () { if (S.imgSrc === src) { S.img = im; refrescarTodo(); } };
  im.onerror = function () { aviso('No se pudo leer la imagen del plano.', 'error'); };
  im.src = src;
  S.img = im;
}
function obtenerPixeles() {
  if (!imagenLista()) return null;
  if (S.pix && S.pix.img === S.img) return S.pix;
  var w = S.img.naturalWidth, h = S.img.naturalHeight;
  var k = Math.min(1, 1600 / Math.max(w, h));
  var cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
  var c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  var g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, cw, ch);
  g.drawImage(S.img, 0, 0, cw, ch);
  var id = g.getImageData(0, 0, cw, ch);
  S.pix = { img: S.img, w: cw, h: ch, k: cw / w, kx: cw / w, ky: ch / h, data: id.data, anchoOrig: w, altoOrig: h };
  return S.pix;
}
async function cargarArchivoImagen(file) {
  if (!file || !/^image\//.test(file.type || 'image/')) { aviso('Ese archivo no parece una imagen (usa PNG o JPG).', 'warn'); return; }
  var url = await new Promise(function (res, rej) {
    var fr = new FileReader();
    fr.onload = function () { res(fr.result); };
    fr.onerror = function () { rej(fr.error); };
    fr.readAsDataURL(file);
  }).catch(function () { return null; });
  if (!url) { aviso('No se pudo leer el archivo.', 'error'); return; }
  var im = new Image();
  im.onload = function () {
    var w = im.naturalWidth, h = im.naturalHeight, final = url;
    if (Math.max(w, h) > 3200) {
      var k = 3200 / Math.max(w, h), c = document.createElement('canvas');
      c.width = Math.round(w * k); c.height = Math.round(h * k);
      var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(im, 0, 0, c.width, c.height);
      final = c.toDataURL('image/png'); w = c.width; h = c.height;
      aviso('La imagen era muy grande y se redujo a ' + w + '×' + h + ' px.', 'info');
    }
    var teniaEscala = !!S.proy.plano.mPorPx;
    S.traza = null; S.calib = null; S.pix = null;
    S.img = im; S.imgSrc = final;
    mutar(function () {
      var pl = S.proy.plano;
      pl.imagen = final; pl.anchoPx = w; pl.altoPx = h;
      pl.mPorPx = null; pl.x0 = 0; pl.y0 = 0;
      if (!pl.opacidad) pl.opacidad = 0.5;
    }, { inv: false });
    ponerHerr('seleccionar');
    aviso('Imagen cargada. Ahora calibra la escala (paso 2)' + (teniaEscala ? ' (la escala anterior se reinició)' : '') + '.', 'ok', 5000);
    refrescarTodo();
    encajar();
  };
  im.onerror = function () { aviso('No se pudo decodificar la imagen.', 'error'); };
  im.src = url;
}

/* ------------------------------------------------------------------ dibujo del lienzo */
var PAL = {
  claro: { bg: '#eef2f6', grid: 'rgba(30,60,100,0.09)', gridMaj: 'rgba(30,60,100,0.2)', piso: '#ffffff', contorno: '#1f3a5f', hueco: '#8b95a5', huecoBorde: '#475467', rack: '#cfd8e4', rackBorde: '#2b3d57', texto: '#18212c', acento: '#1b5cc0', error: '#d1242f', sel: '#e07b00', leyenda: 'rgba(255,255,255,0.93)', vacioCol: '#dde4ec', halo: '#ffffff' },
  oscuro: { bg: '#131a22', grid: 'rgba(160,190,230,0.08)', gridMaj: 'rgba(160,190,230,0.18)', piso: '#1f2a37', contorno: '#8db4ee', hueco: '#566172', huecoBorde: '#a3afc0', rack: '#41526a', rackBorde: '#b3c6e0', texto: '#e7ecf3', acento: '#6ba5ff', error: '#ff6b73', sel: '#ffb454', leyenda: 'rgba(23,30,39,0.93)', vacioCol: '#2c394a', halo: '#10161d' }
};
var COLOR_ABC = { A: '#e5484d', B: '#f5c518', C: '#3da66a' };
var COLOR_ZONA = { frio: '#2fa8e0', peligrosos: '#f2711c', alto_valor: '#a855f7', cuarentena: '#d4a600', general: '#7a8aa0', almacenaje: '#4f6bd6', muelle: '#0f8f8f', staging: '#c2410c' };
var COLOR_PUERTA = { recepcion: '#1f9d55', despacho: '#e67e22', mixta: '#2d6cdf', salida_emergencia: '#0a6b34' };
var LETRA_PUERTA = { recepcion: 'R', despacho: 'D', mixta: 'M', salida_emergencia: 'E' };
var COLOR_ROL = { picking: '#1d6fd1', reserva: '#e8a21c' };
var HEAT = ['#ffffcc', '#fed976', '#fd8d3c', '#e31a1c', '#800026'];
var PATRONES = null;

function paletaActual() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? PAL.oscuro : PAL.claro;
}
function hex2rgb(h) { return [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)]; }
function heatColor(t) {
  t = clamp(t, 0, 1) * (HEAT.length - 1);
  var i = Math.min(HEAT.length - 2, Math.floor(t)), f = t - i;
  var a = hex2rgb(HEAT[i]), b = hex2rgb(HEAT[i + 1]);
  return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * f) + ',' + Math.round(a[1] + (b[1] - a[1]) * f) + ',' + Math.round(a[2] + (b[2] - a[2]) * f) + ')';
}
function crearPatrones(g) {
  if (PATRONES) return PATRONES;
  function mk(draw, size) {
    var c = document.createElement('canvas'); c.width = c.height = size;
    var x = c.getContext('2d'); draw(x, size);
    return g.createPattern(c, 'repeat');
  }
  PATRONES = {
    A: mk(function (x, s) { x.strokeStyle = 'rgba(0,0,0,.55)'; x.lineWidth = 1.6; x.beginPath(); x.moveTo(-1, s + 1); x.lineTo(s + 1, -1); x.moveTo(-1, 2 * s + 1); x.lineTo(2 * s + 1, -1); x.moveTo(-s - 1, s + 1); x.lineTo(s + 1, -s - 1); x.stroke(); }, 7),
    B: mk(function (x, s) { x.fillStyle = 'rgba(0,0,0,.55)'; x.beginPath(); x.arc(s / 2, s / 2, 1.1, 0, 7); x.fill(); }, 6),
    C: null,
    hueco: mk(function (x, s) { x.strokeStyle = 'rgba(0,0,0,.45)'; x.lineWidth = 1; x.beginPath(); x.moveTo(0, s); x.lineTo(s, 0); x.stroke(); }, 6),
    inaccesible: mk(function (x, s) { x.fillStyle = '#9aa3af'; x.fillRect(0, 0, s, s); x.strokeStyle = '#4b5563'; x.lineWidth = 1; x.beginPath(); x.moveTo(0, 0); x.lineTo(s, s); x.stroke(); }, 6)
  };
  return PATRONES;
}
function trazarPoly(g, pts, cerrar) {
  var i, p;
  g.beginPath();
  for (i = 0; i < pts.length; i++) {
    p = w2s(pts[i][0], pts[i][1]);
    if (i) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]);
  }
  if (cerrar !== false) g.closePath();
}
function textoHalo(g, txt, x, y, pal, tam, color) {
  g.font = '600 ' + (tam || 11) + 'px system-ui, -apple-system, "Segoe UI", sans-serif';
  g.lineWidth = 3; g.lineJoin = 'round';
  g.strokeStyle = pal.halo; g.strokeText(txt, x, y);
  g.fillStyle = color || pal.texto; g.fillText(txt, x, y);
}

/* columnas = (rack, módulo, slot): huella en planta que agrupa los niveles */
function columnasMapa(modo) {
  var res = S.proy.resultado;
  modo = modo || S.vistaMapa;
  var clave = [S.ver, modo, res ? 1 : 0, (modo === 'dist' && distListo()) ? 1 : 0].join('|');
  var rolMap = res && res.rolPorPosicion ? res.rolPorPosicion : dic();
  var modKg = dic(), modCap = dic(), modLim = dic();
  return cache('cols', clave, function () {
    var pos = getPos(), por = res && res.porPosicion ? res.porPosicion : dic();
    var abc = mapaABC(), prods = productoPorSku();
    var dist = (modo === 'dist' && distListo()) ? getDist().porId : null;
    var racks = dic(); S.proy.racks.forEach(function (r) { racks[r.id] = r; });
    var cols = {}, lista = [], maxD = 0, maxP = 0, maxRatio = 0;
    pos.forEach(function (p) {   // carga por módulo (rack + índice de módulo, todos los niveles y slots)
      var r0 = racks[p.rackId]; if (!r0) return;
      var mk = p.rackId + '|' + p.modulo, s0 = por[p.id], pr0 = s0 ? prods[s0] : null;
      modKg[mk] = (modKg[mk] || 0) + (pr0 ? N(pr0.unidadesPorUbic) * N(pr0.pesoUnitKg) : 0);
      modCap[mk] = (modCap[mk] || 0) + N(p.cargaMaxKg);
      modLim[mk] = r0.cargaMaxModuloKg > 0 ? r0.cargaMaxModuloKg : 0;
    });
    pos.forEach(function (p) {
      var r = racks[p.rackId]; if (!r) return;
      var key = p.rackId + '|' + p.modulo + '|' + (p.slot || 1);
      var c = cols[key];
      if (!c) {
        var w = r.largo / Math.max(1, r.modulos) / Math.max(1, r.slotsPorModulo || 1), e = rackEjes(r);
        var hx = w / 2, hy = r.fondo / 2;
        c = cols[key] = {
          rackId: p.rackId, modulo: p.modulo, slot: p.slot || 1, n: 0, occ: 0, rank: 9, picks: 0, dmin: Infinity, skus: [], nPick: 0, nRes: 0, ratio: null, conLimite: false,
          poly: [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(function (q) { return [p.cx + q[0] * e.ex[0] + q[1] * e.ey[0], p.cy + q[0] * e.ex[1] + q[1] * e.ey[1]]; })
        };
        lista.push(c);
      }
      c.n++;
      var sku = por[p.id];
      if (sku) {
        c.occ++; c.skus.push(sku);
        if (rolMap[p.id] === 'picking') c.nPick++; else if (rolMap[p.id] === 'reserva') c.nRes++;
        var cl = abc[sku] ? abc[sku].clase : 'C';
        c.rank = Math.min(c.rank, cl === 'A' ? 0 : cl === 'B' ? 1 : 2);
        var pr = prods[sku] ? prods[sku].picks || 0 : 0;
        if (pr > c.picks) c.picks = pr;
        if (pr > maxP) maxP = pr;
      }
      if (dist) {
        var d = dist[p.id];
        if (d && isFinite(d.dDesp)) { if (d.dDesp < c.dmin) c.dmin = d.dDesp; if (d.dDesp > maxD) maxD = d.dDesp; }
      }
    });
    lista.forEach(function (c) {
      var mk = c.rackId + '|' + c.modulo, cap = modLim[mk] > 0 ? modLim[mk] : modCap[mk];
      c.conLimite = modLim[mk] > 0;
      c.ratio = cap > 0 ? modKg[mk] / cap : null;
      if (c.ratio !== null && c.ratio > maxRatio) maxRatio = c.ratio;
    });
    return { lista: lista, maxD: maxD, maxP: maxP, maxRatio: maxRatio };
  });
}

function rutaPuertaPos(d) { return d; }

function dibujarEscena(g, w, h, op) {
  var pal = op.pal, p = S.proy, k = S.v.k, ui = !!op.ui;
  var pat = crearPatrones(g);
  g.clearRect(0, 0, w, h);
  g.fillStyle = pal.bg; g.fillRect(0, 0, w, h);
  var i, j;

  /* cuadrícula */
  if (op.grid) {
    var pasos = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100, 200], paso = 200;
    for (i = 0; i < pasos.length; i++) if (pasos[i] * k >= 14) { paso = pasos[i]; break; }
    var a = s2w(0, 0), b = s2w(w, h);
    var gx0 = Math.floor(a[0] / paso), gx1 = Math.ceil(b[0] / paso), gy0 = Math.floor(a[1] / paso), gy1 = Math.ceil(b[1] / paso);
    if ((gx1 - gx0) < 600 && (gy1 - gy0) < 600) {
      for (i = gx0; i <= gx1; i++) {
        var sx = Math.round(i * paso * k + S.v.ox) + 0.5;
        g.strokeStyle = (i % 5 === 0) ? pal.gridMaj : pal.grid; g.lineWidth = 1;
        g.beginPath(); g.moveTo(sx, 0); g.lineTo(sx, h); g.stroke();
      }
      for (j = gy0; j <= gy1; j++) {
        var sy = Math.round(j * paso * k + S.v.oy) + 0.5;
        g.strokeStyle = (j % 5 === 0) ? pal.gridMaj : pal.grid; g.lineWidth = 1;
        g.beginPath(); g.moveTo(0, sy); g.lineTo(w, sy); g.stroke();
      }
    }
  }

  /* imagen de fondo */
  var hayImg = imagenLista() && p.plano.imagen;
  if (hayImg) {
    var s = mPorPxEff(), o = w2s(p.plano.x0 || 0, p.plano.y0 || 0);
    g.save();
    g.globalAlpha = clamp(p.plano.opacidad == null ? 0.5 : p.plano.opacidad, 0, 1);
    g.imageSmoothingQuality = 'high';
    g.drawImage(S.img, o[0], o[1], (p.plano.anchoPx || S.img.naturalWidth) * s * k, (p.plano.altoPx || S.img.naturalHeight) * s * k);
    g.restore();
  }

  /* piso útil */
  if (p.contorno.length >= 3) {
    g.save();
    g.beginPath();
    p.contorno.forEach(function (q, ii) { var sp = w2s(q[0], q[1]); if (ii) g.lineTo(sp[0], sp[1]); else g.moveTo(sp[0], sp[1]); });
    g.closePath();
    g.globalAlpha = hayImg ? 0.55 : 1;
    g.fillStyle = pal.piso; g.fill();
    g.restore();
  }

  /* zonas */
  p.zonas.forEach(function (z) {
    if (!z.poly || z.poly.length < 3) return;
    var col = COLOR_ZONA[z.tipo] || COLOR_ZONA.general;
    trazarPoly(g, z.poly);
    g.globalAlpha = 0.2; g.fillStyle = col; g.fill(); g.globalAlpha = 1;
    g.setLineDash(z.tipo === 'muelle' ? [2, 3] : z.tipo === 'staging' ? [10, 3, 2, 3] : z.tipo === 'almacenaje' ? [14, 4] : [6, 4]); g.lineWidth = z.tipo === 'almacenaje' || z.tipo === 'muelle' || z.tipo === 'staging' ? 2.2 : 1.6; g.strokeStyle = col; g.stroke(); g.setLineDash([]);
    var c = centroide(z.poly), sp = w2s(c[0], c[1]);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    if (k > 4) textoHalo(g, z.nombre || NOMBRES_ZONA[z.tipo] || 'Zona', sp[0], sp[1], pal, 11, pal.texto);
  });

  /* contorno */
  if (p.contorno.length >= 3) {
    trazarPoly(g, p.contorno);
    g.lineWidth = 2.5; g.strokeStyle = pal.contorno; g.lineJoin = 'round'; g.stroke();
  } else if (p.contorno.length) {
    trazarPoly(g, p.contorno, false); g.lineWidth = 2; g.strokeStyle = pal.contorno; g.stroke();
  }

  /* huecos */
  p.huecos.forEach(function (hh) {
    if (!hh.poly || hh.poly.length < 3) return;
    trazarPoly(g, hh.poly);
    g.fillStyle = pal.hueco; g.fill();
    if (pat.hueco) { g.fillStyle = pat.hueco; g.fill(); }
    g.lineWidth = 1.5; g.strokeStyle = pal.huecoBorde; g.stroke();
    if (k > 10 && hh.tipo !== 'columna') {
      var c2 = centroide(hh.poly), s2 = w2s(c2[0], c2[1]);
      g.textAlign = 'center'; g.textBaseline = 'middle';
      textoHalo(g, NOMBRES_TIPO_HUECO[hh.tipo] || 'Obstáculo', s2[0], s2[1], pal, 10);
    }
  });

  /* capa: mapa de calor de evacuación (muestras que devuelve el análisis) */
  if (S.capas && S.capas.evac) {
    var ev = muestrasEvac();
    if (ev && ev.lista.length) {
      var lado = Math.max(2, k * ev.paso);
      g.save();
      if (p.contorno.length >= 3) { trazarPoly(g, p.contorno); g.clip(); }
      g.globalAlpha = 0.6;
      ev.lista.forEach(function (m) {
        var sp = w2s(m.x - ev.paso / 2, m.y - ev.paso / 2);
        if (sp[0] < -lado || sp[1] < -lado || sp[0] > w || sp[1] > h) return;
        g.fillStyle = heatColor(ev.max > 0 ? m.d / ev.max : 0); g.fillRect(sp[0], sp[1], lado + 0.5, lado + 0.5);
      });
      g.restore();
    }
  }

  /* racks + mapa */
  var modo = op.modo || (S.tab === 'asignar' ? S.vistaMapa : 'nada');
  var probs = problemasRacks();
  var bus = ui && S.busqueda && S.proy.resultado ? S.busqueda : null;
  var busSet = null;
  if (bus) { busSet = dic(); bus.posIds.forEach(function (id) { busSet[id] = true; }); }

  var cm = null;
  if (modo !== 'nada') cm = columnasMapa(modo);

  p.racks.forEach(function (r) {
    var esq = rackEsquinas(r);
    var mal = !!probs[r.id];
    // base
    trazarPoly(g, esq);
    g.fillStyle = mal ? 'rgba(209,36,47,0.35)' : pal.rack;
    g.fill();
    // divisiones de módulos
    if (r.modulos > 1 && r.largo * k / r.modulos > 4) {
      g.beginPath();
      for (i = 1; i < r.modulos; i++) {
        var lx = -r.largo / 2 + i * r.largo / r.modulos;
        var a1 = w2s.apply(null, rackPt(r, lx, -r.fondo / 2)), a2 = w2s.apply(null, rackPt(r, lx, r.fondo / 2));
        g.moveTo(a1[0], a1[1]); g.lineTo(a2[0], a2[1]);
      }
      g.lineWidth = 0.8; g.strokeStyle = pal.rackBorde; g.globalAlpha = 0.55; g.stroke(); g.globalAlpha = 1;
    }
  });

  if (cm) {
    var enGrande = k >= 7;
    var letras = k * 0.9 >= 14;
    cm.lista.forEach(function (c) {
      var relleno = null, rank = c.rank;
      if (modo === 'abc') {
        relleno = c.occ ? (rank === 0 ? COLOR_ABC.A : rank === 1 ? COLOR_ABC.B : COLOR_ABC.C) : pal.vacioCol;
      } else if (modo === 'dist') {
        relleno = isFinite(c.dmin) ? heatColor(cm.maxD ? c.dmin / cm.maxD : 0) : null;
      } else if (modo === 'picks') {
        relleno = c.occ ? heatColor(cm.maxP ? c.picks / cm.maxP : 0) : pal.vacioCol;
      } else if (modo === 'rol') {
        relleno = c.nPick ? COLOR_ROL.picking : c.nRes ? COLOR_ROL.reserva : pal.vacioCol;
      } else if (modo === 'carga') {
        relleno = c.ratio === null ? pal.vacioCol : heatColor(Math.min(1, c.ratio));
      }
      var tenue = busSet ? !c.skus.some(function (sk) { return sk === bus.sku; }) : false;
      trazarPoly(g, c.poly);
      g.globalAlpha = tenue ? 0.28 : (modo === 'abc' && c.occ ? 0.5 + 0.5 * c.occ / c.n : 1);
      if (relleno) { g.fillStyle = relleno; g.fill(); }
      else if (modo === 'dist' && pat.inaccesible) { g.fillStyle = pat.inaccesible; g.fill(); }
      if (modo === 'abc' && c.occ && !tenue) {
        var pt = rank === 0 ? pat.A : rank === 1 ? pat.B : null;
        if (pt) { g.globalAlpha = 1; g.fillStyle = pt; g.fill(); }
      }
      g.globalAlpha = tenue ? 0.4 : 1;
      g.lineWidth = 0.6; g.strokeStyle = pal.rackBorde; g.stroke();
      g.globalAlpha = 1;
      if ((modo === 'rol' && (c.nPick || c.nRes) && letras && !tenue) || (modo === 'carga' && c.ratio !== null && c.ratio > 1 && !tenue && k >= 5)) {
        var cc2 = centroide(c.poly), sp2 = w2s(cc2[0], cc2[1]);
        g.textAlign = 'center'; g.textBaseline = 'middle';
        textoHalo(g, modo === 'carga' ? '!' : (c.nPick ? 'P' : 'R'), sp2[0], sp2[1], { halo: '#fff', texto: '#111' }, Math.min(14, Math.max(9, k * 0.6)), '#111');
      }
      if (modo === 'abc' && c.occ && letras && !tenue) {
        var cc = centroide(c.poly), sp = w2s(cc[0], cc[1]);
        g.textAlign = 'center'; g.textBaseline = 'middle';
        textoHalo(g, rank === 0 ? 'A' : rank === 1 ? 'B' : 'C', sp[0], sp[1], { halo: '#fff', texto: '#111' }, Math.min(14, Math.max(9, k * 0.6)), '#111');
      }
    });
    // resalte de búsqueda
    if (bus) {
      g.lineWidth = 2.5; g.strokeStyle = '#c026d3';
      cm.lista.forEach(function (c) {
        if (c.skus.indexOf(bus.sku) >= 0) { trazarPoly(g, c.poly); g.stroke(); }
      });
    }
  }

  // bordes, frente y etiquetas de racks
  p.racks.forEach(function (r) {
    var esq = rackEsquinas(r), mal = probs[r.id];
    var seleccionado = ui && S.sel && S.sel.tipo === 'rack' && S.sel.id === r.id;
    var elev = ui && S.tab === 'asignar' && S.rackElev === r.id;
    trazarPoly(g, esq);
    g.lineWidth = seleccionado || elev ? 3 : 1.4;
    g.strokeStyle = mal ? pal.error : (seleccionado ? pal.sel : elev ? pal.acento : pal.rackBorde);
    g.stroke();
    // frente (lado de acceso)
    var f = r.frente === 'B' ? [esq[3], esq[2]] : [esq[0], esq[1]];
    var fs = [w2s(f[0][0], f[0][1]), w2s(f[1][0], f[1][1])];
    g.beginPath(); g.moveTo(fs[0][0], fs[0][1]); g.lineTo(fs[1][0], fs[1][1]);
    g.lineWidth = 3; g.strokeStyle = pal.acento; g.stroke();
    if (r.largo * k > 30) {
      var cen = w2s(r.cx, r.cy), e = rackEjes(r), sg = r.frente === 'B' ? 1 : -1;
      var tip = w2s(r.cx + e.ey[0] * (r.fondo / 2 + 0.01) * sg, r.cy + e.ey[1] * (r.fondo / 2 + 0.01) * sg);
      var nx = e.ey[0] * sg, ny = e.ey[1] * sg;
      g.beginPath();
      g.moveTo(tip[0] + nx * 5, tip[1] + ny * 5);
      g.lineTo(tip[0] - ny * 4, tip[1] + nx * 4);
      g.lineTo(tip[0] + ny * 4, tip[1] - nx * 4);
      g.closePath(); g.fillStyle = pal.acento; g.fill();
    }
    if (r.largo * k > 34 && k > 3) {
      var c = w2s(r.cx, r.cy);
      g.textAlign = 'center'; g.textBaseline = 'middle';
      if (!cm || k > 9) textoHalo(g, r.nombre || r.id, c[0], c[1], pal, 10);
    }
  });

  /* puertas */
  p.puertas.forEach(function (d) {
    var sp = w2s(d.x, d.y), col = COLOR_PUERTA[d.tipo] || '#555';
    var seleccionado = ui && S.sel && S.sel.tipo === 'puerta' && S.sel.id === d.id;
    g.beginPath();
    if (d.tipo === 'salida_emergencia') { g.moveTo(sp[0], sp[1] - 15); g.lineTo(sp[0] + 15, sp[1]); g.lineTo(sp[0], sp[1] + 15); g.lineTo(sp[0] - 15, sp[1]); g.closePath(); }
    else g.rect(sp[0] - 11, sp[1] - 11, 22, 22);
    g.fillStyle = col; g.fill();
    g.lineWidth = seleccionado ? 3 : 2; g.strokeStyle = seleccionado ? pal.sel : '#fff'; g.stroke();
    g.fillStyle = '#fff'; g.font = '700 13px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(LETRA_PUERTA[d.tipo] || '?', sp[0], sp[1] + 0.5);
    if (k > 3) { g.textAlign = 'left'; textoHalo(g, d.nombre || '', sp[0] + 15, sp[1], pal, 11); }
  });

  /* ruta de búsqueda */
  if (bus && bus.ruta && bus.ruta.length > 1) {
    [{ r: bus.rutaRec, dash: [7, 5], col: '#1f9d55', w: 3 }, { r: bus.ruta, dash: [], col: '#c026d3', w: 4 }].forEach(function (rr) {
      if (!rr.r || rr.r.length < 2) return;
      trazarPoly(g, rr.r, false);
      g.lineJoin = 'round'; g.lineCap = 'round';
      g.setLineDash([]); g.lineWidth = rr.w + 3; g.strokeStyle = pal.halo; g.stroke();
      g.setLineDash(rr.dash); g.lineWidth = rr.w; g.strokeStyle = rr.col; g.stroke(); g.setLineDash([]);
    });
    var fin = bus.ruta[bus.ruta.length - 1], sf = w2s(fin[0], fin[1]);
    g.beginPath(); g.arc(sf[0], sf[1], 6, 0, 7); g.fillStyle = '#c026d3'; g.fill(); g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke();
  }

  if (ui) dibujarOverlays(g, w, h, pal);

  /* leyenda y escala */
  if (op.leyenda !== false) dibujarLeyenda(g, w, h, pal, cm, modo);
  dibujarEscala(g, w, h, pal);
  if (op.titulo) {
    g.textAlign = 'left'; g.textBaseline = 'top';
    textoHalo(g, op.titulo, 14, 12, pal, 15);
  }
}

function dibujarOverlays(g, w, h, pal) {
  var p = S.proy, i;
  /* vista previa del auto-trazo */
  if (S.traza && S.traza.res) {
    var tr = S.traza.res;
    if (tr.contornoM && tr.contornoM.length >= 3) {
      trazarPoly(g, tr.contornoM);
      g.globalAlpha = 0.18; g.fillStyle = pal.acento; g.fill(); g.globalAlpha = 1;
      g.setLineDash([8, 5]); g.lineWidth = 2.5; g.strokeStyle = pal.acento; g.stroke(); g.setLineDash([]);
    }
    (tr.huecosM || []).forEach(function (hh) {
      if (hh.length < 3) return;
      trazarPoly(g, hh); g.globalAlpha = 0.4; g.fillStyle = pal.error; g.fill(); g.globalAlpha = 1;
      g.setLineDash([4, 3]); g.lineWidth = 1.5; g.strokeStyle = pal.error; g.stroke(); g.setLineDash([]);
    });
  }
  if (S.traza && S.traza.semilla) {
    var sm = pxAm(S.traza.semilla[0], S.traza.semilla[1]), ss = w2s(sm[0], sm[1]);
    g.beginPath(); g.arc(ss[0], ss[1], 6, 0, 7); g.fillStyle = pal.acento; g.fill(); g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke();
  }
  /* calibración */
  if (S.calib && S.calib.pts.length) {
    var pts = S.calib.pts.map(function (q) { var m = pxAm(q[0], q[1]); return w2s(m[0], m[1]); });
    if (pts.length === 1 && S.cursor && S.herr === 'calibrar') pts.push(w2s(S.cursor[0], S.cursor[1]));
    if (pts.length === 2) {
      g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); g.lineTo(pts[1][0], pts[1][1]);
      g.lineWidth = 3; g.strokeStyle = pal.halo; g.stroke();
      g.setLineDash([6, 4]); g.lineWidth = 2; g.strokeStyle = pal.error; g.stroke(); g.setLineDash([]);
    }
    S.calib.pts.forEach(function (q, idx) {
      var m = pxAm(q[0], q[1]), sp = w2s(m[0], m[1]);
      g.beginPath(); g.arc(sp[0], sp[1], 6, 0, 7); g.fillStyle = pal.error; g.fill(); g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke();
      g.textAlign = 'left'; g.textBaseline = 'middle'; textoHalo(g, 'P' + (idx + 1), sp[0] + 10, sp[1] - 10, pal, 12);
    });
  }
  /* vértices editables */
  if (S.tab === 'plano' && S.herr === 'seleccionar') {
    var polys = [];
    if (p.contorno.length >= 3) polys.push({ pts: p.contorno, tipo: 'contorno', id: null });
    if (S.sel && S.sel.tipo !== 'contorno') {
      var el = elementoSel();
      if (el && el.poly) polys.push({ pts: el.poly, tipo: S.sel.tipo, id: S.sel.id });
    }
    polys.forEach(function (pp) {
      var esSel = S.sel && S.sel.tipo === pp.tipo && (pp.tipo === 'contorno' || S.sel.id === pp.id);
      if (esSel) { trazarPoly(g, pp.pts); g.lineWidth = 3.5; g.strokeStyle = pal.sel; g.stroke(); }
      pp.pts.forEach(function (q, idx) {
        var sp = w2s(q[0], q[1]);
        var activo = esSel && S.selVert === idx;
        var t = activo ? 6 : 4;
        g.fillStyle = activo ? pal.sel : '#fff'; g.strokeStyle = activo ? '#fff' : pal.contorno; g.lineWidth = 1.6;
        g.beginPath(); g.rect(sp[0] - t, sp[1] - t, 2 * t, 2 * t); g.fill(); g.stroke();
      });
    });
  }
  /* dibujo en curso */
  var d = S.dib;
  if (d) {
    var cur = S.cursor;
    if (d.pts && d.pts.length) {
      var arr = d.pts.slice(); if (cur) arr.push(cur);
      trazarPoly(g, arr, false); g.lineWidth = 2.5; g.strokeStyle = pal.sel; g.setLineDash([6, 4]); g.stroke(); g.setLineDash([]);
      d.pts.forEach(function (q, idx) {
        var sp = w2s(q[0], q[1]);
        g.beginPath(); g.arc(sp[0], sp[1], idx === 0 && d.pts.length >= 3 ? 7 : 4, 0, 7); g.fillStyle = idx === 0 ? pal.sel : '#fff'; g.fill(); g.lineWidth = 1.6; g.strokeStyle = pal.sel; g.stroke();
      });
      if (cur && d.pts.length) {
        var l = Math.hypot(cur[0] - d.pts[d.pts.length - 1][0], cur[1] - d.pts[d.pts.length - 1][1]);
        var sc = w2s(cur[0], cur[1]);
        g.textAlign = 'left'; g.textBaseline = 'top'; textoHalo(g, fmt(l, 2) + ' m', sc[0] + 12, sc[1] + 10, pal, 12);
      }
    }
    if (d.a && d.b) {
      var rp = [[d.a[0], d.a[1]], [d.b[0], d.a[1]], [d.b[0], d.b[1]], [d.a[0], d.b[1]]];
      trazarPoly(g, rp); g.globalAlpha = 0.2; g.fillStyle = pal.sel; g.fill(); g.globalAlpha = 1;
      g.setLineDash([6, 4]); g.lineWidth = 2.5; g.strokeStyle = pal.sel; g.stroke(); g.setLineDash([]);
      var sc2 = w2s(d.b[0], d.b[1]);
      g.textAlign = 'left'; g.textBaseline = 'top';
      textoHalo(g, fmt(Math.abs(d.b[0] - d.a[0]), 2) + ' × ' + fmt(Math.abs(d.b[1] - d.a[1]), 2) + ' m', sc2[0] + 12, sc2[1] + 10, pal, 12);
    }
  }
  /* hover rack en Asignar */
  if (S.tab === 'asignar' && S.rackHover && S.rackHover !== S.rackElev) {
    var rh = p.racks.filter(function (r) { return r.id === S.rackHover; })[0];
    if (rh) { trazarPoly(g, rackEsquinas(rh)); g.lineWidth = 2.5; g.strokeStyle = pal.acento; g.stroke(); }
  }
  /* posición seleccionada / en movimiento (marca en planta) */
  [S.posSel, S.moviendo].forEach(function (id, ii) {
    if (!id) return;
    var ps = posPorId()[id];
    if (!ps) return;
    var sp = w2s(ps.cx, ps.cy);
    g.beginPath(); g.arc(sp[0], sp[1], 7, 0, 7);
    g.lineWidth = 3; g.strokeStyle = ii ? pal.error : pal.sel; g.stroke();
    g.lineWidth = 1.2; g.strokeStyle = '#fff'; g.stroke();
  });
  /* indicador de ajuste */
  if (S.cursor && ['columna', 'puerta', 'hueco-rect', 'hueco-poli', 'zona-rect', 'zona-poli', 'contorno-poli'].indexOf(S.herr) >= 0) {
    var cp = w2s(S.cursor[0], S.cursor[1]);
    g.lineWidth = 1.4; g.strokeStyle = pal.sel;
    g.beginPath(); g.moveTo(cp[0] - 9, cp[1]); g.lineTo(cp[0] + 9, cp[1]); g.moveTo(cp[0], cp[1] - 9); g.lineTo(cp[0], cp[1] + 9); g.stroke();
  }
}

function dibujarEscala(g, w, h, pal) {
  var k = S.v.k, largos = [0.5, 1, 2, 5, 10, 20, 50, 100, 200], L = 200, i;
  for (i = 0; i < largos.length; i++) if (largos[i] * k >= 70) { L = largos[i]; break; }
  var x = 16, y = h - 18, px = L * k;
  g.save();
  g.fillStyle = pal.leyenda; g.fillRect(x - 6, y - 20, px + 12, 32);
  g.strokeStyle = pal.texto; g.lineWidth = 2;
  g.beginPath(); g.moveTo(x, y - 5); g.lineTo(x, y); g.lineTo(x + px, y); g.lineTo(x + px, y - 5); g.stroke();
  g.fillStyle = pal.texto; g.font = '600 11px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'bottom';
  g.fillText(L + ' m', x + px / 2, y - 4);
  g.restore();
}

function dibujarLeyenda(g, w, h, pal, cm, modo) {
  if (modo === 'nada' && !(S.capas && S.capas.evac)) return;
  var x = w - 12, y = 12, an = 190, items = [];
  g.save();
  g.font = '600 11px system-ui, sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'left';
  if (modo === 'abc') {
    var alto = 22 + 4 * 20;
    x -= an;
    g.fillStyle = pal.leyenda; g.fillRect(x, y, an, alto);
    g.strokeStyle = pal.rackBorde; g.lineWidth = 1; g.strokeRect(x + .5, y + .5, an, alto);
    g.fillStyle = pal.texto; g.fillText('Clase ABC (por rotación)', x + 8, y + 12);
    var defs = [['A', 'Alta rotación', COLOR_ABC.A], ['B', 'Media', COLOR_ABC.B], ['C', 'Baja', COLOR_ABC.C], ['—', 'Hueco libre', pal.vacioCol]];
    var pt = crearPatrones(g);
    defs.forEach(function (d, i2) {
      var yy = y + 22 + i2 * 20 + 9;
      g.fillStyle = d[2]; g.fillRect(x + 8, yy - 8, 22, 16);
      if (d[0] === 'A' && pt.A) { g.fillStyle = pt.A; g.fillRect(x + 8, yy - 8, 22, 16); }
      if (d[0] === 'B' && pt.B) { g.fillStyle = pt.B; g.fillRect(x + 8, yy - 8, 22, 16); }
      g.strokeStyle = pal.rackBorde; g.strokeRect(x + 8.5, yy - 7.5, 22, 16);
      g.fillStyle = pal.texto; g.fillText((d[0] === '—' ? '' : d[0] + ' · ') + d[1], x + 38, yy);
    });
  } else if (modo === 'rol') {
    x -= an;
    g.fillStyle = pal.leyenda; g.fillRect(x, y, an, 82);
    g.strokeStyle = pal.rackBorde; g.lineWidth = 1; g.strokeRect(x + .5, y + .5, an, 82);
    g.fillStyle = pal.texto; g.fillText('Rol de la posición', x + 8, y + 12);
    [['P · picking (se toma de aquí)', COLOR_ROL.picking], ['R · reserva (repone al picking)', COLOR_ROL.reserva], ['Hueco libre / sin rol', pal.vacioCol]].forEach(function (d, i4) {
      var yy = y + 30 + i4 * 17; g.fillStyle = d[1]; g.fillRect(x + 8, yy - 7, 22, 14); g.strokeStyle = pal.rackBorde; g.strokeRect(x + 8.5, yy - 6.5, 22, 14);
      g.fillStyle = pal.texto; g.fillText(d[0], x + 36, yy);
    });
    if (!(S.proy.resultado && S.proy.resultado.rolPorPosicion && Object.keys(S.proy.resultado.rolPorPosicion).length)) { g.fillStyle = pal.texto; g.fillText('Sin roles: active «picking/reserva»', x + 8, y + 74); }
  } else if (modo === 'carga') {
    var an3 = Math.max(190, Math.min(272, w - 24));   // B-5: más ancha y con el texto medido para que no se corte
    x = w - 12 - an3;
    var alto3 = 80;
    g.fillStyle = pal.leyenda; g.fillRect(x, y, an3, alto3);
    g.strokeStyle = pal.rackBorde; g.lineWidth = 1; g.strokeRect(x + .5, y + .5, an3, alto3);
    var ajusta = function (t, px, peso) {   // reduce la letra hasta que el texto quepa
      var f = px; g.font = peso + ' ' + f + 'px system-ui, sans-serif';
      while (f > 8 && g.measureText(t).width > an3 - 16) { f -= 0.5; g.font = peso + ' ' + f + 'px system-ui, sans-serif'; }
      return t;
    };
    g.fillStyle = pal.texto; g.fillText(ajusta('Carga por módulo (kg / capacidad)', 11, 600), x + 8, y + 12);
    var gr2 = g.createLinearGradient(x + 8, 0, x + an3 - 8, 0);
    HEAT.forEach(function (c, i5) { gr2.addColorStop(i5 / (HEAT.length - 1), c); });
    g.fillStyle = gr2; g.fillRect(x + 8, y + 22, an3 - 16, 12);
    g.strokeStyle = pal.rackBorde; g.strokeRect(x + 8.5, y + 22.5, an3 - 16, 12);
    g.fillStyle = pal.texto; g.font = '600 11px system-ui, sans-serif'; g.textAlign = 'left'; g.fillText('0 %', x + 8, y + 44); g.textAlign = 'right'; g.fillText('100 %  (! = excede)', x + an3 - 8, y + 44);
    g.textAlign = 'left';
    g.fillText(ajusta('Capacidad: dato suyo (placa) si lo puso;', 10, 500), x + 8, y + 58);
    g.fillText(ajusta('si no, suma de cargas máx. por posición.', 10, 500), x + 8, y + 71);
  } else if (cm && (modo === 'dist' || modo === 'picks')) {
    x -= an;
    var alto2 = 54;
    g.fillStyle = pal.leyenda; g.fillRect(x, y, an, alto2);
    g.strokeStyle = pal.rackBorde; g.lineWidth = 1; g.strokeRect(x + .5, y + .5, an, alto2);
    g.fillStyle = pal.texto;
    g.fillText(modo === 'dist' ? 'Distancia caminando al despacho' : 'Picks del SKU ubicado', x + 8, y + 12);
    var gr = g.createLinearGradient(x + 8, 0, x + an - 8, 0);
    HEAT.forEach(function (c, i3) { gr.addColorStop(i3 / (HEAT.length - 1), c); });
    g.fillStyle = gr; g.fillRect(x + 8, y + 22, an - 16, 12);
    g.strokeStyle = pal.rackBorde; g.strokeRect(x + 8.5, y + 22.5, an - 16, 12);
    g.fillStyle = pal.texto; g.textAlign = 'left'; g.fillText('0', x + 8, y + 44);
    g.textAlign = 'right';
    g.fillText(modo === 'dist' ? fmt(cm.maxD, 0) + ' m' : fmt(cm.maxP, 0), x + an - 8, y + 44);
  }
  if (S.capas && S.capas.evac) {
    var ev2 = muestrasEvac();
    var xe = w - 12 - an, ye = h - 74;
    g.fillStyle = pal.leyenda; g.fillRect(xe, ye, an, 62);
    g.strokeStyle = pal.rackBorde; g.lineWidth = 1; g.strokeRect(xe + .5, ye + .5, an, 62);
    g.fillStyle = pal.texto; g.font = '600 11px system-ui, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
    g.font = '600 10px system-ui, sans-serif'; g.fillText('Evacuación (m a la salida)', xe + 8, ye + 11);
    if (ev2 && ev2.lista.length) {
      var gr3 = g.createLinearGradient(xe + 8, 0, xe + an - 8, 0);
      HEAT.forEach(function (c, i6) { gr3.addColorStop(i6 / (HEAT.length - 1), c); });
      g.fillStyle = gr3; g.fillRect(xe + 8, ye + 20, an - 16, 11); g.strokeStyle = pal.rackBorde; g.strokeRect(xe + 8.5, ye + 20.5, an - 16, 11);
      g.fillStyle = pal.texto; g.fillText('0', xe + 8, ye + 41); g.textAlign = 'right'; g.fillText(fmt(ev2.max, 0) + ' m', xe + an - 8, ye + 41);
      g.textAlign = 'left'; g.font = '500 10px system-ui, sans-serif'; g.fillText(ev2.obsoleto ? 'Desactualizado: recalcule' : 'Solo valores; límite: dato suyo', xe + 8, ye + 54);
    } else { g.fillText('Sin datos: calcule el Análisis', xe + 8, ye + 34); }
  }
  g.restore();
}
function muestrasEvac() {
  var an = S.analisis && S.analisis.res, ev = an && an.evacuacion, m = ev && ev.mapa && ev.mapa.muestras;
  if (!Array.isArray(m) || !m.length) return null;
  return cache('evacm', (S.analisis.ver || 0) + '|' + m.length + '|' + S.ver, function () {
    var lista = [], mx = 0;
    m.slice(0, 6000).forEach(function (q) {
      var x = Array.isArray(q) ? q[0] : q && q.x, y = Array.isArray(q) ? q[1] : q && q.y, d = Array.isArray(q) ? q[2] : q && q.d;
      if (typeof x === 'number' && typeof y === 'number' && typeof d === 'number' && isFinite(x) && isFinite(y) && isFinite(d)) { lista.push({ x: x, y: y, d: d }); if (d > mx) mx = d; }
    });
    var cel = ev.mapa.celdaM > 0 && ev.mapa.celdaM < 5 ? ev.mapa.celdaM : null, pasoC = ev.mapa.paso > 0 && ev.mapa.paso < 20 ? ev.mapa.paso : 1;
    /* el motor entrega «paso» en celdas de «celdaM» m: el lado del cuadro dibujado es paso × celdaM (si no hay celdaM, paso ya está en m) */
    return { lista: lista, max: mx, paso: cel ? pasoC * cel : pasoC, obsoleto: S.analisis.ver !== S.ver };
  });
}

/* ciclo de dibujo */
var dibPend = false;
function pedirDibujo() {
  if (dibPend) return;
  dibPend = true;
  var hecho = false;
  function ir() {
    if (hecho) return; hecho = true; dibPend = false;
    try { dibujarLienzo(); } catch (e) { console.error(e); if (!S.errDibAvisado) { S.errDibAvisado = true; aviso('No se pudo dibujar el plano: ' + e.message + '. Revise los datos del proyecto.', 'error', 9000); } }
  }
  requestAnimationFrame(ir);
  setTimeout(ir, 60);
}
function dibujarLienzo() {
  if (!ctx) return;
  var tabLienzo = S.tab === 'plano' || S.tab === 'racks' || S.tab === 'asignar';
  if (!tabLienzo || !W || !H) return;
  // si el mapa de distancias está pedido y no calculado, calcularlo con aviso
  if (S.tab === 'asignar' && S.vistaMapa === 'dist' && !distListo() && getPos().length && !S.ocupado) {
    conEspera('Calculando distancias caminando…', function () { getDist(); }).then(function () { pedirDibujo(); refrescarAsignarDetalle(); });
  }
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  dibujarEscena(ctx, W, H, { pal: paletaActual(), ui: true, grid: $('#chk-grid').checked });
  actualizarEstadoLienzo();
}
function ajustarLienzo() {
  var marco = $('#marco');
  var r = marco.getBoundingClientRect();
  DPR = window.devicePixelRatio || 1;
  var nw = Math.max(1, Math.round(r.width)), nh = Math.max(1, Math.round(r.height));
  if (nw === W && nh === H && cv.width === Math.round(nw * DPR)) return;
  var primero = !W;
  W = nw; H = nh;
  cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
  if (primero && S.encajarPendiente) { S.encajarPendiente = false; encajar(); }
  pedirDibujo();
}

/* ------------------------------------------------------------------ selección y herramientas */
function elementoSel() {
  var s = S.sel, p = S.proy;
  if (!s) return null;
  if (s.tipo === 'contorno') return p.contorno.length >= 3 ? { poly: p.contorno } : null;
  var lista = { hueco: p.huecos, puerta: p.puertas, zona: p.zonas, rack: p.racks }[s.tipo] || [];
  for (var i = 0; i < lista.length; i++) if (lista[i].id === s.id) return lista[i];
  return null;
}
var MSG_HERR = {
  seleccionar: '',
  mano: 'Arrastra para desplazar el plano.',
  calibrar: 'Haz clic en el primer punto conocido de la imagen.',
  trazo: 'Haz clic DENTRO del almacén (sobre el piso libre) en la imagen.',
  columna: 'Clic para colocar una columna. Esc para terminar.',
  puerta: 'Clic para colocar una puerta. Esc para terminar.',
  'hueco-rect': 'Arrastra de una esquina a la opuesta. Esc para terminar.',
  'hueco-poli': 'Clic por vértice; doble clic o Enter para cerrar; Esc cancela.',
  'zona-rect': 'Arrastra de una esquina a la opuesta. Esc para terminar.',
  'zona-poli': 'Clic por vértice; doble clic o Enter para cerrar; Esc cancela.',
  'contorno-poli': 'Clic por esquina; doble clic o Enter para cerrar; Esc cancela.'
};
function ponerHerr(h) {
  S.herr = h;
  S.dib = null;
  $$('[data-herr]').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-herr') === h ? 'true' : 'false'); });
  $('#tb-herr-msg').textContent = MSG_HERR[h] || '';
  var cur = 'default';
  if (h === 'mano') cur = 'grab';
  else if (h !== 'seleccionar') cur = 'crosshair';
  cv.style.cursor = cur;
  pedirDibujo();
}
function snapW(w, e) {
  var s = num($('#sel-snap').value, 0);
  if (!s || (e && e.altKey)) return w;
  return [Math.round(Math.round(w[0] / s) * s * 1e4) / 1e4, Math.round(Math.round(w[1] / s) * s * 1e4) / 1e4];
}
function golpe(wx, wy) {
  var p = S.proy, k = S.v.k, i, j, tolV = 9 / k;
  var pt = [wx, wy];
  if (S.tab === 'plano') {
    var cands = [];
    var el = S.sel && S.sel.tipo !== 'contorno' ? elementoSel() : null;
    if (el && el.poly) cands.push({ tipo: S.sel.tipo, id: S.sel.id, poly: el.poly });
    if (p.contorno.length >= 3) cands.push({ tipo: 'contorno', id: null, poly: p.contorno });
    for (i = 0; i < cands.length; i++) {
      for (j = 0; j < cands[i].poly.length; j++) {
        var q = cands[i].poly[j];
        if (Math.hypot(q[0] - wx, q[1] - wy) < tolV) return { tipo: cands[i].tipo, id: cands[i].id, vert: j };
      }
    }
    for (i = p.puertas.length - 1; i >= 0; i--) {
      if (Math.abs(p.puertas[i].x - wx) < 12 / k && Math.abs(p.puertas[i].y - wy) < 12 / k) return { tipo: 'puerta', id: p.puertas[i].id };
    }
    for (i = p.huecos.length - 1; i >= 0; i--) {
      var hh = p.huecos[i];
      if (hh.poly && hh.poly.length >= 3) {
        if (enPoly(pt, hh.poly)) return { tipo: 'hueco', id: hh.id };
        var cc = centroide(hh.poly);
        if (Math.hypot(cc[0] - wx, cc[1] - wy) < 7 / k) return { tipo: 'hueco', id: hh.id };
      }
    }
    for (i = p.zonas.length - 1; i >= 0; i--) {
      if (p.zonas[i].poly && enPoly(pt, p.zonas[i].poly)) return { tipo: 'zona', id: p.zonas[i].id };
    }
    if (p.contorno.length >= 3) {
      for (i = 0; i < p.contorno.length; i++) {
        var d = distPtSeg(pt, p.contorno[i], p.contorno[(i + 1) % p.contorno.length]);
        if (d.d < 6 / k) return { tipo: 'contorno', id: null };
      }
    }
    return null;
  }
  for (i = p.racks.length - 1; i >= 0; i--) {
    if (enPoly(pt, rackEsquinas(p.racks[i]))) return { tipo: 'rack', id: p.racks[i].id };
  }
  return null;
}
function ptrPos(e) {
  var r = cv.getBoundingClientRect();
  var sx = e.clientX - r.left, sy = e.clientY - r.top;
  return { sx: sx, sy: sy, w: s2w(sx, sy) };
}

function onDown(e) {
  if (S.ocupado) return;
  cv.focus({ preventScroll: true });
  var pp = ptrPos(e), w = pp.w;
  var ws = snapW(w, e);
  S.cursor = ws;
  // panorámica
  if (e.button === 1 || e.button === 2 || S.espacio || S.herr === 'mano') {
    iniciarPan(e, pp); return;
  }
  if (e.button !== 0) return;
  var h = S.herr;
  if (h === 'seleccionar') { seleccionarYArrastrar(e, pp, ws); return; }
  if (h === 'calibrar') { clicCalibrar(w); return; }
  if (h === 'trazo') { clicTrazo(w); return; }
  if (h === 'columna') { colocarColumna(ws); return; }
  if (h === 'puerta') { colocarPuerta(ws); return; }
  if (h === 'hueco-rect' || h === 'zona-rect') {
    if (S.dib && S.dib.esperando) { S.dib.b = ws; cerrarRect(); return; }
    S.dib = { tipo: h, a: ws, b: ws, arrastrando: true, sx: pp.sx, sy: pp.sy };
    cv.setPointerCapture(e.pointerId);
    pedirDibujo(); return;
  }
  if (h === 'hueco-poli' || h === 'zona-poli' || h === 'contorno-poli') {
    if (!S.dib) S.dib = { tipo: h, pts: [] };
    var d = S.dib;
    if (d.pts.length >= 3) {
      var f = w2s(d.pts[0][0], d.pts[0][1]);
      if (Math.hypot(f[0] - pp.sx, f[1] - pp.sy) < 10) { cerrarPoli(); return; }
    }
    var ult = d.pts[d.pts.length - 1];
    if (!ult || Math.hypot(ult[0] - ws[0], ult[1] - ws[1]) > 1e-6) d.pts.push(ws);
    pedirDibujo();
  }
}
function iniciarPan(e, pp) {
  S.drag = { tipo: 'pan', sx: pp.sx, sy: pp.sy, ox: S.v.ox, oy: S.v.oy };
  cv.setPointerCapture(e.pointerId);
  cv.style.cursor = 'grabbing';
}
function seleccionarYArrastrar(e, pp, ws) {
  var w = pp.w;
  var g = golpe(w[0], w[1]);
  var antes = null;
  if (!g) {
    S.sel = null; S.selVert = null;
    if (S.tab === 'asignar') { /* mantener elevación fijada */ }
    refrescarPanelesSeleccion();
    iniciarPan(e, pp);
    return;
  }
  S.sel = { tipo: g.tipo, id: g.id };
  S.selVert = g.vert != null ? g.vert : null;
  if (g.tipo === 'rack') {
    S.rackElev = g.id;
    if (S.tab === 'asignar') { refrescarAsignarDetalle(); refrescarPanelesSeleccion(); pedirDibujo(); return; }
  }
  refrescarPanelesSeleccion();
  var el = elementoSel();
  if (!el) return;
  antes = snap();
  cv.setPointerCapture(e.pointerId);
  if (g.vert != null) {
    S.drag = { tipo: 'vert', antes: antes, movido: false, idx: g.vert };
  } else if (g.tipo === 'contorno') {
    iniciarPan(e, pp);
    S.drag.tipo = 'pan';
  } else if (el.poly) {
    S.drag = { tipo: 'mover', antes: antes, movido: false, ini: ws, orig: clonar(el.poly) };
  } else if (g.tipo === 'puerta') {
    S.drag = { tipo: 'mover', antes: antes, movido: false, ini: ws, orig: [el.x, el.y] };
  } else if (g.tipo === 'rack') {
    S.drag = { tipo: 'mover', antes: antes, movido: false, ini: w, orig: [el.cx, el.cy] };
  }
  pedirDibujo();
}
function onMove(e) {
  var pp = ptrPos(e), w = pp.w, ws = snapW(w, e);
  S.cursor = ws;
  var d = S.drag;
  if (d) {
    if (d.tipo === 'pan') {
      S.v.ox = d.ox + (pp.sx - d.sx); S.v.oy = d.oy + (pp.sy - d.sy);
    } else if (d.tipo === 'vert') {
      var el = elementoSel();
      if (el && el.poly) {
        var pt = ws;
        el.poly[d.idx] = [pt[0], pt[1]];
        if (!d.movido) d.movido = true;
        tocar();
      }
    } else if (d.tipo === 'mover') {
      var el2 = elementoSel();
      if (el2) {
        var dx, dy;
        if (S.sel.tipo === 'rack') {
          var base = [d.orig[0] + (w[0] - d.ini[0]), d.orig[1] + (w[1] - d.ini[1])];
          var sn = snapW(base, e);
          dx = sn[0] - d.orig[0]; dy = sn[1] - d.orig[1];
          el2.cx = d.orig[0] + dx; el2.cy = d.orig[1] + dy;
        } else if (S.sel.tipo === 'puerta') {
          el2.x = ws[0]; el2.y = ws[1];
        } else if (el2.poly) {
          dx = ws[0] - d.ini[0]; dy = ws[1] - d.ini[1];
          el2.poly = d.orig.map(function (q) { return [q[0] + dx, q[1] + dy]; });
        }
        if (Math.hypot(w[0] - d.ini[0], w[1] - d.ini[1]) * S.v.k > 3) { d.movido = true; tocar(); }
      }
    }
    pedirDibujo();
    actualizarEstadoLienzo();
    return;
  }
  if (S.dib && S.dib.arrastrando) {
    S.dib.b = ws;
  } else if (S.dib && S.dib.esperando) {
    S.dib.b = ws;
  }
  // hover (Asignar)
  if (S.tab === 'asignar' && S.herr === 'seleccionar') {
    var g = golpe(w[0], w[1]);
    var id = g && g.tipo === 'rack' ? g.id : null;
    if (id !== S.rackHover) { S.rackHover = id; refrescarElevacion(); }
    cv.style.cursor = id ? 'pointer' : 'default';
  } else if (S.herr === 'seleccionar' && !S.drag) {
    var g2 = golpe(w[0], w[1]);
    cv.style.cursor = g2 ? (g2.vert != null ? 'move' : 'pointer') : 'default';
  }
  pedirDibujo();
  actualizarEstadoLienzo();
}
function onUp(e) {
  var d = S.drag;
  if (d) {
    S.drag = null;
    try { cv.releasePointerCapture(e.pointerId); } catch (x) { /* nada */ }
    if (d.tipo === 'pan') { ponerCursorHerr(); pedirDibujo(); return; }
    if (d.movido) {
      var el = elementoSel();
      if (el && S.sel && S.sel.tipo === 'rack') { el.auto = false; }
      pushUndo(d.antes);
      invalidarResultado();
      tocar();
      trasCambio();
    }
    return;
  }
  if (S.dib && S.dib.arrastrando) {
    var dd = S.dib, pp = ptrPos(e);
    dd.arrastrando = false;
    try { cv.releasePointerCapture(e.pointerId); } catch (x2) { /* nada */ }
    if (Math.hypot(pp.sx - dd.sx, pp.sy - dd.sy) > 6) { dd.b = snapW(pp.w, e); cerrarRect(); }
    else { dd.esperando = true; $('#tb-herr-msg').textContent = 'Haz clic en la esquina opuesta.'; }
    pedirDibujo();
  }
}
function ponerCursorHerr() {
  cv.style.cursor = S.herr === 'mano' ? 'grab' : (S.herr === 'seleccionar' ? 'default' : 'crosshair');
}

function cerrarRect() {
  var d = S.dib;
  if (!d || !d.a || !d.b) return;
  var x0 = Math.min(d.a[0], d.b[0]), x1 = Math.max(d.a[0], d.b[0]), y0 = Math.min(d.a[1], d.b[1]), y1 = Math.max(d.a[1], d.b[1]);
  S.dib = null;
  $('#tb-herr-msg').textContent = MSG_HERR[S.herr] || '';
  if (x1 - x0 < 0.05 || y1 - y0 < 0.05) { aviso('El rectángulo es demasiado pequeño.', 'warn'); return; }
  var poly = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  if (d.tipo === 'hueco-rect') anadirHueco(poly, $('#sel-hueco-tipo').value);
  else anadirZona(poly, $('#sel-zona-tipo').value);
}
function cerrarPoli() {
  var d = S.dib;
  if (!d || !d.pts) return;
  var pts = d.pts.slice();
  // quitar duplicados consecutivos (el doble clic agrega el mismo punto dos veces)
  var lim = [];
  pts.forEach(function (q) {
    var u = lim[lim.length - 1];
    if (!u || Math.hypot(u[0] - q[0], u[1] - q[1]) > 1e-6) lim.push(q);
  });
  if (lim.length > 1 && Math.hypot(lim[0][0] - lim[lim.length - 1][0], lim[0][1] - lim[lim.length - 1][1]) < 1e-6) lim.pop();
  S.dib = null;
  if (lim.length < 3 || areaAbs(lim) < 1e-4) { aviso('Se necesitan al menos 3 puntos que formen un área.', 'warn'); pedirDibujo(); return; }
  if (d.tipo === 'contorno-poli') {
    mutar(function () { S.proy.contorno = lim; });
    S.sel = { tipo: 'contorno' };
    ponerHerr('seleccionar');
    aviso('Contorno creado (' + fmt(areaAbs(lim), 1) + ' m²).', 'ok');
    encajar();
  } else if (d.tipo === 'hueco-poli') anadirHueco(lim, $('#sel-hueco-tipo').value);
  else anadirZona(lim, $('#sel-zona-tipo').value);
  pedirDibujo();
}
function anadirHueco(poly, tipo) {
  var id = nuevoId(S.proy.huecos, 'H');
  mutar(function () { S.proy.huecos.push({ id: id, tipo: tipo || 'otro', poly: poly }); });
  S.sel = { tipo: 'hueco', id: id }; S.selVert = null;
  refrescarPanelesSeleccion();
}
function anadirZona(poly, tipo) {
  var id = nuevoId(S.proy.zonas, 'Z');
  var n = S.proy.zonas.filter(function (z) { return z.tipo === tipo; }).length + 1;
  mutar(function () { var z = { id: id, nombre: (NOMBRES_ZONA[tipo] || 'Zona').replace(/ \(.*\)$/, '') + ' ' + n, tipo: tipo || 'general', poly: poly }; if (tipo === 'almacenaje') z.cfg = {}; S.proy.zonas.push(z); });
  S.sel = { tipo: 'zona', id: id }; S.selVert = null;
  refrescarPanelesSeleccion();
}
function colocarColumna(pt) {
  var L = Math.max(0.1, num($('#inp-col-tam').value, 0.5)), h = L / 2;
  anadirHueco([[pt[0] - h, pt[1] - h], [pt[0] + h, pt[1] - h], [pt[0] + h, pt[1] + h], [pt[0] - h, pt[1] + h]], 'columna');
}
function colocarPuerta(pt) {
  var tipo = $('#sel-puerta-tipo').value, id = nuevoId(S.proy.puertas, 'P');
  var n = S.proy.puertas.filter(function (d) { return d.tipo === tipo; }).length + 1;
  mutar(function () { S.proy.puertas.push({ id: id, nombre: NOMBRES_PUERTA[tipo] + ' ' + n, tipo: tipo, x: pt[0], y: pt[1] }); });
  S.sel = { tipo: 'puerta', id: id }; S.selVert = null;
  refrescarPanelesSeleccion();
}

function onDbl(e) {
  var pp = ptrPos(e);
  if (S.dib && S.dib.pts) { cerrarPoli(); e.preventDefault(); return; }
  if (S.herr === 'seleccionar' && S.tab === 'plano') {
    // insertar vértice en borde del polígono seleccionado o del contorno
    var el = S.sel && S.sel.tipo !== 'contorno' ? elementoSel() : null;
    var poly = el && el.poly ? el.poly : (S.proy.contorno.length >= 3 ? S.proy.contorno : null);
    var tipoSel = el && el.poly ? S.sel.tipo : 'contorno';
    if (!poly) return;
    var best = null, i;
    for (i = 0; i < poly.length; i++) {
      var d = distPtSeg(pp.w, poly[i], poly[(i + 1) % poly.length]);
      if (d.d * S.v.k < 8 && (!best || d.d < best.d)) best = { d: d.d, i: i, q: d.q };
    }
    if (best) {
      mutar(function () { poly.splice(best.i + 1, 0, snapW(best.q, e)); });
      S.sel = tipoSel === 'contorno' ? { tipo: 'contorno' } : { tipo: tipoSel, id: S.sel.id };
      S.selVert = best.i + 1;
      refrescarPanelesSeleccion();
    }
  }
}
function onWheel(e) {
  e.preventDefault();
  var pp = ptrPos(e);
  var dy = e.deltaY * (e.deltaMode === 1 ? 16 : 1);
  zoomEn(Math.exp(-dy * 0.0016), pp.sx, pp.sy);
  actualizarEstadoLienzo();
}

function borrarSeleccion() {
  var s = S.sel;
  if (!s) return;
  var p = S.proy;
  var el = elementoSel();
  if (!el) return;
  if (S.selVert != null && el.poly && el.poly.length > 3) {
    var idx = S.selVert;
    mutar(function () { el.poly.splice(idx, 1); });
    S.selVert = null;
    return;
  }
  mutar(function () {
    if (s.tipo === 'contorno') p.contorno = [];
    else if (s.tipo === 'hueco') p.huecos = p.huecos.filter(function (x) { return x.id !== s.id; });
    else if (s.tipo === 'zona') p.zonas = p.zonas.filter(function (x) { return x.id !== s.id; });
    else if (s.tipo === 'puerta') p.puertas = p.puertas.filter(function (x) { return x.id !== s.id; });
    else if (s.tipo === 'rack') p.racks = p.racks.filter(function (x) { return x.id !== s.id; });
  });
  S.sel = null; S.selVert = null;
  refrescarPanelesSeleccion();
}
function rotarRack() {
  if (!S.sel || S.sel.tipo !== 'rack') { aviso('Selecciona un rack para rotarlo.', 'info'); return; }
  var r = elementoSel();
  if (!r) return;
  mutar(function () { r.ang = ((r.ang || 0) + 90) % 360; r.auto = false; });
}

function onKey(e) {
  var t = e.target, tag = t && t.tagName;
  var enCampo = t && (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || t.isContentEditable);
  var dlgAbierto = $('#dlg').open;
  if (dlgAbierto) return;
  var ctrl = e.ctrlKey || e.metaKey;
  var k = (e.key || '').toLowerCase();
  if (ctrl && k === 'z') {
    if (enCampo && tag !== 'SELECT' && !(t.type === 'range' || t.type === 'checkbox')) return;
    e.preventDefault();
    if (e.shiftKey) rehacer(); else deshacer();
    return;
  }
  if (ctrl && k === 'y') {
    if (enCampo && !(t.type === 'range' || t.type === 'checkbox')) return;
    e.preventDefault(); rehacer(); return;
  }
  var tabLienzo = S.tab === 'plano' || S.tab === 'racks' || S.tab === 'asignar';
  if (!tabLienzo) return;
  if (e.key === ' ' && !enCampo && tag !== 'BUTTON') { S.espacio = true; cv.style.cursor = 'grab'; e.preventDefault(); return; }
  if (enCampo) return;
  if (ctrl || e.altKey) return;
  if (k === 'r' && tag !== 'BUTTON') { if (S.tab === 'racks') rotarRack(); return; }
  if (k === 'f') { encajar(); return; }
  if (k === 'v') { ponerHerr('seleccionar'); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (S.dib && S.dib.pts && S.dib.pts.length) { S.dib.pts.pop(); if (!S.dib.pts.length) S.dib = null; pedirDibujo(); e.preventDefault(); return; }
    if (S.tab !== 'asignar' && tag !== 'BUTTON') { borrarSeleccion(); e.preventDefault(); }
    return;
  }
  if (e.key === 'Escape') {
    if (S.dib) { S.dib = null; $('#tb-herr-msg').textContent = MSG_HERR[S.herr] || ''; pedirDibujo(); return; }
    if (S.moviendo) { S.moviendo = null; refrescarAsignarDetalle(); pedirDibujo(); return; }
    if (S.herr === 'calibrar') { cancelarCalibracion(); return; }
    if (S.herr !== 'seleccionar') { ponerHerr('seleccionar'); return; }
    S.sel = null; S.selVert = null; refrescarPanelesSeleccion(); pedirDibujo();
    return;
  }
  if (e.key === 'Enter') {
    if (S.dib && S.dib.pts) { cerrarPoli(); e.preventDefault(); }
    return;
  }
}
function onKeyUp(e) {
  if (e.key === ' ' && S.espacio) { S.espacio = false; ponerCursorHerr(); }
}

function actualizarEstadoLienzo() {
  var c = S.cursor;
  $('#est-coord').textContent = c ? 'x: ' + fmt(c[0], 2) + ' m · y: ' + fmt(c[1], 2) + ' m' : 'x: — m · y: — m';
  $('#est-zoom').textContent = 'Zoom: ' + fmt(S.v.k, 1) + ' px/m';
}

/* ------------------------------------------------------------------ calibración y auto-trazo */
function clicCalibrar(w) {
  if (!S.proy.plano.imagen) { aviso('Primero sube una imagen del plano.', 'warn'); return; }
  var px = mApx(w[0], w[1]);
  if (!S.calib) S.calib = { pts: [] };
  if (S.calib.pts.length >= 2) S.calib.pts = [];
  S.calib.pts.push(px);
  if (S.calib.pts.length === 1) {
    $('#tb-herr-msg').textContent = 'Ahora haz clic en el segundo punto.';
  } else {
    $('#tb-herr-msg').textContent = 'Escribe la distancia real entre los dos puntos.';
    $('#form-calib').hidden = false;
    $('#inp-metros').focus();
  }
  pedirDibujo();
}
function cancelarCalibracion() {
  S.calib = null;
  $('#form-calib').hidden = true;
  ponerHerr('seleccionar');
}
function aplicarCalibracion() {
  if (!S.calib || S.calib.pts.length < 2) { aviso('Marca primero los 2 puntos en la imagen.', 'warn'); return; }
  var m = num($('#inp-metros').value, 0);
  if (!(m > 0)) { aviso('Escribe una distancia mayor que cero.', 'warn'); $('#inp-metros').focus(); return; }
  var pts = S.calib.pts;
  if (Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) < 2) { aviso('Los dos puntos están casi juntos. Elige puntos más separados.', 'warn'); return; }
  var esc;
  try { esc = M.escalaDesdeCalibracion(pts[0], pts[1], m); } catch (e) { aviso('Error al calibrar: ' + e.message, 'error'); return; }
  if (!(esc > 0) || !isFinite(esc)) { aviso('No se pudo calcular la escala.', 'error'); return; }
  mutar(function () { S.proy.plano.mPorPx = esc; }, { inv: false });
  S.calib = null;
  $('#form-calib').hidden = true;
  $('#inp-metros').value = '';
  ponerHerr('seleccionar');
  aviso('Escala calibrada: 1 px = ' + fmt(esc, 4) + ' m. Imagen de ' + fmt(S.proy.plano.anchoPx * esc, 1) + ' × ' + fmt(S.proy.plano.altoPx * esc, 1) + ' m.', 'ok', 6000);
  encajar();
}
function clicTrazo(w) {
  var pl = S.proy.plano;
  if (!pl.imagen || !imagenLista()) { aviso('Sube una imagen primero.', 'warn'); return; }
  if (!pl.mPorPx) { aviso('Calibra la escala antes de trazar (paso 2).', 'warn'); ponerHerr('seleccionar'); return; }
  var px = mApx(w[0], w[1]);
  if (px[0] < 0 || px[1] < 0 || px[0] >= pl.anchoPx || px[1] >= pl.altoPx) { aviso('Haz clic dentro de la imagen.', 'warn'); return; }
  S.traza = S.traza || {};
  S.traza.semilla = [Math.round(px[0]), Math.round(px[1])];
  $('#trz-panel').hidden = false;
  $('#tb-herr-msg').textContent = 'Ajusta los controles; otro clic cambia el punto de partida.';
  recalcularTraza(true);
}
var tTraza = null;
function recalcularTraza(ya) {
  clearTimeout(tTraza);
  $('#trz-info').textContent = 'Calculando…';
  tTraza = setTimeout(calcularTraza, ya ? 10 : 140);
}
function calcularTraza() {
  var t = S.traza;
  if (!t || !t.semilla) return;
  var pix = obtenerPixeles();
  if (!pix) return;
  var umbral = num($('#trz-umbral').value, 180), tol = num($('#trz-tol').value, 3), amin = num($('#trz-areamin').value, 40);
  var k = pix.k, res;
  try {
    res = M.contornoDesdeImagen({
      data: pix.data, ancho: pix.w, alto: pix.h,
      semilla: [Math.min(pix.w - 1, Math.max(0, Math.round(t.semilla[0] * k))), Math.min(pix.h - 1, Math.max(0, Math.round(t.semilla[1] * k)))],
      umbral: umbral, tolerancia: Math.max(0, tol * k), areaMinHuecoPx: Math.max(1, amin * k * k)
    });
  } catch (e) {
    $('#trz-info').innerHTML = '<span class="chip err">Error</span> ' + esc(e.message);
    return;
  }
  var conv = function (q) { return pxAm(q[0] / k, q[1] / k); };
  var cont = (res.contornoPx || []).map(conv);
  var huecos = (res.huecosPx || []).map(function (hh) { return hh.map(conv); });
  t.res = { contornoM: cont, huecosM: huecos, advertencias: res.advertencias || [], areaPx: res.areaPx };
  var html = '';
  if (cont.length >= 3) {
    html += '<b>' + fmt(areaAbs(cont), 1) + ' m²</b> · ' + cont.length + ' vértices · ' + huecos.length + ' obstáculos internos detectados.';
  } else {
    html += '<span class="chip err">Sin contorno</span> No se encontró un área. Prueba con otro punto o cambia el umbral.';
  }
  (t.res.advertencias).forEach(function (a) { html += '<div class="msg aviso">' + esc(a) + '</div>'; });
  $('#trz-info').innerHTML = html;
  $('#btn-trz-ok').disabled = cont.length < 3;
  pedirDibujo();
}
function cancelarTraza() {
  S.traza = null;
  $('#trz-panel').hidden = true;
  ponerHerr('seleccionar');
}
function aplicarTraza() {
  var t = S.traza;
  if (!t || !t.res || t.res.contornoM.length < 3) return;
  var r = t.res;
  mutar(function () {
    S.proy.contorno = r.contornoM.map(function (q) { return [Math.round(q[0] * 1000) / 1000, Math.round(q[1] * 1000) / 1000]; });
    S.proy.huecos = S.proy.huecos.filter(function (h) { return !h.auto; });
    r.huecosM.forEach(function (hp) {
      var bb = bboxPts(hp), lado = Math.max(bb[2] - bb[0], bb[3] - bb[1]);
      var id = nuevoId(S.proy.huecos, 'H');
      S.proy.huecos.push({ id: id, tipo: lado <= 1.5 ? 'columna' : 'otro', auto: true, poly: hp.map(function (q) { return [Math.round(q[0] * 1000) / 1000, Math.round(q[1] * 1000) / 1000]; }) });
    });
  });
  var nh = r.huecosM.length;
  S.traza = null;
  $('#trz-panel').hidden = true;
  S.sel = { tipo: 'contorno' };
  ponerHerr('seleccionar');
  aviso('Contorno aplicado (' + S.proy.contorno.length + ' vértices, ' + nh + ' obstáculos). Puedes arrastrar los vértices para afinarlo.', 'ok', 6000);
  refrescarPanelesSeleccion();
}

/* ------------------------------------------------------------------ pasos / pestañas */
function puertasOperativas() { return S.proy.puertas.filter(function (d) { return d.tipo !== 'salida_emergencia'; }); }   // la salida de emergencia NO es punto de partida de picks ni entradas
function prerrequisitos() {
  var p = S.proy;
  var falta = [];
  if (p.contorno.length < 3) falta.push('contorno');
  if (!puertasOperativas().length) falta.push('puerta (recepción, despacho o mixta; la salida de emergencia no cuenta)');
  if (!p.racks.length) falta.push('racks');
  if (!p.productos.length) falta.push('artículos');
  return falta;
}
function cantidadParaDimensionar(pr) {
  var c = pr.cantidad || 0;
  if (S.proy.config.dimensionarPor === 'maximo' && pr.stockMax != null && pr.stockMax > c) c = pr.stockMax;
  return c;
}
function necesidadPorTipo() {
  var n = { palet: 0, bin: 0, piso: 0, cantilever: 0 };
  S.proy.productos.forEach(function (pr) {
    if (!(pr.unidadesPorUbic > 0)) return;   // igual que el motor: sin unidades por ubicación no requiere posiciones
    if (pr.crossdock) return;                // cross-docking: pasa por el muelle y NO ocupa rack
    var req = Math.ceil(cantidadParaDimensionar(pr) / pr.unidadesPorUbic - 1e-9);
    n[pr.tipoUbic] = (n[pr.tipoUbic] || 0) + req;
  });
  return n;
}
function disponiblesPorTipo() {   // en unidades de ubicación (un carril de piso suma profundidad × apilado)
  var d = { palet: 0, bin: 0, piso: 0, cantilever: 0 };
  getPos().forEach(function (q) { d[q.tipo] = (d[q.tipo] || 0) + (q.capacidadUb > 0 ? q.capacidadUb : 1); });
  return d;
}
function refrescarPasos() {
  var p = S.proy, res = {};
  var pl = p.plano;
  if (pl.imagen && !pl.mPorPx) res.plano = ['falta', 'falta calibrar escala'];
  else if (p.contorno.length < 3) res.plano = ['falta', 'falta contorno'];
  else if (!puertasOperativas().length) res.plano = ['falta', 'falta una puerta'];
  else res.plano = ['ok', fmt(areaAbs(p.contorno), 0) + ' m² · ' + puertasOperativas().length + (puertasOperativas().length === 1 ? ' puerta' : ' puertas')];

  var nPos = getPos().length;
  var probs = Object.keys(problemasRacks()).length;
  if (!p.racks.length) res.racks = ['falta', p.contorno.length < 3 ? 'falta contorno' : 'faltan racks'];
  else if (probs) res.racks = ['falta', 'revisar ' + probs + (probs === 1 ? ' rack' : ' racks')];
  else res.racks = ['ok', p.racks.length + ' racks · ' + nPos + ' pos.'];

  if (!p.productos.length) res.articulos = ['falta', 'faltan artículos'];
  else {
    var nec = necesidadPorTipo(), dis = disponiblesPorTipo(), faltan = 0;
    TIPOS_UBIC.forEach(function (t) { faltan += Math.max(0, (nec[t] || 0) - (dis[t] || 0)); });
    res.articulos = problemasDatos().total ? ['falta', 'revisar ' + problemasDatos().total + ' fila(s)'] : faltan ? ['falta', 'faltan ' + faltan + ' posiciones'] : ['ok', p.productos.length + ' SKU'];
  }
  var pre = prerrequisitos();
  if (pre.length) res.asignar = ['', 'falta ' + pre[0]];
  else if (!p.resultado) res.asignar = ['falta', 'sin asignar'];
  else res.asignar = ['ok', p.resultado.mejoraPct == null ? 'no comparable' : 'mejora ' + fmt(Number(p.resultado.mejoraPct), 0) + ' %'];
  if (!AA) res.analisis = ['', 'no disponible'];
  else if (faltaAnalisis().length) res.analisis = ['', 'falta ' + faltaAnalisis()[0].split(' ')[0]];
  else if (!S.analisis) res.analisis = ['', 'sin calcular'];
  else if (S.analisis.ver !== S.ver) res.analisis = ['falta', 'recalcular'];
  else res.analisis = ['ok', N(((S.analisis.res || {}).recomendaciones || []).length) + ' recomend.'];
  res.reportes = p.resultado ? ['ok', 'listo'] : ['', 'sin resultado'];

  Object.keys(res).forEach(function (t) {
    var b = $('#paso-' + t), s = $('#est-' + t);
    b.classList.toggle('ok', res[t][0] === 'ok');
    b.classList.toggle('falta', res[t][0] === 'falta');
    s.textContent = res[t][1];
    b.setAttribute('aria-label', 'Paso ' + (['plano', 'racks', 'articulos', 'asignar', 'analisis', 'reportes'].indexOf(t) + 1) + ': ' + t + '. ' + res[t][1]);
    if (t === S.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
}
function irTab(t) {
  if (S.tab === 'plano' && t !== 'plano') { S.calib = null; S.traza = null; $('#trz-panel').hidden = true; $('#form-calib').hidden = true; }
  S.tab = t;
  var lienzo = (t === 'plano' || t === 'racks' || t === 'asignar');
  $('#area-lienzo').hidden = !lienzo;
  $('#area-articulos').hidden = t !== 'articulos';
  $('#area-analisis').hidden = t !== 'analisis';
  $('#area-reportes').hidden = t !== 'reportes';
  $$('.panel-tab').forEach(function (el) {
    var id = el.id;
    el.hidden = !(id === 'p-' + t || id === 'r-' + t);
  });
  S.sel = null; S.selVert = null; S.moviendo = null; S.dib = null;
  if (lienzo) {
    ponerHerr('seleccionar');
    if (t === 'asignar') {
      if (!S.rackElev && S.proy.racks.length) S.rackElev = S.proy.racks[0].id;
    }
    ajustarLienzo();
    if (S.encajarSiguiente) { S.encajarSiguiente = false; encajar(); }
  }
  sincronizarCampos();
  refrescarTodo();
  var area = $('#principal');
  if (!lienzo) { var pg = $(t === 'articulos' ? '#area-articulos' : t === 'analisis' ? '#area-analisis' : '#area-reportes'); if (pg) pg.scrollTop = 0; }
  try { history.replaceState(null, '', '#' + t); } catch (e) { /* file:// puede impedirlo */ }
}

function refrescarTodo() {
  sincronizarImagen();
  refrescarPasos();
  refrescarVacio();
  $('#tb-undo').disabled = !S.undo.length;
  $('#tb-redo').disabled = !S.redo.length;
  switch (S.tab) {
    case 'plano': refrescarPlanoPanel(); break;
    case 'racks': refrescarRacksPanel(); break;
    case 'asignar': refrescarAsignar(); break;
    case 'articulos': refrescarArticulos(); break;
    case 'analisis': renderAnalisis(); break;
    case 'reportes': refrescarReportes(); break;
  }
  pedirDibujo();
}
function refrescarPanelesSeleccion() {
  if (S.tab === 'plano') refrescarSelDetalle();
  else if (S.tab === 'racks') refrescarRackProps();
  else if (S.tab === 'asignar') refrescarElevacion();
  pedirDibujo();
}

/* ------------------------------------------------------------------ estados vacíos del lienzo */
function refrescarVacio() {
  var v = $('#vacio'), p = S.proy, html = '', clase = '';
  var lienzo = (S.tab === 'plano' || S.tab === 'racks' || S.tab === 'asignar');
  if (!lienzo) { v.hidden = true; return; }
  if (S.tab === 'plano') {
    if (p.contorno.length < 3 && !p.plano.imagen && !S.dib && !p.huecos.length && !p.puertas.length) {
      html = '<div class="tarjeta-vacia"><h3>Empieza definiendo tu almacén</h3>' +
        '<p>Elige cómo quieres crear el plano:</p>' +
        '<ul><li><b>Cargar ejemplo</b>: una nave en L con racks y 45 artículos, para ver todo funcionando.</li>' +
        '<li><b>Subir imagen</b> de tu plano, calibrarla y trazar el contorno automáticamente.</li>' +
        '<li><b>Plantilla</b>: rectángulo o L con tus medidas (panel izquierdo, paso 3).</li></ul>' +
        '<div class="acc"><button type="button" class="btn primario" data-acc="ejemplo">Cargar ejemplo</button>' +
        '<button type="button" class="btn" data-acc="subir">Subir imagen del plano</button>' +
        '<button type="button" class="btn" data-acc="rect">Crear rectángulo 40 × 25 m</button></div></div>';
    }
  } else if (S.tab === 'racks') {
    if (p.contorno.length < 3) {
      html = '<div class="tarjeta-vacia"><h3>Primero define el contorno</h3><p>Los racks se generan dentro de la forma del almacén. Vuelve al paso 1 o carga el ejemplo.</p>' +
        '<div class="acc"><button type="button" class="btn primario" data-acc="irplano">Ir al paso 1: Plano</button><button type="button" class="btn" data-acc="ejemplo">Cargar ejemplo</button></div></div>';
    } else if (!p.racks.length) {
      html = '<div class="tarjeta-vacia"><h3>Aún no hay racks</h3><p>Ajusta el equipo y las medidas a la izquierda y pulsa el botón; o añade racks a mano.</p>' +
        '<div class="acc"><button type="button" class="btn primario" data-acc="generar">Generar racks automáticamente</button></div></div>';
      clase = 'abajo';
    }
  } else if (S.tab === 'asignar') {
    var pre = prerrequisitos();
    if (pre.length) {
      html = '<div class="tarjeta-vacia"><h3>Aún falta algo para asignar</h3><p>Completa: <b>' + esc(pre.join(', ')) + '</b>.</p>' +
        '<div class="acc">' + (pre.indexOf('contorno') >= 0 || pre.some(function (x) { return x.indexOf('puerta') === 0; }) ? '<button type="button" class="btn" data-acc="irplano">Paso 1: Plano</button>' : '') +
        (pre.indexOf('racks') >= 0 ? '<button type="button" class="btn" data-acc="irracks">Paso 2: Racks</button>' : '') +
        (pre.indexOf('artículos') >= 0 ? '<button type="button" class="btn" data-acc="irarticulos">Paso 3: Artículos</button>' : '') +
        '<button type="button" class="btn primario" data-acc="ejemplo">Cargar ejemplo</button></div></div>';
    } else if (!p.resultado) {
      html = '<div class="tarjeta-vacia"><h3>Todo listo para asignar</h3><p>Pulsa «Asignar ubicaciones»: el programa coloca cada artículo según su rotación y la distancia real caminando.</p>' +
        '<div class="acc"><button type="button" class="btn primario" data-acc="asignar">Asignar ubicaciones</button></div></div>';
      clase = 'abajo';
    }
  }
  v.className = clase;
  v.style.alignItems = clase === 'abajo' ? 'flex-end' : 'center';
  v.innerHTML = html;
  v.hidden = !html;
}
function accionVacio(acc) {
  if (acc === 'ejemplo') cargarEjemplo();
  else if (acc === 'subir') $('#inp-imagen').click();
  else if (acc === 'rect') plantillaRect(40, 25);
  else if (acc === 'irplano') irTab('plano');
  else if (acc === 'irracks') irTab('racks');
  else if (acc === 'irarticulos') irTab('articulos');
  else if (acc === 'generar') generarRacks();
  else if (acc === 'asignar') asignar();
  else if (acc === 'calcular-an') calcularAnalisis();
}

/* ------------------------------------------------------------------ campos <-> proyecto */
function enfocado(el) { return document.activeElement === el; }
function setVal(id, v) {
  var el = $('#' + id);
  if (!el || enfocado(el)) return;
  el.value = v == null ? '' : v;
}
function sincronizarCampos() {
  var p = S.proy, c = p.config;
  setVal('nombre-proyecto', p.nombre);
  setVal('rng-opacidad', p.plano.opacidad == null ? 0.5 : p.plano.opacidad);
  setVal('sel-equipo', c.equipo || 'manual');
  setVal('sel-rociador', c.tipoRociador || 'estandar');
  setVal('inp-perfil-viga', c.perfilViga);
  setVal('inp-holgura-carga', c.holguraSobreCarga);
  setVal('inp-flue', c.flue);
  setVal('a-penal', c.penalNivelPalet);
  setVal('inp-ancho-pasillo', c.anchoPasillo);
  setVal('inp-ancho-cruce', c.anchoPasilloCruce);
  setVal('inp-altura-nave', c.alturaLibreNave);
  setVal('inp-holgura', c.holguraRociadores);
  setVal('a-peso-rec', Math.round((c.pesoRecepcion == null ? 0.3 : c.pesoRecepcion) * 100));
  $('#out-peso-rec').textContent = Math.round((c.pesoRecepcion == null ? 0.3 : c.pesoRecepcion) * 100);
  $('#out-peso-desp').textContent = 100 - Math.round((c.pesoRecepcion == null ? 0.3 : c.pesoRecepcion) * 100);
  setVal('a-pasadas', c.pasadasMejora);
  setVal('a-sep', c.separacionIncompatibles);
  setVal('a-abc-a', Math.round(((c.abc && c.abc.a) || 0.8) * 100));
  setVal('a-abc-b', Math.round(((c.abc && c.abc.b) || 0.95) * 100));
  /* v1.1 */
  setVal('a-dimensionar', c.dimensionarPor || 'actual');
  var ch = $('#a-repos'); if (ch && !enfocado(ch)) ch.checked = !!(c.reposicion && c.reposicion.activa);
  setVal('a-pospick', c.reposicion && c.reposicion.posicionesPicking != null ? c.reposicion.posicionesPicking : 1);
  setVal('a-afin', c.pesoAfinidad == null ? 0.3 : c.pesoAfinidad);
  setVal('a-fecha', c.fechaReferencia);
  setVal('a-dias-venc', c.diasAlertaVencimiento);
  var su = $('#a-seg-usar'); if (su && !enfocado(su)) su.checked = !(c.segregacion && c.segregacion.usar === false);
  setVal('d-evac', c.evacMaxM); setVal('d-evac-ancho', c.anchoEvacuacionMin); setVal('d-carga-piso', c.cargaPisoMaxKgM2);
  var mu = c.muelle || {};
  setVal('m-rec', mu.palletsDiaRecepcion); setVal('m-desp', mu.palletsDiaDespacho); setVal('m-dias-rec', mu.diasPermanenciaRec); setVal('m-dias-desp', mu.diasPermanenciaDesp);
  setVal('m-m2', mu.m2PorPalet); setVal('m-maniobra', mu.factorManiobra);
  renderMatrizSeg();
}
/* matriz de segregación por peligro (v1.1): null = la del motor (SEGREGACION_DEFECTO); editable en una copia propia */
function matrizSegEfectiva() {
  var sg = S.proy.config.segregacion || {};
  if (Array.isArray(sg.matriz)) return { lista: sg.matriz, propia: true };
  var d = M.SEGREGACION_DEFECTO;
  return { lista: Array.isArray(d) ? d : (d && Array.isArray(d.matriz) ? d.matriz : []), propia: false };
}
function renderMatrizSeg() {
  var box = $('#seg-matriz');
  if (!box || (box.contains(document.activeElement) && document.activeElement !== box)) return;
  var m = matrizSegEfectiva();
  var sel = function (v, k, j) { return '<select data-seg="' + k + '" data-sj="' + j + '"' + (m.propia ? '' : ' disabled') + '>' + PELIGROS.map(function (t) { return '<option value="' + t + '"' + (t === v ? ' selected' : '') + '>' + esc(NOMBRES_PELIGRO[t]) + '</option>'; }).join('') + '</select>'; };
  var h = '<p class="peq muted">' + (m.propia ? 'Matriz <b>propia</b> (su copia editada).' : (m.lista.length ? 'Matriz <b>por defecto del programa</b> (solo lectura hasta que la personalice).' : 'El motor instalado todavía no trae matriz por defecto.')) + ' <span class="verif">[VERIFICAR con HDS y seguridad-sst]</span> Es una referencia: la segregación real depende de las hojas de seguridad y de la norma aplicable.</p>';
  if (m.lista.length || m.propia) {
    h += '<div class="tabla-ancha"><table class="tabla-simple matriz-seg"><thead><tr><th>Clase A</th><th>Clase B</th><th class="n">Distancia mín. (m)</th><th><span class="sr">Quitar</span></th></tr></thead><tbody>' +
      m.lista.map(function (e, j) {
        return '<tr><td>' + sel(e.a, 'a', j) + '</td><td>' + sel(e.b, 'b', j) + '</td><td class="n"><input type="number" data-seg="distMinM" data-sj="' + j + '" min="0" step="0.5" value="' + (e.distMinM == null ? '' : N(e.distMinM)) + '" placeholder="solo no mismo rack"' + (m.propia ? '' : ' disabled') + '></td>' +
          '<td>' + (m.propia ? '<button type="button" class="btn peq-btn" data-seg-del="' + j + '" aria-label="Quitar regla ' + (j + 1) + '">✕</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  h += '<div class="fila-inp">' + (m.propia ? '<button type="button" class="btn" data-seg-acc="add">Añadir regla</button><button type="button" class="btn" data-seg-acc="defecto">Volver a la matriz por defecto</button>' : '<button type="button" class="btn" data-seg-acc="copiar">Personalizar (copiar la matriz)</button>') + '</div>' +
    '<p class="peq muted">Vacío en «distancia mínima» = sin separación numérica, pero nunca en el mismo rack.</p>';
  box.innerHTML = h;
}
function editarMatrizSeg(fn) {
  var c = S.proy.config;
  mutar(function () { c.segregacion = c.segregacion || { usar: true, matriz: null }; fn(c.segregacion); }, { inv: false });
  S.opcionesCambiadas = !!S.proy.resultado;
  renderMatrizSeg(); refrescarAsignar();
}
/* opciones v1.1 de «Asignar» */
function leerOpcionesAsignarV11() {
  var c = S.proy.config;
  c.dimensionarPor = $('#a-dimensionar').value === 'maximo' ? 'maximo' : 'actual';
  c.reposicion = { activa: $('#a-repos').checked, posicionesPicking: Math.round(clamp(num($('#a-pospick').value, 1), 1, 10)) };
  c.pesoAfinidad = clamp(num($('#a-afin').value, 0.3), 0, 1);
  var fe = $('#a-fecha').value; c.fechaReferencia = ymdValido(fe) ? fe : null;
  var dv = num($('#a-dias-venc').value, null); c.diasAlertaVencimiento = dv !== null && dv >= 0 ? Math.round(Math.min(dv, 3650)) : null;
  c.segregacion = c.segregacion || { usar: true, matriz: null };
  c.segregacion.usar = $('#a-seg-usar').checked;
}
/* datos suyos de la pestaña Análisis */
function leerDatosSuyos() {
  var c = S.proy.config, g = function (id) { var v = String($('#' + id).value).trim(); return v === '' ? null : num(v, null); };
  var pos = function (x) { return x !== null && x > 0 ? x : null; };
  c.evacMaxM = pos(g('d-evac')); c.anchoEvacuacionMin = pos(g('d-evac-ancho')); c.cargaPisoMaxKgM2 = pos(g('d-carga-piso'));
  var mu = c.muelle = c.muelle || {};
  var rec = g('m-rec'), des = g('m-desp'), dr = g('m-dias-rec'), dd = g('m-dias-desp');
  mu.palletsDiaRecepcion = rec !== null && rec >= 0 ? rec : null; mu.palletsDiaDespacho = des !== null && des >= 0 ? des : null;
  mu.diasPermanenciaRec = dr !== null ? clamp(dr, 0, 365) : 1; mu.diasPermanenciaDesp = dd !== null ? clamp(dd, 0, 365) : 1;
  mu.m2PorPalet = pos(g('m-m2')); mu.factorManiobra = pos(g('m-maniobra'));
}

/* ------------------------------------------------------------------ panel Plano */
function refrescarPlanoPanel() {
  var p = S.proy, pl = p.plano;
  var info = $('#info-imagen');
  if (pl.imagen) info.textContent = 'Imagen cargada: ' + pl.anchoPx + ' × ' + pl.altoPx + ' px.' + (pl.mPorPx ? '' : ' Falta calibrar la escala.');
  else info.textContent = 'Sin imagen. Puedes definir el almacén solo con medidas (paso 3).';
  $('#fila-opacidad').style.display = pl.imagen ? '' : 'none';
  $('#btn-quitar-imagen').hidden = !pl.imagen;
  $('#btn-calibrar').disabled = !pl.imagen;
  var ie = $('#info-escala');
  if (!pl.imagen) ie.textContent = 'Necesitas una imagen para calibrar. Si defines el almacén con medidas, ya está a escala real.';
  else if (pl.mPorPx) ie.innerHTML = '<span class="chip ok">Calibrado</span> 1 px = ' + fmt(pl.mPorPx, 4) + ' m · imagen de ' + fmt(pl.anchoPx * pl.mPorPx, 1) + ' × ' + fmt(pl.altoPx * pl.mPorPx, 1) + ' m';
  else ie.innerHTML = '<span class="chip warn">Sin calibrar</span> Usa «Calibrar con 2 clics».';
  var ay = $('#ayuda-autotrazo');
  if (!pl.imagen) ay.textContent = 'Necesita una imagen del plano (paso 1) y su escala (paso 2).';
  else if (!pl.mPorPx) ay.textContent = 'Primero calibra la escala (paso 2).';
  else ay.innerHTML = 'Pulsa el botón y haz clic <b>dentro</b> del almacén, sobre el piso libre de la imagen.';
  refrescarSelDetalle();
  var rs = $('#resumen-plano'), h = '';
  if (p.contorno.length >= 3) {
    h += '<dl class="kv"><dt>Área útil</dt><dd>' + fmt(areaAbs(p.contorno), 1) + ' m²</dd>' +
      '<dt>Perímetro</dt><dd>' + fmt(perimetro(p.contorno), 1) + ' m</dd>' +
      '<dt>Vértices del contorno</dt><dd>' + p.contorno.length + '</dd>';
  } else h += '<dl class="kv"><dt>Contorno</dt><dd><span class="chip warn">falta</span></dd>';
  var np = { recepcion: 0, despacho: 0, mixta: 0, salida_emergencia: 0 };
  p.puertas.forEach(function (d) { np[d.tipo] = (np[d.tipo] || 0) + 1; });
  var nzt = { almacenaje: 0, muelle: 0, staging: 0, otras: 0 };
  p.zonas.forEach(function (z) { if (nzt[z.tipo] != null) nzt[z.tipo]++; else nzt.otras++; });
  h += '<dt>Obstáculos</dt><dd>' + p.huecos.length + '</dd><dt>Puertas (R/D/M)</dt><dd>' + np.recepcion + ' / ' + np.despacho + ' / ' + np.mixta + '</dd><dt>Salidas de emergencia</dt><dd>' + np.salida_emergencia + '</dd><dt>Zonas</dt><dd>' + p.zonas.length +
    (nzt.almacenaje || nzt.muelle || nzt.staging ? ' (almacenaje ' + nzt.almacenaje + ' · muelle ' + nzt.muelle + ' · staging ' + nzt.staging + ')' : '') + '</dd></dl>';
  var dimC = dimensionesContorno();
  if (dimC && (dimC.ancho > 300 || dimC.alto > 300)) h += '<div class="msg aviso"><b>Contorno de ' + fmt(dimC.ancho, 0) + ' × ' + fmt(dimC.alto, 0) + ' m.</b> Es más grande que casi cualquier almacén: revisa la calibración de la escala (paso 2).</div>';
  if (!puertasOperativas().length) h += '<div class="msg aviso">Falta al menos una puerta de recepción, despacho o mixta: es el punto de partida de los recorridos (la salida de emergencia no lo es).</div>';
  if (p.puertas.length && !np.salida_emergencia) h += '<div class="msg info">No hay salida de emergencia marcada: el análisis de evacuación tomará las puertas operativas y lo avisará. Marque las salidas reales con el tipo «Salida de emergencia» <span class="verif">[VERIFICAR RNE A.130 / ITSE]</span>.</div>';
  else if (!np.mixta && (!np.recepcion || !np.despacho)) h += '<div class="msg info">Solo hay puertas de un tipo: recepción y despacho usarán la misma.</div>';
  rs.innerHTML = h;
}
function refrescarSelDetalle() {
  var d = $('#sel-detalle'), s = S.sel, el = elementoSel(), h = '';
  if (!s || !el) {
    d.innerHTML = '<p class="peq muted">Haz clic en un elemento del plano (contorno, obstáculo, puerta, zona) para editarlo. Arrastra sus vértices para cambiar su forma; <b>doble clic</b> en un borde añade un vértice; <b>Supr</b> borra el elemento o el vértice marcado.</p>';
    return;
  }
  function opts(obj, sel) { return Object.keys(obj).map(function (k) { return '<option value="' + k + '"' + (k === sel ? ' selected' : '') + '>' + esc(obj[k]) + '</option>'; }).join(''); }
  if (s.tipo === 'contorno') {
    h = '<p><b>Contorno del almacén</b></p><dl class="kv"><dt>Vértices</dt><dd>' + el.poly.length + '</dd><dt>Área</dt><dd>' + fmt(areaAbs(el.poly), 1) + ' m²</dd></dl>' +
      '<p class="peq muted">Arrastra los cuadritos para cambiar la forma. Doble clic en un borde añade un vértice.</p>';
  } else if (s.tipo === 'hueco') {
    h = '<p><b>Obstáculo</b> ' + esc(el.id) + '</p><label>Tipo<select data-campo="tipo">' + opts(NOMBRES_TIPO_HUECO, el.tipo) + '</select></label>' +
      '<dl class="kv"><dt>Área</dt><dd>' + fmt(areaAbs(el.poly), 2) + ' m²</dd></dl>';
  } else if (s.tipo === 'zona') {
    h = '<p><b>Zona</b> ' + esc(el.id) + '</p><label>Nombre<input type="text" data-campo="nombre" value="' + esc(el.nombre) + '"></label>' +
      '<label>Tipo<select data-campo="tipo">' + opts(NOMBRES_ZONA, el.tipo) + '</select></label>' +
      '<dl class="kv"><dt>Área</dt><dd>' + fmt(areaAbs(el.poly), 1) + ' m²</dd></dl>';
    if (el.tipo === 'almacenaje') h += zonaCfgHTML(el);
    else if (el.tipo === 'muelle' || el.tipo === 'staging') h += '<p class="peq muted">Esta zona se mide (' + fmt(areaAbs(el.poly), 1) + ' m²) y se compara en el Análisis con el área que pide su operación: palets por día × días de permanencia × m² por palet × factor de maniobra. Esos datos son <b>suyos</b> (Análisis → «Datos suyos»); sin ellos el programa solo muestra un cálculo con supuestos <span class="verif">[VERIFICAR]</span>.</p>';
  } else if (s.tipo === 'puerta') {
    h = '<p><b>Puerta</b> ' + esc(el.id) + '</p><label>Nombre<input type="text" data-campo="nombre" value="' + esc(el.nombre) + '"></label>' +
      '<label>Tipo<select data-campo="tipo">' + opts(NOMBRES_PUERTA, el.tipo) + '</select></label>' +
      '<div class="rejilla2"><label>x (m)<input type="number" step="0.1" data-campo="x" value="' + (Math.round(el.x * 100) / 100) + '"></label><label>y (m)<input type="number" step="0.1" data-campo="y" value="' + (Math.round(el.y * 100) / 100) + '"></label></div>';
  }
  h += '<div class="fila-inp"><button type="button" class="btn peligro" data-acc-sel="borrar">' + (S.selVert != null && el.poly && el.poly.length > 3 ? 'Borrar vértice' : 'Borrar ' + (s.tipo === 'contorno' ? 'contorno' : 'elemento')) + '</button></div>';
  d.innerHTML = h;
}
/* zona de almacenaje: cada campo vacío hereda de la configuración del proyecto */
function zonaCfgHTML(z) {
  var c = z.cfg || {}, cf = S.proy.config;
  var ni = function (k, etq, min, max, step, her) { return '<label>' + etq + '<input type="number" data-zcfg="' + k + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + (c[k] == null ? '' : N(c[k])) + '" placeholder="' + esc(her) + '"></label>'; };
  var h = '<h4 class="sub-h">Configuración de esta zona <span class="muted peq">(vacío = hereda del proyecto)</span></h4><div class="rejilla2">' +
    '<label>Equipo<select data-zcfg="equipo"><option value="">Del proyecto (' + esc(NOMBRES_EQUIPO[cf.equipo] || cf.equipo) + ')</option>' + EQUIPOS_VALIDOS.map(function (k) { return '<option value="' + k + '"' + (c.equipo === k ? ' selected' : '') + '>' + esc(NOMBRES_EQUIPO[k] || k) + '</option>'; }).join('') + '</select></label>' +
    '<label>Tipo de ubicación<select data-zcfg="tipo"><option value="">Del generador</option>' + TIPOS_UBIC.map(function (k) { return '<option value="' + k + '"' + (c.tipo === k ? ' selected' : '') + '>' + esc(NOMBRES_UBIC[k]) + '</option>'; }).join('') + '</select></label>' +
    ni('anchoPasillo', 'Ancho de pasillo (m)', 0.5, 12, 0.05, fmt(cf.anchoPasillo, 2)) + ni('fondo', 'Fondo (m)', 0.1, 50, 0.05, 'del generador') +
    ni('largoModulo', 'Largo de módulo (m)', 0.3, 50, 0.1, 'del generador') + ni('niveles', 'Niveles / brazos', 1, 30, 1, 'auto') +
    ni('altoNivel', 'Alto de nivel (m)', 0.05, 20, 0.05, 'del tipo') + ni('slotsPorModulo', 'Posiciones por módulo', 1, 20, 1, 'del generador') +
    (c.tipo === 'piso' ? ni('profundidadPalets', 'Profundidad (palets)', 1, 50, 1, '1') + ni('apilado', 'Apilado (palets)', 1, 10, 1, '1') : '') + '</div>' +
    '<button type="button" class="btn primario grande" data-acc-sel="gen-zona">Generar racks en esta zona</button>' +
    '<p class="peq muted">Solo regenera los racks automáticos de esta zona; los demás racks se conservan como obstáculos. ' + (S.proy.racks.some(function (r) { return r.zonaId === z.id; }) ? 'Ya hay racks de esta zona (se reemplazarán los automáticos).' : 'Aún no hay racks de esta zona.') + '</p>';
  return h;
}
function editarZonaCfg(campo, valor) {
  var z = S.sel && S.sel.tipo === 'zona' ? elementoSel() : null;
  if (!z || z.tipo !== 'almacenaje') return;
  var v = String(valor).trim();
  var lim = { anchoPasillo: [0.5, 12], fondo: [0.1, 50], largoModulo: [0.3, 50], altoNivel: [0.05, 20], niveles: [1, 30], slotsPorModulo: [1, 20], profundidadPalets: [1, 50], apilado: [1, 10] }[campo];
  mutar(function () {
    z.cfg = z.cfg || {};
    if (v === '') delete z.cfg[campo];
    else if (campo === 'equipo') { var e = enLista(v, EQUIPOS_VALIDOS, null); if (e) z.cfg.equipo = e; else delete z.cfg.equipo; }
    else if (campo === 'tipo') { var t = enLista(v, TIPOS_UBIC, null); if (t) z.cfg.tipo = t; else delete z.cfg.tipo; }
    else if (lim) { var x = num(v, null); if (x === null) delete z.cfg[campo]; else { x = clamp(x, lim[0], lim[1]); z.cfg[campo] = ['niveles', 'slotsPorModulo', 'profundidadPalets', 'apilado'].indexOf(campo) >= 0 ? Math.round(x) : x; } }
  }, { inv: false });
  refrescarSelDetalle();
}
async function generarEnZona() {
  var z = S.sel && S.sel.tipo === 'zona' ? elementoSel() : null;
  if (!z || z.tipo !== 'almacenaje') return;
  var p = S.proy;
  if (p.contorno.length < 3) { aviso('Primero define el contorno del almacén.', 'warn'); return; }
  if (S.ocupado) return;
  var antes = snap(), notas = [];
  leerConfigRacks(); acotarConfigRacks(notas);
  var opciones = opcionesGeneracion(notas), c = z.cfg || {};
  ['tipo', 'fondo', 'largoModulo', 'niveles', 'slotsPorModulo', 'profundidadPalets', 'apilado'].forEach(function (k) { if (c[k] != null) opciones[k] = c[k]; });
  opciones.zonas = [z.id];
  var resto = p.racks.filter(function (r) { return !(r.auto && r.zonaId === z.id); });
  var base = Object.assign({}, p, { racks: resto.map(function (r) { return Object.assign({}, r, { auto: false }); }) });   // los demás racks son obstáculos
  var res = await conEspera('Generando racks en la zona…', function () { return M.generarRacksAuto(base, opciones); });
  if (!res) return;
  var nuevos = (res.racks || []).map(function (r) { return Object.assign({}, r, { auto: true }); });
  var propios = nuevos.filter(function (r) { return r.zonaId === z.id; });
  if (propios.length) nuevos = propios;
  else nuevos = nuevos.filter(function (r) { return enPoly([r.cx, r.cy], z.poly); });   // motor sin soporte de zonas: se queda solo con lo que cae dentro
  if (!nuevos.length) {
    aviso('No se pudo colocar ningún rack dentro de la zona «' + z.nombre + '». Prueba pasillos más angostos, otro fondo o revisa su forma.', 'warn', 8000);
    return;
  }
  var usados = dic();
  resto.forEach(function (r) { usados[r.id] = 1; usados['n:' + r.nombre] = 1; });
  nuevos.forEach(function (r) {
    if (usados[r.id]) { var n = 1; while (usados['RZ' + n]) n++; r.id = 'RZ' + n; }
    usados[r.id] = 1;
    if (usados['n:' + r.nombre]) { var m = 1; while (usados['n:Z' + m]) m++; r.nombre = 'Z' + m; }
    usados['n:' + r.nombre] = 1;
    r.zonaId = z.id;
    if (c.equipo && !r.equipo) r.equipo = c.equipo;
    if (c.anchoPasillo != null && r.anchoPasillo == null) r.anchoPasillo = c.anchoPasillo;
  });
  pushUndo(antes);
  p.racks = resto.concat(nuevos);
  invalidarResultado();
  tocar();
  S.genInfo = { resumen: res.resumen || {}, supuestos: res.supuestos || [], advertencias: (res.advertencias || []).concat(notas.length ? ['Se ajustaron valores fuera de rango: ' + notas.join('; ')] : []) };
  S.rackElev = null;
  trasCambio();
  aviso('Se generaron ' + nuevos.length + ' racks en la zona «' + z.nombre + '».', 'ok');
}
function editarSeleccion(campo, valor) {
  var el = elementoSel();
  if (!el) return;
  mutar(function () {
    if (campo === 'x' || campo === 'y') el[campo] = num(valor, el[campo]);
    else el[campo] = valor;
    if (campo === 'tipo' && S.sel && S.sel.tipo === 'zona') { if (valor === 'almacenaje') el.cfg = el.cfg || {}; else delete el.cfg; }
  });
}

function plantillaRect(ancho, largo) {
  var t = M.crearProyectoRectangular(ancho, largo);
  mutar(function () {
    S.proy.contorno = clonar(t.contorno);
    S.proy.huecos = S.proy.huecos.filter(function (h) { return !h.auto; });
  });
  S.sel = { tipo: 'contorno' };
  aviso('Contorno rectangular de ' + ancho + ' × ' + largo + ' m creado. Añade al menos una puerta.', 'ok', 5000);
  encajar();
}
function plantillaL(at, lt, ab, lb) {
  var t = M.crearProyectoEnL(at, lt, ab, lb);
  mutar(function () {
    S.proy.contorno = clonar(t.contorno);
    S.proy.huecos = S.proy.huecos.filter(function (h) { return !h.auto; });
  });
  S.sel = { tipo: 'contorno' };
  aviso('Contorno en L creado. Añade al menos una puerta.', 'ok', 5000);
  encajar();
}

/* ------------------------------------------------------------------ panel Racks */
function holguraEfectiva(c) { return c.holguraRociadores != null && isFinite(c.holguraRociadores) ? c.holguraRociadores : (c.tipoRociador === 'esfr' ? 1.2 : 0.75); }
function dimensionesContorno() {
  var c = S.proy.contorno;
  if (!c || c.length < 3) return null;
  var b = bboxPts(c);
  return { ancho: b[2] - b[0], alto: b[3] - b[1] };
}
function leerConfigRacks() {
  var c = S.proy.config;
  c.equipo = $('#sel-equipo').value;
  c.anchoPasillo = num($('#inp-ancho-pasillo').value, c.anchoPasillo);
  c.anchoPasilloCruce = num($('#inp-ancho-cruce').value, c.anchoPasilloCruce);
  c.alturaLibreNave = num($('#inp-altura-nave').value, c.alturaLibreNave);
  var hv = String($('#inp-holgura').value).trim();
  c.holguraRociadores = hv === '' ? null : num(hv, c.holguraRociadores);   // vacío = auto según el tipo de rociador
  if ($('#inp-perfil-viga').value !== '') c.perfilViga = num($('#inp-perfil-viga').value, c.perfilViga);
  if ($('#inp-holgura-carga').value !== '') c.holguraSobreCarga = num($('#inp-holgura-carga').value, c.holguraSobreCarga);
  c.tipoRociador = $('#sel-rociador').value === 'esfr' ? 'esfr' : 'estandar';
  c.flue = num($('#inp-flue').value, c.flue);
}
function cambiarEquipo(eq) {
  mutar(function () {
    var def = M.configPorDefecto(eq) || {};
    S.proy.config.equipo = eq;
    if (def.anchoPasillo != null) S.proy.config.anchoPasillo = def.anchoPasillo;
    if (def.anchoPasilloCruce != null) S.proy.config.anchoPasilloCruce = def.anchoPasilloCruce;
  });
  aviso('Ancho de pasillo de referencia para «' + (NOMBRES_EQUIPO[eq] || eq) + '»: ' + fmt(S.proy.config.anchoPasillo, 2) + ' m (orden de magnitud: VERIFICAR con la ficha del equipo; pasillo real = ancho del equipo + largo del palet + holguras).', 'info', 7000);
}
/* Acota un número tecleado y avisa si hubo que ajustarlo (M5). */
function acotar(v, min, max, def, nombre, notas) {
  var x = v;
  if (x == null || !isFinite(x)) x = def;
  var y = Math.max(min, Math.min(max, x));
  if (y !== x || (v == null || !isFinite(v))) notas.push(nombre + ': ' + (v == null || !isFinite(v) ? 'valor vacío o inválido' : fmt(x, 2).replace(/,00$/, '')) + ' → se usó ' + fmt(y, 2).replace(/,00$/, '') + ' (permitido ' + fmt(min, 2).replace(/,00$/, '') + ' a ' + fmt(max, 2).replace(/,00$/, '') + ')');
  return y;
}
function opcionesGeneracion(notas) {
  notas = notas || [];
  var niv = num($('#g-niveles').value, null);
  return {
    orientacion: $('#g-orient').value,
    largoModulo: acotar(num($('#g-largo').value, 2.7), 0.3, 12, 2.7, 'Largo del módulo (m)', notas),
    fondo: acotar(num($('#g-fondo').value, 1.1), 0.3, $('#g-tipo').value === 'piso' ? 12 : 3, 1.1, 'Fondo del rack (m)', notas),
    niveles: niv === null ? null : Math.round(acotar(niv, 1, 20, 1, 'Niveles', notas)),
    slotsPorModulo: Math.round(acotar(num($('#g-slots').value, 2), 1, 10, 2, 'Posiciones por módulo y nivel', notas)),
    tipo: $('#g-tipo').value,
    dobles: $('#g-dobles').checked,
    modulosPorTramo: Math.round(acotar(num($('#g-modulos-tramo').value, 8), 2, 50, 8, 'Módulos por tramo', notas)),
    reservarFrentePuertas: acotar(num($('#g-reserva').value, 3), 0, 30, 3, 'Reserva frente a puertas (m)', notas),
    rellenarSobrantes: $('#g-rellenar').checked,
    profundidadPalets: Math.round(acotar(num($('#g-prof').value, 1), 1, 50, 1, 'Profundidad de piso (palets)', notas)),
    apilado: Math.round(acotar(num($('#g-apil').value, 1), 1, 10, 1, 'Apilado de piso (palets)', notas))
  };
}
/* Lee y acota la configuración de racks (pasillos, altura). */
function acotarConfigRacks(notas) {
  var c = S.proy.config;
  c.anchoPasillo = acotar(c.anchoPasillo, 0.6, 8, 2.4, 'Ancho de pasillo (m)', notas);
  c.anchoPasilloCruce = acotar(c.anchoPasilloCruce, 0.6, 10, Math.max(2.4, c.anchoPasillo), 'Ancho del pasillo de cruce (m)', notas);
  c.alturaLibreNave = acotar(c.alturaLibreNave, 1, 40, 8, 'Altura libre (m)', notas);
  if (c.holguraRociadores != null) c.holguraRociadores = acotar(c.holguraRociadores, 0, 3, 0.75, 'Holgura a rociadores (m)', notas);
  if (c.perfilViga != null) c.perfilViga = acotar(c.perfilViga, 0, 0.5, 0.12, 'Perfil de viga (m)', notas);
  if (c.holguraSobreCarga != null) c.holguraSobreCarga = acotar(c.holguraSobreCarga, 0, 0.5, 0.1, 'Holgura sobre la carga (m)', notas);
  if (c.flue != null) c.flue = acotar(c.flue, 0, 1, 0.15, 'Flue (m)', notas);
}
/* Coloca los racks generados por el motor: reemplaza los automáticos (o todos) y conserva los manuales. */
function colocarRacksGenerados(res, modo, antes, cfgNueva) {
  var p = S.proy;
  var nuevos = res.racks.map(function (r) { return Object.assign({}, r, { auto: true }); });
  var conservar = modo === 'auto' ? p.racks.filter(function (r) { return !r.auto; }) : [];
  var usados = dic();
  nuevos.forEach(function (r) { usados[r.id] = 1; usados['n:' + r.nombre] = 1; });
  var mc = 0;
  conservar.forEach(function (r) {
    if (usados[r.id] || usados['n:' + r.nombre]) {
      do { mc++; } while (usados['M' + mc] || usados['n:M' + mc]);
      r.id = 'M' + mc; r.nombre = 'M' + mc;
    }
    usados[r.id] = 1; usados['n:' + r.nombre] = 1;
  });
  pushUndo(antes);
  if (cfgNueva) p.config = cfgNueva;
  p.racks = conservar.concat(nuevos);
  invalidarResultado();
  tocar();
  S.genInfo = { resumen: res.resumen || {}, supuestos: res.supuestos || [], advertencias: res.advertencias || [] };
  S.sel = null; S.rackElev = null;
  trasCambio();
  renderGenResumen();
  return nuevos;
}
async function generarRacks() {
  var p = S.proy;
  if (p.contorno.length < 3) { aviso('Primero define el contorno del almacén (paso 1).', 'warn'); irTab('plano'); return; }
  if (S.ocupado) return;
  var existentes = p.racks.length, autos = p.racks.filter(function (r) { return r.auto; }).length, manuales = existentes - autos;
  var modo = 'todos';
  if (existentes) {
    var botones = [{ texto: 'Reemplazar todos los racks', valor: 'todos', primario: !(manuales && autos) }];
    if (manuales && autos) botones.unshift({ texto: 'Reemplazar solo los automáticos', valor: 'auto', primario: true });
    botones.push({ texto: 'Cancelar', valor: null });
    modo = await preguntar('Ya hay racks en el plano',
      'Hay ' + existentes + ' racks (' + autos + ' automáticos, ' + manuales + ' hechos o editados a mano).\n¿Qué quieres hacer con ellos? Puedes deshacer con Ctrl+Z.', botones);
    if (!modo) return;
  }
  var antes = snap();
  leerConfigRacks();
  var notas = [];
  acotarConfigRacks(notas);
  var opciones = opcionesGeneracion(notas);
  sincronizarCampos();
  [['#g-largo', opciones.largoModulo], ['#g-fondo', opciones.fondo], ['#g-slots', opciones.slotsPorModulo], ['#g-modulos-tramo', opciones.modulosPorTramo], ['#g-reserva', opciones.reservarFrentePuertas]].forEach(function (x) { $(x[0]).value = x[1]; });
  if (opciones.niveles !== null) $('#g-niveles').value = opciones.niveles;
  if (notas.length) aviso('Se ajustaron valores fuera de rango: ' + notas.join('; ') + '.', 'warn', 10000);
  avisoContornoGrande();
  if (!p.puertas.length) aviso('No hay puertas: los racks se generan igual, pero no se reservará espacio frente a ellas.', 'warn');
  var base = Object.assign({}, S.proy, { racks: modo === 'auto' ? S.proy.racks.filter(function (r) { return !r.auto; }) : [] });
  var res = await conEspera('Generando racks…', function () { return M.generarRacksAuto(base, opciones); });
  if (!res) return;
  if (!res.racks || !res.racks.length) {
    S.genInfo = { resumen: res.resumen || {}, supuestos: res.supuestos || [], advertencias: res.advertencias || [], vacio: true };
    renderGenResumen();
    aviso('No se pudo colocar ningún rack. Prueba pasillos más angostos, un módulo más corto o revisa el contorno.', 'warn', 8000);
    return;
  }
  var nuevos = colocarRacksGenerados(res, modo, antes, null);
  aviso('Racks generados: ' + (res.resumen && res.resumen.posiciones != null ? res.resumen.posiciones + ' posiciones.' : nuevos.length + ' racks.'), 'ok');
}
function avisoContornoGrande() {
  var dim = dimensionesContorno();
  if (dim && (dim.ancho > 300 || dim.alto > 300)) aviso('El contorno mide ' + fmt(dim.ancho, 0) + ' × ' + fmt(dim.alto, 0) + ' m: es muy grande para un almacén. Probablemente la calibración de la escala está mal; revísala antes de fiarte de los resultados.', 'warn', 12000);
}
function renderGenResumen() {
  var g = S.genInfo, el = $('#gen-resumen');
  if (!g) { el.innerHTML = ''; return; }
  var r = g.resumen || {}, h = '';
  if (g.vacio) h += '<div class="msg aviso">No se generó ningún rack con estos parámetros.</div>';
  else {
    var fx = function (v, d) { return v != null ? esc(fmt(Number(v), d)) : '—'; };
    h += '<dl class="kv"><dt>Posiciones de almacenaje</dt><dd>' + fx(r.posiciones, 0) + '</dd>' +
      '<dt>Filas de racks</dt><dd>' + fx(r.filas, 0) + '</dd>' +
      '<dt>Ángulo de las filas</dt><dd>' + (r.angulo != null ? esc(fmt(Number(r.angulo), 0)) + '°' : '—') + '</dd>' +
      '<dt>Ocupación del área</dt><dd>' + (r.ocupacionAreaPct != null ? esc(fmt(Number(r.ocupacionAreaPct), 1)) + ' %' : '—') + '</dd>' +
      '<dt>Descartados</dt><dd>' + (r.descartados != null ? (Array.isArray(r.descartados) ? r.descartados.length : fx(r.descartados, 0)) : '—') + '</dd></dl>';
  }
  if (g.supuestos && g.supuestos.length) h += '<details class="mini" open><summary>Supuestos de la generación</summary><ul class="peq">' + g.supuestos.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul></details>';
  if (g.advertencias && g.advertencias.length) h += g.advertencias.map(function (s) { return '<div class="msg aviso">' + esc(s) + '</div>'; }).join('');
  el.innerHTML = h;
}
function nombreRackLibre() {
  var usados = dic();
  S.proy.racks.forEach(function (r) { usados[r.id] = 1; usados[r.nombre] = 1; });
  var n = 1, nom;
  do { nom = 'R' + (n < 10 ? '0' + n : n); n++; } while (usados[nom]);
  return nom;
}
function anadirRack() {
  if (S.proy.contorno.length < 3 && !S.proy.racks.length) { /* se permite igualmente */ }
  var c = s2w(W / 2, H / 2);
  var cfg = S.proy.config;
  var fondo = num($('#g-fondo').value, 1.1), lm = num($('#g-largo').value, 2.7), slots = Math.max(1, Math.round(num($('#g-slots').value, 2)));
  var tipo = $('#g-tipo').value;
  var altoNivel = tipo === 'bin' ? 0.45 : 1.6, altoBase = tipo === 'bin' ? 0.15 : 0.15;
  var niv = num($('#g-niveles').value, null);
  if (!niv) niv = Math.max(1, Math.floor(((cfg.alturaLibreNave || 8) - holguraEfectiva(cfg) - altoBase) / altoNivel));
  var nombre = nombreRackLibre(), id = nuevoId(S.proy.racks, 'RM');
  var sn = snapW(c, null);
  var r = { id: id, nombre: nombre, cx: sn[0], cy: sn[1], ang: 0, largo: Math.round(lm * 4 * 100) / 100, fondo: fondo, modulos: 4, niveles: Math.round(niv), slotsPorModulo: slots,
    altoNivel: altoNivel, altoBase: altoBase, cargaMaxKg: tipo === 'bin' ? 50 : 1000, tipo: tipo, frente: 'A', auto: false,
    equipo: null, anchoPasillo: null, cargaMaxModuloKg: null, profundidadPalets: tipo === 'piso' ? Math.max(1, Math.round(num($('#g-prof').value, 1))) : 1, apilado: tipo === 'piso' ? Math.max(1, Math.round(num($('#g-apil').value, 1))) : 1, zonaId: null };
  if (tipo === 'piso') { r.slotsPorModulo = 1; r.niveles = 1; }
  if (tipo === 'cantilever') { r.slotsPorModulo = 1; r.altoNivel = 0.8; r.fondo = Math.max(r.fondo, 1.2); r.cargaMaxKg = 2000; }
  mutar(function () { S.proy.racks.push(r); });
  S.sel = { tipo: 'rack', id: id };
  refrescarPanelesSeleccion();
}
function duplicarRack() {
  var r = elementoSel();
  if (!r || S.sel.tipo !== 'rack') { aviso('Selecciona un rack para duplicarlo.', 'info'); return; }
  var c = clonar(r), e = rackEjes(r);
  c.id = nuevoId(S.proy.racks, 'RM'); c.nombre = nombreRackLibre(); c.auto = false;
  c.cx = r.cx + e.ey[0] * (r.fondo + 0.6); c.cy = r.cy + e.ey[1] * (r.fondo + 0.6);
  mutar(function () { S.proy.racks.push(c); });
  S.sel = { tipo: 'rack', id: c.id };
  refrescarPanelesSeleccion();
}
async function borrarRacksAuto() {
  var n = S.proy.racks.filter(function (r) { return r.auto; }).length;
  if (!n) { aviso('No hay racks automáticos.', 'info'); return; }
  var ok = await preguntar('Borrar racks automáticos', 'Se borrarán ' + n + ' racks generados automáticamente. Los hechos a mano se conservan.', [{ texto: 'Borrar', valor: true, peligro: true }, { texto: 'Cancelar', valor: null, primario: true }]);
  if (!ok) return;
  mutar(function () { S.proy.racks = S.proy.racks.filter(function (r) { return !r.auto; }); });
  S.sel = null; S.rackElev = null;
}
var CAMPOS_RACK = [
  ['nombre', 'Nombre', 'text'], ['cx', 'Centro x (m)', 'n', 0.05], ['cy', 'Centro y (m)', 'n', 0.05], ['ang', 'Ángulo (°)', 'n', 1],
  ['largo', 'Largo total (m)', 'n', 0.1], ['fondo', 'Fondo (m)', 'n', 0.05], ['modulos', 'Módulos', 'i', 1], ['niveles', 'Niveles', 'i', 1],
  ['slotsPorModulo', 'Posiciones por módulo', 'i', 1], ['altoNivel', 'Alto de nivel (m)', 'n', 0.05], ['altoBase', 'Alto de base (m)', 'n', 0.05],
  ['cargaMaxKg', 'Carga máx. por posición (kg)', 'n', 10]
];
function refrescarRackProps() {
  var d = $('#rack-props'), r = S.sel && S.sel.tipo === 'rack' ? elementoSel() : null;
  if (!r) { d.innerHTML = '<p class="peq muted">Selecciona un rack en el plano (clic) para editar sus propiedades. Arrástralo para moverlo; <b>R</b> lo rota 90°.</p>'; return; }
  var h = '<p><b>' + esc(r.nombre) + '</b> <span class="chip-modo ' + (r.auto ? 'auto' : 'manual') + '" title="' + (r.auto ? 'Se reemplaza al volver a generar los racks automáticos' : 'Se conserva al regenerar con «solo los automáticos»') + '">' + (r.auto ? 'auto (se reemplaza al regenerar)' : 'manual (se conserva al regenerar)') + '</span>' +
    (r.zonaId ? ' <span class="chip-modo">zona ' + esc(r.zonaId) + '</span>' : '') + '</p><div class="rejilla2">';
  CAMPOS_RACK.forEach(function (c) {
    var v = r[c[0]];
    if (c[2] === 'text') h += '<label>' + c[1] + '<input type="text" data-campo="' + c[0] + '" value="' + esc(v) + '"></label>';
    else h += '<label>' + c[1] + '<input type="number" data-campo="' + c[0] + '" data-tipo="' + c[2] + '" step="' + c[3] + '" value="' + (v == null ? '' : N(Math.round(v * 1000) / 1000)) + '"></label>';
  });
  h += '<label>Tipo<select data-campo="tipo">' + TIPOS_UBIC.map(function (t) { return '<option value="' + t + '"' + (r.tipo === t ? ' selected' : '') + '>' + esc(NOMBRES_UBIC[t]) + '</option>'; }).join('') + '</select></label>';
  h += '<label>Frente (acceso)<select data-campo="frente"><option value="A"' + (r.frente === 'A' ? ' selected' : '') + '>A (lado −y local)</option><option value="B"' + (r.frente === 'B' ? ' selected' : '') + '>B (lado +y local)</option></select></label>';
  h += '<label>Equipo de este rack<select data-campo="equipo" data-tipo="e"><option value="">Del proyecto (' + esc(NOMBRES_EQUIPO[S.proy.config.equipo] || S.proy.config.equipo) + ')</option>' +
    EQUIPOS_VALIDOS.map(function (k) { return '<option value="' + k + '"' + (r.equipo === k ? ' selected' : '') + '>' + esc(NOMBRES_EQUIPO[k] || k) + '</option>'; }).join('') + '</select></label>';
  h += '<label>Ancho de pasillo propio (m)<input type="number" data-campo="anchoPasillo" data-tipo="nn" min="0.5" step="0.05" value="' + (r.anchoPasillo == null ? '' : N(r.anchoPasillo)) + '" placeholder="del equipo/proyecto"></label>';
  h += '<label>Carga máx. del módulo (kg)<input type="number" data-campo="cargaMaxModuloKg" data-tipo="nn" min="0" step="50" value="' + (r.cargaMaxModuloKg == null ? '' : N(r.cargaMaxModuloKg)) + '" placeholder="sin dato"></label>';
  if (r.tipo === 'piso') {
    h += '<label>Profundidad (palets por carril)<input type="number" data-campo="profundidadPalets" data-tipo="i" min="1" max="50" step="1" value="' + N(r.profundidadPalets || 1) + '"></label>';
    h += '<label>Apilado (palets en altura)<input type="number" data-campo="apilado" data-tipo="i" min="1" max="10" step="1" value="' + N(r.apilado || 1) + '"></label>';
  }
  h += '</div>';
  var pos = N(r.modulos) * N(r.niveles) * N(r.slotsPorModulo);
  h += '<p class="peq muted">' + pos + ' posiciones' + (r.tipo === 'piso' ? ' (carriles) · capacidad por carril = ' + N(r.profundidadPalets || 1) * N(r.apilado || 1) + ' palets (' + (N(r.profundidadPalets || 1) > 1 ? 'LIFO: no apto para FEFO' : 'sin LIFO') + ')' : r.tipo === 'cantilever' ? ' (bahías; «niveles» = brazos, largo útil de la bahía = largo total ÷ módulos)' : '') + '. Altura total ≈ ' + fmt(N(r.altoBase) + N(r.niveles) * N(r.altoNivel), 2) + ' m.</p>';
  if (r.cargaMaxModuloKg == null) h += '<p class="peq muted"><span class="dato-suyo">Carga máx. del módulo: dato suyo (placa del fabricante); sin él no se vigila la carga por módulo.</span></p>';
  var pr = problemasRacks()[r.id];
  if (pr) h += '<div class="msg error">' + pr.map(function (t) { return t === 'fuera' ? 'Sale del contorno.' : t === 'solape' ? 'Se solapa con otro rack.' : 'Cruza un obstáculo.'; }).join(' ') + '</div>';
  d.innerHTML = h;
}
var LIM_RACK = { largo: [0.3, 60, 'Largo total (m)'], fondo: [0.3, 12, 'Fondo (m)'], modulos: [1, 200, 'Módulos'], niveles: [1, 20, 'Niveles'], slotsPorModulo: [1, 10, 'Posiciones por módulo'],
  altoNivel: [0.1, 5, 'Alto de nivel (m)'], altoBase: [0, 2, 'Alto de base (m)'], cargaMaxKg: [1, 20000, 'Carga máx. (kg)'], ang: [-360, 360, 'Ángulo'], profundidadPalets: [1, 50, 'Profundidad (palets)'], apilado: [1, 10, 'Apilado (palets)'] };
function editarRack(campo, valor, tipo) {
  var r = S.sel && S.sel.tipo === 'rack' ? elementoSel() : null;
  if (!r) return;
  var v = valor;
  if (tipo === 'n' || tipo === 'i') {
    v = num(valor, r[campo]);
    if (tipo === 'i') v = Math.round(v);
    var lim = LIM_RACK[campo];
    if (lim) {
      var notas = [];
      v = acotar(v, lim[0], lim[1], r[campo], lim[2], notas);
      if (notas.length) aviso('Se ajustó el valor: ' + notas.join('; ') + '.', 'warn', 6000);
    }
  }
  var extra = null;
  if (tipo === 'nn') { v = String(valor).trim() === '' ? null : num(valor, null); if (v !== null) v = campo === 'anchoPasillo' ? clamp(v, 0.5, 12) : Math.max(1, v); if (v !== null && !(v > 0)) v = null; }
  else if (tipo === 'e') v = enLista(valor, EQUIPOS_VALIDOS, null);
  else if (campo === 'tipo') {
    v = enLista(valor, TIPOS_UBIC, r.tipo);
    if (v === 'piso' || v === 'cantilever') { extra = { slotsPorModulo: 1 }; if (v === 'piso') extra.niveles = 1; }
    if (v === 'cantilever' && r.altoNivel < 0.6) extra = Object.assign(extra || {}, { altoNivel: 0.8, fondo: Math.max(r.fondo, 1.2) });
  }
  if (campo === 'nombre') {
    v = String(valor).trim().slice(0, 40) || r.nombre;
    if (S.proy.racks.some(function (x) { return x !== r && x.nombre === v; })) { aviso('Ya existe un rack con ese nombre.', 'warn'); refrescarRackProps(); return; }
  }
  mutar(function () { r[campo] = v; if (extra) Object.assign(r, extra); r.auto = false; });
  if (extra) aviso('Al pasar a «' + (NOMBRES_UBIC[v] || v) + '» se ajustaron: ' + Object.keys(extra).join(', ') + ' (revísalos).', 'info', 6000);
}
var tVal = null;
function renderValidacion() {
  var d = $('#validacion'), items = [];
  var v = S.valid;
  if (v && S.validVer === S.ver) v.forEach(function (x) { items.push(x); });
  var h = '';
  /* B-7: nombres de rack repetidos (el motor los renombra con sufijo al normalizar) */
  var cn = dic(), rep = [];
  S.proy.racks.forEach(function (r) { var nm = String(r.nombre || r.id); cn[nm] = (cn[nm] || 0) + 1; if (cn[nm] === 2) rep.push(nm); });
  if (rep.length) h += '<div class="msg aviso"><b>' + rep.length + ' nombre' + (rep.length === 1 ? '' : 's') + ' de rack repetido' + (rep.length === 1 ? '' : 's') + '</b> (' + esc(rep.slice(0, 5).join(', ')) + (rep.length > 5 ? '…' : '') + '). El motor los renombrará con un sufijo al calcular; póngales nombres distintos para reconocerlos en los reportes.</div>';
  if (S.validVer !== S.ver) h += '<div class="muted">Revisando el diseño…</div>';
  var ne = items.filter(function (i) { return i.nivel === 'error'; }).length, na = items.filter(function (i) { return i.nivel === 'aviso'; }).length;
  if (S.validVer === S.ver) {
    h += '<div>' + (ne ? '<span class="chip err">' + ne + ' error' + (ne === 1 ? '' : 'es') + '</span> ' : '') + (na ? '<span class="chip warn">' + na + ' aviso' + (na === 1 ? '' : 's') + '</span> ' : '') + (!ne && !na ? '<span class="chip ok">Sin problemas detectados</span>' : '') + '</div>';
  }
  var angostos = items.filter(function (i) { return i.codigo === 'PASILLO_ANGOSTO'; });
  items.forEach(function (i) {
    if (i.codigo === 'PASILLO_ANGOSTO') return;
    h += '<div class="msg ' + (i.nivel === 'error' ? 'error' : i.nivel === 'aviso' ? 'aviso' : 'info') + '">' + esc(i.mensaje) + '</div>';
  });
  if (angostos.length) {
    h += '<div class="msg aviso"><b>Pasillo angosto en ' + angostos.length + ' rack' + (angostos.length === 1 ? '' : 's') + '.</b> El pasillo real = ancho del equipo + largo del palet + holguras: verifícalo con la ficha del equipo.<ul class="limpia">' +
      angostos.slice(0, 3).map(function (i) { return '<li>' + esc(i.mensaje) + '</li>'; }).join('') + (angostos.length > 3 ? '<li class="muted">… y ' + (angostos.length - 3) + ' más.</li>' : '') + '</ul></div>';
  }
  d.innerHTML = h;
}
function refrescarRacksPanel() {
  renderGenResumen();
  refrescarRackProps();
  renderValidacion();
  if (S.validVer !== S.ver) {
    clearTimeout(tVal);
    var ver = S.ver;
    tVal = setTimeout(function () {
      try { S.valid = M.validarProyecto(S.proy) || []; } catch (e) { console.error(e); S.valid = [{ nivel: 'aviso', codigo: 'ERR', mensaje: 'No se pudo revisar el diseño: ' + e.message }]; }
      S.validVer = ver;
      if (S.tab === 'racks') renderValidacion();
    }, 350);
  }
}

/* ------------------------------------------------------------------ descargas */
function descargar(nombre, contenido, mime) {
  var blob = contenido instanceof Blob ? contenido : new Blob([contenido], { type: mime || 'text/plain' });
  var a = document.createElement('a');
  var url = URL.createObjectURL(blob);
  a.href = url; a.download = nombre;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 1500);
}
function conBOM(t) { t = String(t == null ? '' : t); return t.charAt(0) === '﻿' ? t : '﻿' + t; }
function leerTexto(file) {
  return new Promise(function (res, rej) {
    var fr = new FileReader();
    fr.onload = function () { res(String(fr.result || '')); };
    fr.onerror = function () { rej(fr.error); };
    fr.readAsText(file, 'utf-8');
  });
}

/* ------------------------------------------------------------------ Artículos */
var PAG = 100;
var CAMPOS_ART = [
  ['sku', 'c-sku', 't'], ['descripcion', 'c-desc', 't'], ['familia', 'c-fam', 't'],
  ['cantidad', 'c-num', 'n', 1], ['unidadesPorUbic', 'c-num', 'n', 1], ['picks', 'c-num', 'n', 1], ['entradas', 'c-num', 'n', 1],
  ['pesoUnitKg', 'c-num', 'n', 0.01], ['altoCargaM', 'c-num', 'n', 0.01]
];
function skusDuplicados() {
  var c = dic(), d = dic();
  S.proy.productos.forEach(function (p) { c[p.sku] = (c[p.sku] || 0) + 1; if (c[p.sku] > 1) d[p.sku] = true; });
  return d;
}
function indicesFiltrados() {
  var f = (S.filtroArt || '').toLowerCase().trim(), out = [];
  S.proy.productos.forEach(function (p, i) {
    if (!f || String(p.sku).toLowerCase().indexOf(f) >= 0 || String(p.descripcion || '').toLowerCase().indexOf(f) >= 0 || String(p.familia || '').toLowerCase().indexOf(f) >= 0) out.push(i);
  });
  return out;
}
function posReq(p) { return p.unidadesPorUbic > 0 && !p.crossdock ? Math.ceil(cantidadParaDimensionar(p) / p.unidadesPorUbic - 1e-9) : 0; }   // igual que el motor (en piso/cantilever el motor divide además por la capacidad del carril)
/* Datos de artículos que el motor ignora o rechaza: SKU repetido, vacío, unidades por ubicación ≤ 0, valores negativos (M1). */
function problemasDatos() {
  return cache('probdatos', S.ver, function () {
    var vistos = dic(), dup = dic(), inval = [];
    S.proy.productos.forEach(function (p, i) {
      var sku = String(p.sku == null ? '' : p.sku).trim(), mot = [];
      if (!sku) mot.push('SKU vacío');
      else { if (vistos[sku]) dup[sku] = true; vistos[sku] = true; }
      if (!(p.unidadesPorUbic > 0)) mot.push('unidades por ubicación ≤ 0');
      if (!(p.cantidad >= 0)) mot.push('cantidad inválida');
      if (!(p.picks >= 0)) mot.push('picks inválidos');
      if (TIPOS_UBIC.indexOf(p.tipoUbic) < 0) mot.push('tipo de ubicación desconocido');
      if (p.tipoUbic === 'cantilever' && !(p.largoM > 0)) mot.push('cantilever sin largo de carga');
      if (mot.length) inval.push({ fila: i + 1, sku: sku || '(vacío)', motivos: mot });
    });
    return { duplicados: Object.keys(dup), invalidos: inval, total: Object.keys(dup).length + inval.length };
  });
}
function cajaProblemasDatos() {
  var pd = problemasDatos();
  if (!pd.total) return '';
  var h = '<div class="msg error"><b>Datos de artículos que el programa no puede usar bien</b><ul class="limpia">';
  if (pd.duplicados.length) h += '<li>SKU repetidos (' + pd.duplicados.length + '): ' + esc(pd.duplicados.slice(0, 6).join(', ')) + (pd.duplicados.length > 6 ? '…' : '') + '. Solo se usa una fila por SKU; las demás se listan como «duplicado» y no se ubican.</li>';
  if (pd.invalidos.length) h += '<li>Filas con datos inválidos (' + pd.invalidos.length + '): ' + pd.invalidos.slice(0, 5).map(function (x) { return 'fila ' + x.fila + ' (' + esc(x.sku) + ': ' + esc(x.motivos.join(', ')) + ')'; }).join('; ') + (pd.invalidos.length > 5 ? '…' : '') + '. Se ignoran y no se ubican.</li>';
  return h + '</ul>Corrígelos en la pestaña Artículos.</div>';
}
function filaArtHTML(p, i, abc, dup) {
  var h = '<tr data-i="' + N(i) + '"' + (dup[p.sku] ? ' class="dup" title="SKU repetido"' : (S.artSel === i ? ' class="fila-sel"' : '')) + '>';
  CAMPOS_ART.forEach(function (c) {
    var v = p[c[0]];
    if (c[2] === 't') h += '<td><input type="text" class="' + c[1] + '" data-c="' + c[0] + '" value="' + esc(v) + '" aria-label="' + c[0] + ' fila ' + (N(i) + 1) + '"></td>';
    else h += '<td class="n"><input type="number" class="' + c[1] + '" data-c="' + c[0] + '" step="' + c[3] + '" min="0" value="' + (v == null ? '' : N(v)) + '" aria-label="' + c[0] + ' fila ' + (N(i) + 1) + '"' + (c[0] === 'entradas' ? ' placeholder="estimar"' : '') + '></td>';
  });
  h += '<td><select data-c="tipoUbic" aria-label="Tipo de ubicación fila ' + (i + 1) + '">' + TIPOS_UBIC.map(function (t) { return '<option value="' + esc(t) + '"' + (p.tipoUbic === t ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join('') + '</select></td>';
  h += '<td><select data-c="requiereZona" aria-label="Zona requerida fila ' + (i + 1) + '"><option value="">—</option>' + ['frio', 'peligrosos', 'alto_valor', 'cuarentena'].map(function (t) { return '<option value="' + t + '"' + (p.requiereZona === t ? ' selected' : '') + '>' + NOMBRES_ZONA[t] + '</option>'; }).join('') + '</select></td>';
  h += '<td><input type="text" class="c-inc" data-c="incompatibleCon" value="' + esc((p.incompatibleCon || []).join('|')) + '" aria-label="Incompatibles fila ' + (i + 1) + '"></td>';
  var cl = abc[p.sku] ? abc[p.sku].clase : '';
  h += '<td class="abc-c" data-d="abc">' + (cl ? '<span class="badge-abc ' + esc(cl) + '">' + esc(cl) + '</span>' : '') + '</td>';
  h += '<td class="n" data-d="pos">' + N(posReq(p)) + '</td>';
  h += '<td class="adv-c"><button type="button" class="btn peq-btn' + (S.artSel === i ? ' primario' : '') + '" data-adv="' + N(i) + '" aria-label="Avanzado de la fila ' + (N(i) + 1) + '" title="Stock máx., lotes, FEFO, cross-docking, peligro…">⋯</button>' + marcasAvanzado(p) + '</td>';
  h += '<td><button type="button" class="btn peq-btn" data-del="' + N(i) + '" aria-label="Borrar fila ' + (N(i) + 1) + '">✕</button></td></tr>';
  return h;
}
function refrescarArticulos() {
  var p = S.proy, vacio = !p.productos.length;
  $('#art-vacio').hidden = !vacio;
  if (vacio) {
    $('#art-vacio').innerHTML = '<h3 style="justify-content:center">Aún no hay artículos</h3><p class="muted">Cada artículo (SKU) necesita cantidad, unidades por ubicación y picks (rotación). Elige una opción:</p>' +
      '<div class="acc" style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap"><button type="button" class="btn primario" data-acc="ejemplo">Cargar ejemplo</button>' +
      '<button type="button" class="btn" data-acc-art="import">Importar CSV</button><button type="button" class="btn" data-acc-art="plantilla">Descargar plantilla CSV</button><button type="button" class="btn" data-acc-art="add">Añadir fila a mano</button></div>';
  }
  var er = $('#art-errores');
  var nE = S.erroresCSV ? S.erroresCSV.length : 0, nA = S.avisosCSV ? S.avisosCSV.length : 0;
  if (nE || nA) {
    er.hidden = false;
    var lis = function (l) { return '<ul class="limpia">' + l.slice(0, 15).map(function (e) { return '<li>Línea ' + esc(e.linea) + ': ' + esc(e.mensaje) + '</li>'; }).join('') + (l.length > 15 ? '<li>… y ' + (l.length - 15) + ' más.</li>' : '') + '</ul>'; };
    er.innerHTML = (nE ? '<b>' + nE + ' error(es) al importar el CSV (esas filas no se importaron):</b>' + lis(S.erroresCSV) : '') +
      (nA ? (S.csvCancelado ? '<b>Importación cancelada: NO se importó nada. ' + nA + ' advertencia(s) del CSV para corregir en el archivo:</b>' : '<b>' + nA + ' advertencia(s) del CSV (las filas SÍ se importaron; verifica que los números se leyeron bien):</b>') + lis(S.avisosCSV) : '');
  } else { er.hidden = true; er.innerHTML = ''; }
  if (S.noRenderTabla) { S.noRenderTabla = false; actualizarDerivadosArt(); }
  else renderTablaArt();
  renderResumenArt();
  renderAvanzadoArt();
  renderPedidos();
  dibujarPareto();
  var dl = $('#sku-lista');
  if (dl && dl.getAttribute('data-n') !== String(p.productos.length) + '|' + S.ver) {
    dl.setAttribute('data-n', String(p.productos.length) + '|' + S.ver);
    dl.innerHTML = p.productos.slice(0, 800).map(function (q) { return '<option value="' + esc(q.sku) + '">' + esc(q.descripcion || '') + '</option>'; }).join('');
  }
}
function renderTablaArt() {
  var p = S.proy, idx = indicesFiltrados(), abc = mapaABC(), dup = skusDuplicados();
  var paginas = Math.max(1, Math.ceil(idx.length / PAG));
  S.pagArt = clamp(S.pagArt, 0, paginas - 1);
  var ini = S.pagArt * PAG, vis = idx.slice(ini, ini + PAG);
  $('#tbody-art').innerHTML = vis.map(function (i) { return filaArtHTML(p.productos[i], i, abc, dup); }).join('');
  $('#art-contador').textContent = idx.length + (idx.length === p.productos.length ? ' artículos' : ' de ' + p.productos.length + ' artículos');
  $('#art-pag').textContent = 'Página ' + (S.pagArt + 1) + ' de ' + paginas;
  $('#art-prev').disabled = S.pagArt <= 0; $('#art-next').disabled = S.pagArt >= paginas - 1;
  $('#tabla-art').parentNode.hidden = !p.productos.length;
}
function actualizarDerivadosArt() {
  var abc = mapaABC(), dup = skusDuplicados(), p = S.proy;
  $$('#tbody-art tr').forEach(function (tr) {
    var i = parseInt(tr.getAttribute('data-i'), 10), pr = p.productos[i];
    if (!pr) return;
    var cl = abc[pr.sku] ? abc[pr.sku].clase : '';
    tr.querySelector('[data-d="abc"]').innerHTML = cl ? '<span class="badge-abc ' + esc(cl) + '">' + esc(cl) + '</span>' : '';
    tr.querySelector('[data-d="pos"]').textContent = posReq(pr);
    tr.classList.toggle('dup', !!dup[pr.sku]);
  });
}
function renderResumenArt() {
  var nec = necesidadPorTipo(), dis = disponiblesPorTipo(), h = '<table class="tabla-simple"><thead><tr><th>Tipo</th><th class="n">Necesarias</th><th class="n">Disponibles</th><th>Estado</th></tr></thead><tbody>';
  var tn = 0, td = 0, hay = false;
  TIPOS_UBIC.forEach(function (t) {
    var n = nec[t] || 0, d = dis[t] || 0;
    tn += n; td += d;
    if (!n && !d) return;
    hay = true;
    h += '<tr><td>' + t + '</td><td class="n">' + n + '</td><td class="n">' + d + '</td><td>' + (n <= d ? '<span class="chip ok">alcanza (' + fmt(d ? n / d * 100 : 0, 0) + ' %)</span>' : '<span class="chip err">faltan ' + (n - d) + '</span>') + '</td></tr>';
  });
  if (!hay) h += '<tr><td colspan="4" class="muted">Sin datos: añade artículos y racks.</td></tr>';
  h += '</tbody></table>';
  if (!S.proy.racks.length) h += '<div class="msg aviso">Todavía no hay racks: genera los racks en el paso 2 para ver las posiciones disponibles.</div>';
  h += cajaProblemasDatos();
  $('#art-resumen').innerHTML = h;
}
function dibujarPareto() {
  var c = $('#canvas-pareto');
  var cssW = c.parentNode.clientWidth - 24 || 600;
  if (cssW < 100) return;
  var dpr = window.devicePixelRatio || 1, cssH = Math.round(Math.min(300, Math.max(190, cssW * 0.42)));
  c.width = Math.round(cssW * dpr); c.height = Math.round(cssH * dpr);
  var g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  var pal = paletaActual();
  g.clearRect(0, 0, cssW, cssH);
  var prods = S.proy.productos;
  var leyenda = $('#pareto-leyenda');
  if (!prods.length) {
    g.fillStyle = pal.texto; g.font = '13px system-ui,sans-serif'; g.textAlign = 'center'; g.fillText('Sin artículos todavía', cssW / 2, cssH / 2);
    leyenda.textContent = ''; return;
  }
  var abc = [];
  try { abc = M.clasificarABC(prods, S.proy.config.abc) || []; } catch (e) { console.error(e); abc = []; }
  var tot = 0; abc.forEach(function (a) { tot += a.picks || 0; });
  var ml = 44, mr = 40, mt = 18, mb = 26, pw = cssW - ml - mr, ph = cssH - mt - mb;
  var n = abc.length, maxP = 1;
  abc.forEach(function (a) { if ((a.picks || 0) > maxP) maxP = a.picks; });
  // ejes y rejilla
  g.font = '11px system-ui,sans-serif'; g.textBaseline = 'middle';
  g.strokeStyle = pal.grid.replace(/0\.\d+\)/, '0.25)'); g.lineWidth = 1;
  var i;
  for (i = 0; i <= 4; i++) {
    var y = mt + ph - ph * i / 4;
    g.beginPath(); g.moveTo(ml, y + .5); g.lineTo(ml + pw, y + .5); g.stroke();
    g.fillStyle = pal.texto; g.textAlign = 'right'; g.fillText(fmt(maxP * i / 4, 0), ml - 5, y);
    g.textAlign = 'left'; g.fillText((i * 25) + ' %', ml + pw + 5, y);
  }
  var bw = pw / n;
  abc.forEach(function (a, j) {
    var x = ml + j * bw, hh = ph * (a.picks || 0) / maxP;
    g.fillStyle = COLOR_ABC[a.clase] || '#888';
    g.fillRect(x, mt + ph - hh, Math.max(1, bw - (bw > 4 ? 1 : 0)), hh);
    if (a.clase === 'A' && bw > 3) { g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(x, mt + ph - hh, Math.max(1, bw - 1), 2); }
  });
  // curva acumulada
  g.beginPath();
  abc.forEach(function (a, j) {
    var f = (a.porcAcum != null ? a.porcAcum : 0) / 100;
    var x = ml + (j + 0.5) * bw, y2 = mt + ph - ph * clamp(f, 0, 1);
    if (j) g.lineTo(x, y2); else g.moveTo(x, y2);
  });
  g.lineWidth = 2.2; g.strokeStyle = pal.contorno; g.stroke();
  // líneas de corte
  var cfg = S.proy.config.abc || { a: 0.8, b: 0.95 };
  [cfg.a, cfg.b].forEach(function (u) {
    var y3 = mt + ph - ph * u;
    g.setLineDash([5, 4]); g.strokeStyle = pal.error; g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(ml, y3 + .5); g.lineTo(ml + pw, y3 + .5); g.stroke(); g.setLineDash([]);
  });
  // marcas de clase en el eje x
  var cuenta = { A: 0, B: 0, C: 0 }, picksC = { A: 0, B: 0, C: 0 };
  abc.forEach(function (a) { cuenta[a.clase]++; picksC[a.clase] += a.picks || 0; });
  var x0 = ml;
  ['A', 'B', 'C'].forEach(function (cl) {
    var w2 = cuenta[cl] * bw;
    if (w2 > 0) {
      g.fillStyle = COLOR_ABC[cl]; g.fillRect(x0, mt + ph + 4, Math.max(2, w2 - 1), 4);
      g.fillStyle = pal.texto; g.textAlign = 'center'; g.font = '700 11px system-ui,sans-serif';
      if (w2 > 14) g.fillText(cl, x0 + w2 / 2, mt + ph + 17);
    }
    x0 += w2;
  });
  g.fillStyle = pal.texto; g.font = '11px system-ui,sans-serif'; g.textAlign = 'left';
  g.fillText('picks', 4, mt - 6); g.textAlign = 'right'; g.fillText('% acum.', cssW - 2, mt - 6);
  g.strokeStyle = pal.texto; g.lineWidth = 1; g.beginPath(); g.moveTo(ml + .5, mt); g.lineTo(ml + .5, mt + ph + .5); g.lineTo(ml + pw, mt + ph + .5); g.stroke();
  leyenda.innerHTML = ['A', 'B', 'C'].map(function (cl) {
    return '<span class="badge-abc ' + cl + '">' + cl + '</span> ' + cuenta[cl] + ' SKU · ' + fmt(tot ? picksC[cl] / tot * 100 : 0, 0) + ' % de los picks';
  }).join(' &nbsp; ') + ' &nbsp;<span class="muted">(líneas rojas: cortes ' + Math.round(cfg.a * 100) + ' % y ' + Math.round(cfg.b * 100) + ' %)</span>';
}
/* ---- Artículos: panel «Avanzado» (v1.1), lotes y pedidos ---- */
function marcasAvanzado(p) {
  var m = [];
  if (p.fefo) m.push('FEFO');
  if (p.crossdock) m.push('X-dock');
  if (p.lotes && p.lotes.length) m.push(p.lotes.length + ' lote' + (p.lotes.length > 1 ? 's' : ''));
  if (p.peligro) m.push(NOMBRES_PELIGRO[p.peligro] || p.peligro);
  if (p.stockMax != null) m.push('máx.');
  return m.length ? '<div class="marcas-adv">' + m.map(function (t) { return '<span class="mini-chip">' + esc(t) + '</span>'; }).join('') + '</div>' : '';
}
function sumaLotes(p) { return (p.lotes || []).reduce(function (s, l) { return s + N(l.cantidad); }, 0); }
function renderAvanzadoArt() {
  var box = $('#art-adv'), tit = $('#art-adv-titulo');
  if (!box) return;
  var pr = S.artSel != null ? S.proy.productos[S.artSel] : null;
  if (!pr) { S.artSel = null; box.innerHTML = '<p class="peq muted">Pulsa «⋯» en la fila de un artículo para editar su stock máximo, picks pico, lotes con vencimiento, FEFO, cross-docking, peligro, largo y apilado. Todos son opcionales: vacíos reproducen el comportamiento anterior.</p>'; tit.textContent = 'elige un artículo con el botón «⋯» de su fila'; return; }
  tit.textContent = 'SKU ' + pr.sku;
  var num_ = function (campo, etq, ph, step, ayuda) { return '<label>' + etq + '<input type="number" data-av="' + campo + '" min="0" step="' + step + '" value="' + (pr[campo] == null ? '' : N(pr[campo])) + '" placeholder="' + esc(ph) + '"></label>'; };
  var h = '<div class="rejilla3">' +
    num_('stockMax', 'Stock máximo en el pico (unid.)', '= cantidad', 1) +
    num_('picksPico', 'Picks por periodo en temporada alta', '= picks', 1) +
    num_('unidadesPorLinea', 'Unidades por línea de pedido', 'falta: dato suyo', 1) +
    '<label>Clase de peligro (segregación)<select data-av="peligro"><option value="">— ninguno —</option>' + PELIGROS.map(function (t) { return '<option value="' + t + '"' + (pr.peligro === t ? ' selected' : '') + '>' + esc(NOMBRES_PELIGRO[t]) + '</option>'; }).join('') + '</select></label>' +
    num_('largoM', 'Largo de la carga (m) · mercadería larga', 'vacío = no aplica', 0.1) +
    '<label>Apilable máx. (palets uno sobre otro)<input type="number" data-av="apilableMax" min="1" max="20" step="1" value="' + N(pr.apilableMax || 1) + '"></label>' +
    '</div>' +
    '<div class="fila-inp"><label class="inline"><input type="checkbox" data-av="fefo"' + (pr.fefo ? ' checked' : '') + '> FEFO: sale primero lo que vence primero (exige ubicación sin LIFO)</label>' +
    '<label class="inline"><input type="checkbox" data-av="crossdock"' + (pr.crossdock ? ' checked' : '') + '> Cross-docking: pasa por el muelle, NO ocupa rack</label></div>' +
    (pr.crossdock ? '<div class="rejilla3">' + num_('flujoCrossdock', 'Flujo que cruza recepción→despacho (palets/periodo)', 'falta: dato suyo', 1) + '</div>' : '');
  if (pr.tipoUbic === 'cantilever' && !(pr.largoM > 0)) h += '<div class="msg aviso">Un artículo en cantilever necesita el <b>largo de la carga</b>: sin él no se podrá ubicar.</div>';
  if (pr.stockMax != null && pr.stockMax < pr.cantidad) h += '<div class="msg aviso">El stock máximo (' + fmt(pr.stockMax, 0) + ') es menor que la cantidad actual (' + fmt(pr.cantidad, 0) + '): revisa el dato.</div>';
  var lotes = pr.lotes || [], sum = sumaLotes(pr);
  h += '<h4 class="sub-h">Lotes con vencimiento <span class="muted peq">(opcional; Σ lotes debería igualar la cantidad)</span></h4>';
  if (lotes.length) {
    h += '<table class="tabla-simple tabla-lotes"><thead><tr><th>Lote</th><th class="n">Cantidad</th><th>Vence</th><th><span class="sr">Quitar</span></th></tr></thead><tbody>' +
      lotes.map(function (l, j) {
        return '<tr data-lj="' + j + '"><td><input type="text" data-lc="lote" maxlength="40" value="' + esc(l.lote) + '" aria-label="Lote ' + (j + 1) + '"></td>' +
          '<td class="n"><input type="number" data-lc="cantidad" min="0" step="1" value="' + N(l.cantidad) + '" aria-label="Cantidad del lote ' + (j + 1) + '"></td>' +
          '<td><input type="date" data-lc="vence" value="' + esc(l.vence || '') + '" aria-label="Vencimiento del lote ' + (j + 1) + '"></td>' +
          '<td><button type="button" class="btn peq-btn" data-lq="' + j + '" aria-label="Quitar lote ' + (j + 1) + '">✕</button></td></tr>';
      }).join('') + '</tbody></table>';
    var ok = Math.abs(sum - pr.cantidad) <= Math.max(0.5, pr.cantidad * 0.001);
    h += '<div class="msg ' + (ok ? 'ok' : 'aviso') + '">Σ lotes = ' + fmt(sum, 0) + ' · cantidad del artículo = ' + fmt(pr.cantidad, 0) + (ok ? ' (cuadra).' : ': <b>no cuadra</b> (diferencia ' + fmt(sum - pr.cantidad, 0) + '). El motor avisará y repartirá por lote solo lo que haya.') + '</div>';
  } else h += '<p class="peq muted">Sin lotes: todo el stock se trata como un solo lote.</p>';
  h += '<div class="fila-inp"><button type="button" class="btn" data-lotes="add">Añadir lote</button></div>';
  box.innerHTML = h;
}
function editarAvanzado(campo, valor, chk) {
  var pr = S.artSel != null ? S.proy.productos[S.artSel] : null;
  if (!pr) return;
  var v;
  if (['stockMax', 'picksPico', 'unidadesPorLinea', 'flujoCrossdock', 'largoM'].indexOf(campo) >= 0) v = String(valor).trim() === '' ? null : Math.max(0, num(valor, 0));
  else if (campo === 'apilableMax') v = Math.round(clamp(num(valor, 1), 1, 20));
  else if (campo === 'peligro') v = enLista(valor, PELIGROS, null);
  else if (campo === 'fefo' || campo === 'crossdock') v = !!chk;
  else return;
  mutar(function () { pr[campo] = v; }, { inv: true });
  renderAvanzadoArt();
}
function editarLote(j, campo, valor) {
  var pr = S.artSel != null ? S.proy.productos[S.artSel] : null;
  if (!pr || !pr.lotes || !pr.lotes[j]) return;
  var v;
  if (campo === 'lote') v = String(valor).slice(0, 40);
  else if (campo === 'cantidad') v = Math.max(0, num(valor, 0));
  else { v = ymdValido(valor) ? valor : null; if (valor && !v) aviso('Fecha de vencimiento no válida.', 'warn'); }
  mutar(function () { pr.lotes[j][campo] = v; }, { inv: true });
  renderAvanzadoArt();
}
function pedidosResumen() {
  var ped = S.proy.pedidos || [], skus = productoPorSku(), lineas = 0, desc = dic(), uno = 0;
  ped.forEach(function (o) {
    lineas += o.lineas.length;
    if (o.lineas.length < 2) uno++;
    o.lineas.forEach(function (l) { if (!(l.sku in skus)) desc[l.sku] = true; });
  });
  return { n: ped.length, lineas: lineas, desconocidos: Object.keys(desc), unaLinea: uno };
}
function renderPedidos() {
  var box = $('#ped-resumen');
  if (!box) return;
  var r = pedidosResumen();
  if (!r.n) { box.innerHTML = '<span class="muted">Sin pedidos cargados: no se usa afinidad.</span>'; $('#ped-afinidad').innerHTML = ''; return; }
  box.innerHTML = '<b>' + fmt(r.n, 0) + '</b> pedidos · <b>' + fmt(r.lineas, 0) + '</b> líneas · ' + fmt(r.unaLinea, 0) + ' de una sola línea (no aportan pares)' +
    (r.desconocidos.length ? ' · <span class="chip warn">' + r.desconocidos.length + ' SKU desconocidos</span> (' + esc(r.desconocidos.slice(0, 6).join(', ')) + (r.desconocidos.length > 6 ? '…' : '') + ')' : '') +
    (r.n < 30 ? '<div class="msg aviso">Muestra pequeña (' + r.n + ' pedidos, menos de 30): la afinidad es poco fiable <span class="verif">[VERIFICAR]</span>.</div>' : '');
}
/* lector propio solo si el motor aún no trae parseCSVPedidos */
function parseCSVPedidosLocal(texto) {
  var t = String(texto || '').replace(/^﻿/, ''), lin = t.split(/\r?\n/).filter(function (l) { return l.trim() !== ''; });
  var errores = [], adv = [], por = dic(), orden = [];
  if (!lin.length) return { pedidos: [], errores: [{ linea: 1, mensaje: 'El archivo está vacío.' }], advertencias: [] };
  var sep = (lin[0].match(/;/g) || []).length >= (lin[0].match(/,/g) || []).length ? ';' : ',';
  var cab = lin[0].split(sep).map(function (s) { return s.trim().toLowerCase(); });
  var ip = cab.indexOf('pedido'), is = cab.indexOf('sku'), ic = cab.indexOf('cant');
  if (ip < 0 || is < 0) return { pedidos: [], errores: [{ linea: 1, mensaje: 'Faltan las columnas «pedido» y «sku» en el encabezado.' }], advertencias: [] };
  lin.slice(1).forEach(function (l, k) {
    var c = l.split(sep), id = (c[ip] || '').trim().slice(0, 40), sku = (c[is] || '').trim().slice(0, 60);
    if (!id || !sku) { errores.push({ linea: k + 2, mensaje: 'Falta el pedido o el SKU.' }); return; }
    var cant = ic >= 0 ? num(c[ic], null) : null;
    if (!(id in por)) { por[id] = { id: id, lineas: [] }; orden.push(id); }
    por[id].lineas.push(cant != null && cant > 0 ? { sku: sku, cant: cant } : { sku: sku });
  });
  return { pedidos: orden.map(function (id) { return por[id]; }), errores: errores, advertencias: adv };
}
async function importarPedidosArchivo(file) {
  var texto;
  try { texto = await leerTexto(file); } catch (e) { aviso('No se pudo leer el archivo.', 'error'); return; }
  var r;
  try { r = (typeof M.parseCSVPedidos === 'function' ? M.parseCSVPedidos : parseCSVPedidosLocal)(texto); } catch (e2) { aviso('El CSV de pedidos no se pudo interpretar: ' + e2.message, 'error'); return; }
  var ped = pedidosLimpios(r && r.pedidos);
  S.erroresCSV = (r && r.errores) || []; S.avisosCSV = (r && r.advertencias) || []; S.csvCancelado = false;
  if (!ped.length) { aviso('No se encontró ningún pedido válido en el CSV.', 'warn', 7000); refrescarArticulos(); return; }
  mutar(function () { S.proy.pedidos = ped; });
  refrescarArticulos();
  var rs = pedidosResumen();
  aviso(rs.n + ' pedidos importados (' + rs.lineas + ' líneas)' + (rs.desconocidos.length ? '; ' + rs.desconocidos.length + ' SKU no están en la tabla de artículos' : '') + '.', rs.desconocidos.length || S.erroresCSV.length ? 'warn' : 'ok', 6000);
}
function verAfinidad() {
  var box = $('#ped-afinidad');
  if (!(S.proy.pedidos || []).length) { aviso('Primero importa pedidos.', 'warn'); return; }
  if (typeof M.calcularAfinidad !== 'function') { box.innerHTML = '<div class="msg aviso">El motor instalado todavía no incluye <code>calcularAfinidad</code>; la afinidad estará disponible al actualizar <code>motor.js</code>.</div>'; return; }
  var a;
  try { a = M.calcularAfinidad(S.proy.pedidos, S.proy.productos); } catch (e) { box.innerHTML = '<div class="msg error">No se pudo calcular la afinidad: ' + esc(e.message) + '</div>'; return; }
  var pares = ((a && a.pares) || []).slice().sort(function (x, y) { return N(y.lift) - N(x.lift) || N(y.soporte) - N(x.soporte); }).slice(0, 15);
  if (!pares.length) { box.innerHTML = '<div class="msg aviso">No hay pares: se necesitan pedidos con 2 o más líneas.</div>'; return; }
  box.innerHTML = '<h4 class="sub-h">Pares que más se piden juntos (' + fmt(a.nPedidos, 0) + ' pedidos)</h4><table class="tabla-simple"><thead><tr><th>SKU A</th><th>SKU B</th><th class="n">Veces juntos</th><th class="n">Soporte</th><th class="n">Lift</th></tr></thead><tbody>' +
    pares.map(function (p) { return '<tr><td>' + esc(p.a) + '</td><td>' + esc(p.b) + '</td><td class="n">' + fmt(N(p.coocurrencias), 0) + '</td><td class="n">' + fmt(N(p.soporte) * 100, 1) + ' %</td><td class="n">' + fmt(N(p.lift), 2) + '</td></tr>'; }).join('') +
    '</tbody></table><p class="peq muted">Soporte = fracción de pedidos que contienen ambos; lift &gt; 1 = se piden juntos más de lo esperable por azar. Con pocos pedidos es solo indicativo <span class="verif">[VERIFICAR]</span>.</p>';
}
function descargarPlantillaPedidos() {
  descargar('plantilla-pedidos.csv', conBOM('pedido;sku;cant\nP1;SKU-001;2\nP1;SKU-002;1\nP2;SKU-001;1\nP2;SKU-003;4\n'), 'text/csv;charset=utf-8');
  aviso('Plantilla de pedidos descargada (los SKU de la plantilla son solo ilustrativos: use los suyos).', 'ok', 5000);
}
function nuevaFilaProducto() {
  var base = 'SKU-', n = S.proy.productos.length + 1, sku;
  do { sku = base + (n < 100 ? ('00' + n).slice(-3) : n); n++; } while (S.proy.productos.some(function (q) { return q.sku === sku; }));
  return { sku: sku, descripcion: '', familia: '', cantidad: 0, unidadesPorUbic: 1, picks: 0, entradas: null, pesoUnitKg: 0, altoCargaM: 0, tipoUbic: 'palet', requiereZona: null, incompatibleCon: [],
    stockMax: null, picksPico: null, unidadesPorLinea: null, peligro: null, fefo: false, lotes: [], crossdock: false, flujoCrossdock: null, largoM: null, apilableMax: 1 };
}
function anadirFila() {
  mutar(function () { S.proy.productos.push(nuevaFilaProducto()); });
  S.filtroArt = ''; $('#art-filtro').value = '';
  S.pagArt = Math.max(0, Math.ceil(S.proy.productos.length / PAG) - 1);
  renderTablaArt();
  var filas = $$('#tbody-art tr');
  var ult = filas[filas.length - 1];
  if (ult) { ult.scrollIntoView({ block: 'nearest' }); var inp = ult.querySelector('input'); if (inp) { inp.focus(); inp.select(); } }
}
function editarArticulo(i, campo, valor) {
  var pr = S.proy.productos[i];
  if (!pr) return;
  var v = valor;
  if (['cantidad', 'unidadesPorUbic', 'picks', 'pesoUnitKg', 'altoCargaM'].indexOf(campo) >= 0) {
    v = num(valor, 0);
    if (v < 0) v = 0;
    if (campo === 'unidadesPorUbic' && v <= 0) { v = 1; aviso('Las unidades por ubicación deben ser mayores que cero (se puso 1).', 'warn'); }
  } else if (campo === 'entradas') {
    v = String(valor).trim() === '' ? null : Math.max(0, num(valor, 0));
  } else if (campo === 'requiereZona') {
    v = valor === '' ? null : valor;
  } else if (campo === 'incompatibleCon') {
    v = String(valor).split(/[|,;]/).map(function (s) { return s.trim(); }).filter(Boolean);
  } else if (campo === 'sku') {
    v = String(valor).trim();
    if (!v) { aviso('El SKU no puede estar vacío.', 'warn'); renderTablaArt(); return; }
  } else v = String(valor);
  S.noRenderTabla = true;
  mutar(function () { pr[campo] = v; }, { inv: campo !== 'descripcion' });
  if (campo === 'unidadesPorUbic' || campo === 'cantidad') { var tr = $('#tbody-art tr[data-i="' + i + '"]'); if (tr && campo === 'unidadesPorUbic') tr.querySelector('[data-c="unidadesPorUbic"]').value = v; }
}
async function importarCSVArchivo(file) {
  if (!file) return;
  var texto;
  try { texto = await leerTexto(file); } catch (e) { aviso('No se pudo leer el archivo.', 'error'); return; }
  var r;
  try { r = M.parseCSVProductos(texto); } catch (e2) { aviso('El CSV no se pudo interpretar: ' + e2.message, 'error'); return; }
  var prods = (r && r.productos) || [];
  S.erroresCSV = (r && r.errores) || [];
  S.avisosCSV = (r && r.advertencias) || [];
  S.csvCancelado = false;
  var ambig = S.avisosCSV.filter(function (x) { return /ambigu|miles|decimal|entero/i.test(String(x.mensaje)); });
  if (ambig.length) {
    var okAmb = await preguntar('El CSV tiene números ambiguos (' + ambig.length + ')',
      'Pueden leerse mal los miles y decimales (por ejemplo «1.000» o «1,500»), lo que cambiaría cantidades y picks sin aviso. Primeros casos:\n' +
      ambig.slice(0, 5).map(function (x) { return 'Línea ' + x.linea + ': ' + x.mensaje; }).join('\n') +
      (ambig.length > 5 ? '\n… y ' + (ambig.length - 5) + ' más (se muestran en la pantalla de Artículos).' : '') +
      '\n\nRecomendado: cancelar, corregir el archivo y volver a importar.',
      [{ texto: 'Cancelar', valor: 'cancelar', primario: true }, { texto: 'Importar igual', valor: 'igual' }]);
    if (okAmb !== 'igual') { S.csvCancelado = true; aviso('Importación cancelada: corrige los números ambiguos del CSV.', 'warn', 7000); irTab('articulos'); refrescarArticulos(); return; }
  }
  if (!prods.length) { aviso('No se encontró ningún artículo en el CSV.' + (S.erroresCSV.length ? ' Revisa los avisos.' : ''), 'warn', 7000); refrescarArticulos(); return; }
  var modo = 'reemplazar';
  if (S.proy.productos.length) {
    modo = await preguntar('Importar ' + prods.length + ' artículos', 'Ya hay ' + S.proy.productos.length + ' artículos en el proyecto.\n¿Quieres reemplazarlos o añadir los nuevos al final?', [
      { texto: 'Reemplazar', valor: 'reemplazar', primario: true }, { texto: 'Añadir al final', valor: 'anadir' }, { texto: 'Cancelar', valor: null }]);
    if (!modo) return;
  }
  mutar(function () {
    if (modo === 'reemplazar') S.proy.productos = prods;
    else {
      var ya = dic();
      S.proy.productos.forEach(function (q) { ya[q.sku] = true; });
      prods.forEach(function (q) { if (ya[q.sku]) { S.erroresCSV.push({ linea: '—', mensaje: 'SKU repetido «' + q.sku + '»: revisa la fila duplicada.' }); } S.proy.productos.push(q); });
    }
  });
  S.pagArt = 0; S.filtroArt = ''; $('#art-filtro').value = ''; S.artSel = null;
  refrescarArticulos();
  var nAv = S.erroresCSV.length + S.avisosCSV.length;
  aviso(prods.length + ' artículos importados' + (nAv ? ' (con ' + nAv + ' avisos: revísalos arriba en Artículos)' : '') + '.', nAv ? 'warn' : 'ok', nAv ? 9000 : 3500);
}

/* ------------------------------------------------------------------ Asignar */
function leerOpcionesAsignar() {
  var c = S.proy.config;
  c.pesoRecepcion = clamp(num($('#a-peso-rec').value, 30) / 100, 0, 1);
  c.pasadasMejora = Math.max(0, Math.round(num($('#a-pasadas').value, c.pasadasMejora)));
  c.separacionIncompatibles = Math.max(0, num($('#a-sep').value, c.separacionIncompatibles));
  c.penalNivelPalet = clamp(num($('#a-penal').value, c.penalNivelPalet), 0, 20);
  var a = clamp(num($('#a-abc-a').value, 80), 10, 98) / 100, b = clamp(num($('#a-abc-b').value, 95), 20, 99.9) / 100;
  if (b <= a) b = Math.min(0.999, a + 0.05);
  c.abc = { a: a, b: b };
}
async function asignar() {
  var pre = prerrequisitos();
  if (pre.length) { aviso('Todavía falta: ' + pre.join(', ') + '.', 'warn'); return; }
  if (S.ocupado) return;
  var pd = problemasDatos();
  if (pd.total) {
    var seguir = await preguntar('Hay datos de artículos con problemas',
      (pd.duplicados.length ? pd.duplicados.length + ' SKU repetido(s) (' + pd.duplicados.slice(0, 4).join(', ') + (pd.duplicados.length > 4 ? '…' : '') + '). ' : '') +
      (pd.invalidos.length ? pd.invalidos.length + ' fila(s) con datos inválidos. ' : '') +
      'El programa usa una sola fila por SKU e ignora las inválidas: esas quedarán SIN UBICAR y el resultado no las incluye. Lo recomendable es corregirlas primero en la pestaña Artículos.',
      [{ texto: 'Corregir primero', valor: 'corregir', primario: true }, { texto: 'Asignar igual', valor: 'seguir' }]);
    if (seguir === 'corregir') { irTab('articulos'); return; }
    if (seguir !== 'seguir') return;
  }
  var antes = snap();
  leerOpcionesAsignar();
  var cfg = S.proy.config;
  var res = await conEspera('Asignando ubicaciones…', function () { return M.asignar(S.proy, { pasadasMejora: cfg.pasadasMejora, fechaReferencia: fechaRefVenc(), usarPicksPico: cfg.dimensionarPor === 'maximo' }); });
  if (!res) return;
  pushUndo(antes);
  S.proy.resultado = protegerResultado(res);
  S.busqueda = null; S.posSel = null; S.moviendo = null; S.opcionesCambiadas = false;
  if (!S.rackElev && S.proy.racks.length) S.rackElev = S.proy.racks[0].id;
  tocar();
  trasCambio();
  var nsu = (res.sinUbicar || []).length;
  var mj = res.mejoraPct == null ? null : Number(res.mejoraPct);
  aviso('Asignación lista: ' + (mj === null ? 'mejora no comparable con «sin criterio»' : fmt(mj, 1) + ' % de mejora de costo frente a ubicar sin criterio') + (nsu ? ' · ' + nsu + ' SKU sin ubicar por completo' : '') + '.', nsu || mj === null ? 'warn' : 'ok', 7000);
}
function nombreClase(c) { return c === 'A' ? 'A · alta rotación' : c === 'B' ? 'B · media' : 'C · baja'; }
/* Causa por la que la mejora no es comparable (la entrega el motor; si no, se busca en sus advertencias). */
function causaNoComparable(res) {
  if (typeof res.mejoraNota === 'string' && res.mejoraNota) return res.mejoraNota;
  if (typeof res.mejoraCausa === 'string' && res.mejoraCausa) return res.mejoraCausa;
  var adv = (res.advertencias || []).filter(function (t) { return /mejora|compar/i.test(t); });
  return adv.length ? adv[0] : 'el conjunto de posiciones ubicadas cambia entre el reparto «sin criterio» y el asignado';
}
/* KPIs v1.1: cross-docking, dimensionado, reposición, afinidad y vencimientos. Cada bloque aparece solo si el motor lo entregó. */
function kpiV11HTML(res, k) {
  var h = '', filas = '';
  var dd = function (a, b) { return '<dt>' + a + '</dt><dd>' + b + '</dd>'; };
  if (typeof k.dimensionadoPor === 'string' && k.dimensionadoPor) filas += dd('Dimensionado por', k.dimensionadoPor === 'maximo' ? 'stock máximo del pico' : 'stock actual');
  if (k.skusCrossdock != null) filas += dd('SKU en cross-docking', fmt(N(k.skusCrossdock), 0) + ' (no ocupan rack' + (k.flujoCrossdock != null ? '; flujo ' + fmt(N(k.flujoCrossdock), 0) + ' palets/periodo' : '') + ')');
  var rp = k.reposicion;
  if (rp && typeof rp === 'object') {
    filas += dd('Picking / reserva', rp.activa ? 'activo · ' + fmt(N(rp.skusConPicking), 0) + ' SKU con posición de picking' : 'desactivado (se comporta como antes)');
    if (rp.activa) filas += dd('Reposiciones por periodo', fmt(N(rp.reposPorPeriodo), 1) + ' palets-equiv. · distancia media reserva→picking ' + (rp.distMediaReposicion == null ? '—' : fmt(N(rp.distMediaReposicion), 1) + ' m'));
  }
  var af = k.afinidad;
  if (af && typeof af === 'object') filas += dd('Afinidad', fmt(N(af.pares), 0) + ' pares con lift &gt; 1 · distancia media entre pares altos ' + (af.distMediaParesAltos == null ? '—' : fmt(N(af.distMediaParesAltos), 1) + ' m'));
  if (filas) h += '<dl class="kv" style="margin-top:6px">' + filas + '</dl>';
  var vs = Array.isArray(res.vencimientos) ? res.vencimientos : [];
  if (vs.length) {
    var marc = vs.map(function (v) { return { v: v, e: estadoVenc(v.vence) }; }).filter(function (x) { return x.e && x.e.t !== 'ok'; });
    marc.sort(function (a, b) { return a.e.d - b.e.d; });
    var nv = marc.filter(function (x) { return x.e.t === 'vencido'; }).length, np = marc.length - nv;
    h += '<div class="msg ' + (nv ? 'error' : np ? 'aviso' : 'ok') + '"><b>Vencimientos</b> (al ' + esc(fechaRefVenc()) + (S.proy.config.fechaReferencia ? '' : ', hoy') + '): ' + (nv ? '✕ ' + nv + ' vencido' + (nv === 1 ? '' : 's') : 'ningún lote vencido') +
      (S.proy.config.diasAlertaVencimiento != null ? ' · ▲ ' + np + ' por vencer (≤ ' + S.proy.config.diasAlertaVencimiento + ' d)' : ' · sin «días de alerta» no se marcan los por vencer (dato suyo)') + '.' +
      (marc.length ? '<ul class="limpia">' + marc.slice(0, 8).map(function (x) { return '<li><span class="venc-alerta ' + (x.e.t === 'vencido' ? 'venc' : 'pronto') + '">' + (x.e.t === 'vencido' ? '✕' : '▲') + ' ' + esc(x.v.sku) + ' · lote ' + esc(x.v.lote) + ' · ' + esc(x.v.vence) + ' — ' + esc(x.e.txt) + '</span></li>'; }).join('') + (marc.length > 8 ? '<li class="muted">… y ' + (marc.length - 8) + ' más.</li>' : '') + '</ul>' : '') + '</div>';
  }
  return h;
}
function kpiHTML(res) {
  var k = res.kpis || {}, b = res.baseline || {}, h = '';
  var mejora = res.mejoraPct == null || !isFinite(Number(res.mejoraPct)) ? null : Number(res.mejoraPct);
  // los picks se ponderan SOLO con lo ubicado
  var ubic = dic();
  Object.keys(res.porPosicion || {}).forEach(function (id) { ubic[res.porPosicion[id]] = true; });
  var picksUbic = S.proy.productos.reduce(function (s, q) { return s + (ubic[q.sku] ? N(q.picks) : 0); }, 0);
  var picksTot = S.proy.productos.reduce(function (s, q) { return s + N(q.picks); }, 0);
  var dBase = b.distMediaPonderada, dAct = k.distMediaPonderada;
  var ahorroM = (mejora !== null && dBase != null && dAct != null) ? (dBase - dAct) * picksUbic * 2 : null;
  if (res.modificadoManual) h += '<div class="msg aviso">Reparto <b>modificado a mano</b> después de asignar. Vuelve a pulsar «Asignar ubicaciones» para recalcular el mejor reparto.</div>';
  if (mejora === null) {
    h += '<div class="gran-numero" style="font-size:1.4rem" aria-label="Mejora no comparable">no comparable</div>' +
      '<div class="msg aviso peq">No se puede comparar con «sin criterio»: ' + esc(causaNoComparable(res)) + '.</div>';
  } else {
    h += '<div class="gran-numero' + (mejora < 0 ? ' neg' : '') + '" aria-label="Mejora de costo frente a ubicar sin criterio">' + fmt(mejora, 1) + ' %</div>' +
      '<div class="peq muted"><b>mejora de costo</b> (incluye la penalización de nivel) frente a ubicar <b>sin criterio</b>, no frente a su situación actual.<br>Referencia: ' + esc(b.descripcion || 'SKU en orden de ingreso sobre posiciones numeradas') + '</div>';
  }
  if (dBase != null && dAct != null) {
    var mx = Math.max(Number(dBase), Number(dAct), 1e-9);
    h += '<div style="margin-top:8px"><div class="peq">Sin criterio: <b>' + fmt(dBase, 1) + ' m</b>/pick</div><div class="barra-comp"><span style="width:' + N(Number(dBase) / mx * 100).toFixed(1) + '%;background:#8892a0"></span></div>' +
      '<div class="peq">Con esta asignación: <b>' + fmt(dAct, 1) + ' m</b>/pick</div><div class="barra-comp"><span style="width:' + N(Number(dAct) / mx * 100).toFixed(1) + '%;background:#2f9e6b"></span></div></div>';
  }
  if (ahorroM != null && picksUbic > 0) h += '<div class="peq">≈ <b>' + fmt(ahorroM, 0) + ' m</b> menos de caminata por periodo en lo ubicado (ida y vuelta, ' + fmt(picksUbic, 0) + ' de ' + fmt(picksTot, 0) + ' picks). Estimación del modelo, no una medición.</div>';
  h += '<dl class="kv" style="margin-top:8px">' +
    '<dt>Ocupación</dt><dd>' + fmt(k.ocupacionPct, 1) + ' % (' + (k.posicionesOcupadas != null ? esc(fmt(k.posicionesOcupadas, 0)) : '—') + ' / ' + (k.posicionesTotales != null ? esc(fmt(k.posicionesTotales, 0)) : '—') + ')</dd>' +
    '<dt>Distancia media por pick</dt><dd>' + fmt(dAct, 1) + ' m</dd>' +
    '<dt>Costo total (modelo)</dt><dd>' + fmt(k.costoTotal, 0) + ' m equivalentes <span class="muted">(no es dinero)</span></dd>' +
    '<dt>Costo «sin criterio»</dt><dd>' + fmt(b.costoTotal, 0) + ' m eq.</dd>' +
    '<dt>Picks de clase A en nivel 1</dt><dd>' + fmt(k.picksA_enNivel1Pct, 1) + ' %</dd>' +
    '<dt>Tiempo de cálculo</dt><dd>' + (k.tiempoMs != null ? fmt(k.tiempoMs, 0) + ' ms' : '—') + '</dd></dl>';
  h += kpiV11HTML(res, k);
  if (k.porClase) {
    h += '<table class="tabla-simple"><thead><tr><th>Clase</th><th class="n">SKU</th><th class="n">Posic.</th><th class="n">Dist. media</th></tr></thead><tbody>';
    ['A', 'B', 'C'].forEach(function (c) {
      var x = k.porClase[c]; if (!x) return;
      h += '<tr><td><span class="badge-abc ' + c + '">' + c + '</span></td><td class="n">' + (x.skus != null ? esc(fmt(x.skus, 0)) : '—') + '</td><td class="n">' + (x.posiciones != null ? esc(fmt(x.posiciones, 0)) : '—') + '</td><td class="n">' + (x.distMedia != null ? fmt(x.distMedia, 1) + ' m' : '—') + '</td></tr>';
    });
    h += '</tbody></table>';
  }
  return h;
}
/* «Cómo se decide»: refleja los pesos y cortes ABC realmente configurados. */
function comoSeDecideHTML() {
  var c = S.proy.config, pr = N(c.pesoRecepcion), pd = 1 - pr;
  var pa = Math.round(N(c.abc && c.abc.a) * 100), pb = Math.round(N(c.abc && c.abc.b) * 100);
  return '<ol class="lista-decide">' +
    '<li><b>Clasificación ABC</b> por picks (rotación): A ≈ primeros ' + pa + ' % de las salidas, B hasta ' + pb + ' %, C el resto (cortes configurados en Opciones).</li>' +
    '<li><b>Distancia real caminando</b> (rodeando racks, columnas y muros), desde las puertas de recepción y despacho. No es línea recta.</li>' +
    '<li><b>Costo de cada hueco</b> = picks × distancia de despacho × 2 (ida y vuelta) × <b>' + fmt(pd, 2) + '</b> (1 − peso de recepción) + entradas × distancia de recepción × 2 × <b>' + fmt(pr, 2) + '</b> (peso de recepción) + penalización por nivel de altura (' + fmt(N(c.penalNivelPalet), 1) + ' m equivalentes por nivel en palets; <b>[VERIFICAR ficha del equipo: velocidades de elevación]</b>).</li>' +
    '<li><b>Restricciones duras</b>: tipo de ubicación, carga máxima (valor por defecto; la real es la placa del fabricante), altura de carga, zonas (frío, peligrosos…) y familias incompatibles separadas.</li>' +
    '<li><b>Orden</b>: primero lo más restringido (zona, peso), luego mayor densidad picks/posiciones. Cada SKU se agrupa en un clúster compacto.</li>' +
    '<li><b>Mejora local</b>: intercambios de posiciones mientras bajen el costo. Es una <b>heurística</b>, no garantiza el óptimo.</li></ol>';
}
function refrescarAsignar() {
  var p = S.proy, res = p.resultado, pre = prerrequisitos();
  var est = $('#asig-estado'), btn = $('#btn-asignar');
  btn.disabled = pre.length > 0;
  if (pre.length) est.innerHTML = '<span class="chip warn">Falta</span> ' + esc(pre.join(', ')) + '.';
  else if (!res) est.innerHTML = '<span class="chip">Listo</span> Pulsa el botón para asignar.';
  else if (S.opcionesCambiadas) est.innerHTML = '<span class="chip warn">Opciones cambiadas</span> Vuelve a asignar para aplicarlas.';
  else est.innerHTML = '<span class="chip ok">Asignado</span> ' + esc(res.generadoEn && !isNaN(Date.parse(res.generadoEn)) ? new Date(res.generadoEn).toLocaleString('es-PE') : 'Fecha de referencia: ' + fechaRefVenc());   // B-2: el motor puede dejar generadoEn en null
  var cd = $('#como-lista'); if (cd) cd.innerHTML = comoSeDecideHTML();
  $('#kpis').innerHTML = cajaProblemasDatos() + (res ? kpiHTML(res) : '<p class="peq muted">Todavía no hay asignación. Completa los pasos 1 a 3 y pulsa <b>«Asignar ubicaciones»</b>.</p>');
  // no ubicados
  var nu = $('#no-ubicados');
  if (!res) nu.innerHTML = '—';
  else if (!(res.sinUbicar || []).length && !problemasDatos().total) nu.innerHTML = '<span class="chip ok">Todos los artículos tienen ubicación</span>';
  else {
    var pdn = problemasDatos();
    nu.innerHTML = ((res.sinUbicar || []).length ? '<table class="tabla-simple"><thead><tr><th>SKU</th><th class="n">Faltan</th><th>Motivo</th></tr></thead><tbody>' +
      res.sinUbicar.map(function (u) { return '<tr><td>' + esc(u.sku) + '</td><td class="n">' + esc(u.faltan) + '</td><td>' + (NOMBRES_MOTIVO[u.motivo] ? esc(NOMBRES_MOTIVO[u.motivo]) + ' <span class="muted">(' + esc(u.motivo) + ')</span>' : esc(u.motivo)) + (u.detalle ? '<br><span class="muted">' + esc(u.detalle) + '</span>' : '') + '</td></tr>'; }).join('') + '</tbody></table>'
      : '<span class="chip ok">Ningún SKU válido quedó sin ubicar</span>') +
      (pdn.total ? '<div class="msg aviso" style="margin-top:6px"><b>' + pdn.total + ' fila(s)/SKU con datos duplicados o inválidos no se ubicaron</b> (ver el aviso rojo arriba). No se puede decir que todos los artículos tienen ubicación.</div>' : '');
  }
  // supuestos
  var sp = $('#supuestos'), h = '';
  if (res) {
    if ((res.advertencias || []).length) h += res.advertencias.map(function (a) { return '<div class="msg aviso">' + esc(a) + '</div>'; }).join('');
    h += '<ul class="peq" style="padding-left:1.1rem;margin:.3rem 0">' + (res.supuestos || []).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>';
    h += '<p class="peq aviso-honesto">Heurística: no garantiza el óptimo. Propuesta a validar por el responsable de almacén (rociadores, pasillo real del equipo). La resistencia del piso, el anclaje sísmico y la losa <b>no se calculan</b>: verificar con el ingeniero estructural.</p>';
  } else h = '—';
  sp.innerHTML = h;
  refrescarElevacion();
  refrescarAsignarDetalle();
}

/* ---- vencimientos (v1.1): la fecha de referencia es de la config; por defecto, hoy (solo la UI lee el reloj) ---- */
function fechaRefVenc() { return S.proy.config.fechaReferencia || ymdHoy(); }
function diasHasta(vence, ref) { return Math.round((Date.parse(vence + 'T00:00:00Z') - Date.parse(ref + 'T00:00:00Z')) / 864e5); }
function estadoVenc(vence) {
  if (!ymdValido(vence)) return null;
  var d = diasHasta(vence, fechaRefVenc()), al = S.proy.config.diasAlertaVencimiento;
  if (d < 0) return { t: 'vencido', d: d, txt: 'VENCIDO hace ' + (-d) + ' d' };
  if (al != null && d <= al) return { t: 'pronto', d: d, txt: 'vence en ' + d + ' d (≤ ' + al + ' d de su alerta)' };
  return { t: 'ok', d: d, txt: 'vence en ' + d + ' d' };
}

/* ---- elevación frontal ---- */
function colorPosicion(sku) {
  if (!sku) return null;
  var a = mapaABC()[sku];
  return COLOR_ABC[a ? a.clase : 'C'];
}
function refrescarElevacion() {
  var cvE = $('#canvas-elev');
  var id = S.rackHover || S.rackElev;
  var r = id ? S.proy.racks.filter(function (x) { return x.id === id; })[0] : null;
  var tit = $('#elev-titulo');
  var cssW = cvE.parentNode.clientWidth - 24;
  if (cssW < 120) cssW = 300;
  var dpr = window.devicePixelRatio || 1;
  S.elevHit = [];
  if (!r) {
    tit.textContent = 'Pasa el mouse o haz clic sobre un rack del plano.';
    cvE.width = Math.round(cssW * dpr); cvE.height = Math.round(60 * dpr);
    var g0 = cvE.getContext('2d'); g0.setTransform(dpr, 0, 0, dpr, 0, 0); g0.clearRect(0, 0, cssW, 60);
    return;
  }
  var res = S.proy.resultado, por = res && res.porPosicion ? res.porPosicion : {};
  var posR = posPorRack()[r.id] || [];
  var N = Math.max(1, Math.min(30, Math.round(Number(r.niveles)) || 1)), MO = Math.max(1, Math.min(1000, Math.round(Number(r.modulos)) || 1)), K = Math.max(1, Math.min(20, Math.round(Number(r.slotsPorModulo)) || 1));
  var padL = 26, padT = 18, padB = 14, cellH = 30, cellW = (cssW - padL - 6) / MO;
  var cssH = padT + N * cellH + padB;
  cvE.width = Math.round(cssW * dpr); cvE.height = Math.round(cssH * dpr);
  var g = cvE.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  var pal = paletaActual();
  g.clearRect(0, 0, cssW, cssH);
  var espejo = r.frente !== 'B';   // frente A: quien mira desde el pasillo ve el módulo 1 a su DERECHA (el eje x local queda invertido)
  var rolPos = res && res.rolPorPosicion ? res.rolPorPosicion : {}, lotePos = res && res.lotePorPosicion ? res.lotePorPosicion : {};
  tit.innerHTML = '<b>' + esc(r.nombre) + '</b> · frente ' + esc(r.frente) + ' · ' + MO + ' módulos × ' + N + ' niveles × ' + K + ' pos. (vista desde el pasillo' + (espejo ? ', espejada: el módulo 1 queda a la derecha' : ': el módulo 1 queda a la izquierda') + ')' + (S.rackHover && S.rackHover !== S.rackElev ? ' <span class="chip">vista previa</span>' : '');
  g.font = '10px system-ui,sans-serif'; g.textBaseline = 'middle';
  var idx = {};
  posR.forEach(function (q) { idx[q.modulo + '|' + q.nivel + '|' + (q.slot || 1)] = q; });
  var bus = S.busqueda && res ? S.busqueda.sku : null;
  var mo, ni, sl;
  for (mo = 1; mo <= MO; mo++) {
    g.fillStyle = pal.texto; g.textAlign = 'center';
    g.fillText(String(mo), padL + ((espejo ? MO - mo : mo - 1) + 0.5) * cellW, padT - 8);
  }
  for (ni = 1; ni <= N; ni++) {
    var y = padT + (N - ni) * cellH;
    g.fillStyle = pal.texto; g.textAlign = 'right';
    g.fillText('N' + ni, padL - 4, y + cellH / 2);
    for (mo = 1; mo <= MO; mo++) {
      for (sl = 1; sl <= K; sl++) {
        var q = idx[mo + '|' + ni + '|' + sl];
        var x = padL + (espejo ? MO - mo : mo - 1) * cellW + (espejo ? K - sl : sl - 1) * cellW / K, w = cellW / K;
        var sku = q ? por[q.id] : null;
        var col = colorPosicion(sku);
        g.fillStyle = col || pal.vacioCol;
        g.fillRect(x + 1, y + 1, w - 2, cellH - 2);
        if (sku) {
          var a = mapaABC()[sku], pt = crearPatrones(g);
          var patt = a && a.clase === 'A' ? pt.A : a && a.clase === 'B' ? pt.B : null;
          if (patt) { g.fillStyle = patt; g.fillRect(x + 1, y + 1, w - 2, cellH - 2); }
        }
        var esBus = bus && sku === bus, esSel = q && S.posSel === q.id, esMov = q && S.moviendo === q.id;
        g.lineWidth = esSel || esMov || esBus ? 3 : 1;
        g.strokeStyle = esMov ? pal.error : esSel ? pal.sel : esBus ? '#c026d3' : pal.rackBorde;
        if (esMov) g.setLineDash([4, 3]);
        g.strokeRect(x + 1.5, y + 1.5, w - 3, cellH - 3);
        g.setLineDash([]);
        if (sku && w > 22) {
          g.fillStyle = '#111'; g.textAlign = 'center';
          var cl = (mapaABC()[sku] || {}).clase || '';
          var txt = sku, maxw = w - 6;
          g.font = '600 10px system-ui,sans-serif';
          while (txt.length > 2 && g.measureText(txt).width > maxw) txt = txt.slice(0, -2);
          if (txt !== sku) txt += '…';
          g.lineWidth = 3; g.strokeStyle = 'rgba(255,255,255,.85)'; g.strokeText(txt, x + w / 2, y + cellH / 2 - 5); g.fillText(txt, x + w / 2, y + cellH / 2 - 5);
          g.font = '700 9px system-ui,sans-serif';
          var rol = rolPos[q.id], lt = lotePos[q.id];
          var l2 = cl + (w > 40 && rol ? (rol === 'picking' ? ' · PICK' : ' · RES') : '') + (w > 56 && lt && lt.lote ? ' · ' + String(lt.lote).slice(0, 6) : '');
          g.strokeText(l2, x + w / 2, y + cellH / 2 + 8); g.fillText(l2, x + w / 2, y + cellH / 2 + 8);
          g.font = '10px system-ui,sans-serif';
        }
        if (q && sku && rolPos[q.id]) {   // marca de rol en la esquina: P = picking, R = reserva
          g.font = '700 9px system-ui,sans-serif'; g.textAlign = 'left'; g.fillStyle = rolPos[q.id] === 'picking' ? '#0b5d2a' : '#5a3a00';
          g.fillText(rolPos[q.id] === 'picking' ? 'P' : 'R', x + 3, y + 6); g.font = '10px system-ui,sans-serif';
        }
        if (q && sku && lotePos[q.id] && lotePos[q.id].vence) {   // alerta de vencimiento: icono + texto en el detalle
          var ev = estadoVenc(lotePos[q.id].vence);
          if (ev && ev.t !== 'ok') {
            var ax = x + w - 8, ay = y + 8;
            g.beginPath(); g.fillStyle = ev.t === 'vencido' ? '#c0262d' : '#d98a00';
            if (ev.t === 'vencido') { g.arc(ax, ay, 6, 0, 6.2832); } else { g.moveTo(ax, ay - 6); g.lineTo(ax + 6.5, ay + 5); g.lineTo(ax - 6.5, ay + 5); g.closePath(); }
            g.fill(); g.fillStyle = '#fff'; g.font = '700 9px system-ui,sans-serif'; g.textAlign = 'center'; g.fillText(ev.t === 'vencido' ? '×' : '!', ax, ay + (ev.t === 'vencido' ? 0.5 : 2)); g.font = '10px system-ui,sans-serif';
          }
        }
        if (q) S.elevHit.push({ x: x, y: y, w: w, h: cellH, id: q.id });
      }
    }
  }
  g.strokeStyle = pal.texto; g.lineWidth = 2; g.beginPath(); g.moveTo(padL, padT + N * cellH + 2); g.lineTo(cssW - 4, padT + N * cellH + 2); g.stroke();
  var ley = $('#elev-leyenda');
  if (ley) ley.textContent = (Object.keys(rolPos).length ? 'P = picking · R = reserva · ' : '') + (Object.keys(lotePos).length ? '● × vencido · ▲ ! por vencer (según su fecha de referencia y días de alerta; el detalle dice el texto) · ' : '') + (r.tipo === 'piso' ? 'carril de piso: ' + (r.profundidadPalets || 1) + ' en profundidad × ' + (r.apilado || 1) + ' apilados · ' : '') + 'letra A/B/C = clase ABC';
}
function clicElevacion(e) {
  var r = $('#canvas-elev').getBoundingClientRect();
  var sx = (e.clientX - r.left) * ($('#canvas-elev').width / (window.devicePixelRatio || 1)) / r.width;
  var sy = (e.clientY - r.top) * ($('#canvas-elev').height / (window.devicePixelRatio || 1)) / r.height;
  var hit = (S.elevHit || []).filter(function (c) { return sx >= c.x && sx <= c.x + c.w && sy >= c.y && sy <= c.y + c.h; })[0];
  if (!hit) return;
  if (S.moviendo && S.proy.resultado) {
    var org = S.moviendo;
    if (org === hit.id) { S.moviendo = null; refrescarAsignarDetalle(); refrescarElevacion(); return; }
    moverManual(org, hit.id);
    return;
  }
  seleccionarPosicion(hit.id);
}
function seleccionarPosicion(id) {
  S.posSel = id;
  var ps = posPorId()[id];
  if (ps && ps.rackId && !S.rackHover) S.rackElev = ps.rackId;
  refrescarElevacion();
  refrescarAsignarDetalle();
  pedirDibujo();
  if (!distListo() && S.proy.resultado) {
    conEspera('Calculando distancias caminando…', function () { getDist(); }).then(function () { refrescarAsignarDetalle(); pedirDibujo(); });
  }
}
function refrescarAsignarDetalle() {
  var d = $('#pos-detalle'), res = S.proy.resultado, h = '';
  var bi = $('#busqueda-info'), bq = S.busqueda;
  $('#btn-limpiar-busqueda').hidden = !bq;
  if (bq && res) bi.innerHTML = bq.html;
  if (S.moviendo) {
    var po = posPorId()[S.moviendo];
    h += '<div class="msg info"><b>Mover SKU ' + esc(res && res.porPosicion[S.moviendo]) + '</b> desde ' + esc(S.moviendo) + '.<br>Haz clic en el hueco de destino en la elevación (si está ocupado, se intercambian). Para cambiar de rack, selecciónalo en el plano.' +
      '<br><button type="button" class="btn peq-btn" data-acc-pos="cancelar-mover">Cancelar movimiento</button></div>';
  }
  var id = S.posSel;
  if (id) {
    var ps = posPorId()[id];
    if (!ps) { d.innerHTML = h; return; }
    var sku = res && res.porPosicion ? res.porPosicion[id] : null;
    var pr2 = sku ? productoPorSku()[sku] : null;
    var di = distPos(id);
    h += '<dl class="kv"><dt>Ubicación</dt><dd>' + esc(id) + '</dd><dt>Rack / nivel</dt><dd>' + esc(ps.rackNombre) + ' / N' + esc(ps.nivel) + '</dd>' +
      '<dt>Tipo · zona</dt><dd>' + esc(ps.tipo) + ' · ' + esc(NOMBRES_ZONA[ps.zonaTipo] || ps.zonaTipo) + '</dd>' +
      '<dt>Carga máx. / altura</dt><dd>' + fmt(ps.cargaMaxKg, 0) + ' kg / ' + fmt(ps.alturaM, 2) + ' m</dd>';
    if (di) h += '<dt>Distancia desde despacho</dt><dd>' + (isFinite(di.dDesp) ? fmt(di.dDesp, 1) + ' m' : 'inaccesible') + '</dd><dt>Distancia desde recepción</dt><dd>' + (isFinite(di.dRec) ? fmt(di.dRec, 1) + ' m' : 'inaccesible') + '</dd>';
    else if (S.proy.resultado) h += '<dt>Distancias</dt><dd class="muted">calculando…</dd>';
    var rolD = res && res.rolPorPosicion ? res.rolPorPosicion[id] : null, loteD = res && res.lotePorPosicion ? res.lotePorPosicion[id] : null;
    if (rolD) h += '<dt>Rol</dt><dd>' + (rolD === 'picking' ? 'picking (se toma de aquí)' : 'reserva (repone al picking)') + '</dd>';
    if (ps.lifo === true) h += '<dt>Acceso</dt><dd>LIFO (el último en entrar sale primero)</dd>';
    if (loteD) {
      var evD = estadoVenc(loteD.vence);
      h += '<dt>Lote</dt><dd>' + esc(loteD.lote || '—') + ' · ' + fmt(N(loteD.cantidad), 0) + ' unid.</dd><dt>Vence</dt><dd>' + (loteD.vence ? esc(loteD.vence) + (evD ? ' · <span class="venc-alerta ' + (evD.t === 'vencido' ? 'venc' : evD.t === 'pronto' ? 'pronto' : '') + '">' + (evD.t === 'vencido' ? '✕ ' : evD.t === 'pronto' ? '▲ ' : '') + esc(evD.txt) + '</span>' : '') : 'sin fecha (sale al final)') + '</dd>';
    }
    h += '</dl>';
    if (sku && pr2) {
      var cl = (mapaABC()[sku] || {}).clase;
      h += '<div><span class="badge-abc ' + esc(cl) + '">' + esc(cl) + '</span> <b>' + esc(sku) + '</b> ' + esc(pr2.descripcion || '') + '<br><span class="muted">' + fmt(pr2.picks, 0) + ' picks · familia ' + esc(pr2.familia || '—') + '</span></div>' +
        '<div class="fila-inp"><button type="button" class="btn" data-acc-pos="mover">Mover este SKU a mano…</button><button type="button" class="btn" data-acc-pos="buscar">Resaltar y ver ruta</button></div>';
    } else if (res) h += '<div class="muted">Hueco libre.</div>';
  } else if (res && !S.moviendo) {
    h += '<p class="muted">Haz clic en un hueco de la elevación para ver su detalle o mover un SKU a mano.</p>';
  }
  d.innerHTML = h;
}

/* ---- mover a mano ---- */
function reconstruirAsignaciones(mapa, previo) {
  var por = dic(), prods = productoPorSku(), abc = mapaABC();
  Object.keys(mapa).forEach(function (id) { (por[mapa[id]] = por[mapa[id]] || []).push(id); });
  var prev = dic();
  (previo || []).forEach(function (a) { prev[a.sku] = a; });
  return Object.keys(por).map(function (sku) {
    var a = prev[sku] || {};
    return Object.assign({}, a, { sku: sku, clase: (abc[sku] || {}).clase || a.clase, posReq: prods[sku] ? posReq(prods[sku]) : a.posReq, posiciones: por[sku] });
  });
}
function moverManual(origen, destino) {
  var res = S.proy.resultado;
  if (!res) return;
  var mapa = Object.assign(dic(), res.porPosicion);
  var sku = mapa[origen], otro = mapa[destino];
  if (!sku) { aviso('El origen no tiene un SKU.', 'warn'); return; }
  var ps = posPorId(), po = ps[origen], pd = ps[destino];
  var antesK = res.kpis || {};
  if (otro) mapa[origen] = otro; else delete mapa[origen];
  mapa[destino] = sku;
  var ev;
  try { ev = M.evaluarAsignacionManual(S.proy, mapa); } catch (e) { aviso('No se pudo evaluar el movimiento: ' + e.message, 'error'); return; }
  if (!ev) { aviso('El motor no devolvió resultado para el movimiento.', 'error'); return; }
  var antes = snap();
  var nuevo = Object.assign({}, res, ev);
  nuevo.porPosicion = Object.assign(dic(), ev.porPosicion || mapa);
  nuevo.asignaciones = ev.asignaciones || reconstruirAsignaciones(mapa, res.asignaciones);
  nuevo.baseline = ev.baseline || res.baseline;
  nuevo.sinUbicar = ev.sinUbicar || res.sinUbicar;
  nuevo.supuestos = ev.supuestos || res.supuestos;
  nuevo.kpis = Object.assign({}, res.kpis, ev.kpis || {});
  if (ev.mejoraPct === undefined && nuevo.baseline && nuevo.baseline.costoTotal) {   // null = «no comparable» (lo decide el motor)
    nuevo.mejoraPct = (nuevo.baseline.costoTotal - nuevo.kpis.costoTotal) / nuevo.baseline.costoTotal * 100;
  }
  if (ev.mejoraNota !== undefined) nuevo.mejoraNota = ev.mejoraNota; else if (ev.mejoraCausa !== undefined) nuevo.mejoraCausa = ev.mejoraCausa;
  nuevo.advertencias = (ev.advertencias || []).slice();
  nuevo.modificadoManual = true;
  pushUndo(antes);
  S.proy.resultado = nuevo;
  S.moviendo = null; S.posSel = destino;
  tocar();
  var dk = (nuevo.kpis.costoTotal || 0) - (antesK.costoTotal || 0);
  trasCambioSinInvalidar();
  var msg = 'SKU ' + sku + ' movido a ' + destino + (otro ? ' (intercambiado: ' + otro + ' pasa a ' + origen + ')' : '') + '. Costo total (m equivalentes, no es dinero): ' + fmt(antesK.costoTotal, 0) + ' → ' + fmt(nuevo.kpis.costoTotal, 0) + ' (' + (dk >= 0 ? '+' : '') + fmt(dk, 0) + '); mejora de costo vs «sin criterio»: ' + (nuevo.mejoraPct == null ? 'no comparable' : fmt(Number(nuevo.mejoraPct), 1) + ' %') + '.';
  aviso(msg, dk > 0 ? 'warn' : 'ok', 9000);
  if (nuevo.advertencias.length) aviso(nuevo.advertencias.slice(0, 2).join(' '), 'warn', 9000);
}
function trasCambioSinInvalidar() { trasCambio(); }

/* ---- búsqueda y ruta ---- */
function mallaMotor() {
  return cache('mallaM', sigGeom(), function () { return M.construirMalla(S.proy); });
}
function campoPuerta(d, malla) {
  return cache('campo|' + d.id, sigGeom(), function () { return M.distanciasDesde(malla, [[d.x, d.y]]); });
}
function celdaCercana(m, x, y, maxM) {
  var ci = clamp(Math.floor((x - m.x0) / m.celda), 0, m.nx - 1), cj = clamp(Math.floor((y - m.y0) / m.celda), 0, m.ny - 1);
  var rmax = Math.ceil((maxM || 3) / m.celda) + 1, best = -1, bd = Infinity, r, di, dj;
  for (r = 0; r <= rmax && best < 0; r++) {
    for (dj = -r; dj <= r; dj++) for (di = -r; di <= r; di++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
      var i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= m.nx || j >= m.ny || !m.caminable[j * m.nx + i]) continue;
      var d = Math.hypot(m.x0 + (i + .5) * m.celda - x, m.y0 + (j + .5) * m.celda - y);
      if (d < bd) { bd = d; best = j * m.nx + i; }
    }
  }
  return best;
}
/* Ruta caminada: descenso por el campo de distancias del motor (distanciasDesde) desde el destino hasta la puerta. */
function rutaPorCampo(m, campo, puerta, destino) {
  var t = celdaCercana(m, destino[0], destino[1], 3);
  if (t < 0 || !isFinite(campo[t])) return null;
  var D = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  var pts = [[destino[0], destino[1]]], cur = t, guard = m.nx * m.ny;
  while (guard-- > 0) {
    var ui = cur % m.nx, uj = (cur - ui) / m.nx;
    pts.push([m.x0 + (ui + .5) * m.celda, m.y0 + (uj + .5) * m.celda]);
    var best = -1, bv = campo[cur];
    for (var q = 0; q < 8; q++) {
      var vi = ui + D[q][0], vj = uj + D[q][1];
      if (vi < 0 || vj < 0 || vi >= m.nx || vj >= m.ny) continue;
      var v = vj * m.nx + vi;
      if (!m.caminable[v]) continue;
      if (D[q][0] && D[q][1] && (!m.caminable[uj * m.nx + vi] || !m.caminable[vj * m.nx + ui])) continue;
      var val = campo[v] + D[q][2] * m.celda;
      if (campo[v] < campo[cur] && val < bv + 1e-4 && (best < 0 || val < bv)) { bv = val; best = v; }
    }
    if (best < 0) break;
    cur = best;
  }
  pts.push([puerta.x, puerta.y]);
  pts.reverse();
  var out = [pts[0]], i2;
  for (i2 = 1; i2 < pts.length - 1; i2++) {
    var p0 = out[out.length - 1], p1 = pts[i2], p2 = pts[i2 + 1];
    var cr = (p1[0] - p0[0]) * (p2[1] - p1[1]) - (p1[1] - p0[1]) * (p2[0] - p1[0]);
    if (Math.abs(cr) > 1e-6) out.push(p1);
  }
  out.push(pts[pts.length - 1]);
  var largo = 0;
  for (i2 = 1; i2 < out.length; i2++) largo += Math.hypot(out[i2][0] - out[i2 - 1][0], out[i2][1] - out[i2 - 1][1]);
  return { puntos: out, largo: largo, motor: campo[t] };
}
function mejorRuta(puertas, destino) {
  var m = mallaMotor(), mejor = null;
  puertas.forEach(function (d) {
    var campo = campoPuerta(d, m);
    var t = celdaCercana(m, destino[0], destino[1], 3);
    if (t < 0 || !isFinite(campo[t])) return;
    if (!mejor || campo[t] < mejor.v) mejor = { v: campo[t], d: d, campo: campo };
  });
  if (!mejor) return null;
  var r = rutaPorCampo(m, mejor.campo, mejor.d, destino);
  if (r) r.puerta = mejor.d;
  return r;
}
function puertasPara(tipo) {
  var ps = puertasOperativas();
  var l = ps.filter(function (d) { return d.tipo === tipo || d.tipo === 'mixta'; });
  return l.length ? l : ps;
}
async function buscarSku(skuDirecto) {
  var q = (skuDirecto || $('#inp-sku').value).trim();
  var bi = $('#busqueda-info');
  if (!q) { bi.innerHTML = '<span class="muted">Escribe un SKU para buscarlo.</span>'; return; }
  var res = S.proy.resultado;
  if (!res) { aviso('Primero asigna ubicaciones.', 'warn'); return; }
  var ql = q.toLowerCase(), prods = S.proy.productos;
  var pr = prods.filter(function (x) { return String(x.sku).toLowerCase() === ql; })[0] ||
    prods.filter(function (x) { return String(x.sku).toLowerCase().indexOf(ql) === 0; })[0] ||
    prods.filter(function (x) { return String(x.sku).toLowerCase().indexOf(ql) >= 0 || String(x.descripcion || '').toLowerCase().indexOf(ql) >= 0; })[0];
  if (!pr) { S.busqueda = null; bi.innerHTML = '<span class="chip warn">No encontrado</span> No hay un artículo que coincida con «' + esc(q) + '».'; refrescarAsignarDetalle(); pedirDibujo(); return; }
  var posIds = Object.keys(res.porPosicion).filter(function (id) { return res.porPosicion[id] === pr.sku; });
  if (!posIds.length) {
    var su = (res.sinUbicar || []).filter(function (u) { return u.sku === pr.sku; })[0];
    S.busqueda = null;
    bi.innerHTML = '<span class="chip err">Sin ubicación</span> ' + esc(pr.sku) + ' no quedó ubicado' + (su ? ': ' + esc(su.motivo) + ' (faltan ' + esc(su.faltan) + ' posiciones)' : '') + '.';
    refrescarAsignarDetalle(); pedirDibujo(); return;
  }
  $('#inp-sku').value = pr.sku;
  var datos = await conEspera('Calculando ruta caminando…', function () {
    var dist = getDist();
    var cand = posIds.map(function (id) { return dist.porId[id]; }).filter(Boolean);
    cand.sort(function (a, b) { return (a.dDesp - b.dDesp) || (a.id < b.id ? -1 : 1); });
    var mejor = cand[0] || posPorId()[posIds[0]];
    var dest = [mejor.ax != null ? mejor.ax : mejor.cx, mejor.ay != null ? mejor.ay : mejor.cy];
    var rd = mejorRuta(puertasPara('despacho'), dest), rr = mejorRuta(puertasPara('recepcion'), dest);
    return { mejor: mejor, rd: rd, rr: rr };
  });
  if (!datos) return;
  var a = mapaABC()[pr.sku] || {};
  var html = '<span class="badge-abc ' + esc(a.clase || 'C') + '">' + esc(a.clase || 'C') + '</span> <b>' + esc(pr.sku) + '</b> · ' + posIds.length + (posIds.length === 1 ? ' posición' : ' posiciones') + '.<br>' +
    'Mejor posición: <b>' + esc(datos.mejor.id) + '</b>.';
  if (datos.rd) html += '<br><span style="color:#c026d3;font-weight:700">━</span> Ruta desde ' + esc(datos.rd.puerta.nombre) + ' (despacho): <b>' + fmt(datos.rd.largo, 1) + ' m</b>';
  if (datos.mejor.dDesp != null && isFinite(datos.mejor.dDesp)) html += ' <span class="muted">(motor: ' + fmt(datos.mejor.dDesp, 1) + ' m)</span>';
  if (datos.rr && (!datos.rd || datos.rr.puerta.id !== datos.rd.puerta.id)) html += '<br><span style="color:#1f9d55;font-weight:700">┅</span> Desde ' + esc(datos.rr.puerta.nombre) + ' (recepción): <b>' + fmt(datos.rr.largo, 1) + ' m</b>';
  if (!datos.rd) html += '<br><span class="chip warn">No se pudo trazar la ruta</span> revisa que haya puertas y pasillos conectados.';
  S.busqueda = { sku: pr.sku, posIds: posIds, ruta: datos.rd ? datos.rd.puntos : null, rutaRec: datos.rr ? datos.rr.puntos : null, html: html };
  bi.innerHTML = html;
  // llevar la vista al rack encontrado
  var ps = posPorId()[datos.mejor.id];
  if (ps) { S.rackElev = ps.rackId; S.posSel = ps.id; }
  refrescarElevacion(); refrescarAsignarDetalle(); pedirDibujo();
}
function limpiarBusqueda() {
  S.busqueda = null;
  $('#busqueda-info').innerHTML = '';
  $('#inp-sku').value = '';
  refrescarAsignarDetalle(); refrescarElevacion(); pedirDibujo();
}

/* ------------------------------------------------------------------ Análisis (espacio, capacidad, movimiento, escenarios) */
var AA = window.AlmacenAnalisis;
var EST_AN = { ok: ['✓', 'OK'], atencion: ['⚠', 'Atención'], critico: ['✖', 'Crítico'], info: ['ℹ', 'Info'] };
var PRIO_AN = { 1: 'Alta', 2: 'Media', 3: 'Baja' };
var COL_AREA = { racks: '#3b82f6', circ: '#22a06b', libre: '#f2a516', huecos: '#8b95a5', otro: '#c4ccd8' };
function estAn(e) { return EST_AN[e] ? e : 'info'; }
function fmtVal(v) {
  if (v == null || typeof v !== 'number' || !isFinite(v)) return '—';
  var av = Math.abs(v), d = v % 1 === 0 ? 0 : av >= 10 ? 1 : av >= 1 ? 2 : 3;
  return fmt(v, d);
}
function fmtSigno(v, d, suf) {
  if (v == null || typeof v !== 'number' || !isFinite(v)) return '—';
  return (v > 0 ? '+' : '') + fmt(v, d) + (suf || '');
}
function refAn(r) {
  if (!r) return '';
  if (typeof r === 'string') return esc(r);
  return esc(r.texto || '') + (r.nivel ? ' <b class="ref-n">' + esc(r.nivel) + '</b>' : '');
}
function tarjetaMetrica(m) {
  m = m || {};
  var e = estAn(m.estado), ic = EST_AN[e], tv = typeof m.valor === 'number' && isFinite(m.valor);
  return '<article class="an-card est-' + e + '"><header><h4>' + esc(m.nombre) + '</h4><span class="an-est est-' + e + '"><span aria-hidden="true">' + ic[0] + '</span> ' + ic[1] + '</span></header>' +
    '<div class="an-valor">' + (!tv && /ahorr/i.test(String(m.id) + ' ' + String(m.nombre)) ? '<span style="font-size:1rem">no comparable</span>' : esc(fmtVal(m.valor)) + (tv && m.unidad ? ' <small>' + esc(m.unidad) + '</small>' : '')) + '</div>' +
    (m.lectura ? '<p class="peq an-lect">' + (!tv && /ahorr/i.test(String(m.id) + ' ' + String(m.nombre)) ? '<b>Causa:</b> ' : '') + esc(m.lectura) + '</p>' : '') +
    '<details><summary>Ver cálculo</summary><dl class="an-calc">' +
    (m.formula ? '<dt>Fórmula</dt><dd><code>' + esc(m.formula) + '</code></dd>' : '') +
    (m.sustitucion ? '<dt>Con sus números</dt><dd><code>' + esc(m.sustitucion) + '</code></dd>' : '') +
    (m.lectura ? '<dt>Lectura</dt><dd>' + esc(m.lectura) + '</dd>' : '') +
    (m.referencia ? '<dt>Referencia</dt><dd>' + refAn(m.referencia) + '</dd>' : '') +
    '</dl></details></article>';
}
function faltaAnalisis() {
  var p = S.proy, f = [];
  if (p.contorno.length < 3) f.push('contorno (paso 1)');
  if (!p.racks.length) f.push('racks (paso 2)');
  return f;
}
function leerOpcionesAnalisis(notas) {
  var vv = function (id) { var t = String($('#' + id).value).trim(); return t === '' ? null : num(t, null); };
  var op = {};
  var vel = vv('an-vel'); if (vel !== null) op.velocidadMs = acotar(vel, 0.1, 10, 1.5, 'Velocidad (m/s)', notas);
  var seg = vv('an-seg'); if (seg !== null) op.segPorPick = acotar(seg, 0, 600, 30, 'Segundos por pick', notas);
  var per = vv('an-periodo'); op.periodoDias = per === null ? 30 : acotar(per, 1, 366, 30, 'Periodo (días)', notas);
  var cos = vv('an-costo'); if (cos !== null && cos > 0) op.costoHora = acotar(cos, 0.01, 1e6, 1, 'Costo por hora', notas);
  var cre = vv('an-crec'); if (cre !== null) op.crecimientoPct = acotar(cre, -90, 500, 0, 'Crecimiento %', notas);
  var oc = vv('an-ocup'); op.ocupacionObjetivo = (oc === null ? 85 : acotar(oc, 30, 100, 85, 'Ocupación objetivo %', notas)) / 100;
  op.escenarios = $('#an-escenarios').checked;
  op.fechaReferencia = fechaRefVenc();   // B-1: la misma fecha que usa Asignar (por defecto, hoy)
  return op;
}
async function calcularAnalisis() {
  if (S.ocupado) return;
  if (!AA) { aviso('No se cargó analisis.js.', 'error'); return; }
  var falta = faltaAnalisis();
  if (falta.length) { aviso('Falta: ' + falta.join(', ') + '.', 'warn'); return; }
  var notas = [];
  var op = leerOpcionesAnalisis(notas);
  if (notas.length) aviso('Se ajustaron valores fuera de rango: ' + notas.join('; ') + '.', 'warn', 9000);
  S.ocupado = true;
  var btn = $('#an-calcular'), est = $('#an-estado');
  btn.disabled = true;
  est.innerHTML = '<span class="spinner" aria-hidden="true"></span> <b>Calculando…</b> ' + (op.escenarios ? 'con escenarios: tarda unos segundos.' : '');
  await esperar(80);   // cede al navegador para que pinte «Calculando…»
  try {
    var t0 = performance.now();
    var res = AA.analizar(S.proy, op);
    S.analisis = { res: res, ver: S.ver, op: op, ms: Math.round(performance.now() - t0), conEsc: !!op.escenarios };
  } catch (e) {
    console.error(e);
    S.analisis = null;
    aviso('No se pudo calcular el análisis: ' + e.message, 'error', 9000);
  } finally {
    S.ocupado = false; btn.disabled = false;
  }
  renderAnalisis();
  refrescarPasos();
}
function dibujarAreas(an) {
  var c = $('#canvas-areas');
  if (!c || !an) return;
  var cssW = Math.max(260, Math.min(520, c.parentNode.clientWidth - 24)), cssH = 230, dpr = window.devicePixelRatio || 1;
  c.style.width = cssW + 'px'; c.style.height = cssH + 'px';
  c.width = Math.round(cssW * dpr); c.height = Math.round(cssH * dpr);
  var g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  var pal = paletaActual();
  g.clearRect(0, 0, cssW, cssH);
  var seg = segmentosAreas(an), tot = seg.total;
  var cx = cssW / 2, cy = cssH / 2, R = Math.min(cssW, cssH) / 2 - 8, r0 = R * 0.58;
  if (!(tot > 0)) { g.fillStyle = pal.texto; g.font = '13px system-ui,sans-serif'; g.textAlign = 'center'; g.fillText('Sin área medida', cx, cy); return; }
  var ang = -Math.PI / 2;
  seg.items.forEach(function (s) {
    if (!(s.valor > 0)) return;
    var a1 = ang + 2 * Math.PI * s.valor / tot;
    g.beginPath(); g.arc(cx, cy, R, ang, a1); g.arc(cx, cy, r0, a1, ang, true); g.closePath();
    g.fillStyle = s.color; g.fill();
    g.lineWidth = 2; g.strokeStyle = pal.piso; g.stroke();
    var pc = 100 * s.valor / tot;
    if (pc >= 6) {
      var am = (ang + a1) / 2, rr = (R + r0) / 2;
      g.fillStyle = '#10161d'; g.font = '700 12px system-ui,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(fmt(pc, 0) + ' %', cx + Math.cos(am) * rr, cy + Math.sin(am) * rr);
    }
    ang = a1;
  });
  g.fillStyle = pal.texto; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '700 18px system-ui,sans-serif'; g.fillText(fmt(tot, 0) + ' m²', cx, cy - 6);
  g.font = '11px system-ui,sans-serif'; g.fillText('área del contorno', cx, cy + 13);
}
function metricaPorId(lista, id) { return (lista || []).filter(function (m) { return m && m.id === id; })[0] || null; }
function segmentosAreas(an) {
  var A = (an.espacio && an.espacio.areas) || [];
  var v = function (id) { var m = metricaPorId(A, id); return m && typeof m.valor === 'number' && isFinite(m.valor) ? Math.max(0, m.valor) : 0; };
  var total = v('area_total'), racks = v('area_racks'), huecos = v('area_huecos'), circ = v('area_circulacion'), libre = v('area_sin_uso');
  var circUtil = Math.max(0, circ - libre);
  var otro = Math.max(0, total - racks - huecos - circUtil - libre);
  var items = [
    { id: 'racks', nombre: 'Huella de racks', valor: racks, color: COL_AREA.racks },
    { id: 'circ', nombre: 'Circulación (pasillos)', valor: circUtil, color: COL_AREA.circ },
    { id: 'libre', nombre: 'Libre sin uso', valor: libre, color: COL_AREA.libre },
    { id: 'huecos', nombre: 'Huecos (columnas, oficinas, equipos)', valor: huecos, color: COL_AREA.huecos }
  ];
  if (total > 0 && otro / total > 0.01) items.push({ id: 'otro', nombre: 'Sin clasificar (márgenes de muro, solapes)', valor: otro, color: COL_AREA.otro });
  return { total: total, items: items };
}
/* ---- secciones nuevas del análisis v1.1 (A1–A8) y sensibilidad (A9). Lectura tolerante: si analisis.js aún no entrega una sección, se avisa y no se rompe nada ---- */
var SECCIONES_AN = [
  ['muelle', 'A1 · Muelle y staging'], ['evacuacion', 'A2 · Evacuación'], ['cargas', 'A3 · Cargas por módulo y por piso'], ['pico', 'A4 · Ocupación actual vs pico'],
  ['crossdock', 'A5 · Cross-docking'], ['afinidad', 'A6 · Afinidad (pares que se piden juntos)'], ['reposicion', 'A7 · Picking / reserva y reposición'], ['fefo', 'A8 · Lotes, vencimientos y FEFO']
];
function seccionAn(r, id) { return (r && (r[id] || (r.secciones && r.secciones[id]))) || null; }
function metricasSeccion(s) {
  if (!s) return [];
  if (Array.isArray(s)) return s.filter(function (m) { return m && typeof m === 'object' && ('valor' in m || 'nombre' in m); });
  return Array.isArray(s.metricas) ? s.metricas : [];
}
/* tabla genérica para listas de objetos que devuelva una sección (ranking, pares, lotes…): solo columnas simples, máx. 12 filas */
function tablaGenerica(lista, titulo) {
  if (!Array.isArray(lista) || !lista.length || typeof lista[0] !== 'object' || lista[0] === null) return '';
  var cols = Object.keys(lista[0]).filter(function (k) { var v = lista[0][k]; return v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean'; }).slice(0, 8);
  if (!cols.length) return '';
  return '<details class="an-det"><summary>' + esc(titulo) + ' (' + lista.length + ')</summary><div class="tabla-ancha"><table class="tabla-simple"><thead><tr>' + cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr></thead><tbody>' +
    lista.slice(0, 12).map(function (o) { return '<tr>' + cols.map(function (c) { var v = o && o[c]; return '<td' + (typeof v === 'number' ? ' class="n"' : '') + '>' + (typeof v === 'number' ? esc(fmtVal(v)) : esc(v == null ? '—' : v)) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>' + (lista.length > 12 ? '<p class="peq muted">… y ' + (lista.length - 12) + ' más.</p>' : '') + '</details>';
}
function renderSeccionesNuevas(r) {
  var box = $('#an-nuevas'), h = '', ausentes = [];
  SECCIONES_AN.forEach(function (d) {
    var s = seccionAn(r, d[0]);
    if (!s) { ausentes.push(d[1].split(' · ')[0]); return; }
    var mets = metricasSeccion(s), extra = '';
    if (!Array.isArray(s)) {
      if (s.resumen && typeof s.resumen === 'string') extra += '<p class="peq">' + esc(s.resumen) + '</p>';
      if (s.faltaDato || s.falta) extra += '<div class="msg aviso"><b>Falta dato suyo:</b> ' + esc(Array.isArray(s.faltaDato || s.falta) ? (s.faltaDato || s.falta).join('; ') : (s.faltaDato || s.falta)) + '</div>';
      if (s.motivo && typeof s.motivo === 'string') extra += '<div class="msg info">' + esc(s.motivo) + '</div>';
      (Array.isArray(s.advertencias) ? s.advertencias : []).forEach(function (t) { extra += '<div class="msg aviso">' + esc(t) + '</div>'; });
      Object.keys(s).forEach(function (k) {
        if (k === 'mapa' || k === 'metricas' || !Array.isArray(s[k]) || k === 'advertencias' || k === 'supuestos') return;
        extra += tablaGenerica(s[k], k);
      });
      if (Array.isArray(s.supuestos) && s.supuestos.length) extra += '<details><summary>Supuestos de esta sección</summary><ul class="peq">' + s.supuestos.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></details>';
    }
    h += '<section class="caja" data-an-sec="' + esc(d[0]) + '"><h3>' + esc(d[1]) + '</h3>' + extra +
      (mets.length ? '<div class="an-tarjetas">' + mets.map(tarjetaMetrica).join('') + '</div>' : '<p class="muted peq">Sin métricas para esta sección con los datos actuales.</p>') + '</section>';
  });
  if (ausentes.length) h += '<p class="peq muted">Secciones no entregadas por el <code>analisis.js</code> instalado: ' + esc(ausentes.join(', ')) + '. Se mostrarán al actualizarlo.</p>';
  box.innerHTML = h;
}
function textoSensible(p) { return p.robusto === true ? ['✓', 'Robusto', 'ok'] : p.robusto === false ? ['⚠', 'Sensible', 'atencion'] : ['ℹ', 'Sin veredicto', 'info']; }
function sensibilidadHTML(s) {
  var h = '';
  if (!s || !Array.isArray(s.parametros)) return '<p class="muted">La sensibilidad no devolvió parámetros.</p>';
  var res = Array.isArray(s.resumen) ? s.resumen : [];
  if (res.length) {
    h += '<h4 class="sub-h">Qué parámetros importan</h4><ol class="peq">' + res.slice(0, 10).map(function (x) {
      return '<li>' + (typeof x === 'string' ? esc(x) : esc((x && (x.texto || x.lectura || x.nombre)) || '') + (x && x.efecto != null && typeof x.efecto === 'number' ? ' <span class="muted">(efecto ' + esc(fmtVal(x.efecto)) + ')</span>' : '')) + '</li>';
    }).join('') + '</ol>';
  }
  h += '<div class="tabla-ancha"><table class="tabla-simple an-sens"><thead><tr><th>Parámetro</th><th class="n">Valor base</th><th class="n">Variación</th><th class="n">Valor</th><th class="n" title="Costo de la asignación nueva medido con el criterio base: es comparable con la base">Costo (criterio base)</th><th class="n">Δ costo</th><th class="n">SKU que cambian</th><th>¿Misma asignación?</th></tr></thead><tbody>';
  s.parametros.forEach(function (p) {
    var v = textoSensible(p), vars = Array.isArray(p.variaciones) ? p.variaciones : [];
    h += '<tr class="fila-param"><td colspan="8"><b>' + esc(p.nombre || p.id) + '</b> · <span class="an-est est-' + v[2] + '"><span aria-hidden="true">' + v[0] + '</span> ' + v[1] + '</span>' + (p.lectura ? '<div class="peq muted" style="white-space:normal;max-width:70ch">' + esc(p.lectura) + '</div>' : '') + '</td></tr>';
    vars.forEach(function (x) {
      h += '<tr><td></td><td class="n">' + esc(fmtVal(p.base)) + '</td><td class="n">' + (typeof x.pct === 'number' ? esc(fmtSigno(x.pct, 0, ' %')) : '—') + '</td><td class="n">' + esc(fmtVal(x.valor)) + '</td><td class="n">' + esc(fmtVal(x.costoBajoBase != null ? x.costoBajoBase : x.costoTotal)) + '</td><td class="n">' + (typeof x.deltaCostoPct === 'number' ? esc(fmtSigno(x.deltaCostoPct, 1, ' %')) : '—') + (x.comparable === false ? '<br><span class="peq muted" title="No entra al veredicto">excluida: ' + esc(x.motivoNoComparable === 'violacionesBase' ? 'el caso base viola una restricción' : x.motivoNoComparable === 'conjuntoDistinto' ? 'ubica otro conjunto' : 'no comparable') + '</span>' : '') + '</td><td class="n">' + (typeof x.skusCambiados === 'number' ? esc(fmtVal(x.skusCambiados)) + (typeof x.skusCambiadosPct === 'number' ? ' (' + esc(fmt(x.skusCambiadosPct, 1)) + ' %)' : '') : '—') + '</td><td>' + (x.mismaAsignacion === true ? '✓ sí' : x.mismaAsignacion === false ? '✕ no' : '—') + '</td></tr>';
    });
  });
  h += '</tbody></table></div>';
  if (Array.isArray(s.advertencias) && s.advertencias.length) h += s.advertencias.map(function (t) { return '<div class="msg aviso">' + esc(t) + '</div>'; }).join('');
  if (Array.isArray(s.supuestos) && s.supuestos.length) h += '<details><summary>Supuestos de la sensibilidad</summary><ul class="peq">' + s.supuestos.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></details>';
  return h;
}
async function calcularSensibilidad() {
  if (S.ocupado) return;
  var est = $('#an-sens-estado');
  if (!AA || typeof AA.sensibilidad !== 'function') { est.innerHTML = '<span class="chip warn">No disponible</span> El <code>analisis.js</code> instalado todavía no incluye <code>sensibilidad</code>.'; return; }
  var falta = faltaAnalisis();
  if (falta.length || !S.proy.productos.length) { aviso('Para la sensibilidad hacen falta contorno, racks y artículos.', 'warn'); return; }
  S.ocupado = true;
  var btn = $('#an-sens-calc'); btn.disabled = true;
  est.innerHTML = '<span class="spinner" aria-hidden="true"></span> <b>Calculando…</b> corre la asignación varias veces; tarda unos segundos.';
  await esperar(80);
  try {
    var t0 = performance.now(), op = {};
    if ($('#an-sens-25').checked) op.variacionesPct = [25, 50];
    op.fechaReferencia = fechaRefVenc();
    var res = AA.sensibilidad(S.proy, op);
    S.sensibilidad = { res: res, ver: S.ver, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    console.error(e); S.sensibilidad = null;
    aviso('No se pudo calcular la sensibilidad: ' + e.message, 'error', 9000);
  } finally { S.ocupado = false; btn.disabled = false; }
  renderSensibilidad();
}
function renderSensibilidad() {
  var est = $('#an-sens-estado'), box = $('#an-sens-res'), s = S.sensibilidad;
  if (!box) return;
  if (!s) { box.innerHTML = ''; if (!S.ocupado) est.textContent = ''; return; }
  var vig = s.ver === S.ver;
  est.innerHTML = (vig ? '<span class="chip ok">Al día</span>' : '<span class="chip warn">Desactualizado</span>') + ' Calculado en ' + esc(fmt(s.ms / 1000, 1)) + ' s.' + (vig ? '' : ' Cambió el proyecto: vuelve a calcular.') + (s.res && s.res.truncado ? ' <b>Truncado por tiempo.</b>' : '');
  box.innerHTML = sensibilidadHTML(s.res);
}
function renderAnalisis() {
  var an = S.analisis, vac = $('#an-vacio'), cont = $('#an-resultado'), est = $('#an-estado');
  var falta = faltaAnalisis();
  $('#an-calcular').disabled = !!S.ocupado || !AA;
  if (!AA) {
    vac.hidden = false; cont.hidden = true;
    vac.innerHTML = '<h3 style="justify-content:center">No se cargó analisis.js</h3><p class="muted">Verifica que el archivo esté en la misma carpeta que index.html.</p>';
    return;
  }
  if (falta.length && !an) {
    vac.hidden = false; cont.hidden = true;
    vac.innerHTML = '<h3 style="justify-content:center">Falta ' + esc(falta.join(' y ')) + '</h3><p class="muted">El análisis mide el espacio, la capacidad y el movimiento sobre tu plano. Necesita al menos el contorno y los racks; con puertas y artículos también calcula recorridos y horas.</p>' +
      '<div class="acc" style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap"><button type="button" class="btn primario" data-acc="ejemplo">Cargar ejemplo</button>' +
      '<button type="button" class="btn" data-acc="irplano">Ir al plano</button><button type="button" class="btn" data-acc="irracks">Ir a racks</button></div>';
    est.textContent = '';
    return;
  }
  if (!an) {
    vac.hidden = false; cont.hidden = true;
    vac.innerHTML = '<h3 style="justify-content:center">Todo listo para analizar</h3><p class="muted">Pulsa «Calcular análisis»: mide las áreas reales, la capacidad por tipo, las distancias y horas de recorrido, y propone mejoras con su cálculo a la vista.' +
      (!S.proy.puertas.length ? '<br><b>Sin puertas</b> no se calculan recorridos.' : '') + (!S.proy.productos.length ? '<br><b>Sin artículos</b> no se calculan capacidad por tipo ni movimiento.' : '') + '</p>' +
      '<div class="acc"><button type="button" class="btn primario" data-acc="calcular-an">Calcular análisis</button></div>';
    est.textContent = '';
    return;
  }
  vac.hidden = true; cont.hidden = false;
  var r = an.res, vig = an.ver === S.ver;
  est.innerHTML = (vig ? '<span class="chip ok">Al día</span>' : '<span class="chip warn">Desactualizado</span>') + ' Calculado en ' + esc(fmt(an.ms / 1000, 1)) + ' s' + (an.conEsc ? ' (con escenarios)' : ' (sin escenarios)') + (r.meta && r.meta.truncado ? ' · <b>escenarios truncados por tiempo</b>' : '') + '.' + (vig ? '' : ' Cambiaste el proyecto después de calcular: vuelve a pulsar «Calcular análisis».');
  // áreas
  dibujarAreas(r);
  var seg = segmentosAreas(r);
  $('#an-areas-leyenda').innerHTML = '<ul class="an-ley">' + seg.items.map(function (s) {
    return '<li><span class="sw" style="background:' + esc(s.color) + '"></span>' + esc(s.nombre) + ': <b>' + esc(fmt(s.valor, 1)) + ' m²</b> (' + esc(fmt(seg.total > 0 ? 100 * s.valor / seg.total : null, 1)) + ' %)</li>';
  }).join('') + '</ul>';
  $('#an-areas-tabla').innerHTML = '<div class="an-tarjetas an-tarj-peq">' + ((r.espacio && r.espacio.areas) || []).map(tarjetaMetrica).join('') + '</div>';
  $('#an-met-espacio').innerHTML = ((r.espacio && r.espacio.metricas) || []).map(tarjetaMetrica).join('') || '<p class="muted peq">Sin métricas.</p>';
  // capacidad
  var pt = (r.capacidad && r.capacidad.porTipo) || [];
  var h = '';
  if (pt.length) {
    h += '<div class="tabla-simple-caja"><table class="tabla-simple"><thead><tr><th>Tipo</th><th class="n">Necesarias</th><th class="n">Disponibles</th><th class="n">Ocupación</th><th class="n">Balance</th><th class="n">Déficit</th><th class="n">m² adicionales</th><th class="n">Niveles adicionales</th></tr></thead><tbody>' +
      pt.map(function (t) {
        return '<tr><td><b>' + esc(t.tipo) + '</b></td><td class="n">' + esc(fmtVal(t.requeridas)) + '</td><td class="n">' + esc(fmtVal(t.disponibles)) + '</td><td class="n">' + (t.ocupacionPct == null ? '—' : esc(fmt(t.ocupacionPct, 1)) + ' %') + '</td><td class="n">' + esc(fmtSigno(t.balance, 0)) + '</td><td class="n">' + (t.deficit > 0 ? '<b class="rojo">⚠ ' + esc(fmtVal(t.deficit)) + '</b>' : '0') + '</td><td class="n">' + esc(fmtVal(t.m2Adicionales)) + '</td><td class="n">' + esc(fmtVal(t.nivelesAdicionales)) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    h += pt.filter(function (t) { return (t.metricas || []).length; }).map(function (t) {
      return '<details class="an-det"><summary>Cálculo de capacidad: <b>' + esc(t.tipo) + '</b></summary><div class="an-tarjetas">' + t.metricas.map(tarjetaMetrica).join('') + '</div></details>';
    }).join('');
  }
  $('#an-cap-tipos').innerHTML = h;
  $('#an-met-capacidad').innerHTML = ((r.capacidad && r.capacidad.metricas) || []).map(tarjetaMetrica).join('');
  $('#an-met-mov').innerHTML = ((r.movimiento && r.movimiento.metricas) || []).map(tarjetaMetrica).join('') || '<p class="muted peq">Sin métricas de movimiento.</p>';
  renderSeccionesNuevas(r);
  renderSensibilidad();
  // recomendaciones
  var rs = r.recomendaciones || [];
  $('#an-recs').innerHTML = rs.length ? rs.map(function (x) {
    var pr = x.prioridad === 1 || x.prioridad === 2 || x.prioridad === 3 ? x.prioridad : 3;
    var imp = x.impacto || {};
    return '<article class="an-rec p' + pr + '"><header><span class="pbadge p' + pr + '">P' + pr + ' · ' + PRIO_AN[pr] + '</span><h4>' + esc(x.titulo) + '</h4><span class="conf">Confianza: <b>' + esc(x.confianza || '—') + '</b></span></header>' +
      '<p><b>Impacto:</b> ' + esc(imp.texto || '') + (typeof imp.magnitud === 'number' && isFinite(imp.magnitud) ? ' <span class="muted">(' + esc(fmtVal(imp.magnitud)) + ' ' + esc(imp.unidad || '') + ')</span>' : '') + '</p>' +
      '<p><b>Acción:</b> ' + esc(x.accion || '') + '</p>' +
      '<details><summary>Ver cálculo y qué verificar</summary><dl class="an-calc">' +
      (x.detalle ? '<dt>Detalle</dt><dd>' + esc(x.detalle) + '</dd>' : '') +
      (x.formula ? '<dt>Fórmula</dt><dd><code>' + esc(x.formula) + '</code></dd>' : '') +
      (x.sustitucion ? '<dt>Con sus números</dt><dd><code>' + esc(x.sustitucion) + '</code></dd>' : '') +
      ((x.verificar || []).length ? '<dt>Qué verificar</dt><dd><ul>' + x.verificar.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></dd>' : '') +
      '</dl></details></article>';
  }).join('') : '<p class="muted">No hay recomendaciones con los datos actuales.' + (an.conEsc ? '' : ' Algunas dependen de los escenarios: márcalos y recalcula.') + '</p>';
  // escenarios
  var es = (r.escenarios || []).slice().sort(function (a, b) {
    if (a.id === 'regenerado') return -1; if (b.id === 'regenerado') return 1;
    return (b.posiciones - a.posiciones) || ((a.distMedia == null ? 1e9 : a.distMedia) - (b.distMedia == null ? 1e9 : b.distMedia));
  });
  $('#an-esc').innerHTML = es.length ? '<p class="peq muted">Cada escenario cambia UNA cosa y corre la misma heurística del motor (no es el óptimo). «Regenerado» es la referencia: separa el efecto de volver a generar los racks del efecto del cambio. Δ recorrido: negativo = camina menos.</p>' +
    '<div class="tabla-simple-caja"><table class="tabla-simple an-esc"><thead><tr><th>Escenario</th><th class="n">Posiciones</th><th class="n">Densidad (pos/m²)</th><th class="n">Dist. media (m)</th><th class="n">Ocupación</th><th class="n">Δ posiciones</th><th class="n">Δ recorrido</th><th></th></tr></thead><tbody>' +
    es.map(function (e) {
      var dr = e.deltaRecorridoPct, drTxt = dr == null ? '—' : (dr < 0 ? '▼ ' : dr > 0 ? '▲ ' : '') + fmtSigno(dr, 1, ' %');
      var puede = vig && e.aplicar && e.aplicar.racksOpciones && e.id !== 'regenerado';
      var puedeRef = vig && e.aplicar && e.aplicar.racksOpciones;
      return '<tr' + (e.id === 'regenerado' ? ' class="ref"' : '') + '><td><b>' + esc(e.nombre) + '</b>' + (e.id === 'regenerado' ? ' <span class="chip">referencia</span>' : '') + '<br><span class="peq muted">' + esc(e.cambio || '') + '</span>' +
        (e.alcanzables === false ? '<br><span class="chip warn">⚠ el equipo no alcanza todos los niveles</span>' : '') +
        (e.nota ? '<br><span class="peq">' + esc(e.nota) + '</span>' : '') +
        '<details><summary>Ver cálculo</summary><dl class="an-calc">' + (e.formula ? '<dt>Fórmula</dt><dd><code>' + esc(e.formula) + '</code></dd>' : '') + (e.sustitucion ? '<dt>Con sus números</dt><dd><code>' + esc(e.sustitucion) + '</code></dd>' : '') + (e.lectura ? '<dt>Lectura</dt><dd>' + esc(e.lectura) + '</dd>' : '') + '</dl></details></td>' +
        '<td class="n">' + esc(fmtVal(e.posiciones)) + (e.posicionesUtiles != null && e.posicionesUtiles !== e.posiciones ? '<br><span class="peq muted">útiles: ' + esc(fmtVal(e.posicionesUtiles)) + '</span>' : '') + '</td><td class="n">' + esc(e.densidad == null ? '—' : fmt(e.densidad, 3)) + '</td><td class="n">' + esc(e.distMedia == null ? '—' : fmt(e.distMedia, 2)) + '</td><td class="n">' + (e.ocupacionPct == null ? '—' : esc(fmt(e.ocupacionPct, 1)) + ' %') + '</td>' +
        '<td class="n">' + esc(fmtSigno(e.deltaPosiciones, 0)) + (e.deltaPosPct == null ? '' : ' <span class="muted">(' + esc(fmtSigno(e.deltaPosPct, 1, ' %')) + ')</span>') + (e.id !== 'regenerado' && e.deltaCambioPosiciones != null ? '<br><span class="peq muted">por el cambio: ' + esc(fmtSigno(e.deltaCambioPosiciones, 0)) + '</span>' : '') + '</td><td class="n">' + esc(drTxt) + '</td>' +
        '<td>' + ((e.id === 'regenerado' ? puedeRef : puede) ? '<button type="button" class="btn peq-btn" data-esc="' + esc(e.id) + '">Aplicar este escenario</button>' : '<span class="peq muted">' + (!vig ? 'recalcula' : 'no aplicable') + '</span>') + '</td></tr>';
    }).join('') + '</tbody></table></div>'
    : '<p class="muted">' + (an.conEsc ? 'No se generaron escenarios (faltan contorno o puertas).' : 'No se calcularon escenarios. Marca «Incluir escenarios» y recalcula.') + '</p>';
  // supuestos
  $('#an-sup').innerHTML = ((r.advertencias || []).length ? (r.advertencias || []).map(function (t) { return '<div class="msg aviso">' + esc(t) + '</div>'; }).join('') : '') +
    '<ul style="padding-left:1.1rem;margin:.3rem 0">' + (r.supuestos || []).map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' +
    ((r.supuestosAsignacion || []).length ? '<details><summary>Supuestos de la asignación (slotting)</summary><ul style="padding-left:1.1rem;margin:.3rem 0">' + r.supuestosAsignacion.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></details>' : '') +
    '<p class="aviso-honesto">Valores geométricos calculados sobre su plano; los valores de referencia son típicos y deben verificarse; las horas son una cota superior bajo estos supuestos (un viaje por línea).</p>';
}
async function aplicarEscenario(id) {
  var an = S.analisis;
  if (!an || an.ver !== S.ver) { aviso('El análisis está desactualizado: recalcúlalo antes de aplicar un escenario.', 'warn'); return; }
  var esc1 = (an.res.escenarios || []).filter(function (e) { return e.id === id; })[0];
  if (!esc1) return;
  var ap = esc1.aplicar;
  if (!ap || !ap.racksOpciones) { aviso('Este escenario no trae instrucciones de aplicación.', 'warn'); return; }
  if (S.ocupado) return;
  var p = S.proy, autos = p.racks.filter(function (r) { return r.auto; }).length, manuales = p.racks.length - autos;
  var cfgCambios = Object.keys(ap.config || {}).filter(function (k) { return /^[A-Za-z]{1,30}$/.test(k); });
  var ok = await preguntar('Aplicar el escenario «' + esc1.nombre + '»',
    (esc1.cambio ? esc1.cambio + '.\n' : '') +
    (cfgCambios.length ? 'Cambia la configuración: ' + cfgCambios.map(function (k) { var v = ap.config[k]; return k + ' = ' + (typeof v === 'number' ? fmt(v, 2).replace(/,00$/, '') : String(v).slice(0, 30)); }).join(', ') + '.\n' : '') +
    'Se regenerarán SOLO los racks automáticos (' + autos + '); los ' + manuales + ' hechos a mano se conservan. La asignación de artículos actual se borra y habrá que volver a asignar. Puedes deshacerlo con Ctrl+Z.',
    [{ texto: 'Aplicar escenario', valor: true, primario: true }, { texto: 'Cancelar', valor: null }]);
  if (!ok) return;
  var antes = snap();
  var cfgNueva = Object.assign({}, p.config);
  Object.keys(ap.config || {}).forEach(function (k) {
    var v = ap.config[k];
    if (k === '__proto__' || !/^[A-Za-z]{1,30}$/.test(k) || k === 'abc') return;
    if (typeof v === 'number' && isFinite(v)) cfgNueva[k] = v;
    else if (typeof v === 'string' && /^[a-z_]{1,24}$/.test(v)) cfgNueva[k] = v;
    else if (typeof v === 'boolean') cfgNueva[k] = v;
  });
  var base = Object.assign({}, p, { config: cfgNueva, resultado: null, racks: p.racks.filter(function (r) { return !r.auto; }) });
  var res = await conEspera('Aplicando escenario…', function () { return M.generarRacksAuto(base, ap.racksOpciones); });
  if (!res) return;
  if (!res.racks || !res.racks.length) { aviso('El escenario no generó ningún rack: no se cambió nada.', 'warn', 8000); return; }
  colocarRacksGenerados(res, 'auto', antes, cfgNueva);
  var n = getPos().length;
  aviso('Escenario «' + esc1.nombre + '» aplicado: ' + n + ' posiciones en total. Vuelve a asignar ubicaciones; Ctrl+Z lo deshace.', 'ok', 9000);
  S.analisis = S.analisis;   // queda desactualizado (S.ver cambió)
}
/* Análisis para el informe imprimible: usa el último cálculo vigente; si no hay, uno rápido sin escenarios. */
function analisisParaInforme() {
  if (!AA || faltaAnalisis().length) return null;
  if (S.analisis && S.analisis.ver === S.ver) return { res: S.analisis.res, nota: S.analisis.conEsc ? '' : 'Calculado sin escenarios.' };
  try {
    return { res: AA.analizar(S.proy, { escenarios: false, fechaReferencia: fechaRefVenc() }), nota: 'Cálculo rápido con opciones por defecto y sin escenarios (en la pestaña Análisis puedes elegir las opciones).' };
  } catch (e) { return null; }
}
function informeAnalisisHTML() {
  var x = analisisParaInforme();
  if (!x) return '<h2>Análisis de espacio, capacidad y movimiento</h2><p>No calculado (falta el contorno o los racks).</p>';
  var r = x.res, h = '<h2 class="salto">Análisis de espacio, capacidad y movimiento</h2>';
  var mo = (r.meta && r.meta.opciones) || {};
  h += '<p class="peq">Valores geométricos calculados sobre su plano; los valores de referencia son típicos y deben verificarse; las horas son una <b>cota superior bajo estos supuestos</b> (un viaje de ida y vuelta por línea, sin encadenar picks). ' + esc(x.nota) + '</p>';
  h += '<p class="peq"><b>Parámetros usados:</b> velocidad ' + esc(fmt(Number(mo.velocidadMs), 1)) + ' m/s · ' + esc(fmt(Number(mo.segPorPick), 0)) + ' s por pick · periodo ' + esc(fmt(Number(mo.periodoDias), 0)) + ' días · ocupación objetivo ' + esc(fmt(Number(mo.ocupacionObjetivo) * 100, 0)) + ' %' + (mo.costoHora ? ' · costo ' + esc(fmt(Number(mo.costoHora), 2)) + ' por hora' : ' · sin costo por hora (no se calcula dinero)') + '. Los valores no indicados por el usuario son supuestos del análisis: ver la lista de supuestos y sus [VERIFICAR].</p>';
  var fila = function (m) {
    var e = estAn(m.estado);
    return '<tr><td>' + esc(m.nombre) + '</td><td class="n">' + esc(fmtVal(m.valor)) + (typeof m.valor === 'number' && m.unidad ? ' ' + esc(m.unidad) : '') + '</td><td>' + EST_AN[e][0] + ' ' + EST_AN[e][1] + '</td></tr>';
  };
  var seg = segmentosAreas(r);
  h += '<h3>Áreas</h3><table><thead><tr><th>Concepto</th><th class="n">m²</th><th class="n">% del total</th></tr></thead><tbody>' +
    '<tr><td><b>Área del contorno</b></td><td class="n">' + esc(fmt(seg.total, 1)) + '</td><td class="n">100,0</td></tr>' +
    seg.items.map(function (s) { return '<tr><td>' + esc(s.nombre) + '</td><td class="n">' + esc(fmt(s.valor, 1)) + '</td><td class="n">' + esc(fmt(seg.total > 0 ? 100 * s.valor / seg.total : null, 1)) + '</td></tr>'; }).join('') + '</tbody></table>';
  var claves = [].concat((r.espacio && r.espacio.metricas) || [], (r.capacidad && r.capacidad.metricas) || [], (r.movimiento && r.movimiento.metricas) || []);
  h += '<h3>Métricas clave</h3><table><thead><tr><th>Métrica</th><th class="n">Valor</th><th>Estado</th></tr></thead><tbody>' + claves.map(fila).join('') + '</tbody></table>';
  var pt = (r.capacidad && r.capacidad.porTipo) || [];
  if (pt.length) h += '<h3>Capacidad por tipo</h3><table><thead><tr><th>Tipo</th><th class="n">Necesarias</th><th class="n">Disponibles</th><th class="n">Ocupación</th><th class="n">Déficit</th></tr></thead><tbody>' + pt.map(function (t) { return '<tr><td>' + esc(t.tipo) + '</td><td class="n">' + esc(fmtVal(t.requeridas)) + '</td><td class="n">' + esc(fmtVal(t.disponibles)) + '</td><td class="n">' + (t.ocupacionPct == null ? '—' : esc(fmt(t.ocupacionPct, 1)) + ' %') + '</td><td class="n">' + esc(fmtVal(t.deficit)) + '</td></tr>'; }).join('') + '</tbody></table>';
  SECCIONES_AN.forEach(function (d) {
    var s = seccionAn(r, d[0]);
    if (!s) return;
    var mets = metricasSeccion(s);
    h += '<h3>' + esc(d[1]) + '</h3>';
    if (!Array.isArray(s)) {
      if (s.faltaDato || s.falta) h += '<p><b>Falta dato suyo:</b> ' + esc(Array.isArray(s.faltaDato || s.falta) ? (s.faltaDato || s.falta).join('; ') : (s.faltaDato || s.falta)) + '</p>';
      if (s.motivo && typeof s.motivo === 'string') h += '<p>' + esc(s.motivo) + '</p>';
    }
    if (mets.length) h += '<table><thead><tr><th>Métrica</th><th class="n">Valor</th><th>Estado</th></tr></thead><tbody>' + mets.map(fila).join('') + '</tbody></table>' +
      '<p class="peq">' + mets.filter(function (m) { return m.formula; }).slice(0, 6).map(function (m) { return esc(m.nombre) + ': <code>' + esc(m.formula) + '</code>' + (m.sustitucion ? ' → <code>' + esc(m.sustitucion) + '</code>' : '') + (m.referencia ? ' <i>[' + refAn(m.referencia) + ']</i>' : ''); }).join('<br>') + '</p>';
    else h += '<p>Sin métricas con los datos actuales.</p>';
    if (!Array.isArray(s) && Array.isArray(s.supuestos) && s.supuestos.length) h += '<ul class="peq">' + s.supuestos.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>';
  });
  var sn = S.sensibilidad && S.sensibilidad.ver === S.ver ? S.sensibilidad.res : null;
  if (sn && Array.isArray(sn.parametros) && sn.parametros.length) {
    h += '<h3>Sensibilidad de parámetros</h3><table><thead><tr><th>Parámetro</th><th class="n">Base</th><th>Veredicto</th><th>Peor variación (Δ costo / SKU que cambian)</th></tr></thead><tbody>' + sn.parametros.map(function (q) {
      var v = textoSensible(q), vars = Array.isArray(q.variaciones) ? q.variaciones.filter(function (z) { return z && z.comparable !== false; }) : [], peor = vars.slice().sort(function (a, b) { return Math.abs(N(b.deltaCostoPct)) - Math.abs(N(a.deltaCostoPct)); })[0];
      return '<tr><td>' + esc(q.nombre || q.id) + '</td><td class="n">' + esc(fmtVal(q.base)) + '</td><td>' + v[0] + ' ' + v[1] + '</td><td>' + (peor ? esc(fmtSigno(peor.deltaCostoPct, 1, ' %')) + ' / ' + esc(fmt(N(peor.skusCambiadosPct), 1)) + ' % (' + esc(fmtSigno(peor.pct, 0, ' %')) + ')' : '—') + '</td></tr>';
    }).join('') + '</tbody></table><p class="peq">«Robusto» = menos de 10 % de los SKU cambian de posición y el costo cambia menos de 5 % con ±50 % [PROPIO].</p>';
  }
  var rs = (r.recomendaciones || []).slice(0, 5);
  h += '<h3>Recomendaciones principales</h3>' + (rs.length ? rs.map(function (q) {
    var pr = q.prioridad === 1 || q.prioridad === 2 || q.prioridad === 3 ? q.prioridad : 3;
    return '<div class="rec-inf"><p><b>P' + pr + ' · ' + esc(q.titulo) + '</b> <span class="peq">(confianza ' + esc(q.confianza || '—') + ')</span></p>' +
      '<p>' + esc((q.impacto && q.impacto.texto) || '') + ' <i>Acción: ' + esc(q.accion || '') + '</i></p>' +
      '<p class="peq">Fórmula: <code>' + esc(q.formula || '') + '</code><br>Con sus números: <code>' + esc(q.sustitucion || '') + '</code>' + ((q.verificar || []).length ? '<br>Verificar: ' + esc(q.verificar.join('; ')) : '') + '</p></div>';
  }).join('') : '<p>Sin recomendaciones con los datos actuales.</p>');
  if ((r.supuestos || []).length) h += '<h3>Supuestos del análisis</h3><ul>' + r.supuestos.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>';
  if ((r.advertencias || []).length) h += '<p><b>Advertencias del análisis:</b></p><ul>' + r.advertencias.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>';
  return h;
}

/* ------------------------------------------------------------------ Reportes */
function vistaAjustada(b, w, h, margen) {
  var bw = Math.max(1, b[2] - b[0]), bh = Math.max(1, b[3] - b[1]);
  var k = Math.min((w - 2 * margen) / bw, (h - 2 * margen) / bh);
  return { k: k, ox: w / 2 - ((b[0] + b[2]) / 2) * k, oy: h / 2 - ((b[1] + b[3]) / 2) * k };
}
function renderizarPlano(anchoPx, opciones) {
  opciones = opciones || {};
  var b = limitesEscena();
  var bw = Math.max(1, b[2] - b[0]), bh = Math.max(1, b[3] - b[1]);
  var alto = clamp(Math.round(anchoPx * bh / bw) + 80, 500, 2400);
  var c = document.createElement('canvas');
  c.width = anchoPx; c.height = alto;
  var g = c.getContext('2d');
  var guardada = S.v;
  S.v = vistaAjustada(b, anchoPx, alto, 50);
  try {
    dibujarEscena(g, anchoPx, alto, { pal: PAL.claro, ui: false, grid: true, modo: S.proy.resultado ? 'abc' : 'nada', titulo: opciones.titulo });
  } finally { S.v = guardada; }
  return c;
}
function exportarPNG() {
  if (S.proy.contorno.length < 3 && !S.proy.racks.length) { aviso('No hay nada que dibujar todavía.', 'warn'); return; }
  var c = renderizarPlano(1800, { titulo: S.proy.nombre });
  c.toBlob(function (blob) {
    if (!blob) { aviso('No se pudo generar el PNG.', 'error'); return; }
    descargar(slug(S.proy.nombre) + '-plano.png', blob);
    aviso('PNG del plano descargado.', 'ok');
  }, 'image/png');
}
function csvUbicaciones() {
  if (!S.proy.resultado) { aviso('Primero asigna ubicaciones.', 'warn'); return; }
  var t;
  try { t = M.ubicacionesACSV(S.proy); } catch (e) { aviso('No se pudo generar el CSV: ' + e.message, 'error'); return; }
  descargar(slug(S.proy.nombre) + '-ubicaciones.csv', conBOM(t), 'text/csv;charset=utf-8');
  aviso('CSV de ubicaciones descargado.', 'ok');
}
function csvArticulos() {
  if (!S.proy.productos.length) { aviso('No hay artículos.', 'warn'); return; }
  var t;
  try { t = M.productosACSV(S.proy.productos); } catch (e) { console.error(e); aviso('No se pudo generar el CSV de artículos: ' + e.message, 'error'); return; }
  descargar(slug(S.proy.nombre) + '-articulos.csv', conBOM(t), 'text/csv;charset=utf-8');
  aviso('CSV de artículos descargado.', 'ok');
}
function guardarJSON() {
  var t = JSON.stringify(S.proy, null, 1);
  descargar(slug(S.proy.nombre) + '.almacen.json', t, 'application/json');
  aviso('Proyecto guardado en un archivo .json (incluye la imagen y el resultado).', 'ok');
}
async function abrirJSONArchivo(file) {
  if (!file) return;
  var t;
  try { t = await leerTexto(file); } catch (e) { aviso('No se pudo leer el archivo.', 'error'); return; }
  var o;
  try { o = JSON.parse(t); } catch (e2) { aviso('El archivo no es un JSON válido.', 'error'); return; }
  if (!o || typeof o !== 'object' || Array.isArray(o) || !('contorno' in o || 'racks' in o || 'productos' in o || 'plano' in o)) {
    aviso('Ese JSON no parece un proyecto de este programa.', 'error'); return;
  }
  if (hayContenido()) {
    var ok = await preguntar('Abrir proyecto', 'Se reemplazará el proyecto actual por «' + (o.nombre || file.name) + '». ¿Continuar?', [{ texto: 'Abrir', valor: true, primario: true }, { texto: 'Cancelar', valor: null }]);
    if (!ok) return;
  }
  cargarProyecto(o);
  aviso('Proyecto «' + S.proy.nombre + '» abierto.', 'ok');
}

function hayContenido() {
  var p = S.proy;
  return p.contorno.length > 0 || p.racks.length > 0 || p.productos.length > 0 || !!p.plano.imagen || p.puertas.length > 0 || p.huecos.length > 0;
}
function cargarProyecto(obj) {
  S.proy = proyectoNormalizado(obj);
  S.undo = []; S.redo = []; S.sel = null; S.selVert = null; S.rackElev = null; S.rackHover = null; S.posSel = null; S.moviendo = null;
  S.busqueda = null; S.genInfo = null; S.valid = null; S.validVer = -1; S.traza = null; S.calib = null; S.erroresCSV = null; S.avisosCSV = null; S.csvCancelado = false; S.dib = null;
  S.img = null; S.imgSrc = null; S.pix = null; S.opcionesCambiadas = false; S.pagArt = 0; S.filtroArt = ''; S.analisis = null; S.sensibilidad = null; S.artSel = null;
  $('#art-filtro').value = ''; $('#trz-panel').hidden = true; $('#form-calib').hidden = true;
  tocar();
  sincronizarImagen();
  S.encajarSiguiente = true;
  irTab('plano');
  encajar();
  guardarAutoDif();
}
async function cargarEjemplo() {
  if (hayContenido()) {
    var ok = await preguntar('Cargar el ejemplo', 'El proyecto actual se reemplazará por el ejemplo (nave en L, racks y 45 artículos rotulados «EJEMPLO – editar»). ¿Continuar?', [{ texto: 'Cargar ejemplo', valor: true, primario: true }, { texto: 'Cancelar', valor: null }]);
    if (!ok) return;
  }
  var ej;
  try { ej = M.ejemplo(); } catch (e) { aviso('No se pudo crear el ejemplo: ' + e.message, 'error'); return; }
  /* B-6: lo que el programa NO debe dar por «dato suyo» queda vacío en el ejemplo; la fecha de referencia vuelve a «hoy» */
  if (ej && ej.config) {
    ej.config.fechaReferencia = null; ej.config.diasAlertaVencimiento = null;
    if (ej.config.muelle && typeof ej.config.muelle === 'object') { ej.config.muelle.palletsDiaRecepcion = null; ej.config.muelle.palletsDiaDespacho = null; }
  }
  cargarProyecto(ej);
  aviso('Ejemplo cargado. Recorre los pasos: genera racks (si hace falta) y pulsa «Asignar ubicaciones».', 'ok', 6000);
}
async function nuevoProyecto() {
  if (hayContenido()) {
    var ok = await preguntar('Proyecto nuevo', 'Se descartará el proyecto actual (puedes guardarlo antes en Reportes → Guardar proyecto). ¿Empezar uno nuevo?', [{ texto: 'Proyecto nuevo', valor: true, peligro: true }, { texto: 'Cancelar', valor: null, primario: true }]);
    if (!ok) return;
  }
  cargarProyecto(M.crearProyectoVacio());
  aviso('Proyecto nuevo en blanco.', 'info');
}

/* ---- informe imprimible ---- */
function infoNombreZona(t) { return NOMBRES_ZONA[t] || t || ''; }
/* Datos v1.1 para el informe: salidas, zonas, artículos avanzados, pedidos y límites del usuario (con «dato suyo» y sin afirmar cumplimiento) */
function informeDatosV11HTML() {
  var p = S.proy, c = p.config, h = '';
  var nz = { almacenaje: 0, muelle: 0, staging: 0 };
  p.zonas.forEach(function (z) { if (nz[z.tipo] != null) nz[z.tipo]++; });
  var nSal = p.puertas.filter(function (d) { return d.tipo === 'salida_emergencia'; }).length;
  var pr = p.productos, nL = 0, nF = 0, nX = 0, nP = 0, nM = 0;
  pr.forEach(function (q) { if (q.lotes && q.lotes.length) nL++; if (q.fefo) nF++; if (q.crossdock) nX++; if (q.peligro) nP++; if (q.stockMax != null) nM++; });
  var tiposR = {}; p.racks.forEach(function (r) { tiposR[r.tipo] = (tiposR[r.tipo] || 0) + 1; });
  var dato = function (v, u) { return v == null ? '<i>sin dato (dato suyo)</i>' : esc(fmt(v, 2).replace(/,00$/, '')) + (u ? ' ' + u : ''); };
  h += '<h2>Configuración v1.1 y datos suyos</h2><table><tbody>' +
    '<tr><th>Tipos de rack</th><td>' + Object.keys(tiposR).map(function (t) { return esc(NOMBRES_UBIC[t] || t) + ': ' + tiposR[t]; }).join(' · ') + '</td><th>Zonas de almacenaje / muelle / staging</th><td>' + nz.almacenaje + ' / ' + nz.muelle + ' / ' + nz.staging + '</td></tr>' +
    '<tr><th>Salidas de emergencia marcadas</th><td>' + nSal + (nSal ? '' : ' (ninguna: la evacuación usa las puertas operativas)') + '</td><th>Pedidos para afinidad</th><td>' + N((p.pedidos || []).length) + '</td></tr>' +
    '<tr><th>Artículos con lotes / FEFO / cross-docking / peligro / stock máx.</th><td>' + nL + ' / ' + nF + ' / ' + nX + ' / ' + nP + ' / ' + nM + '</td><th>Dimensionado por</th><td>' + (c.dimensionarPor === 'maximo' ? 'stock máximo del pico' : 'stock actual') + '</td></tr>' +
    '<tr><th>Picking / reserva</th><td>' + (c.reposicion && c.reposicion.activa ? 'activo' : 'desactivado') + '</td><th>Peso de afinidad</th><td>' + esc(fmt(N(c.pesoAfinidad), 2)) + '</td></tr>' +
    '<tr><th>Segregación por peligro</th><td>' + (c.segregacion && c.segregacion.usar === false ? 'desactivada' : 'activa') + (c.segregacion && c.segregacion.matriz ? ' (matriz propia)' : ' (matriz por defecto)') + ' [VERIFICAR con HDS y seguridad-sst]</td><th>Fecha de referencia / alerta «por vencer»</th><td>' + esc(fechaRefVenc()) + (c.fechaReferencia ? '' : ' (hoy)') + ' / ' + (c.diasAlertaVencimiento == null ? '<i>sin dato (solo se marcan vencidos)</i>' : N(c.diasAlertaVencimiento) + ' d') + '</td></tr>' +
    '<tr><th>Distancia máx. de evacuación (suya)</th><td>' + dato(c.evacMaxM, 'm') + ' [VERIFICAR RNE A.130 / ITSE]</td><th>Ancho mín. de evacuación (suyo)</th><td>' + dato(c.anchoEvacuacionMin, 'm') + ' [VERIFICAR RNE A.130]</td></tr>' +
    '<tr><th>Capacidad de la losa (suya)</th><td>' + dato(c.cargaPisoMaxKgM2, 'kg/m²') + ' [VERIFICAR ingeniero estructural]</td><th>Muelle: palets/día rec. / desp.</th><td>' + dato(c.muelle && c.muelle.palletsDiaRecepcion) + ' / ' + dato(c.muelle && c.muelle.palletsDiaDespacho) + '</td></tr>' +
    '</tbody></table><p class="peq">Donde dice «sin dato» el programa <b>no afirma cumplimiento</b>: solo muestra los valores calculados. Los límites normativos son suyos o del especialista [VERIFICAR].</p>';
  return h;
}
function renderInforme() {
  var p = S.proy, res = p.resultado, el = $('#informe'), h = '';
  var cfg = p.config;
  var nPos = getPos().length;
  h += '<h1>' + esc(p.nombre) + '</h1>';
  h += '<div>Informe de distribución y asignación de ubicaciones · ' + esc(hoy()) + '</div>';
  h += '<p><b>Propuesta a validar</b> por el responsable de almacén: norma de rociadores, ancho de pasillo real del equipo y resistencia del piso (anclaje sísmico y losa no se calculan aquí: verificar con el ingeniero estructural). Es un resultado de una heurística, no un óptimo garantizado.</p>';
  h += '<h2>Datos del almacén</h2><table><tbody>' +
    '<tr><th>Área útil</th><td>' + (p.contorno.length >= 3 ? fmt(areaAbs(p.contorno), 1) + ' m²' : '—') + '</td><th>Racks / posiciones</th><td>' + p.racks.length + ' / ' + nPos + '</td></tr>' +
    '<tr><th>Equipo</th><td>' + esc(NOMBRES_EQUIPO[cfg.equipo] || cfg.equipo) + ' (pasillo ' + fmt(cfg.anchoPasillo, 2) + ' m, cruce ' + fmt(cfg.anchoPasilloCruce, 2) + ' m) [VERIFICAR con ficha del equipo: pasillo real = ancho del equipo + largo del palet + holguras]</td><th>Artículos (SKU)</th><td>' + p.productos.length + '</td></tr>' +
    '<tr><th>Puertas</th><td>' + p.puertas.map(function (d) { return esc(d.nombre) + ' (' + esc(NOMBRES_PUERTA[d.tipo] || d.tipo) + ')'; }).join(', ') + '</td><th>Peso recepción / despacho</th><td>' + Math.round(N(cfg.pesoRecepcion) * 100) + ' % / ' + (100 - Math.round(N(cfg.pesoRecepcion) * 100)) + ' %</td></tr>' +
    '<tr><th>Rociadores</th><td>' + (cfg.tipoRociador === 'esfr' ? 'ESFR' : 'Estándar') + ' · altura libre ' + fmt(cfg.alturaLibreNave, 1) + ' m · holgura ' + fmt(holguraEfectiva(cfg), 2) + ' m' + (cfg.holguraRociadores == null ? ' (según el tipo de rociador)' : '') + ' [VERIFICAR con el ingeniero de protección contra incendios]</td><th>Cortes ABC</th><td>A hasta ' + Math.round(N(cfg.abc && cfg.abc.a) * 100) + ' % · B hasta ' + Math.round(N(cfg.abc && cfg.abc.b) * 100) + ' % de los picks</td></tr>' +
    '</tbody></table>' + informeDatosV11HTML();
  if (p.contorno.length >= 3 || p.racks.length) {
    var cnv = renderizarPlano(1400, {});
    h += '<h2>Plano' + (res ? ' por clase ABC' : '') + '</h2><img class="plano" alt="Plano del almacén" src="' + cnv.toDataURL('image/png') + '">';
  }
  if (res) {
    var k = res.kpis || {}, b = res.baseline || {};
    h += '<h2>Resultados</h2><div class="kpi-grid">' +
      '<div class="kpi"><b>' + (res.mejoraPct == null ? 'no comparable' : fmt(Number(res.mejoraPct), 1) + ' %') + '</b><span>mejora de costo (incluye penalización de nivel) vs ubicar «sin criterio», no vs su situación actual' + (res.mejoraPct == null ? ': ' + esc(causaNoComparable(res)) : '') + '</span></div>' +
      '<div class="kpi"><b>' + fmt(k.distMediaPonderada, 1) + ' m</b><span>distancia media por pick (ida) · sin criterio: ' + fmt(b.distMediaPonderada, 1) + ' m</span></div>' +
      '<div class="kpi"><b>' + fmt(k.ocupacionPct, 1) + ' %</b><span>ocupación (' + esc(fmt(k.posicionesOcupadas, 0)) + ' de ' + esc(fmt(k.posicionesTotales, 0)) + ')</span></div>' +
      '<div class="kpi"><b>' + fmt(k.picksA_enNivel1Pct, 1) + ' %</b><span>de los picks de clase A en nivel 1</span></div>' +
      '<div class="kpi"><b>' + fmt(k.costoTotal, 0) + '</b><span>costo total del modelo, en m equivalentes (no es dinero) · sin criterio: ' + fmt(b.costoTotal, 0) + '</span></div>' +
      '<div class="kpi"><b>' + N((res.sinUbicar || []).length) + '</b><span>SKU sin ubicar por completo</span></div></div>' + kpiV11HTML(res, k) + cajaProblemasDatos();
    if (k.porClase) {
      h += '<h2>Por clase</h2><table><thead><tr><th>Clase</th><th class="n">SKU</th><th class="n">Posiciones</th><th class="n">Distancia media (m)</th></tr></thead><tbody>' +
        ['A', 'B', 'C'].map(function (c) { var x = k.porClase[c] || {}; return '<tr><td>' + c + '</td><td class="n">' + (x.skus != null ? esc(fmt(x.skus, 0)) : '—') + '</td><td class="n">' + (x.posiciones != null ? esc(fmt(x.posiciones, 0)) : '—') + '</td><td class="n">' + (x.distMedia != null ? fmt(x.distMedia, 1) : '—') + '</td></tr>'; }).join('') + '</tbody></table>';
    }
    if ((res.sinUbicar || []).length) {
      h += '<h2>Artículos no ubicados</h2><table><thead><tr><th>SKU</th><th class="n">Faltan</th><th>Motivo</th></tr></thead><tbody>' +
        res.sinUbicar.map(function (u) { return '<tr><td>' + esc(u.sku) + '</td><td class="n">' + esc(u.faltan) + '</td><td>' + esc(NOMBRES_MOTIVO[u.motivo] || u.motivo) + '</td></tr>'; }).join('') + '</tbody></table>';
    }
    h += '<h2>Supuestos y advertencias</h2><ul>' + (res.supuestos || []).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>';
    if ((res.advertencias || []).length) h += '<p><b>Advertencias:</b></p><ul>' + res.advertencias.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>';
    // tabla de ubicaciones
    var ids = Object.keys(res.porPosicion || {}).sort(function (a, c) { return a < c ? -1 : a > c ? 1 : 0; });
    var pos = posPorId(), prods = productoPorSku(), abc = mapaABC(), dist = distListo() ? getDist().porId : {};
    var rolI = res.rolPorPosicion || {}, loteI = res.lotePorPosicion || {}, conRol = Object.keys(rolI).length > 0, conLote = Object.keys(loteI).length > 0;
    h += '<h2 class="salto">Tabla de ubicaciones (' + ids.length + ')</h2><table><thead><tr><th>Ubicación</th><th>Rack</th><th class="n">Nivel</th><th>SKU</th><th>Descripción</th><th>Clase</th>' + (conRol ? '<th>Rol</th>' : '') + (conLote ? '<th>Lote</th><th>Vence</th>' : '') + '<th class="n">Dist. despacho (m)</th><th class="n">Dist. recepción (m)</th></tr></thead><tbody>';
    var filas = [];
    ids.forEach(function (id) {
      var ps = pos[id], sku = res.porPosicion[id], pr = prods[sku] || {}, d = dist[id];
      filas.push('<tr><td>' + esc(id) + '</td><td>' + esc(ps ? ps.rackNombre : '') + '</td><td class="n">' + (ps ? esc(ps.nivel) : '') + '</td><td>' + esc(sku) + '</td><td>' + esc(pr.descripcion || '') + '</td><td>' + esc((abc[sku] || {}).clase || '') + '</td>' + (conRol ? '<td>' + esc(rolI[id] || '') + '</td>' : '') + (conLote ? '<td>' + esc(loteI[id] ? loteI[id].lote : '') + '</td><td>' + esc(loteI[id] && loteI[id].vence ? loteI[id].vence + (estadoVenc(loteI[id].vence) && estadoVenc(loteI[id].vence).t !== 'ok' ? ' · ' + estadoVenc(loteI[id].vence).txt : '') : '') + '</td>' : '') + '<td class="n">' + (d && isFinite(d.dDesp) ? fmt(d.dDesp, 1) : '') + '</td><td class="n">' + (d && isFinite(d.dRec) ? fmt(d.dRec, 1) : '') + '</td></tr>');
    });
    h += filas.join('') + '</tbody></table>';
  } else {
    h += '<h2>Sin asignación</h2><p>Todavía no se han asignado ubicaciones. Completa los pasos 1 a 3 y pulsa «Asignar ubicaciones».</p>';
  }
  h += informeAnalisisHTML();
  h += '<div class="pie">Generado con el Diseñador de Almacén (local, sin IA). Unidades: metros y kilogramos. Distancias medidas caminando sobre una malla de ' + fmt(cfg.celdaM, 2) + ' m, rodeando racks y obstáculos. Los anchos de pasillo por equipo son valores típicos [VERIFICAR con ficha del fabricante].</div>';
  el.innerHTML = h;
}
function refrescarReportes() {
  var p = S.proy, res = p.resultado;
  $('#rep-csv-ubic').disabled = !res;
  $('#rep-csv-art').disabled = !p.productos.length;
  $('#rep-png').disabled = !(p.contorno.length >= 3 || p.racks.length);
  $('#rep-nota').textContent = res ? 'El informe de abajo es el que se imprime (botón «Imprimir informe»; en el diálogo puedes elegir «Guardar como PDF»).' : 'Para el CSV de ubicaciones primero asigna ubicaciones (paso 4). El informe puede imprimirse igual, sin resultados.';
  if (res && !distListo() && !S.ocupado) {
    conEspera('Preparando informe…', function () { getDist(); }).then(function () { if (S.tab === 'reportes') renderInforme(); });
    return;
  }
  renderInforme();
}
async function imprimirInforme() {
  if (S.proy.resultado && !distListo()) await conEspera('Preparando informe…', function () { getDist(); });
  renderInforme();
  await esperar(60);
  window.print();
}

/* ------------------------------------------------------------------ arranque y eventos */
function on(sel, ev, fn, opt) {
  var el = typeof sel === 'string' ? $(sel) : sel;
  if (el) el.addEventListener(ev, fn, opt);
}
function iniciar() {
  cv = $('#lienzo');
  ctx = cv.getContext('2d');

  var guardado = leerAutoguardado();
  var restaurado = false;
  try {
    S.proy = proyectoNormalizado(guardado || M.crearProyectoVacio());
    restaurado = !!guardado && hayContenido();
  } catch (e) {
    S.proy = proyectoNormalizado(M.crearProyectoVacio());
  }
  S.encajarPendiente = true;

  /* pasos */
  $$('#pasos .paso').forEach(function (b) { on(b, 'click', function () { irTab(b.getAttribute('data-tab')); }); });
  on('#nombre-proyecto', 'input', function (e) { S.proy.nombre = e.target.value || 'Almacén sin nombre'; guardarAutoDif(); });
  on('#btn-ejemplo', 'click', cargarEjemplo);
  on('#btn-nuevo', 'click', nuevoProyecto);

  /* barra del lienzo */
  $$('[data-herr]').forEach(function (b) {
    on(b, 'click', function () {
      var h = b.getAttribute('data-herr');
      if (S.tab !== 'plano' && h !== 'seleccionar' && h !== 'mano') return;
      if (S.herr === h && h !== 'seleccionar') { ponerHerr('seleccionar'); return; }
      if (h !== 'calibrar') S.calib = null;
      ponerHerr(h);
    });
  });
  on('#tb-undo', 'click', deshacer);
  on('#tb-redo', 'click', rehacer);
  on('#tb-encajar', 'click', function () { encajar(); });
  on('#tb-zoom-in', 'click', function () { zoomEn(1.3); actualizarEstadoLienzo(); });
  on('#tb-zoom-out', 'click', function () { zoomEn(1 / 1.3); actualizarEstadoLienzo(); });
  on('#sel-snap', 'change', pedirDibujo);
  on('#chk-grid', 'change', pedirDibujo);

  /* lienzo */
  on(cv, 'pointerdown', onDown);
  on(cv, 'pointermove', onMove);
  on(cv, 'pointerup', onUp);
  on(cv, 'pointercancel', onUp);
  on(cv, 'pointerleave', function () { if (S.rackHover) { S.rackHover = null; refrescarElevacion(); } });
  on(cv, 'dblclick', onDbl);
  on(cv, 'wheel', onWheel, { passive: false });
  on(cv, 'contextmenu', function (e) { e.preventDefault(); });
  on(document, 'keydown', onKey);
  on(document, 'keyup', onKeyUp);
  new ResizeObserver(function () { ajustarLienzo(); if (S.tab === 'asignar') refrescarElevacion(); if (S.tab === 'articulos') dibujarPareto(); }).observe($('#marco'));
  on(window, 'resize', function () { if (S.tab === 'articulos') dibujarPareto(); if (S.tab === 'asignar') refrescarElevacion(); if (S.tab === 'analisis' && S.analisis) dibujarAreas(S.analisis.res); });
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var cambio = function () { pedirDibujo(); if (S.tab === 'articulos') dibujarPareto(); if (S.tab === 'asignar') refrescarElevacion(); if (S.tab === 'analisis' && S.analisis) dibujarAreas(S.analisis.res); };
    if (mq.addEventListener) mq.addEventListener('change', cambio); else if (mq.addListener) mq.addListener(cambio);
  }

  /* Análisis */
  on('#an-calcular', 'click', calcularAnalisis);
  on('#an-sens-calc', 'click', calcularSensibilidad);
  on('#an-vacio', 'click', function (e) { var b = e.target.closest('[data-acc]'); if (b) accionVacio(b.getAttribute('data-acc')); });
  on('#an-esc', 'click', function (e) { var b = e.target.closest('[data-esc]'); if (b) aplicarEscenario(b.getAttribute('data-esc')); });

  /* estados vacíos (delegación) */
  on('#vacio', 'click', function (e) { var b = e.target.closest('[data-acc]'); if (b) accionVacio(b.getAttribute('data-acc')); });
  on('#art-vacio', 'click', function (e) {
    var b = e.target.closest('[data-acc]'); if (b) { accionVacio(b.getAttribute('data-acc')); return; }
    var a = e.target.closest('[data-acc-art]');
    if (a) {
      var v = a.getAttribute('data-acc-art');
      if (v === 'import') $('#inp-csv').click(); else if (v === 'plantilla') descargarPlantilla(); else if (v === 'add') anadirFila();
    }
  });

  /* Plano: imagen */
  on('#inp-imagen', 'change', function (e) { var f = e.target.files && e.target.files[0]; if (f) cargarArchivoImagen(f); e.target.value = ''; });
  on('#rng-opacidad', 'input', function (e) { S.proy.plano.opacidad = num(e.target.value, 0.5); pedirDibujo(); guardarAutoDif(); });
  on('#btn-quitar-imagen', 'click', function () {
    S.img = null; S.imgSrc = null; S.pix = null; S.traza = null; S.calib = null;
    mutar(function () { S.proy.plano.imagen = null; S.proy.plano.anchoPx = 0; S.proy.plano.altoPx = 0; }, { inv: false });
    $('#trz-panel').hidden = true; $('#form-calib').hidden = true;
    ponerHerr('seleccionar');
    refrescarTodo();
    aviso('Imagen quitada (el contorno y lo demás se conservan).', 'info');
  });
  var zs = $('#zona-soltar');
  ['dragenter', 'dragover'].forEach(function (ev) { on(zs, ev, function (e) { e.preventDefault(); zs.classList.add('sobre'); }); });
  ['dragleave', 'drop'].forEach(function (ev) { on(zs, ev, function () { zs.classList.remove('sobre'); }); });
  on(zs, 'keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#inp-imagen').click(); } });
  zs.tabIndex = 0;

  /* Plano: calibración */
  on('#btn-calibrar', 'click', function () {
    if (!S.proy.plano.imagen) { aviso('Primero sube una imagen del plano.', 'warn'); return; }
    S.calib = { pts: [] };
    $('#form-calib').hidden = true;
    ponerHerr('calibrar');
    pedirDibujo();
  });
  on('#btn-calib-ok', 'click', aplicarCalibracion);
  on('#btn-calib-cancel', 'click', cancelarCalibracion);
  on('#inp-metros', 'keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); aplicarCalibracion(); } else if (e.key === 'Escape') cancelarCalibracion(); });

  /* Plano: auto-trazo */
  on('#btn-autotrazo', 'click', function () {
    var pl = S.proy.plano;
    if (!pl.imagen) { aviso('Primero sube una imagen del plano (paso 1).', 'warn'); return; }
    if (!pl.mPorPx) { aviso('Calibra la escala antes de trazar (paso 2).', 'warn'); return; }
    S.traza = { semilla: null };
    $('#trz-panel').hidden = false;
    $('#btn-trz-ok').disabled = true;
    $('#trz-info').textContent = 'Haz clic dentro del almacén, sobre el piso libre de la imagen.';
    ponerHerr('trazo');
  });
  [['trz-umbral', 'out-umbral'], ['trz-tol', 'out-tol'], ['trz-areamin', 'out-areamin']].forEach(function (par) {
    on('#' + par[0], 'input', function (e) { $('#' + par[1]).textContent = e.target.value; if (S.traza && S.traza.semilla) recalcularTraza(false); });
  });
  on('#btn-trz-ok', 'click', aplicarTraza);
  on('#btn-trz-cancel', 'click', cancelarTraza);
  on('#btn-tpl-rect', 'click', function () {
    var a = num($('#tpl-ancho').value, 0), l = num($('#tpl-largo').value, 0);
    if (a <= 0 || l <= 0) { aviso('Escribe un ancho y un largo mayores que cero.', 'warn'); return; }
    plantillaRect(a, l);
  });
  on('#btn-tpl-l', 'click', function () {
    var at = num($('#l-ancho-total').value, 0), lt = num($('#l-largo-total').value, 0), ab = num($('#l-ancho-brazo').value, 0), lb = num($('#l-largo-brazo').value, 0);
    if (at <= 0 || lt <= 0 || ab <= 0 || lb <= 0) { aviso('Todas las medidas deben ser mayores que cero.', 'warn'); return; }
    if (ab >= at || lb >= lt) { aviso('El brazo debe ser más pequeño que el total (ancho y largo del brazo < ancho y largo total).', 'warn'); return; }
    plantillaL(at, lt, ab, lb);
  });

  /* Plano: selección */
  on('#sel-detalle', 'change', function (e) {
    var c = e.target.getAttribute && e.target.getAttribute('data-campo');
    if (c) editarSeleccion(c, e.target.value);
  });
  on('#sel-detalle', 'click', function (e) {
    if (e.target.closest('[data-acc-sel="borrar"]')) borrarSeleccion();
    else if (e.target.closest('[data-acc-sel="gen-zona"]')) generarEnZona();
  });
  on('#sel-detalle', 'change', function (e) { var zc = e.target.getAttribute && e.target.getAttribute('data-zcfg'); if (zc) editarZonaCfg(zc, e.target.value); });
  on('#chk-capa-evac', 'change', function (e) { S.capas.evac = !!e.target.checked; pedirDibujo(); });

  /* Racks */
  on('#sel-equipo', 'change', function (e) { cambiarEquipo(e.target.value); });
  ['inp-ancho-pasillo', 'inp-ancho-cruce', 'inp-altura-nave', 'inp-holgura', 'sel-rociador', 'inp-flue', 'inp-perfil-viga', 'inp-holgura-carga'].forEach(function (id) {
    on('#' + id, 'change', function () { var nt = []; mutar(function () { leerConfigRacks(); if (id === 'sel-rociador') { S.proy.config.holguraRociadores = null; $('#inp-holgura').value = ''; } acotarConfigRacks(nt); }); if (nt.length) aviso('Se ajustó el valor: ' + nt.join('; ') + '.', 'warn', 6000); });
  });
  on('#g-tipo', 'change', function () { var piso = $('#g-tipo').value === 'piso'; $$('.solo-piso').forEach(function (l) { l.hidden = !piso; }); });
  $$('.solo-piso').forEach(function (l) { l.hidden = $('#g-tipo').value !== 'piso'; });
  on('#btn-generar', 'click', generarRacks);
  on('#btn-rack-nuevo', 'click', anadirRack);
  on('#btn-rack-dup', 'click', duplicarRack);
  on('#btn-rack-rot', 'click', rotarRack);
  on('#btn-rack-borrar', 'click', function () {
    if (!S.sel || S.sel.tipo !== 'rack') { aviso('Selecciona un rack para borrarlo.', 'info'); return; }
    S.selVert = null; borrarSeleccion();
  });
  on('#btn-racks-borrar-auto', 'click', borrarRacksAuto);
  on('#rack-props', 'change', function (e) {
    var c = e.target.getAttribute && e.target.getAttribute('data-campo');
    if (c) editarRack(c, e.target.value, e.target.getAttribute('data-tipo') || (e.target.type === 'text' ? 't' : 's'));
  });

  /* Asignar */
  on('#btn-asignar', 'click', asignar);
  on('#a-peso-rec', 'input', function (e) {
    var v = num(e.target.value, 30);
    $('#out-peso-rec').textContent = v; $('#out-peso-desp').textContent = 100 - v;
    S.proy.config.pesoRecepcion = v / 100; opcionAsignarCambiada();
  });
  ['a-pasadas', 'a-sep', 'a-penal', 'a-abc-a', 'a-abc-b'].forEach(function (id) { on('#' + id, 'change', function () { leerOpcionesAsignar(); opcionAsignarCambiada(); if (S.tab === 'articulos') dibujarPareto(); }); });
  ['a-dimensionar', 'a-repos', 'a-pospick', 'a-afin', 'a-fecha', 'a-dias-venc', 'a-seg-usar'].forEach(function (id) {
    on('#' + id, 'change', function () { leerOpcionesAsignarV11(); opcionAsignarCambiada(); if (S.tab === 'articulos') { renderTablaArt(); renderResumenArt(); } });
  });
  ['d-evac', 'd-evac-ancho', 'd-carga-piso', 'm-rec', 'm-desp', 'm-dias-rec', 'm-dias-desp', 'm-m2', 'm-maniobra'].forEach(function (id) {
    on('#' + id, 'change', function () { mutar(function () { leerDatosSuyos(); }, { inv: false }); });
  });
  on('#seg-matriz', 'change', function (e) {
    var k = e.target.getAttribute('data-seg'), j = parseInt(e.target.getAttribute('data-sj'), 10);
    if (!k) return;
    editarMatrizSeg(function (sg) {
      var r = sg.matriz && sg.matriz[j]; if (!r) return;
      if (k === 'distMinM') { var d = String(e.target.value).trim() === '' ? null : num(e.target.value, null); r.distMinM = d !== null && d >= 0 ? clamp(d, 0, 500) : null; }
      else r[k] = enLista(e.target.value, PELIGROS, r[k]);
    });
  });
  on('#seg-matriz', 'click', function (e) {
    var q = e.target.closest('[data-seg-del]'), a = e.target.closest('[data-seg-acc]');
    if (q) { var j = parseInt(q.getAttribute('data-seg-del'), 10); editarMatrizSeg(function (sg) { sg.matriz.splice(j, 1); }); }
    else if (a) {
      var ac = a.getAttribute('data-seg-acc');
      editarMatrizSeg(function (sg) {
        if (ac === 'copiar') sg.matriz = clonar(matrizSegEfectiva().lista);
        else if (ac === 'defecto') sg.matriz = null;
        else if (ac === 'add') sg.matriz.push({ a: 'inflamable', b: 'oxidante', distMinM: null });
      });
    }
  });
  $$('input[name="vista"]').forEach(function (r) { on(r, 'change', function () { if (r.checked) { S.vistaMapa = r.value; pedirDibujo(); } }); });
  on('#btn-buscar', 'click', function () { buscarSku(); });
  on('#inp-sku', 'keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); buscarSku(); } });
  on('#inp-sku', 'change', function () { if ($('#inp-sku').value.trim() && S.proy.resultado) buscarSku(); });
  on('#btn-limpiar-busqueda', 'click', limpiarBusqueda);
  on('#canvas-elev', 'click', clicElevacion);
  on('#pos-detalle', 'click', function (e) {
    var b = e.target.closest('[data-acc-pos]'); if (!b) return;
    var a = b.getAttribute('data-acc-pos');
    if (a === 'mover') { S.moviendo = S.posSel; refrescarAsignarDetalle(); refrescarElevacion(); pedirDibujo(); aviso('Elige el hueco de destino en la elevación.', 'info', 4000); }
    else if (a === 'cancelar-mover') { S.moviendo = null; refrescarAsignarDetalle(); refrescarElevacion(); pedirDibujo(); }
    else if (a === 'buscar') { var s = S.proy.resultado && S.posSel ? S.proy.resultado.porPosicion[S.posSel] : null; if (s) buscarSku(s); }
  });

  /* Artículos */
  on('#art-add', 'click', anadirFila);
  on('#art-import', 'click', function () { $('#inp-csv').click(); });
  on('#inp-csv', 'change', function (e) { var f = e.target.files && e.target.files[0]; if (f) importarCSVArchivo(f); e.target.value = ''; });
  on('#art-export', 'click', csvArticulos);
  on('#art-plantilla', 'click', descargarPlantilla);
  on('#art-ejemplo', 'click', cargarEjemplo);
  on('#art-borrar-todo', 'click', async function () {
    if (!S.proy.productos.length) return;
    var ok = await preguntar('Borrar todos los artículos', 'Se borrarán los ' + S.proy.productos.length + ' artículos y se descartará la asignación. Puedes deshacer con Ctrl+Z.', [{ texto: 'Borrar todos', valor: true, peligro: true }, { texto: 'Cancelar', valor: null, primario: true }]);
    if (!ok) return;
    S.erroresCSV = null; S.avisosCSV = null; S.artSel = null;
    mutar(function () { S.proy.productos = []; });
  });
  on('#art-filtro', 'input', function (e) { S.filtroArt = e.target.value; S.pagArt = 0; renderTablaArt(); });
  on('#art-prev', 'click', function () { S.pagArt--; renderTablaArt(); });
  on('#art-next', 'click', function () { S.pagArt++; renderTablaArt(); });
  on('#tbody-art', 'change', function (e) {
    var t = e.target, c = t.getAttribute && t.getAttribute('data-c');
    if (!c) return;
    var tr = t.closest('tr'), i = parseInt(tr.getAttribute('data-i'), 10);
    editarArticulo(i, c, t.value);
  });
  on('#tbody-art', 'click', function (e) {
    var a = e.target.closest('[data-adv]');
    if (a) {
      var j = parseInt(a.getAttribute('data-adv'), 10);
      S.artSel = S.artSel === j ? null : j;
      renderTablaArt(); renderAvanzadoArt();
      if (S.artSel != null) { var det = $('#art-adv-caja'); det.open = true; det.scrollIntoView({ block: 'nearest' }); }
      return;
    }
    var b = e.target.closest('[data-del]'); if (!b) return;
    var i = parseInt(b.getAttribute('data-del'), 10);
    if (S.artSel === i) S.artSel = null; else if (S.artSel != null && S.artSel > i) S.artSel--;
    mutar(function () { S.proy.productos.splice(i, 1); });
  });
  on('#art-adv', 'change', function (e) {
    var t = e.target, av = t.getAttribute && t.getAttribute('data-av');
    if (av) { editarAvanzado(av, t.value, t.checked); return; }
    var lc = t.getAttribute && t.getAttribute('data-lc');
    if (lc) { var tr = t.closest('tr'); editarLote(parseInt(tr.getAttribute('data-lj'), 10), lc, t.value); }
  });
  on('#art-adv', 'click', function (e) {
    var q = e.target.closest('[data-lq]');
    var pr = S.artSel != null ? S.proy.productos[S.artSel] : null;
    if (!pr) return;
    if (q) { var j = parseInt(q.getAttribute('data-lq'), 10); mutar(function () { pr.lotes.splice(j, 1); }, { inv: true }); renderAvanzadoArt(); return; }
    if (e.target.closest('[data-lotes="add"]')) { mutar(function () { pr.lotes = pr.lotes || []; pr.lotes.push({ lote: 'L' + (pr.lotes.length + 1), cantidad: 0, vence: null }); }, { inv: true }); renderAvanzadoArt(); }
  });
  on('#ped-import', 'click', function () { $('#inp-ped').click(); });
  on('#inp-ped', 'change', function (e) { var f = e.target.files && e.target.files[0]; if (f) importarPedidosArchivo(f); e.target.value = ''; });
  on('#ped-plantilla', 'click', descargarPlantillaPedidos);
  on('#ped-afin', 'click', verAfinidad);
  on('#ped-borrar', 'click', async function () {
    if (!(S.proy.pedidos || []).length) return;
    var ok = await preguntar('Quitar los pedidos', 'Se quitarán ' + S.proy.pedidos.length + ' pedidos y se dejará de usar la afinidad. Puedes deshacer con Ctrl+Z.', [{ texto: 'Quitar pedidos', valor: true, peligro: true }, { texto: 'Cancelar', valor: null, primario: true }]);
    if (!ok) return;
    mutar(function () { S.proy.pedidos = []; }, { inv: true });
  });

  /* Reportes */
  on('#rep-csv-ubic', 'click', csvUbicaciones);
  on('#rep-csv-art', 'click', csvArticulos);
  on('#rep-png', 'click', exportarPNG);
  on('#rep-imprimir', 'click', imprimirInforme);
  on('#rep-guardar', 'click', guardarJSON);
  on('#rep-abrir', 'click', function () { $('#inp-json').click(); });
  on('#inp-json', 'change', function (e) { var f = e.target.files && e.target.files[0]; if (f) abrirJSONArchivo(f); e.target.value = ''; });
  on(window, 'beforeprint', function () { renderInforme(); });

  /* pegar y arrastrar archivos */
  on(document, 'paste', function (e) {
    var t = e.target; if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    var items = e.clipboardData && e.clipboardData.items ? e.clipboardData.items : [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf('image/') === 0) {
        var f = items[i].getAsFile();
        if (f) { e.preventDefault(); if (S.tab !== 'plano') irTab('plano'); cargarArchivoImagen(f); return; }
      }
    }
  });
  on(window, 'dragover', function (e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0) e.preventDefault(); });
  on(window, 'drop', function (e) {
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    var f = e.dataTransfer.files[0], nombre = (f.name || '').toLowerCase();
    if (/^image\//.test(f.type)) { if (S.tab !== 'plano') irTab('plano'); cargarArchivoImagen(f); }
    else if (/\.json$/.test(nombre)) abrirJSONArchivo(f);
    else if (/\.(csv|txt)$/.test(nombre)) { irTab('articulos'); importarCSVArchivo(f); }
    else aviso('Tipo de archivo no reconocido (usa imagen, .csv o .json).', 'warn');
  });

  /* valores iniciales de campos */
  llenarEquipos();
  sincronizarCampos();
  var h = (location.hash || '').replace('#', '');
  var tabInicial = ['plano', 'racks', 'articulos', 'asignar', 'analisis', 'reportes'].indexOf(h) >= 0 ? h : 'plano';
  S.encajarSiguiente = true;
  irTab(tabInicial);
  ajustarLienzo();
  if (restaurado) aviso('Se restauró tu proyecto «' + S.proy.nombre + '» (autoguardado en este navegador).', 'info', 5000);
  if (S.proy.resultado && !S.rackElev && S.proy.racks.length) S.rackElev = S.proy.racks[0].id;
  $('#estado-guardado').textContent = guardado ? 'Autoguardado activo' : 'Sin guardar aún';
  // exponer para pruebas manuales
  iniciarGuia(restaurado);
  window.AlmacenUI = { estado: S, encajar: encajar, irTab: irTab };
}
function opcionAsignarCambiada() {
  if (S.proy.resultado) S.opcionesCambiadas = true;
  guardarAutoDif();
  if (S.tab === 'asignar') refrescarAsignar();
}
/* ---- Guía de primeros pasos (v1.2): banner de bienvenida la 1.ª vez + diálogo paso a paso ---- */
var CLAVE_GUIA = 'almacen_guia_v1';
var GUIA_PASOS = [
  { tab: 'plano', t: '1 · Plano', h: '<p>Dibuja el contorno del almacén. Tienes tres formas:</p><ul><li><b>Subir la imagen</b> del plano (PNG/JPG), <b>calibrar la escala</b> con 2 clics y una medida real, y pulsar «Auto-trazar» (funciona con planos de líneas oscuras sobre fondo claro).</li><li>Usar una <b>plantilla</b> (rectángulo o forma en L) escribiendo las medidas.</li><li>Dibujar el contorno punto por punto.</li></ul><p>Marca también las <b>puertas</b> (recepción, despacho, salida de emergencia) y las <b>zonas</b> (frío, peligrosos, muelle…).</p>' },
  { tab: 'racks', t: '2 · Racks', h: '<p>Elige el <b>equipo</b> (carretilla, apilador…): define el ancho del pasillo. Luego pulsa <b>«Generar racks automáticamente»</b> y ajusta a mano lo que quieras (mover, rotar, duplicar).</p><p>Los avisos en vivo te dicen si un rack se solapa, queda fuera del contorno o deja un pasillo angosto.</p>' },
  { tab: 'articulos', t: '3 · Artículos', h: '<p>Carga tus SKU con su <b>cantidad, picks (salidas) por periodo, peso y alto</b>. Puedes escribirlos en la tabla o <b>importar un CSV</b>: pulsa «Descargar plantilla» para ver el formato exacto (separador <code>;</code>).</p><p>Opcional: importa tus <b>pedidos</b> para que el programa acerque los artículos que se piden juntos.</p>' },
  { tab: 'asignar', t: '4 · Asignar', h: '<p>Pulsa <b>«Asignar ubicaciones»</b>. El programa pone los artículos de más rotación cerca de la salida y a un nivel cómodo, respetando peso, altura, zonas y vencimientos.</p><p>Mira el mapa por clase ABC, busca un SKU para ver su ruta caminada y, si quieres, muévelo a mano. Todo supuesto aparece en pantalla.</p>' },
  { tab: 'analisis', t: '5 · Análisis', h: '<p>Pulsa <b>«Calcular análisis»</b>: áreas, densidad, utilización, déficit de capacidad, tiempos, muelle, evacuación y escenarios «¿qué pasa si…?». Cada resultado muestra su <b>fórmula con los números sustituidos</b>.</p><p>Los valores de referencia son típicos y deben verificarse con la ficha de tu equipo y con los profesionales competentes.</p>' },
  { tab: 'reportes', t: '6 · Reportes', h: '<p>Descarga los <b>CSV</b> de ubicaciones y artículos, el <b>PNG</b> del plano, o imprime el <b>informe</b> (en el diálogo de impresión elige «Guardar como PDF»).</p><p>Guarda tu proyecto como <b>.json</b> para abrirlo más tarde. Además, se autoguarda en este navegador. Nada sale de tu dispositivo.</p>' }
];
var guiaPaso = 0;
function guiaVista(v) { try { if (v === undefined) return localStorage.getItem(CLAVE_GUIA) === '1'; localStorage.setItem(CLAVE_GUIA, v ? '1' : '0'); } catch (e) { return false; } }
function pintarGuia() {
  var p = GUIA_PASOS[guiaPaso];
  $('#guia-prog').textContent = 'Paso ' + (guiaPaso + 1) + ' de ' + GUIA_PASOS.length;
  $('#guia-titulo').textContent = p.t;
  $('#guia-cuerpo').innerHTML = p.h;
  $('#guia-ant').disabled = guiaPaso === 0;
  $('#guia-sig').textContent = guiaPaso === GUIA_PASOS.length - 1 ? 'Listo' : 'Siguiente';
}
function abrirGuia(n) {
  guiaPaso = Math.max(0, Math.min(GUIA_PASOS.length - 1, n || 0));
  var d = $('#dlg-guia');
  pintarGuia();
  guiaVista(true); $('#banner-guia').hidden = true;
  if (d && !d.open) { if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', ''); }
}
function cerrarGuia() { var d = $('#dlg-guia'); if (d && d.open) { if (typeof d.close === 'function') d.close(); else d.removeAttribute('open'); } }
function iniciarGuia(yaTieneProyecto) {
  on('#btn-guia', 'click', function () { abrirGuia(0); });
  on('#guia-ant', 'click', function () { if (guiaPaso > 0) { guiaPaso--; pintarGuia(); } });
  on('#guia-sig', 'click', function () { if (guiaPaso < GUIA_PASOS.length - 1) { guiaPaso++; pintarGuia(); } else cerrarGuia(); });
  on('#guia-ir', 'click', function () { var t = GUIA_PASOS[guiaPaso].tab; cerrarGuia(); irTab(t); });
  on('#guia-cerrar', 'click', cerrarGuia);
  on('#banner-ver', 'click', function () { abrirGuia(0); });
  on('#banner-ejemplo', 'click', function () { $('#banner-guia').hidden = true; guiaVista(true); cargarEjemplo(); });
  on('#banner-cerrar', 'click', function () { $('#banner-guia').hidden = true; guiaVista(true); });
  // el aviso solo se muestra a quien llega por primera vez y todavía no tiene proyecto
  if (!yaTieneProyecto && !guiaVista()) $('#banner-guia').hidden = false;
}
function descargarPlantilla() {
  descargar('plantilla-articulos.csv', conBOM(M.plantillaCSVProductos()), 'text/csv;charset=utf-8');
  aviso('Plantilla CSV descargada.', 'ok');
}

iniciar();
})();
