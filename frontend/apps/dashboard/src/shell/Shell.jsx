// Shell.jsx — la cornice della dashboard: barra laterale, barra in alto, la
// sezione attiva e i contenitori globali (toast, modali, drawer).
import { Suspense, lazy, useState } from 'react';
import { EmptyState, Icon } from '@youty/shared';
import { useDash } from '../ctx.jsx';
import { SECTIONS } from '../sections/registry.js';
import DkModals from '../modals/DkModals.jsx';
import { DkToast, DkDrawer } from '../ui/index.js';
import Sidebar from './Sidebar.jsx';
import Topbar from './Topbar.jsx';
import ChunkErrorBoundary from './ChunkErrorBoundary.jsx';
import YourangReturn from './YourangReturn.jsx';

const AnalystDrawer = lazy(() => import('../sections/insight/AnalystDrawer.jsx'));

export default function Shell() {
  const { tab, drawer, setDrawer, toastProps, t, lang, hasScope, fireToast } = useDash();

  /* Finché non la si sceglie, sotto i 1366 px (portatili piccoli, iPad in
   * orizzontale) la barra laterale parte compressa: aperta si prendeva 252 px
   * e l'agenda andava a capo o scorreva di lato. Scelta una volta, resta. */
  const [sideCollapsed, setSideCollapsed] = useState(() => {
    try {
      const v = localStorage.getItem('dk-side-collapsed');
      if (v !== null) return v === '1';
    } catch { /* ignore */ }
    return window.innerWidth < 1366;
  });
  // si salva solo la scelta fatta col bottone: il valore di partenza segue lo schermo
  const toggleSide = () => {
    const next = !sideCollapsed;
    setSideCollapsed(next);
    try { localStorage.setItem('dk-side-collapsed', next ? '1' : '0'); } catch { /* ignore */ }
  };

  const Section = SECTIONS[tab];

  return (
    <div className={'dk-root' + (sideCollapsed ? ' dk-side-collapsed' : '')}>
      <Sidebar collapsed={sideCollapsed} onToggleCollapse={toggleSide} />

      <div className="dk-main">
        <Topbar />
        <div className="dk-content" key={tab}>
          {/* Un chunk che non si carica (deploy nel frattempo) o un errore di
              rendering restano confinati alla sezione: prima smontavano tutto. */}
          <ChunkErrorBoundary t={t} variant="page">
            <Suspense fallback={<SectionSkeleton />}>
              {Section
                ? <Section />
                : <div className="dk-page"><EmptyState icon="sparkle" title={tab} sub="—" /></div>}
            </Suspense>
          </ChunkErrorBoundary>
        </div>
      </div>

      {/* FAB dell'assistente, su ogni pagina — «Chiedi a Youty» risponde a chi vede l'Analisi dati:
          il titolare o chi ha il permesso «Analisi dati» (contratto C11) */}
      {hasScope('insights') && (
        <button
          type="button"
          className="press"
          aria-label={t('Chiedi a Youty', 'Ask Youty')}
          title={t('Chiedi a Youty', 'Ask Youty')}
          onClick={() => setDrawer(
            <ChunkErrorBoundary t={t} variant="inline">
              <Suspense fallback={null}>
                <AnalystDrawer t={t} lang={lang} fireToast={fireToast} onClose={() => setDrawer(null)} />
              </Suspense>
            </ChunkErrorBoundary>
          )}
          style={{
            position: 'fixed', right: 22, bottom: 74, zIndex: 40,
            width: 52, height: 52, borderRadius: '50%', border: 'none', cursor: 'pointer',
            background: 'linear-gradient(135deg, var(--clay), color-mix(in srgb, var(--clay) 60%, #7c6cf0))',
            color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: 'var(--shadow-lg, 0 10px 28px rgba(0,0,0,.22))',
          }}
        >
          <Icon name="sparkle" size={22} />
        </button>
      )}

      {/* ritorno a yourang: pill in basso a destra + telo a bolla.
          Sta all'ancora del cerchio, per questo il FAB qui sopra è a bottom 74. */}
      <YourangReturn />

      {/* toast, modali e drawer di tutta l'app */}
      <DkToast {...toastProps} />
      <DkModals />
      <DkDrawer open={!!drawer} onClose={() => setDrawer(null)}>{drawer}</DkDrawer>
    </div>
  );
}

function SectionSkeleton() {
  return (
    <div className="dk-page">
      <div className="skel" style={{ height: 26, width: 260, marginBottom: 18 }} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 22 }}>
        {[...Array(3)].map((_, i) => <div key={i} className="skel" style={{ height: 90, borderRadius: 16 }} />)}
      </div>
      <div className="skel" style={{ height: 320, borderRadius: 16 }} />
    </div>
  );
}
