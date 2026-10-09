// Sincronizzazione opzionale tra telefoni: i dati vengono cifrati sul dispositivo (AES-GCM)
// prima di arrivare su Firebase. Google conserva solo un blocco illeggibile.
import { sha256Hex } from './util.js';

const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';
const enc = new TextEncoder();
const dec = new TextDecoder();

const toB64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function streamBytes(bytes, Stream) {
  const s = new Blob([bytes]).stream().pipeThrough(new Stream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

export async function deriveSecret(passphrase) {
  const docId = (await sha256Hex('formichina-doc:' + passphrase)).slice(0, 40);
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('formichina-salt-v1:' + docId), iterations: 310000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
  );
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  return { docId, keyB64: toB64(raw) };
}

const importKey = (keyB64) => crypto.subtle.importKey('raw', fromB64(keyB64), 'AES-GCM', false, ['encrypt', 'decrypt']);

export async function encryptState(state, keyB64) {
  const key = await importKey(keyB64);
  let bytes = enc.encode(JSON.stringify(state));
  let flag = 0;
  if ('CompressionStream' in globalThis) { bytes = await streamBytes(bytes, CompressionStream); flag = 1; }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(1 + iv.length + ct.length);
  out[0] = flag; out.set(iv, 1); out.set(ct, 13);
  return toB64(out);
}

export async function decryptState(b64, keyB64) {
  const key = await importKey(keyB64);
  const all = fromB64(b64);
  const flag = all[0];
  const iv = all.subarray(1, 13);
  let bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, all.subarray(13)));
  if (flag === 1) bytes = await streamBytes(bytes, DecompressionStream);
  return JSON.parse(dec.decode(bytes));
}

export function parseFirebaseConfig(text) {
  // accetta sia JSON puro sia lo snippet "const firebaseConfig = { apiKey: "..." ... }"
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Non trovo la configurazione tra parentesi graffe');
  let body = m[0];
  try { return JSON.parse(body); } catch { /* prova a convertire lo snippet JS */ }
  body = body.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":').replace(/'/g, '"').replace(/,\s*}/g, '}');
  const cfg = JSON.parse(body);
  if (!cfg.apiKey || !cfg.projectId) throw new Error('Mancano apiKey o projectId');
  return cfg;
}

export class Sync {
  constructor({ deviceId, onRemote, onStatus }) {
    this.deviceId = deviceId;
    this.onRemote = onRemote;
    this.onStatus = onStatus || (() => {});
    this.ref = null;
    this.unsub = null;
    this.lastPushed = null;
    this.pushing = Promise.resolve();
  }

  async start({ config, docId, keyB64 }) {
    this.keyB64 = keyB64;
    this.onStatus('connessione…');
    const [appMod, authMod, fsMod] = await Promise.all([
      import(FB + 'firebase-app.js'), import(FB + 'firebase-auth.js'), import(FB + 'firebase-firestore.js'),
    ]);
    this.fs = fsMod;
    const name = 'formichina';
    const app = appMod.getApps().find((a) => a.name === name) || appMod.initializeApp(config, name);
    const auth = authMod.getAuth(app);
    if (!auth.currentUser) await authMod.signInAnonymously(auth);
    const db = fsMod.getFirestore(app);
    this.ref = fsMod.doc(db, 'budgets', docId);
    this.unsub = fsMod.onSnapshot(this.ref, (snap) => this.handle(snap), (err) => this.onStatus('errore: ' + err.code));
    this.onStatus('attiva');
  }

  async handle(snap) {
    if (!snap.exists()) { this.onRemote(null); return; }
    const d = snap.data();
    if (d.data === this.lastPushed) return;
    try {
      const remote = await decryptState(d.data, this.keyB64);
      this.onRemote(remote);
      this.onStatus('aggiornata ' + new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }));
    } catch {
      this.onStatus('errore: frase segreta diversa da quella del partner');
    }
  }

  push(state) {
    this.pushing = this.pushing.then(async () => {
      if (!this.ref) return;
      const data = await encryptState(state, this.keyB64);
      if (data.length > 1000000) { this.onStatus('errore: dati troppo grandi, esporta e archivia i movimenti vecchi'); return; }
      this.lastPushed = data;
      await this.fs.setDoc(this.ref, { data, by: this.deviceId, v: 1, updatedAt: this.fs.serverTimestamp() });
      this.onStatus('salvata ' + new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }));
    }).catch((e) => this.onStatus('errore: ' + (e.code || e.message)));
    return this.pushing;
  }

  stop() { if (this.unsub) this.unsub(); this.unsub = null; this.ref = null; }
}
