// Tiny safe markdown renderer — builds DOM nodes only, never innerHTML with
// raw content. Supports: paragraphs, # headings, -/* bullets, fenced code,
// inline `code`, [links](url).

export function renderMd(text: string, parent: HTMLElement): void {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let list: HTMLUListElement | null = null;
  const closeList = () => { list = null; };
  const addInline = (el: HTMLElement, s: string) => {
    // inline `code` and [label](url)
    const re = /(`[^`]+`)|(\[([^\]]+)\]\((https?:[^)\s]+)\))/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      if (m.index > last) el.appendChild(document.createTextNode(s.slice(last, m.index)));
      if (m[1]) {
        const c = document.createElement('code');
        c.textContent = m[1].slice(1, -1);
        el.appendChild(c);
      } else {
        const a = document.createElement('a');
        a.href = m[4];
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = m[3];
        el.appendChild(a);
      }
      last = re.lastIndex;
    }
    if (last < s.length) el.appendChild(document.createTextNode(s.slice(last)));
  };

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      closeList();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++; // closing fence
      const pre = document.createElement('pre');
      pre.textContent = buf.join('\n');
      parent.appendChild(pre);
      continue;
    }
    const head = /^(#{1,6})\s+(.*)/.exec(line);
    if (head) {
      closeList();
      const h = document.createElement('div');
      h.className = 'md-h';
      addInline(h, head[2]);
      parent.appendChild(h);
      i++;
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)/.exec(line);
    if (bullet) {
      if (!list) {
        list = document.createElement('ul');
        parent.appendChild(list);
      }
      const li = document.createElement('li');
      addInline(li, bullet[1]);
      list.appendChild(li);
      i++;
      continue;
    }
    closeList();
    if (line.trim() === '') { i++; continue; }
    // paragraph: merge consecutive plain lines
    const buf = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].startsWith('```') &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^\s*[-*]\s/.test(lines[i])
    ) buf.push(lines[i++]);
    const p = document.createElement('p');
    addInline(p, buf.join('\n'));
    parent.appendChild(p);
  }
}

/// Same section extraction as the server: heading whose title matches `re`
/// to the next heading of same/higher level. Null when absent.
export function extractSection(md: string, re: RegExp): string | null {
  const lines = (md ?? '').replace(/\r\n/g, '\n').split('\n');
  const headingRe = /^(#{1,6})\s+(.+?)\s*$/;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = headingRe.exec(lines[i]);
    if (!m) continue;
    const title = m[2].replace(/\[\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
    if (re.test(title)) {
      start = i + 1;
      level = m[1].length;
      break;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    const m = headingRe.exec(lines[i]);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start, end).join('\n').trim();
  return body || null;
}
