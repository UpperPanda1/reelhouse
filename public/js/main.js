// App entry: builds the shell, starts the hash router and renders the matching view.
import { $, h, mount } from './util.js';
import { startRouter } from './router.js';
import { buildShell } from './ui/shell.js';
import { homeView } from './ui/home.js';
import { searchView, listView, historyView } from './ui/browse.js';
import { account } from './account.js';
import { detailsView } from './ui/details.js';
import { BRAND } from './brand.js';

const root = $('#main');
let settingsOpen = null;
// Settings (with the account screens) and the admin page load on first use: they are not needed to browse.
const showSettings = async () => { if (settingsOpen && settingsOpen.el && settingsOpen.el.open) return; settingsOpen = { el: { open: true } }; try { settingsOpen = (await import('./ui/settings.js')).openSettings(); } catch (e) { settingsOpen = null; throw e; } };
const adminView = (ctx) => import('./ui/admin.js').then((m) => { if (!ctx.signal.aborted) m.adminView(ctx); });
// the watch page (with the player and subtitle code) loads on the first Play: it is not needed to browse
const watchView = (ctx) => import('./ui/watch.js').then((m) => { if (!ctx.signal.aborted) m.watchView(ctx); });
document.addEventListener('rh:settings', showSettings);

const shell = buildShell({ onSettings: showSettings });

const views = { home: homeView, search: searchView, list: listView, history: historyView, admin: adminView, details: detailsView, watch: watchView };

let rerender = null;
const rerun = startRouter((route, { signal }) => {
  rerender = route.name;
  document.title = BRAND.name;
  shell.update(route);
  const view = views[route.name];
  if (!view) {
    mount(root, h('div', { class: 'empty' }, h('h2', null, 'Page not found'), h('a', { class: 'btn', href: '#/' }, 'Go home')));
    return;
  }
  window.scrollTo(0, 0);
  // Every navigation gets its own container. A view that is still waiting on the network after the user left
  // can then only write into a detached element, never into the page that replaced it.
  const viewRoot = h('div', { class: 'view' });
  mount(root, viewRoot);
  try { view({ root: viewRoot, route, signal }); } catch (e) {
    console.error(e);
    mount(viewRoot, h('div', { class: 'notice' }, h('h2', null, 'Something went wrong'), h('p', null, 'Reload the page to try again.')));
  }
});

// Accounts: find out who is signed in (and whether this site has accounts). Pages that show the library are drawn
// again when sync brings changes from another device; the admin page waits for the sign-in state.
account.init().then((st) => { if (st.user && rerender === 'admin') rerun(); });
document.addEventListener('rh:library-synced', () => { if (['home', 'list', 'history'].includes(rerender)) { const y = window.scrollY; rerun(); window.scrollTo(0, y); } });
