// UndoButton — «Indietro» nella barra: annulla l'ultimo gesto di chi guarda
// (la pila del «torna indietro», vedi useUndo). Sta sempre allo stesso posto,
// e non compare e scompare: chi ha appena sbagliato un gesto deve trovarlo
// dove si aspetta, non cercarlo. Spento quando non c'è niente da annullare,
// con l'ultima azione scritta nel suggerimento.
import { Icon } from '@youty/shared';

export default function UndoButton({ undoStack, undoing, undoLast, t }) {
  return (
    <button
      className="dk-agbtn dk-agbtn--quiet dk-agbtn--icon-narrow"
      disabled={!undoStack.length || undoing}
      onClick={() => undoLast(undoStack[0]?.id)}
      aria-label={t('Torna indietro', 'Undo')}
      title={(undoStack[0]
        ? t(`Torna indietro · ${undoStack[0].label}`, `Undo · ${undoStack[0].label}`)
        : t('Niente da annullare', 'Nothing to undo')) + '  (⌘Z)'}
    >
      <Icon name="undo" size={16} /><span className="dk-ag-lbl">{t('Indietro', 'Undo')}</span>
    </button>
  );
}
