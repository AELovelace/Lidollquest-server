(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const article = $('#article');
  const pageStatus = $('#page-status');
  const contentCache = new Map();
  let pages = [];
  let routeVersion = 0;
  let searchEntries = [];
  let searchLoading = null;
  let searchIncomplete = false;
  let headingObserver;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node; // Text values never pass through innerHTML.
  }

  const routeLink = (slug, anchor = '') => `#/${slug === 'index' ? '' : slug}${anchor ? '/' + encodeURIComponent(anchor) : ''}`;
  const normalize = value => value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const slugify = value => value.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/ /g, '-');

  async function fetchMarkdown(page) {
    if (!contentCache.has(page.slug)) {
      const request = fetch(`content/${page.slug}.md`, { cache: 'no-cache' }).then(response => {
        if (!response.ok) throw new Error(`Could not load ${page.title} (${response.status}).`);
        return response.text();
      }).catch(error => { contentCache.delete(page.slug); throw error; });
      contentCache.set(page.slug, request); // Failed requests can be retried; successful chapters are reused during this visit.
    }
    return contentCache.get(page.slug);
  }

  function prepareMarkdown(text, page) {
    return text.replace(/^# .+\r?\n\s*/, '').replace(/^\[Wiki home\].*\r?\n\s*/, ''); // Website chrome replaces the text guides' navigation row.
  }

  function renderMarkdown(text, page) {
    const fragment = document.createElement('div');
    fragment.innerHTML = DOMPurify.sanitize(marked.parse(prepareMarkdown(text, page), { gfm: true, headerIds: false, mangle: false }), {
      USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe'], FORBID_ATTR: ['style', 'id', 'name'],
    }); // Sanitize authored Markdown HTML before inserting it; heading IDs are generated below.
    const seen = new Map();
    fragment.querySelectorAll('h2, h3, h4, h5, h6').forEach(heading => {
      const base = slugify(heading.textContent);
      const count = seen.get(base) || 0;
      seen.set(base, count + 1);
      heading.id = base + (count ? `-${count}` : '');
    });
    fragment.querySelectorAll('a').forEach(link => {
      const href = link.getAttribute('href');
      if (!href) return;
      const target = new URL(href, `https://wiki.invalid/${page.source}`);
      if (target.origin === 'https://wiki.invalid') {
        const destination = pages.find(candidate => '/' + candidate.source === target.pathname);
        if (destination) link.href = routeLink(destination.slug, decodeURIComponent(target.hash.slice(1)));
        else { link.removeAttribute('href'); link.title = 'This reference is not part of the GM wiki.'; }
      } else if (['https:', 'http:'].includes(target.protocol)) {
        link.rel = 'noopener noreferrer';
      }
    }); // Original .md links become client-side routes, including their heading anchors.
    fragment.querySelectorAll('table').forEach(table => {
      const wrapper = element('div', 'table-scroll');
      wrapper.tabIndex = 0;
      wrapper.setAttribute('role', 'region');
      wrapper.setAttribute('aria-label', 'Reference table');
      table.replaceWith(wrapper);
      wrapper.append(table); // Wide tables scroll independently on phones.
    });
    return fragment;
  }

  function buildNavigation() {
    const nav = $('#chapters');
    nav.replaceChildren();
    let group, list;
    for (const page of pages) {
      if (group !== page.group) {
        group = page.group;
        nav.append(element('p', 'nav-group', group));
        list = element('ul');
        nav.append(list);
      }
      const item = element('li');
      const link = element('a', '', page.title);
      link.href = routeLink(page.slug);
      link.dataset.page = page.slug;
      item.append(link);
      list.append(item);
    }
    const cards = $('#chapter-cards');
    pages.slice(1).forEach((page, index) => {
      const card = element('a', 'chapter-card');
      card.href = routeLink(page.slug);
      const top = element('span', 'card-top');
      top.append(element('span', '', String(index + 1).padStart(2, '0')), element('span', '', '↗'));
      card.append(top, element('span', 'card-kicker', page.kicker), element('h2', '', page.title), element('p', '', page.description));
      cards.append(card);
    });
  }

  function setHeading(page) {
    const home = page.slug === 'index';
    document.body.className = home ? 'home' : 'article';
    document.title = `${page.title} · LiDollQuest GM Wiki`;
    $('meta[name="description"]').content = page.description;
    $('#breadcrumb-label').textContent = page.kicker;
    $('#page-kicker').textContent = page.kicker;
    $('#page-title').textContent = home ? 'Your guide to\ncreating quests' : page.title;
    $('#page-description').textContent = page.description;
    $('#hero').hidden = !home;
    $('#chapter-cards').hidden = !home;
    $('#markdown-link').href = `content/${page.slug}.md`;
    article.setAttribute('aria-label', page.title);
    document.querySelectorAll('#chapters a').forEach(link => {
      if (link.dataset.page === page.slug) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }

  function buildToc(page) {
    headingObserver?.disconnect();
    const toc = $('#toc');
    toc.replaceChildren();
    const list = element('ul');
    const headings = [...article.querySelectorAll('h2, h3')];
    const links = new Map();
    for (const heading of headings) {
      const item = element('li', heading.tagName === 'H3' ? 'toc-subheading' : '');
      const link = element('a', '', heading.textContent);
      link.href = routeLink(page.slug, heading.id);
      links.set(heading.id, link);
      item.append(link);
      list.append(item);
    }
    toc.append(list);
    if ('IntersectionObserver' in window) {
      headingObserver = new IntersectionObserver(records => {
        for (const record of records) {
          if (!record.isIntersecting) continue;
          links.forEach((link, id) => {
            if (id === record.target.id) link.setAttribute('aria-current', 'location');
            else link.removeAttribute('aria-current');
          });
        }
      }, { rootMargin: '-100px 0px -65% 0px' });
      headings.forEach(heading => headingObserver.observe(heading));
    }
  }

  function buildPagination(page) {
    const nav = $('#pagination');
    nav.replaceChildren();
    const index = pages.indexOf(page);
    for (const [offset, label] of [[-1, 'Previous chapter'], [1, 'Next chapter']]) {
      const target = pages[index + offset];
      if (!target) continue;
      const link = element('a');
      link.href = routeLink(target.slug);
      link.append(element('span', '', label), element('strong', '', `${target.title} ${offset < 0 ? '←' : '→'}`));
      nav.append(link);
    }
  }

  function showError(message, retry) {
    article.replaceChildren();
    pageStatus.hidden = false;
    pageStatus.replaceChildren(element('span', '', message + ' '));
    const button = element('button', 'retry-button', 'Try again');
    button.type = 'button';
    button.addEventListener('click', retry);
    pageStatus.append(button); // A failed fetch has a visible recovery action instead of an empty article.
  }

  async function loadRoute() {
    const version = ++routeVersion;
    const [slug = '', encodedAnchor = ''] = location.hash.replace(/^#\/?/, '').split('/');
    const page = pages.find(candidate => candidate.slug === (slug || 'index'));
    let anchor;
    try { anchor = decodeURIComponent(encodedAnchor); } catch { anchor = ''; }
    $('#toc').replaceChildren();
    $('#pagination').replaceChildren();
    article.replaceChildren();
    if (!page) {
      $('#page-title').textContent = 'That chapter is not here.';
      $('#page-description').textContent = 'Choose a chapter from the guide or return to the wiki home.';
      $('#hero').hidden = true;
      $('#chapter-cards').hidden = true;
      pageStatus.hidden = true;
      return;
    }
    setHeading(page);
    pageStatus.hidden = false;
    pageStatus.textContent = 'Loading this chapter…';
    article.setAttribute('aria-busy', 'true');
    try {
      const text = await fetchMarkdown(page);
      if (version !== routeVersion) return; // A slow previous request must never overwrite a newer navigation.
      article.replaceChildren(...renderMarkdown(text, page).childNodes);
      article.setAttribute('aria-busy', 'false');
      pageStatus.hidden = true;
      $('#reading-time').textContent = `${Math.max(1, Math.round(article.textContent.split(/\s+/).length / 200))} min read`;
      buildToc(page);
      buildPagination(page);
      if (compact.matches) menu.open = false;
      requestAnimationFrame(() => {
        if (version !== routeVersion) return;
        if (anchor && document.getElementById(anchor)) document.getElementById(anchor).scrollIntoView();
        else window.scrollTo(0, 0);
      });
    } catch (error) {
      if (version !== routeVersion) return;
      article.setAttribute('aria-busy', 'false');
      showError(error.message || 'This chapter could not be loaded. Check your connection.', loadRoute);
    }
  }

  const menu = $('.guide-nav');
  const compact = window.matchMedia('(max-width: 760px)');
  const syncMenu = () => { menu.open = !compact.matches; };
  syncMenu();
  compact.addEventListener('change', syncMenu);

  const dialog = $('.search-dialog');
  const input = $('#wiki-search');
  const results = $('#search-results');
  const searchStatus = $('#search-status');

  async function indexSearch() {
    if (searchLoading) return searchLoading;
    searchStatus.textContent = 'Loading the Markdown chapters for search…';
    searchLoading = Promise.allSettled(pages.map(async page => {
      const rendered = renderMarkdown(await fetchMarkdown(page), page);
      const sections = [{ title: page.title, section: 'Overview', url: routeLink(page.slug), text: page.description }];
      let current = sections[0];
      for (const node of rendered.children) {
        if (node.matches('h2, h3')) {
          current = { title: page.title, section: node.textContent, url: routeLink(page.slug, node.id), text: '' };
          sections.push(current);
        } else current.text += ' ' + node.textContent.replace(/\s+/g, ' ');
      }
      return sections;
    })).then(settled => {
      searchIncomplete = settled.some(result => result.status === 'rejected');
      searchEntries = settled.filter(result => result.status === 'fulfilled').flatMap(result => result.value);
      showSearchResults();
      if (searchIncomplete) searchLoading = null; // Reopening search retries missing chapters while keeping useful results.
    });
    return searchLoading;
  }

  function showSearchResults() {
    const query = normalize(input.value.trim());
    const terms = query.split(/\s+/).filter(Boolean);
    const ranked = searchEntries.map(entry => {
      const heading = normalize(`${entry.title} ${entry.section}`);
      const body = normalize(entry.text);
      const score = terms.every(term => `${heading} ${body}`.includes(term))
        ? terms.reduce((total, term) => total + (heading.includes(term) ? 10 : 1), 0) + (heading.includes(query) ? 5 : 0) : 0;
      return { entry, score };
    }).filter(result => terms.length ? result.score > 0 : result.entry.section === 'Overview').sort((a, b) => b.score - a.score);
    results.replaceChildren();
    searchStatus.textContent = (terms.length ? (ranked.length ? `${ranked.length} matching sections${ranked.length > 12 ? ' · showing the first 12' : ''}` : 'No matches. Try a shorter word, like “bank”, “quest”, or “diaper”.') : 'Browse a chapter, or search by a word or phrase.') + (searchIncomplete ? ' Some chapters could not load; reopen search to retry.' : '');
    for (const { entry } of ranked.slice(0, 12)) {
      const item = element('li');
      const link = element('a');
      link.href = entry.url;
      const start = terms.length ? Math.max(0, normalize(entry.text).indexOf(terms[0]) - 45) : 0;
      const snippet = (start ? '…' : '') + entry.text.slice(start, start + 155) + (start + 155 < entry.text.length ? '…' : '');
      link.append(element('strong', '', entry.section === 'Overview' ? entry.title : entry.section), element('small', '', entry.title), element('p', '', snippet));
      link.addEventListener('click', () => {
        dialog.close();
        if (link.hash === location.hash) loadRoute(); // A result on the current section still scrolls to that section.
      });
      item.append(link);
      results.append(item);
    }
  }

  function openSearch() {
    if (!dialog.open) dialog.showModal();
    if (searchEntries.length) showSearchResults();
    indexSearch();
    input.focus();
    input.select();
  }

  $('.search-trigger').addEventListener('click', openSearch);
  input.addEventListener('input', showSearchResults);
  $('.search-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); dialog.close(); }
  }); // Search inputs otherwise consume the first Escape to clear text instead of closing the dialog.
  dialog.addEventListener('click', event => {
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
  });
  document.addEventListener('keydown', event => {
    const typing = event.target.matches('input, textarea, [contenteditable="true"]');
    if (pages.length && ((event.key === '/' && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k'))) {
      event.preventDefault();
      openSearch();
    }
  });
  for (const link of [$('.skip-link'), $('#back-to-top')]) {
    link.addEventListener('click', event => { event.preventDefault(); $('#main').focus({ preventScroll: true }); window.scrollTo(0, 0); });
  }
  window.addEventListener('hashchange', loadRoute);

  async function start() {
    try {
      if (!window.marked || !window.DOMPurify) throw new Error('The Markdown renderer could not load. Refresh to try again.');
      const response = await fetch('pages.json', { cache: 'no-cache' });
      if (!response.ok) throw new Error('The guide index could not load. Check your connection and try again.');
      pages = await response.json();
      buildNavigation();
      $('.search-trigger').hidden = false;
      await loadRoute();
    } catch (error) {
      showError(location.protocol === 'file:' ? 'Open this wiki through a web server so the browser can load its Markdown files.' : error.message, () => location.reload());
    }
  }
  start();
})();
