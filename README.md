# Formichina

Web app (PWA) per sapere ogni giorno **quanto puoi spendere**, senza collegare banca o carte.
I dati restano nel browser del telefono. Nessun account, nessun server obbligatorio.

## Cosa fa

- **Budget di oggi**: entrate del ciclo − spese fisse − accantonamenti − risparmio − spese già fatte, diviso i giorni che mancano allo stipendio. Se oggi spendi meno, domani hai di più; se sfori, la differenza si spalma sui giorni seguenti.
- **Ciclo dello stipendio** (es. dal 27 al 26), non il mese solare.
- **Spese ed entrate fisse** che si registrano da sole (mensili, bimestrali, trimestrali, semestrali, annuali).
- **Buste**: limite per categoria con indicatore di dove dovresti essere oggi.
- **Accantonamenti** per le spese annuali (assicurazione, bollo, regali): la quota per ciclo è calcolata in automatico e le spese pagate da lì non toccano il budget giornaliero.
- **Obiettivi di risparmio** con quota fissa e suggerimento per arrivare in tempo.
- **Statistiche**: giorno per giorno, categorie, ultimi 6 cicli, giorno della settimana, chi ha speso.
- **Import CSV** dall'home banking (letto solo sul telefono), con regole di categorizzazione e controllo dei duplicati.
- **Coppia**: più persone, e sincronizzazione facoltativa **cifrata sul telefono** tramite Firebase.
- Backup JSON, export CSV per Excel, blocco con PIN, tema chiaro/scuro, funziona offline, promemoria serale nel calendario.

## Pubblicare su GitHub Pages (come il ricettario)

1. Su GitHub crea un nuovo repository, ad esempio `Formichina` (pubblico).
2. **Add file → Upload files**: trascina *tutto il contenuto* di questa cartella (`index.html`, `styles.css`, `sw.js`, `manifest.webmanifest`, `firestore.rules`, le cartelle `js/` e `icons/`). Poi **Commit changes**.
3. **Settings → Pages → Branch: `main` / root → Save**.
4. Dopo un minuto l'app è su `https://<tuo-utente>.github.io/Formichina/`.

Il repository contiene solo il codice: i tuoi dati non finiscono mai su GitHub.

### Installarla sul telefono
- **iPhone**: apri il link in Safari → Condividi → *Aggiungi alla schermata Home*.
- **Android**: apri in Chrome → menu ⋮ → *Installa app*.

Installarla è importante: su iPhone, Safari può cancellare i dati dei siti non aperti per settimane, ma non quelli delle app aggiunte alla Home. In *Altro → Dati* tocca anche "Proteggi i dati dalla pulizia del browser".

### Aggiornare l'app
Carica i file modificati e cambia il numero in `sw.js` (`const VERSION = 'formichina-v1.0.1'`). Al riavvio successivo l'app si aggiorna.

## Sincronizzazione di coppia (facoltativa)

1. Su [console.firebase.google.com](https://console.firebase.google.com) usa il progetto del ricettario o creane uno nuovo.
2. **Authentication → Metodo di accesso → Anonimo → Attiva**.
3. **Firestore Database → Regole**: aggiungi il blocco `match /budgets/{docId}` del file `firestore.rules` (senza cancellare le regole del ricettario) e pubblica.
4. **Impostazioni progetto → Le tue app → Web**: copia l'oggetto `firebaseConfig`.
5. Nell'app: *Altro → Sincronizzazione di coppia → Configura*, incolla la configurazione e scegli una frase segreta (almeno 12 caratteri). Ripeti sull'altro telefono con **la stessa frase**.

Come funziona: la frase genera sul telefono una chiave AES-256 (PBKDF2, 310.000 iterazioni) e il nome del documento. I dati vengono compressi e cifrati prima dell'invio; Firebase conserva solo un blocco illeggibile. Se perdete la frase, i dati sul cloud non si recuperano (restano quelli sui telefoni). Le modifiche si uniscono voce per voce: vince quella più recente.

## Scorciatoie
Aprire `.../Formichina/?action=add&amount=4,50&cat=Bar e ristoranti&note=Caffè` apre il modulo già compilato: utile con Comandi Rapidi di iPhone o un widget Android.

## Struttura
| File | Contenuto |
| --- | --- |
| `js/calc.js` | ciclo, voci fisse, quote di accantonamento, budget giornaliero, statistiche |
| `js/store.js` | dati, salvataggio in IndexedDB, unione per la sync, dati di esempio |
| `js/app.js` | interfaccia |
| `js/csv.js` | lettura estratti conto |
| `js/sync.js` | cifratura e Firebase |
| `js/charts.js` | grafici SVG |

Importi salvati in centesimi interi; nessuna libreria esterna (Firebase si carica solo se attivi la sync).
