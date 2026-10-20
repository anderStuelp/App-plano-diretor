/* =====================================================================
   PD-SLZ Campo – app de levantamento de campo do Plano Diretor
   Funciona sem internet (IndexedDB + service worker) e sincroniza com o Supabase
   (Auth + REST + Storage) quando há conexão. Sem dependências externas.
   Versão 1.1.0
   ===================================================================== */
'use strict';
(() => {
  const VERSAO = '1.1.0';
  const CAT = window.PD_CAT;
  const PARAM = Object.assign({}, CAT.params);

  /* ------------------------------------------------------------ utilidades */
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); }));
  const pad = (n, k = 2) => String(n).padStart(k, '0');
  const hoje = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const brData = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '—');
  const brHora = (iso) => { if (!iso) return '—'; const d = new Date(iso); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const num = (v) => { if (v === null || v === undefined || v === '') return NaN; if (typeof v === 'number') return v; const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : NaN; };
  const fmt = (v, d = 2) => (isFinite(v) ? Number(v).toLocaleString('pt-BR', { maximumFractionDigits: d }) : '—');
  const pct = (v) => (v == null || !isFinite(v) ? '—' : Math.round(v * 100) + '%');
  const diasEntre = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 864e5);
  const addDias = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return hoje(d); };
  const temValor = (x) => !(x === undefined || x === null || x === '' || (Array.isArray(x) && !x.length));
  const debounce = (fn, ms) => { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.cancelar = () => clearTimeout(t); return d; };
  function toast(msg, ms = 3800) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), ms); }

  /* ------------------------------------------------------------ catálogo */
  const ESC = {}; CAT.escopos.forEach((e, i) => { e.ordem = i; ESC[e.cod] = e; });
  const ITEM = {}; const ITENS_ESC = {};
  CAT.itens.forEach((it) => { ITEM[it.id] = it; (ITENS_ESC[it.esc] = ITENS_ESC[it.esc] || []).push(it); });
  const TEMA = {}; CAT.temas.forEach((t) => { TEMA[t.cod] = t.nome; });
  const CH = {}; Object.entries(CAT.choices).forEach(([k, arr]) => { CH[k] = {}; arr.forEach(([c, l]) => { CH[k][c] = l; }); });
  const CAMPO = {}; Object.values(CAT.campos).forEach((fs) => fs.forEach((f) => { CAMPO[f.n] = f; }));
  const NUMT = new Set(['integer', 'decimal']);
  const rotulo = (lista, cod) => (CH[lista] && CH[lista][cod]) || cod || '';
  const lab = (campo, cod) => { const f = CAMPO[campo]; return f && f.list ? rotulo(f.list, cod) : cod; };

  function compila(expr) {
    if (!expr) return null;
    try { return new Function('v', 'sel', 'has', 'iff', 'rnd', 'S', 'return (' + expr + ');'); } catch (e) { console.warn('Expressão inválida', expr, e); return null; }
  }
  Object.values(CAT.campos).forEach((fs) => fs.forEach((f) => { f.relF = compila(f.rel); f.conF = compila(f.con); f.calcF = compila(f.calc); }));
  CAT.itens.forEach((it) => { it.gateF = compila(it.gate); });
  const iff = (c, a, b) => (c ? a : b);
  const rnd = (x, d) => { const p = 10 ** d; return Math.round(x * p) / p; };

  // Contexto de avaliação no padrão XLSForm: campo não relevante (oculto) vale vazio, mesmo que tenha sido preenchido antes
  function ctx(rec) {
    const at = rec.attrs || {};
    const visitando = new Set();
    const sel = (n, c) => String(v(n) || '').split(' ').includes(c);
    const has = (n) => v(n) !== '';
    function relevante(f) {
      if (!f.relF || visitando.has(f.n)) return true;
      visitando.add(f.n);
      try { return !!f.relF(v, sel, has, iff, rnd, undefined); } catch (e) { return true; } finally { visitando.delete(f.n); }
    }
    function v(n) {
      const f = CAMPO[n];
      if (f && !relevante(f)) return '';
      let x = f && f.calcF ? f.calcF(v, sel, has, iff, rnd, undefined) : at[n];
      if (x === undefined || x === null || x === '' || (typeof x === 'number' && !isFinite(x))) return '';
      if (f && (NUMT.has(f.t) || f.calcF)) { const k = num(x); return isFinite(k) ? k : ''; }
      return x;
    }
    return { v, has, sel };
  }
  function avalia(fn, rec, self) {
    if (!fn) return true;
    try { const c = ctx(rec); return fn(c.v, c.sel, c.has, iff, rnd, self); } catch (e) { return true; }
  }
  const camposDe = (rec) => CAT.campos[rec.escopo] || [];
  const visivel = (f, rec) => avalia(f.relF, rec);
  const camposVisiveis = (rec) => camposDe(rec).filter((f) => f.t !== 'calculate' && visivel(f, rec));
  function itensAplicaveis(rec) {
    return (ITENS_ESC[rec.escopo] || []).filter((it) => !(rec.escopo === 'ED' && Number(rec.nivel) === 2 && !it.n2) && avalia(it.gateF, rec));
  }

  /* ------------------------------------------------------------ criticidade, prazos e cores */
  const ORD_CRIT = { 'Crítica': 1, 'Alta': 2, 'Média': 3, 'Baixa': 4, 'Melhoria': 5, 'A classificar': 6 };
  function criticidade(r, g, u, t) {
    if (r === 'OM') return 'Melhoria';
    g = +g; u = +u; t = +t;
    if (!(g && u && t)) return 'A classificar';
    const p = g * u * t;
    return g === 5 || p >= 80 ? 'Crítica' : p >= 40 ? 'Alta' : p >= 15 ? 'Média' : 'Baixa';
  }
  const PRAZO = (c) => ({ 'Crítica': PARAM.prazo_critica, 'Alta': PARAM.prazo_alta, 'Média': PARAM.prazo_media, 'Baixa': PARAM.prazo_baixa, 'Melhoria': PARAM.prazo_melhoria }[c] ?? PARAM.prazo_a_classificar);
  const GUT_SUG = { 'Crítica': [5, 4, 3], 'Alta': [4, 4, 3], 'Média': [3, 3, 2], 'Baixa': [2, 2, 2] };
  function corIdx(v) { // cor de TEXTO legível nos temas claro e escuro
    v = v == null ? NaN : Number(v);
    if (!isFinite(v)) return 'var(--ink-3)';
    return v >= PARAM.indice_bom ? 'var(--c)' : v >= PARAM.indice_atencao ? 'var(--nv)' : v >= PARAM.indice_ruim ? 'var(--alta)' : 'var(--nc)';
  }
  const COR_HEX = (v) => (v == null || !isFinite(v) ? '#8C9A95' : v >= PARAM.indice_bom ? '#1E7B47' : v >= PARAM.indice_atencao ? '#D9A400' : v >= PARAM.indice_ruim ? '#E0601C' : '#B71C1C');

  /* ------------------------------------------------------------ diagnóstico automático pelas normas */
  const R = { C: (t) => ({ r: 'C', txt: t }), NC: (t) => ({ r: 'NC', txt: t }), OM: (t) => ({ r: 'OM', txt: t }), dica: (t) => ({ r: null, txt: t }) };
  const mm = (x) => fmt(x, 2) + ' m';
  const maiusc = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function regras(rec) {
    const { v, has } = ctx(rec);
    const out = {};
    const set = (id, x) => { if (x) out[id] = x; };
    const tl = rec.telhados || [];
    const td = hoje();
    switch (rec.escopo) {
      case 'ED': {
        const om = num(v('ed_ocup_m')); const of = num(v('ed_ocup_f'));
        const ocup = (isFinite(om) ? om : 0) + (isFinite(of) ? of : 0);
        if (v('ed_tem_san') === 'S' && (isFinite(om) || isFinite(of))) {
          const k = PARAM.nr24_trab_por_conjunto;
          const nm = Math.ceil((om || 0) / k); const nf = Math.ceil((of || 0) / k);
          const bm = num(v('ed_bacias_m')) || 0; const bf = num(v('ed_bacias_f')) || 0; const lv = num(v('ed_lavatorios'));
          const f = [];
          if (bm < nm) f.push(`masculino com ${bm} bacia(s) para ${om || 0} pessoas (mínimo ${nm})`);
          if (bf < nf) f.push(`feminino com ${bf} bacia(s) para ${of || 0} pessoas (mínimo ${nf})`);
          if (isFinite(lv) && lv < nm + nf) f.push(`${lv} lavatório(s) (mínimo ${nm + nf})`);
          set('ED-18', f.length ? R.NC(`NR-24 (1 conjunto para cada ${k} pessoas, por sexo) não atendida: ${f.join('; ')}`)
            : R.C(`NR-24 atendida: ${bm} bacia(s) masc. para ${om || 0} e ${bf} fem. para ${of || 0} pessoas`));
        }
        if (v('ed_tem_vest') === 'S' && has('ed_armarios') && ocup > 0 && num(v('ed_armarios')) < ocup) {
          set('ED-20', R.NC(`Armários individuais (${v('ed_armarios')}) em número menor que os ocupantes (${ocup}) – NR-24`));
        }
        const cap = num(v('ed_capacidade'));
        if (cap > 0 && ocup > 0) {
          const tx = ocup / cap;
          set('ED-14', tx > 1 ? R.NC(`Superlotação: ${ocup} pessoas para ${cap} lugares (${Math.round(tx * 100)}%)`)
            : tx < 0.4 ? R.OM(`Ociosidade: ${Math.round(tx * 100)}% da capacidade ocupada`) : R.C(`Ocupação de ${Math.round(tx * 100)}% da capacidade`));
        }
        if (v('ed_tem_san') === 'S' && v('ed_san_pcd') === 'N') set('ED-27', R.NC('Não há sanitário acessível (NBR 9050)'));
        const cb = v('ed_cbmma'); const cbv = v('ed_cbmma_val');
        if (cb === 'VIG') set('ED-33', cbv && cbv < td ? R.NC(`Certificado do CBMMA vencido em ${brData(cbv)}`) : R.C('Certificado do CBMMA vigente' + (cbv ? ` até ${brData(cbv)}` : '')));
        else if (cb === 'VEN') set('ED-33', R.NC('Certificado do CBMMA vencido' + (cbv ? ` em ${brData(cbv)}` : '')));
        else if (cb === 'INE') set('ED-33', R.NC('Edificação sem certificado do CBMMA (AVCB/CLCB)'));
        if (v('ed_tem_spda') === 'S') {
          const l = v('ed_laudo_spda');
          if (l === 'VIG') set('ED-46', R.C('Laudo de inspeção do SPDA vigente'));
          else if (l === 'VEN') set('ED-46', R.NC('Laudo de SPDA vencido (NBR 5419)'));
          else if (l === 'INE') set('ED-46', R.NC('SPDA sem laudo de inspeção (NBR 5419)'));
        }
        if (num(v('ed_pavimentos')) > 1 && v('ed_elevador') === 'N') set('ED-29', R.dica('Sem elevador ou plataforma: confirme se há rampa acessível aos pavimentos superiores'));
        if (tl.length) {
          const ruins = tl.filter((t) => num(t.condicao) > 0 && num(t.condicao) <= 2);
          if (ruins.length) set('ED-07', R.NC(`Cobertura em condição ${ruins.map((t) => t.condicao).join('/')} (${ruins.map((t) => rotulo('tipo_telha', t.tipo) || 'tipo não informado').join(', ')})`));
          if (tl.some((t) => t.infiltr === 'S')) set('ED-09', R.NC('Infiltração registrada na cobertura'));
          else if (tl.every((t) => t.infiltr === 'N')) set('ED-09', R.C('Sem infiltração observada nas coberturas'));
          if (tl.some((t) => t.acesso === 'N')) set('ED-10', R.NC('Cobertura sem acesso seguro para manutenção (NR-35)'));
          else if (tl.every((t) => t.acesso === 'S')) set('ED-10', R.C('Acesso seguro à cobertura informado'));
          if (tl.some((t) => t.tipo === 'FIB' && (t.amianto === 'S' || t.amianto === 'NI'))) set('ED-11', R.dica('Fibrocimento com suspeita de amianto: verifique se há plano de gestão/substituição (Lei 9.055/1995, NR-15 Anexo 12)'));
        }
        break;
      }
      case 'FP': {
        const tipo = v('fp_tipo');
        if (has('fp_largura') && tipo !== 'INF' && tipo !== 'PAS') {
          const x = num(v('fp_largura'));
          set('FP-02', x >= 3 ? R.C(`Largura da faixa ${mm(x)} (≥ 3,00 m)`) : R.NC(`Largura da faixa ${mm(x)}, abaixo de 3,00 m (MBST Vol. IV)`));
        }
        if (tipo !== 'PAS') {
          const rb = v('fp_rebaix');
          if (rb === 'N') set('FP-04', R.NC('Calçada sem rebaixamento (NBR 9050)'));
          else if (rb === 'P') set('FP-04', R.NC('Rebaixamento em só um lado ou incompleto (NBR 9050)'));
          else if (rb === 'S') set('FP-04', R.dica('Confirme inclinação ≤ 8,33%, largura ≥ 1,50 m e ausência de degrau'));
        }
        const tt = v('fp_tatil');
        if (tt === 'N') set('FP-05', R.NC('Sem piso tátil nos rebaixamentos (NBR 16537:2024)'));
        else if (tt === 'P') set('FP-05', R.NC('Piso tátil incompleto (NBR 16537:2024)'));
        if (v('fp_ilum') === 'N') set('FP-07', R.NC('Travessia sem iluminação específica (NBR 5101)'));
        else if (v('fp_ilum') === 'S') set('FP-07', R.C('Travessia com iluminação específica'));
        if (v('fp_conecta') === 'N') set('FP-09', R.NC('Travessia não conecta com caminho seguro nos dois lados'));
        else if (v('fp_conecta') === 'S') set('FP-09', R.C('Conectada a caminho seguro nos dois lados'));
        if (tipo === 'ELV' && num(v('fp_vel')) > 30) set('FP-08', R.NC(`Faixa elevada em via de ${v('fp_vel')} km/h, acima de 30 km/h (Res. CONTRAN 738/2018)`));
        break;
      }
      case 'CS': {
        if (has('cs_faixa_livre')) { const x = num(v('cs_faixa_livre')); set('CS-01', x >= 1.2 ? R.C(`Faixa livre ${mm(x)} (≥ 1,20 m)`) : R.NC(`Faixa livre ${mm(x)}, abaixo de 1,20 m (NBR 9050)`)); }
        if (has('cs_incl_transv')) { const x = num(v('cs_incl_transv')); set('CS-02', x <= 3 ? R.C(`Inclinação transversal ${fmt(x, 1)}% (≤ 3%)`) : R.NC(`Inclinação transversal ${fmt(x, 1)}%, acima de 3% (NBR 9050)`)); }
        if (has('cs_incl_long')) {
          const x = num(v('cs_incl_long'));
          set('CS-03', x <= 5 ? R.C(`Inclinação longitudinal ${fmt(x, 1)}% (≤ 5%)`) : x <= 8.33 ? R.dica(`Inclinação de ${fmt(x, 1)}%: o trecho deve ser tratado como rampa, com patamares e corrimãos (NBR 9050)`)
            : R.NC(`Inclinação longitudinal ${fmt(x, 1)}%, acima de 8,33% (NBR 9050)`));
        }
        if (v('cs_segreg') === 'NEN') set('CS-08', R.dica('Sem segregação: é não conforme se houver tráfego de veículos pesados ou equipamentos'));
        const il = v('cs_iluminado');
        if (il === 'N') set('CS-11', R.NC('Trecho sem iluminação (NBR 5101)'));
        else if (il === 'P') set('CS-11', R.NC('Iluminação só em parte do trecho (NBR 5101)'));
        else if (il === 'S') set('CS-11', R.C('Trecho iluminado'));
        if (v('cs_tatil') === 'N') set('CS-06', R.dica('Sem piso tátil: é não conforme onde houver obstáculos, rampas ou mudança de direção (NBR 16537:2024)'));
        break;
      }
      case 'ES': {
        const vg = num(v('es_vagas'));
        if (vg > 0) {
          const npcd = Math.max(1, Math.ceil(0.02 * vg)); const nid = Math.ceil(0.05 * vg);
          if (has('es_pcd')) { const x = num(v('es_pcd')); set('ES-01', x >= npcd ? R.C(`${x} vaga(s) PcD para ${vg} (mínimo ${npcd}: 2%, Lei 13.146/2015)`) : R.NC(`${x} vaga(s) PcD para ${vg} vagas; mínimo ${npcd} (2%, Lei 13.146/2015)`)); }
          if (has('es_idoso')) { const x = num(v('es_idoso')); set('ES-02', x >= nid ? R.C(`${x} vaga(s) para idosos (mínimo ${nid}: 5%, Lei 10.741/2003)`) : R.NC(`${x} vaga(s) para idosos; mínimo ${nid} (5%, Lei 10.741/2003)`)); }
          if (has('es_ocup')) { const tx = num(v('es_ocup')) / vg; set('ES-06', tx > 0.9 ? R.NC(`Ocupação no pico de ${Math.round(tx * 100)}%, acima de 90%`) : R.C(`Ocupação no pico de ${Math.round(tx * 100)}%`)); }
        }
        break;
      }
      case 'PB': {
        if (v('pb_abrigo') === 'N') set('PB-01', R.NC('Parada sem abrigo'));
        if (v('pb_baia') === 'N') set('PB-05', R.NC('Embarque na pista, sem baia'));
        else if (v('pb_baia') === 'S') set('PB-05', R.dica('Baia presente: confirme operação sem ré e pedestres segregados'));
        if (v('pb_ilum') === 'N') set('PB-07', R.NC('Parada sem iluminação (NBR 5101)'));
        else if (v('pb_ilum') === 'S') set('PB-07', R.C('Parada iluminada'));
        break;
      }
      case 'DR': {
        const sub = v('dr_sub'); const tp = v('dr_tampa');
        if (['BLB', 'GRE', 'CXP', 'PV', 'CAN'].includes(sub)) {
          if (tp === 'N') set('DR-02', R.NC('Abertura sem tampa/grelha fixa: risco de queda de pessoas e veículos'));
          else if (tp === 'S') set('DR-02', R.C('Tampa/grelha presente e fixa'));
        }
        if (sub && sub !== 'ALA') {
          const ob = String(v('dr_obstr')); const as = v('dr_assoreado');
          if (ob === '50' || ob === '75' || as === 'S') set('DR-03', R.NC(ob === '75' ? 'Obstrução acima de 50%' : ob === '50' ? 'Obstrução de 25% a 50%' : 'Dispositivo assoreado'));
          else if (ob === '25') set('DR-03', R.OM('Obstrução de até 25%: incluir na limpeza programada'));
          else if (ob === '0') set('DR-03', R.C('Dispositivo desobstruído'));
        }
        if (v('dr_cruzada') === 'S') set('DR-05', R.NC('Indício de esgoto ou óleo na drenagem pluvial (ligação cruzada)'));
        else if (v('dr_cruzada') === 'N') set('DR-05', R.C('Sem indício de ligação cruzada'));
        break;
      }
      case 'IL': {
        const fu = v('il_func');
        if (fu === 'S') set('IL-01', R.C('Luminária acesa'));
        else if (fu === 'N') set('IL-01', R.NC('Luminária apagada'));
        else if (fu === 'P') set('IL-01', R.NC('Luminária intermitente'));
        const tc = v('il_tec');
        if (tc === 'LED') set('IL-07', has('il_pot') && has('il_circuito') ? R.C('LED com cadastro completo') : R.dica('LED: complete potência e circuito para conformidade do cadastro'));
        else if (tc) set('IL-07', R.OM(`Tecnologia ${lab('il_tec', tc)}: avaliar troca por LED`));
        break;
      }
      case 'EA': {
        const sub = v('ea_sub');
        if (sub === 'POC') {
          if (v('ea_outorga') === 'S') set('EA-01', R.C('Outorga de captação vigente'));
          else if (v('ea_outorga') === 'N') set('EA-01', R.NC('Poço sem outorga de captação vigente (Lei 9.433/1997)'));
        }
        const ld = v('ea_laudo');
        if (ld === 'VIG') set('EA-03', R.C('Laudo de potabilidade vigente'));
        else if (ld === 'VEN') set('EA-03', R.NC('Laudo de potabilidade vencido (Portaria GM/MS 888/2021)'));
        else if (ld === 'INE') set('EA-03', R.NC('Sem laudo de potabilidade (Portaria GM/MS 888/2021)'));
        if (has('ea_cloro')) {
          const x = num(v('ea_cloro'));
          set('EA-04', x < PARAM.cloro_min_mgl ? R.NC(`Cloro residual livre de ${fmt(x, 2)} mg/L, abaixo de ${fmt(PARAM.cloro_min_mgl, 1)} mg/L (Portaria GM/MS 888/2021)`)
            : x > PARAM.cloro_max_mgl ? R.NC(`Cloro residual livre de ${fmt(x, 2)} mg/L, acima de ${fmt(PARAM.cloro_max_mgl, 0)} mg/L (Portaria GM/MS 888/2021)`)
              : R.C(`Cloro residual livre de ${fmt(x, 2)} mg/L`));
        }
        if ((sub === 'RES' || sub === 'REA') && has('ea_limpeza')) {
          const d = diasEntre(v('ea_limpeza'), td);
          set('EA-06', d > PARAM.reservatorio_dias_limpeza ? R.NC(`Última limpeza há ${d} dias (referência: ${PARAM.reservatorio_dias_limpeza} dias)`) : R.C(`Limpeza há ${d} dias`));
        }
        break;
      }
      case 'ET': {
        const lic = v('et_licenca'); const out = v('et_outorga');
        if (lic === 'N' || out === 'N') set('ET-01', R.NC(maiusc([lic === 'N' ? 'sem licença de operação vigente' : '', out === 'N' ? 'sem outorga de lançamento vigente' : ''].filter(Boolean).join(' e '))));
        else if (lic === 'S' && out === 'S') set('ET-01', R.C('Licença de operação e outorga vigentes'));
        const mo = v('et_monit');
        if (mo === 'N') set('ET-02', R.NC('Sem monitoramento do efluente com laudos em dia (CONAMA 430/2011)'));
        else if (mo === 'S') set('ET-02', R.C('Monitoramento do efluente com laudos em dia'));
        const uc = v('et_uso_cap');
        if (uc !== '') set('ET-03', uc / 100 > PARAM.ete_uso_max ? R.NC(`Uso da capacidade de ${fmt(uc, 0)}%, acima de ${Math.round(PARAM.ete_uso_max * 100)}%`) : R.C(`Uso da capacidade de ${fmt(uc, 0)}%`));
        break;
      }
      case 'EP':
        if (has('ep_retirada')) set('EP-03', v('ep_retirada') < td ? R.NC(`Retirada prevista para ${brData(v('ep_retirada'))} já passou`) : R.C(`Retirada prevista para ${brData(v('ep_retirada'))}`));
        break;
      case 'CA':
        if (has('ca_vigencia')) set('CA-02', v('ca_vigencia') < td ? R.NC(`Contrato/comodato vencido em ${brData(v('ca_vigencia'))}`) : R.C(`Contrato/comodato vigente até ${brData(v('ca_vigencia'))}`));
        if (v('ca_sit') === 'ORF') set('CA-12', R.NC('Canteiro órfão/abandonado, sem termo de devolução'));
        break;
      case 'DI': {
        const co = v('di_coberto'); const im = v('di_impermeavel');
        if (co === 'N' || im === 'N') set('DI-01', R.NC(maiusc([co === 'N' ? 'sem cobertura' : '', im === 'N' ? 'piso não impermeável' : ''].filter(Boolean).join(' e ')) + ' (NBR 11174/NBR 12235)'));
        else if (co === 'S' && im === 'S') set('DI-01', R.C('Coberto e com piso impermeável'));
        break;
      }
      case 'HI':
        if (has('hi_ult_teste')) { const d = diasEntre(v('hi_ult_teste'), td); set('HI-04', d > PARAM.hidrante_dias_teste ? R.NC(`Último teste há ${d} dias (referência: ${PARAM.hidrante_dias_teste} dias)`) : R.C(`Teste realizado há ${d} dias`)); }
        break;
      case 'UT': {
        const cg = v('ut_carreg');
        if (cg !== '') set('UT-05', cg > 80 ? R.NC(`Carregamento de ${fmt(cg, 0)}%, acima de 80%`) : R.C(`Carregamento de ${fmt(cg, 0)}%`));
        break;
      }
      case 'PO':
        if (has('po_fila')) { const x = num(v('po_fila')); set('PO-02', x > PARAM.portaria_fila_meta_min ? R.NC(`Fila de ${fmt(x, 1)} min no pico (meta: ${PARAM.portaria_fila_meta_min} min)`) : R.C(`Fila de ${fmt(x, 1)} min no pico`)); }
        break;
      case 'SV':
        if (v('sv_pelicula') === 'NRF') set('SV-02', R.NC('Película não retrorrefletiva: placa sem visibilidade à noite (MBST)'));
        if (has('sv_altura') && num(v('sv_altura')) < 2) set('SV-03', R.dica(`Altura livre de ${mm(v('sv_altura'))}: é não conforme se a placa estiver sobre calçada (mínimo 2,00 m)`));
        break;
      case 'AV': {
        const rk = v('av_risco');
        if (v('av_sub') === 'ARV' && rk) set('AV-02', rk === 'ALT' || rk === 'EXT' ? R.NC(`Árvore com risco ${lab('av_risco', rk).toLowerCase()} (NBR 16246-3)`) : rk === 'MOD' ? R.OM('Árvore com risco moderado: monitorar e programar manejo') : R.C('Árvore com risco baixo'));
        break;
      }
      default: break;
    }
    return out;
  }

  const ncsAtivas = (rec) => Object.entries(rec.ncs || {}).filter(([id]) => rec.resp[id] && (rec.resp[id].r === 'NC' || rec.resp[id].r === 'OM'));

  function aplicarAuto(rec) {
    const aplic = new Set(itensAplicaveis(rec).map((i) => i.id));
    for (const id of Object.keys(rec.resp)) if (!aplic.has(id)) delete rec.resp[id];
    const rg = regras(rec);
    rec.autoInfo = {};
    for (const id of aplic) {
      const x = rg[id]; const cur = rec.resp[id];
      if (x) rec.autoInfo[id] = x;
      if (x && x.r) { if (!cur || cur.origem === 'auto') rec.resp[id] = { r: x.r, origem: 'auto' }; }
      else if (cur && cur.origem === 'auto') delete rec.resp[id];
    }
    for (const [id, x] of Object.entries(rec.resp)) {
      if (x.r !== 'NC' && x.r !== 'OM') continue;
      if (!rec.ncIds[id]) rec.ncIds[id] = uuid();
      if (!rec.ncs[id]) {
        const s = GUT_SUG[ITEM[id].sev] || [3, 3, 2]; const ai = rec.autoInfo[id];
        rec.ncs[id] = { g: s[0], u: s[1], t: s[2], gutSug: true, desc: ai && ai.r ? ai.txt : '', qtd: '', cont: '', contDesc: '', acaoCampo: '' };
      }
    }
  }

  function alertas(rec, tem, ncs) {
    const { v } = ctx(rec); const A = []; const add = (c, t) => A.push({ c, t });
    const om = num(v('ed_ocup_m')) || 0; const of = num(v('ed_ocup_f')) || 0; const k = PARAM.nr24_trab_por_conjunto; const td = hoje();
    switch (rec.escopo) {
      case 'ED': {
        if (om + of >= PARAM.ocupacao_alta && tem.ACE && tem.ACE.cf + tem.ACE.nc > 0 && tem.ACE.cf / (tem.ACE.cf + tem.ACE.nc) < 0.7) add('R01', 'Edificação de alta ocupação com acessibilidade abaixo de 70%');
        if (v('ed_tem_san') === 'S' && (Math.ceil(om / k) > (num(v('ed_bacias_m')) || 0) || Math.ceil(of / k) > (num(v('ed_bacias_f')) || 0))) add('R02', 'Déficit de sanitários (NR-24)');
        if ((rec.telhados || []).some((t) => t.amianto === 'S')) add('R03', 'Cobertura com suspeita de amianto');
        const cb = v('ed_cbmma'); if (cb && (cb !== 'VIG' || (v('ed_cbmma_val') && v('ed_cbmma_val') < td))) add('R04', 'Sem certificado do CBMMA vigente');
        break;
      }
      case 'FP': if (v('fp_ilum') === 'N' || v('fp_rebaix') === 'N') add('R05', 'Travessia sem iluminação ou sem rebaixamento'); break;
      case 'PB': if (v('pb_abrigo') === 'N' || v('pb_baia') === 'N') add('R06', 'Parada sem abrigo ou sem baia'); break;
      case 'DR': if (v('dr_tampa') === 'N') add('R07', 'Drenagem sem tampa/grelha (risco de queda)'); if (String(v('dr_obstr')) === '75') add('R08', 'Drenagem com obstrução acima de 50%'); break;
      case 'ES': { const vg = num(v('es_vagas')); if (vg > 0 && ((num(v('es_pcd')) || 0) < Math.max(1, Math.ceil(0.02 * vg)) || (num(v('es_idoso')) || 0) < Math.ceil(0.05 * vg))) add('R09', 'Vagas PcD abaixo de 2% ou de idosos abaixo de 5%'); if (vg > 0 && num(v('es_ocup')) / vg > 0.9) add('R10', 'Ocupação no pico acima de 90%'); break; }
      case 'EP': if (v('ep_retirada') && v('ep_retirada') < td) add('R11', 'Estrutura provisória com retirada vencida'); break;
      case 'CA': if (v('ca_sit') === 'ORF' || (v('ca_vigencia') && v('ca_vigencia') < td)) add('R12', 'Canteiro órfão ou com contrato vencido'); break;
      case 'ET': { const uc = v('et_uso_cap'); if (v('et_licenca') === 'N' || (uc !== '' && uc / 100 > PARAM.ete_uso_max)) add('R13', 'ETE acima de 80% da capacidade ou sem licença'); break; }
      case 'EA': if (v('ea_outorga') === 'N' || (['RES', 'REA'].includes(v('ea_sub')) && v('ea_limpeza') && diasEntre(v('ea_limpeza'), td) > PARAM.reservatorio_dias_limpeza)) add('R14', 'Reservatório sem limpeza no prazo ou poço sem outorga'); break;
      case 'DI': if (v('di_coberto') === 'N' || v('di_impermeavel') === 'N') add('R15', 'DIR sem cobertura ou sem piso impermeável'); break;
      case 'IL': if (['N', 'P'].includes(v('il_func'))) add('R16', 'Poste apagado ou intermitente'); break;
      case 'PO': if (num(v('po_fila')) > PARAM.portaria_fila_meta_min) add('R17', 'Fila na portaria acima da meta'); break;
      default: break;
    }
    if (ncs.some((x) => x.crit === 'Crítica')) add('R18', 'Não conformidade crítica: contenção imediata e comunicação ao dono da área no mesmo dia');
    return A;
  }

  function diagnostico(rec) {
    const its = itensAplicaveis(rec); const n = { C: 0, NC: 0, OM: 0, NA: 0, NV: 0 }; const faltam = []; const tem = {};
    for (const it of its) {
      const x = rec.resp[it.id];
      if (!x) { faltam.push(it); continue; }
      n[x.r]++;
      for (const t of it.temas) { const o = tem[t] || (tem[t] = { cf: 0, nc: 0 }); if (x.r === 'C' || x.r === 'OM') o.cf++; else if (x.r === 'NC') o.nc++; }
    }
    const den = n.C + n.OM + n.NC; const indice = den ? (n.C + n.OM) / den : null;
    const ncs = ncsAtivas(rec).map(([id, x]) => {
      const r = rec.resp[id].r; const crit = criticidade(r, x.g, x.u, x.t); const prazo = PRAZO(crit);
      return { id, it: ITEM[id], r, ...x, crit, prazo, lim: addDias(rec.data || hoje(), prazo) };
    }).sort((a, b) => ORD_CRIT[a.crit] - ORD_CRIT[b.crit] || a.id.localeCompare(b.id));
    const critMax = ncs.filter((x) => x.r === 'NC').map((x) => x.crit).sort((a, b) => ORD_CRIT[a] - ORD_CRIT[b])[0] || (ncs.length ? 'Melhoria' : null);
    return { its, n, faltam, tem, indice, ncs, critMax, alertas: alertas(rec, tem, ncs) };
  }

  function pendencias(rec, d, fotos) {
    const B = []; const W = []; const p = (arr, txt, passo) => arr.push({ txt, passo });
    if (!rec.escopo) p(B, 'Escolha o escopo do ativo', 'id');
    if (!/^[A-Z]{2}-[A-Z]-\d{4}$/.test(rec.codigo || '')) p(B, 'Código do ativo no formato ED-A-0001', 'id');
    else if (rec.escopo && rec.codigo.slice(0, 2) !== rec.escopo) p(B, `O código deve começar por ${rec.escopo}`, 'id');
    if (!/^B\d{2}$/.test(rec.bloco || '')) p(B, 'Bloco no formato B01', 'id');
    if (!rec.nome) p(B, 'Nome ou uso do ativo', 'id');
    if (!rec.gps) p(B, 'Fixe o ponto GPS', 'loc');
    else if (rec.gps.acc > 15) p(W, `Precisão do GPS de ${fmt(rec.gps.acc, 0)} m (meta: ${PARAM.gps_meta_m} m)`, 'loc');
    if (!fotos.some((f) => f.tipo === 'F')) p(B, 'Tire a foto principal', 'loc');
    if (!rec.condicao) p(B, 'Informe a condição geral (1 a 5)', 'loc');
    if (rec.escopo) {
      for (const f of camposVisiveis(rec)) {
        if (f.t === 'note') continue;
        const val = rec.attrs[f.n];
        if (f.req && !temValor(val)) p(B, `Cadastro: ${f.l}`, 'cad');
        else if (temValor(val) && f.conF && !avalia(f.conF, rec, NUMT.has(f.t) ? num(val) : val)) p(B, `Cadastro: ${f.l} – ${f.conMsg || 'valor fora do intervalo esperado'}`, 'cad');
      }
      if (rec.escopo === 'ED') {
        if (!(rec.telhados || []).length) p(W, 'Nenhuma cobertura registrada', 'tel');
        (rec.telhados || []).forEach((t, i) => { if (!t.tipo || !temValor(t.area_proj)) p(W, `Cobertura ${i + 1}: informe tipo de telha e área`, 'tel'); });
      }
      if (ESC[rec.escopo].geom !== 'ponto' && !(rec.tracado && rec.tracado.pts && rec.tracado.pts.length >= 2)) p(W, 'Traçado não registrado (pode ser desenhado depois no QGIS pelo código)', 'geo');
      if (d.faltam.length) p(B, `${d.faltam.length} item(ns) do checklist sem resposta`, 'ck');
      if (d.n.NV && !rec.nvMotivo) p(B, 'Explique por que há itens não verificados (NV)', 'fim');
      for (const x of d.ncs) {
        if (!x.desc) p(B, `${x.id}: descreva a ${x.r === 'NC' ? 'não conformidade' : 'melhoria'}`, 'nc');
        if (x.r === 'NC' && !(x.g && x.u && x.t)) p(B, `${x.id}: informe G, U e T`, 'nc');
        if (x.r === 'NC' && !fotos.some((f) => f.tipo === 'N1' && f.itemId === x.id)) p(B, `${x.id}: foto 1 (contexto) da não conformidade`, 'nc');
        if (x.crit === 'Crítica' && !x.cont) p(B, `${x.id}: informe se houve contenção imediata`, 'nc');
        if (x.gutSug && x.r === 'NC') p(W, `${x.id}: G, U e T ainda são os sugeridos – confirme`, 'nc');
      }
    }
    if (rec.statusInspecao === 'PAR' && !rec.motivoParcial) p(B, 'Informe o motivo da inspeção parcial', 'fim');
    return { B, W };
  }

  /* ------------------------------------------------------------ banco local (IndexedDB) */
  let DB;
  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  function abrirDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('pdslz-campo', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('registros')) d.createObjectStore('registros', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('fotos')) d.createObjectStore('fotos', { keyPath: 'id' }).createIndex('reg', 'regId');
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'k' });
        if (!d.objectStoreNames.contains('servidor')) d.createObjectStore('servidor', { keyPath: 'id' });
      };
      r.onsuccess = () => { DB = r.result; res(DB); };
      r.onerror = () => rej(r.error);
    });
  }
  const dbGet = (s, k) => reqP(DB.transaction(s).objectStore(s).get(k));
  const dbAll = (s) => reqP(DB.transaction(s).objectStore(s).getAll());
  const dbIdx = (s, i, k) => reqP(DB.transaction(s).objectStore(s).index(i).getAll(k));
  function dbPut(s, v) { return new Promise((res, rej) => { const t = DB.transaction(s, 'readwrite'); t.objectStore(s).put(v); t.oncomplete = () => res(v); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); }
  function dbDel(s, k) { return new Promise((res, rej) => { const t = DB.transaction(s, 'readwrite'); t.objectStore(s).delete(k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }
  function dbClear(s) { return new Promise((res, rej) => { const t = DB.transaction(s, 'readwrite'); t.objectStore(s).clear(); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }
  async function metaGet(k, def) { const r = await dbGet('meta', k); return r ? r.v : def; }
  const metaSet = (k, v) => dbPut('meta', { k, v });

  /* ------------------------------------------------------------ Supabase (Auth + REST + Storage, sem biblioteca) */
  class ErroSB extends Error {
    constructor(status, corpo) {
      const j = corpo || {};
      let m = j.message || j.msg || j.error_description || j.error || `Erro ${status}`;
      if (j.code === '23505') m = 'Código do ativo já usado por outro levantamento no servidor – altere o código';
      else if (j.code === '23503') m = 'Item ou escopo não existe no banco: rode o script 02_catalogo.sql';
      else if (j.code === '42501' || status === 403 || /row-level security/.test(m)) m = 'Sem permissão para gravar: peça ao coordenador para liberar seu usuário como inspetor';
      else if (j.code === '42P01' || j.code === 'PGRST205') m = 'Tabela não encontrada no Supabase: rode os scripts SQL do kit';
      else if (status === 401) m = 'Sessão expirada: entre novamente';
      super(m); this.status = status; this.corpo = j;
    }
  }
  class ErroRede extends Error { constructor() { super('Sem conexão com o servidor'); this.rede = true; } }
  const buscar = (u, o) => fetch(u, o).catch(() => { throw new ErroRede(); });
  const ehRede = (e) => !!(e && e.rede);
  const SB = {
    sessao: null,
    get url() { return (st.cfg.supabaseUrl || '').trim().replace(/\/+$/, ''); },
    get key() { return (st.cfg.supabaseKey || '').trim(); },
    get bucket() { return st.cfg.bucket || 'pd-fotos'; },
    configurado() { return /^https?:\/\//.test(this.url) && this.key.length > 20; },
    async auth(caminho, corpo) {
      const r = await buscar(`${this.url}/auth/v1/${caminho}`, { method: 'POST', headers: { apikey: this.key, 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = (j.error_description || j.msg || j.message || '').toLowerCase();
        throw new ErroSB(r.status, { message: /invalid login|invalid_grant|credentials/.test(msg) ? 'E-mail ou senha incorretos' : (j.error_description || j.msg || j.message || `Erro ${r.status}`) });
      }
      return j;
    },
    async login(email, senha) { const j = await this.auth('token?grant_type=password', { email, password: senha }); await this.guardar(j); return j; },
    async guardar(j) {
      this.expirada = false;
      this.sessao = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600),
        user: { id: (j.user && j.user.id) || (this.sessao && this.sessao.user.id), email: (j.user && j.user.email) || (this.sessao && this.sessao.user.email) } };
      await metaSet('sessao', this.sessao);
    },
    async renovar() {
      if (!this.sessao) throw new ErroSB(401, {});
      try { const j = await this.auth('token?grant_type=refresh_token', { refresh_token: this.sessao.refresh_token }); await this.guardar(j); }
      catch (e) { if (e.status && e.status < 500) { this.expirada = true; } throw e; }
      this.expirada = false;
    },
    async token() { if (!this.sessao) throw new ErroSB(401, {}); if (this.sessao.expires_at - Date.now() / 1000 < 120) await this.renovar(); return this.sessao.access_token; },
    async req(caminho, o = {}) {
      const tentar = async () => {
        const h = Object.assign({ apikey: this.key, Authorization: 'Bearer ' + (await this.token()) }, o.headers || {});
        let body = o.body;
        if (body !== undefined && !(body instanceof Blob)) { h['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
        if (o.prefer) h.Prefer = o.prefer;
        return buscar(this.url + caminho, { method: o.method || 'GET', headers: h, body });
      };
      let r = await tentar();
      if (r.status === 401) { await this.renovar(); r = await tentar(); }
      if (!r.ok) { let j = null; try { j = await r.json(); } catch (e) { /* sem corpo */ } throw new ErroSB(r.status, j); }
      const txt = await r.text();
      return txt ? JSON.parse(txt) : null;
    },
    select(tab, q = 'select=*') { return this.req(`/rest/v1/${tab}?${q}`); },
    async selectTudo(tab, q = 'select=*') {
      const out = []; for (let off = 0; ; off += 1000) { const lote = await this.select(tab, `${q}&limit=1000&offset=${off}`); out.push(...lote); if (lote.length < 1000) break; } return out;
    },
    upsert(tab, linhas, conflito) { if (!linhas.length) return null; return this.req(`/rest/v1/${tab}?on_conflict=${conflito}`, { method: 'POST', body: linhas, prefer: 'resolution=merge-duplicates,return=minimal' }); },
    apagar(tab, filtro) { return this.req(`/rest/v1/${tab}?${filtro}`, { method: 'DELETE', prefer: 'return=minimal' }); },
    rpc(fn, args) { return this.req(`/rest/v1/rpc/${fn}`, { method: 'POST', body: args }); },
    enviarFoto(caminho, blob) {
      const enc = caminho.split('/').map(encodeURIComponent).join('/');
      return this.req(`/storage/v1/object/${this.bucket}/${enc}`, { method: 'POST', body: blob, headers: { 'Content-Type': blob.type || 'image/jpeg', 'x-upsert': 'true', 'cache-control': 'max-age=3600' } });
    },
    apagarFotos(caminhos) { if (!caminhos.length) return null; return this.req(`/storage/v1/object/${this.bucket}`, { method: 'DELETE', body: { prefixes: caminhos } }); },
    async assinar(caminhos, seg = 3600) {
      if (!caminhos.length) return [];
      const r = await this.req(`/storage/v1/object/sign/${this.bucket}`, { method: 'POST', body: { expiresIn: seg, paths: caminhos } });
      return (r || []).map((x) => ({ path: x.path, url: x.signedURL ? (/^https?:/.test(x.signedURL) ? x.signedURL : `${this.url}/storage/v1${x.signedURL}`) : null }));
    },
    async sair() { try { if (this.sessao) await fetch(`${this.url}/auth/v1/logout`, { method: 'POST', headers: { apikey: this.key, Authorization: 'Bearer ' + this.sessao.access_token } }); } catch (e) { /* offline */ } this.sessao = null; await dbDel('meta', 'sessao'); },
  };

  /* ------------------------------------------------------------ estado */
  const st = { cfg: {}, aj: {}, perfil: null, online: navigator.onLine, sinc: { rodando: false, pend: 0, txt: '' }, reg: null, fotos: [], urls: new Map(),
    filtro: { st: 'todos', q: '' }, painel: null, painelFonte: 'servidor', swNovo: null, slot: null, gps: null, gpsErro: '', gravando: false, ficha: null };

  function lerCfg() {
    const c = Object.assign({}, window.PD_CONFIG || {});
    try { const l = JSON.parse(localStorage.getItem('pdslz_cfg') || '{}'); Object.keys(l).forEach((k) => { if (l[k]) c[k] = l[k]; }); } catch (e) { /* sem armazenamento */ }
    return c;
  }
  function salvarCfg(o) {
    try { const l = JSON.parse(localStorage.getItem('pdslz_cfg') || '{}'); Object.assign(l, o); localStorage.setItem('pdslz_cfg', JSON.stringify(l)); } catch (e) { /* sem armazenamento */ }
    st.cfg = lerCfg();
  }
  function linkCfg() {
    const m = location.hash.match(/cfg=([^&]+)/);
    if (!m) return;
    try {
      const o = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(m[1])))));
      if (o.u && o.k) { salvarCfg({ supabaseUrl: o.u, supabaseKey: o.k }); toast('Conexão com o banco configurada'); }
    } catch (e) { toast('Link de configuração inválido'); }
    history.replaceState(null, '', location.pathname + '#/inicio');
  }
  const AJ_PADRAO = { nome: '', equipe: '', bloco: '', fotoMax: 1600, carimbo: true, tema: 'auto' };

  /* ------------------------------------------------------------ registros */
  function novoRegistro() {
    const agora = new Date().toISOString();
    return { id: uuid(), codigo: '', escopo: '', bloco: st.aj.bloco || '', nivel: 1, nome: '', sap: '', equipe: st.aj.equipe, inspetor: st.aj.nome,
      userId: SB.sessao && SB.sessao.user.id, iniciadoEm: agora, finalizadoEm: null, data: hoje(), gps: null, condicao: null, attrs: {}, telhados: [],
      tracado: null, resp: {}, ncs: {}, ncIds: {}, autoInfo: {}, fotosRem: [], status: 'rascunho', dirty: true, statusInspecao: 'COM', motivoParcial: '',
      nvMotivo: '', obs: '', criadoEm: agora, atualizadoEm: agora, erro: '', resumo: null };
  }
  function resumir(rec) {
    const d = diagnostico(rec);
    rec.resumo = { indice: d.indice, n: d.n, nNC: d.ncs.filter((x) => x.r === 'NC').length, nOM: d.ncs.filter((x) => x.r === 'OM').length,
      criticas: d.ncs.filter((x) => x.crit === 'Crítica').length, critMax: d.critMax, faltam: d.faltam.length };
    return d;
  }
  const _gravar = debounce(async (rec) => { await dbPut('registros', rec); contarPendentes(); }, 350);
  function mexeu(rec, agora = false) {
    rec.atualizadoEm = new Date().toISOString();
    rec.dirty = true;
    if (rec.status === 'sincronizado' || rec.status === 'erro') rec.status = rec.finalizadoEm ? 'pronto' : 'rascunho';
    aplicarAuto(rec); resumir(rec);
    if (agora) return dbPut('registros', rec).then(contarPendentes);
    _gravar(rec);
    return Promise.resolve();
  }
  async function carregarFotos(regId) { st.fotos = (await dbIdx('fotos', 'reg', regId)).sort((a, b) => (a.ts < b.ts ? -1 : 1)); return st.fotos; }
  function urlFoto(f) {
    if (!f || !f.blob) return null;
    if (!st.urls.has(f.id)) st.urls.set(f.id, URL.createObjectURL(f.blob));
    return st.urls.get(f.id);
  }

  async function sugerirCodigo(rec) {
    const eq = st.aj.equipe;
    if (!eq || !rec.escopo) return '';
    const pref = `${rec.escopo}-${eq}-`;
    let n = await metaGet(`seq:${rec.escopo}-${eq}`, 0);
    const usa = (c) => { if (c && c.startsWith(pref)) n = Math.max(n, parseInt(c.slice(-4), 10) || 0); };
    (await dbAll('registros')).forEach((r) => { if (r.id !== rec.id) usa(r.codigo); });
    (await dbAll('servidor')).forEach((r) => usa(r.codigo));
    if (st.online && SB.sessao) {
      try { const s = await SB.rpc('pd_proximo_codigo', { p_escopo: rec.escopo, p_equipe: eq }); if (s) n = Math.max(n, (parseInt(String(s).slice(-4), 10) || 1) - 1); } catch (e) { /* offline */ }
    }
    return pref + pad(n + 1, 4);
  }
  async function reservarCodigo(rec) {
    if (!/^[A-Z]{2}-[A-Z]-\d{4}$/.test(rec.codigo || '')) return;
    const chave = `seq:${rec.codigo.slice(0, 2)}-${rec.codigo.slice(3, 4)}`;
    const n = parseInt(rec.codigo.slice(-4), 10);
    if (n > (await metaGet(chave, 0))) await metaSet(chave, n);
  }

  /* ------------------------------------------------------------ GPS */
  let gpsWatch = null;
  const gpsOuvintes = new Set();
  function gpsLigar() {
    if (gpsWatch !== null || !navigator.geolocation) return;
    gpsWatch = navigator.geolocation.watchPosition((p) => {
      st.gps = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, alt: p.coords.altitude, ts: new Date(p.timestamp || Date.now()).toISOString() };
      st.gpsErro = '';
      gpsOuvintes.forEach((f) => f(st.gps));
    }, (e) => { st.gpsErro = e.code === 1 ? 'Permissão de localização negada: libere nas configurações do navegador' : 'Sem sinal de GPS ainda – vá para área aberta'; gpsOuvintes.forEach((f) => f(null)); },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 });
  }
  function gpsDesligar() { if (gpsWatch !== null) { navigator.geolocation.clearWatch(gpsWatch); gpsWatch = null; } }
  function distM(a, b) {
    const R0 = 6371008.8; const r = Math.PI / 180;
    const dl = (b[0] - a[0]) * r; const dn = (b[1] - a[1]) * r;
    const h = Math.sin(dl / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dn / 2) ** 2;
    return 2 * R0 * Math.asin(Math.sqrt(h));
  }
  function medidas(tr) {
    if (!tr || !tr.pts || tr.pts.length < 2) return { comp: 0, area: 0 };
    let comp = 0; for (let i = 1; i < tr.pts.length; i++) comp += distM(tr.pts[i - 1], tr.pts[i]);
    let area = 0;
    if (tr.tipo === 'area' && tr.pts.length >= 3) {
      const lat0 = tr.pts[0][0]; const lon0 = tr.pts[0][1];
      const xy = tr.pts.map((p) => [(p[1] - lon0) * 111320 * Math.cos(lat0 * Math.PI / 180), (p[0] - lat0) * 110574]);
      for (let i = 0; i < xy.length; i++) { const j = (i + 1) % xy.length; area += xy[i][0] * xy[j][1] - xy[j][0] * xy[i][1]; }
      area = Math.abs(area) / 2; comp += distM(tr.pts[tr.pts.length - 1], tr.pts[0]);
    }
    return { comp, area };
  }
  gpsOuvintes.add((g) => {
    if (!g || !st.gravando || !st.reg || !st.reg.tracado) return;
    const pts = st.reg.tracado.pts;
    if (g.acc > 20) return;
    const p = [g.lat, g.lon, Math.round(g.acc * 10) / 10];
    if (!pts.length || distM(pts[pts.length - 1], p) >= 3) { pts.push(p); mexeu(st.reg); atualizarGeo(); }
  });

  /* ------------------------------------------------------------ fotos */
  async function comprimir(arquivo, max, carimbo) {
    let img;
    try { img = await createImageBitmap(arquivo, { imageOrientation: 'from-image' }); }
    catch (e) { img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(arquivo); }); }
    const w0 = img.width; const h0 = img.height; const s = Math.min(1, max / Math.max(w0, h0));
    const w = Math.round(w0 * s); const h = Math.round(h0 * s);
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d'); g.drawImage(img, 0, 0, w, h);
    if (carimbo) {
      const fs = Math.max(14, Math.round(w / 52)); const linhas = carimbo.split('\n');
      const bh = fs * (linhas.length + 0.9);
      g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(0, h - bh, w, bh);
      g.fillStyle = '#F5C400'; g.font = `700 ${fs}px system-ui, sans-serif`; g.textBaseline = 'top';
      linhas.forEach((l, i) => g.fillText(l, fs * 0.6, h - bh + fs * (0.45 + i)));
    }
    const blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.82));
    return { blob, w, h };
  }
  function abrirCamera(slot, galeria) { st.slot = slot; const inp = galeria ? $('#inGal') : $('#inCam'); inp.value = ''; inp.click(); }
  async function receberFoto(arquivo) {
    const slot = st.slot; const rec = st.reg;
    if (!slot || !rec || !arquivo) return;
    try {
      const g = st.gps; const agora = new Date();
      const carimbo = st.aj.carimbo ? `${rec.codigo || 'sem código'} · ${rec.bloco || ''} · ${slot.tipo}${slot.itemId ? ' ' + slot.itemId : ''}\n${pad(agora.getDate())}/${pad(agora.getMonth() + 1)}/${agora.getFullYear()} ${pad(agora.getHours())}:${pad(agora.getMinutes())}${g ? ` · ${g.lat.toFixed(6)}, ${g.lon.toFixed(6)} ±${Math.round(g.acc)} m` : ''}` : '';
      const { blob, w, h } = await comprimir(arquivo, st.aj.fotoMax || 1600, carimbo);
      if (slot.unico) {
        for (const f of st.fotos.filter((x) => x.tipo === slot.tipo && (x.itemId || '') === (slot.itemId || '') && (x.telhadoId || '') === (slot.telhadoId || ''))) await removerFoto(f.id, true);
      }
      const f = { id: uuid(), regId: rec.id, tipo: slot.tipo, itemId: slot.itemId || null, telhadoId: slot.telhadoId || null, legenda: slot.legenda || '',
        blob, w, h, bytes: blob.size, lat: g ? g.lat : null, lon: g ? g.lon : null, ts: agora.toISOString(), enviado: false, path: null };
      await dbPut('fotos', f);
      await carregarFotos(rec.id);
      await mexeu(rec, true);
      renderPreservando();
    } catch (e) { console.error(e); toast('Não foi possível ler a foto: ' + e.message); }
  }
  async function removerFoto(id, silencioso) {
    const f = await dbGet('fotos', id); const rec = st.reg;
    if (!f) return;
    if (f.path && rec) rec.fotosRem.push({ id: f.id, path: f.path });
    await dbDel('fotos', id);
    if (st.urls.has(id)) { URL.revokeObjectURL(st.urls.get(id)); st.urls.delete(id); }
    if (!silencioso && rec) { await carregarFotos(rec.id); await mexeu(rec, true); renderPreservando(); }
  }
  function slotFoto(titulo, slot, obrig) {
    const f = st.fotos.find((x) => x.tipo === slot.tipo && (x.itemId || '') === (slot.itemId || '') && (x.telhadoId || '') === (slot.telhadoId || ''));
    const enc = esc(JSON.stringify(slot));
    if (f) {
      const u = urlFoto(f);
      return `<div class="foto"><span class="tit">${esc(titulo)}</span>${u ? `<img src="${u}" alt="${esc(titulo)}">` : f.path ? `<img data-path="${esc(f.path)}" alt="${esc(titulo)} (no servidor)">` : '<div class="vazio"><span class="mut peq">Foto sem arquivo</span></div>'}
        <button class="x" data-a="fotoDel" data-id="${f.id}" aria-label="Apagar foto">×</button></div>`;
    }
    return `<div class="foto ${obrig ? 'req' : ''}"><span class="tit">${esc(titulo)}${obrig ? ' *' : ''}</span><div class="vazio">
      <button data-a="foto" data-slot="${enc}">Câmera</button><button class="gal" data-a="fotoGal" data-slot="${enc}">Galeria</button></div></div>`;
  }

  /* ------------------------------------------------------------ sincronização */
  async function contarPendentes() {
    const regs = await dbAll('registros');
    st.sinc.pend = regs.filter((r) => r.status !== 'rascunho' && (r.dirty || r.status === 'erro')).length;
    st.sinc.rasc = regs.filter((r) => r.status === 'rascunho').length;
    pintarSinc();
  }
  function pintarSinc() {
    const b = $('#bSinc'); if (!b) return;
    const s = st.sinc;
    b.className = 'sinc' + (!st.online ? ' off' : s.rodando ? ' rod' : '');
    b.querySelector('span:last-child').textContent = !st.online ? (s.pend ? `Sem internet · ${s.pend} a enviar` : 'Sem internet')
      : s.rodando ? (s.txt || 'Enviando…') : s.pend ? `${s.pend} a enviar` : 'Tudo enviado';
  }
  function nomePadrao(rec, f, usados) {
    const d = new Date(f.ts || Date.now());
    const base = `SLZ-${rec.bloco || 'B00'}-${rec.codigo}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${f.tipo}${f.itemId ? '_' + f.itemId : ''}`;
    let nome = base + '.jpg'; let k = 2;
    while (usados.has(nome)) nome = `${base}-${k++}.jpg`;
    usados.add(nome);
    return nome;
  }
  function geojson(tr) {
    if (!tr || !tr.pts || tr.pts.length < 2) return null;
    const c = tr.pts.map((p) => [Math.round(p[1] * 1e7) / 1e7, Math.round(p[0] * 1e7) / 1e7]);
    if (tr.tipo === 'area' && c.length >= 3) return { type: 'Polygon', coordinates: [[...c, c[0]]] };
    return { type: 'LineString', coordinates: c };
  }
  function atributosEnvio(rec) {
    const o = {}; const c = ctx(rec);
    for (const f of camposDe(rec)) {
      if (f.t === 'note') continue;
      if (f.t === 'calculate') { const x = c.v(f.n); if (x !== '') o[f.n] = x; continue; }
      if (!visivel(f, rec)) continue;
      const x = rec.attrs[f.n]; if (temValor(x)) o[f.n] = NUMT.has(f.t) && isFinite(num(x)) ? num(x) : x;
    }
    return o;
  }
  async function sincronizarRegistro(rec) {
    const marca = rec.atualizadoEm;
    const fotos = await dbIdx('fotos', 'reg', rec.id);
    const ativos = new Set(ncsAtivas(rec).map(([id]) => id));
    const telIds = new Set((rec.telhados || []).map((t) => t.id));
    const validas = fotos.filter((f) => (!/^N\d$/.test(f.tipo) || ativos.has(f.itemId)) && (f.tipo !== 'TL' || telIds.has(f.telhadoId)));
    const usados = new Set();
    let i = 0;
    for (const f of validas) {
      i++;
      const nome = nomePadrao(rec, f, usados);
      const caminho = `${rec.bloco || 'B00'}/${rec.codigo}/${nome}`;
      if (f.enviado && f.path === caminho) continue;
      if (!f.blob) { usados.add(nome); continue; }
      st.sinc.txt = `Enviando fotos de ${rec.codigo} (${i}/${validas.length})`; pintarSinc();
      await SB.enviarFoto(caminho, f.blob);
      if (f.path && f.path !== caminho) rec.fotosRem.push({ id: f.id, path: f.path, manterLinha: true });
      f.enviado = true; f.path = caminho; f.nome = nome;
      await dbPut('fotos', f);
    }
    st.sinc.txt = `Gravando ${rec.codigo}`; pintarSinc();
    const d = resumir(rec); const m = medidas(rec.tracado); const g = rec.gps || {};
    await SB.upsert('pd_levantamentos', [{
      id: rec.id, codigo_ativo: rec.codigo, escopo: rec.escopo, bloco: rec.bloco || null, nome_ativo: rec.nome || null,
      nivel: rec.escopo === 'ED' ? Number(rec.nivel) || 1 : null, sap_li: rec.sap || null, equipe: rec.equipe || st.aj.equipe || null, inspetor: rec.inspetor || st.aj.nome || null,
      data_levantamento: rec.data, iniciado_em: rec.iniciadoEm, finalizado_em: rec.finalizadoEm, lat: g.lat ?? null, lon: g.lon ?? null,
      precisao_m: g.acc != null ? Math.round(g.acc * 10) / 10 : null, altitude: g.alt != null ? Math.round(g.alt * 10) / 10 : null, condicao_geral: rec.condicao ? Number(rec.condicao) : null,
      atributos: atributosEnvio(rec), tracado: geojson(rec.tracado), extensao_m: m.comp ? Math.round(m.comp * 10) / 10 : null, area_m2: m.area ? Math.round(m.area * 10) / 10 : null,
      status_inspecao: rec.statusInspecao || null, motivo_parcial: rec.motivoParcial || null, nv_motivo: rec.nvMotivo || null, observacao: rec.obs || null,
      n_c: d.n.C, n_nc: d.n.NC, n_om: d.n.OM, n_na: d.n.NA, n_nv: d.n.NV, indice: d.indice == null ? null : Math.round(d.indice * 1e4) / 1e4,
      app_versao: VERSAO, dispositivo: navigator.userAgent.slice(0, 160) }], 'id');
    const filtroLev = `levantamento_id=eq.${rec.id}`;
    const naoEm = (col, ids) => (ids.length ? `&${col}=not.in.(${ids.map((x) => `"${x}"`).join(',')})` : '');
    const ncIdsAtivos = [...ativos].map((id) => rec.ncIds[id]);
    await SB.apagar('pd_nao_conformidades', filtroLev + naoEm('id', ncIdsAtivos));
    const respostas = Object.entries(rec.resp).map(([item, x]) => ({ levantamento_id: rec.id, item_id: item, resultado: x.r, origem: x.origem || 'manual',
      justificativa: x.origem === 'auto' && rec.autoInfo[item] ? rec.autoInfo[item].txt : (x.just || null) }));
    await SB.upsert('pd_respostas', respostas, 'levantamento_id,item_id');
    await SB.apagar('pd_respostas', filtroLev + naoEm('item_id', respostas.map((x) => x.item_id)));
    const tels = (rec.telhados || []).map((t, k) => ({ id: t.id, levantamento_id: rec.id, ordem: k + 1, tipo: t.tipo || null, estrutura: t.estrutura || null,
      area_projetada_m2: isFinite(num(t.area_proj)) ? num(t.area_proj) : null, inclinacao_pct: isFinite(num(t.incl)) ? num(t.incl) : null,
      aguas: isFinite(num(t.aguas)) ? num(t.aguas) : null, calhas: t.calhas || null, condicao: isFinite(num(t.condicao)) ? num(t.condicao) : null, amianto: t.amianto || null,
      acesso_seguro: t.acesso || null, infiltracao: t.infiltr || null, fv_existente: t.fv_exist || null, fv_apto: t.fv_apto || null, observacao: t.obs || null }));
    await SB.upsert('pd_telhados', tels, 'id');
    await SB.apagar('pd_telhados', filtroLev + naoEm('id', tels.map((t) => t.id)));
    const ncs = ncsAtivas(rec).map(([item, x]) => ({ id: rec.ncIds[item], levantamento_id: rec.id, item_id: item, resultado: rec.resp[item].r,
      g: rec.resp[item].r === 'NC' && x.g ? Number(x.g) : null, u: rec.resp[item].r === 'NC' && x.u ? Number(x.u) : null, t: rec.resp[item].r === 'NC' && x.t ? Number(x.t) : null,
      descricao: x.desc || null, quantidade: x.qtd || null, contencao: x.cont === 'S' ? true : x.cont === 'N' ? false : null, contencao_desc: x.contDesc || null,
      acao_sugerida_campo: x.acaoCampo || null }));
    await SB.upsert('pd_nao_conformidades', ncs, 'id');
    const enviadas = (await dbIdx('fotos', 'reg', rec.id)).filter((f) => f.enviado && f.path && validas.some((v) => v.id === f.id));
    const linhasFoto = enviadas.map((f) => ({ id: f.id, levantamento_id: rec.id, nc_id: /^N\d$/.test(f.tipo) && ativos.has(f.itemId) ? rec.ncIds[f.itemId] : null,
      telhado_id: f.tipo === 'TL' && telIds.has(f.telhadoId) ? f.telhadoId : null, tipo: f.tipo, item_id: f.itemId || null, legenda: f.legenda || null,
      storage_path: f.path, nome_padrao: f.nome || f.path.split('/').pop(), lat: f.lat, lon: f.lon, tirada_em: f.ts, largura: f.w || null, altura: f.h || null, bytes: f.bytes || null,
      classificacao: ['PO', 'CE'].includes(rec.escopo) ? 'Restrito' : 'Uso interno' }));
    await SB.apagar('pd_fotos', filtroLev + naoEm('id', linhasFoto.map((f) => f.id)));
    await SB.upsert('pd_fotos', linhasFoto, 'id');
    const remover = rec.fotosRem.map((x) => x.path).filter((p) => !linhasFoto.some((l) => l.storage_path === p));
    if (remover.length) { try { await SB.apagarFotos(remover); } catch (e) { console.warn('Fotos antigas não removidas do servidor', e); } }
    rec.fotosRem = rec.fotosRem.filter((x) => !remover.includes(x.path) && !linhasFoto.some((l) => l.storage_path === x.path));
    const mudouDurante = rec.atualizadoEm !== marca; // editado enquanto enviava: continua pendente
    rec.status = mudouDurante ? 'pronto' : 'sincronizado'; rec.dirty = mudouDurante; rec.erro = ''; rec.sincronizadoEm = new Date().toISOString();
    await dbPut('registros', rec);
    await reservarCodigo(rec);
  }
  async function sincronizar(manual) {
    if (st.sinc.rodando) return;
    if (!st.online) { if (manual) toast('Sem internet: os levantamentos ficam guardados no aparelho e serão enviados depois'); return; }
    if (!SB.sessao || !SB.configurado()) { if (manual) toast('Entre com seu usuário para enviar'); return; }
    st.sinc.rodando = true; st.sinc.txt = 'Enviando…'; pintarSinc();
    let ok = 0; let erros = 0;
    try {
      const regs = (await dbAll('registros')).filter((r) => r.status !== 'rascunho' && (r.dirty || r.status === 'erro'));
      for (const rec of regs) {
        const atual = st.reg && st.reg.id === rec.id ? st.reg : rec;
        try { await sincronizarRegistro(atual); ok++; }
        catch (e) {
          if (ehRede(e)) throw e;
          erros++; atual.status = 'erro'; atual.erro = e.message; await dbPut('registros', atual);
          if (e.status === 401 && SB.expirada) throw e;
        }
      }
      if (ok || manual || Date.now() - (st.ultimaLeitura || 0) > 5 * 60e3) await puxarServidor().catch((e) => { if (ehRede(e)) throw e; console.warn('Leitura do servidor falhou', e); });
      if (manual || ok || erros) toast(erros ? `${ok} enviado(s); ${erros} com erro – veja em Levantamentos` : ok ? `${ok} levantamento(s) enviado(s)` : 'Nada novo para enviar');
    } catch (e) {
      if (ehRede(e)) { if (manual) toast('Sem conexão com o servidor: os dados continuam no aparelho e o envio será tentado de novo automaticamente'); }
      else if (SB.expirada) { toast('Sessão expirada: entre novamente para enviar'); }
      else toast('Falha no envio: ' + e.message);
    } finally {
      st.sinc.rodando = false; st.sinc.txt = '';
      await contarPendentes();
      if (['inicio', 'lista'].includes(rota().tela)) render();
    }
  }
  // Leitura incremental: só baixa os levantamentos novos ou alterados desde a última leitura (economiza dados móveis)
  async function puxarServidor() {
    const indice = await SB.selectTudo('pd_levantamentos', 'select=id,atualizado_em&order=id');
    const vivos = new Map(indice.map((x) => [x.id, x.atualizado_em]));
    const srv = new Map((await dbAll('servidor')).map((r) => [r.id, r.atualizadoEm]));
    const locais = new Map((await dbAll('registros')).map((r) => [r.id, r]));
    for (const id of srv.keys()) if (!vivos.has(id)) await dbDel('servidor', id);
    for (const [id, loc] of locais) {
      if (!vivos.has(id) && loc.status === 'sincronizado' && !loc.dirty && loc.sincronizadoEm && !(st.reg && st.reg.id === id)) {
        await dbDel('registros', id); for (const f of await dbIdx('fotos', 'reg', id)) await dbDel('fotos', f.id);
      }
    }
    const desatualizado = (x) => { const l = locais.get(x.id); return l && l.status === 'sincronizado' && !l.dirty && l.srvAtualizadoEm !== x.atualizado_em; };
    const mudou = indice.filter((x) => srv.get(x.id) !== x.atualizado_em || desatualizado(x)).map((x) => x.id);
    for (let i = 0; i < mudou.length; i += 50) {
      const f = `in.(${mudou.slice(i, i + 50).join(',')})`;
      st.sinc.txt = `Recebendo dados da equipe (${Math.min(i + 50, mudou.length)}/${mudou.length})`; pintarSinc();
      const [levs, resps, ncs, tels, fotos] = await Promise.all([
        SB.selectTudo('pd_levantamentos', `select=*&id=${f}&order=id`), SB.selectTudo('pd_respostas', `select=levantamento_id,item_id,resultado,origem,justificativa&levantamento_id=${f}&order=levantamento_id,item_id`),
        SB.selectTudo('pd_nao_conformidades', `select=*&levantamento_id=${f}&order=id`), SB.selectTudo('pd_telhados', `select=*&levantamento_id=${f}&order=id`), SB.selectTudo('pd_fotos', `select=*&levantamento_id=${f}&order=id`)]);
      await gravarDoServidor(levs, resps, ncs, tels, fotos, locais);
    }
    st.ultimaLeitura = Date.now();
    await metaSet('ultimaLeitura', new Date().toISOString());
    return mudou.length;
  }
  async function gravarDoServidor(levs, resps, ncs, tels, fotos, locais) {
    const por = (arr, k) => { const m = {}; arr.forEach((x) => (m[x[k]] = m[x[k]] || []).push(x)); return m; };
    const R2 = por(resps, 'levantamento_id'); const N2 = por(ncs, 'levantamento_id'); const T2 = por(tels, 'levantamento_id'); const F2 = por(fotos, 'levantamento_id');
    for (const l of levs) {
      const rec = { id: l.id, codigo: l.codigo_ativo, escopo: l.escopo, bloco: l.bloco, nome: l.nome_ativo, nivel: l.nivel || 1, sap: l.sap_li, equipe: l.equipe, inspetor: l.inspetor,
        data: l.data_levantamento, iniciadoEm: l.iniciado_em, finalizadoEm: l.finalizado_em, gps: l.lat != null ? { lat: l.lat, lon: l.lon, acc: l.precisao_m, alt: l.altitude } : null,
        condicao: l.condicao_geral, attrs: Object.fromEntries(Object.entries(l.atributos || {}).map(([k, v]) => [k, Array.isArray(v) ? v.join(' ') : typeof v === 'number' ? String(v).replace('.', ',') : String(v)])),
        telhados: (T2[l.id] || []).sort((a, b) => (a.ordem || 0) - (b.ordem || 0)).map((t) => ({ id: t.id, tipo: t.tipo, estrutura: t.estrutura, area_proj: t.area_projetada_m2, incl: t.inclinacao_pct,
          aguas: t.aguas, calhas: t.calhas, condicao: t.condicao, amianto: t.amianto, acesso: t.acesso_seguro, infiltr: t.infiltracao, fv_exist: t.fv_existente, fv_apto: t.fv_apto, obs: t.observacao })),
        tracado: l.tracado ? { tipo: l.tracado.type === 'Polygon' ? 'area' : 'linha', pts: (l.tracado.type === 'Polygon' ? l.tracado.coordinates[0].slice(0, -1) : l.tracado.coordinates).map((c) => [c[1], c[0], null]) } : null,
        resp: Object.fromEntries((R2[l.id] || []).map((r) => [r.item_id, { r: r.resultado, origem: r.origem, just: r.justificativa }])),
        ncs: Object.fromEntries((N2[l.id] || []).map((n) => [n.item_id, { g: n.g, u: n.u, t: n.t, desc: n.descricao, qtd: n.quantidade, cont: n.contencao === true ? 'S' : n.contencao === false ? 'N' : '', contDesc: n.contencao_desc, acaoCampo: n.acao_sugerida_campo, status: n.status }])),
        ncIds: Object.fromEntries((N2[l.id] || []).map((n) => [n.item_id, n.id])), autoInfo: {},
        fotosSrv: (F2[l.id] || []).map((f) => ({ id: f.id, tipo: f.tipo, itemId: f.item_id, telhadoId: f.telhado_id, legenda: f.legenda || '', path: f.storage_path, nome: f.nome_padrao,
          lat: f.lat, lon: f.lon, ts: f.tirada_em, w: f.largura, h: f.altura, bytes: f.bytes })),
        statusInspecao: l.status_inspecao, motivoParcial: l.motivo_parcial, nvMotivo: l.nv_motivo, obs: l.observacao, status: 'servidor', atualizadoEm: l.atualizado_em, indiceSrv: l.indice };
      resumir(rec);
      await dbPut('servidor', rec);
      const loc = locais.get(l.id);
      if (loc && loc.status === 'sincronizado' && !loc.dirty && loc.srvAtualizadoEm !== l.atualizado_em && !(st.reg && st.reg.id === l.id)) await dbPut('registros', await paraLocal(rec, loc));
    }
  }
  async function paraLocal(srv, loc) {
    const rec = Object.assign({}, srv, { status: 'sincronizado', dirty: false, fotosRem: [], erro: '', sincronizadoEm: (loc && loc.sincronizadoEm) || srv.atualizadoEm,
      srvAtualizadoEm: srv.atualizadoEm, userId: loc ? loc.userId : null, criadoEm: loc ? loc.criadoEm : srv.iniciadoEm, autoInfo: {}, resumo: null });
    const ids = new Set();
    for (const f of srv.fotosSrv || []) {
      ids.add(f.id);
      const x = await dbGet('fotos', f.id);
      if (!x) await dbPut('fotos', Object.assign({}, f, { regId: rec.id, blob: null, enviado: true }));
      else if (x.path !== f.path || (x.legenda || '') !== (f.legenda || '')) await dbPut('fotos', Object.assign(x, { path: f.path, nome: f.nome, legenda: f.legenda, enviado: true }));
    }
    for (const f of await dbIdx('fotos', 'reg', rec.id)) if (f.enviado && !ids.has(f.id)) await dbDel('fotos', f.id);
    delete rec.fotosSrv;
    aplicarAuto(rec); resumir(rec);
    return rec;
  }
  async function todosRegistros() {
    const loc = await dbAll('registros'); const srv = await dbAll('servidor');
    const ids = new Set(loc.map((r) => r.id));
    return [...loc, ...srv.filter((r) => !ids.has(r.id))];
  }

  /* ------------------------------------------------------------ rotas e casca */
  const ICON = {
    inicio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/></svg>',
    lista: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
    mapa: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
    painel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
    ajustes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  };
  function rota() {
    const h = location.hash.replace(/^#\/?/, '');
    const [tela, a, b] = h.split('/');
    return { tela: tela || 'inicio', id: a, passo: b };
  }
  const irPara = (h, substituir) => { if (substituir) { history.replaceState(null, '', '#/' + h); window.dispatchEvent(new HashChangeEvent('hashchange')); } else location.hash = '#/' + h; };

  function passosDe(rec) {
    const ps = [{ id: 'id', t: 'Identificação' }, { id: 'loc', t: 'Localização' }];
    if (rec.escopo) {
      ps.push({ id: 'cad', t: 'Cadastro' });
      if (rec.escopo === 'ED') ps.push({ id: 'tel', t: 'Telhados' });
      if (ESC[rec.escopo].geom !== 'ponto') ps.push({ id: 'geo', t: 'Traçado' });
      ps.push({ id: 'ck', t: 'Checklist' }, { id: 'nc', t: 'Não conformidades' }, { id: 'fot', t: 'Fotos' });
    }
    ps.push({ id: 'fim', t: 'Diagnóstico' });
    return ps;
  }

  function topo(titulo, voltar, extra = '') {
    return `<header class="topo">${voltar ? `<button class="vol" data-a="voltar" data-h="${esc(voltar)}" aria-label="Voltar">‹</button>` : ''}
      <h1>${esc(titulo)}</h1>${extra}<button class="sinc" id="bSinc" data-a="sinc"><span class="pt"></span><span></span></button></header>`;
  }
  function nav(atual) {
    const it = [['inicio', 'Início'], ['lista', 'Levantamentos'], ['mapa', 'Mapa'], ['painel', 'Painel'], ['ajustes', 'Ajustes']];
    return `<nav class="nav">${it.map(([k, t]) => `<button class="${k === atual ? 'on' : ''}" data-a="ir" data-h="${k}">${ICON[k]}<span>${t}</span></button>`).join('')}</nav>`;
  }

  async function render() {
    const app = $('#app'); const r = rota();
    if (!SB.configurado()) { app.innerHTML = telaConfigurar(); pintarSinc(); return; }
    if (!SB.sessao) { app.innerHTML = telaLogin(); return; }
    if (r.tela !== 'form' && r.tela !== 'mapa') { gpsDesligar(); st.gravando = false; }
    if (r.tela !== 'form') st.reg = null;
    let html = '';
    switch (r.tela) {
      case 'form': html = await telaForm(r); break;
      case 'lista': html = await telaLista(); break;
      case 'mapa': html = telaMapa(); break;
      case 'painel': html = await telaPainel(); break;
      case 'ajustes': html = await telaAjustes(); break;
      case 'ajuda': html = telaAjuda(); break;
      case 'equipe': html = await telaEquipe(); break;
      default: html = await telaInicio();
    }
    if (html === null) return;
    app.innerHTML = html;
    pintarSinc();
    if (r.tela === 'mapa') montarMapa();
    if (r.tela === 'form' && st.reg) { st.assin = assinatura(st.reg); aposForm(r.passo); }
  }
  function renderPreservando() { const y = window.scrollY; return render().then(() => window.scrollTo(0, y)); }

  /* ------------------------------------------------------------ telas: configurar e entrar */
  function telaConfigurar() {
    return `${topo('PD Campo · conexão', '')}<main>
      <h2>Conectar ao banco de dados</h2>
      <p class="mut">Use o link de configuração enviado pelo coordenador ou preencha os dados do projeto Supabase (Project Settings › API).</p>
      <div class="cartao">
        <div class="campo"><label for="cfgU">URL do projeto</label><input class="inp" id="cfgU" inputmode="url" placeholder="https://xxxx.supabase.co" value="${esc(st.cfg.supabaseUrl || '')}"></div>
        <div class="campo"><label for="cfgK">Chave pública (publishable ou anon)</label><input class="inp" id="cfgK" placeholder="sb_publishable_…" value="${esc(st.cfg.supabaseKey || '')}"></div>
        <button class="bt pri bloco" data-a="cfgSalvar">Salvar e testar</button>
        <p class="mut peq">Nunca use a chave secret/service_role no aplicativo.</p>
      </div></main>`;
  }
  function telaLogin() {
    return `<header class="topo"><h1>PD Campo</h1></header><main>
      <div class="plaqueta"><div class="furo"></div><div class="corpo"><div class="cod">PD-SLZ</div><div class="sub">Levantamento de campo do Plano Diretor</div></div></div>
      <div class="cartao">
        <h2>Entrar</h2>
        <div class="campo"><label for="lgE">E-mail</label><input class="inp" id="lgE" type="email" autocomplete="username" inputmode="email"></div>
        <div class="campo"><label for="lgS">Senha</label><input class="inp" id="lgS" type="password" autocomplete="current-password"></div>
        <button class="bt pri bloco" data-a="entrar">Entrar</button>
        <p class="mut peq" id="lgMsg">${st.online ? '' : 'Sem internet: o primeiro acesso precisa de conexão.'}</p>
      </div>
      <p class="mut peq">Banco: ${esc(SB.url)} · <button class="lnk" data-a="cfgTrocar">alterar conexão</button></p></main>`;
  }

  /* ------------------------------------------------------------ tela: início */
  async function telaInicio() {
    const regs = await dbAll('registros'); const hj = hoje();
    const deHoje = regs.filter((r) => r.data === hj);
    const rasc = regs.filter((r) => r.status === 'rascunho').sort((a, b) => (a.atualizadoEm < b.atualizadoEm ? 1 : -1));
    const erros = regs.filter((r) => r.status === 'erro');
    const nNC = deHoje.reduce((s, r) => s + ((r.resumo && r.resumo.nNC) || 0), 0); const nCr = deHoje.reduce((s, r) => s + ((r.resumo && r.resumo.criticas) || 0), 0);
    const semEquipe = !st.aj.equipe;
    const papel = st.perfil && st.perfil.papel; const leitor = papel === 'leitor' || papel === 'pendente';
    const ult = regs.filter((r) => r.finalizadoEm && r.escopo).sort((a, b) => (a.finalizadoEm < b.finalizadoEm ? 1 : -1))[0];
    return `${topo('PD Campo', '')}<main class="com-nav">
      <p class="mut">${esc(st.aj.nome || (SB.sessao.user.email || ''))}${st.aj.equipe ? ` · equipe ${esc(st.aj.equipe)}` : ''}${st.aj.bloco ? ` · bloco ${esc(st.aj.bloco)}` : ''}</p>
      ${semEquipe ? `<div class="cartao aviso"><b>Defina sua letra de equipe</b><p class="peq">Ela entra no código dos ativos (ED-<b>A</b>-0001) e evita códigos repetidos entre aparelhos.</p><button class="bt" data-a="ir" data-h="ajustes">Abrir ajustes</button></div>` : ''}
      ${st.swNovo ? '<div class="cartao aviso"><b>Nova versão do app disponível</b><p class="peq">Atualize quando não estiver no meio de um levantamento.</p><button class="bt" data-a="swAtualizar">Atualizar agora</button></div>' : ''}
      ${papel === 'pendente' ? '<div class="cartao aviso"><b>Acesso aguardando liberação</b><p class="peq">Seu usuário foi criado, mas o coordenador ainda não liberou o acesso. Peça a liberação (Ajustes › Equipe, no aparelho do coordenador) e toque em “Enviar agora” para atualizar.</p></div>' : ''}
      ${papel === 'leitor' ? '<div class="cartao aviso"><b>Perfil somente leitura</b><p class="peq">Seu usuário pode consultar o painel, o mapa e exportar, mas não grava levantamentos. Peça ao coordenador para mudar seu perfil para inspetor.</p></div>' : ''}
      <button class="bt pri big" data-a="novo" ${semEquipe || leitor ? 'disabled' : ''}>+ Novo levantamento</button>
      ${ult && !leitor && !semEquipe ? `<button class="bt bloco" style="margin-top:8px" data-a="duplicar" data-id="${ult.id}">+ Outro ativo de ${esc(ESC[ult.escopo].curto.toLowerCase())} <span class="mut peq">(copia o cadastro de ${esc(ult.codigo)})</span></button>` : ''}
      <div class="kpis" style="margin-top:12px">
        <div class="kpi"><b>${deHoje.length}</b><span>ativos hoje</span></div>
        <div class="kpi"><b>${nNC}</b><span>não conformidades hoje</span></div>
        <div class="kpi ${nCr ? 'cr' : ''}"><b>${nCr}</b><span>críticas hoje</span></div>
        <div class="kpi"><b>${st.sinc.pend || 0}</b><span>a enviar</span></div>
      </div>
      ${erros.length ? `<div class="cartao erro"><b>${erros.length} levantamento(s) com erro no envio</b><p class="peq">${esc(erros[0].erro || '')}</p><button class="bt" data-a="ir" data-h="lista">Ver levantamentos</button></div>` : ''}
      ${rasc.length ? `<h3>Continuar rascunho</h3>${rasc.slice(0, 5).map(linhaReg).join('')}` : ''}
      <div class="linha-bts" style="margin-top:10px"><button class="bt" data-a="sinc">Enviar agora</button><button class="bt" data-a="ir" data-h="ajuda">Como usar</button></div>
    </main>${nav('inicio')}`;
  }
  function linhaReg(r) {
    const e = ESC[r.escopo]; const idx = r.resumo ? r.resumo.indice : null;
    const rotSt = { rascunho: 'Rascunho', pronto: 'A enviar', sincronizado: 'Enviado', erro: 'Erro', servidor: 'Equipe' }[r.status] || r.status;
    return `<button class="reg" data-a="abrir" data-id="${r.id}" data-srv="${r.status === 'servidor' ? 1 : ''}">
      <span class="esq"><span class="mini">${esc(r.codigo || 'sem código')}</span><span class="st ${r.status}">${rotSt}</span></span>
      <span class="meio"><b>${esc(r.nome || (e ? e.curto : 'Novo levantamento'))}</b><span>${e ? esc(e.curto) : '—'} · ${esc(r.bloco || '—')} · ${brHora(r.atualizadoEm)}${r.resumo && r.resumo.nNC ? ` · ${r.resumo.nNC} NC` : ''}${r.status === 'servidor' && r.equipe ? ` · equipe ${esc(r.equipe)}` : ''}</span></span>
      <span class="dot" style="background:${COR_HEX(idx)}" title="Índice ${pct(idx)}"></span></button>`;
  }

  /* ------------------------------------------------------------ tela: lista */
  async function telaLista() {
    const todos = await todosRegistros();
    const f = st.filtro; const q = f.q.toLowerCase();
    const L = todos.filter((r) => (f.st === 'todos' || (f.st === 'meus' ? r.status !== 'servidor' : r.status === f.st))
      && (!q || `${r.codigo} ${r.nome} ${r.bloco} ${r.escopo}`.toLowerCase().includes(q))).sort((a, b) => ((a.atualizadoEm || '') < (b.atualizadoEm || '') ? 1 : -1));
    const ops = [['todos', 'Todos'], ['meus', 'Deste aparelho'], ['rascunho', 'Rascunhos'], ['pronto', 'A enviar'], ['erro', 'Com erro'], ['servidor', 'Da equipe']];
    return `${topo('Levantamentos', '')}<main class="com-nav">
      <div class="campo"><input class="inp" id="busca" placeholder="Buscar por código, nome ou bloco" value="${esc(f.q)}"></div>
      <div class="chips" style="margin-bottom:12px">${ops.map(([k, t]) => `<button class="${f.st === k ? 'on' : ''}" data-a="filtro" data-v="${k}">${t}</button>`).join('')}</div>
      ${L.length ? L.slice(0, 300).map(linhaReg).join('') : '<div class="vazio-tela"><p>Nenhum levantamento aqui.</p><button class="bt pri" data-a="novo">+ Novo levantamento</button></div>'}
      ${L.length > 300 ? `<p class="mut peq">Mostrando 300 de ${L.length}. Use a busca.</p>` : ''}
    </main>${nav('lista')}`;
  }

  /* ------------------------------------------------------------ formulário */
  async function telaForm(r) {
    if (!st.reg || st.reg.id !== r.id) {
      let rec = await dbGet('registros', r.id);
      if (!rec) {
        const srv = await dbGet('servidor', r.id);
        if (!srv) { irPara('inicio', true); return null; }
        rec = await paraLocal(srv, null);
        await dbPut('registros', rec);
        toast('Levantamento da equipe aberto para edição neste aparelho');
      }
      rec.ncIds = rec.ncIds || {}; rec.ncs = rec.ncs || {}; rec.resp = rec.resp || {}; rec.attrs = rec.attrs || {}; rec.fotosRem = rec.fotosRem || [];
      st.reg = rec; aplicarAuto(rec); resumir(rec);
      await carregarFotos(rec.id);
      gpsLigar();
    }
    const rec = st.reg; const ps = passosDe(rec);
    const passo = ps.find((p) => p.id === r.passo) ? r.passo : ps[0].id;
    const k = ps.findIndex((p) => p.id === passo);
    const d = diagnostico(rec); const pend = pendencias(rec, d, st.fotos);
    const errosPasso = new Set(pend.B.map((x) => x.passo));
    const corpo = ({ id: passoId, loc: passoLoc, cad: passoCad, tel: passoTel, geo: passoGeo, ck: passoCk, nc: passoNc, fot: passoFot, fim: passoFim })[passo](rec, d, pend);
    const plaq = plaquetaHTML(rec, d);
    const ult = k === ps.length - 1;
    return `${topo(`${k + 1}/${ps.length} · ${ps[k].t}`, 'sair')}
      <div class="passos">${ps.map((p, i) => `<button class="${i === k ? 'atual' : i < k ? (errosPasso.has(p.id) ? 'erro' : 'feito') : (errosPasso.has(p.id) && rec.finalizadoEm ? 'erro' : '')}" data-a="passo" data-p="${p.id}" aria-label="${esc(p.t)}"></button>`).join('')}</div>
      <main>${plaq}${corpo}</main>
      <div class="acao">${k > 0 ? `<button class="bt" data-a="passo" data-p="${ps[k - 1].id}">Voltar</button>` : '<button class="bt" data-a="sair">Sair</button>'}
      ${ult ? `<button class="bt pri" data-a="finalizar">${rec.finalizadoEm ? 'Salvar e enviar' : 'Finalizar levantamento'}</button>` : `<button class="bt pri" data-a="passo" data-p="${ps[k + 1].id}">Próximo</button>`}</div>`;
  }
  function plaquetaHTML(rec, d) {
    const e = ESC[rec.escopo];
    return `<div class="plaqueta"><div class="furo"></div><div class="corpo"><div class="cod">${esc(rec.codigo || 'SEM CÓDIGO')}</div>
      <div class="sub">${e ? esc(e.curto) : 'escolha o escopo'}${rec.bloco ? ' · ' + esc(rec.bloco) : ''}${rec.nome ? ' · ' + esc(rec.nome) : ''}</div></div>
      <div class="idx">${d.indice == null ? '<b class="vazio">—</b>' : `<b style="background:${COR_HEX(d.indice)};color:${d.indice >= PARAM.indice_atencao && d.indice < PARAM.indice_bom ? '#14201C' : '#fff'}">${pct(d.indice)}</b>`}<span>índice</span></div></div>`;
  }
  function atualizarPlaqueta(rec) { const p = $('main .plaqueta'); if (p && rota().tela === 'form') p.outerHTML = plaquetaHTML(rec, diagnostico(rec)); }
  function assinatura(rec) {
    const c = ctx(rec);
    const notas = camposDe(rec).filter((f) => f.t === 'note' && visivel(f, rec)).map((f) => f.l.replace(/\$\{(\w+)\}/g, (m0, n) => String(c.v(n)))).join('|');
    const tels = (rec.telhados || []).map((t) => `${t.tipo}:${num(t.area_proj)}:${num(t.incl)}`).join('|');
    let pend = '';
    if (rota().passo === 'fim') { const pd = pendencias(rec, diagnostico(rec), st.fotos); pend = pd.B.concat(pd.W).map((x) => x.txt).join('|'); }
    return [rota().passo, camposVisiveis(rec).map((f) => f.n).join(','), notas, tels, passosDe(rec).map((p) => p.id).join(','), pend].join('#');
  }
  function renderSuave() {
    setTimeout(() => {
      const id = document.activeElement && document.activeElement.id;
      renderPreservando().then(() => { if (id) { const el = document.getElementById(id); if (el) el.focus({ preventScroll: true }); } });
    }, 0);
  }
  function aposForm(passo) {
    if (passo === 'loc') atualizarGPS();
    if (passo === 'geo') atualizarGeo();
    miniaturasServidor();
  }
  const ASSINADAS = new Map();
  async function miniaturasServidor() {
    const imgs = $$('img[data-path]').filter((i) => i.dataset.path && !i.getAttribute('src'));
    if (!imgs.length) return;
    const agora = Date.now();
    const falta = [...new Set(imgs.map((i) => i.dataset.path))].filter((p) => !(ASSINADAS.has(p) && ASSINADAS.get(p).exp > agora));
    if (falta.length && st.online && SB.sessao) {
      try { (await SB.assinar(falta, 3600)).forEach((x) => { if (x.url) ASSINADAS.set(x.path, { url: x.url, exp: agora + 3500e3 }); }); } catch (e) { /* sem rede: fica o texto alternativo */ }
    }
    imgs.forEach((i) => { const a = ASSINADAS.get(i.dataset.path); if (a) i.src = a.url; });
  }

  function campoHTML(f, val, chave) {
    const id = 'f_' + chave.replace(/[^\w]/g, '_');
    const req = f.req ? ' <span class="req">*</span>' : '';
    const dica = f.hint ? `<div class="dica">${esc(f.hint)}</div>` : '';
    if (f.t === 'note') return '';
    if (f.t === 'select_one') {
      const ops = CAT.choices[f.list] || [];
      if (ops.length <= 5) {
        return `<div class="campo"><span class="rot">${esc(f.l)}${req}</span><div class="seg">${ops.map(([c, l]) => `<button class="${String(val) === c ? 'on' : ''}" data-a="set" data-f="${chave}" data-v="${esc(c)}">${esc(l)}</button>`).join('')}</div>${dica}</div>`;
      }
      return `<div class="campo"><label for="${id}">${esc(f.l)}${req}</label><select class="inp" id="${id}" data-f="${chave}"><option value="">Escolha…</option>${ops.map(([c, l]) => `<option value="${esc(c)}" ${String(val) === c ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>${dica}</div>`;
    }
    if (f.t === 'select_multiple') {
      const sel = String(val || '').split(' ').filter(Boolean);
      return `<div class="campo"><span class="rot">${esc(f.l)}${req}</span><div class="chips">${(CAT.choices[f.list] || []).map(([c, l]) => `<button class="${sel.includes(c) ? 'on' : ''}" data-a="tog" data-f="${chave}" data-v="${esc(c)}">${esc(l)}</button>`).join('')}</div>${dica}</div>`;
    }
    const tipo = f.t === 'date' ? 'date' : 'text';
    const im = f.t === 'integer' ? 'numeric' : f.t === 'decimal' ? 'decimal' : 'text';
    if (f.multi) return `<div class="campo"><label for="${id}">${esc(f.l)}${req}</label><textarea class="inp" id="${id}" data-f="${chave}">${esc(val || '')}</textarea>${dica}</div>`;
    return `<div class="campo"><label for="${id}">${esc(f.l)}${req}</label><input class="inp" id="${id}" type="${tipo}" inputmode="${im}" data-f="${chave}" value="${esc(val ?? '')}" ${f.t === 'text' ? 'autocapitalize="sentences"' : ''}>${dica}</div>`;
  }

  function passoId(rec) {
    const blocos = new Set(); (st._blocos || []).forEach((b) => blocos.add(b));
    const bloqueiaEsc = Object.keys(rec.resp).length > 0 || Object.keys(rec.attrs).length > 0;
    return `<h2>Qual ativo é este?</h2>
      <div class="campo"><span class="rot">Escopo <span class="req">*</span></span>
        ${bloqueiaEsc && rec.escopo ? `<p class="peq mut">Escopo ${esc(ESC[rec.escopo].curto)}. <button class="lnk" data-a="trocarEsc">Trocar escopo</button> (apaga cadastro e checklist)</p>` : `<div class="grade-esc">${CAT.escopos.map((e) => `<button class="esc-bt ${rec.escopo === e.cod ? 'on' : ''}" data-a="escopo" data-v="${e.cod}"><b style="background:${e.cor}">${e.cod}</b><span>${esc(e.curto)}</span></button>`).join('')}</div>`}
      </div>
      ${rec.escopo === 'ED' ? `<div class="campo"><span class="rot">Nível de inspeção</span><div class="seg"><button class="${Number(rec.nivel) === 1 ? 'on' : ''}" data-a="setReg" data-k="nivel" data-v="1">1 – completo</button><button class="${Number(rec.nivel) === 2 ? 'on' : ''}" data-a="setReg" data-k="nivel" data-v="2">2 – simplificado</button></div><div class="dica">Nível 2: só os itens de maior severidade (edificações de baixa ocupação e baixo risco).</div></div>` : ''}
      <div class="campo"><label for="fBloco">Bloco <span class="req">*</span></label><input class="inp" id="fBloco" data-f="reg:bloco" value="${esc(rec.bloco)}" placeholder="B01" autocapitalize="characters" maxlength="3"></div>
      <div class="campo"><label for="fCod">Código do ativo <span class="req">*</span></label>
        <div class="linha-bts"><input class="inp" id="fCod" data-f="reg:codigo" value="${esc(rec.codigo)}" placeholder="ED-A-0001" autocapitalize="characters" maxlength="9" style="flex:2"><button class="bt" data-a="sugerir" style="flex:1">Sugerir</button></div>
        <div class="dica">Formato ESCOPO-EQUIPE-0000. Se o ativo já tem placa ou código no cadastro, anote em “Código SAP/LI”.</div></div>
      <div class="campo"><label for="fNome">Nome ou uso <span class="req">*</span></label><input class="inp" id="fNome" data-f="reg:nome" value="${esc(rec.nome)}" placeholder="ex.: Vestiário da oficina de vagões"></div>
      <div class="campo"><label for="fSap">Código SAP / LI / placa existente</label><input class="inp" id="fSap" data-f="reg:sap" value="${esc(rec.sap)}"></div>
      <p class="mut peq">Equipe ${esc(rec.equipe || st.aj.equipe || '—')} · ${esc(rec.inspetor || st.aj.nome || '—')} · ${brData(rec.data)}</p>`;
  }

  function passoLoc(rec) {
    const fx = rec.gps;
    return `<h2>Onde está</h2>
      <div class="cartao"><div class="gps"><div class="acc" id="gpsAcc">—</div><div><div id="gpsTxt" class="peq">Procurando sinal de GPS…</div><div id="gpsCoord" class="mut peq"></div></div></div>
      <p class="peq mut" style="margin-top:8px">${ESC[rec.escopo] ? 'Ponto de referência: ' + esc(refPonto(rec.escopo)) + '.' : ''} Espere a precisão chegar a ${PARAM.gps_meta_m} m ou menos.</p>
      <button class="bt pri bloco" data-a="fixar">Fixar ponto aqui</button>
      ${fx ? `<p class="peq" style="margin-top:8px">Ponto fixado: <b>${fx.lat.toFixed(6)}, ${fx.lon.toFixed(6)}</b> · ±${fmt(fx.acc, 1)} m · ${brHora(fx.ts)}</p>` : '<p class="peq msg" style="color:var(--nc);font-weight:600;margin-top:8px">Ponto ainda não fixado.</p>'}</div>
      <h3>Foto principal</h3><div class="fotos">${slotFoto('Principal', { tipo: 'F', unico: true }, true)}</div>
      <h3>Condição geral</h3>
      <div class="seg">${(CAT.choices.condicao || []).slice().reverse().map(([c, l]) => `<button class="${String(rec.condicao) === c ? 'on' : ''}" data-a="setReg" data-k="condicao" data-v="${c}">${esc(l)}</button>`).join('')}</div>
      <p class="mut peq">5 ótimo · 4 bom · 3 regular (manutenção planejada) · 2 ruim (afeta o uso) · 1 crítico (risco ou perda de função)</p>`;
  }
  const REF_PONTO = { ED: 'porta de entrada principal', VI: 'início do trecho', SV: 'base do suporte da placa', FP: 'centro da travessia', CS: 'início do trecho', ES: 'entrada do estacionamento',
    PB: 'abrigo ou poste da parada', DR: 'centro do dispositivo', IL: 'base do poste', EP: 'centro do conjunto', CA: 'portão do canteiro', ET: 'entrada da unidade', EA: 'unidade ou reservatório',
    DI: 'porta do depósito', HI: 'hidrante ou abrigo', UT: 'equipamento', PO: 'catraca ou guarita', CE: 'início do trecho', AV: 'centro da mancha ou tronco da árvore', ZN: 'centro da área', OT: 'o próprio ponto' };
  const refPonto = (e) => REF_PONTO[e] || 'o ativo';
  function atualizarGPS() {
    const a = $('#gpsAcc'); if (!a) return;
    const g = st.gps;
    if (!g) { $('#gpsTxt').textContent = st.gpsErro || 'Procurando sinal de GPS…'; a.textContent = '—'; a.className = 'acc'; return; }
    a.innerHTML = `±${fmt(g.acc, g.acc < 10 ? 1 : 0)}<small> m</small>`;
    a.className = 'acc ' + (g.acc <= PARAM.gps_meta_m ? 'bom' : g.acc <= 15 ? 'med' : 'ruim');
    $('#gpsTxt').textContent = g.acc <= PARAM.gps_meta_m ? 'Precisão boa: pode fixar' : g.acc <= 15 ? 'Aguarde mais um pouco em área aberta' : 'Precisão ruim: afaste-se de prédios e estruturas metálicas';
    $('#gpsCoord').textContent = `${g.lat.toFixed(6)}, ${g.lon.toFixed(6)}`;
  }
  gpsOuvintes.add(() => { if (rota().passo === 'loc') atualizarGPS(); });

  function passoCad(rec) {
    const c = ctx(rec);
    const fs = camposDe(rec).filter((f) => visivel(f, rec));
    const html = fs.map((f) => {
      if (f.t === 'calculate') return '';
      if (f.t === 'note') return `<div class="nota">${esc(f.l.replace(/\$\{(\w+)\}/g, (m0, n) => { const x = c.v(n); return x === '' ? '—' : fmt(x, 1); }))}</div>`;
      return campoHTML(f, rec.attrs[f.n], 'attr:' + f.n);
    }).join('');
    return `<h2>Cadastro de ${esc(ESC[rec.escopo].curto.toLowerCase())}</h2>
      <p class="mut peq">As medições alimentam o diagnóstico automático do checklist (normas citadas em cada item).</p>${html}`;
  }

  const TL_CAMPOS = [
    { k: 'tipo', l: 'Tipo de telha', t: 'select_one', list: 'tipo_telha', req: 1 }, { k: 'estrutura', l: 'Estrutura', t: 'select_one', list: 'estr_cob' },
    { k: 'area_proj', l: 'Área projetada (m²)', t: 'decimal', req: 1, hint: 'Pela planta, pela imagem (régua do QGIS/Google Earth) ou trena no contorno' },
    { k: 'incl', l: 'Inclinação (%)', t: 'decimal', hint: 'Inclinômetro na empena ou referência: metálica 5–10%, fibrocimento 10–15%, cerâmica 30–35%' },
    { k: 'aguas', l: 'Nº de águas', t: 'integer' }, { k: 'calhas', l: 'Calhas e condutores', t: 'select_one', list: 'snni' },
    { k: 'condicao', l: 'Condição (1 a 5)', t: 'select_one', list: 'condicao' }, { k: 'amianto', l: 'Suspeita de amianto?', t: 'select_one', list: 'snni', so: 'FIB' },
    { k: 'acesso', l: 'Acesso seguro para manutenção (linha de vida/escada fixa)?', t: 'select_one', list: 'snni' }, { k: 'infiltr', l: 'Infiltração/goteira?', t: 'select_one', list: 'snni' },
    { k: 'fv_exist', l: 'Possui fotovoltaico?', t: 'select_one', list: 'snni' }, { k: 'fv_apto', l: 'Área apta a fotovoltaico?', t: 'select_one', list: 'snni' }];
  function passoTel(rec) {
    const tl = rec.telhados || [];
    return `<h2>Telhados e coberturas</h2>
      <div class="cartao aviso peq">Levante sempre do solo, de ponto elevado seguro ou pela imagem. Nunca suba no telhado nem pise em fibrocimento.</div>
      ${tl.map((t, i) => {
        const ar = num(t.area_proj); const inc = num(t.incl) || 0;
        const real = isFinite(ar) ? Math.round(ar * Math.sqrt(1 + (inc / 100) ** 2) * 10) / 10 : null;
        return `<div class="cartao"><div class="linha-bts" style="align-items:center"><b style="flex:1">Cobertura ${i + 1}</b><button class="lnk" data-a="telDel" data-i="${i}">Remover</button></div>
          ${TL_CAMPOS.filter((f) => !f.so || t.tipo === f.so).map((f) => campoHTML(Object.assign({ n: f.k }, f), t[f.k], `tel:${i}:${f.k}`)).join('')}
          <p><b>Área real: ${real == null ? '—' : fmt(real, 1) + ' m²'}</b> <span class="mut peq">= projetada × √(1 + inclinação²)</span></p>
          <div class="fotos">${slotFoto('Cobertura', { tipo: 'TL', telhadoId: t.id, unico: true }, false)}</div></div>`;
      }).join('')}
      <button class="bt bloco" data-a="telAdd">+ Adicionar cobertura</button>
      ${tl.length ? `<p class="mut peq" style="margin-top:10px">Total: ${fmt(tl.reduce((s, t) => { const a = num(t.area_proj); return s + (isFinite(a) ? a * Math.sqrt(1 + ((num(t.incl) || 0) / 100) ** 2) : 0); }, 0), 1)} m² de área real.</p>` : ''}`;
  }

  function passoGeo(rec) {
    const tipo = ESC[rec.escopo].geom === 'area' ? 'area' : 'linha';
    if (!rec.tracado) rec.tracado = { tipo, pts: [] };
    return `<h2>Traçado da ${tipo === 'area' ? 'área' : 'linha'}</h2>
      <p class="mut peq">${tipo === 'area' ? 'Caminhe pelo contorno marcando os vértices nos cantos.' : 'Marque o início, as mudanças de direção e o fim do trecho, ou grave caminhando.'} Opcional: se não der, o coordenador desenha no QGIS pelo código.</p>
      <div class="cartao"><svg class="esboco" id="esboco" viewBox="0 0 300 180" preserveAspectRatio="xMidYMid meet"></svg>
        <p id="geoTxt" class="peq"></p>
        <div class="linha-bts"><button class="bt pri" data-a="vertice">Marcar ponto aqui</button><button class="bt" data-a="gravar" id="btGravar">${st.gravando ? 'Parar gravação' : 'Gravar caminhando'}</button></div>
        <div class="linha-bts" style="margin-top:8px"><button class="bt" data-a="desfazer">Desfazer último</button><button class="bt" data-a="limparGeo">Limpar</button></div></div>`;
  }
  function atualizarGeo() {
    const svg = $('#esboco'); const rec = st.reg; if (!svg || !rec || !rec.tracado) return;
    const pts = rec.tracado.pts; const m = medidas(rec.tracado);
    $('#geoTxt').textContent = `${pts.length} ponto(s) · ${rec.tracado.tipo === 'area' ? `área ${fmt(m.area, 0)} m² · perímetro ${fmt(m.comp, 0)} m` : `extensão ${fmt(m.comp, 0)} m`}${st.gravando ? ' · gravando' : ''}`;
    const bg = $('#btGravar'); if (bg) bg.textContent = st.gravando ? 'Parar gravação' : 'Gravar caminhando';
    if (!pts.length) { svg.innerHTML = '<text x="150" y="95" text-anchor="middle" fill="currentColor" font-size="12">Nenhum ponto ainda</text>'; return; }
    const lat0 = pts[0][0]; const k = Math.cos(lat0 * Math.PI / 180);
    const xy = pts.map((p) => [p[1] * k, -p[0]]);
    const xs = xy.map((p) => p[0]); const ys = xy.map((p) => p[1]);
    const minx = Math.min(...xs); const maxx = Math.max(...xs); const miny = Math.min(...ys); const maxy = Math.max(...ys);
    const sc = Math.min(260 / Math.max(maxx - minx, 1e-9), 150 / Math.max(maxy - miny, 1e-9));
    const P = xy.map((p) => [20 + (p[0] - minx) * sc, 15 + (p[1] - miny) * sc]);
    const pp = P.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ');
    svg.innerHTML = (rec.tracado.tipo === 'area' && P.length >= 3 ? `<polygon points="${pp}" fill="rgba(0,97,92,.18)" stroke="#00615C" stroke-width="2.5"/>` : `<polyline points="${pp}" fill="none" stroke="#00615C" stroke-width="3"/>`)
      + P.map((p, i) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${i === P.length - 1 ? 5 : 3.5}" fill="${i === P.length - 1 ? '#F5C400' : '#00615C'}" stroke="#fff"/>`).join('');
  }

  function passoCk(rec, d) {
    const its = d.its; const secs = [];
    its.forEach((it) => { let s = secs.find((x) => x.n === it.sec); if (!s) { s = { n: it.sec, its: [] }; secs.push(s); } s.its.push(it); });
    const resp = Object.keys(rec.resp).length;
    return `<h2>Checklist legal</h2>
      <p class="peq">${resp} de ${its.length} respondidos · <b style="color:var(--nc)">${d.n.NC} NC</b> · <b style="color:var(--om)">${d.n.OM} OM</b>${d.n.NV ? ` · ${d.n.NV} NV` : ''}</p>
      <p class="mut peq">Responda todos: C conforme · NC não conforme · OM oportunidade de melhoria · NA não se aplica · NV não verificado. Itens com “Automático” vieram das suas medições – confira e mude se necessário.</p>
      ${secs.map((s) => {
        const rr = s.its.filter((it) => rec.resp[it.id]).length; const nc = s.its.filter((it) => rec.resp[it.id] && rec.resp[it.id].r === 'NC').length;
        const aberta = rr < s.its.length;
        return `<details class="sec" ${aberta ? 'open' : ''}><summary>${esc(s.n)}<span class="prog ${rr === s.its.length ? 'ok' : ''}">${rr}/${s.its.length}${nc ? ` · ${nc} NC` : ''}</span></summary><div class="corpo">
          ${s.its.map((it) => itemHTML(rec, it)).join('')}
          ${rr < s.its.length ? `<button class="bt bloco" style="margin-top:10px" data-a="secC" data-sec="${esc(s.n)}">Marcar os ${s.its.length - rr} pendentes desta seção como C</button>` : ''}</div></details>`;
      }).join('')}`;
  }
  function itemHTML(rec, it) {
    const x = rec.resp[it.id]; const ai = rec.autoInfo && rec.autoInfo[it.id];
    let aut = '';
    if (ai) {
      if (ai.r) aut = x && x.origem === 'manual' && x.r !== ai.r ? `<div class="auto dica"><b>Automático sugere ${ai.r}:</b> ${esc(ai.txt)} (você marcou ${x.r})</div>` : `<div class="auto ${ai.r}"><b>Automático ${ai.r}:</b> ${esc(ai.txt)}</div>`;
      else aut = `<div class="auto dica"><b>Atenção:</b> ${esc(ai.txt)}</div>`;
    }
    return `<div class="item" id="it_${it.id}"><div class="cab"><span>${esc(it.id)}</span><span class="sevb ${esc(it.sev)}">${esc(it.sev)}</span></div>
      <div class="q">${esc(it.q)}</div>${aut}
      <div class="res">${['C', 'NC', 'OM', 'NA', 'NV'].map((r) => `<button class="${r} ${x && x.r === r ? 'on' : ''}" data-a="resp" data-item="${it.id}" data-v="${r}">${r}</button>`).join('')}</div>
      <details><summary>Critério e base legal</summary><p><b>Critério:</b> ${esc(it.crit)}</p><p><b>Base:</b> ${esc(it.ref)}</p><p><b>Se NC:</b> ${esc(it.acao)} (${esc(it.resp)})</p>${it.gateTxt ? `<p class="mut">Aplica-se se: ${esc(it.gateTxt)}</p>` : ''}</details></div>`;
  }

  function passoNc(rec, d) {
    if (!d.ncs.length) return `<h2>Não conformidades</h2><div class="vazio-tela"><p>Nenhuma não conformidade ou melhoria marcada no checklist.</p></div>`;
    return `<h2>Não conformidades e melhorias</h2><p class="mut peq">${d.ncs.length} registro(s). Toda NC precisa de G, U, T, descrição e foto de contexto. Os valores de G, U e T vêm sugeridos pela severidade do item – ajuste ao que você viu.</p>
      ${d.ncs.map((x) => {
        const it = x.it;
        return `<div class="cartao nc ${x.crit}" id="nc_${x.id}"><div class="linha-bts" style="align-items:center"><b style="flex:1">${esc(x.id)} · ${x.r === 'NC' ? 'Não conformidade' : 'Oportunidade de melhoria'}</b><span class="critb ${x.crit}">${esc(x.crit)}${x.r === 'NC' && x.g && x.u && x.t ? ` · GUT ${x.g * x.u * x.t}` : ''}</span></div>
          <p style="font-weight:600">${esc(it.q)}</p>
          ${x.r === 'NC' ? `<div class="gut">${[['g', 'Gravidade'], ['u', 'Urgência'], ['t', 'Tendência']].map(([k, l]) => `<span class="peq"><b>${l}</b></span><div class="seg">${[1, 2, 3, 4, 5].map((n) => `<button class="${Number(x[k]) === n ? 'on' : ''}" data-a="gut" data-item="${x.id}" data-k="${k}" data-v="${n}">${n}</button>`).join('')}</div>`).join('')}</div>
            ${x.gutSug ? '<p class="peq" style="color:var(--nv);font-weight:700">Valores sugeridos – toque para confirmar ou ajustar.</p>' : ''}` : ''}
          ${x.crit === 'Crítica' ? '<div class="cartao erro peq"><b>Crítica:</b> afaste-se, sinalize e ligue agora para o coordenador e o dono da área.</div>' : ''}
          <div class="campo"><label for="d_${x.id}">Descrição (o quê, onde, quanto) <span class="req">*</span></label><textarea class="inp" id="d_${x.id}" data-f="nc:${x.id}:desc">${esc(x.desc || '')}</textarea></div>
          <div class="campo"><label for="q_${x.id}">Quantidade ou extensão afetada</label><input class="inp" id="q_${x.id}" data-f="nc:${x.id}:qtd" value="${esc(x.qtd || '')}" placeholder="ex.: 3 extintores; 12 m de calçada"></div>
          <div class="fotos">${slotFoto('1 Contexto', { tipo: 'N1', itemId: x.id, unico: true }, x.r === 'NC')}${slotFoto('2 Aproximação', { tipo: 'N2', itemId: x.id, unico: true })}${slotFoto('3 Detalhe', { tipo: 'N3', itemId: x.id, unico: true })}</div>
          ${x.r === 'NC' ? `<div class="campo" style="margin-top:12px"><span class="rot">Houve contenção imediata?${x.crit === 'Crítica' ? ' <span class="req">*</span>' : ''}</span><div class="seg"><button class="${x.cont === 'S' ? 'on' : ''}" data-a="ncSet" data-item="${x.id}" data-k="cont" data-v="S">Sim</button><button class="${x.cont === 'N' ? 'on' : ''}" data-a="ncSet" data-item="${x.id}" data-k="cont" data-v="N">Não</button></div></div>
            ${x.cont === 'S' ? `<div class="campo"><label for="cd_${x.id}">Qual contenção?</label><input class="inp" id="cd_${x.id}" data-f="nc:${x.id}:contDesc" value="${esc(x.contDesc || '')}"></div>` : ''}` : ''}
          <div class="campo"><label for="ac_${x.id}">Sugestão de ação (opcional)</label><input class="inp" id="ac_${x.id}" data-f="nc:${x.id}:acaoCampo" value="${esc(x.acaoCampo || '')}"></div>
          <dl class="kv"><dt>Ação-padrão</dt><dd>${esc(it.acao)}</dd><dt>Responsável</dt><dd>${esc(it.resp)}</dd><dt>Prazo</dt><dd>${x.prazo} dias · até ${brData(x.lim)}</dd><dt>Base</dt><dd>${esc(it.ref)}</dd></dl></div>`;
      }).join('')}`;
  }

  function passoFot() {
    const extras = st.fotos.filter((f) => ['X', 'G', 'D', 'P', 'E'].includes(f.tipo));
    const tipos = [['X', 'Identificação/placa'], ['G', 'Geral/contexto'], ['D', 'Detalhe'], ['P', 'Panorâmica'], ['E', 'Com escala']];
    return `<h2>Fotos adicionais</h2><p class="mut peq">Placa ou identificação, contexto, detalhes relevantes. As fotos de NC ficam no passo anterior.</p>
      ${extras.map((f) => `<div class="cartao"><div class="fotos"><div class="foto">${urlFoto(f) ? `<img src="${urlFoto(f)}" alt="">` : `<img data-path="${esc(f.path || '')}" alt="Foto no servidor">`}<button class="x" data-a="fotoDel" data-id="${f.id}" aria-label="Apagar">×</button></div>
        <div style="grid-column:span 2"><select class="inp" data-f="foto:${f.id}:tipo">${tipos.map(([c, l]) => `<option value="${c}" ${f.tipo === c ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input class="inp" style="margin-top:6px" placeholder="Legenda" data-f="foto:${f.id}:legenda" value="${esc(f.legenda || '')}"></div></div></div>`).join('')}
      <div class="linha-bts"><button class="bt pri" data-a="foto" data-slot="${esc(JSON.stringify({ tipo: 'G' }))}">Câmera</button><button class="bt" data-a="fotoGal" data-slot="${esc(JSON.stringify({ tipo: 'G' }))}">Galeria</button></div>`;
  }

  function barrasTema(tem) {
    const L = Object.entries(tem).filter(([, o]) => o.cf + o.nc > 0).map(([t, o]) => ({ t, v: o.cf / (o.cf + o.nc) })).sort((a, b) => a.v - b.v);
    if (!L.length) return '<p class="mut peq">Sem itens avaliados.</p>';
    return L.map((x) => `<div class="barra"><span>${esc(TEMA[x.t] || x.t)}</span><span class="tr"><i style="width:${(x.v * 100).toFixed(0)}%;background:${COR_HEX(x.v)}"></i></span><span class="v">${pct(x.v)}</span></div>`).join('');
  }
  function passoFim(rec, d, pend) {
    const refs = [...new Set(d.ncs.map((x) => x.it.ref))];
    return `<h2>Diagnóstico automático</h2>
      <div class="cartao"><div class="indice"><b style="color:${corIdx(d.indice)}">${pct(d.indice)}</b><span class="mut">índice de conformidade<br>(C + OM) ÷ (C + OM + NC)</span></div>
        <div class="cont">${['C', 'NC', 'OM', 'NA', 'NV'].map((k) => `<div><b style="color:var(--${k.toLowerCase()})">${d.n[k]}</b><span>${k}</span></div>`).join('')}</div>
        ${d.faltam.length ? `<p class="peq" style="color:var(--nc);font-weight:700;margin-top:8px">${d.faltam.length} item(ns) sem resposta</p>` : ''}</div>
      ${d.alertas.length ? `<div class="cartao aviso"><b>Alertas de cruzamento</b><ul class="limpa">${d.alertas.map((a) => `<li class="peq" style="margin-top:6px"><b>${a.c}</b> ${esc(a.t)}</li>`).join('')}</ul></div>` : ''}
      <h3>Índice por tema</h3><div class="cartao">${barrasTema(d.tem)}</div>
      <h3>Plano de ação gerado (${d.ncs.length})</h3>
      ${d.ncs.length ? d.ncs.map((x) => `<div class="cartao nc ${x.crit}"><div class="linha-bts" style="align-items:center"><b style="flex:1">${esc(x.id)}</b><span class="critb ${x.crit}">${esc(x.crit)}</span></div>
        <p class="peq" style="margin:4px 0"><b>${esc(x.it.acao)}</b></p><p class="mut peq" style="margin:0">${esc(x.it.resp)} · até ${brData(x.lim)}</p></div>`).join('') : '<p class="mut">Nenhuma ação: ativo sem não conformidades.</p>'}
      ${refs.length ? `<details class="cartao"><summary><b>Base legal das não conformidades</b></summary><ul>${refs.map((r) => `<li class="peq">${esc(r)}</li>`).join('')}</ul></details>` : ''}
      <h3>Fechamento</h3>
      <div class="campo"><span class="rot">Inspeção</span><div class="seg"><button class="${rec.statusInspecao === 'COM' ? 'on' : ''}" data-a="setReg" data-k="statusInspecao" data-v="COM">Completa</button><button class="${rec.statusInspecao === 'PAR' ? 'on' : ''}" data-a="setReg" data-k="statusInspecao" data-v="PAR">Parcial</button></div></div>
      ${rec.statusInspecao === 'PAR' ? `<div class="campo"><label for="fMp">Motivo da inspeção parcial <span class="req">*</span></label><input class="inp" id="fMp" data-f="reg:motivoParcial" value="${esc(rec.motivoParcial)}"></div>` : ''}
      ${d.n.NV ? `<div class="campo"><label for="fNv">Por que há itens não verificados? <span class="req">*</span></label><input class="inp" id="fNv" data-f="reg:nvMotivo" value="${esc(rec.nvMotivo)}"></div>` : ''}
      <div class="campo"><label for="fObs">Observações</label><textarea class="inp" id="fObs" data-f="reg:obs">${esc(rec.obs)}</textarea></div>
      ${pend.B.length ? `<div class="cartao erro"><b>Falta para finalizar (${pend.B.length})</b><ul class="limpa pend">${pend.B.map((x) => `<li class="peq">${esc(x.txt)} <button class="lnk" data-a="passo" data-p="${x.passo}">ir</button></li>`).join('')}</ul></div>` : '<div class="cartao" style="border-color:var(--c)"><b style="color:var(--c)">Tudo preenchido.</b></div>'}
      ${pend.W.length ? `<div class="cartao aviso"><b>Atenção</b><ul class="limpa pend">${pend.W.map((x) => `<li class="peq">${esc(x.txt)} <button class="lnk" data-a="passo" data-p="${x.passo}">ir</button></li>`).join('')}</ul></div>` : ''}
      <p class="mut peq">Situação: ${{ rascunho: 'rascunho (só neste aparelho)', pronto: 'pronto para enviar', sincronizado: 'enviado ao servidor', erro: 'erro no envio: ' + esc(rec.erro) }[rec.status] || rec.status}</p>
      <button class="lnk" data-a="excluir" style="color:var(--nc)">Excluir este levantamento</button>`;
  }

  /* ------------------------------------------------------------ tela: mapa */
  const MP = { view: null, W: 0, H: 0, tiles: new Map(), pts: [], ptrs: new Map(), pinch: null, moved: 0, down: null };
  function telaMapa() {
    return `${topo('Mapa', '')}<div class="mapa" id="mapa"><div class="tiles" id="mTiles"></div><svg id="mVec"></svg>
      <div class="leg"><span class="dot" style="background:#1E7B47"></span> ≥ 90% <span class="dot" style="background:#D9A400"></span> 70–90% <span class="dot" style="background:#E0601C"></span> 50–70% <span class="dot" style="background:#B71C1C"></span> &lt; 50% <span class="dot" style="background:#2B67B1"></span> você</div>
      <div class="ctl"><button data-a="mZoom" data-v="1" aria-label="Aproximar">+</button><button data-a="mZoom" data-v="-1" aria-label="Afastar">−</button><button data-a="mEu" aria-label="Minha posição">◎</button><button data-a="mTudo" aria-label="Enquadrar todos">⤢</button></div>
      <div id="mFicha"></div></div>${nav('mapa')}`;
  }
  const proj = (lat, lon, z) => { const s = 256 * 2 ** z; const si = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180); return { x: (lon + 180) / 360 * s, y: (0.5 - Math.log((1 + si) / (1 - si)) / (4 * Math.PI)) * s }; };
  const desproj = (x, y, z) => { const s = 256 * 2 ** z; const n = Math.PI - 2 * Math.PI * y / s; return { lat: 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lon: x / s * 360 - 180 }; };
  async function montarMapa() {
    const el = $('#mapa'); if (!el) return;
    const regs = await todosRegistros();
    MP.pts = regs.filter((r) => r.gps && isFinite(r.gps.lat)).map((r) => ({ id: r.id, lat: r.gps.lat, lon: r.gps.lon, cod: r.codigo, esc: r.escopo, nome: r.nome, idx: r.resumo ? r.resumo.indice : null, nNC: r.resumo ? r.resumo.nNC : 0, srv: r.status === 'servidor', tr: r.tracado }));
    if (!MP.view) {
      const v = await metaGet('mapaView', null);
      MP.view = v || (MP.pts.length ? { lat: MP.pts[0].lat, lon: MP.pts[0].lon, z: 16 } : { lat: -2.5655, lon: -44.365, z: 13 });
    }
    MP.tiles = new Map();
    const r = el.getBoundingClientRect(); MP.W = r.width; MP.H = r.height;
    el.addEventListener('pointerdown', mDown); el.addEventListener('pointermove', mMove); el.addEventListener('pointerup', mUp); el.addEventListener('pointercancel', mUp);
    el.addEventListener('wheel', (e) => { e.preventDefault(); const b = el.getBoundingClientRect(); mZoomEm(MP.view.z - e.deltaY * 0.002, e.clientX - b.left, e.clientY - b.top); }, { passive: false });
    gpsLigar();
    mDesenhar();
  }
  let mRaf = 0;
  function mDesenhar() { if (!mRaf) mRaf = requestAnimationFrame(() => { mRaf = 0; mTiles(); mVetor(); }); }
  function mTela(lat, lon) { const c = proj(MP.view.lat, MP.view.lon, MP.view.z); const p = proj(lat, lon, MP.view.z); return [p.x - c.x + MP.W / 2, p.y - c.y + MP.H / 2]; }
  function mTiles() {
    const box = $('#mTiles'); if (!box) return;
    const z = Math.max(1, Math.min(19, Math.round(MP.view.z))); const s = 2 ** (MP.view.z - z);
    const c = proj(MP.view.lat, MP.view.lon, z); const x0 = c.x - MP.W / 2 / s; const y0 = c.y - MP.H / 2 / s; const n = 2 ** z; const need = new Set();
    for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y0 + MP.H / s) / 256); ty++) {
      if (ty < 0 || ty >= n) continue;
      for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x0 + MP.W / s) / 256); tx++) {
        const wx = ((tx % n) + n) % n; const k = `${z}/${tx}/${ty}`; need.add(k);
        let im = MP.tiles.get(k);
        if (!im) { im = new Image(); im.alt = ''; im.onerror = () => { im.style.visibility = 'hidden'; }; im.src = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${ty}/${wx}`; MP.tiles.set(k, im); box.appendChild(im); }
        im.style.transform = `translate(${(tx * 256 - x0) * s}px,${(ty * 256 - y0) * s}px) scale(${s})`;
      }
    }
    for (const [k, im] of MP.tiles) if (!need.has(k)) { im.remove(); MP.tiles.delete(k); }
  }
  function mVetor() {
    const svg = $('#mVec'); if (!svg) return;
    const out = [];
    for (const p of MP.pts) {
      if (p.tr && p.tr.pts && p.tr.pts.length >= 2) {
        const pp = p.tr.pts.map((q) => mTela(q[0], q[1]).map((v) => v.toFixed(1)).join(',')).join(' ');
        out.push(p.tr.tipo === 'area' ? `<polygon points="${pp}" fill="${COR_HEX(p.idx)}" fill-opacity=".25" stroke="${COR_HEX(p.idx)}" stroke-width="2"/>` : `<polyline points="${pp}" fill="none" stroke="${COR_HEX(p.idx)}" stroke-width="4" stroke-linecap="round"/>`);
      }
    }
    const big = MP.view.z >= 17;
    for (const p of MP.pts) {
      const [x, y] = mTela(p.lat, p.lon); if (x < -30 || y < -30 || x > MP.W + 30 || y > MP.H + 30) continue;
      out.push(`<circle data-id="${p.id}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${big ? 11 : 7}" fill="${COR_HEX(p.idx)}" stroke="${p.srv ? '#fff' : '#F5C400'}" stroke-width="2.5"/>`);
      if (big) out.push(`<text x="${(x + 14).toFixed(1)}" y="${(y + 4).toFixed(1)}" font-size="12" font-weight="700" fill="#fff" stroke="#14201C" stroke-width="3" paint-order="stroke">${esc(p.cod)}</text>`);
    }
    if (st.gps) {
      const [x, y] = mTela(st.gps.lat, st.gps.lon); const mpp = 156543.03392 * Math.cos(st.gps.lat * Math.PI / 180) / 2 ** MP.view.z;
      out.push(`<circle cx="${x}" cy="${y}" r="${Math.max(8, st.gps.acc / mpp)}" fill="rgba(43,103,177,.15)" stroke="rgba(43,103,177,.5)"/><circle cx="${x}" cy="${y}" r="7" fill="#2B67B1" stroke="#fff" stroke-width="3"/>`);
    }
    svg.innerHTML = out.join('');
  }
  gpsOuvintes.add(() => { if (rota().tela === 'mapa') mDesenhar(); });
  function mPan(dx, dy) { const c = proj(MP.view.lat, MP.view.lon, MP.view.z); const u = desproj(c.x - dx, c.y - dy, MP.view.z); MP.view.lat = u.lat; MP.view.lon = u.lon; mDesenhar(); }
  function mZoomEm(z, sx, sy) {
    z = Math.max(4, Math.min(20, z));
    const c = proj(MP.view.lat, MP.view.lon, MP.view.z); const g = desproj(c.x + sx - MP.W / 2, c.y + sy - MP.H / 2, MP.view.z);
    MP.view.z = z; const p = proj(g.lat, g.lon, z); const u = desproj(p.x - (sx - MP.W / 2), p.y - (sy - MP.H / 2), z);
    MP.view.lat = u.lat; MP.view.lon = u.lon; mDesenhar(); salvarVista();
  }
  const salvarVista = debounce(() => metaSet('mapaView', MP.view), 800);
  function mDown(e) {
    if (e.target.closest('.ctl,.ficha,.leg')) return;
    e.currentTarget.setPointerCapture(e.pointerId); MP.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); MP.moved = 0; MP.down = e.target;
    if (MP.ptrs.size === 2) { const [a, b] = [...MP.ptrs.values()]; MP.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: MP.view.z }; }
  }
  function mMove(e) {
    const p = MP.ptrs.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x; const dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
    if (MP.ptrs.size === 1) { MP.moved += Math.abs(dx) + Math.abs(dy); mPan(dx, dy); }
    else if (MP.pinch) { const [a, b] = [...MP.ptrs.values()]; const bx = $('#mapa').getBoundingClientRect(); mZoomEm(MP.pinch.z + Math.log2(Math.hypot(a.x - b.x, a.y - b.y) / MP.pinch.d), (a.x + b.x) / 2 - bx.left, (a.y + b.y) / 2 - bx.top); MP.moved += 10; }
  }
  function mUp(e) {
    if (!MP.ptrs.has(e.pointerId)) return; MP.ptrs.delete(e.pointerId); if (MP.ptrs.size < 2) MP.pinch = null;
    if (e.type === 'pointerup' && MP.moved < 6 && !MP.ptrs.size) {
      const t = MP.down && MP.down.closest && MP.down.closest('[data-id]');
      if (t) mostrarFicha(t.getAttribute('data-id')); else $('#mFicha').innerHTML = '';
    }
    salvarVista();
  }
  function mostrarFicha(id) {
    const p = MP.pts.find((x) => x.id === id); if (!p) return;
    $('#mFicha').innerHTML = `<div class="ficha"><div class="linha-bts" style="align-items:center"><span class="mini" style="background:var(--tag);font-weight:800;border-radius:6px;padding:4px 6px">${esc(p.cod)}</span><b style="flex:1;margin-left:8px">${esc(p.nome || '')}</b><span style="font-weight:800;color:${corIdx(p.idx)}">${pct(p.idx)}</span></div>
      <p class="peq mut">${esc(ESC[p.esc] ? ESC[p.esc].curto : '')} · ${p.nNC || 0} NC${p.srv ? ' · levantado por outra equipe' : ''}</p><button class="bt pri bloco" data-a="abrir" data-id="${p.id}" data-srv="${p.srv ? 1 : ''}">Abrir levantamento</button></div>`;
  }

  /* ------------------------------------------------------------ tela: painel */
  async function telaPainel() {
    const fonte = st.painelFonte;
    let corpo = '';
    if (fonte === 'servidor' && st.online) {
      if (!st.painel) { carregarPainel(); corpo = '<p class="mut">Carregando o diagnóstico da equipe…</p>'; }
      else if (st.painel.erro) corpo = `<div class="cartao erro">${esc(st.painel.erro)}</div>`;
      else corpo = painelServidor(st.painel);
    } else {
      corpo = painelLocal(await todosRegistros());
      if (fonte === 'servidor') corpo = '<div class="cartao aviso peq">Sem internet: mostrando os dados guardados neste aparelho.</div>' + corpo;
    }
    return `${topo('Painel', '')}<main class="com-nav">
      <div class="chips" style="margin-bottom:12px"><button class="${fonte === 'servidor' ? 'on' : ''}" data-a="pFonte" data-v="servidor">Equipe (servidor)</button><button class="${fonte === 'local' ? 'on' : ''}" data-a="pFonte" data-v="local">Este aparelho</button><button data-a="pRec">Atualizar</button></div>
      ${corpo}
      <h3>Exportar</h3>
      <div class="cartao"><p class="peq">Planilha no mesmo formato do kit (abas principal, nc, telhado e fotos): cole no Retrato do Site (PD-SLZ_10), carregue no WebGIS (PD-SLZ_11) ou rode o script do QGIS.</p>
        <button class="bt pri bloco" data-a="xlsx">Baixar planilha (XLSX)</button></div>
    </main>${nav('painel')}`;
  }
  async function carregarPainel() {
    try {
      const q = (v, s = 'select=*') => SB.select(v, s);
      const [res, tema, bloco, alertas, criticas, prog] = await Promise.all([q('pd_vw_resumo'), q('pd_vw_indice_tema', 'select=*&order=indice.asc.nullslast'), q('pd_vw_indice_bloco', 'select=*&order=bloco'),
        q('pd_vw_alertas_resumo', 'select=*&order=regra'), q('pd_vw_plano_acao', 'select=id_acao,codigo_ativo,item_id,pergunta,o_que,quem,quando,situacao,bloco&criticidade=eq.Crítica&status=in.(Aberta,"Em tratamento")&order=quando'),
        q('pd_vw_progresso', `select=*&data_levantamento=eq.${hoje()}`)]);
      st.painel = { res: res[0] || {}, tema, bloco, alertas, criticas, prog, em: new Date().toISOString() };
    } catch (e) { st.painel = { erro: e.message }; }
    if (rota().tela === 'painel') render();
  }
  function painelServidor(p) {
    const r = p.res;
    const porEq = {}; p.prog.forEach((x) => { porEq[x.equipe || '—'] = (porEq[x.equipe || '—'] || 0) + Number(x.ativos); });
    return `<div class="kpis"><div class="kpi"><b>${r.ativos || 0}</b><span>ativos levantados</span></div><div class="kpi"><b style="color:${corIdx(r.indice)}">${pct(r.indice == null ? null : Number(r.indice))}</b><span>índice geral</span></div>
      <div class="kpi"><b>${r.n_nc || 0}</b><span>não conformidades</span></div><div class="kpi cr"><b>${r.n_criticas || 0}</b><span>críticas</span></div></div>
      <p class="mut peq">Hoje: ${Object.entries(porEq).map(([e, n]) => `equipe ${esc(e)} ${n}`).join(' · ') || 'nenhum ativo enviado'} · atualizado ${brHora(p.em)}</p>
      <h3>Índice por tema</h3><div class="cartao">${p.tema.filter((t) => t.indice != null).map((t) => `<div class="barra"><span>${esc(t.nome)}</span><span class="tr"><i style="width:${(Number(t.indice) * 100).toFixed(0)}%;background:${COR_HEX(Number(t.indice))}"></i></span><span class="v">${pct(Number(t.indice))}</span></div>`).join('') || '<p class="mut peq">Sem dados.</p>'}</div>
      <h3>Críticas em aberto (${p.criticas.length})</h3>${p.criticas.length ? p.criticas.slice(0, 30).map((c) => `<div class="cartao nc Crítica"><b>${esc(c.codigo_ativo)} · ${esc(c.item_id)}</b><p class="peq" style="margin:4px 0">${esc(c.o_que)}</p><p class="mut peq" style="margin:0">${esc(c.quem)} · até ${brData(c.quando)} · ${esc(c.situacao)}</p></div>`).join('') : '<p class="mut">Nenhuma crítica em aberto.</p>'}
      <h3>Cruzamentos</h3><div class="cartao">${p.alertas.length ? `<table class="tb"><tr><th>Regra</th><th>Alerta</th><th class="n">Ativos</th></tr>${p.alertas.map((a) => `<tr><td>${esc(a.regra)}</td><td>${esc(a.alerta)}</td><td class="n">${a.ativos}</td></tr>`).join('')}</table>` : '<p class="mut peq">Nenhum alerta.</p>'}</div>
      <h3>Por bloco</h3><div class="cartao"><table class="tb"><tr><th>Bloco</th><th class="n">Ativos</th><th class="n">Índice</th><th class="n">NC</th><th class="n">Críticas</th></tr>${p.bloco.map((b) => `<tr><td>${esc(b.bloco)}</td><td class="n">${b.ativos}</td><td class="n" style="color:${corIdx(Number(b.indice))};font-weight:700">${pct(b.indice == null ? null : Number(b.indice))}</td><td class="n">${b.n_nc}</td><td class="n">${b.n_criticas}</td></tr>`).join('')}</table></div>`;
  }
  function painelLocal(regs) {
    const vale = regs.filter((r) => r.resumo);
    const n = { C: 0, NC: 0, OM: 0 }; const tem = {}; let cr = 0;
    for (const r of vale) {
      const d = diagnostico(r); n.C += d.n.C; n.NC += d.n.NC; n.OM += d.n.OM; cr += d.ncs.filter((x) => x.crit === 'Crítica').length;
      Object.entries(d.tem).forEach(([t, o]) => { const x = tem[t] || (tem[t] = { cf: 0, nc: 0 }); x.cf += o.cf; x.nc += o.nc; });
    }
    const den = n.C + n.OM + n.NC;
    return `<div class="kpis"><div class="kpi"><b>${vale.length}</b><span>ativos</span></div><div class="kpi"><b style="color:${corIdx(den ? (n.C + n.OM) / den : null)}">${pct(den ? (n.C + n.OM) / den : null)}</b><span>índice geral</span></div>
      <div class="kpi"><b>${n.NC}</b><span>não conformidades</span></div><div class="kpi cr"><b>${cr}</b><span>críticas</span></div></div>
      <h3>Índice por tema</h3><div class="cartao">${barrasTema(tem)}</div>`;
  }

  /* ------------------------------------------------------------ tela: ajustes e ajuda */
  async function telaAjustes() {
    let est = '';
    try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); est = `${fmt((e.usage || 0) / 1048576, 0)} MB usados de ${fmt((e.quota || 0) / 1048576, 0)} MB disponíveis`; } } catch (e) { /* sem estimativa */ }
    const a = st.aj;
    return `${topo('Ajustes', '')}<main class="com-nav">
      <h3>Você</h3><div class="cartao">
        <div class="campo"><label for="ajN">Nome do inspetor</label><input class="inp" id="ajN" data-f="aj:nome" value="${esc(a.nome)}"></div>
        <div class="campo"><label for="ajE">Letra da equipe (uma por aparelho)</label><input class="inp" id="ajE" data-f="aj:equipe" value="${esc(a.equipe)}" maxlength="1" autocapitalize="characters" placeholder="A"></div>
        <div class="campo"><label for="ajB">Bloco em que vai trabalhar</label><input class="inp" id="ajB" data-f="aj:bloco" value="${esc(a.bloco)}" maxlength="3" autocapitalize="characters" placeholder="B01"></div>
        <p class="mut peq">Usuário: ${esc(SB.sessao.user.email || '')}${st.perfil ? ` · perfil ${esc(PAPEL[st.perfil.papel] || st.perfil.papel)}` : ''}</p></div>
      ${st.perfil && st.perfil.papel === 'coordenador' ? '<h3>Coordenação</h3><div class="cartao"><p class="peq">Libere os usuários novos e defina papel e letra de equipe de cada um.</p><button class="bt bloco" data-a="ir" data-h="equipe">Gerenciar equipe</button></div>' : ''}
      <h3>Fotos</h3><div class="cartao">
        <div class="campo"><span class="rot">Tamanho máximo</span><div class="seg">${[[1280, '1280 px'], [1600, '1600 px'], [2048, '2048 px']].map(([v, l]) => `<button class="${Number(a.fotoMax) === v ? 'on' : ''}" data-a="ajSet" data-k="fotoMax" data-v="${v}">${l}</button>`).join('')}</div><div class="dica">1600 px fica entre 250 e 450 KB por foto.</div></div>
        <div class="campo"><span class="rot">Carimbar código, data e coordenadas na foto</span><div class="seg"><button class="${a.carimbo ? 'on' : ''}" data-a="ajSet" data-k="carimbo" data-v="1">Sim</button><button class="${!a.carimbo ? 'on' : ''}" data-a="ajSet" data-k="carimbo" data-v="0">Não</button></div></div></div>
      <h3>Aparência</h3><div class="cartao"><div class="seg">${[['auto', 'Automática'], ['light', 'Clara (sol)'], ['dark', 'Escura']].map(([v, l]) => `<button class="${a.tema === v ? 'on' : ''}" data-a="ajSet" data-k="tema" data-v="${v}">${l}</button>`).join('')}</div></div>
      <h3>Equipe</h3><div class="cartao"><p class="peq">Envie este link para os auxiliares: ele configura o banco no aparelho deles (cada um entra com o próprio usuário).</p>
        <button class="bt bloco" data-a="link">Copiar link de configuração</button></div>
      <h3>Dados deste aparelho</h3><div class="cartao"><p class="peq">${est}</p>
        <div class="linha-bts"><button class="bt" data-a="backup">Baixar cópia de segurança</button><button class="bt" data-a="restaurar">Restaurar cópia</button></div>
        <button class="bt bloco" style="margin-top:8px" data-a="liberar">Liberar espaço (fotos já enviadas)</button></div>
      <h3>Conexão</h3><div class="cartao"><p class="peq">${esc(SB.url)}</p><div class="linha-bts"><button class="bt" data-a="cfgTrocar">Alterar conexão</button><button class="bt alerta" data-a="sair">Sair</button></div></div>
      <p class="mut peq">PD Campo ${VERSAO} · catálogo ${esc(CAT.versao)} (${CAT.itens.length} itens, ${CAT.escopos.length} escopos) · <button class="lnk" data-a="ir" data-h="ajuda">Como usar</button></p>
    </main>${nav('ajustes')}`;
  }
  function telaAjuda() {
    return `${topo('Como usar', 'inicio')}<main>
      <div class="cartao"><h2>No campo</h2><ol class="peq">
        <li>Toque em <b>Novo levantamento</b>, escolha o escopo, o bloco e use <b>Sugerir</b> para o código.</li>
        <li>No ponto de referência, espere a precisão do GPS chegar a ${PARAM.gps_meta_m} m e toque em <b>Fixar ponto aqui</b>. Tire a foto principal e dê a condição.</li>
        <li>Preencha o cadastro: as medições (larguras, inclinações, vagas, contagens, documentos) marcam itens do checklist automaticamente, com a norma citada.</li>
        <li>Responda todo o checklist (C, NC, OM, NA, NV). Abra “Critério e base legal” em caso de dúvida.</li>
        <li>Em cada NC: confirme G, U e T, descreva o quê/onde/quanto e tire as 3 fotos (contexto, aproximação, detalhe com escala).</li>
        <li>No diagnóstico, confira o índice, os alertas e o plano de ação gerado e toque em <b>Finalizar</b>.</li>
        <li>Ativos parecidos em sequência (postes, bocas de lobo, placas): use <b>Outro ativo de …</b> no início – o cadastro é copiado e você só ajusta o que muda.</li></ol></div>
      <div class="cartao"><h2>Sem internet</h2><p class="peq">Tudo fica guardado no aparelho. Quando houver rede, o app envia sozinho (ou toque no indicador no alto da tela). Não desinstale o app nem limpe os dados do navegador com levantamentos a enviar.</p></div>
      <div class="cartao"><h2>Criticidade</h2><p class="peq">GUT = Gravidade × Urgência × Tendência (1 a 5). Crítica: G = 5 ou GUT ≥ 80 (contenção no mesmo dia, prazo ${PARAM.prazo_critica} dias). Alta: 40–79 (${PARAM.prazo_alta} dias). Média: 15–39 (${PARAM.prazo_media} dias). Baixa: &lt; 15 (${PARAM.prazo_baixa} dias). Melhoria: ${PARAM.prazo_melhoria} dias.</p></div>
      <div class="cartao"><h2>Segurança</h2><p class="peq">Nunca suba em telhados, nem pise em fibrocimento, abra quadros elétricos ou tampas, entre em área operacional sem o dono ou meça na via sem um colega observando o tráfego. Fotos de portarias e sistemas de segurança só com autorização.</p></div>
    </main>`;
  }

  /* ------------------------------------------------------------ exportação XLSX (formato do kit) */
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (u8) => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function zip(arquivos) {
    const te = new TextEncoder(); const partes = []; const central = []; let off = 0;
    for (const [nome, txt] of arquivos) {
      const nm = te.encode(nome); const dados = te.encode(txt); const crc = crc32(dados);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true); lh.setUint32(14, crc, true); lh.setUint32(18, dados.length, true); lh.setUint32(22, dados.length, true); lh.setUint16(26, nm.length, true);
      partes.push(lh.buffer, nm, dados);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint32(16, crc, true); ch.setUint32(20, dados.length, true); ch.setUint32(24, dados.length, true); ch.setUint16(28, nm.length, true); ch.setUint32(42, off, true);
      central.push(ch.buffer, nm);
      off += 30 + nm.length + dados.length;
    }
    const tamC = central.reduce((s, p) => s + (p.byteLength || p.length), 0);
    const fim = new DataView(new ArrayBuffer(22));
    fim.setUint32(0, 0x06054b50, true); fim.setUint16(8, arquivos.length, true); fim.setUint16(10, arquivos.length, true); fim.setUint32(12, tamC, true); fim.setUint32(16, off, true);
    return new Blob([...partes, ...central, fim.buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  const colL = (i) => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  function planilha(abas) {
    const arq = [];
    arq.push(['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${abas.map((a, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`]);
    arq.push(['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>']);
    arq.push(['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${abas.map((a, i) => `<sheet name="${xmlEsc(a.nome.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`]);
    arq.push(['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${abas.map((a, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`]);
    abas.forEach((a, i) => {
      const linhas = a.linhas.map((ln, r) => `<row r="${r + 1}">${ln.map((v, c) => {
        if (v === null || v === undefined || v === '') return '';
        const ref = colL(c) + (r + 1);
        return typeof v === 'number' && isFinite(v) ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
      }).join('')}</row>`).join('');
      arq.push([`xl/worksheets/sheet${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${linhas}</sheetData></worksheet>`]);
    });
    return zip(arq);
  }
  function baixar(blob, nome) { const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.download = nome; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(u); a.remove(); }, 1500); }
  async function exportarXlsx() {
    if (st.online && SB.sessao) { try { await sincronizar(false); await puxarServidor(); } catch (e) { /* usa o que houver */ } }
    const regs = (await todosRegistros()).filter((r) => r.codigo && r.escopo).sort((a, b) => (a.codigo < b.codigo ? -1 : 1));
    if (!regs.length) { toast('Nenhum levantamento para exportar'); return; }
    const fotosLoc = await dbAll('fotos');
    const attrNomes = []; const vis = new Set();
    CAT.escopos.forEach((e) => (CAT.campos[e.cod] || []).forEach((f) => { if (f.t !== 'note' && !vis.has(f.n)) { vis.add(f.n); attrNomes.push(f.n); } }));
    const cab = ['start', 'end', 'today', 'equipe', 'inspetor', 'bloco', 'escopo', 'nivel', 'codigo_ativo', 'nome_ativo', 'sap_li', 'geo_ponto', 'lat', 'lon', 'precisao_m', 'foto_principal', 'condicao_geral',
      ...attrNomes, ...CAT.itens.map((i) => 'c_' + i.tk), 'geo_linha', 'ext_m', 'geo_area', 'area_m2', 'n_c', 'n_nc', 'n_om', 'n_na', 'n_nv', 'indice', 'status_inspecao', 'motivo_parcial', 'nv_motivo', 'observacao',
      '_geo_ponto_latitude', '_geo_ponto_longitude', '_geo_ponto_altitude', '_geo_ponto_precision', '_id', '_uuid', '_submission_time', '_index'];
    const L = [cab]; const NCL = [['nc_item', 'nc_res', 'nc_ativo', 'nc_escopo', 'nc_bloco', 'nc_lat', 'nc_lon', 'nc_data', 'nc_equipe', 'nc_g', 'nc_u', 'nc_t', 'nc_gut', 'nc_crit', 'nc_descricao', 'nc_qtd', 'nc_foto1', 'nc_foto2', 'nc_foto3', 'nc_contencao', 'nc_contencao_desc', 'nc_acao_campo', '_index', '_parent_table_name', '_parent_index', '_submission__uuid']];
    const TLL = [['tl_ativo', 'tl_tipo', 'tl_estrutura', 'tl_area_proj', 'tl_incl', 'tl_area_real', 'tl_aguas', 'tl_calhas', 'tl_condicao', 'tl_amianto', 'tl_acesso', 'tl_infiltr', 'tl_fv_exist', 'tl_fv_apto', 'tl_foto', '_index', '_parent_table_name', '_parent_index', '_submission__uuid']];
    const FTL = [['ft_ativo', 'ft_tipo', 'ft_foto', 'ft_legenda', '_index', '_parent_table_name', '_parent_index', '_submission__uuid']];
    const PAI = 'PD-SLZ Levantamento de Campo';
    regs.forEach((rec, k) => {
      const idx = k + 1; const d = diagnostico(rec); const c = ctx(rec); const g = rec.gps || {}; const m = medidas(rec.tracado);
      const fts = rec.status === 'servidor' ? (rec.fotosSrv || []) : fotosLoc.filter((f) => f.regId === rec.id).map((f) => ({ ...f, nome: f.nome || (f.path ? f.path.split('/').pop() : `${f.id}.jpg`) }));
      const nomeF = (tipo, item, tel) => { const f = fts.find((x) => x.tipo === tipo && (x.itemId || null) === (item || null) && (!tel || x.telhadoId === tel)); return f ? f.nome || (f.path || '').split('/').pop() : null; };
      const geoStr = (tr) => (tr && tr.pts && tr.pts.length >= 2 ? tr.pts.map((p) => `${p[0].toFixed(7)} ${p[1].toFixed(7)} 0 ${p[2] == null ? 0 : p[2]}`).join(';') : null);
      const valAttr = (n) => { const f = CAMPO[n]; const x = f && f.calcF ? c.v(n) : rec.attrs[n]; if (!temValor(x)) return null; return f && (NUMT.has(f.t) || f.calcF) && isFinite(num(x)) ? num(x) : x; };
      const lin = [rec.iniciadoEm, rec.finalizadoEm, rec.data, rec.equipe, rec.inspetor, rec.bloco, rec.escopo, rec.escopo === 'ED' ? String(rec.nivel || 1) : null, rec.codigo, rec.nome, rec.sap,
        g.lat != null ? `${g.lat} ${g.lon} ${g.alt || 0} ${g.acc || 0}` : null, g.lat ?? null, g.lon ?? null, g.acc ?? null, nomeF('F'), rec.condicao ? String(rec.condicao) : null,
        ...attrNomes.map((n) => ((CAT.campos[rec.escopo] || []).some((f) => f.n === n) ? valAttr(n) : null)),
        ...CAT.itens.map((i) => (rec.resp[i.id] ? rec.resp[i.id].r : null)),
        rec.tracado && rec.tracado.tipo !== 'area' ? geoStr(rec.tracado) : null, rec.tracado && rec.tracado.tipo !== 'area' && m.comp ? Math.round(m.comp * 10) / 10 : null,
        rec.tracado && rec.tracado.tipo === 'area' ? geoStr({ pts: [...rec.tracado.pts, rec.tracado.pts[0]] }) : null, rec.tracado && rec.tracado.tipo === 'area' && m.area ? Math.round(m.area * 10) / 10 : null,
        d.n.C, d.n.NC, d.n.OM, d.n.NA, d.n.NV, d.indice == null ? null : Math.round(d.indice * 1000) / 10, rec.statusInspecao, rec.motivoParcial, rec.nvMotivo, rec.obs,
        g.lat ?? null, g.lon ?? null, g.alt ?? null, g.acc ?? null, idx, rec.id, rec.atualizadoEm, idx];
      L.push(lin);
      d.ncs.forEach((x) => {
        NCL.push([x.it.tk, x.r, rec.codigo, rec.escopo, rec.bloco, g.lat ?? null, g.lon ?? null, rec.data, rec.equipe, x.r === 'NC' ? Number(x.g) || null : null, x.r === 'NC' ? Number(x.u) || null : null, x.r === 'NC' ? Number(x.t) || null : null,
          x.r === 'NC' && x.g && x.u && x.t ? x.g * x.u * x.t : null, x.crit, x.desc, x.qtd, nomeF('N1', x.id), nomeF('N2', x.id), nomeF('N3', x.id), x.cont || null, x.contDesc, x.acaoCampo, NCL.length, PAI, idx, rec.id]);
      });
      (rec.telhados || []).forEach((t) => {
        const ar = num(t.area_proj); const real = isFinite(ar) ? Math.round(ar * Math.sqrt(1 + ((num(t.incl) || 0) / 100) ** 2) * 10) / 10 : null;
        TLL.push([rec.codigo, t.tipo, t.estrutura, isFinite(ar) ? ar : null, isFinite(num(t.incl)) ? num(t.incl) : null, real, isFinite(num(t.aguas)) ? num(t.aguas) : null, t.calhas, t.condicao != null ? String(t.condicao) : null,
          t.amianto, t.acesso, t.infiltr, t.fv_exist, t.fv_apto, nomeF('TL', null, t.id), TLL.length, PAI, idx, rec.id]);
      });
      fts.filter((f) => ['X', 'G', 'D', 'P', 'E'].includes(f.tipo)).forEach((f) => FTL.push([rec.codigo, f.tipo, f.nome || (f.path || '').split('/').pop(), f.legenda, FTL.length, PAI, idx, rec.id]));
    });
    const blob = planilha([{ nome: PAI, linhas: L }, { nome: 'nc', linhas: NCL }, { nome: 'telhado', linhas: TLL }, { nome: 'fotos', linhas: FTL }]);
    const agora = new Date();
    baixar(blob, `PD-SLZ_App_${hoje(agora).replace(/-/g, '')}-${pad(agora.getHours())}${pad(agora.getMinutes())}.xlsx`);
    toast(`Planilha com ${regs.length} ativos baixada`);
  }

  /* ------------------------------------------------------------ cópia de segurança */
  const blobB64 = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });
  async function backup() {
    const regs = await dbAll('registros'); const fotos = await dbAll('fotos');
    const fs = []; for (const f of fotos) fs.push(Object.assign({}, f, { blob: f.blob ? await blobB64(f.blob) : null }));
    baixar(new Blob([JSON.stringify({ app: 'PD-SLZ Campo', versao: VERSAO, gerado: new Date().toISOString(), registros: regs, fotos: fs })], { type: 'application/json' }), `PD-SLZ_Campo_backup_${hoje().replace(/-/g, '')}.json`);
  }
  async function restaurar(arq) {
    try {
      const j = JSON.parse(await arq.text());
      if (!j.registros) throw new Error('arquivo não é uma cópia do PD Campo');
      let n = 0;
      for (const r of j.registros) { const atual = await dbGet('registros', r.id); if (!atual || (atual.atualizadoEm || '') < (r.atualizadoEm || '')) { await dbPut('registros', r); n++; } }
      for (const f of j.fotos || []) { if (!(await dbGet('fotos', f.id)) && f.blob) { const b = await (await fetch(f.blob)).blob(); await dbPut('fotos', Object.assign({}, f, { blob: b })); } }
      toast(`${n} levantamento(s) restaurado(s)`); contarPendentes(); render();
    } catch (e) { toast('Não foi possível restaurar: ' + e.message); }
  }

  /* ------------------------------------------------------------ ações */
  async function setCampo(chave, valor, recarregar) {
    const rec = st.reg;
    const [tipo, a, b] = chave.split(':');
    if (tipo === 'aj') {
      st.aj[a] = a === 'equipe' || a === 'bloco' ? String(valor).toUpperCase().trim() : valor;
      await metaSet('ajustes', st.aj);
      if (a === 'tema') aplicarTema();
      return;
    }
    if (!rec) return;
    if (tipo === 'attr') { if (temValor(valor)) rec.attrs[a] = valor; else delete rec.attrs[a]; }
    else if (tipo === 'reg') {
      let v = valor;
      if (a === 'codigo' || a === 'bloco') v = String(v).toUpperCase().replace(/\s/g, '');
      if (a === 'bloco' && /^B\d$/.test(v)) v = 'B0' + v.slice(1);
      rec[a] = v;
    } else if (tipo === 'tel') { rec.telhados[+a][b] = valor; }
    else if (tipo === 'nc') { rec.ncs[a][b] = valor; }
    else if (tipo === 'foto') { const f = await dbGet('fotos', a); if (f) { f[b] = valor; await dbPut('fotos', f); await carregarFotos(rec.id); } }
    await mexeu(rec);
    if (recarregar === 'seMudou') { if (assinatura(rec) !== st.assin) renderSuave(); else atualizarPlaqueta(rec); }
    else if (recarregar) renderPreservando();
  }
  const ACT = {
    ir: (b) => irPara(b.dataset.h),
    voltar: (b) => { if (b.dataset.h === 'sair') ACT.sair(); else irPara(b.dataset.h); },
    async sinc() { if (st.online && SB.sessao) await carregarPerfil(); await sincronizar(true); },
    async novo() {
      const papel = st.perfil && st.perfil.papel;
      if (papel === 'pendente' || papel === 'leitor') { toast(papel === 'leitor' ? 'Perfil somente leitura: peça ao coordenador para liberar como inspetor' : 'Acesso aguardando liberação do coordenador'); return; }
      if (!st.aj.equipe) { toast('Defina a letra da equipe nos ajustes'); irPara('ajustes'); return; }
      const rec = novoRegistro(); await dbPut('registros', rec); st.reg = null; irPara(`form/${rec.id}/id`);
    },
    abrir: (b) => irPara(`form/${b.dataset.id}/fim`),
    async pfSet(b) {
      try { await SB.req(`/rest/v1/pd_perfis?user_id=eq.${b.dataset.u}`, { method: 'PATCH', body: { [b.dataset.k]: b.dataset.v }, prefer: 'return=minimal' }); toast('Perfil atualizado'); }
      catch (e) { toast('Não foi possível alterar: ' + e.message); }
      if (b.dataset.u === SB.sessao.user.id) await carregarPerfil();
      renderPreservando();
    },
    async pfSalvar(b) {
      const u = b.dataset.u; const eq = ($(`#pfe_${u}`).value || '').trim().toUpperCase();
      if (eq && !/^[A-Z]$/.test(eq)) { toast('A equipe é uma única letra, de A a Z'); return; }
      try { await SB.req(`/rest/v1/pd_perfis?user_id=eq.${u}`, { method: 'PATCH', body: { nome: $(`#pfn_${u}`).value.trim() || null, equipe: eq || null }, prefer: 'return=minimal' }); toast('Nome e equipe salvos'); }
      catch (e) { toast('Não foi possível salvar: ' + e.message); }
      renderPreservando();
    },
    async duplicar(b) {
      const o = await dbGet('registros', b.dataset.id); if (!o) return;
      const rec = novoRegistro();
      Object.assign(rec, { escopo: o.escopo, bloco: o.bloco || rec.bloco, nivel: o.nivel, attrs: JSON.parse(JSON.stringify(o.attrs || {})) });
      rec.codigo = await sugerirCodigo(rec);
      aplicarAuto(rec); resumir(rec);
      await dbPut('registros', rec); st.reg = null;
      toast(`Cadastro copiado de ${o.codigo}: confira o que muda neste ativo`);
      irPara(`form/${rec.id}/id`);
    },
    async sair() {
      const rec = st.reg;
      if (rec) { _gravar.cancelar(); await dbPut('registros', rec); st.gravando = false; }
      if (rec && rec.status === 'rascunho' && !rec.escopo && !Object.keys(rec.attrs).length && !st.fotos.length) await dbDel('registros', rec.id);
      irPara('inicio');
    },
    passo: (b) => irPara(`form/${st.reg.id}/${b.dataset.p}`, true),
    async escopo(b) {
      const rec = st.reg; rec.escopo = b.dataset.v;
      if (!rec.codigo || rec.codigo.slice(0, 2) !== rec.escopo) rec.codigo = await sugerirCodigo(rec);
      await mexeu(rec, true); renderPreservando();
    },
    async trocarEsc() {
      if (!confirm('Trocar o escopo apaga o cadastro, os telhados e o checklist deste levantamento. Continuar?')) return;
      const rec = st.reg; rec.escopo = ''; rec.attrs = {}; rec.resp = {}; rec.ncs = {}; rec.telhados = []; rec.tracado = null; rec.codigo = '';
      await mexeu(rec, true); renderPreservando();
    },
    async sugerir() { const rec = st.reg; if (!rec.escopo) { toast('Escolha o escopo primeiro'); return; } rec.codigo = await sugerirCodigo(rec); await mexeu(rec, true); renderPreservando(); },
    set: (b) => { const atual = b.classList.contains('on'); setCampo(b.dataset.f, atual ? '' : b.dataset.v, true); },
    tog: (b) => { const rec = st.reg; const n = b.dataset.f.split(':')[1]; const s = new Set(String(rec.attrs[n] || '').split(' ').filter(Boolean)); if (s.has(b.dataset.v)) s.delete(b.dataset.v); else s.add(b.dataset.v); setCampo(b.dataset.f, [...s].join(' '), true); },
    async setReg(b) { const rec = st.reg; const k = b.dataset.k; rec[k] = String(rec[k]) === b.dataset.v && k !== 'nivel' && k !== 'statusInspecao' ? null : (k === 'nivel' ? Number(b.dataset.v) : b.dataset.v); await mexeu(rec, true); renderPreservando(); },
    async fixar() {
      const g = st.gps; if (!g) { toast(st.gpsErro || 'Ainda sem sinal de GPS'); return; }
      if (g.acc > PARAM.gps_meta_m && !confirm(`A precisão está em ${fmt(g.acc, 0)} m (meta ${PARAM.gps_meta_m} m). Fixar mesmo assim?`)) return;
      st.reg.gps = Object.assign({}, g); await mexeu(st.reg, true); renderPreservando(); toast('Ponto fixado');
    },
    async resp(b) {
      const rec = st.reg; const id = b.dataset.item; const v = b.dataset.v; const cur = rec.resp[id];
      if (cur && cur.r === v && cur.origem === 'manual') delete rec.resp[id]; else rec.resp[id] = { r: v, origem: 'manual' };
      await mexeu(rec, true); renderPreservando();
    },
    async secC(b) {
      const rec = st.reg; let n = 0;
      itensAplicaveis(rec).filter((it) => it.sec === b.dataset.sec && !rec.resp[it.id]).forEach((it) => { rec.resp[it.id] = { r: 'C', origem: 'manual' }; n++; });
      await mexeu(rec, true); renderPreservando(); toast(`${n} item(ns) marcados como conformes`);
    },
    async gut(b) { const x = st.reg.ncs[b.dataset.item]; x[b.dataset.k] = Number(b.dataset.v); x.gutSug = false; await mexeu(st.reg, true); renderPreservando(); },
    async ncSet(b) { const x = st.reg.ncs[b.dataset.item]; x[b.dataset.k] = x[b.dataset.k] === b.dataset.v ? '' : b.dataset.v; await mexeu(st.reg, true); renderPreservando(); },
    async telAdd() { st.reg.telhados.push({ id: uuid(), tipo: '', estrutura: '', area_proj: '', incl: '', aguas: '', calhas: '', condicao: '', amianto: '', acesso: '', infiltr: '', fv_exist: '', fv_apto: '' }); await mexeu(st.reg, true); renderPreservando(); },
    async telDel(b) {
      if (!confirm('Remover esta cobertura?')) return;
      const t = st.reg.telhados.splice(+b.dataset.i, 1)[0];
      for (const f of st.fotos.filter((x) => x.telhadoId === t.id)) await removerFoto(f.id, true);
      await carregarFotos(st.reg.id); await mexeu(st.reg, true); renderPreservando();
    },
    foto: (b) => abrirCamera(JSON.parse(b.dataset.slot), false),
    fotoGal: (b) => abrirCamera(JSON.parse(b.dataset.slot), true),
    fotoDel: (b) => { if (confirm('Apagar esta foto?')) removerFoto(b.dataset.id); },
    async vertice() {
      const g = st.gps; if (!g) { toast('Ainda sem sinal de GPS'); return; }
      st.reg.tracado.pts.push([g.lat, g.lon, Math.round(g.acc * 10) / 10]); await mexeu(st.reg, true); atualizarGeo(); toast(`Ponto ${st.reg.tracado.pts.length} marcado (±${fmt(g.acc, 0)} m)`);
    },
    gravar: () => { st.gravando = !st.gravando; atualizarGeo(); toast(st.gravando ? 'Gravando: caminhe pelo traçado' : 'Gravação parada'); },
    async desfazer() { st.reg.tracado.pts.pop(); await mexeu(st.reg, true); atualizarGeo(); },
    async limparGeo() { if (!confirm('Apagar todo o traçado?')) return; st.reg.tracado.pts = []; st.gravando = false; await mexeu(st.reg, true); atualizarGeo(); },
    async finalizar() {
      const rec = st.reg; const d = diagnostico(rec); const p = pendencias(rec, d, st.fotos);
      if (p.B.length) { toast(`Faltam ${p.B.length} item(ns) para finalizar – veja a lista`); renderPreservando(); return; }
      _gravar.cancelar();
      if (!rec.finalizadoEm) rec.finalizadoEm = new Date().toISOString();
      rec.status = 'pronto'; rec.dirty = true; st.gravando = false;
      resumir(rec); await dbPut('registros', rec); await reservarCodigo(rec); await contarPendentes();
      toast(`${rec.codigo} salvo${st.online ? ': enviando…' : ': será enviado quando houver internet'}`);
      irPara('inicio'); sincronizar(false);
    },
    async excluir() {
      const rec = st.reg;
      if (!confirm(`Excluir o levantamento ${rec.codigo || ''}? Isso não pode ser desfeito.`)) return;
      if (rec.sincronizadoEm || rec.status === 'sincronizado') {
        if (!st.online) { toast('Para excluir um levantamento já enviado é preciso estar com internet'); return; }
        try {
          const fotos = await SB.select('pd_fotos', `select=storage_path&levantamento_id=eq.${rec.id}`);
          await SB.apagar('pd_levantamentos', `id=eq.${rec.id}`);
          if (fotos.length) await SB.apagarFotos(fotos.map((f) => f.storage_path)).catch(() => null);
          await dbDel('servidor', rec.id);
        } catch (e) { toast('Não foi possível excluir no servidor: ' + e.message); return; }
      }
      for (const f of st.fotos) await dbDel('fotos', f.id);
      await dbDel('registros', rec.id); st.reg = null; toast('Levantamento excluído'); contarPendentes(); irPara('inicio');
    },
    filtro: (b) => { st.filtro.st = b.dataset.v; render(); },
    mZoom: (b) => mZoomEm(Math.round(MP.view.z) + Number(b.dataset.v), MP.W / 2, MP.H / 2),
    mEu: () => { if (st.gps) { MP.view.lat = st.gps.lat; MP.view.lon = st.gps.lon; MP.view.z = Math.max(MP.view.z, 17); mDesenhar(); } else toast('Ainda sem sinal de GPS'); },
    mTudo: () => {
      if (!MP.pts.length) return;
      let s = 90; let n = -90; let w = 180; let e = -180; MP.pts.forEach((p) => { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lon); e = Math.max(e, p.lon); });
      let z = 19; for (; z > 4; z -= 0.5) { const a = proj(n, w, z); const b = proj(s, e, z); if (b.x - a.x < MP.W - 80 && b.y - a.y < MP.H - 80) break; }
      MP.view = { lat: (s + n) / 2, lon: (w + e) / 2, z }; mDesenhar(); salvarVista();
    },
    pFonte: (b) => { st.painelFonte = b.dataset.v; st.painel = null; render(); },
    pRec: async () => { st.painel = null; if (st.online) { try { await puxarServidor(); } catch (e) { /* segue */ } } render(); },
    xlsx: () => exportarXlsx().catch((e) => toast('Falha ao exportar: ' + e.message)),
    async ajSet(b) { const k = b.dataset.k; let v = b.dataset.v; if (k === 'fotoMax') v = Number(v); if (k === 'carimbo') v = v === '1'; st.aj[k] = v; await metaSet('ajustes', st.aj); if (k === 'tema') aplicarTema(); render(); },
    async link() {
      const l = `${location.origin}${location.pathname}#cfg=${encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify({ u: SB.url, k: SB.key })))))}`;
      try { await navigator.clipboard.writeText(l); toast('Link copiado: envie aos auxiliares'); } catch (e) { prompt('Copie o link:', l); }
    },
    backup: () => backup().catch((e) => toast('Falha na cópia: ' + e.message)),
    restaurar: () => { const i = $('#inBackup'); i.value = ''; i.click(); },
    async liberar() {
      const regs = await dbAll('registros'); let n = 0;
      for (const r of regs) {
        if (r.status !== 'sincronizado' || r.dirty) continue;
        for (const f of await dbIdx('fotos', 'reg', r.id)) if (f.enviado && f.blob) { f.blob = null; await dbPut('fotos', f); n++; }
      }
      toast(`${n} foto(s) liberadas do aparelho (continuam no servidor)`); render();
    },
    async cfgSalvar() {
      const u = $('#cfgU').value.trim(); const k = $('#cfgK').value.trim();
      salvarCfg({ supabaseUrl: u, supabaseKey: k });
      if (!SB.configurado()) { toast('Preencha a URL (https://…) e a chave'); return; }
      try { const r = await fetch(`${SB.url}/auth/v1/health`, { headers: { apikey: SB.key } }); toast(r.ok ? 'Conexão OK' : `O servidor respondeu ${r.status}: confira a URL e a chave`); }
      catch (e) { toast('Não foi possível testar agora (sem internet?). Configuração salva.'); }
      render();
    },
    cfgTrocar: () => { salvarCfg({ supabaseUrl: '', supabaseKey: '' }); try { localStorage.removeItem('pdslz_cfg'); } catch (e) { /* ok */ } st.cfg = { bucket: 'pd-fotos' }; render(); },
    async entrar() {
      const e = $('#lgE').value.trim(); const s = $('#lgS').value; const msg = $('#lgMsg');
      if (!e || !s) { msg.textContent = 'Informe e-mail e senha'; return; }
      msg.textContent = 'Entrando…';
      try {
        await SB.login(e, s);
        await carregarPerfil();
        render(); contarPendentes(); sincronizar(false);
      } catch (err) { msg.textContent = err.message; }
    },
    swAtualizar: () => { if (st.swNovo) { st.atualizando = true; st.swNovo.postMessage('atualizar'); } },
  };
  const _sairForm = ACT.sair;
  ACT.sair = async function (b) {
    if (rota().tela === 'form') return _sairForm(b);
    if (!confirm('Sair do aplicativo? Os levantamentos não enviados continuam guardados neste aparelho.')) return;
    await SB.sair(); render();
  };

  const PAPEL = { pendente: 'aguardando liberação', inspetor: 'inspetor', coordenador: 'coordenador', leitor: 'leitor (só consulta)' };
  async function telaEquipe() {
    let lista = [];
    try { lista = await SB.select('pd_perfis', 'select=*&order=papel,email'); } catch (e) { return `${topo('Equipe', 'ajustes')}<main><div class="cartao erro">${esc(e.message)}</div></main>`; }
    const pend = lista.filter((p) => p.papel === 'pendente').length;
    return `${topo('Equipe', 'ajustes')}<main>
      <p class="mut peq">Usuários são criados no Supabase (Authentication › Users › Add user). Aqui você libera o acesso e define a letra de equipe, que entra no código dos ativos.</p>
      ${pend ? `<div class="cartao aviso peq"><b>${pend} usuário(s) aguardando liberação</b></div>` : ''}
      ${lista.map((p) => `<div class="cartao" id="pf_${p.user_id}"><b>${esc(p.nome || p.email)}</b><p class="mut peq" style="margin:2px 0 8px">${esc(p.email || '')}</p>
        <div class="campo"><span class="rot">Papel</span><div class="seg">${['inspetor', 'coordenador', 'leitor', 'pendente'].map((k) => `<button class="${p.papel === k ? 'on' : ''}" data-a="pfSet" data-u="${p.user_id}" data-k="papel" data-v="${k}">${k === 'pendente' ? 'bloqueado' : k}</button>`).join('')}</div></div>
        <div class="linha-bts"><div class="campo" style="flex:1"><label for="pfn_${p.user_id}">Nome</label><input class="inp" id="pfn_${p.user_id}" value="${esc(p.nome || '')}"></div>
        <div class="campo" style="width:92px"><label for="pfe_${p.user_id}">Equipe</label><input class="inp" id="pfe_${p.user_id}" maxlength="1" autocapitalize="characters" value="${esc(p.equipe || '')}"></div></div>
        <button class="bt" data-a="pfSalvar" data-u="${p.user_id}">Salvar nome e equipe</button></div>`).join('')}
    </main>`;
  }
  // parâmetros (prazos, limites das normas) vêm da tabela pd_parametros: o coordenador ajusta no Supabase e os aparelhos recebem
  async function carregarParametros() {
    try {
      const ps = await SB.select('pd_parametros', 'select=chave,valor');
      const o = {}; ps.forEach((x) => { const n = Number(x.valor); if (x.chave in CAT.params && isFinite(n)) o[x.chave] = n; });
      Object.assign(PARAM, o); await metaSet('params', o);
    } catch (e) { /* mantém os do catálogo ou os últimos recebidos */ }
  }
  async function carregarPerfil() {
    carregarParametros();
    try {
      const p = await SB.select('pd_perfis', `select=*&user_id=eq.${SB.sessao.user.id}`);
      st.perfil = p[0] || null;
      if (st.perfil) {
        if (!st.aj.nome && st.perfil.nome) st.aj.nome = st.perfil.nome;
        if (!st.aj.equipe && st.perfil.equipe) st.aj.equipe = st.perfil.equipe;
        await metaSet('ajustes', st.aj); await metaSet('perfil', st.perfil);
      }
    } catch (e) { st.perfil = await metaGet('perfil', null); }
  }
  function aplicarTema() { const t = st.aj.tema; if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }

  /* ------------------------------------------------------------ eventos */
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]'); if (!b || b.disabled) return;
    const f = ACT[b.dataset.a]; if (!f) return;
    e.preventDefault();
    Promise.resolve(f(b, e)).catch((err) => { console.error(err); toast('Erro: ' + err.message); });
  });
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'busca') { st.filtro.q = t.value; clearTimeout(st._bt); st._bt = setTimeout(() => render().then(() => { const i = $('#busca'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }), 300); return; }
    if (t.dataset.f && t.tagName !== 'SELECT') setCampo(t.dataset.f, t.value, false);
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'inCam' || t.id === 'inGal') { if (t.files && t.files[0]) receberFoto(t.files[0]); return; }
    if (t.id === 'inBackup') { if (t.files && t.files[0]) restaurar(t.files[0]); return; }
    if (t.dataset.f) {
      const k = t.dataset.f.split(':')[0];
      if (k === 'aj' || k === 'foto') setCampo(t.dataset.f, t.value, false);
      else setCampo(t.dataset.f, t.value, t.tagName === 'SELECT' ? true : 'seMudou');
    }
  });
  window.addEventListener('hashchange', () => { render().then(() => window.scrollTo(0, 0)); });
  window.addEventListener('online', () => { st.online = true; pintarSinc(); sincronizar(false); });
  window.addEventListener('offline', () => { st.online = false; pintarSinc(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && st.reg) dbPut('registros', st.reg); });
  setInterval(() => { if (st.online && SB.sessao && !st.sinc.rodando && (st.sinc.pend || Date.now() - (st.ultimaLeitura || 0) > 10 * 60e3)) sincronizar(false); }, 120000);

  /* ------------------------------------------------------------ início */
  async function iniciar() {
    st.cfg = lerCfg(); linkCfg();
    await abrirDB();
    st.aj = Object.assign({}, AJ_PADRAO, await metaGet('ajustes', {}));
    aplicarTema();
    SB.sessao = await metaGet('sessao', null);
    st.perfil = await metaGet('perfil', null);
    const ul = await metaGet('ultimaLeitura', null); st.ultimaLeitura = ul ? Date.parse(ul) : 0;
    Object.assign(PARAM, await metaGet('params', {}));
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* opcional */ }
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      try {
        const reg = await navigator.serviceWorker.register('sw.js');
        const avisar = (w) => { st.swNovo = w; if (rota().tela === 'inicio') render(); };
        if (reg.waiting && navigator.serviceWorker.controller) avisar(reg.waiting);
        reg.addEventListener('updatefound', () => { const w = reg.installing; w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) avisar(w); }); });
        let recarregou = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => { if (st.atualizando && !recarregou) { recarregou = true; location.reload(); } });
      } catch (e) { console.warn('Service worker não registrado', e); }
    }
    if (!location.hash || location.hash === '#') history.replaceState(null, '', '#/inicio');
    await contarPendentes();
    await render();
    if (SB.sessao && st.online) { carregarPerfil(); sincronizar(false); }
  }
  window.__pdcampo = { st, SB, ctx, iff, rnd, diagnostico, regras, itensAplicaveis, pendencias, aplicarAuto, resumir, sincronizar, sincronizarRegistro, puxarServidor, exportarXlsx, CAT };
  iniciar().catch((e) => { console.error(e); document.getElementById('app').innerHTML = `<main><div class="cartao erro">Falha ao iniciar o app: ${esc(e.message)}</div></main>`; });
})();
