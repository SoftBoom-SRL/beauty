// prenota/index.jsx — booking wizard (core flow), un passo alla volta (vedi
// steps.js): scelta → servizi (listino pubblico) → giorno, operatrice e orario
// (GET /api/agenda/client|public/availability, operatrici da
// /api/staff/public/operators) → riepilogo → [senza sessione: dati → codice
// via SMS] → POST /api/agenda/client/appointments → fine (con la caparra se il
// salone la chiede). Stato e azioni in usePrenota.js, un file per passo.
import { useApp } from '../../ctx.jsx';
import { ClientSubHead } from '../../components/ClientSubHead.jsx';
import { STEP } from './steps.js';
import { usePrenota } from './usePrenota.js';
import { renderChoice } from './StepChoice.jsx';
import { renderDetails } from './StepDetails.jsx';
import { renderDone } from './StepDone.jsx';
import { renderOtp } from './StepOtp.jsx';
import { renderReview } from './StepReview.jsx';
import { renderService } from './StepService.jsx';
import { renderTime } from './StepTime.jsx';

export default function Prenota() {
  const app = useApp();
  const b = usePrenota(app);
  const { brand, setView } = app;
  const { step, setStep, booked } = b;

  // «indietro» torna al passo prima (i numeri di STEP sono in ordine); dalla
  // scelta iniziale si esce alla home
  const head = (title) => (
    <ClientSubHead brand={brand} title={title} onBack={step <= STEP.CHOICE ? () => setView('home') : () => setStep(step - 1)} />
  );

  /* I passi sono funzioni che disegnano, chiamate qui, e non componenti:
   * così lo schermo resta un componente solo e, da un passo all'altro, React
   * riusa quello che resta al suo posto — l'intestazione, la barra dei passi
   * che si riempie con la sua transizione, il pulsante in fondo che sfuma fra
   * abilitato e disabilitato. Con un componente per passo si rifarebbe tutto
   * da capo a ogni passo, e quelle transizioni non si vedrebbero più. */
  const p = { ...app, ...b, head };
  if (step === STEP.DONE && booked) return renderDone(p);
  if (step === STEP.CHOICE) return renderChoice(p);
  if (step === STEP.SERVICE) return renderService(p);
  if (step === STEP.TIME) return renderTime(p);
  if (step === STEP.DETAILS) return renderDetails(p);
  if (step === STEP.OTP) return renderOtp(p);
  return renderReview(p);   // STEP.REVIEW
}
