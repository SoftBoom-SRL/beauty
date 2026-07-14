// app.jsx — shell, context, navigation, tweaks
const { useState: useStateApp, useEffect: useEffectApp, useRef: useRefApp } = React;

/* ---- color utils for white-label theming ---- */
function hex2rgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
function mix(h, t, amt) { const a = hex2rgb(h), b = hex2rgb(t); return '#' + a.map((x, i) => Math.round(x + (b[i] - x) * amt).toString(16).padStart(2, '0')).join(''); }
const darken = h => mix(h, '#000000', 0.28);
const tintOf = h => mix(h, '#ffffff', 0.86);

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "lang": "it",
  "parlourAccent": "#6366F1",
  "clientType": "serif"
}/*EDITMODE-END*/;

function Placeholder({ name }) {
  return <div style={{ paddingTop: 'calc(var(--safe-top) + 30px)' }}><EmptyState icon="sparkle" title={name} sub="In costruzione" /></div>;
}

function App() {
  const [tw, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const lang = tw.lang;
  const t = (it, en) => (lang === 'en' ? en : it);
  const [appts, setAppts] = useStateApp(window.APPTS);
  const [toast, setToast] = useStateApp(null);
  const toastUndo = useRefApp(null);
  const fireToast = (obj) => { toastUndo.current = obj.undoFn || null; setToast(obj); };

  const bootShot = (typeof localStorage !== 'undefined' && localStorage.getItem('yrshot')) || null;
  const brand = { color: tw.parlourAccent, ink: darken(tw.parlourAccent), tint: tintOf(tw.parlourAccent), type: tw.clientType };

  const ctx = { t, lang, setLang: v => setTweak('lang', v), brand, appts, setAppts, fireToast, shot: bootShot,
    setParlourAccent: v => setTweak('parlourAccent', v), setClientType: v => setTweak('clientType', v) };

  return (
    <AppCtx.Provider value={ctx}>
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '20px 16px', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontWeight: 800, fontSize: 19, letterSpacing: '-0.02em', color: 'var(--ink)' }}>yourang</span>
          <span style={{ width: 6, height: 6, borderRadius: 99, background: 'var(--clay)', display: 'inline-block' }} />
          <span className="t-sm" style={{ color: 'var(--muted)', marginLeft: 4 }}>{t('app cliente', 'client app')}</span>
        </div>

        <IOSDevice>
          <div style={{ position: 'relative', height: '100%', background: 'var(--paper)', overflow: 'hidden' }}>
            {window.ClientApp ? <window.ClientApp /> : <Placeholder name="The Parlour" />}
            <Toast toast={toast} onUndo={() => { toastUndo.current && toastUndo.current(); setToast(null); }} onDone={() => setToast(null)} />
          </div>
        </IOSDevice>

        <div className="t-sm" style={{ color: 'var(--muted)', textAlign: 'center', maxWidth: 380 }}>
          {t('Prototipo · web app cliente, brandizzata The Parlour', 'Prototype · client web app, branded as The Parlour')}
        </div>

        <TweaksPanel>
          <TweakSection label={t('Lingua', 'Language')} />
          <TweakRadio label={t('Lingua contenuti', 'Content language')} value={lang} options={[{ value: 'it', label: 'Italiano' }, { value: 'en', label: 'English' }]} onChange={v => setTweak('lang', v)} />
          <TweakSection label={t('White-label cliente', 'Client white-label')} />
          <TweakColor label={t('Accento The Parlour', 'The Parlour accent')} value={tw.parlourAccent} options={['#6366F1', '#7C4A57', '#3E5C4B', '#1F1F21', '#5E748C']} onChange={v => setTweak('parlourAccent', v)} />
          <TweakRadio label={t('Tipografia cliente', 'Client type')} value={tw.clientType} options={[{ value: 'serif', label: t('Editoriale', 'Editorial') }, { value: 'grotesk', label: t('Pulita', 'Clean') }]} onChange={v => setTweak('clientType', v)} />
        </TweaksPanel>
      </div>
    </AppCtx.Provider>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
