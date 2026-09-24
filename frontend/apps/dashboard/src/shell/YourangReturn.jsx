// YourangReturn.jsx — la metà di ritorno del passaggio yourang ↔ portale.
//
// Il movimento è una bolla: un cerchio ancorato appena dentro l'angolo in basso
// a destra, dove sta il pill. È un gesto solo diviso su due documenti:
//
//   andata    yourang apre il cerchio, copre, tiene il marchio e naviga ancora
//             coperto; QUI il telo si richiude sull'ancora e scopre la pagina
//   ritorno   QUI il telo apre il cerchio, copre, tiene il marchio e naviga
//             coperto; yourang si richiude sulla sua ancora
//
// I due documenti devono ancorare il cerchio nello STESSO punto, altrimenti le
// due metà smettono di leggersi come un gesto solo. L'ancora è
// `calc(100% - 2.5rem)` su entrambi gli assi: la stessa che usano
// yourang (web/src/app/globals.css) e il portale food. Non cambiarla da un lato
// solo — la geometria sta accanto ai keyframe in styles/yourang-return.css.
//
// Il telo è dipinto col brand di YOURANG e porta il suo logo, non quelli del
// salone: chi guarda il telo sta andando A yourang, quindi è yourang che deve
// annunciarsi.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT, Icon } from '@youty/shared';

// Dove torna il browser. Il fallback locale vale per `npm run dev`, la prod
// passa VITE_YOURANG_URL.
const YOURANG_URL = import.meta.env.VITE_YOURANG_URL || 'http://localhost:3000';

// Solo http(s) arriva mai a `location.assign`.
const SAFE_URL = /^https?:\/\//i;

// L'URL di ritorno, col marcatore che dice a yourang "stai ricevendo un
// passaggio, copri subito". Serve un marcatore e non il referrer: il referrer
// sopravvive a un reload, per cui dall'altra parte ogni refresh rigiocava
// l'animazione di arrivo. Costruito con `URL` e non per concatenazione:
// VITE_YOURANG_URL può già portare una query, e un `?` di troppo romperebbe il
// parametro.
const RETURN_URL = (() => {
  try {
    const u = new URL(YOURANG_URL);
    u.searchParams.set('yr_sweep', '1');
    return u.toString();
  } catch {
    // Un URL malformato non merita un modulo che esplode all'import: si torna
    // comunque a casa, solo senza animazione di arrivo.
    return YOURANG_URL;
  }
})();

// Il battito in cui si legge il marchio, a schermo coperto.
const HOLD_MS = 420;

// Se la navigazione non avviene, nessuno resta sotto il telo per sempre.
const NAVIGATION_TIMEOUT_MS = 3000;

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Una sola passata, in tre battiti: 'entering' ed 'exiting' sono animazioni e
// avanzano su `animationend`; 'holding' NON lo è — il pannello sta fermo a
// copertura piena — quindi avanza su timer. È l'asimmetria da ricordare: il CSS
// di reduced-motion accorcia le due fasi animate e non può toccare 'holding',
// perciò il timer viene azzerato qui.
export default function YourangReturn() {
  const { t } = useT();
  const [phase, setPhase] = useState('idle');
  const navigated = useRef(false);

  // Arrivo da yourang: il telo va ricreato già coperto e poi spazzato via.
  //
  // ponytail: il test è "referrer cross-origin", non "referrer == yourang".
  // Il pill di yourang può rimbalzare su altri salti prima di arrivare qui, e a
  // quel punto il referrer non è più yourang. Quindi questa rivelazione è
  // best-effort e in quel caso semplicemente non parte; il viaggio di ritorno
  // qui sotto invece è sempre affidabile perché parte da un click nostro.
  useEffect(() => {
    if (prefersReducedMotion()) return;
    try {
      if (
        document.referrer &&
        new URL(document.referrer).origin !== window.location.origin
      ) {
        setPhase('exiting');
      }
    } catch {
      // Un referrer malformato non merita un render che esplode.
    }
  }, []);

  // Ritorno col tasto Indietro: la pagina rientra dalla bfcache con l'heap JS
  // intatto, quindi col telo ANCORA dipinto sopra una dashboard perfettamente
  // usabile. Senza questo handler il portale spedisce un lock a schermo intero.
  useEffect(() => {
    const onPageShow = (event) => {
      if (!event.persisted) return;
      navigated.current = false;
      setPhase(prefersReducedMotion() ? 'idle' : 'exiting');
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  // Il battito del marchio, poi si naviga — sempre coperti.
  useEffect(() => {
    if (phase !== 'holding') return;
    const timer = window.setTimeout(() => {
      if (!SAFE_URL.test(YOURANG_URL) || navigated.current) return;
      navigated.current = true;
      window.location.assign(RETURN_URL);
    }, prefersReducedMotion() ? 0 : HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  // Valvola di sicurezza: una navigazione bloccata non lascia il telo lì.
  useEffect(() => {
    if (phase !== 'holding') return;
    const timer = window.setTimeout(() => setPhase('idle'), NAVIGATION_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const handleClick = useCallback((event) => {
    if (!SAFE_URL.test(YOURANG_URL)) return;
    event.preventDefault();

    // Stesso stato finale, nessun viaggio. Saltare del tutto il telo (invece di
    // renderlo senza animazione) è necessario: la sequenza avanza su
    // `animationend`, che senza animazione non scatta mai.
    if (prefersReducedMotion()) {
      window.location.assign(RETURN_URL);
      return;
    }
    setPhase('entering');
  }, []);

  const handleSweepEnd = useCallback(() => {
    if (phase === 'entering') { setPhase('holding'); return; }
    if (phase === 'exiting') setPhase('idle');
  }, [phase]);

  return (
    <>
      <a
        href={RETURN_URL}
        onClick={handleClick}
        aria-label={t('Torna a yourang', 'Back to yourang')}
        className="yr-return-pill press"
      >
        <Icon name="scissors" size={16} />
        <span>{t('Torna a yourang', 'Back to yourang')}</span>
      </a>

      {phase !== 'idle' && (
        <div
          className="yr-sweep"
          data-phase={phase}
          onAnimationEnd={handleSweepEnd}
          aria-hidden="true"
        >
          {/* Variante "accent": testo bianco con pittogramma e ".ai" a
              gradiente. Il tutto-bianco su indigo appiattisce il marchio, e la
              variante scura avrebbe il testo nero — illeggibile qui. */}
          <img src="/yourang-logo-accent.png" alt="" className="yr-sweep__mark" />
        </div>
      )}

      <span role="status" aria-live="polite" className="sr-only">
        {phase === 'entering' || phase === 'holding'
          ? t('Apertura di yourang…', 'Opening yourang…')
          : ''}
      </span>
    </>
  );
}
