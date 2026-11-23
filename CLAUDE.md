# Formichina: regole per Claude

App web (PWA) di Marco Pigozzi per sapere ogni giorno quanto può spendere, senza collegare banca o carte.
Online su https://marcopigozzi99-prog.github.io/Formichina/ (GitHub Pages, ramo `main`, cartella principale).

## Come parlare con Marco
- Sempre in italiano, con parole semplici e senza gergo tecnico.
- Fatti separati dalle ipotesi. Se una cosa non l'hai provata, dillo: "non provato su un iPhone vero".
- Alla fine bastano poche righe: cosa è cambiato, dove lo vede, cosa deve provare lui.

## Regole fisse del progetto
- **Privacy prima di tutto**: niente collegamenti a banche o carte, niente analytics, niente servizi esterni nuovi senza il suo sì. I dati restano sul telefono. La sincronizzazione di coppia (Firebase) è facoltativa e cifrata sul telefono prima dell'invio: non indebolirla.
- **Struttura piatta**: tutti i file stanno nella cartella principale, senza sottocartelle, e si richiamano con percorsi relativi (`./app.js`). È una scelta voluta: non creare cartelle.
- **Niente build**: JavaScript, HTML e CSS semplici, senza framework né npm. Le icone sono generate dal logo `logo.svg`.
- **Aggiornamenti**: a ogni modifica pubblicata aumenta il numero di versione in `sw.js` (es. `formichina-v1.0.4` → `v1.0.5`), altrimenti i telefoni restano sulla versione vecchia.
- **Uso dal telefono**: campi di almeno 16 px (niente zoom automatico su iPhone), niente doppio tocco che ingrandisce, la tastiera non deve coprire i pulsanti, e nei campi giorno si usano menu a tendina.
- **Dati di esempio**: mai nomi veri di persone (per esempio quello della moglie di Marco) nei testi segnaposto o nei dati demo.
- **Firebase**: le regole sono in `firestore.rules`. Se le cambi, spiega a Marco cosa deve incollare nella console Firebase: non puoi farlo tu.

## Prima di dire "fatto"
1. Prova l'app con Playwright simulando iPhone e Android (`p.devices['iPhone 13']`, `p.devices['Pixel 7']`): apertura, onboarding, aggiunta di una spesa, budget di oggi, nessun errore nella console.
2. Controlla che il calcolo del budget giornaliero dia gli stessi numeri di prima, se non era quello da cambiare.
3. Fai uno screenshot delle schermate toccate e guardalo.

## Pubblicare
- **Piccole correzioni** chieste da Marco: dopo le prove, commit e push su `main`.
- **Funzioni nuove o cambi grafici grandi**: lavora in un ramo separato, mostra il risultato e pubblica su `main` solo quando Marco dice "Pubblica".
- Messaggi di commit in italiano.
- Dopo il push controlla che GitHub Pages abbia pubblicato: `gh run list -R marcopigozzi99-prog/Formichina -L 1` (ci vogliono 1-2 minuti).
- Mai password, chiavi o token nel repository.

## Dopo una decisione
Le scelte di Marco vanno riportate anche nel suo vault Obsidian "Second Brain" (nota del progetto in `03 - Progetti/` e `07 - Decisioni e Log/Registro decisioni.md`). Se il vault non risponde, scrivile in `rapporti/da-riportare-nel-vault.md` nel repository `ventoverde-magazzino`.
