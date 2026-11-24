{
  'use strict';

  /* ===================== Configuración ===================== */
  const MAX_FILES = 25;
  const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/build/pdf.min.mjs';
  const PDFJS_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/build/pdf.worker.min.mjs';

  const TOOLS = {
    merge: {
      title: 'Unir PDF',
      desc: 'Junta varios PDF en un solo archivo. El primero de la lista será el inicio del documento.',
      accept: '.pdf,application/pdf', exts: ['pdf'], label: '.pdf',
      button: 'Unir PDF', min: 2
    },
    word2pdf: {
      title: 'Word a PDF',
      desc: 'Convierte documentos .docx a PDF conservando títulos, listas, tablas e imágenes. Los diseños muy complejos pueden variar.',
      accept: '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document', exts: ['docx'], label: '.docx',
      button: 'Convertir a PDF', min: 1
    },
    pdf2word: {
      title: 'PDF a Word',
      desc: 'Convierte cada PDF en un documento .docx que puedes abrir y editar en Word.',
      accept: '.pdf,application/pdf', exts: ['pdf'], label: '.pdf',
      button: 'Convertir a Word', min: 1
    }
  };

  const state = {
    tool: 'merge',
    files: { merge: [], word2pdf: [], pdf2word: [] },
    results: [],
    busy: false
  };
  let uid = 0;

  /* ===================== Elementos ===================== */
  const $ = (id) => document.getElementById(id);
  const el = {
    tabs: document.querySelectorAll('.tabs button'),
    title: $('tool-title'), desc: $('tool-desc'),
    drop: $('drop'), picker: $('picker'), acceptLabel: $('accept-label'),
    optMerge: $('opt-merge'), optPdf2word: $('opt-pdf2word'), outName: $('out-name'),
    list: $('list'), empty: $('empty'), hint: $('hint'), count: $('count'), clear: $('clear'),
    run: $('run'), progress: $('progress'), bar: $('bar'), status: $('status'),
    resultsBand: $('results-band'), results: $('results'), zip: $('zip'),
    toast: $('toast'), renderArea: $('render-area')
  };

  /* ===================== Utilidades ===================== */
  const extOf = (name) => { const m = /\.([^.]+)$/.exec(name); return m ? m[1].toLowerCase() : ''; };
  const baseName = (name) => name.replace(/\.[^.]+$/, '');
  const cleanName = (name) => name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'documento';

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  let toastTimer = null;
  function toast(msg, isError) {
    el.toast.textContent = msg;
    el.toast.classList.toggle('err', !!isError);
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), isError ? 6000 : 3500);
  }

  function setProgress(fraction, text) {
    el.progress.hidden = false;
    el.bar.style.width = Math.round(Math.max(0, Math.min(1, fraction)) * 100) + '%';
    el.status.textContent = text;
  }

  const nextFrame = () => new Promise((r) => setTimeout(r, 0));

  /* ===================== Descargas ===================== */
  // Dentro de claude.ai se usa la capacidad "downloads"; fuera, un enlace normal.
  let downloader = null;
  if (window.claude && typeof window.claude.use === 'function') {
    window.claude.use('downloads').then((ns) => { downloader = ns; }).catch(() => {});
  }

  async function saveFile(name, blob) {
    if (downloader) {
      try {
        await downloader.save({ filename: name, data: blob });
        toast('Descargado: ' + name);
      } catch (e) {
        const code = e && e.code;
        if (code === 'declined') toast('Descarga cancelada.');
        else if (code === 'rate_limited') toast('Hay una descarga pendiente. Inténtalo en un momento.', true);
        else if (code === 'host_unavailable') toast('Esta app no permite guardar archivos. Ábrela en un navegador.', true);
        else toast('No se pudo descargar el archivo.', true);
      }
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /* ===================== Pestañas ===================== */
  function selectTool(tool) {
    if (state.busy) return;
    state.tool = tool;
    const cfg = TOOLS[tool];
    el.tabs.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tool === tool)));
    el.title.textContent = cfg.title;
    el.desc.textContent = cfg.desc;
    el.acceptLabel.textContent = cfg.label;
    el.picker.accept = cfg.accept;
    el.optMerge.hidden = tool !== 'merge';
    el.optPdf2word.hidden = tool !== 'pdf2word';
    el.progress.hidden = true;
    el.resultsBand.hidden = true;
    state.results = [];
    render();
  }

  /* ===================== Lista de archivos ===================== */
  function addFiles(fileList) {
    if (state.busy) return;
    const cfg = TOOLS[state.tool];
    const arr = state.files[state.tool];
    let wrongType = 0, oldDoc = 0, overLimit = 0, added = 0;

    for (const file of fileList) {
      const ext = extOf(file.name);
      if (!cfg.exts.includes(ext)) {
        if (ext === 'doc') oldDoc++; else wrongType++;
        continue;
      }
      if (arr.length >= MAX_FILES) { overLimit++; continue; }
      arr.push({ id: ++uid, file });
      added++;
    }

    if (overLimit) toast(`Máximo ${MAX_FILES} documentos. Se omitieron ${overLimit}.`, true);
    else if (oldDoc) toast('Los archivos .doc antiguos no se pueden convertir. Guárdalos como .docx en Word.', true);
    else if (wrongType) toast(`Solo se aceptan archivos ${cfg.label}. Se omitieron ${wrongType}.`, true);
    else if (added) toast(added === 1 ? 'Archivo agregado.' : `${added} archivos agregados.`);
    render();
  }

  function moveItem(from, to) {
    const arr = state.files[state.tool];
    if (to < 0 || to >= arr.length || from === to) return;
    const [item] = arr.splice(from, 1);
    arr.splice(to, 0, item);
    render();
  }

  const ICONS = {
    up: '<svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
    del: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'
  };

  function iconButton(kind, label, disabled, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon' + (kind === 'del' ? ' del' : '');
    b.innerHTML = ICONS[kind];
    b.setAttribute('aria-label', label);
    b.title = label;
    b.disabled = disabled;
    b.addEventListener('click', onClick);
    return b;
  }

  let dragIndex = null;

  function render() {
    const cfg = TOOLS[state.tool];
    const arr = state.files[state.tool];
    const n = arr.length;

    el.list.replaceChildren();
    arr.forEach((item, i) => {
      const li = document.createElement('li');
      li.className = 'file';
      li.draggable = !state.busy;

      const grip = document.createElement('span');
      grip.className = 'grip';
      grip.textContent = '⋮⋮';
      grip.setAttribute('aria-hidden', 'true');

      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(i + 1);

      const name = document.createElement('span');
      name.className = 'fname';
      name.textContent = item.file.name;
      name.title = item.file.name;

      const size = document.createElement('span');
      size.className = 'fsize';
      size.textContent = formatSize(item.file.size);

      const btns = document.createElement('span');
      btns.className = 'btns';
      btns.append(
        iconButton('up', 'Subir', state.busy || i === 0, () => moveItem(i, i - 1)),
        iconButton('down', 'Bajar', state.busy || i === n - 1, () => moveItem(i, i + 1)),
        iconButton('del', 'Quitar', state.busy, () => { arr.splice(i, 1); render(); })
      );

      li.append(grip, num, name, size, btns);

      li.addEventListener('dragstart', (e) => {
        dragIndex = i;
        li.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(i)); } catch (_) {}
      });
      li.addEventListener('dragend', () => { dragIndex = null; li.classList.remove('dragging'); });
      li.addEventListener('dragover', (e) => {
        if (dragIndex === null) return;
        e.preventDefault();
        li.classList.add('target');
      });
      li.addEventListener('dragleave', () => li.classList.remove('target'));
      li.addEventListener('drop', (e) => {
        if (dragIndex === null) return;
        e.preventDefault();
        e.stopPropagation();
        li.classList.remove('target');
        moveItem(dragIndex, i);
      });

      el.list.appendChild(li);
    });

    el.empty.hidden = n > 0;
    el.hint.hidden = n < 2;
    el.count.textContent = `${n}/${MAX_FILES}`;
    el.count.classList.toggle('full', n >= MAX_FILES);
    el.clear.disabled = n === 0 || state.busy;
    el.run.textContent = cfg.button;
    el.run.disabled = state.busy || n < cfg.min;
    el.run.title = n < cfg.min && cfg.min > 1 ? `Agrega al menos ${cfg.min} PDF para unirlos` : '';
  }

  /* ===================== Unir PDF ===================== */
  async function mergePdfs(items) {
    const { PDFDocument } = window.PDFLib;
    const out = await PDFDocument.create();

    for (let i = 0; i < items.length; i++) {
      const f = items[i].file;
      setProgress(i / items.length, `Agregando ${i + 1} de ${items.length}: ${f.name}`);
      let src;
      try {
        src = await PDFDocument.load(await f.arrayBuffer());
      } catch (e) {
        const locked = /encrypt/i.test(String(e && e.message));
        throw new Error(locked
          ? `"${f.name}" está protegido con contraseña.`
          : `No se pudo leer "${f.name}". Puede estar dañado.`);
      }
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p) => out.addPage(p));
    }

    setProgress(0.97, 'Generando el PDF final…');
    const bytes = await out.save();
    const name = cleanName(el.outName.value.replace(/\.pdf$/i, '')) + '.pdf';
    return [{ name, blob: new Blob([bytes], { type: 'application/pdf' }), info: `${out.getPageCount()} páginas` }];
  }

  /* ===================== Word a PDF ===================== */
  async function docxToPdf(file) {
    const arrayBuffer = await file.arrayBuffer();
    const result = await window.mammoth.convertToHtml(
      { arrayBuffer },
      {
        convertImage: window.mammoth.images.imgElement((image) =>
          image.read('base64').then((data) => ({ src: `data:${image.contentType};base64,${data}` })))
      }
    );

    const page = document.createElement('div');
    page.className = 'doc-page';
    page.innerHTML = result.value || '<p></p>';
    el.renderArea.appendChild(page);

    // Espera a que carguen las imágenes incrustadas
    await Promise.all([...page.querySelectorAll('img')].map((img) =>
      img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; })));

    try {
      return await window.html2pdf().set({
        margin: [15, 15, 15, 15],
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: { scale: 2, backgroundColor: '#ffffff', logging: false },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['css', 'legacy'], avoid: ['img', 'tr', 'h1', 'h2', 'h3'] }
      }).from(page).outputPdf('blob');
    } finally {
      page.remove();
    }
  }

  async function wordToPdfAll(items) {
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const f = items[i].file;
      setProgress(i / items.length, `Convirtiendo ${i + 1} de ${items.length}: ${f.name}`);
      await nextFrame();
      try {
        const blob = await docxToPdf(f);
        out.push({ name: cleanName(baseName(f.name)) + '.pdf', blob });
      } catch (e) {
        out.push({ name: f.name, error: 'No se pudo convertir (¿archivo dañado o no es .docx?).' });
      }
    }
    return out;
  }

  /* ===================== PDF a Word ===================== */
  let pdfjsPromise = null;
  function loadPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import(PDFJS_URL).then((lib) => {
        // pdf.js crea el worker por su cuenta (y usa uno interno si el navegador lo bloquea)
        lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
        return lib;
      });
      pdfjsPromise.catch(() => { pdfjsPromise = null; });
    }
    return pdfjsPromise;
  }

  // Agrupa los fragmentos de texto de una página en líneas y luego en párrafos
  function textToParagraphs(items) {
    const frags = [];
    for (const it of items) {
      if (!it.str || !it.transform) continue;
      const [a, b, c, d, x, y] = it.transform;
      const size = Math.hypot(c, d) || Math.hypot(a, b) || 10;
      frags.push({ str: it.str, x, y, size, w: it.width || 0 });
    }
    if (!frags.length) return [];

    frags.sort((p, q) => (q.y - p.y) || (p.x - q.x));
    const lines = [];
    for (const f of frags) {
      const line = lines.find((l) => Math.abs(l.y - f.y) < Math.max(l.size, f.size) * 0.5);
      if (line) { line.items.push(f); line.size = Math.max(line.size, f.size); }
      else lines.push({ y: f.y, size: f.size, items: [f] });
    }
    lines.sort((p, q) => q.y - p.y);

    for (const line of lines) {
      line.items.sort((p, q) => p.x - q.x);
      let text = '', end = null;
      for (const f of line.items) {
        const gap = end === null ? 0 : f.x - end;
        if (text && gap > f.size * 0.2 && !/\s$/.test(text) && !/^\s/.test(f.str)) text += ' ';
        text += f.str;
        end = f.x + f.w;
      }
      line.text = text.replace(/\s+/g, ' ').trim();
    }

    const sizes = lines.map((l) => l.size).sort((p, q) => p - q);
    const body = sizes[Math.floor(sizes.length / 2)] || 11;

    const paras = [];
    let cur = null, prev = null;
    for (const line of lines) {
      if (!line.text) continue;
      const gap = prev ? prev.y - line.y : 0;
      const sameSize = cur && Math.abs(cur.size - line.size) < Math.max(cur.size, line.size) * 0.15;
      if (cur && sameSize && gap < line.size * 1.7) {
        cur.text = /-$/.test(cur.text) && /^[a-záéíóúñ]/.test(line.text)
          ? cur.text.slice(0, -1) + line.text
          : cur.text + ' ' + line.text;
      } else {
        cur = { text: line.text, size: line.size, heading: line.size > body * 1.25 };
        paras.push(cur);
      }
      prev = line;
    }
    return paras;
  }

  async function pdfToDocx(file, mode, onPage) {
    const lib = await loadPdfjs();
    const D = window.docx;
    let pdf;
    const task = lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    try {
      pdf = await task.promise;
    } catch (e) {
      throw new Error(e && e.name === 'PasswordException' ? 'protegido' : 'ilegible');
    }

    const children = [];
    const A4 = { width: 11906, height: 16838 }; // twips
    const margin = mode === 'image' ? 567 : 1134; // 1 cm o 2 cm

    for (let p = 1; p <= pdf.numPages; p++) {
      onPage(p, pdf.numPages);
      const page = await pdf.getPage(p);
      const breakBefore = p > 1;

      if (mode === 'image') {
        const vp = page.getViewport({ scale: 2 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(vp.width);
        canvas.height = Math.round(vp.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
        const jpg = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
        const data = new Uint8Array(await jpg.arrayBuffer());

        // Área útil de la hoja en píxeles (96 ppp)
        const maxW = (A4.width - margin * 2) / 15;
        const maxH = (A4.height - margin * 2) / 15 - 4;
        const k = Math.min(maxW / canvas.width, maxH / canvas.height);
        children.push(new D.Paragraph({
          pageBreakBefore: breakBefore,
          alignment: D.AlignmentType.CENTER,
          spacing: { before: 0, after: 0 },
          children: [new D.ImageRun({
            type: 'jpg', data,
            transformation: { width: Math.floor(canvas.width * k), height: Math.floor(canvas.height * k) }
          })]
        }));
        canvas.width = canvas.height = 0;
      } else {
        const content = await page.getTextContent();
        const paras = textToParagraphs(content.items);
        if (!paras.length) {
          children.push(new D.Paragraph({
            pageBreakBefore: breakBefore,
            children: [new D.TextRun({ text: `[Página ${p} sin texto seleccionable: prueba el modo “Conservar diseño”]`, italics: true, color: '888888' })]
          }));
        }
        paras.forEach((para, idx) => {
          const half = Math.max(16, Math.min(56, Math.round(para.size * 2)));
          children.push(new D.Paragraph({
            pageBreakBefore: breakBefore && idx === 0,
            spacing: { after: 120 },
            children: [new D.TextRun({ text: para.text, size: half, bold: para.heading })]
          }));
        });
      }
      page.cleanup();
    }
    await task.destroy();

    const doc = new D.Document({
      styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
      sections: [{
        properties: { page: { size: A4, margin: { top: margin, bottom: margin, left: margin, right: margin } } },
        children
      }]
    });
    return D.Packer.toBlob(doc);
  }

  async function pdfToWordAll(items) {
    const mode = document.querySelector('input[name="mode"]:checked').value;
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const f = items[i].file;
      try {
        const blob = await pdfToDocx(f, mode, (p, total) => {
          setProgress((i + p / total) / items.length,
            `Archivo ${i + 1} de ${items.length}: ${f.name} (página ${p} de ${total})`);
        });
        out.push({ name: cleanName(baseName(f.name)) + '.docx', blob });
      } catch (e) {
        const msg = e && e.message === 'protegido' ? 'Está protegido con contraseña.'
          : e && e.message === 'ilegible' ? 'No se pudo leer el PDF.'
          : 'No se pudo convertir.';
        out.push({ name: f.name, error: msg });
      }
    }
    return out;
  }

  /* ===================== Ejecutar ===================== */
  function librariesReady(tool) {
    if (tool === 'merge') return !!window.PDFLib;
    if (tool === 'word2pdf') return !!(window.mammoth && window.html2pdf);
    return !!window.docx;
  }

  async function run() {
    const tool = state.tool;
    const items = state.files[tool].slice();
    if (state.busy || items.length < TOOLS[tool].min) return;
    if (!librariesReady(tool)) {
      toast('No se cargaron las librerías necesarias. Revisa tu conexión a internet y recarga la página.', true);
      return;
    }

    state.busy = true;
    render();
    setProgress(0, 'Preparando…');
    try {
      let results;
      if (tool === 'merge') results = await mergePdfs(items);
      else if (tool === 'word2pdf') results = await wordToPdfAll(items);
      else results = await pdfToWordAll(items);

      const ok = results.filter((r) => r.blob).length;
      setProgress(1, ok === results.length
        ? '¡Listo! Tus archivos están abajo.'
        : `Terminado: ${ok} de ${results.length} archivos convertidos.`);
      showResults(results);
    } catch (e) {
      setProgress(0, 'Ocurrió un problema.');
      toast((e && e.message) || 'Ocurrió un error inesperado.', true);
    } finally {
      state.busy = false;
      render();
    }
  }

  /* ===================== Resultados ===================== */
  function uniqueNames(list) {
    const seen = new Map();
    return list.map((r) => {
      if (!r.blob) return r;
      const n = seen.get(r.name) || 0;
      seen.set(r.name, n + 1);
      if (!n) return r;
      const ext = extOf(r.name);
      return { ...r, name: `${baseName(r.name)} (${n + 1}).${ext}` };
    });
  }

  function showResults(list) {
    state.results = uniqueNames(list);
    el.results.replaceChildren();

    for (const r of state.results) {
      const li = document.createElement('li');
      li.className = 'result';

      const type = document.createElement('span');
      const ext = r.blob ? extOf(r.name) : '!';
      type.className = 'ftype ' + ext;
      type.textContent = r.blob ? ext.toUpperCase() : '!';

      const meta = document.createElement('span');
      meta.className = 'meta';
      const n = document.createElement('span');
      n.textContent = r.name;
      n.title = r.name;
      const sub = document.createElement('span');
      sub.textContent = r.blob ? [formatSize(r.blob.size), r.info].filter(Boolean).join(' · ') : r.error;
      meta.append(n, sub);

      li.append(type, meta);
      if (r.blob) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Descargar';
        btn.addEventListener('click', () => saveFile(r.name, r.blob));
        li.appendChild(btn);
      }
      el.results.appendChild(li);
    }

    const okCount = state.results.filter((r) => r.blob).length;
    el.zip.hidden = okCount < 2 || !window.JSZip;
    el.resultsBand.hidden = false;
    el.resultsBand.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }

  async function downloadZip() {
    const ok = state.results.filter((r) => r.blob);
    if (!ok.length || !window.JSZip) return;
    el.zip.disabled = true;
    try {
      const zip = new window.JSZip();
      ok.forEach((r) => zip.file(r.name, r.blob));
      const blob = await zip.generateAsync({ type: 'blob' });
      const label = state.tool === 'word2pdf' ? 'word-a-pdf' : state.tool === 'pdf2word' ? 'pdf-a-word' : 'documentos';
      await saveFile(`${label}.zip`, blob);
    } finally {
      el.zip.disabled = false;
    }
  }

  /* ===================== Eventos ===================== */
  el.tabs.forEach((b) => b.addEventListener('click', () => selectTool(b.dataset.tool)));

  el.picker.addEventListener('change', () => {
    addFiles(el.picker.files);
    el.picker.value = '';
  });

  ['dragenter', 'dragover'].forEach((type) => el.drop.addEventListener(type, (e) => {
    if (dragIndex !== null) return;
    e.preventDefault();
    el.drop.classList.add('over');
  }));
  ['dragleave', 'dragend'].forEach((type) => el.drop.addEventListener(type, () => el.drop.classList.remove('over')));
  el.drop.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.drop.classList.remove('over');
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  // Evita que el navegador abra el archivo si se suelta fuera de la zona
  window.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } });

  el.clear.addEventListener('click', () => { state.files[state.tool] = []; el.progress.hidden = true; render(); });
  el.run.addEventListener('click', run);
  el.zip.addEventListener('click', downloadZip);

  selectTool('merge');
}
