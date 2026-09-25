// ViewSelector — Giorno / Settimana / Mese nella barra (anche coi tasti G, S, M).
// Con la barra stretta i tre bottoni lasciano il posto a un menu (vedi i gradini
// di .dk-agbar in agenda.css): tutti e due restano nella pagina, il CSS sceglie.

const VIEWS = [['day', 'Giorno', 'Day', 'G'], ['week', 'Settimana', 'Week', 'S'], ['month', 'Mese', 'Month', 'M']];

export default function ViewSelector({ calView, setCalView, t }) {
  return (
    <>
      <div className="dk-agseg dk-ag-t3" role="group" aria-label={t('Vista', 'View')}>
        {VIEWS.map(([v, it, en, key]) => (
          <button key={v} onClick={() => setCalView(v)} aria-pressed={calView === v} title={t(`${it} (${key})`, `${en} (${key})`)}>{t(it, en)}</button>
        ))}
      </div>
      {/* scelta la vista il fuoco lascia il menu: se no le frecce cambiavano
          ancora vista invece di sfogliare, e T non faceva niente */}
      <select className="dk-agselect dk-ag-t3only" value={calView} onChange={(e) => { setCalView(e.target.value); e.target.blur(); }} aria-label={t('Vista', 'View')}>
        {VIEWS.map(([v, it, en]) => <option key={v} value={v}>{t(it, en)}</option>)}
      </select>
    </>
  );
}
