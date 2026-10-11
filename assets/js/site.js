(() => {
  'use strict';

  const root = document.documentElement;
  const themeToggle = document.querySelector('.theme-toggle');
  const themeColor = document.querySelector('meta[name="theme-color"]');
  const syncTheme = () => {
    const dark = root.dataset.theme === 'dark';
    if (themeToggle) themeToggle.setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} theme`);
    if (themeColor) themeColor.content = dark ? '#181e1b' : '#f7f5ef';
  };
  if (themeToggle) {
    themeToggle.hidden = false;
    themeToggle.addEventListener('click', () => {
      root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('field-notes-theme', root.dataset.theme); } catch (_) {}
      syncTheme();
    });
    syncTheme();
  }

  const filters = document.querySelector('.note-filters');
  if (filters) {
    const rows = [...document.querySelectorAll('[data-note-category]')];
    const buttons = [...filters.querySelectorAll('[data-filter]')];
    const result = filters.querySelector('.filter-result');
    filters.hidden = false;
    buttons.forEach(button => button.addEventListener('click', () => {
      const category = button.dataset.filter;
      rows.forEach(row => { row.hidden = category !== 'all' && row.dataset.noteCategory !== category; });
      buttons.forEach(item => {
        const selected = item === button;
        item.classList.toggle('selected', selected);
        item.setAttribute('aria-pressed', String(selected));
      });
      const visible = rows.filter(row => !row.hidden).length;
      result.textContent = category === 'all' ? '' : `${visible} of ${rows.length} notes`;
    }));
  }

  const figure = document.querySelector('[data-gradient]');
  if (figure) {
    const control = figure.querySelector('.gradient-control');
    const slider = figure.querySelector('input[type="range"]');
    const point = figure.querySelector('.plot-point');
    const halo = figure.querySelector('.plot-halo');
    const status = figure.querySelector('.figure-status');
    const caption = figure.querySelector('figcaption');
    const slope = Math.log(3.1);
    const updateGradient = () => {
      const x = Number(slider.value);
      const zero = x === 0;
      const cx = 214 + 156 * x;
      const cy = 154 - 100 * x;
      [point, halo].forEach(dot => { dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); });
      figure.querySelector('[data-forward]').textContent = (x * slope).toFixed(4);
      figure.querySelector('[data-old]').textContent = zero ? '0.0000' : slope.toFixed(4);
      figure.querySelector('output').textContent = x.toFixed(1);
      figure.querySelector('.old-tangent').style.display = zero ? '' : 'none';
      figure.querySelector('.old-annotation').style.display = zero ? '' : 'none';
      status.replaceChildren(Object.assign(document.createElement('span'), { ariaHidden: 'true' }), document.createTextNode(zero ? 'At the origin' : `x = ${x.toFixed(1)}`));
      status.style.color = zero ? '' : 'var(--accent)';
      caption.textContent = zero ? 'The value is zero. The slope is still there.' : 'Away from zero, the old and correct gradients agree.';
    };
    control.hidden = false;
    slider.addEventListener('input', updateGradient);
    figure.querySelector('[data-reset]').addEventListener('click', () => { slider.value = '0'; updateGradient(); });
    updateGradient();
  }

  const prose = document.querySelector('.article-content');
  const toc = document.querySelector('.article-toc');
  let headings = [];
  let tocLinks = [];
  if (prose && toc) {
    headings = [...prose.querySelectorAll('h2')];
    const list = toc.querySelector('ol');
    headings.forEach((heading, index) => {
      if (!heading.id) heading.id = `section-${index + 1}`;
      const link = document.createElement('a');
      link.href = `#${heading.id}`;
      link.textContent = heading.textContent;
      const item = document.createElement('li');
      item.append(link);
      list.append(item);
      tocLinks.push(link);
    });
    toc.hidden = headings.length === 0;
  }

  document.querySelectorAll('.prose .highlighter-rouge').forEach(block => {
    const code = block.querySelector('pre code');
    if (!code) return;
    const language = [...block.classList].find(name => name.startsWith('language-'));
    const label = document.createElement('span');
    label.className = 'code-language';
    label.textContent = language ? language.replace('language-', '') : 'code';
    block.append(label);
    if (!navigator.clipboard) return;
    const button = document.createElement('button');
    button.className = 'code-copy';
    button.type = 'button';
    button.textContent = 'Copy';
    button.setAttribute('aria-label', 'Copy code to clipboard');
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code.textContent);
        button.textContent = 'Copied';
        button.setAttribute('aria-label', 'Code copied');
      } catch (_) {
        button.textContent = 'Select code';
        const range = document.createRange();
        range.selectNodeContents(code);
        const selection = window.getSelection();
        if (selection) { selection.removeAllRanges(); selection.addRange(range); }
      }
      window.setTimeout(() => { button.textContent = 'Copy'; button.setAttribute('aria-label', 'Copy code to clipboard'); }, 1800);
    });
    block.append(button);
  });

  const progress = document.querySelector('.reading-progress > span');
  if (progress || headings.length) {
    let scheduled = false;
    const updateReading = () => {
      scheduled = false;
      if (progress) {
        const article = document.querySelector('.article-grid');
        const start = article ? article.getBoundingClientRect().top + window.scrollY : 0;
        const end = article ? start + article.offsetHeight - window.innerHeight * 0.6 : root.scrollHeight - window.innerHeight;
        const fraction = Math.min(1, Math.max(0, (window.scrollY - start) / Math.max(1, end - start)));
        progress.style.width = `${fraction * 100}%`;
      }
      if (headings.length) {
        let current = 0;
        headings.forEach((heading, index) => { if (heading.getBoundingClientRect().top <= 125) current = index; });
        tocLinks.forEach((link, index) => {
          link.classList.toggle('current', current === index);
          if (current === index) link.setAttribute('aria-current', 'location');
          else link.removeAttribute('aria-current');
        });
      }
    };
    const requestUpdate = () => { if (!scheduled) { scheduled = true; window.requestAnimationFrame(updateReading); } };
    window.addEventListener('scroll', requestUpdate, { passive: true });
    window.addEventListener('resize', requestUpdate);
    if (document.fonts) document.fonts.ready.then(requestUpdate);
    updateReading();
  }
})();
