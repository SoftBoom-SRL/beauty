// Utility.jsx — floating top utility bar: language toggle + logout.
import React from 'react';
import { Icon, clientAuth } from '@youty/shared';
import { useApp } from './ctx.jsx';

export default function Utility() {
  const { t, lang, setLang, fireToast, session, openAuth } = useApp();
  const btnCss = {
    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', borderRadius: 99,
    background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(8px)', fontSize: 12, fontWeight: 700,
    color: 'var(--ink)', boxShadow: 'var(--sh-sm)', border: 'none', cursor: 'pointer',
  };
  return (
    <div style={{ position: 'absolute', top: 'calc(var(--safe-top) - 4px)', right: 14, zIndex: 65, display: 'flex', gap: 8 }}>
      <button className="press" onClick={() => setLang(lang === 'it' ? 'en' : 'it')} style={btnCss}>
        <Icon name="globe" size={14} />{lang.toUpperCase()}
      </button>
      {session ? (
        <button className="press" title={t('Esci', 'Log out')}
          onClick={() => { clientAuth.logout(); fireToast({ msg: t('Sei uscita dal profilo', 'Logged out'), icon: 'check' }); }}
          style={btnCss}>
          <Icon name="x" size={14} />
        </button>
      ) : (
        <button className="press" onClick={() => openAuth()} style={btnCss}>
          <Icon name="user" size={14} />{t('Accedi', 'Sign in')}
        </button>
      )}
    </div>
  );
}
