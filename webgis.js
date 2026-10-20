/* =====================================================================
   PD-SLZ WebGIS – base geográfica (polígonos, linhas e pontos) + dados do app de campo (Supabase)
   Relação: feição da base (pd_geo_feicoes.id_ativo) = levantamento (pd_levantamentos.codigo_ativo).
   Sem o código, o vínculo é sugerido pela posição (GPS dentro do polígono, perto da linha ou do ponto)
   e confirmado pelo coordenador. Sem bibliotecas externas (exceto JSZip, para KMZ e Shapefile).
   Versão 1.1.0
   ===================================================================== */
'use strict';
(() => {
  const VERSAO = '1.1.0';
  // configuração: config.js + a mesma conexão salva pelo app de campo neste navegador (link #cfg=…)
  const CFG = (() => {
    const c = Object.assign({}, window.PD_CONFIG || {});
    try {
      const m = location.hash.match(/cfg=([^&]+)/);
      if (m) {
        const o = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(m[1])))));
        if (o.u && o.k) { const l = JSON.parse(localStorage.getItem('pdslz_cfg') || '{}'); Object.assign(l, { supabaseUrl: o.u, supabaseKey: o.k }); localStorage.setItem('pdslz_cfg', JSON.stringify(l)); }
        history.replaceState(null, '', location.pathname);
      }
    } catch (e) { /* link inválido */ }
    try { const l = JSON.parse(localStorage.getItem('pdslz_cfg') || '{}'); ['supabaseUrl', 'supabaseKey', 'bucket'].forEach((k) => { if (l[k]) c[k] = l[k]; }); } catch (e) { /* sem armazenamento */ }
    return c;
  })();
  const CAT = window.PD_CAT || { escopos: [], temas: [], params: {} };

  /* ------------------------------------------------------------ utilidades */
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (v, d = 0) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: d, minimumFractionDigits: 0 }));
  const pct = (v) => (v == null || !isFinite(v) ? '—' : Math.round(Number(v) * 100) + '%');
  const brData = (iso) => (iso ? `${String(iso).slice(8, 10)}/${String(iso).slice(5, 7)}/${String(iso).slice(0, 4)}` : '—');
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  function toast(msg, ms = 4200) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), ms); }
  function baixar(conteudo, nome, tipo) { const b = conteudo instanceof Blob ? conteudo : new Blob([conteudo], { type: tipo }); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = nome; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(u); a.remove(); }, 1500); }
  const hojeTag = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };

  /* ------------------------------------------------------------ catálogo e cores */
  const ESC = {}; CAT.escopos.forEach((e) => { ESC[e.cod] = e; });
  const TEMA = {}; CAT.temas.forEach((t) => { TEMA[t.cod] = t.nome; });
  const PARAM = Object.assign({ indice_bom: 0.9, indice_atencao: 0.7, indice_ruim: 0.5 }, CAT.params || {});
  const CINZA = '#8C9A95';
  const corIdx = (v) => (v == null || !isFinite(v) ? CINZA : v >= PARAM.indice_bom ? '#1E7B47' : v >= PARAM.indice_atencao ? '#D9A400' : v >= PARAM.indice_ruim ? '#E0601C' : '#B71C1C');
  const COR_CRIT = { 'Crítica': '#B71C1C', 'Alta': '#E0601C', 'Média': '#D9A400', 'Baixa': '#6D9F3B', 'Melhoria': '#2B67B1', 'A classificar': '#8C9A95' };
  const COR_SIT = { confirmado: '#1E7B47', sugerido: '#2B67B1', sem: '#8C9A95', codigo: '#8E44AD', contexto: '#F5C400' };
  const ROT_SIT = { confirmado: 'Levantado (vínculo confirmado)', sugerido: 'Sugestão pela posição', sem: 'Não levantado', codigo: 'Código na base sem levantamento', contexto: 'Camada de contexto' };
  const COR_COND = { 5: '#1E7B47', 4: '#6D9F3B', 3: '#D9A400', 2: '#E0601C', 1: '#B71C1C' };
  const ORD_CRIT = { 'Crítica': 1, 'Alta': 2, 'Média': 3, 'Baixa': 4, 'Melhoria': 5, 'A classificar': 6 };
  const textoSobre = (hex) => { const h = hex.replace('#', ''); const r = parseInt(h.substr(0, 2), 16); const g = parseInt(h.substr(2, 2), 16); const b = parseInt(h.substr(4, 2), 16); return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#14201C' : '#fff'; };
  const selo = (txt, cor) => `<span class="selo" style="background:${cor};color:${textoSobre(cor)}">${esc(txt)}</span>`;

  /* ------------------------------------------------------------ Supabase (Auth + REST + Storage) */
  class ErroSB extends Error {
    constructor(status, corpo) {
      const j = corpo || {};
      let m = j.message || j.msg || j.error_description || j.error || `Erro ${status}`;
      if (j.code === '42501' || status === 403 || /row-level security/i.test(m)) m = 'Sem permissão para esta operação (seu papel não permite)';
      else if (j.code === '42P01' || j.code === 'PGRST205') m = 'Tabela não encontrada: rode o script 06_webgis_base_geografica.sql no Supabase';
      else if (j.code === '23505') m = 'Código já vinculado a outra feição: ' + (j.details || m);
      else if (status === 401) m = 'Sessão expirada: entre novamente';
      super(m); this.status = status; this.corpo = j;
    }
  }
  const CHAVE_SESSAO = 'pdslz_webgis_sessao';
  const SB = {
    sessao: null,
    url: String(CFG.supabaseUrl || '').trim().replace(/\/+$/, ''),
    key: String(CFG.supabaseKey || '').trim(),
    bucket: CFG.bucket || 'pd-fotos',
    configurado() { return /^https?:\/\//.test(this.url) && this.key.length > 20; },
    async auth(caminho, corpo) {
      let r;
      try { r = await fetch(`${this.url}/auth/v1/${caminho}`, { method: 'POST', headers: { apikey: this.key, 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) }); }
      catch (e) { throw new Error('Sem conexão com o servidor'); }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = (j.error_description || j.msg || j.message || '').toLowerCase();
        throw new ErroSB(r.status, { message: /invalid login|invalid_grant|credentials/.test(msg) ? 'E-mail ou senha incorretos' : (j.error_description || j.msg || j.message || `Erro ${r.status}`) });
      }
      return j;
    },
    guardar(j) {
      this.sessao = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600),
        user: { id: (j.user && j.user.id) || (this.sessao && this.sessao.user.id), email: (j.user && j.user.email) || (this.sessao && this.sessao.user.email) } };
      try { localStorage.setItem(CHAVE_SESSAO, JSON.stringify(this.sessao)); } catch (e) { /* sem armazenamento */ }
    },
    restaurar() { try { this.sessao = JSON.parse(localStorage.getItem(CHAVE_SESSAO) || 'null'); } catch (e) { this.sessao = null; } },
    async login(email, senha) { this.guardar(await this.auth('token?grant_type=password', { email, password: senha })); },
    async renovar() { if (!this.sessao) throw new ErroSB(401, {}); this.guardar(await this.auth('token?grant_type=refresh_token', { refresh_token: this.sessao.refresh_token })); },
    async token() { if (!this.sessao) throw new ErroSB(401, {}); if (this.sessao.expires_at - Date.now() / 1000 < 120) await this.renovar(); return this.sessao.access_token; },
    async req(caminho, o = {}) {
      const tentar = async () => {
        const h = Object.assign({ apikey: this.key, Authorization: 'Bearer ' + (await this.token()) }, o.headers || {});
        let body = o.body;
        if (body !== undefined && !(body instanceof Blob)) { h['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
        if (o.prefer) h.Prefer = o.prefer;
        try { return await fetch(this.url + caminho, { method: o.method || 'GET', headers: h, body }); } catch (e) { throw new Error('Sem conexão com o servidor'); }
      };
      let r = await tentar();
      if (r.status === 401) { await this.renovar(); r = await tentar(); }
      if (!r.ok) { let j = null; try { j = await r.json(); } catch (e) { /* sem corpo */ } throw new ErroSB(r.status, j); }
      const txt = await r.text();
      return txt ? JSON.parse(txt) : null;
    },
    select(tab, q = 'select=*') { return this.req(`/rest/v1/${tab}?${q}`); },
    async tudo(tab, q = 'select=*') {
      const out = [];
      for (let off = 0; ; off += 1000) { const lote = await this.select(tab, `${q}&limit=1000&offset=${off}`); out.push(...lote); if (lote.length < 1000) break; }
      return out;
    },
    rpc(fn, args) { return this.req(`/rest/v1/rpc/${fn}`, { method: 'POST', body: args }); },
    inserir(tab, linhas) { return this.req(`/rest/v1/${tab}`, { method: 'POST', body: linhas, prefer: 'return=minimal' }); },
    apagar(tab, filtro) { return this.req(`/rest/v1/${tab}?${filtro}`, { method: 'DELETE', prefer: 'return=minimal' }); },
    async assinar(caminhos, seg = 3600) {
      if (!caminhos.length) return [];
      const r = await this.req(`/storage/v1/object/sign/${this.bucket}`, { method: 'POST', body: { expiresIn: seg, paths: caminhos } });
      return (r || []).map((x) => ({ path: x.path, url: x.signedURL ? (/^https?:/.test(x.signedURL) ? x.signedURL : `${this.url}/storage/v1${x.signedURL}`) : null }));
    },
    sair() { try { fetch(`${this.url}/auth/v1/logout`, { method: 'POST', headers: { apikey: this.key, Authorization: 'Bearer ' + (this.sessao && this.sessao.access_token) } }); } catch (e) { /* offline */ } this.sessao = null; try { localStorage.removeItem(CHAVE_SESSAO); } catch (e) { /* ok */ } },
  };

  /* ------------------------------------------------------------ geometria */
  // mundo Web Mercator normalizado (0..1)
  const mx = (lon) => (lon + 180) / 360;
  const my = (lat) => { const s = Math.sin(clamp(lat, -85.05, 85.05) * Math.PI / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
  const lonDe = (x) => x * 360 - 180;
  const latDe = (y) => { const n = Math.PI - 2 * Math.PI * y; return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };
  // métrico local (equirretangular em torno da latitude de referência do site)
  let LAT0 = -2.56; let KX = 111320 * Math.cos(LAT0 * Math.PI / 180); const KY = 110574;
  const mLoc = (p) => [p[0] * KX, p[1] * KY];
  function distSeg(p, a, b) {
    const dx = b[0] - a[0]; const dy = b[1] - a[1]; const L = dx * dx + dy * dy;
    let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0; t = clamp(t, 0, 1);
    const qx = a[0] + t * dx; const qy = a[1] + t * dy;
    return { d: Math.hypot(p[0] - qx, p[1] - qy), q: [qx, qy] };
  }
  function dentroAnel(p, anel) {
    let ins = false;
    for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
      const xi = anel[i][0]; const yi = anel[i][1]; const xj = anel[j][0]; const yj = anel[j][1];
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) ins = !ins;
    }
    return ins;
  }
  const dentroPoligono = (p, poli) => dentroAnel(p, poli[0]) && !poli.slice(1).some((h) => dentroAnel(p, h));
  const areaAnel = (a) => { let s = 0; for (let i = 0; i < a.length; i++) { const j = (i + 1) % a.length; s += a[i][0] * a[j][1] - a[j][0] * a[i][1]; } return s / 2; };
  const compLinha = (l) => { let s = 0; for (let i = 1; i < l.length; i++) s += Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]); return s; };

  // GeoJSON → {tipo, partes} com coordenadas [lon, lat]
  function normGeom(g) {
    if (!g || !g.type) return null;
    const c = g.coordinates;
    switch (g.type) {
      case 'Point': return { tipo: 'ponto', partes: [c] };
      case 'MultiPoint': return { tipo: 'ponto', partes: c };
      case 'LineString': return { tipo: 'linha', partes: [c] };
      case 'MultiLineString': return { tipo: 'linha', partes: c };
      case 'Polygon': return { tipo: 'poligono', partes: [c] };
      case 'MultiPolygon': return { tipo: 'poligono', partes: c };
      default: return null;
    }
  }
  // distância (m) de um ponto [lon,lat] à geometria normalizada; 0 se dentro do polígono
  function distGeom(ll, ng) {
    const p = mLoc(ll); let best = { d: Infinity, q: null };
    const testa = (r) => { if (r.d < best.d) best = r; };
    if (ng.tipo === 'ponto') ng.partes.forEach((q) => { const m = mLoc(q); testa({ d: Math.hypot(p[0] - m[0], p[1] - m[1]), q: m }); });
    else if (ng.tipo === 'linha') ng.partes.forEach((l) => { const m = l.map(mLoc); for (let i = 1; i < m.length; i++) testa(distSeg(p, m[i - 1], m[i])); if (m.length === 1) testa({ d: Math.hypot(p[0] - m[0][0], p[1] - m[0][1]), q: m[0] }); });
    else {
      for (const poli of ng.partes) {
        const mp = poli.map((a) => a.map(mLoc));
        if (dentroPoligono(p, mp)) return { d: 0, q: ll.slice(0, 2), dentro: true };
        mp.forEach((anel) => { for (let i = 1; i < anel.length; i++) testa(distSeg(p, anel[i - 1], anel[i])); });
      }
    }
    return best.q ? { d: best.d, q: [best.q[0] / KX, best.q[1] / KY] } : best;
  }
  function medidas(ng) {
    if (ng.tipo === 'poligono') { let a = 0; ng.partes.forEach((poli) => poli.forEach((anel, i) => { const v = Math.abs(areaAnel(anel.map(mLoc))); a += i === 0 ? v : -v; })); return { area: a, comp: null }; }
    if (ng.tipo === 'linha') return { area: null, comp: ng.partes.reduce((s, l) => s + compLinha(l.map(mLoc)), 0) };
    return { area: null, comp: null };
  }
  function centro(ng) {
    if (ng.tipo === 'ponto') return ng.partes[0];
    if (ng.tipo === 'linha') { const l = ng.partes[0]; return l[Math.floor(l.length / 2)]; }
    const anel = ng.partes[0][0]; let x = 0; let y = 0; let a = 0;
    for (let i = 0; i < anel.length - 1; i++) { const f = anel[i][0] * anel[i + 1][1] - anel[i + 1][0] * anel[i][1]; x += (anel[i][0] + anel[i + 1][0]) * f; y += (anel[i][1] + anel[i + 1][1]) * f; a += f; }
    if (!a) return anel[0];
    const c = [x / (3 * a), y / (3 * a)];
    return dentroPoligono(c, ng.partes[0]) ? c : anel[0];
  }

  /* ------------------------------------------------------------ sistemas de coordenadas (SIRGAS 2000 / UTM → WGS 84) */
  // GRS 80 (SIRGAS 2000) ≈ WGS 84 para fins de cadastro (diferença centimétrica)
  function utmParaGeo(E, N, zona, sul) {
    const a = 6378137; const f = 1 / 298.257222101; const k0 = 0.9996;
    const e2 = f * (2 - f); const ep2 = e2 / (1 - e2);
    const x = E - 500000; const y = sul ? N - 10000000 : N;
    const M = y / k0; const mu = M / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256));
    const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
    const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
      + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
    const s = Math.sin(p1); const c = Math.cos(p1); const t = Math.tan(p1);
    const C1 = ep2 * c * c; const T1 = t * t; const N1 = a / Math.sqrt(1 - e2 * s * s); const R1 = a * (1 - e2) / Math.pow(1 - e2 * s * s, 1.5); const D = x / (N1 * k0);
    const lat = p1 - (N1 * t / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24 + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720);
    const lon = (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / c;
    return [((zona * 6 - 183) * Math.PI / 180 + lon) * 180 / Math.PI, lat * 180 / Math.PI];
  }
  // CRS suportados: {cod, nome, conv([x,y]) → [lon,lat]}
  function crsDe(cod) {
    cod = String(cod || '').toUpperCase().replace('EPSG:', '');
    const n = parseInt(cod, 10);
    const geo = (nome) => ({ cod: String(n), nome, conv: (p) => [p[0], p[1]] });
    if (n === 4326) return geo('WGS 84 (graus)');
    if (n === 4674) return geo('SIRGAS 2000 (graus)');
    if (n === 3857 || n === 900913) return { cod: '3857', nome: 'Web Mercator', conv: (p) => [p[0] / 6378137 * 180 / Math.PI, (2 * Math.atan(Math.exp(p[1] / 6378137)) - Math.PI / 2) * 180 / Math.PI] };
    if (n >= 31977 && n <= 31985) { const z = n - 31960; return { cod: String(n), nome: `SIRGAS 2000 / UTM ${z}S`, conv: (p) => utmParaGeo(p[0], p[1], z, true) }; }
    if (n >= 31965 && n <= 31976) { const z = n - 31954; return { cod: String(n), nome: `SIRGAS 2000 / UTM ${z}N`, conv: (p) => utmParaGeo(p[0], p[1], z, false) }; }
    if (n >= 32718 && n <= 32725) { const z = n - 32700; return { cod: String(n), nome: `WGS 84 / UTM ${z}S`, conv: (p) => utmParaGeo(p[0], p[1], z, true) }; }
    if (n >= 32618 && n <= 32625) { const z = n - 32600; return { cod: String(n), nome: `WGS 84 / UTM ${z}N`, conv: (p) => utmParaGeo(p[0], p[1], z, false) }; }
    return null;
  }
  const CRS_OPCOES = ['4326', '4674', '31982', '31983', '31984', '32722', '32723', '32724', '3857'];
  function crsDeWkt(wkt) {
    if (!wkt) return null;
    const up = wkt.toUpperCase();
    const auth = up.match(/AUTHORITY\["EPSG","(\d+)"\]\]\s*$/) || up.match(/ID\["EPSG",(\d+)\]\]\s*$/);
    if (auth && crsDe(auth[1])) return crsDe(auth[1]);
    if (/SAD[ _]?69|CORREGO|C[OÓ]RREGO/.test(up)) return { cod: 'SAD69', nome: 'SAD 69 / Córrego Alegre (não suportado)', conv: null };
    const z = up.match(/UTM[ _]?ZONE[ _]?(\d{1,2})([NS])/);
    if (z) { const zn = +z[1]; const sul = z[2] === 'S'; if (/SIRGAS/.test(up)) return crsDe(sul ? 31960 + zn : 31954 + zn); return crsDe(sul ? 32700 + zn : 32600 + zn); }
    if (/PSEUDO.MERCATOR|WEB.MERCATOR|3857/.test(up)) return crsDe(3857);
    if (/GEOGCS|GEOGCRS/.test(up) && !/PROJCS|PROJCRS/.test(up)) return crsDe(/SIRGAS/.test(up) ? 4674 : 4326);
    return null;
  }
  function adivinharCrs(amostra) {
    if (!amostra) return crsDe(4326);
    const [x, y] = amostra;
    if (Math.abs(x) <= 180 && Math.abs(y) <= 90) return crsDe(4326);
    if (x > 100000 && x < 900000 && y > 8000000 && y < 10000001) return crsDe(31983);
    if (Math.abs(x) < 2.1e7 && Math.abs(y) < 2.1e7) return crsDe(3857);
    return null;
  }
  function converterGeom(g, conv) {
    const r = (p) => { const q = conv(p); return [Math.round(q[0] * 1e7) / 1e7, Math.round(q[1] * 1e7) / 1e7]; };
    const rl = (l) => l.map(r);
    const fecha = (a) => { const b = rl(a); if (b.length && (b[0][0] !== b[b.length - 1][0] || b[0][1] !== b[b.length - 1][1])) b.push(b[0].slice()); return b; };
    switch (g.type) {
      case 'Point': return { type: 'Point', coordinates: r(g.coordinates) };
      case 'MultiPoint': return { type: 'MultiPoint', coordinates: rl(g.coordinates) };
      case 'LineString': return { type: 'MultiLineString', coordinates: [rl(g.coordinates)] };
      case 'MultiLineString': return { type: 'MultiLineString', coordinates: g.coordinates.map(rl) };
      case 'Polygon': return { type: 'MultiPolygon', coordinates: [g.coordinates.map(fecha)] };
      case 'MultiPolygon': return { type: 'MultiPolygon', coordinates: g.coordinates.map((p) => p.map(fecha)) };
      default: return null;
    }
  }
  const tipoDe = (g) => (!g ? null : /Polygon/.test(g.type) ? 'poligono' : /LineString/.test(g.type) ? 'linha' : /Point/.test(g.type) ? 'ponto' : null);
  function primeiraCoord(g) { let c = g && g.coordinates; while (Array.isArray(c) && Array.isArray(c[0])) c = c[0]; return Array.isArray(c) ? c : null; }

  /* ------------------------------------------------------------ leitores de arquivos */
  // WKB (ISO e EWKB) → GeoJSON; Z/M descartados
  function lerWKB(dv, off) {
    const le = dv.getUint8(off) === 1; off += 1;
    let t = dv.getUint32(off, le); off += 4;
    let dims = 2;
    if (t & 0x80000000) { dims++; } if (t & 0x40000000) { dims++; } if (t & 0x20000000) { off += 4; }
    t &= 0x0FFFFFFF;
    if (t >= 3000) { dims = 4; t -= 3000; } else if (t >= 2000) { dims = 3; t -= 2000; } else if (t >= 1000) { dims = 3; t -= 1000; }
    const pt = () => { const x = dv.getFloat64(off, le); const y = dv.getFloat64(off + 8, le); off += 8 * dims; return [x, y]; };
    const pts = () => { const n = dv.getUint32(off, le); off += 4; const a = []; for (let i = 0; i < n; i++) a.push(pt()); return a; };
    const aneis = () => { const n = dv.getUint32(off, le); off += 4; const a = []; for (let i = 0; i < n; i++) a.push(pts()); return a; };
    const multi = () => { const n = dv.getUint32(off, le); off += 4; const a = []; for (let i = 0; i < n; i++) { const r = lerWKB(dv, off); off = r.off; a.push(r.g); } return a; };
    let g = null;
    switch (t) {
      case 1: { const p = pt(); g = isNaN(p[0]) ? null : { type: 'Point', coordinates: p }; break; }
      case 2: g = { type: 'LineString', coordinates: pts() }; break;
      case 3: g = { type: 'Polygon', coordinates: aneis() }; break;
      case 4: g = { type: 'MultiPoint', coordinates: multi().filter(Boolean).map((x) => x.coordinates) }; break;
      case 5: g = { type: 'MultiLineString', coordinates: multi().filter(Boolean).map((x) => x.coordinates) }; break;
      case 6: g = { type: 'MultiPolygon', coordinates: multi().filter(Boolean).map((x) => x.coordinates) }; break;
      case 7: { const gs = multi().filter(Boolean); g = gs.length === 1 ? gs[0] : null; break; }
      default: throw new Error(`tipo de geometria WKB ${t} não suportado (curvas)`);
    }
    return { g, off };
  }
  function lerGpkgGeom(u8) {
    if (!u8 || u8.length < 8 || u8[0] !== 0x47 || u8[1] !== 0x50) return null;
    const flags = u8[3]; const env = (flags >> 1) & 7; const vazio = (flags >> 4) & 1;
    if (vazio) return null;
    const tam = [0, 32, 48, 48, 64][env] || 0;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    return lerWKB(dv, 8 + tam).g;
  }

  // Leitor mínimo de SQLite (somente leitura) para GeoPackage
  function lerSqlite(buf) {
    const u8 = new Uint8Array(buf); const dv = new DataView(buf);
    if (new TextDecoder().decode(u8.subarray(0, 15)) !== 'SQLite format 3') throw new Error('o arquivo não é um GeoPackage/SQLite');
    let ps = dv.getUint16(16); if (ps === 1) ps = 65536;
    const U = ps - u8[20];
    const wal = u8[18] === 2 || u8[19] === 2;
    const enc = dv.getUint32(56);
    const td = new TextDecoder(enc === 2 ? 'utf-16le' : enc === 3 ? 'utf-16be' : 'utf-8');
    const varint = (o) => { let v = 0; for (let i = 0; i < 8; i++) { const b = u8[o + i]; v = v * 128 + (b & 0x7f); if (b < 0x80) return [v, o + i + 1]; } return [v * 256 + u8[o + 8], o + 9]; };
    const pag = (n) => (n - 1) * ps;
    function payload(o, P) {
      const X = U - 35;
      if (P <= X) return u8.subarray(o, o + P);
      const M = Math.floor((U - 12) * 32 / 255) - 23;
      let K = M + ((P - M) % (U - 4)); if (K > X) K = M;
      const out = new Uint8Array(P); out.set(u8.subarray(o, o + K)); let pos = K;
      let ov = dv.getUint32(o + K);
      while (ov && pos < P) { const base = pag(ov); const n = Math.min(U - 4, P - pos); out.set(u8.subarray(base + 4, base + 4 + n), pos); pos += n; ov = dv.getUint32(base); }
      return out;
    }
    function registro(b) {
      let [hs, o] = (function v(off) { let r = 0; for (let i = 0; i < 9; i++) { const x = b[off + i]; if (i === 8) return [r * 256 + x, off + 9]; r = r * 128 + (x & 0x7f); if (x < 0x80) return [r, off + i + 1]; } return [r, off]; })(0);
      const tipos = []; let h = o;
      const vb = (off) => { let r = 0; for (let i = 0; i < 9; i++) { const x = b[off + i]; if (i === 8) return [r * 256 + x, off + 9]; r = r * 128 + (x & 0x7f); if (x < 0x80) return [r, off + i + 1]; } return [r, off]; };
      while (h < hs) { const [t, n] = vb(h); tipos.push(t); h = n; }
      const bd = new DataView(b.buffer, b.byteOffset, b.byteLength); let p = hs; const vals = [];
      for (const t of tipos) {
        if (t === 0) vals.push(null);
        else if (t >= 1 && t <= 6) { const n = [0, 1, 2, 3, 4, 6, 8][t]; let v = 0; const neg = b[p] & 0x80; for (let i = 0; i < n; i++) v = v * 256 + b[p + i]; if (neg) v -= 2 ** (8 * n); vals.push(v); p += n; }
        else if (t === 7) { vals.push(bd.getFloat64(p)); p += 8; }
        else if (t === 8) vals.push(0); else if (t === 9) vals.push(1);
        else if (t >= 12 && t % 2 === 0) { const n = (t - 12) / 2; vals.push(b.slice(p, p + n)); p += n; }
        else if (t >= 13) { const n = (t - 13) / 2; vals.push(td.decode(b.subarray(p, p + n))); p += n; }
        else vals.push(null);
      }
      return vals;
    }
    function percorrer(raiz, cb) {
      const pilha = [raiz];
      while (pilha.length) {
        const n = pilha.pop(); const base = pag(n); const h = n === 1 ? base + 100 : base;
        const tipo = u8[h]; const nc = dv.getUint16(h + 3);
        if (tipo === 0x05) {
          const filhos = [];
          for (let i = 0; i < nc; i++) { const c = base + dv.getUint16(h + 12 + 2 * i); filhos.push(dv.getUint32(c)); }
          filhos.push(dv.getUint32(h + 8));
          for (let i = filhos.length - 1; i >= 0; i--) pilha.push(filhos[i]);
        } else if (tipo === 0x0d) {
          for (let i = 0; i < nc; i++) {
            let c = base + dv.getUint16(h + 8 + 2 * i);
            let P; [P, c] = varint(c); let rowid; [rowid, c] = varint(c);
            cb(rowid, registro(payload(c, P)));
          }
        } else throw new Error('página de tabela inesperada no arquivo');
      }
    }
    function colunas(sql) {
      const i = sql.indexOf('('); const f = sql.lastIndexOf(')'); const corpo = sql.slice(i + 1, f);
      const partes = []; let prof = 0; let atual = '';
      for (const ch of corpo) { if (ch === '(') prof++; if (ch === ')') prof--; if (ch === ',' && prof === 0) { partes.push(atual); atual = ''; } else atual += ch; }
      partes.push(atual);
      return partes.map((s) => s.trim()).filter((s) => s && !/^(constraint|primary|unique|check|foreign)\b/i.test(s))
        .map((s) => { const m = s.match(/^("([^"]+)"|\[([^\]]+)\]|`([^`]+)`|(\S+))\s*(.*)$/); const nome = m[2] || m[3] || m[4] || m[5]; return { nome, pk: /integer\s+primary\s+key/i.test(m[6] || '') }; });
    }
    const esquema = [];
    percorrer(1, (rid, v) => esquema.push({ tipo: v[0], nome: v[1], tbl: v[2], raiz: v[3], sql: v[4] }));
    const tabelas = {}; esquema.filter((x) => x.tipo === 'table').forEach((x) => { tabelas[x.nome] = x; });
    function ler(nome) {
      const t = tabelas[nome]; if (!t) return [];
      const cols = colunas(t.sql); const out = [];
      percorrer(t.raiz, (rid, vals) => { const o = {}; cols.forEach((c, k) => { o[c.nome] = c.pk && vals[k] == null ? rid : (k < vals.length ? vals[k] : null); }); out.push(o); });
      return out;
    }
    return { ler, tabelas, wal };
  }
  function lerGPKG(buf) {
    const db = lerSqlite(buf);
    const conteudos = db.ler('gpkg_contents');
    if (!conteudos.length) throw new Error('GeoPackage sem a tabela gpkg_contents');
    const colsGeo = {}; db.ler('gpkg_geometry_columns').forEach((g) => { colsGeo[g.table_name] = g; });
    const srs = {}; db.ler('gpkg_spatial_ref_sys').forEach((s) => { srs[s.srs_id] = s; });
    const camadas = [];
    for (const c of conteudos.filter((x) => x.data_type === 'features')) {
      const gc = colsGeo[c.table_name]; if (!gc) continue;
      const s = srs[gc.srs_id] || srs[c.srs_id] || {};
      const crs = (s.organization && String(s.organization).toUpperCase() === 'EPSG' && crsDe(s.organization_coordsys_id)) || crsDeWkt(s.definition) || crsDe(gc.srs_id);
      const linhas = db.ler(c.table_name); const feicoes = []; let erros = 0;
      for (const l of linhas) {
        let g = null;
        try { g = lerGpkgGeom(l[gc.column_name]); } catch (e) { erros++; }
        if (!g) continue;
        const props = {};
        Object.entries(l).forEach(([k, v]) => { if (k !== gc.column_name && !(v instanceof Uint8Array)) props[k] = v; });
        feicoes.push({ g, props });
      }
      camadas.push({ nome: c.table_name, crs, feicoes, erros, total: linhas.length });
    }
    return { camadas, aviso: db.wal ? 'Este GeoPackage está em modo WAL: feche o QGIS antes de importar para garantir que as últimas edições estejam no arquivo.' : '' };
  }
  function lerGeoJSON(txt, nome) {
    const j = JSON.parse(txt);
    const lista = j.type === 'FeatureCollection' ? j.features : j.type === 'Feature' ? [j] : j.type ? [{ type: 'Feature', geometry: j, properties: {} }] : [];
    let crs = null;
    const nomeCrs = j.crs && j.crs.properties && j.crs.properties.name;
    if (nomeCrs) { const m = String(nomeCrs).match(/(\d{4,5})\s*$/); if (m) crs = crsDe(m[1]); if (/CRS84/i.test(nomeCrs)) crs = crsDe(4326); }
    const feicoes = lista.filter((f) => f && f.geometry).flatMap((f) => (f.geometry.type === 'GeometryCollection' ? f.geometry.geometries.map((g) => ({ g, props: f.properties || {} })) : [{ g: f.geometry, props: f.properties || {} }]));
    if (!crs) crs = adivinharCrs(primeiraCoord(feicoes[0] && feicoes[0].g));
    return { camadas: [{ nome: (j.name || nome || 'geojson').replace(/\.(geo)?json$/i, ''), crs, feicoes, erros: 0, total: lista.length }], aviso: '' };
  }
  function lerKML(txt, nome) {
    const doc = new DOMParser().parseFromString(txt, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('KML inválido');
    const filhos = (el, tag) => Array.from(el.children).filter((c) => c.localName === tag);
    const coords = (el) => (el ? el.textContent.trim().split(/\s+/).map((s) => s.split(',').map(Number)).filter((p) => p.length >= 2 && isFinite(p[0]) && isFinite(p[1])).map((p) => [p[0], p[1]]) : []);
    function geoms(el) {
      const out = [];
      for (const c of Array.from(el.children)) {
        if (c.localName === 'Point') out.push({ type: 'Point', coordinates: coords(c.getElementsByTagNameNS('*', 'coordinates')[0])[0] });
        else if (c.localName === 'LineString') out.push({ type: 'LineString', coordinates: coords(c.getElementsByTagNameNS('*', 'coordinates')[0]) });
        else if (c.localName === 'Polygon') {
          const ext = c.getElementsByTagNameNS('*', 'outerBoundaryIs')[0]; const ints = Array.from(c.getElementsByTagNameNS('*', 'innerBoundaryIs'));
          out.push({ type: 'Polygon', coordinates: [coords(ext && ext.getElementsByTagNameNS('*', 'coordinates')[0]), ...ints.map((i) => coords(i.getElementsByTagNameNS('*', 'coordinates')[0]))] });
        } else if (c.localName === 'MultiGeometry') out.push(...geoms(c));
      }
      return out.filter((g) => g.coordinates && g.coordinates.length);
    }
    const grupos = new Map();
    for (const pm of Array.from(doc.getElementsByTagNameNS('*', 'Placemark'))) {
      const props = {};
      const nm = filhos(pm, 'name')[0]; if (nm) props.name = nm.textContent.trim();
      const ds = filhos(pm, 'description')[0]; if (ds) props.description = ds.textContent.trim().slice(0, 500);
      Array.from(pm.getElementsByTagNameNS('*', 'SimpleData')).forEach((s) => { props[s.getAttribute('name')] = s.textContent.trim(); });
      Array.from(pm.getElementsByTagNameNS('*', 'Data')).forEach((s) => { const v = s.getElementsByTagNameNS('*', 'value')[0]; if (v) props[s.getAttribute('name')] = v.textContent.trim(); });
      const pasta = pm.parentElement && pm.parentElement.localName === 'Folder' ? (filhos(pm.parentElement, 'name')[0] || {}).textContent : null;
      const chave = (pasta || nome || 'kml').trim();
      if (!grupos.has(chave)) grupos.set(chave, []);
      geoms(pm).forEach((g) => grupos.get(chave).push({ g, props }));
    }
    return { camadas: [...grupos].map(([n, f]) => ({ nome: n, crs: crsDe(4326), feicoes: f, erros: 0, total: f.length })), aviso: '' };
  }
  async function lerZip(buf, nome) {
    if (!window.JSZip) throw new Error('leitor de ZIP indisponível');
    const z = await window.JSZip.loadAsync(buf);
    const arqs = Object.keys(z.files).filter((n) => !z.files[n].dir && !/__MACOSX/.test(n));
    const kml = arqs.find((n) => /\.kml$/i.test(n));
    if (kml) return lerKML(await z.file(kml).async('string'), nome.replace(/\.kmz$/i, ''));
    const shps = arqs.filter((n) => /\.shp$/i.test(n));
    if (!shps.length) throw new Error('o ZIP não tem arquivo .shp nem .kml');
    const camadas = []; let aviso = '';
    for (const shp of shps) {
      const base = shp.replace(/\.shp$/i, '');
      const acha = (ext) => arqs.find((n) => n.toLowerCase() === (base + ext).toLowerCase());
      const dbfN = acha('.dbf'); const prjN = acha('.prj'); const cpgN = acha('.cpg');
      const cpg = cpgN ? (await z.file(cpgN).async('string')).trim() : '';
      const prj = prjN ? await z.file(prjN).async('string') : '';
      const r = lerShapefile(await z.file(shp).async('arraybuffer'), dbfN ? await z.file(dbfN).async('arraybuffer') : null, cpg);
      let crs = crsDeWkt(prj) || adivinharCrs(primeiraCoord(r.feicoes[0] && r.feicoes[0].g));
      if (!prj) aviso = 'Shapefile sem arquivo .prj: o sistema de coordenadas foi deduzido pelas coordenadas – confira antes de enviar.';
      camadas.push({ nome: base.split('/').pop(), crs, feicoes: r.feicoes, erros: r.erros, total: r.total });
    }
    return { camadas, aviso };
  }
  function lerShapefile(shpBuf, dbfBuf, cpg) {
    const dv = new DataView(shpBuf); const feicoes = []; let erros = 0;
    let atributos = [];
    if (dbfBuf) {
      const d = new DataView(dbfBuf); const u = new Uint8Array(dbfBuf);
      const nreg = d.getUint32(4, true); const hl = d.getUint16(8, true); const rl = d.getUint16(10, true);
      const campos = []; for (let o = 32; o < hl - 1 && u[o] !== 0x0d; o += 32) campos.push({ nome: new TextDecoder().decode(u.subarray(o, o + 11)).replace(/\0.*$/, ''), tipo: String.fromCharCode(u[o + 11]), tam: u[o + 16] });
      let dec; try { dec = new TextDecoder(/1252|latin|8859/i.test(cpg) ? 'windows-1252' : 'utf-8', { fatal: !cpg }); dec.decode(u.subarray(hl, Math.min(u.length, hl + rl * 50))); } catch (e) { dec = new TextDecoder('windows-1252'); }
      for (let i = 0; i < nreg; i++) {
        let o = hl + i * rl; const apagado = u[o] === 0x2a; o += 1; const p = {};
        for (const c of campos) { let v = dec.decode(u.subarray(o, o + c.tam)).trim(); o += c.tam; if (c.tipo === 'N' || c.tipo === 'F') v = v === '' ? null : Number(v); else if (c.tipo === 'L') v = /^[YT]/i.test(v); else if (c.tipo === 'D' && /^\d{8}$/.test(v)) v = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6)}`; p[c.nome] = v === '' ? null : v; }
        atributos.push(apagado ? null : p);
      }
    }
    let o = 100; let i = 0; const fim = dv.byteLength;
    while (o + 8 <= fim) {
      const len = dv.getInt32(o + 4) * 2; const c = o + 8; o = c + len;
      const props = atributos[i]; i++;
      if (props === null) continue;
      try {
        const t = dv.getInt32(c, true); const bt = t % 10 === 0 ? 0 : t;
        let g = null;
        if (bt === 0) continue;
        if ([1, 11, 21].includes(bt)) g = { type: 'Point', coordinates: [dv.getFloat64(c + 4, true), dv.getFloat64(c + 12, true)] };
        else if ([8, 18, 28].includes(bt)) { const n = dv.getInt32(c + 36, true); const pts = []; for (let k = 0; k < n; k++) pts.push([dv.getFloat64(c + 40 + 16 * k, true), dv.getFloat64(c + 48 + 16 * k, true)]); g = { type: 'MultiPoint', coordinates: pts }; }
        else if ([3, 13, 23, 5, 15, 25].includes(bt)) {
          const np = dv.getInt32(c + 36, true); const nt = dv.getInt32(c + 40, true); const partes = []; for (let k = 0; k < np; k++) partes.push(dv.getInt32(c + 44 + 4 * k, true));
          const p0 = c + 44 + 4 * np; const pts = []; for (let k = 0; k < nt; k++) pts.push([dv.getFloat64(p0 + 16 * k, true), dv.getFloat64(p0 + 8 + 16 * k, true)]);
          const aneis = partes.map((s, k) => pts.slice(s, k + 1 < np ? partes[k + 1] : nt));
          if ([3, 13, 23].includes(bt)) g = aneis.length === 1 ? { type: 'LineString', coordinates: aneis[0] } : { type: 'MultiLineString', coordinates: aneis };
          else {
            const polis = [];
            for (const a of aneis) { if (areaAnel(a) < 0 || !polis.length) polis.push([a]); else { const dono = polis.find((pp) => dentroAnel(a[0], pp[0])) || polis[polis.length - 1]; dono.push(a); } }
            g = polis.length === 1 ? { type: 'Polygon', coordinates: polis[0] } : { type: 'MultiPolygon', coordinates: polis };
          }
        } else { erros++; continue; }
        feicoes.push({ g, props: props || {} });
      } catch (e) { erros++; }
    }
    return { feicoes, erros, total: i };
  }
  async function lerArquivo(arq) {
    const nome = arq.name; const buf = await arq.arrayBuffer();
    if (/\.gpkg$/i.test(nome)) return lerGPKG(buf);
    if (/\.(geo)?json$/i.test(nome)) return lerGeoJSON(new TextDecoder().decode(buf), nome);
    if (/\.kml$/i.test(nome)) return lerKML(new TextDecoder().decode(buf), nome.replace(/\.kml$/i, ''));
    if (/\.(kmz|zip)$/i.test(nome)) return lerZip(buf, nome);
    throw new Error('formato não suportado (use GPKG, GeoJSON, KML, KMZ ou Shapefile em ZIP)');
  }

  /* ------------------------------------------------------------ estado */
  const S = {
    perfil: null, camadas: [], CAM: {}, feicoes: [], levs: [], LEV: {}, ncs: [], alertas: {}, temaIdx: null, carregado: false, carregando: false,
    aba: 'mapa', modo: 'indice', tema: 'ACE', base: 'sat', camVis: new Set(), verLevs: true, verTracados: true, verNC: false,
    blocos: new Set(), filtroSit: new Set(['confirmado', 'sugerido', 'sem', 'codigo', 'contexto']), busca: '',
    tol: { poligono: 15, linha: 15, ponto: 10 }, sel: null, hover: null, imp: null, marcadas: new Set(), lado: false,
  };
  const pode = { ler: () => S.perfil && ['inspetor', 'coordenador', 'leitor'].includes(S.perfil.papel), gravar: () => S.perfil && ['inspetor', 'coordenador'].includes(S.perfil.papel), coord: () => S.perfil && S.perfil.papel === 'coordenador' };

  /* ------------------------------------------------------------ carregar dados do Supabase */
  async function carregar() {
    S.carregando = true; mostrarCarregando('Carregando base geográfica e levantamentos…');
    try {
      const perfis = await SB.select('pd_perfis', `select=*&user_id=eq.${SB.sessao.user.id}`);
      S.perfil = perfis[0] || { papel: 'pendente' };
      if (!pode.ler()) { S.carregado = true; return; }
      const [cams, feics, ativos, levs, ncs, alertas] = await Promise.all([
        SB.select('pd_geo_camadas', 'select=*&order=ordem'),
        SB.tudo('pd_geo_feicoes', 'select=id,camada,escopo,geometria,id_ativo,nome,id_bloco,atributos,geojson,area_m2,comprimento_m,vinculo_origem,fonte,vinculado_em&order=id'),
        SB.tudo('pd_vw_ativos', 'select=*&order=id'),
        SB.tudo('pd_levantamentos', 'select=id,tracado,precisao_m&order=id'),
        SB.tudo('pd_geo_nc', 'select=*&order=id_acao').catch(() => []),
        SB.tudo('pd_vw_alertas', 'select=regra,alerta,levantamento_id&order=regra').catch(() => []),
      ]);
      S.camadas = cams; S.CAM = {}; cams.forEach((c) => { S.CAM[c.cod] = c; });
      if (!S.camVis.size) cams.forEach((c) => S.camVis.add(c.cod));
      const trac = {}; levs.forEach((l) => { trac[l.id] = l.tracado; });
      S.levs = ativos.map((a) => prepararLev(a, trac[a.id]));
      S.LEV = {}; S.levs.forEach((l) => { S.LEV[l.id] = l; });
      const lats = S.levs.filter((l) => l.ll).map((l) => l.ll[1]);
      S.feicoes = feics.map(prepararFeicao).filter(Boolean);
      const latsF = S.feicoes.map((f) => f.c[1]);
      const todas = lats.concat(latsF);
      if (todas.length) { LAT0 = todas.reduce((s, x) => s + x, 0) / todas.length; KX = 111320 * Math.cos(LAT0 * Math.PI / 180); }
      S.ncs = ncs.filter((n) => n.lat != null).map((n) => Object.assign(n, { w: [mx(n.lon), my(n.lat)] }));
      S.alertas = {}; alertas.forEach((a) => { (S.alertas[a.levantamento_id] = S.alertas[a.levantamento_id] || []).push(a); });
      S.temaIdx = null;
      calcularVinculos();
      if (S.sel) {  // a ficha aberta passa a apontar para os objetos recarregados
        const h = S.sel; const o = h.obj;
        const novo = h.tipo === 'lev' ? S.LEV[o.id] : h.tipo === 'feicao' ? S.feicoes.find((f) => f.id === o.id) : S.ncs.find((n) => n.id_acao === o.id_acao);
        S.sel = novo ? { tipo: h.tipo, obj: novo } : null;
      }
      S.carregado = true; S.atualizadoEm = new Date();
    } finally { S.carregando = false; mostrarCarregando(null); }
  }
  function prepararFeicao(r) {
    const ng = normGeom(r.geojson); if (!ng) return null;
    const cam = S.CAM[r.camada] || { escopo: null, geometria: ng.tipo, cor: '#78909C', nome: r.camada };
    const w = ng.partes.map((p) => (ng.tipo === 'ponto' ? [mx(p[0]), my(p[1])] : ng.tipo === 'linha' ? p.map((q) => [mx(q[0]), my(q[1])]) : p.map((a) => a.map((q) => [mx(q[0]), my(q[1])]))));
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    const vis = (q) => { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); };
    if (ng.tipo === 'ponto') w.forEach(vis); else if (ng.tipo === 'linha') w.forEach((l) => l.forEach(vis)); else w.forEach((p) => p[0].forEach(vis));  // caixa em coordenadas do mapa (0..1)
    const esc0 = r.escopo || cam.escopo || null;
    const contexto = !esc0 && ng.tipo !== 'ponto';
    return Object.assign(r, { ng, w, bb: [x0, y0, x1, y1], c: centro(ng), escEf: esc0, contexto, cam });
  }
  function prepararLev(a, tracado) {
    const ll = a.lat != null && a.lon != null ? [a.lon, a.lat] : null;
    const tr = tracado ? normGeom(tracado) : null;
    return Object.assign(a, { codigo: a.codigo_ativo, ll, w: ll ? [mx(ll[0]), my(ll[1])] : null, tr, trw: tr ? tr.partes.map((p) => (tr.tipo === 'linha' ? p.map((q) => [mx(q[0]), my(q[1])]) : p.map((anel) => anel.map((q) => [mx(q[0]), my(q[1])])))) : null,
      indice: a.indice == null ? null : Number(a.indice) });
  }

  /* ------------------------------------------------------------ motor de vínculo (código + posição) */
  function compativel(f, l) {
    if (f.contexto) return false;
    if (f.escEf) return f.escEf === l.escopo;
    return f.ng.tipo === 'ponto' && ESC[l.escopo] && ESC[l.escopo].geom === 'ponto';
  }
  function pontoRef(l) { if (l.ll) return l.ll; if (l.tr) return centro(l.tr); return null; }
  function calcularVinculos() {
    const porCod = new Map(); S.levs.forEach((l) => { porCod.set(l.codigo, l); l.f = null; l.sug = null; l.blocoGeo = null; });
    S.feicoes.forEach((f) => { f.lev = null; f.sug = null; });
    for (const f of S.feicoes) {
      if (f.id_ativo) { const l = porCod.get(f.id_ativo); if (l) { f.lev = l; l.f = f; } }
    }
    // candidatos pela posição, com atribuição 1:1 pela menor distância
    const pares = [];
    const livres = S.feicoes.filter((f) => !f.id_ativo && !f.contexto);
    const grausLat = (m) => m / KY; const grausLon = (m) => m / KX;
    for (const l of S.levs) {
      if (l.f) continue;
      const p = pontoRef(l); if (!p) continue;
      const cands = [];
      for (const f of livres) {
        if (!compativel(f, l)) continue;
        const tol = S.tol[f.ng.tipo] || 10;
        const bx = grausLon(tol); const by = grausLat(tol);
        const bb = f.bbll || (f.bbll = bbLL(f.ng));
        if (p[0] < bb[0] - bx || p[0] > bb[2] + bx || p[1] < bb[1] - by || p[1] > bb[3] + by) continue;
        const r = distGeom(p, f.ng);
        if (r.d <= tol) cands.push({ f, d: r.d, q: r.q });
      }
      cands.sort((a, b) => a.d - b.d);
      cands.forEach((c, k) => pares.push({ l, f: c.f, d: c.d, q: c.q, amb: k === 0 && cands.length > 1 && cands[1].d - c.d < 3 }));
      l.nCand = cands.length;
    }
    pares.sort((a, b) => a.d - b.d);
    for (const p of pares) {
      if (p.l.sug || p.f.sug) continue;
      const amb = p.amb || (p.l.nCand > 1 && pares.some((o) => o.l === p.l && o.f !== p.f && o.d - p.d < 3 && !o.f.sug));
      p.l.sug = { f: p.f, d: p.d, q: p.q, amb }; p.f.sug = { lev: p.l, d: p.d, amb };
    }
    // bloco pela posição (camada de setores/blocos)
    const blocos = S.feicoes.filter((f) => f.camada === 'setor_bloco' && f.id_bloco && f.ng.tipo === 'poligono');
    if (blocos.length) {
      for (const l of S.levs) { const p = pontoRef(l); if (!p) continue; const b = blocos.find((bk) => bk.ng.partes.some((poli) => dentroPoligono(p, poli))); l.blocoGeo = b ? b.id_bloco : null; }
      for (const f of S.feicoes) { if (f.camada === 'setor_bloco' || f.id_bloco) continue; const b = blocos.find((bk) => bk.ng.partes.some((poli) => dentroPoligono(f.c, poli))); f.blocoGeo = b ? b.id_bloco : null; }
    }
  }
  function bbLL(ng) {
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    const v = (q) => { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); };
    if (ng.tipo === 'ponto') ng.partes.forEach(v); else if (ng.tipo === 'linha') ng.partes.forEach((l) => l.forEach(v)); else ng.partes.forEach((p) => p.forEach((a) => a.forEach(v)));
    return [x0, y0, x1, y1];
  }
  const situacao = (f) => (f.contexto ? 'contexto' : f.lev ? 'confirmado' : f.id_ativo ? 'codigo' : f.sug ? 'sugerido' : 'sem');
  const blocoDe = (f) => f.id_bloco || f.blocoGeo || (f.lev && f.lev.bloco) || null;
  const levDe = (f) => f.lev || (f.sug && f.sug.lev) || null;

  /* ------------------------------------------------------------ filtros e cores */
  function feicaoVisivel(f) {
    if (!S.camVis.has(f.camada)) return false;
    if (!S.filtroSit.has(situacao(f))) return false;
    if (S.blocos.size && !f.contexto && !S.blocos.has(blocoDe(f) || 'sem bloco')) return false;
    if (S.busca && !f.contexto) { const l = levDe(f); const txt = `${f.id_ativo || ''} ${f.nome || ''} ${l ? l.codigo + ' ' + (l.nome_ativo || '') : ''}`.toLowerCase(); if (!txt.includes(S.busca)) return false; }
    return true;
  }
  function levVisivel(l) {
    if (S.blocos.size && !S.blocos.has(l.bloco || 'sem bloco')) return false;
    if (S.busca && !`${l.codigo} ${l.nome_ativo || ''}`.toLowerCase().includes(S.busca)) return false;
    return true;
  }
  function corDe(f) {
    if (f.contexto) return f.cam.cor || '#F5C400';
    const sit = situacao(f); const l = f.lev;
    switch (S.modo) {
      case 'situacao': return COR_SIT[sit];
      case 'camada': return f.cam.cor || '#78909C';
      case 'criticidade': return l && l.crit_max ? COR_CRIT[l.crit_max] : (l ? '#1E7B47' : CINZA);
      case 'condicao': return l && l.condicao_geral ? COR_COND[l.condicao_geral] : CINZA;
      case 'tema': { if (!l || !S.temaIdx) return CINZA; const v = (S.temaIdx[l.id] || {})[S.tema]; return v == null ? CINZA : corIdx(v); }
      default: return l ? corIdx(l.indice) : CINZA;
    }
  }
  function corLev(l) {
    switch (S.modo) {
      case 'criticidade': return l.crit_max ? COR_CRIT[l.crit_max] : '#1E7B47';
      case 'condicao': return l.condicao_geral ? COR_COND[l.condicao_geral] : CINZA;
      case 'situacao': return l.f ? COR_SIT.confirmado : l.sug ? COR_SIT.sugerido : '#C3292E';
      case 'tema': { const v = S.temaIdx ? (S.temaIdx[l.id] || {})[S.tema] : null; return v == null ? CINZA : corIdx(v); }
      default: return corIdx(l.indice);
    }
  }
  function legendaHTML() {
    const L = (cor, txt, c) => `<div><span class="sw ${c ? 'c' : ''}" style="background:${cor}"></span>${esc(txt)}</div>`;
    let h = '';
    switch (S.modo) {
      case 'situacao': h = '<b>Situação do vínculo</b>' + ['confirmado', 'sugerido', 'codigo', 'sem'].map((k) => L(COR_SIT[k], ROT_SIT[k])).join('') + L('#C3292E', 'Levantamento sem feição', true); break;
      case 'criticidade': h = '<b>Criticidade máxima</b>' + ['Crítica', 'Alta', 'Média', 'Baixa', 'Melhoria'].map((k) => L(COR_CRIT[k], k)).join('') + L('#1E7B47', 'Sem não conformidade') + L(CINZA, 'Não levantado'); break;
      case 'condicao': h = '<b>Condição geral</b>' + [5, 4, 3, 2, 1].map((k) => L(COR_COND[k], `${k} – ${['', 'crítico', 'ruim', 'regular', 'bom', 'ótimo'][k]}`)).join('') + L(CINZA, 'Não levantado'); break;
      case 'camada': h = '<b>Camada</b>' + S.camadas.filter((c) => S.feicoes.some((f) => f.camada === c.cod)).map((c) => L(c.cor, c.nome)).join(''); break;
      case 'tema': h = `<b>Índice – ${esc(TEMA[S.tema] || S.tema)}</b>`; // fallthrough visual
      // eslint-disable-next-line no-fallthrough
      default: if (S.modo !== 'tema') h = '<b>Índice de conformidade</b>';
        h += L('#1E7B47', `≥ ${pct(PARAM.indice_bom)}`) + L('#D9A400', `${pct(PARAM.indice_atencao)} a ${pct(PARAM.indice_bom)}`) + L('#E0601C', `${pct(PARAM.indice_ruim)} a ${pct(PARAM.indice_atencao)}`) + L('#B71C1C', `< ${pct(PARAM.indice_ruim)}`) + L(CINZA, 'Não levantado / sem dado');
    }
    if (S.verNC) h += '<b style="margin-top:6px">Não conformidades</b>' + ['Crítica', 'Alta', 'Média', 'Baixa'].map((k) => `<div><span class="sw" style="background:${COR_CRIT[k]};transform:rotate(45deg);width:11px;height:11px"></span>${k}</div>`).join('');
    return `<button class="leg-t" data-a="legenda">Legenda</button><div class="leg-c">${h}</div>`;
  }

  /* ------------------------------------------------------------ mapa (canvas + mosaico de imagens) */
  const BASES = {
    sat: { nome: 'Satélite', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', max: 20 },
    ruas: { nome: 'Ruas', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', max: 19 },
    claro: { nome: 'Claro', url: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', max: 20 },
    nenhum: { nome: 'Sem fundo', url: null, max: 22 },
  };
  const V = { lat: -2.5655, lon: -44.365, z: 15, W: 0, H: 0, dpr: 1, tiles: new Map(), ptrs: new Map(), pinch: null, moved: 0, raf: 0 };
  let cv; let ctx;
  const escalaZ = () => 256 * 2 ** V.z;
  const centroW = () => [mx(V.lon), my(V.lat)];
  function tela(w) { const s = escalaZ(); const c = centroW(); return [(w[0] - c[0]) * s + V.W / 2, (w[1] - c[1]) * s + V.H / 2]; }
  function mundo(px, py) { const s = escalaZ(); const c = centroW(); return [c[0] + (px - V.W / 2) / s, c[1] + (py - V.H / 2) / s]; }
  function redesenhar() { if (!V.raf) V.raf = requestAnimationFrame(() => { V.raf = 0; desenharTiles(); desenharVetor(); desenharEscala(); }); }
  function montarMapa() {
    const el = $('#mapa'); if (!el) return;
    cv = $('#cv'); ctx = cv.getContext('2d');
    const ro = new ResizeObserver(() => redimensionar()); ro.observe(el);
    redimensionar();
    el.addEventListener('pointerdown', pDown); el.addEventListener('pointermove', pMove); el.addEventListener('pointerup', pUp); el.addEventListener('pointercancel', pUp);
    el.addEventListener('pointerleave', () => { S.hover = null; $('#dica').classList.add('oculto'); });
    el.addEventListener('wheel', (e) => { e.preventDefault(); const b = el.getBoundingClientRect(); zoomEm(V.z - e.deltaY * 0.0022, e.clientX - b.left, e.clientY - b.top); }, { passive: false });
    el.addEventListener('dblclick', (e) => { const b = el.getBoundingClientRect(); zoomEm(Math.round(V.z) + 1, e.clientX - b.left, e.clientY - b.top); });
  }
  function redimensionar() {
    const el = $('#mapa'); if (!el) return;
    const r = el.getBoundingClientRect(); V.W = r.width; V.H = r.height; V.dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(V.W * V.dpr); cv.height = Math.round(V.H * V.dpr);
    redesenhar();
  }
  function desenharTiles() {
    const box = $('#tiles'); if (!box) return;
    const b = BASES[S.base];
    if (!b.url) { box.innerHTML = ''; V.tiles.clear(); return; }
    const z = clamp(Math.round(V.z), 1, b.max); const k = 2 ** (V.z - z);
    const s = 256 * 2 ** z; const c = centroW(); const x0 = c[0] * s - V.W / 2 / k; const y0 = c[1] * s - V.H / 2 / k; const n = 2 ** z; const need = new Set();
    for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y0 + V.H / k) / 256); ty++) {
      if (ty < 0 || ty >= n) continue;
      for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x0 + V.W / k) / 256); tx++) {
        const wx = ((tx % n) + n) % n; const key = `${S.base}/${z}/${tx}/${ty}`; need.add(key);
        let im = V.tiles.get(key);
        if (!im) { im = new Image(); im.alt = ''; im.crossOrigin = 'anonymous'; im.onerror = () => { im.style.visibility = 'hidden'; }; im.src = b.url.replace('{z}', z).replace('{x}', wx).replace('{y}', ty); V.tiles.set(key, im); box.appendChild(im); }
        im.style.transform = `translate(${(tx * 256 - x0) * k}px,${(ty * 256 - y0) * k}px) scale(${k})`;
      }
    }
    for (const [key, im] of V.tiles) if (!need.has(key)) { im.remove(); V.tiles.delete(key); }
  }
  function caminhoAneis(aneis) { for (const a of aneis) { a.forEach((q, i) => { const p = tela(q); if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }); ctx.closePath(); } }
  function caminhoLinha(l) { l.forEach((q, i) => { const p = tela(q); if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }); }
  function naTela(bb, m = 40) { const a = tela([bb[0], bb[1]]); const b = tela([bb[2], bb[3]]); return !(b[0] < -m || a[0] > V.W + m || b[1] < -m || a[1] > V.H + m); }
  function desenharVetor() {
    if (!ctx) return;
    ctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0); ctx.clearRect(0, 0, V.W, V.H);
    const sel = S.sel; const zoomGrande = V.z >= 17.5;
    const visiveis = S.feicoes.filter((f) => feicaoVisivel(f) && naTela(f.bb));
    const pol = visiveis.filter((f) => f.ng.tipo === 'poligono'); const lin = visiveis.filter((f) => f.ng.tipo === 'linha'); const pts = visiveis.filter((f) => f.ng.tipo === 'ponto');
    // polígonos: contexto primeiro, depois maiores sob os menores
    pol.sort((a, b) => (b.contexto - a.contexto) || ((b.bb[2] - b.bb[0]) * (b.bb[3] - b.bb[1]) - (a.bb[2] - a.bb[0]) * (a.bb[3] - a.bb[1])));
    for (const f of pol) {
      const cor = corDe(f); const sit = situacao(f);
      ctx.beginPath(); f.w.forEach((poli) => caminhoAneis(poli));
      if (!f.contexto) { ctx.globalAlpha = sit === 'sem' || sit === 'codigo' ? 0.16 : 0.42; ctx.fillStyle = cor; ctx.fill('evenodd'); ctx.globalAlpha = 1; }
      ctx.setLineDash(f.contexto || sit === 'sem' ? [6, 4] : sit === 'sugerido' ? [3, 3] : []);
      ctx.lineWidth = f.contexto ? 2.5 : 1.6; ctx.strokeStyle = f.contexto ? cor : escurecer(cor); ctx.stroke(); ctx.setLineDash([]);
    }
    for (const f of lin) {
      const cor = corDe(f); const sit = situacao(f);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); f.w.forEach(caminhoLinha); ctx.lineWidth = 7; ctx.strokeStyle = 'rgba(20,32,28,.55)'; ctx.stroke();
      ctx.setLineDash(sit === 'sem' || sit === 'codigo' ? [8, 6] : sit === 'sugerido' ? [3, 4] : []);
      ctx.beginPath(); f.w.forEach(caminhoLinha); ctx.lineWidth = 4.5; ctx.strokeStyle = cor; ctx.stroke(); ctx.setLineDash([]);
    }
    if (S.verTracados) {
      ctx.setLineDash([6, 5]); ctx.lineWidth = 2.5; ctx.strokeStyle = '#8E44AD';
      for (const l of S.levs) { if (!l.trw || !levVisivel(l)) continue; ctx.beginPath(); if (l.tr.tipo === 'linha') l.trw.forEach(caminhoLinha); else l.trw.forEach((poli) => caminhoAneis(poli)); ctx.stroke(); }
      ctx.setLineDash([]);
    }
    const r = zoomGrande ? 7.5 : 5.5;
    for (const f of pts) {
      const cor = corDe(f); const sit = situacao(f);
      for (const q of f.w) { const p = tela(q); ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 7); ctx.fillStyle = sit === 'sem' || sit === 'codigo' ? 'rgba(140,154,149,.55)' : cor; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke(); }
    }
    // ligações das sugestões (aba Vínculos ou seleção)
    const conectores = S.aba === 'vinculos' ? S.levs.filter((l) => l.sug && l.ll && levVisivel(l)) : sel ? [sel.tipo === 'lev' ? sel.obj : sel.tipo === 'feicao' && sel.obj.sug ? sel.obj.sug.lev : null].filter((l) => l && l.sug && l.ll) : [];
    ctx.setLineDash([4, 4]); ctx.lineWidth = 2;
    for (const l of conectores) { const a = tela(l.w); const b = tela([mx(l.sug.q[0]), my(l.sug.q[1])]); ctx.strokeStyle = l.sug.amb ? '#E0601C' : '#2B67B1'; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
    ctx.setLineDash([]);
    if (S.verLevs) {
      for (const l of S.levs) {
        if (!l.w || !levVisivel(l)) continue;
        const p = tela(l.w); if (p[0] < -20 || p[1] < -20 || p[0] > V.W + 20 || p[1] > V.H + 20) continue;
        const semF = !l.f && !l.sug;
        ctx.beginPath(); ctx.moveTo(p[0], p[1] - 7); ctx.lineTo(p[0] + 6, p[1]); ctx.lineTo(p[0], p[1] + 7); ctx.lineTo(p[0] - 6, p[1]); ctx.closePath();
        ctx.fillStyle = corLev(l); ctx.fill(); ctx.lineWidth = 1.8; ctx.strokeStyle = '#14201C'; ctx.stroke();
        if (semF && (S.aba === 'vinculos' || S.modo === 'situacao')) { ctx.beginPath(); ctx.arc(p[0], p[1], 11, 0, 7); ctx.strokeStyle = '#C3292E'; ctx.lineWidth = 2; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]); }
      }
    }
    if (S.verNC) {
      for (const n of S.ncs) {
        if (S.busca && !`${n.codigo_ativo} ${n.item_id}`.toLowerCase().includes(S.busca)) continue;
        if (S.blocos.size && !S.blocos.has(n.bloco || 'sem bloco')) continue;
        const p = tela(n.w); if (p[0] < -20 || p[1] < -20 || p[0] > V.W + 20 || p[1] > V.H + 20) continue;
        ctx.save(); ctx.translate(p[0], p[1]); ctx.rotate(Math.PI / 4); ctx.fillStyle = COR_CRIT[n.criticidade] || CINZA; ctx.fillRect(-5, -5, 10, 10); ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.strokeRect(-5, -5, 10, 10); ctx.restore();
      }
    }
    // seleção
    if (sel) {
      ctx.strokeStyle = '#F5C400'; ctx.lineWidth = 4;
      if (sel.tipo === 'feicao') { const f = sel.obj; ctx.beginPath(); if (f.ng.tipo === 'poligono') f.w.forEach((poli) => caminhoAneis(poli)); else if (f.ng.tipo === 'linha') f.w.forEach(caminhoLinha); else f.w.forEach((q) => { const p = tela(q); ctx.moveTo(p[0] + 12, p[1]); ctx.arc(p[0], p[1], 12, 0, 7); }); ctx.stroke(); }
      const l = sel.tipo === 'lev' ? sel.obj : sel.tipo === 'feicao' ? levDe(sel.obj) : null;
      if (l && l.w) { const p = tela(l.w); ctx.beginPath(); ctx.arc(p[0], p[1], 13, 0, 7); ctx.stroke(); }
      if (sel.tipo === 'nc') { const p = tela(sel.obj.w); ctx.beginPath(); ctx.arc(p[0], p[1], 12, 0, 7); ctx.stroke(); }
    }
    // rótulos (sem sobreposição: os mais importantes primeiro)
    if (zoomGrande || V.z >= 15) {
      const rot = [];
      for (const f of visiveis) {
        if (f.camada === 'setor_bloco') { if (f.id_bloco || f.nome) { const p = tela([mx((f.bbll || (f.bbll = bbLL(f.ng)))[0]), my(f.bbll[3])]); rot.push({ t: f.id_bloco || f.nome, x: p[0] + 8, y: p[1] + 12, a: 'left', pr: 4, cor: '#F5C400' }); } continue; }
        if (!zoomGrande) continue;
        const sug = !f.id_ativo && f.sug;
        const txt = f.id_ativo || (sug ? f.sug.lev.codigo : null); if (!txt) continue;
        const p = tela([mx(f.c[0]), my(f.c[1])]);
        rot.push({ t: txt, x: p[0], y: p[1] + (f.ng.tipo === 'ponto' ? -15 : 0), a: 'center', pr: sel && sel.obj === f ? 0 : f.lev ? 1 : sug ? 2 : 3, it: !!sug, cor: sug ? '#CFE0FF' : '#fff' });
      }
      if (zoomGrande && S.verLevs) S.levs.forEach((l) => { if (l.w && !l.f && !l.sug && levVisivel(l)) { const p = tela(l.w); rot.push({ t: l.codigo, x: p[0], y: p[1] - 15, a: 'center', pr: 2, cor: '#FFD6D6' }); } });
      rot.sort((a, b) => a.pr - b.pr);
      const ocupado = []; ctx.textBaseline = 'middle'; ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(20,32,28,.9)';
      for (const r of rot) {
        ctx.font = `${r.it ? 'italic ' : ''}700 12px system-ui, sans-serif`;
        const w = ctx.measureText(r.t).width + 6; const x0 = r.a === 'center' ? r.x - w / 2 : r.x - 3; const caixa = [x0, r.y - 9, x0 + w, r.y + 9];
        if (caixa[2] < 0 || caixa[0] > V.W || caixa[3] < 0 || caixa[1] > V.H) continue;
        if (ocupado.some((o) => !(caixa[2] < o[0] || caixa[0] > o[2] || caixa[3] < o[1] || caixa[1] > o[3]))) continue;
        ocupado.push(caixa); ctx.textAlign = r.a; ctx.fillStyle = r.cor;
        ctx.strokeText(r.t, r.x, r.y); ctx.fillText(r.t, r.x, r.y);
      }
    }
  }
  function escurecer(hex) { const h = hex.replace('#', ''); const f = (i) => Math.round(parseInt(h.substr(i, 2), 16) * 0.65).toString(16).padStart(2, '0'); return `#${f(0)}${f(2)}${f(4)}`; }
  function desenharEscala() {
    const el = $('#escala'); if (!el) return;
    const mpp = 156543.03392 * Math.cos(V.lat * Math.PI / 180) / 2 ** V.z;
    const alvo = mpp * 110; const p10 = 10 ** Math.floor(Math.log10(alvo)); const m = [1, 2, 5, 10].map((k) => k * p10).filter((v) => v <= alvo).pop() || p10;
    el.innerHTML = `${m >= 1000 ? fmt(m / 1000, 1) + ' km' : fmt(m) + ' m'}<i style="width:${Math.round(m / mpp)}px"></i>`;
  }
  function pan(dx, dy) { const s = escalaZ(); const c = centroW(); V.lon = lonDe(c[0] - dx / s); V.lat = latDe(c[1] - dy / s); redesenhar(); }
  function zoomEm(z, sx, sy) {
    z = clamp(z, 3, 22); const w = mundo(sx, sy); V.z = z;
    const s = escalaZ(); const c = [w[0] - (sx - V.W / 2) / s, w[1] - (sy - V.H / 2) / s]; V.lon = lonDe(c[0]); V.lat = latDe(c[1]);
    redesenhar(); guardarVista();
  }
  const guardarVista = debounce(() => { try { localStorage.setItem('pdslz_webgis_vista', JSON.stringify({ lat: V.lat, lon: V.lon, z: V.z })); } catch (e) { /* ok */ } }, 600);
  function enquadrar(lista) {
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    lista.forEach((b) => { x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); });
    if (!isFinite(x0)) return;
    const cx = (x0 + x1) / 2; const cy = (y0 + y1) / 2; V.lon = lonDe(cx); V.lat = latDe(cy);
    const dx = Math.max(x1 - x0, 1e-9); const dy = Math.max(y1 - y0, 1e-9);
    V.z = clamp(Math.log2(Math.min((V.W - 80) / (dx * 256), (V.H - 80) / (dy * 256))), 3, 19);
    redesenhar(); guardarVista();
  }
  function enquadrarTudo() {
    const bbs = S.feicoes.filter(feicaoVisivel).map((f) => f.bb).concat(S.levs.filter((l) => l.w).map((l) => [l.w[0], l.w[1], l.w[0], l.w[1]]));
    if (bbs.length) enquadrar(bbs);
  }
  function irPara(obj) {
    if (obj.bb) enquadrar([obj.bb]); else if (obj.w) { V.lon = lonDe(obj.w[0]); V.lat = latDe(obj.w[1]); V.z = Math.max(V.z, 18); redesenhar(); }
    if (V.z > 19.5) { V.z = 19.5; redesenhar(); }
  }

  // seleção por clique / passagem do mouse
  function acertar(px, py) {
    // todos os objetos sob o cursor, por prioridade (NC > levantamento > ponto > linha > polígono) e distância
    const out = [];
    const dist = (w) => { const p = tela(w); return Math.hypot(p[0] - px, p[1] - py); };
    if (S.verNC) S.ncs.forEach((n) => { const d = dist(n.w); if (d <= 8) out.push({ tipo: 'nc', obj: n, k: [0, d] }); });
    if (S.verLevs) S.levs.forEach((l) => { if (l.w && levVisivel(l)) { const d = dist(l.w); if (d <= 9) out.push({ tipo: 'lev', obj: l, k: [1, d] }); } });
    const vis = S.feicoes.filter((f) => feicaoVisivel(f) && naTela(f.bb, 10));
    vis.filter((x) => x.ng.tipo === 'ponto').forEach((f) => { const d = Math.min(...f.w.map(dist)); if (d <= 9) out.push({ tipo: 'feicao', obj: f, k: [2, d] }); });
    vis.filter((x) => x.ng.tipo === 'linha').forEach((f) => {
      let d = Infinity; for (const l of f.w) for (let i = 1; i < l.length; i++) d = Math.min(d, distSeg([px, py], tela(l[i - 1]), tela(l[i])).d);
      if (d <= 7) out.push({ tipo: 'feicao', obj: f, k: [3, d] });
    });
    const w = mundo(px, py);
    vis.filter((f) => f.ng.tipo === 'poligono' && f.w.some((poli) => dentroPoligono(w, poli)))
      .forEach((f) => out.push({ tipo: 'feicao', obj: f, k: [f.contexto ? 5 : 4, (f.bb[2] - f.bb[0]) * (f.bb[3] - f.bb[1])] }));
    if (!out.length) return null;
    out.sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1]);
    return Object.assign({}, out[0], { outros: out.slice(1, 7) });
  }
  function pDown(e) {
    if (e.target.closest('.ctl,.legenda,.ficha,.escala,.coords')) return;
    e.currentTarget.setPointerCapture(e.pointerId); V.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); V.moved = 0;
    if (V.ptrs.size === 2) { const [a, b] = [...V.ptrs.values()]; V.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: V.z }; }
  }
  function pMove(e) {
    const el = $('#mapa'); const bx = el.getBoundingClientRect();
    const p = V.ptrs.get(e.pointerId);
    if (!p) { dicaEm(e.clientX - bx.left, e.clientY - bx.top); coordsEm(e.clientX - bx.left, e.clientY - bx.top); return; }
    const dx = e.clientX - p.x; const dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
    if (V.ptrs.size === 1) { V.moved += Math.abs(dx) + Math.abs(dy); if (V.moved > 3) { el.classList.add('arrastando'); pan(dx, dy); } }
    else if (V.pinch) { const [a, b] = [...V.ptrs.values()]; zoomEm(V.pinch.z + Math.log2(Math.hypot(a.x - b.x, a.y - b.y) / V.pinch.d), (a.x + b.x) / 2 - bx.left, (a.y + b.y) / 2 - bx.top); V.moved += 10; }
  }
  function pUp(e) {
    if (!V.ptrs.has(e.pointerId)) return;
    V.ptrs.delete(e.pointerId); if (V.ptrs.size < 2) V.pinch = null; $('#mapa').classList.remove('arrastando');
    if (e.type === 'pointerup' && V.moved < 6 && !V.ptrs.size) {
      const bx = $('#mapa').getBoundingClientRect(); const h = acertar(e.clientX - bx.left, e.clientY - bx.top);
      selecionar(h);
    }
    guardarVista();
  }
  const dicaEm = (() => { let pend = null; return (x, y) => { pend = [x, y]; requestAnimationFrame(() => { if (!pend) return; const [px, py] = pend; pend = null; const h = acertar(px, py); const d = $('#dica'); if (!h) { d.classList.add('oculto'); $('#mapa').style.cursor = ''; return; } $('#mapa').style.cursor = 'pointer'; d.textContent = rotuloCurto(h); d.style.left = px + 'px'; d.style.top = py + 'px'; d.classList.remove('oculto'); }); }; })();
  function coordsEm(x, y) { const w = mundo(x, y); const el = $('#coords'); if (el) el.textContent = `${latDe(w[1]).toFixed(6)}, ${lonDe(w[0]).toFixed(6)}`; }
  function rotuloCurto(h) {
    if (h.tipo === 'nc') return `${h.obj.codigo_ativo} · ${h.obj.item_id} · ${h.obj.criticidade}`;
    if (h.tipo === 'lev') { const l = h.obj; return `${l.codigo} · ${l.nome_ativo || ''} · ${pct(l.indice)}`; }
    const f = h.obj; const l = levDe(f);
    return `${f.cam.nome}${f.nome ? ' · ' + f.nome : ''}${f.id_ativo ? ' · ' + f.id_ativo : ''}${l ? ' · ' + pct(l.indice) : ''}${f.sug && !f.lev ? ' (sugestão)' : ''}`;
  }

  /* ------------------------------------------------------------ telas */
  function render() {
    const app = $('#app');
    if (!SB.configurado()) { app.innerHTML = '<div class="login"><div class="cartao erro">O arquivo <b>config.js</b> não tem a URL e a chave do Supabase. Use o mesmo config.js do app de campo.</div></div>'; return; }
    if (!SB.sessao) { app.innerHTML = telaLogin(); return; }
    if (!$('#mapa')) {
      app.innerHTML = `<header class="topo">
          <button class="bt menu-mob" data-a="lado" aria-label="Painel">☰</button>
          <div class="marca"><span class="plq">PD-SLZ</span><span class="txt">WebGIS</span></div>
          <div class="kpis" id="kpis"></div>
          <div class="acoes"><select class="bt" id="selExp" aria-label="Exportar"><option value="">Exportar…</option><option value="feicoes">Base com diagnóstico (GeoJSON)</option><option value="levs">Levantamentos (GeoJSON)</option><option value="ncs">Não conformidades (GeoJSON)</option><option value="vinculos">Vínculos (CSV)</option><option value="cobertura">Cobertura (CSV)</option></select>
            <button class="bt" data-a="recarregar" title="Buscar dados novos no servidor" aria-label="Atualizar"><span class="lg">Atualizar</span><span class="ic">↻</span></button>
            <button class="bt" data-a="sair" title="Sair (${esc(SB.sessao.user.email || '')})" aria-label="Sair">Sair</button></div></header>
        <div class="corpo"><aside class="lado" id="lado"><div class="abas">
            <button data-a="aba" data-v="mapa">Mapa</button><button data-a="aba" data-v="vinculos">Vínculos</button><button data-a="aba" data-v="cobertura">Cobertura</button><button data-a="aba" data-v="importar">Importar</button></div>
            <div class="painel" id="painel"></div></aside>
          <main class="mapa" id="mapa"><div class="tiles" id="tiles"></div><canvas id="cv"></canvas>
            <div class="legenda" id="legenda"></div>
            <div class="ctl"><button data-a="zoom" data-v="1" aria-label="Aproximar">+</button><button data-a="zoom" data-v="-1" aria-label="Afastar">−</button><button data-a="tudo" aria-label="Enquadrar tudo" title="Enquadrar tudo">⤢</button>
              <select id="selBase" aria-label="Mapa de fundo">${Object.entries(BASES).map(([k, b]) => `<option value="${k}" ${S.base === k ? 'selected' : ''}>${b.nome}</option>`).join('')}</select></div>
            <div class="escala" id="escala"></div><div class="coords" id="coords"></div>
            <div class="dica oculto" id="dica"></div>
            <aside class="ficha" id="ficha" aria-live="polite"></aside>
            <div class="carregando oculto" id="carregando"></div></main></div>`;
      try { const v = JSON.parse(localStorage.getItem('pdslz_webgis_vista') || 'null'); if (v && Math.abs(v.lat) < 85 && Math.abs(v.lon) <= 180 && v.z >= 3 && v.z <= 20) Object.assign(V, { lat: v.lat, lon: v.lon, z: v.z }); } catch (e) { /* ok */ }
      montarMapa();
    }
    pintarTudo();
  }
  function pintarTudo() {
    $$('.abas button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.aba));
    $('#lado').classList.toggle('on', S.lado);
    $('#kpis').innerHTML = kpisHTML();
    $('#painel').innerHTML = painelHTML();
    $('#legenda').innerHTML = legendaHTML();
    pintarFicha();
    redesenhar();
  }
  function mostrarCarregando(txt) { const el = $('#carregando'); if (!el) return; el.textContent = txt || ''; el.classList.toggle('oculto', !txt); }
  function telaLogin() {
    return `<div class="login"><div class="linha" style="margin-bottom:14px"><span class="cod" style="font-size:16px;padding:4px 10px">PD-SLZ</span><b style="font-size:20px">WebGIS do Plano Diretor</b></div>
      <div class="cartao"><p class="peq mut" style="margin-top:0">Entre com o mesmo usuário do app de campo.</p>
        <div class="campo"><label for="lgE">E-mail</label><input class="inp" id="lgE" type="email" autocomplete="username"></div>
        <div class="campo"><label for="lgS">Senha</label><input class="inp" id="lgS" type="password" autocomplete="current-password"></div>
        <button class="bt pri" style="width:100%" data-a="entrar">Entrar</button><p class="peq" id="lgMsg" style="color:var(--nc);min-height:1.2em"></p></div>
      <p class="peq mut">Banco: ${esc(SB.url)} · versão ${VERSAO}</p></div>`;
  }

  function resumo() {
    const base = S.feicoes.filter((f) => !f.contexto);
    const lev = base.filter((f) => f.lev).length; const sug = base.filter((f) => !f.lev && f.sug).length;
    const levsComIdx = S.levs.filter((l) => l.indice != null);
    const nC = S.levs.reduce((s, l) => s + (l.n_c || 0) + (l.n_om || 0), 0); const nNC = S.levs.reduce((s, l) => s + (l.n_nc || 0), 0);
    return { base: base.length, lev, sug, semF: S.levs.filter((l) => !l.f).length, idx: nC + nNC ? nC / (nC + nNC) : null, nc: nNC,
      crit: S.levs.reduce((s, l) => s + (l.n_criticas || 0), 0), levs: S.levs.length, levsComIdx: levsComIdx.length };
  }
  function kpisHTML() {
    if (!S.carregado || !pode.ler()) return '';
    const r = resumo();
    return [[fmt(r.base), 'feições na base'], [r.base ? pct(r.lev / r.base) : '—', `levantadas (${fmt(r.lev)})`], [fmt(r.levs), 'levantamentos'],
      [pct(r.idx), 'índice geral'], [fmt(r.nc), 'não conformidades'], [fmt(r.crit), 'críticas'], [fmt(r.semF), 'sem feição vinculada']]
      .map(([b, s]) => `<div class="kpi"><b>${b}</b><span>${s}</span></div>`).join('');
  }

  function painelHTML() {
    if (S.perfil && S.perfil.papel === 'pendente') return '<div class="cartao aviso"><b>Acesso aguardando liberação</b><p class="peq">Peça ao coordenador para liberar seu usuário (Ajustes › Gerenciar equipe, no app de campo).</p></div>';
    if (!S.carregado) return '<p class="mut">Carregando…</p>';
    switch (S.aba) {
      case 'vinculos': return painelVinculos();
      case 'cobertura': return painelCobertura();
      case 'importar': return painelImportar();
      default: return painelMapa();
    }
  }
  function painelMapa() {
    const contagem = {}; S.feicoes.forEach((f) => { const c = contagem[f.camada] || (contagem[f.camada] = { n: 0, lev: 0 }); c.n++; if (f.lev) c.lev++; });
    const blocos = [...new Set(S.feicoes.map((f) => (f.contexto ? null : blocoDe(f) || 'sem bloco')).concat(S.levs.map((l) => l.bloco || 'sem bloco')).filter(Boolean))].sort();
    const grupos = [['poligono', 'Polígonos'], ['linha', 'Linhas'], ['ponto', 'Pontos']];
    const vazio = !S.feicoes.length;
    return `${vazio ? `<div class="cartao aviso"><b>A base geográfica ainda está vazia.</b><p class="peq">Importe os polígonos, linhas e pontos (GPKG do kit, GeoJSON, KML ou Shapefile) na aba <b>Importar</b>. Enquanto isso, o mapa mostra os pontos levantados em campo.</p></div>` : ''}
      <div class="campo"><label for="selModo">Colorir por</label><select class="inp" id="selModo">
        ${[['indice', 'Índice de conformidade'], ['situacao', 'Situação do vínculo'], ['criticidade', 'Criticidade máxima'], ['condicao', 'Condição geral'], ['tema', 'Índice por tema'], ['camada', 'Camada']].map(([k, t]) => `<option value="${k}" ${S.modo === k ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      ${S.modo === 'tema' ? `<div class="campo"><label for="selTema">Tema</label><select class="inp" id="selTema">${CAT.temas.map((t) => `<option value="${t.cod}" ${S.tema === t.cod ? 'selected' : ''}>${esc(t.nome)}</option>`).join('')}</select></div>` : ''}
      <div class="campo"><label for="busca">Buscar código ou nome</label><input class="inp" id="busca" value="${esc(S.busca)}" placeholder="ex.: ED-A-0012, vestiário"></div>
      ${S.busca ? resultadosBusca() : ''}
      ${blocos.length ? `<h3>Blocos</h3><div class="chips">${blocos.map((b) => `<button class="${S.blocos.has(b) ? 'on' : ''}" data-a="bloco" data-v="${esc(b)}">${esc(b)}</button>`).join('')}${S.blocos.size ? '<button data-a="blocoLimpar">Todos</button>' : ''}</div>` : ''}
      <h3>Situação</h3><div class="chips">${['confirmado', 'sugerido', 'sem', 'codigo'].map((k) => `<button class="${S.filtroSit.has(k) ? 'on' : ''}" data-a="sit" data-v="${k}">${{ confirmado: 'Levantadas', sugerido: 'Sugestões', sem: 'Não levantadas', codigo: 'Código sem levantamento' }[k]}</button>`).join('')}</div>
      <h3>Dados de campo</h3><div class="camadas">
        <div class="cam"><label><input type="checkbox" data-a="ver" data-v="verLevs" ${S.verLevs ? 'checked' : ''}><span class="sw c" style="background:#1E7B47;transform:rotate(45deg);border-radius:2px"></span>Pontos dos levantamentos</label><span class="n">${S.levs.length}</span></div>
        <div class="cam"><label><input type="checkbox" data-a="ver" data-v="verTracados" ${S.verTracados ? 'checked' : ''}><span class="sw" style="background:none;border:2px dashed #8E44AD"></span>Traçados feitos no app</label><span class="n">${S.levs.filter((l) => l.tr).length}</span></div>
        <div class="cam"><label><input type="checkbox" data-a="ver" data-v="verNC" ${S.verNC ? 'checked' : ''}><span class="sw" style="background:#B71C1C;transform:rotate(45deg);width:11px;height:11px"></span>Não conformidades</label><span class="n">${S.ncs.length}</span></div></div>
      <h3>Base geográfica</h3><div class="camadas">${grupos.map(([g, t]) => {
        const cs = S.camadas.filter((c) => c.geometria === g && contagem[c.cod]);
        if (!cs.length) return '';
        return `<div class="grupo">${t}</div>` + cs.map((c) => `<div class="cam"><label><input type="checkbox" data-a="cam" data-v="${c.cod}" ${S.camVis.has(c.cod) ? 'checked' : ''}><span class="sw ${g === 'ponto' ? 'c' : ''}" style="background:${c.cor}"></span>${esc(c.nome)}</label><span class="n">${c.escopo ? `${contagem[c.cod].lev}/` : ''}${contagem[c.cod].n}</span></div>`).join('');
      }).join('') || '<p class="mut peq">Nenhuma camada importada.</p>'}</div>
      <p class="peq mut" style="margin-top:14px">Atualizado ${S.atualizadoEm ? S.atualizadoEm.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—'} · perfil ${esc(S.perfil.papel)} · WebGIS ${VERSAO}</p>`;
  }
  function resultadosBusca() {
    const q = S.busca;
    const fs = S.feicoes.filter((f) => !f.contexto && `${f.id_ativo || ''} ${f.nome || ''}`.toLowerCase().includes(q)).slice(0, 8);
    const ls = S.levs.filter((l) => `${l.codigo} ${l.nome_ativo || ''}`.toLowerCase().includes(q)).slice(0, 8);
    if (!fs.length && !ls.length) return '<p class="peq mut">Nada encontrado.</p>';
    return `<div class="lista-v">${ls.map((l) => `<div class="it"><span class="cod">${esc(l.codigo)}</span><div class="meio"><b>${esc(l.nome_ativo || '')}</b><span class="peq mut">${esc(ESC[l.escopo] ? ESC[l.escopo].curto : l.escopo)} · ${esc(l.bloco || '')}</span></div><button class="lnk" data-a="selLev" data-id="${l.id}">ver</button></div>`).join('')}
      ${fs.map((f) => `<div class="it"><span class="sw" style="background:${f.cam.cor}"></span><div class="meio"><b>${esc(f.nome || f.id_ativo || f.cam.nome)}</b><span class="peq mut">${esc(f.cam.nome)}${f.id_ativo ? ' · ' + esc(f.id_ativo) : ''}</span></div><button class="lnk" data-a="selFeicao" data-id="${f.id}">ver</button></div>`).join('')}</div>`;
  }

  function painelVinculos() {
    const sug = S.levs.filter((l) => !l.f && l.sug).sort((a, b) => a.sug.d - b.sug.d);
    const semF = S.levs.filter((l) => !l.f && !l.sug);
    const codSemLev = S.feicoes.filter((f) => f.id_ativo && !f.lev);
    const blocoDiv = S.levs.filter((l) => l.blocoGeo && l.bloco && l.blocoGeo !== l.bloco);
    const conf = S.levs.filter((l) => l.f).length;
    const naoAmb = sug.filter((l) => !l.sug.amb);
    const g = pode.gravar(); const c = pode.coord();
    return `<p class="peq">A feição da base fica ligada ao levantamento pelo <b>código do ativo</b> (campo <code>id_ativo</code> = código do app). Quando a base ainda não tem o código, o WebGIS sugere a feição pela posição do GPS – dentro do polígono ou perto da linha ou do ponto, no mesmo escopo – e você confirma.</p>
      <div class="cartao"><div class="linha" style="justify-content:space-between"><b>Tolerância</b><span class="peq mut">distância máxima do GPS</span></div>
        <div class="linha" style="margin-top:6px">${[['poligono', 'Polígono'], ['linha', 'Linha'], ['ponto', 'Ponto']].map(([k, t]) => `<label class="peq" style="flex:1">${t}<input class="inp" type="number" min="0" max="200" step="1" data-tol="${k}" value="${S.tol[k]}"> </label>`).join('')}</div></div>
      <table class="tb"><tr><td>Vínculos confirmados</td><td class="n"><b>${conf}</b></td></tr><tr><td>Sugestões pela posição${sug.length - naoAmb.length ? ` <span class="peq mut">· ${sug.length - naoAmb.length} ambígua${sug.length - naoAmb.length > 1 ? 's' : ''}</span>` : ''}</td><td class="n"><b>${sug.length}</b></td></tr>
        <tr><td>Levantamentos sem feição</td><td class="n"><b>${semF.length}</b></td></tr><tr><td>Códigos na base ainda não levantados</td><td class="n"><b>${codSemLev.length}</b></td></tr>
        <tr><td>Bloco digitado diferente do polígono de bloco</td><td class="n"><b>${blocoDiv.length}</b></td></tr></table>
      <h3>Sugestões (${sug.length})</h3>
      ${sug.length ? `${g ? `<div class="linha" style="margin-bottom:6px"><button class="bt pri peq" data-a="confSem" ${naoAmb.length ? '' : 'disabled'}>Confirmar as ${naoAmb.length} sem ambiguidade</button><button class="bt peq" data-a="confMarc" ${S.marcadas.size ? '' : 'disabled'}>Confirmar marcadas (${S.marcadas.size})</button></div>` : '<p class="peq mut">Seu perfil só consulta: peça a um inspetor ou ao coordenador para confirmar.</p>'}
        <div class="lista-v">${sug.map((l) => `<div class="it">${g ? `<input type="checkbox" data-a="marca" data-id="${l.id}" ${S.marcadas.has(l.id) ? 'checked' : ''} aria-label="Marcar">` : ''}<span class="cod">${esc(l.codigo)}</span>
          <div class="meio"><b>${esc(l.sug.f.nome || l.sug.f.cam.nome)}</b><span class="peq mut">${esc(l.sug.f.cam.nome)} · ${l.sug.d === 0 ? 'GPS dentro' : fmt(l.sug.d, 1) + ' m'}${l.sug.amb ? ' · <b style="color:var(--nv)">ambígua</b>' : ''}</span></div>
          <button class="lnk" data-a="selLev" data-id="${l.id}">ver</button></div>`).join('')}</div>` : '<p class="peq mut">Nenhuma sugestão pendente.</p>'}
      <h3>Levantamentos sem feição (${semF.length})</h3>
      ${semF.length ? `<p class="peq mut">Não há feição do mesmo escopo dentro da tolerância. Importe a camada correspondente, aumente a tolerância ou ${c ? 'crie a feição a partir do traçado ou do GPS do app.' : 'peça ao coordenador para criar a feição.'}</p>
        <div class="lista-v">${semF.map((l) => `<div class="it"><span class="cod">${esc(l.codigo)}</span><div class="meio"><b>${esc(l.nome_ativo || '')}</b><span class="peq mut">${esc(ESC[l.escopo] ? ESC[l.escopo].curto : l.escopo)} · ${esc(l.bloco || '—')}${l.tr ? ' · com traçado' : ''}</span></div>
          <button class="lnk" data-a="selLev" data-id="${l.id}">ver</button>${c ? `<button class="lnk" data-a="criarDe" data-id="${l.id}">criar feição</button>` : ''}</div>`).join('')}</div>` : '<p class="peq mut">Todos os levantamentos têm feição.</p>'}
      ${codSemLev.length ? `<h3>Códigos na base sem levantamento (${codSemLev.length})</h3><div class="lista-v">${codSemLev.slice(0, 200).map((f) => `<div class="it"><span class="cod">${esc(f.id_ativo)}</span><div class="meio"><b>${esc(f.nome || f.cam.nome)}</b><span class="peq mut">${esc(f.cam.nome)} · ainda não levantado</span></div><button class="lnk" data-a="selFeicao" data-id="${f.id}">ver</button></div>`).join('')}</div>` : ''}
      ${blocoDiv.length ? `<h3>Bloco divergente (${blocoDiv.length})</h3><div class="lista-v">${blocoDiv.map((l) => `<div class="it"><span class="cod">${esc(l.codigo)}</span><div class="meio"><b>digitado ${esc(l.bloco)} · polígono ${esc(l.blocoGeo)}</b><span class="peq mut">corrija o bloco no app ou o polígono no QGIS</span></div><button class="lnk" data-a="selLev" data-id="${l.id}">ver</button></div>`).join('')}</div>` : ''}`;
  }

  function tabelaCobertura(chave) {
    const linhas = {};
    S.feicoes.filter((f) => !f.contexto).forEach((f) => {
      const k = chave === 'camada' ? f.cam.nome : (blocoDe(f) || 'sem bloco');
      const o = linhas[k] || (linhas[k] = { n: 0, lev: 0, sug: 0, crit: 0 });
      o.n++; if (f.lev) { o.lev++; if (f.lev.n_criticas) o.crit++; } else if (f.sug) o.sug++;
    });
    return Object.entries(linhas).sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'));
  }
  function painelCobertura() {
    if (!S.feicoes.length) return '<div class="cartao aviso">Importe a base geográfica para ver a cobertura do levantamento (o que existe na base × o que já foi levantado).</div>';
    const tab = (titulo, linhas) => `<h3>${titulo}</h3><table class="tb cob"><tr><th></th><th class="n">Levantadas</th><th>Cobertura</th></tr>
      ${linhas.map(([k, o]) => `<tr><td>${esc(k)}${o.sug ? `<span class="peq mut" style="display:block">+${o.sug} sugest${o.sug > 1 ? 'ões' : 'ão'}</span>` : ''}${o.crit ? `<span class="peq" style="display:block;color:var(--nc)">${o.crit} com NC crítica</span>` : ''}</td><td class="n">${o.lev} / ${o.n}</td><td><div class="prog"><i style="width:${(o.lev / o.n * 100).toFixed(0)}%"></i></div><span class="peq mut">${pct(o.lev / o.n)}</span></td></tr>`).join('')}</table>`;
    const r = resumo();
    return `<div class="cartao"><b>${pct(r.base ? r.lev / r.base : null)}</b> das ${fmt(r.base)} feições da base já têm levantamento confirmado${r.sug ? `; mais ${fmt(r.sug)} têm sugestão pela posição (confirme na aba Vínculos)` : ''}.
      <div class="prog"><i style="width:${r.base ? (r.lev / r.base * 100).toFixed(1) : 0}%"></i></div>
      <button class="bt peq" data-a="soNaoLev">Mostrar só as não levantadas no mapa</button></div>
      ${tab('Por camada', tabelaCobertura('camada'))}${tab('Por bloco', tabelaCobertura('bloco'))}
      <p class="peq mut">Camadas de contexto (setores/blocos, restrições, demandas, propostas, redes) não entram na conta.</p>`;
  }

  /* ------------------------------------------------------------ importar base */
  const KIT = {
    pd_setor_bloco: { camada: 'setor_bloco', id: null, nome: 'nome_bloco' }, pd_zoneamento: { camada: 'zoneamento', id: 'id_area', nome: 'nome_area' },
    pd_edificacao: { camada: 'edificacao', id: 'id_ativo', nome: 'nome' }, pd_estacionamento: { camada: 'estacionamento', id: 'id_ativo', nome: 'nome' },
    pd_canteiro: { camada: 'canteiro', id: 'id_ativo', nome: 'empresa' }, pd_area_verde: { camada: 'area_verde', id: 'id_ativo', nome: 'tipologia' },
    pd_restricao: { camada: 'restricao', id: null, nome: 'tipo_restricao' }, pd_demanda: { camada: 'demanda', id: null, nome: 'descricao' },
    pd_proposta_to_be: { camada: 'proposta', id: null, nome: 'titulo' }, pd_via: { camada: 'via', id: 'id_ativo', nome: 'nome' },
    pd_caminho_seguro: { camada: 'caminho_seguro', id: 'id_ativo', nome: 'tipo' }, pd_cercamento: { camada: 'cercamento', id: 'id_ativo', nome: 'tipo_cerca' },
    pd_rede_utilidade: { camada: 'rede_utilidade', id: 'id_ativo', nome: 'tipo_rede' }, pd_iluminacao: { camada: 'iluminacao', id: 'id_ativo', nome: 'tecnologia' },
    pd_estrutura_provisoria: { camada: 'estrutura_provisoria', id: 'id_ativo', nome: 'tipo_provisoria' }, pd_infra_ponto: { camada: 'infra_ponto', id: 'id_ativo', nome: 'nome' },
  };
  const KIT_IGNORAR = ['pd_achado', 'pd_foto', 'pd_inspecao'];
  // subtipo da camada pd_infra_ponto do kit → escopo do app (para o vínculo pela posição)
  const SUBTIPO_ESC = { PORT: 'PO', PONB: 'PB', RODO: 'PB', CFTV: 'UT', SENS: 'UT', POCO: 'EA', RESV: 'EA', GERA: 'UT', SUBE: 'UT', UPS: 'UT', ETE: 'ET', SAO: 'ET', CRES: 'DI', COLS: 'DI', RACK: 'UT', HIDR: 'HI', BEBE: 'EA', ARVR: 'AV' };
  function escopoDaFeicao(props, cam) {
    if (!cam || cam.escopo || cam.geometria !== 'ponto') return null;
    const k = Object.keys(props || {}).find((x) => /^(escopo|subtipo)$/i.test(x)); if (!k) return null;
    const v = String(props[k] ?? '').trim().toUpperCase();
    if (ESC[v] && ESC[v].geom === 'ponto') return v;
    return SUBTIPO_ESC[v] || null;
  }
  const PALAVRAS = [[/edific|predio|pr[eé]dio|galp/, 'edificacao'], [/bloco|setor/, 'setor_bloco'], [/zone|area_?livre|zoneam/, 'zoneamento'], [/estacion|parking/, 'estacionamento'], [/canteiro/, 'canteiro'],
    [/verde|gram|jardim|vegeta/, 'area_verde'], [/restri|app\b|faixa_dom/, 'restricao'], [/\bvia|rua|estrada|road|vi[aá]rio/, 'via'], [/cal[cç]ada|caminho|passeio|pedestre/, 'caminho_seguro'],
    [/cerca|muro|alambrado|fence/, 'cercamento'], [/rede|tubula|duto|cabo/, 'rede_utilidade'], [/poste|ilumin|lumin/, 'iluminacao'], [/placa|sinaliz/, 'sinalizacao'], [/faixa|travessia/, 'travessia'],
    [/parada|onibus|ônibus|ponto_?bus/, 'parada'], [/drena|boca|bueiro|grelha|caixa/, 'drenagem'], [/hidrante/, 'hidrante'], [/[aá]rvore|tree/, 'arvore'], [/container|contêiner|provis/, 'estrutura_provisoria']];
  function acharCampo(props, nomes) { const ks = Object.keys(props || {}); for (const n of nomes) { const k = ks.find((x) => x.toLowerCase() === n); if (k) return k; } return ''; }
  function prepararImportacao(res, nomeArq) {
    const vazias = res.camadas.filter((c) => !c.feicoes.length && !c.total).map((c) => c.nome);
    const camadas = res.camadas.filter((c) => c.feicoes.length || c.total).map((c) => {
      const kit = KIT[c.nome]; const tipo = tipoDe(c.feicoes[0] && c.feicoes[0].g);
      const amostra = Object.assign({}, ...c.feicoes.slice(0, 20).map((f) => f.props));
      let destino = kit ? kit.camada : null;
      if (!destino) { const low = c.nome.toLowerCase(); const p = PALAVRAS.find(([re, cam]) => re.test(low) && S.CAM[cam] && S.CAM[cam].geometria === tipo); destino = p ? p[1] : (tipo === 'poligono' ? 'zoneamento' : tipo === 'linha' ? 'via' : 'outro_ponto'); }
      return { nome: c.nome, crs: c.crs, crsCod: c.crs ? c.crs.cod : '', feicoes: c.feicoes, erros: c.erros, total: c.total, tipo,
        incluir: c.feicoes.length > 0 && !KIT_IGNORAR.includes(c.nome), destino, escopo: '',
        campoId: kit ? (kit.id && amostra[kit.id] !== undefined ? kit.id : '') : acharCampo(amostra, ['id_ativo', 'codigo_ativo', 'codigo', 'cod_ativo']),
        campoNome: kit ? (kit.nome in amostra ? kit.nome : '') : acharCampo(amostra, ['nome', 'name', 'nome_area', 'nome_bloco', 'titulo', 'descricao'].concat(Object.values(KIT).filter((x) => x.camada === destino).map((x) => x.nome), ['tipologia', 'tipo', 'descricao'])),
        campoBloco: acharCampo(amostra, ['id_bloco', 'bloco']), campos: Object.keys(amostra), auto: !kit && !c.nome.match(/./) };
    });
    S.imp = { arquivo: nomeArq, camadas, vazias, aviso: res.aviso || '', modo: 'adicionar', enviando: false, progresso: 0, resultado: null };
  }
  function painelImportar() {
    if (!pode.coord()) return '<div class="cartao">A base geográfica é mantida pelo coordenador. Seu perfil pode consultar o mapa e os vínculos.</div>';
    const I = S.imp;
    const intro = `<p class="peq">Envie os polígonos, linhas e pontos da base: o <b>PD-SLZ_07_Base_Geografica.gpkg</b> do kit (todas as camadas de uma vez), GeoJSON, KML/KMZ do Google Earth ou Shapefile compactado em ZIP. Coordenadas em SIRGAS 2000 / UTM são convertidas para WGS 84.</p>
      <p class="peq mut">Se a camada tiver o campo <code>id_ativo</code> com o código do app (ex.: ED-A-0012), o vínculo já vem pronto.</p>
      <button class="bt pri" data-a="escolherArq">Escolher arquivo…</button>`;
    if (!I) return intro;
    if (I.resultado) return `${intro}<div class="cartao ${I.resultado.erro ? 'erro' : ''}"><b>${esc(I.resultado.titulo)}</b><p class="peq">${esc(I.resultado.texto)}</p></div>`;
    const opCam = (sel, tipo) => S.camadas.filter((c) => c.geometria === tipo).map((c) => `<option value="${c.cod}" ${sel === c.cod ? 'selected' : ''}>${esc(c.nome)}</option>`).join('');
    const opCampo = (cs, sel) => `<option value="">(nenhum)</option>` + cs.map((k) => `<option ${sel === k ? 'selected' : ''}>${esc(k)}</option>`).join('');
    const sel = I.camadas.filter((c) => c.incluir);
    return `${intro}<h3>${esc(I.arquivo)}</h3>${I.aviso ? `<div class="cartao aviso peq">${esc(I.aviso)}</div>` : ''}
      ${I.camadas.map((c, k) => `<div class="cartao" ${c.feicoes.length ? '' : 'style="opacity:.55"'}>
        <label class="linha"><input type="checkbox" data-a="impInc" data-k="${k}" ${c.incluir ? 'checked' : ''} ${c.feicoes.length ? '' : 'disabled'}><b style="flex:1">${esc(c.nome)}</b><span class="peq mut">${fmt(c.feicoes.length)} ${c.tipo ? { poligono: 'polígonos', linha: 'linhas', ponto: 'pontos' }[c.tipo] : 'feições'}</span></label>
        ${c.erros ? `<p class="peq" style="color:var(--nc)">${c.erros} geometria(s) ignorada(s) (tipo não suportado).</p>` : ''}
        ${!c.feicoes.length ? '<p class="peq mut">Nenhuma geometria válida.</p>' : KIT_IGNORAR.includes(c.nome) ? '<p class="peq mut">Camada de dados de campo do kit: os achados e fotos vêm do app, não precisam ser importados.</p>' : ''}
        ${c.incluir ? `<div class="campo"><label>Camada de destino</label><select class="inp" data-imp="destino" data-k="${k}">${opCam(c.destino, c.tipo)}</select></div>
          <div class="linha"><div class="campo" style="flex:1"><label>Campo do código (id_ativo)</label><select class="inp" data-imp="campoId" data-k="${k}">${opCampo(c.campos, c.campoId)}</select></div>
            <div class="campo" style="flex:1"><label>Campo do nome</label><select class="inp" data-imp="campoNome" data-k="${k}">${opCampo(c.campos, c.campoNome)}</select></div></div>
          <div class="linha"><div class="campo" style="flex:1"><label>Campo do bloco</label><select class="inp" data-imp="campoBloco" data-k="${k}">${opCampo(c.campos, c.campoBloco)}</select></div>
            <div class="campo" style="flex:1"><label>Sistema de coordenadas</label><select class="inp" data-imp="crsCod" data-k="${k}">${[...new Set([c.crsCod].concat(CRS_OPCOES))].filter(Boolean).map((cod) => `<option value="${cod}" ${c.crsCod === cod ? 'selected' : ''}>${esc((crsDe(cod) || { nome: cod }).nome)}</option>`).join('')}${!c.crs || !c.crs.conv ? '<option value="" selected>Não identificado – escolha</option>' : ''}</select></div></div>
          ${S.CAM[c.destino] && !S.CAM[c.destino].escopo && c.tipo === 'ponto' ? `<div class="campo"><label>Escopo dos pontos (para o vínculo)</label><select class="inp" data-imp="escopo" data-k="${k}"><option value="">Automático (campo subtipo/escopo, senão qualquer ponto)</option>${CAT.escopos.filter((e) => e.geom === 'ponto').map((e) => `<option value="${e.cod}" ${c.escopo === e.cod ? 'selected' : ''}>${e.cod} – ${esc(e.curto)}</option>`).join('')}</select></div>` : ''}` : ''}
      </div>`).join('')}
      ${I.vazias && I.vazias.length ? `<p class="peq mut">Camadas vazias no arquivo (ignoradas): ${esc(I.vazias.join(', '))}.</p>` : ''}
      <div class="campo"><span class="rot">Se a camada de destino já tiver feições</span><div class="chips"><button class="${I.modo === 'adicionar' ? 'on' : ''}" data-a="impModo" data-v="adicionar">Adicionar</button><button class="${I.modo === 'substituir' ? 'on' : ''}" data-a="impModo" data-v="substituir">Substituir</button></div>
        <p class="peq mut">${I.modo === 'substituir' ? 'Apaga as feições atuais das camadas de destino antes de enviar. Vínculos feitos no WebGIS que não estejam no arquivo serão perdidos.' : 'Soma às feições que já existem.'}</p></div>
      ${I.enviando ? `<div class="prog"><i style="width:${(I.progresso * 100).toFixed(0)}%"></i></div><p class="peq">Enviando… ${pct(I.progresso)}</p>` : `<div class="linha"><button class="bt pri" data-a="impEnviar" ${sel.length ? '' : 'disabled'}>Enviar ${fmt(sel.reduce((s, c) => s + c.feicoes.length, 0))} feições</button><button class="bt" data-a="impCancelar">Cancelar</button></div>`}`;
  }
  function primitivo(v) { if (v == null) return null; if (v instanceof Uint8Array) return undefined; if (typeof v === 'object') return undefined; return v; }
  async function enviarImportacao() {
    const I = S.imp; const sel = I.camadas.filter((c) => c.incluir && c.feicoes.length);
    for (const c of sel) { const crs = crsDe(c.crsCod); if (!crs || !crs.conv) { toast(`Escolha o sistema de coordenadas de ${c.nome}`); return; } }
    const destinos = [...new Set(sel.map((c) => c.destino))];
    if (I.modo === 'substituir' && !confirm(`Apagar as feições atuais de: ${destinos.map((d) => S.CAM[d].nome).join(', ')}?`)) return;
    const linhas = []; let ignoradas = 0; const codigosArq = new Set(); const repetidos = new Set();
    const ocupados = new Set(S.feicoes.filter((f) => f.id_ativo && !(I.modo === 'substituir' && destinos.includes(f.camada))).map((f) => f.id_ativo));
    for (const c of sel) {
      const conv = crsDe(c.crsCod).conv; const cam = S.CAM[c.destino];
      for (const fe of c.feicoes) {
        const g = converterGeom(fe.g, conv);
        if (!g || tipoDe(g) !== cam.geometria) { ignoradas++; continue; }
        let cod = c.campoId ? String(fe.props[c.campoId] ?? '').trim().toUpperCase() : '';
        if (cod && !/^[A-Z]{2}-[A-Z]-\d{4}$/.test(cod)) cod = '';
        if (cod && (codigosArq.has(cod) || ocupados.has(cod))) { repetidos.add(cod); cod = ''; }
        if (cod) codigosArq.add(cod);
        const atributos = {}; Object.entries(fe.props).forEach(([k, v]) => { const p = primitivo(v); if (p !== undefined && p !== null && p !== '') atributos[k] = p; });
        const ng = normGeom(g); const m = medidas(ng);
        linhas.push({ camada: c.destino, escopo: c.escopo || escopoDaFeicao(fe.props, cam), id_ativo: cod || null, nome: c.campoNome && fe.props[c.campoNome] != null ? String(fe.props[c.campoNome]).slice(0, 200) : null,
          id_bloco: c.campoBloco && fe.props[c.campoBloco] != null ? String(fe.props[c.campoBloco]).slice(0, 10) : null, atributos, geojson: g,
          area_m2: m.area != null ? Math.round(m.area * 10) / 10 : null, comprimento_m: m.comp != null ? Math.round(m.comp * 10) / 10 : null,
          fonte: `${I.arquivo}${c.nome && c.nome !== I.arquivo ? ' › ' + c.nome : ''}`.slice(0, 200), vinculo_origem: cod ? 'importado' : null });
      }
    }
    if (!linhas.length) { toast('Nenhuma feição compatível com as camadas de destino'); return; }
    I.enviando = true; I.progresso = 0; pintarTudo();
    try {
      if (I.modo === 'substituir') await SB.apagar('pd_geo_feicoes', `camada=in.(${destinos.join(',')})`);
      // lotes de até 250 feições ou ~1,5 MB (geometrias com muitos vértices)
      let k = 0;
      while (k < linhas.length) {
        let fim = k; let tam = 0;
        while (fim < linhas.length && fim - k < 250 && (fim === k || tam < 1.5e6)) { tam += JSON.stringify(linhas[fim].geojson).length + 400; fim++; }
        await SB.inserir('pd_geo_feicoes', linhas.slice(k, fim));
        k = fim; I.progresso = k / linhas.length; $('#painel').innerHTML = painelHTML();
      }
      I.resultado = { titulo: `${fmt(linhas.length)} feições enviadas`, texto: `${ignoradas ? `${ignoradas} ignorada(s) por tipo de geometria diferente da camada de destino. ` : ''}${repetidos.size ? `Códigos repetidos ou já usados (enviados sem vínculo): ${[...repetidos].slice(0, 12).join(', ')}${repetidos.size > 12 ? '…' : ''}. ` : ''}Confira os vínculos na aba Vínculos.` };
      await carregar(); enquadrarTudo();
    } catch (e) {
      I.resultado = { erro: true, titulo: 'Falha no envio', texto: e.message + (I.progresso ? ` (parte das feições pode ter sido enviada: ${pct(I.progresso)})` : '') };
      await carregar().catch(() => null);
    } finally { I.enviando = false; pintarTudo(); }
  }

  /* ------------------------------------------------------------ ficha */
  const FOTOS = new Map();
  async function selecionar(h) {
    S.sel = h; pintarFicha(); redesenhar();
    if (h && window.innerWidth < 900) S.lado = false;
    const l = h ? (h.tipo === 'lev' ? h.obj : h.tipo === 'feicao' ? levDe(h.obj) : h.tipo === 'nc' ? S.levs.find((x) => x.codigo === h.obj.codigo_ativo) : null) : null;
    if (l && !FOTOS.has(l.id)) {
      try {
        const fs = await SB.select('pd_fotos', `select=storage_path,tipo,item_id,legenda,nome_padrao&levantamento_id=eq.${l.id}&order=tipo`);
        const urls = await SB.assinar(fs.map((f) => f.storage_path));
        FOTOS.set(l.id, fs.map((f) => Object.assign(f, { url: (urls.find((u) => u.path === f.storage_path) || {}).url })));
      } catch (e) { FOTOS.set(l.id, []); }
      if (S.sel === h) pintarFicha();
    }
    if (l && !S.temaIdx) carregarTemas().then(() => { if (S.sel === h) pintarFicha(); });
  }
  async function carregarTemas() {
    if (S.temaIdx) return;
    try { const r = await SB.tudo('pd_vw_indice_ativo_tema', 'select=levantamento_id,tema,indice&order=levantamento_id'); const m = {}; r.forEach((x) => { (m[x.levantamento_id] = m[x.levantamento_id] || {})[x.tema] = x.indice == null ? null : Number(x.indice); }); S.temaIdx = m; }
    catch (e) { S.temaIdx = {}; }
  }
  function blocoDiagnostico(l) {
    const ncs = S.ncs.filter((n) => n.codigo_ativo === l.codigo).sort((a, b) => (ORD_CRIT[a.criticidade] || 9) - (ORD_CRIT[b.criticidade] || 9));
    const al = S.alertas[l.id] || []; const tm = S.temaIdx && S.temaIdx[l.id];
    const fotos = FOTOS.get(l.id);
    return `<div class="cartao"><div class="linha" style="justify-content:space-between"><span class="cod">${esc(l.codigo)}</span><span class="peq mut">${esc(ESC[l.escopo] ? ESC[l.escopo].curto : l.escopo)} · ${esc(l.bloco || '—')}</span></div>
        <b style="display:block;margin-top:6px">${esc(l.nome_ativo || '')}</b>
        <div class="indice-g" style="margin-top:8px"><b style="color:${corIdx(l.indice)}">${pct(l.indice)}</b><span class="peq mut">índice de conformidade<br>${brData(l.data_levantamento)} · equipe ${esc(l.equipe || '—')} · ${esc(l.inspetor || '')}</span></div>
        <div class="cont">${[['C', l.n_c, 'var(--ok)'], ['NC', l.n_nc, 'var(--nc)'], ['OM', l.n_om, 'var(--om)'], ['NA', l.n_na, 'var(--ink-3)'], ['NV', l.n_nv, 'var(--nv)']].map(([k, v, c]) => `<div><b style="color:${c}">${v || 0}</b><span class="peq">${k}</span></div>`).join('')}</div>
        <dl class="kv" style="margin-top:8px"><dt>Condição</dt><dd>${l.condicao_geral ? l.condicao_geral + ' de 5' : '—'}</dd><dt>Criticidade máx.</dt><dd>${l.crit_max ? selo(l.crit_max, COR_CRIT[l.crit_max]) : '—'}</dd><dt>Ações abertas</dt><dd>${l.n_acoes_abertas || 0}</dd><dt>GPS</dt><dd>${l.ll ? `${l.ll[1].toFixed(6)}, ${l.ll[0].toFixed(6)}${l.precisao_m ? ` (±${fmt(l.precisao_m, 1)} m)` : ''}` : 'sem ponto'}</dd></dl></div>
      ${al.length ? `<div class="cartao aviso"><b>Alertas de cruzamento</b>${al.map((a) => `<div class="peq" style="margin-top:4px"><b>${esc(a.regra)}</b> ${esc(a.alerta)}</div>`).join('')}</div>` : ''}
      ${tm ? `<h3>Índice por tema</h3>${Object.entries(tm).filter(([, v]) => v != null).sort((a, b) => a[1] - b[1]).map(([t, v]) => `<div class="barra"><span>${esc(TEMA[t] || t)}</span><span class="tr"><i style="width:${(v * 100).toFixed(0)}%;background:${corIdx(v)}"></i></span><span class="num">${pct(v)}</span></div>`).join('')}` : ''}
      <h3>Não conformidades e melhorias (${ncs.length})</h3>
      ${ncs.length ? ncs.map((n) => `<div class="nc" style="border-left-color:${COR_CRIT[n.criticidade] || CINZA}"><div class="linha" style="justify-content:space-between"><b>${esc(n.item_id)}</b>${selo(n.criticidade, COR_CRIT[n.criticidade] || CINZA)}</div>
          <div>${esc(n.o_que)}</div><div class="peq mut">${esc(n.quem || '')} · até ${brData(n.quando)} · ${esc(n.situacao || n.status || '')}${n.gut ? ' · GUT ' + n.gut : ''}${n.local_pela_foto ? ' · local pela foto' : ''}</div></div>`).join('') : '<p class="peq mut">Nenhuma.</p>'}
      <h3>Fotos${fotos ? ` (${fotos.length})` : ''}</h3>
      ${!fotos ? '<p class="peq mut">Carregando…</p>' : fotos.length ? `<div class="fotos">${fotos.map((f, i) => `<button data-a="foto" data-id="${l.id}" data-i="${i}" title="${esc(f.nome_padrao || '')}">${f.url ? `<img src="${f.url}" alt="${esc(f.tipo)}" loading="lazy">` : ''}<span>${esc(f.tipo)}${f.item_id ? ' ' + esc(f.item_id) : ''}</span></button>`).join('')}</div>` : '<p class="peq mut">Sem fotos.</p>'}`;
  }
  function pintarFicha() {
    const el = $('#ficha'); if (!el) return;
    const h = S.sel;
    if (!h) { el.classList.remove('on'); el.innerHTML = ''; return; }
    el.classList.add('on');
    let tit = ''; let sub = ''; let corpo = '';
    const g = pode.gravar();
    if (h.tipo === 'feicao') {
      const f = h.obj; const sit = situacao(f); const l = levDe(f);
      tit = f.nome || f.id_ativo || f.cam.nome; sub = f.cam.nome;
      const m = f.area_m2 != null ? `${fmt(f.area_m2, 0)} m²` : f.comprimento_m != null ? `${fmt(f.comprimento_m, 0)} m` : null;
      let vinc = '';
      if (f.contexto) vinc = `<p class="peq mut">Camada de contexto: não se liga a levantamentos.${f.camada === 'setor_bloco' ? ` Os levantamentos dentro deste polígono são do bloco ${esc(f.id_bloco || '—')}.` : ''}</p>`;
      else if (f.lev) vinc = `<p>${selo('Levantado', COR_SIT.confirmado)} <span class="peq mut">vínculo ${esc({ importado: 'importado da base', automatico: 'confirmado pela posição', manual: 'feito manualmente', campo: 'criado do app' }[f.vinculo_origem] || 'pelo código')}${f.vinculado_em ? ' em ' + brData(f.vinculado_em) : ''}</span></p>${g ? '<button class="bt peq alerta" data-a="desvincular">Desvincular</button>' : ''}`;
      else if (f.id_ativo) vinc = `<p>${selo('Código sem levantamento', COR_SIT.codigo)}</p><p class="peq">A base indica o código <b>${esc(f.id_ativo)}</b>, mas ainda não há levantamento enviado com ele.</p>${g ? '<button class="bt peq" data-a="desvincular">Limpar código</button>' : ''}`;
      else if (f.sug) vinc = `<p>${selo('Sugestão', COR_SIT.sugerido)} <b>${esc(f.sug.lev.codigo)}</b> <span class="peq mut">${f.sug.d === 0 ? 'GPS dentro da feição' : 'a ' + fmt(f.sug.d, 1) + ' m'}${f.sug.amb ? ' · há outra feição próxima' : ''}</span></p>${g ? `<button class="bt pri peq" data-a="confirmar" data-cod="${esc(f.sug.lev.codigo)}">Confirmar vínculo</button>` : ''}`;
      else vinc = `<p>${selo('Não levantado', COR_SIT.sem)}</p>`;
      if (!f.contexto && !f.lev && g) {
        const perto = S.levs.filter((x) => compativel(f, x) && !x.f && pontoRef(x)).map((x) => ({ x, d: distGeom(pontoRef(x), f.ng).d })).sort((a, b) => a.d - b.d).slice(0, 8);
        vinc += `<div class="campo" style="margin-top:10px"><label for="inCod">Vincular a outro código</label><div class="linha"><input class="inp" id="inCod" list="dlCod" placeholder="ED-A-0001" style="flex:1;text-transform:uppercase"><button class="bt peq" data-a="vincularCod">Vincular</button></div>
          <datalist id="dlCod">${perto.map((p) => `<option value="${esc(p.x.codigo)}">${esc(p.x.nome_ativo || '')} · ${fmt(p.d, 0)} m</option>`).join('')}</datalist>
          ${perto.length ? `<p class="peq mut">Mais próximos do mesmo escopo: ${perto.slice(0, 4).map((p) => `${esc(p.x.codigo)} (${fmt(p.d, 0)} m)`).join(', ')}</p>` : ''}</div>`;
      }
      const atr = Object.entries(f.atributos || {}).filter(([k]) => !['fid', 'uuid'].includes(k));
      corpo = `${vinc}<dl class="kv"><dt>Código (id_ativo)</dt><dd>${esc(f.id_ativo || '—')}</dd><dt>Bloco</dt><dd>${esc(f.id_bloco || f.blocoGeo || '—')}${!f.id_bloco && f.blocoGeo ? ' <span class="mut">(pela posição)</span>' : ''}</dd>${m ? `<dt>${f.area_m2 != null ? 'Área' : 'Extensão'}</dt><dd>${m}</dd>` : ''}<dt>Escopo</dt><dd>${esc(f.escEf ? f.escEf + ' – ' + (ESC[f.escEf] ? ESC[f.escEf].curto : '') : f.contexto ? 'contexto' : 'qualquer (ponto)')}</dd><dt>Origem</dt><dd>${esc(f.fonte || '—')}</dd></dl>
        ${atr.length ? `<details><summary class="peq"><b>Atributos da base (${atr.length})</b></summary><dl class="kv">${atr.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></details>` : ''}
        ${l ? `<h3>${f.lev ? 'Levantamento vinculado' : 'Levantamento sugerido'}</h3>${blocoDiagnostico(l)}` : ''}
        ${pode.coord() ? '<p style="margin-top:18px"><button class="bt peq alerta" data-a="excluirFeicao">Excluir esta feição da base</button></p>' : ''}`;
    } else if (h.tipo === 'lev') {
      const l = h.obj; tit = l.codigo; sub = `${ESC[l.escopo] ? ESC[l.escopo].curto : l.escopo} · levantamento de campo`;
      let vinc = '';
      if (l.f) vinc = `<p>${selo('Vinculado', COR_SIT.confirmado)} à feição <b>${esc(l.f.nome || l.f.cam.nome)}</b> <button class="bt peq" data-a="selFeicao" data-id="${l.f.id}">ver feição</button></p>`;
      else if (l.sug) vinc = `<p>${selo('Sugestão', COR_SIT.sugerido)} ${esc(l.sug.f.cam.nome)} <b>${esc(l.sug.f.nome || '')}</b> <span class="peq mut">${l.sug.d === 0 ? 'GPS dentro' : fmt(l.sug.d, 1) + ' m'}</span></p>${g ? `<div class="linha"><button class="bt pri peq" data-a="confirmarLev">Confirmar vínculo</button><button class="bt peq" data-a="selFeicao" data-id="${l.sug.f.id}">ver feição</button></div>` : ''}`;
      else vinc = `<p>${selo('Sem feição na base', '#C3292E')}</p><p class="peq mut">Nenhuma feição do escopo ${esc(l.escopo)} a menos de ${S.tol[ESC[l.escopo] && ESC[l.escopo].geom === 'linha' ? 'linha' : ESC[l.escopo] && ESC[l.escopo].geom === 'area' ? 'poligono' : 'ponto']} m.</p>${pode.coord() ? `<button class="bt peq" data-a="criarDe" data-id="${l.id}">Criar feição a partir do ${l.tr ? 'traçado' : 'GPS'}</button>` : ''}`;
      if (l.blocoGeo && l.bloco && l.blocoGeo !== l.bloco) vinc += `<div class="cartao aviso peq">Bloco digitado ${esc(l.bloco)}, mas o ponto está no polígono do bloco ${esc(l.blocoGeo)}.</div>`;
      corpo = vinc + blocoDiagnostico(l);
    } else {
      const n = h.obj; tit = `${n.codigo_ativo} · ${n.item_id}`; sub = 'Não conformidade';
      const l = S.levs.find((x) => x.codigo === n.codigo_ativo);
      corpo = `<p>${selo(n.criticidade, COR_CRIT[n.criticidade] || CINZA)} ${n.gut ? `<span class="peq mut">GUT ${n.gut}</span>` : ''}</p><p><b>${esc(n.pergunta || '')}</b></p>
        <dl class="kv"><dt>Ação</dt><dd>${esc(n.o_que)}</dd><dt>Responsável</dt><dd>${esc(n.quem || '—')}</dd><dt>Prazo</dt><dd>${brData(n.quando)} · ${esc(n.situacao || '')}</dd><dt>Base legal</dt><dd>${esc(n.base_legal || '—')}</dd><dt>Local</dt><dd>${n.local_pela_foto ? 'GPS da foto de contexto' : 'ponto do ativo'}</dd></dl>
        ${l ? `<button class="bt peq" data-a="selLev" data-id="${l.id}">Abrir o ativo ${esc(l.codigo)}</button>` : ''}`;
    }
    const outros = h.outros && h.outros.length ? `<div class="chips outros"><span class="peq mut">Também aqui:</span>${h.outros.map((o, k) => `<button data-a="outro" data-k="${k}">${esc(rotuloCurto(o).split(' · ').slice(0, 2).join(' · '))}</button>`).join('')}</div>` : '';
    el.innerHTML = `<div class="cab"><div class="tt"><b>${esc(tit)}</b><span class="peq mut">${esc(sub)}</span></div><button class="fechar" data-a="fecharFicha" aria-label="Fechar">×</button></div>${outros}<div class="corpo-f">${corpo}</div>`;
  }

  /* ------------------------------------------------------------ ações de vínculo */
  async function vincular(itens, msg) {
    try {
      const n = await SB.rpc('pd_geo_vincular', { p_itens: itens });
      itens.forEach((it) => {
        const f = S.feicoes.find((x) => x.id === it.feicao); if (!f) return;
        if (it.codigo) S.feicoes.forEach((x) => { if (x !== f && x.id_ativo === it.codigo) { x.id_ativo = null; x.vinculo_origem = null; } });
        f.id_ativo = it.codigo || null; f.vinculo_origem = it.codigo ? it.origem : null; f.vinculado_em = new Date().toISOString();
      });
      S.marcadas.clear(); calcularVinculos(); pintarTudo();
      toast(msg || `${n} vínculo(s) gravado(s)`);
    } catch (e) { toast('Não foi possível gravar: ' + e.message); }
  }
  async function criarDeLevantamento(l) {
    const tipos = []; if (l.tr) tipos.push(l.tr.tipo); if (l.ll) tipos.push('ponto');
    const opcoes = S.camadas.filter((c) => tipos.includes(c.geometria) && (c.escopo === l.escopo || (!c.escopo && c.geometria === 'ponto')));
    if (!opcoes.length) { toast(ESC[l.escopo] && ESC[l.escopo].geom === 'area' ? 'Este escopo é um polígono: sem traçado de área no app, desenhe a feição no QGIS e importe' : 'Não há camada compatível com este levantamento'); return; }
    const cam = opcoes.find((c) => c.escopo === l.escopo && c.geometria === (l.tr ? l.tr.tipo : 'ponto')) || opcoes[0];
    let geojson;
    if (cam.geometria === 'ponto') geojson = { type: 'Point', coordinates: [Math.round(l.ll[0] * 1e7) / 1e7, Math.round(l.ll[1] * 1e7) / 1e7] };
    else if (cam.geometria === 'linha') geojson = { type: 'MultiLineString', coordinates: l.tr.partes };
    else geojson = { type: 'MultiPolygon', coordinates: l.tr.partes };
    if (!confirm(`Criar na camada "${cam.nome}" uma feição com ${cam.geometria === 'ponto' ? 'o ponto GPS' : 'o traçado'} de ${l.codigo}?`)) return;
    const m = medidas(normGeom(geojson));
    try {
      await SB.inserir('pd_geo_feicoes', [{ camada: cam.cod, escopo: cam.escopo ? null : l.escopo, id_ativo: l.codigo, nome: l.nome_ativo, id_bloco: l.bloco, geojson, area_m2: m.area != null ? Math.round(m.area * 10) / 10 : null,
        comprimento_m: m.comp != null ? Math.round(m.comp * 10) / 10 : null, fonte: 'app de campo', vinculo_origem: 'campo', atributos: {} }]);
      await carregar(); pintarTudo(); toast(`Feição criada e vinculada a ${l.codigo}`);
    } catch (e) { toast('Não foi possível criar: ' + e.message); }
  }

  /* ------------------------------------------------------------ exportação */
  function exportar(tipo) {
    const t = hojeTag();
    if (tipo === 'feicoes') {
      const fc = { type: 'FeatureCollection', name: 'pdslz_base_diagnostico', features: S.feicoes.filter(feicaoVisivel).map((f) => { const l = f.lev; const s = f.sug; return { type: 'Feature', geometry: f.geojson,
        properties: { id: f.id, camada: f.camada, camada_nome: f.cam.nome, escopo: f.escEf, id_ativo: f.id_ativo, nome: f.nome, id_bloco: f.id_bloco || f.blocoGeo || null, situacao: ROT_SIT[situacao(f)],
          area_m2: f.area_m2, comprimento_m: f.comprimento_m, indice: l ? l.indice : null, n_nc: l ? l.n_nc : null, n_criticas: l ? l.n_criticas : null, crit_max: l ? l.crit_max : null,
          data_levantamento: l ? l.data_levantamento : null, condicao_geral: l ? l.condicao_geral : null, sugestao_codigo: !l && s ? s.lev.codigo : null, sugestao_dist_m: !l && s ? Math.round(s.d * 10) / 10 : null } }; }) };
      baixar(JSON.stringify(fc), `PD-SLZ_base_diagnostico_${t}.geojson`, 'application/geo+json');
    } else if (tipo === 'levs') {
      const feats = [];
      S.levs.filter(levVisivel).forEach((l) => {
        const props = { codigo_ativo: l.codigo, escopo: l.escopo, bloco: l.bloco, bloco_pela_posicao: l.blocoGeo, nome: l.nome_ativo, data: l.data_levantamento, equipe: l.equipe, indice: l.indice, n_nc: l.n_nc, n_criticas: l.n_criticas, crit_max: l.crit_max,
          feicao_id: l.f ? l.f.id : null, vinculo: l.f ? 'confirmado' : l.sug ? 'sugerido' : 'sem feição', sugestao_dist_m: !l.f && l.sug ? Math.round(l.sug.d * 10) / 10 : null };
        if (l.ll) feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: l.ll }, properties: Object.assign({ geometria: 'gps' }, props) });
        if (l.tr) feats.push({ type: 'Feature', geometry: l.tr.tipo === 'linha' ? { type: 'MultiLineString', coordinates: l.tr.partes } : { type: 'MultiPolygon', coordinates: l.tr.partes }, properties: Object.assign({ geometria: 'traçado do app' }, props) });
      });
      baixar(JSON.stringify({ type: 'FeatureCollection', name: 'pdslz_levantamentos', features: feats }), `PD-SLZ_levantamentos_${t}.geojson`, 'application/geo+json');
    } else if (tipo === 'ncs') {
      baixar(JSON.stringify({ type: 'FeatureCollection', name: 'pdslz_nao_conformidades', features: S.ncs.map((n) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [n.lon, n.lat] },
        properties: { id_acao: n.id_acao, codigo_ativo: n.codigo_ativo, item: n.item_id, criticidade: n.criticidade, gut: n.gut, o_que: n.o_que, quem: n.quem, quando: n.quando, situacao: n.situacao, local_pela_foto: n.local_pela_foto } })) }), `PD-SLZ_nao_conformidades_${t}.geojson`, 'application/geo+json');
    } else if (tipo === 'vinculos') {
      const linhas = [['codigo_ativo', 'escopo', 'bloco', 'nome_levantamento', 'situacao', 'feicao_id', 'camada', 'nome_feicao', 'distancia_m', 'ambigua']];
      S.levs.forEach((l) => { const f = l.f || (l.sug && l.sug.f); linhas.push([l.codigo, l.escopo, l.bloco, l.nome_ativo, l.f ? 'confirmado' : l.sug ? 'sugerido' : 'sem feição', f ? f.id : '', f ? f.camada : '', f ? f.nome : '', !l.f && l.sug ? (Math.round(l.sug.d * 10) / 10).toString().replace('.', ',') : '', l.sug && l.sug.amb ? 'sim' : '']); });
      baixar('﻿' + linhas.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n'), `PD-SLZ_vinculos_${t}.csv`, 'text/csv');
    } else if (tipo === 'cobertura') {
      const linhas = [['agrupamento', 'item', 'feicoes', 'levantadas', 'sugeridas', 'cobertura']];
      ['camada', 'bloco'].forEach((k) => tabelaCobertura(k).forEach(([n, o]) => linhas.push([k, n, o.n, o.lev, o.sug, (o.lev / o.n).toFixed(4).replace('.', ',')])));
      baixar('﻿' + linhas.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n'), `PD-SLZ_cobertura_${t}.csv`, 'text/csv');
    }
  }

  /* ------------------------------------------------------------ eventos */
  const ACT = {
    async entrar() {
      const e = $('#lgE').value.trim(); const s = $('#lgS').value; const msg = $('#lgMsg');
      if (!e || !s) { msg.textContent = 'Informe e-mail e senha'; return; }
      msg.textContent = 'Entrando…';
      try { await SB.login(e, s); render(); await carregar(); pintarTudo(); enquadrarSeVazio(); } catch (err) { msg.textContent = err.message; }
    },
    sair() { if (!confirm('Sair do WebGIS?')) return; SB.sair(); location.reload(); },
    async recarregar() { try { FOTOS.clear(); await carregar(); pintarTudo(); toast('Dados atualizados'); } catch (e) { toast('Falha ao atualizar: ' + e.message); } },
    aba: (b) => { S.aba = b.dataset.v; pintarTudo(); },
    lado: () => { S.lado = !S.lado; $('#lado').classList.toggle('on', S.lado); },
    zoom: (b) => zoomEm(Math.round(V.z) + Number(b.dataset.v), V.W / 2, V.H / 2),
    tudo: () => enquadrarTudo(),
    bloco: (b) => { const v = b.dataset.v; if (S.blocos.has(v)) S.blocos.delete(v); else S.blocos.add(v); pintarTudo(); },
    blocoLimpar: () => { S.blocos.clear(); pintarTudo(); },
    sit: (b) => { const v = b.dataset.v; if (S.filtroSit.has(v)) S.filtroSit.delete(v); else S.filtroSit.add(v); pintarTudo(); },
    soNaoLev: () => { S.filtroSit = new Set(['sem', 'sugerido', 'contexto']); S.aba = 'mapa'; pintarTudo(); },
    selLev: (b) => { const l = S.LEV[b.dataset.id]; if (!l) return; selecionar({ tipo: 'lev', obj: l }); irPara(l.w ? l : { bb: (l.f || {}).bb }); },
    selFeicao: (b) => { const f = S.feicoes.find((x) => x.id === b.dataset.id); if (!f) return; if (!S.camVis.has(f.camada)) S.camVis.add(f.camada); selecionar({ tipo: 'feicao', obj: f }); irPara(f); },
    fecharFicha: () => selecionar(null),
    legenda: () => $('#legenda').classList.toggle('aberta'),
    async excluirFeicao() {
      const f = S.sel.obj;
      if (!confirm(`Excluir "${f.nome || f.id_ativo || f.cam.nome}" (${f.cam.nome}) da base geográfica?${f.lev ? ' O levantamento de campo não é apagado, só fica sem feição.' : ''}`)) return;
      try { await SB.apagar('pd_geo_feicoes', `id=eq.${f.id}`); S.sel = null; await carregar(); pintarTudo(); toast('Feição excluída'); } catch (e) { toast('Não foi possível excluir: ' + e.message); }
    },
    outro: (b) => { const h = S.sel; const k = +b.dataset.k; const o = h.outros[k]; selecionar(Object.assign({}, o, { outros: [Object.assign({}, h, { outros: null })].concat(h.outros.filter((x, i) => i !== k)) })); },
    confirmar: (b) => { const f = S.sel.obj; vincular([{ feicao: f.id, codigo: b.dataset.cod, origem: 'automatico' }], `${b.dataset.cod} vinculado a ${f.nome || f.cam.nome}`); },
    confirmarLev: () => { const l = S.sel.obj; vincular([{ feicao: l.sug.f.id, codigo: l.codigo, origem: 'automatico' }], `${l.codigo} vinculado`); },
    desvincular: () => { const f = S.sel.obj; if (!confirm(`Remover o código ${f.id_ativo} desta feição?`)) return; vincular([{ feicao: f.id, codigo: null }], 'Vínculo removido'); },
    vincularCod: () => {
      const f = S.sel.obj; const cod = ($('#inCod').value || '').trim().toUpperCase();
      if (!/^[A-Z]{2}-[A-Z]-\d{4}$/.test(cod)) { toast('Código no formato ED-A-0001'); return; }
      const l = S.levs.find((x) => x.codigo === cod);
      if (l && f.escEf && l.escopo !== f.escEf && !confirm(`${cod} é do escopo ${l.escopo} e a feição é ${f.escEf}. Vincular mesmo assim?`)) return;
      vincular([{ feicao: f.id, codigo: cod, origem: 'manual' }], `${cod} vinculado manualmente`);
    },
    marca: (b) => { const id = b.dataset.id; if (b.checked) S.marcadas.add(id); else S.marcadas.delete(id); $('#painel').innerHTML = painelHTML(); },
    confSem: () => { const l = S.levs.filter((x) => !x.f && x.sug && !x.sug.amb); if (!confirm(`Confirmar ${l.length} vínculo(s) sugeridos pela posição?`)) return; lotes(l.map((x) => ({ feicao: x.sug.f.id, codigo: x.codigo, origem: 'automatico' }))); },
    confMarc: () => { const l = [...S.marcadas].map((id) => S.LEV[id]).filter((x) => x && x.sug); lotes(l.map((x) => ({ feicao: x.sug.f.id, codigo: x.codigo, origem: 'automatico' }))); },
    criarDe: (b) => criarDeLevantamento(S.LEV[b.dataset.id]),
    foto: (b) => { const f = (FOTOS.get(b.dataset.id) || [])[+b.dataset.i]; if (!f || !f.url) return; const d = document.createElement('div'); d.className = 'luz'; d.innerHTML = `<div><img src="${f.url}" alt=""><p>${esc(f.nome_padrao || f.tipo)}${f.legenda ? ' · ' + esc(f.legenda) : ''}</p></div>`; d.onclick = () => d.remove(); document.body.appendChild(d); },
    escolherArq: () => { const i = $('#inArq'); i.value = ''; i.click(); },
    impInc: (b) => { S.imp.camadas[+b.dataset.k].incluir = b.checked; $('#painel').innerHTML = painelHTML(); },
    impModo: (b) => { S.imp.modo = b.dataset.v; $('#painel').innerHTML = painelHTML(); },
    impCancelar: () => { S.imp = null; $('#painel').innerHTML = painelHTML(); },
    impEnviar: () => enviarImportacao(),
  };
  async function lotes(itens) { for (let k = 0; k < itens.length; k += 200) await vincular(itens.slice(k, k + 200), `${Math.min(k + 200, itens.length)} de ${itens.length} vínculo(s) gravados`); }
  // mantém a última vista se ela mostra algum dado; senão enquadra tudo
  function enquadrarSeVazio() {
    let v = null; try { v = localStorage.getItem('pdslz_webgis_vista'); } catch (e) { /* ok */ }
    const algo = S.feicoes.some((f) => naTela(f.bb, 0)) || S.levs.some((l) => l.w && naTela([l.w[0], l.w[1], l.w[0], l.w[1]], 0));
    if (!v || !algo) enquadrarTudo();
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]'); if (!b || b.disabled) return;
    if (b.tagName === 'INPUT' && b.type === 'checkbox') return;
    const f = ACT[b.dataset.a]; if (!f) return;
    e.preventDefault(); Promise.resolve(f(b, e)).catch((err) => { console.error(err); toast('Erro: ' + err.message); });
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'inArq') {
      const arq = t.files && t.files[0]; if (!arq) return;
      S.aba = 'importar'; S.imp = null; $('#painel').innerHTML = '<p class="mut">Lendo o arquivo…</p>';
      lerArquivo(arq).then((res) => { prepararImportacao(res, arq.name); pintarTudo(); }).catch((err) => { S.imp = { arquivo: arq.name, camadas: [], resultado: { erro: true, titulo: 'Não foi possível ler o arquivo', texto: err.message } }; pintarTudo(); });
      return;
    }
    if (t.matches('input[type=checkbox][data-a]')) {
      const a = t.dataset.a;
      if (a === 'cam') { if (t.checked) S.camVis.add(t.dataset.v); else S.camVis.delete(t.dataset.v); redesenhar(); $('#kpis').innerHTML = kpisHTML(); return; }
      if (a === 'ver') { S[t.dataset.v] = t.checked; $('#legenda').innerHTML = legendaHTML(); redesenhar(); return; }
      if (ACT[a]) ACT[a](t);
      return;
    }
    if (t.id === 'selModo') { S.modo = t.value; if (S.modo === 'tema') carregarTemas().then(() => pintarTudo()); pintarTudo(); return; }
    if (t.id === 'selTema') { S.tema = t.value; pintarTudo(); return; }
    if (t.id === 'selBase') { S.base = t.value; try { localStorage.setItem('pdslz_webgis_base', S.base); } catch (er) { /* ok */ } $('#tiles').innerHTML = ''; V.tiles.clear(); redesenhar(); return; }
    if (t.id === 'selExp') { if (t.value) exportar(t.value); t.value = ''; return; }
    if (t.dataset.tol) { const v = Number(t.value); if (isFinite(v) && v >= 0) { S.tol[t.dataset.tol] = Math.min(v, 200); calcularVinculos(); pintarTudo(); } return; }
    if (t.dataset.imp) { const c = S.imp.camadas[+t.dataset.k]; c[t.dataset.imp] = t.value; if (t.dataset.imp === 'crsCod') c.crs = crsDe(t.value); $('#painel').innerHTML = painelHTML(); }
  });
  document.addEventListener('input', debounce((e) => { if (e.target.id === 'busca') { S.busca = e.target.value.trim().toLowerCase(); const pos = e.target.selectionStart; pintarTudo(); const i = $('#busca'); if (i) { i.focus(); i.setSelectionRange(pos, pos); } } }, 250));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.target.id === 'lgS' || e.target.id === 'lgE')) ACT.entrar();
    if (e.key === 'Escape') { selecionar(null); $$('.luz').forEach((x) => x.remove()); }
  });

  window.addEventListener('hashchange', () => { if (/cfg=/.test(location.hash)) location.reload(); });
  async function iniciar() {
    try { S.base = localStorage.getItem('pdslz_webgis_base') || 'sat'; } catch (e) { /* ok */ }
    SB.restaurar();
    render();
    if (SB.sessao) {
      try { await carregar(); pintarTudo(); enquadrarSeVazio(); }
      catch (e) { if (e.status === 401) { SB.sair(); render(); } else { toast('Falha ao carregar: ' + e.message); pintarTudo(); } }
    }
  }
  window.__webgis = { S, V, tela, mx, my, prepararFeicao, prepararLev, utmParaGeo, lerGPKG, lerShapefile, lerKML, lerGeoJSON, calcularVinculos, distGeom, crsDe, crsDeWkt };
  iniciar();
})();
