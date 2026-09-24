"""Costanti dell'integrazione Yourang che servono a più moduli.

Il nome del segnaposto delle prenotazioni importate lo usano la sync, che lo
crea, e i ricevitori che lo tengono idoneo per ogni operatrice (signals.py):
stava in sync.py, e signals.py caricava all'avvio l'intera sync — e con lei i
servizi dell'agenda — per leggere un nome. La migrazione 0007 ne ha una copia
sua, come ogni migrazione.
"""

# Nome del servizio segnaposto delle prenotazioni importate (non è un servizio
# del listino: esiste solo perché un evento Yourang non porta un servizio nostro).
PLACEHOLDER_SERVICE_NAME = "Prenotazione Yourang"
