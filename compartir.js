/*!
 * compartir.js — Compartir un proyecto por enlace (v1.2). UMD: `window.AlmacenCompartir` y `module.exports`.
 *
 * Formato del texto:  «v1.» + base64url( gzip( JSON del proyecto ) ).  El proyecto viaja SIN imagen del plano, SIN logo y SIN resultado
 * (se recalcula con «Asignar»). En la página va como fragmento (#compartir=…): el fragmento no se envía a ningún servidor.
 *
 * Seguridad: un enlace es ENTRADA NO CONFIABLE.
 *   - tope de entrada (400 000 caracteres) y de salida descomprimida (8 MB, se corta leyendo por trozos: protege de «bombas de compresión»);
 *   - JSON.parse dentro de try/catch; claves peligrosas (__proto__, constructor/prototype con objetos) y anidación excesiva se rechazan/limpian;
 *   - el resultado SIEMPRE pasa por AlmacenMotor.normalizarConAvisos; la interfaz además lo normaliza otra vez y pide confirmación antes de cargarlo.
 *   - nunca lanza una excepción sin capturar: decodificar() siempre resuelve { ok:false, motivo } si algo falla.
 */
(function (raiz, fabrica) {
  'use strict';
  if (typeof module === 'object' && module && module.exports) {
    module.exports = fabrica(function () { try { return require('./motor.js'); } catch (e) { return null; } });
  } else {
    raiz.AlmacenCompartir = fabrica(function () { return raiz.AlmacenMotor || null; });
  }
})(typeof self !== 'undefined' ? self : this, function (cargarMotor) {
  'use strict';

  var PREFIJO = 'v1.';
  var TOPE_ENTRADA = 400000;          // caracteres del texto
  var TOPE_SALIDA = 8 * 1024 * 1024;  // bytes descomprimidos
  var AVISO_CHATS = 8000, TOPE_ENLACE = 200000;
  var PROFUNDIDAD_MAX = 40;

  function motor() { try { return cargarMotor(); } catch (e) { return null; } }
  function esObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }

  /** ¿Este navegador puede comprimir y descomprimir? (si no, se ofrece el .json) */
  function soportado() {
    return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function' && typeof TextEncoder === 'function' && typeof TextDecoder === 'function' && typeof Blob === 'function';
  }

  /* ---------------------------------------------------------------- base64url */
  function aBase64Url(bytes) {
    var s = '', paso = 0x8000;
    for (var i = 0; i < bytes.length; i += paso) s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(bytes.length, i + paso)));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function deBase64Url(t) {
    if (!/^[A-Za-z0-9_-]*$/.test(t) || t.length % 4 === 1) throw new Error('base64 inválido');
    var b = t.replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    var bin = atob(b), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* ---------------------------------------------------------------- compresión por flujos */
  async function leerFlujo(flujo, tope) {
    var lector = flujo.getReader(), trozos = [], total = 0;
    for (;;) {
      var r = await lector.read();
      if (r.done) break;
      total += r.value.length;
      if (total > tope) { try { await lector.cancel(); } catch (e) { /* ya cortado */ } var err = new Error('salida demasiado grande'); err.codigo = 'bomba'; throw err; }
      trozos.push(r.value);
    }
    var out = new Uint8Array(total), pos = 0;
    trozos.forEach(function (t) { out.set(t, pos); pos += t.length; });
    return out;
  }
  async function comprimir(bytes) { return leerFlujo(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')), 64 * 1024 * 1024); }
  async function descomprimir(bytes) { return leerFlujo(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')), TOPE_SALIDA); }

  /* ---------------------------------------------------------------- saneamiento de lo que viene de fuera */
  /** Recorre el JSON (sin recursión) y quita claves peligrosas. Devuelve false si la anidación es excesiva. */
  function limpiarClaves(raizObj) {
    var pila = [[raizObj, 0]];
    while (pila.length) {
      var par = pila.pop(), o = par[0], d = par[1];
      if (d > PROFUNDIDAD_MAX) return false;
      if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) if (o[i] && typeof o[i] === 'object') pila.push([o[i], d + 1]); continue; }
      var ks = Object.keys(o);
      for (var j = 0; j < ks.length; j++) {
        var k = ks[j], v = o[k];
        if (k === '__proto__' || ((k === 'constructor' || k === 'prototype') && v && typeof v === 'object')) { delete o[k]; continue; }
        if (v && typeof v === 'object') pila.push([v, d + 1]);
      }
    }
    return true;
  }
  var LISTAS_OBJ = ['huecos', 'puertas', 'zonas', 'racks', 'productos', 'pedidos'];
  var TOPES_LISTA = { huecos: 2000, puertas: 200, zonas: 500, racks: 20000, productos: 50000, pedidos: 20000, contorno: 5000 };
  function preparar(o) {
    var p = Object.assign({}, o);
    Object.keys(TOPES_LISTA).forEach(function (k) {
      if (!Array.isArray(p[k])) { if (k in p) p[k] = []; return; }
      p[k] = p[k].slice(0, TOPES_LISTA[k]);
      if (LISTAS_OBJ.indexOf(k) >= 0) p[k] = p[k].filter(esObj);
    });
    // nunca se aceptan imágenes, logos ni resultados por enlace
    p.resultado = null;
    p.plano = esObj(p.plano) ? Object.assign({}, p.plano, { imagen: null, anchoPx: 0, altoPx: 0 }) : p.plano;
    if (esObj(p.marca)) p.marca = Object.assign({}, p.marca, { logo: null });
    return p;
  }

  /* ---------------------------------------------------------------- API */
  /** Copia del proyecto lista para viajar: sin imagen, sin logo, sin resultado. */
  function copiaParaCompartir(proyecto) {
    var c = JSON.parse(JSON.stringify(proyecto, function (k, v) { return k === 'imagen' && v && typeof v === 'string' && v.indexOf('data:') === 0 ? null : v; }));
    if (esObj(c.plano)) { c.plano.imagen = null; c.plano.anchoPx = 0; c.plano.altoPx = 0; }
    if (esObj(c.marca)) c.marca.logo = null;
    c.resultado = null;
    return c;
  }

  async function codificar(proyecto) {
    var avisos = [];
    if (!esObj(proyecto)) return { ok: false, motivo: 'No hay proyecto que compartir.', texto: '', caracteres: 0, avisos: avisos, incluyeImagen: false };
    if (!soportado()) return { ok: false, motivo: 'Este navegador no puede comprimir el enlace (falta CompressionStream). Usa «Guardar proyecto (.json)».', texto: '', caracteres: 0, avisos: avisos, incluyeImagen: false };
    try {
      var copia = copiaParaCompartir(proyecto);
      var json = JSON.stringify(copia);
      var bytes = await comprimir(new TextEncoder().encode(json));
      var texto = PREFIJO + aBase64Url(bytes);
      if (texto.length > TOPE_ENTRADA) return { ok: false, motivo: 'El proyecto es demasiado grande para un enlace (' + texto.length + ' caracteres). Usa «Guardar proyecto (.json)».', texto: '', caracteres: texto.length, avisos: avisos, incluyeImagen: false };
      if (texto.length > TOPE_ENLACE) avisos.push('El enlace tiene ' + texto.length + ' caracteres: es demasiado largo para compartirlo; usa el archivo .json.');
      else if (texto.length > AVISO_CHATS) avisos.push('El enlace tiene ' + texto.length + ' caracteres: algunos chats lo cortan; usa mejor el archivo .json.');
      if (proyecto.plano && typeof proyecto.plano.imagen === 'string' && proyecto.plano.imagen) avisos.push('La imagen del plano no viaja en el enlace.');
      if (proyecto.marca && typeof proyecto.marca.logo === 'string' && proyecto.marca.logo) avisos.push('El logo no viaja en el enlace.');
      return { ok: true, texto: texto, caracteres: texto.length, avisos: avisos, incluyeImagen: false, ofrecerEnlace: texto.length <= TOPE_ENLACE };
    } catch (e) {
      return { ok: false, motivo: 'No se pudo preparar el enlace: ' + (e && e.message ? e.message : 'error'), texto: '', caracteres: 0, avisos: avisos, incluyeImagen: false };
    }
  }

  /** Acepta el texto solo, «#compartir=…», «compartir=…» o una URL completa que lo contenga. */
  function extraerTexto(entrada) {
    var t = String(entrada == null ? '' : entrada).trim();
    var i = t.indexOf('#compartir=');
    if (i >= 0) t = t.slice(i + '#compartir='.length);
    else if (t.indexOf('compartir=') === 0) t = t.slice('compartir='.length);
    return t;
  }
  function fallo(motivo, avisos) { return { ok: false, motivo: motivo, proyecto: null, avisos: avisos || [], resumen: null }; }

  async function decodificar(entrada) {
    try {
      if (typeof entrada !== 'string') return fallo('El enlace no es un texto.');
      var texto = extraerTexto(entrada);
      if (!texto) return fallo('El enlace está vacío.');
      if (texto.length > TOPE_ENTRADA) return fallo('El enlace es demasiado largo (más de ' + TOPE_ENTRADA + ' caracteres) y se rechazó.');
      var m = /^v(\d+)\./.exec(texto);
      if (!m) return fallo('El enlace no tiene el formato de este programa.');
      if (texto.indexOf(PREFIJO) !== 0) return fallo('El enlace es de una versión desconocida (v' + m[1] + '): este programa solo entiende la v1.');
      if (!soportado()) return fallo('Este navegador no puede abrir enlaces comprimidos (falta DecompressionStream). Pide el archivo .json.');
      var comp;
      try { comp = deBase64Url(texto.slice(PREFIJO.length)); } catch (e1) { return fallo('El enlace está dañado (texto no válido).'); }
      if (comp.length < 18) return fallo('El enlace está dañado (demasiado corto).');
      var crudo;
      try { crudo = await descomprimir(comp); }
      catch (e2) { return fallo(e2 && e2.codigo === 'bomba' ? 'El enlace se descomprime a más de 8 MB: se rechazó por seguridad.' : 'El enlace está dañado o incompleto (no se pudo descomprimir).'); }
      var json;
      try { json = new TextDecoder('utf-8', { fatal: true }).decode(crudo); } catch (e3) { return fallo('El enlace está dañado (texto no válido).'); }
      var obj;
      try { obj = JSON.parse(json); } catch (e4) { return fallo('El contenido del enlace no es un proyecto válido (JSON roto).'); }
      if (!esObj(obj)) return fallo('El contenido del enlace no es un proyecto.');
      if (!limpiarClaves(obj)) return fallo('El contenido del enlace está demasiado anidado y se rechazó.');
      if (!('contorno' in obj || 'racks' in obj || 'productos' in obj || 'plano' in obj)) return fallo('El enlace no parece un proyecto de este programa.');
      var M = motor();
      if (!M || typeof M.normalizarConAvisos !== 'function') return fallo('Falta el motor para validar el proyecto.');
      var r = M.normalizarConAvisos(preparar(obj));
      var p = r && r.proyecto;
      if (!esObj(p)) return fallo('No se pudo validar el proyecto del enlace.');
      p.resultado = null;
      if (esObj(p.plano)) p.plano.imagen = null;
      if (esObj(p.marca)) p.marca.logo = null;
      var nombre = typeof p.nombre === 'string' ? p.nombre.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
      var resumen = { nombre: nombre || 'Almacén sin nombre', racks: Array.isArray(p.racks) ? p.racks.length : 0, skus: Array.isArray(p.productos) ? p.productos.length : 0, posiciones: (typeof M.limitarPosicionesRacks === 'function' && Array.isArray(p.racks)) ? M.limitarPosicionesRacks(p.racks).posiciones : null };
      return { ok: true, proyecto: p, avisos: (r.avisos || []).slice(0, 50).map(String), resumen: resumen };
    } catch (e) {
      return fallo('No se pudo abrir el enlace: ' + (e && e.message ? e.message : 'error'));
    }
  }

  /** URL para pegar en un chat. `ubic` = location (o algo con origin y pathname). */
  function construirEnlace(texto, ubic) {
    var u = ubic || (typeof location !== 'undefined' ? location : { origin: '', pathname: '' });
    var origen = u.origin && u.origin !== 'null' ? u.origin : (u.protocol || 'file:') + '//';
    return origen + (u.pathname || '/') + '#compartir=' + texto;
  }
  /** ¿Este fragmento (location.hash) es un enlace compartido? → texto o null. */
  function textoDeHash(hash) {
    var h = String(hash || '');
    return h.indexOf('#compartir=') === 0 ? h.slice('#compartir='.length) : null;
  }

  return {
    soportado: soportado, codificar: codificar, decodificar: decodificar, construirEnlace: construirEnlace, textoDeHash: textoDeHash,
    copiaParaCompartir: copiaParaCompartir,
    TOPE_ENTRADA: TOPE_ENTRADA, TOPE_SALIDA: TOPE_SALIDA, AVISO_CHATS: AVISO_CHATS, TOPE_ENLACE: TOPE_ENLACE
  };
});
