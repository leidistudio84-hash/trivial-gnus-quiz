require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');
const fs = require('fs');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
admin.initializeApp({ credential: admin.credential.cert(require('./serviceAccount.json')) });
const db = admin.firestore();

const DOMAINS = [
  'corriere.it',
  'repubblica.it',
  'ilfattoquotidiano.it',
  'lastampa.it',
  'ilmessaggero.it',
  'ilgiornale.it',
  'ilsole24ore.com',
  'gazzetta.it',
  'corrieredellosport.it',
  'tgcom24.mediaset.it',
].join(',');

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

function formatLabel(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

// ─── STEP 1: fetch real articles from NewsAPI ────────────────────────────────
async function fetchArticles(date) {
  const params = new URLSearchParams({
    domains: DOMAINS,
    from: `${date}T00:00:00`,
    to:   `${date}T23:59:59`,
    language: 'it',
    sortBy: 'popularity',
    pageSize: '50',
    apiKey: process.env.NEWSAPI_KEY,
  });

  const res = await fetch(`https://newsapi.org/v2/everything?${params}`);
  const data = await res.json();

  if (data.status !== 'ok') throw new Error(`NewsAPI error: ${data.message}`);
  if (!data.articles || data.articles.length === 0) throw new Error('Nessun articolo trovato per questa data.');

  console.log(`  NewsAPI: ${data.articles.length} articoli trovati`);
  return data.articles;
}

// ─── STEP 2: generate questions with Gemini ──────────────────────────────────
async function generateQuestions(articles, date) {
  const label = formatLabel(date);

  // Cap per fonte: max 5 articoli per testata, così nessuna domina
  const perSource = {};
  const capped = articles
    .filter(a => a.title && a.title !== '[Removed]')
    .filter(a => {
      const src = a.source?.name || 'unknown';
      perSource[src] = (perSource[src] || 0) + 1;
      return perSource[src] <= 5;
    })
    .slice(0, 50);

  const articleList = capped
    .map((a, i) => {
      const fonte = a.source?.name || a.url?.match(/([^/]+)\./)?.[1] || 'N/D';
      const desc = a.description ? `\n   ${a.description}` : '';
      const url = a.url ? `\n   URL: ${a.url}` : '';
      return `${i + 1}. [${fonte}] ${a.title}${desc}${url}`;
    })
    .join('\n\n');

  const prompt = `Sei un giornalista italiano esperto. Ecco le notizie italiane del ${label} estratte dalle principali testate:

${articleList}

STEP 1 — Seleziona le 12 notizie più rilevanti tra quelle elencate sopra. Scegli storie di categorie diverse (cronaca, politica, sport, cronaca_nera, spettacolo, economia). Usa SOLO notizie presenti nella lista.

STEP 2 — Per ogni notizia selezionata genera esattamente 6 domande a risposta multipla in italiano:
- Domanda 1: CHI è il protagonista/soggetto principale
- Domanda 2: COSA è successo esattamente
- Domanda 3: DOVE si è svolto il fatto
- Domanda 4: PERCHÉ è successo / contesto
- Domanda 5: un dettaglio specifico (numero, cifra, dichiarazione)
- Domanda 6: una conseguenza o sviluppo successivo

REGOLE:
- Ogni domanda ha esattamente 4 opzioni (A, B, C, D), una sola corretta
- Le 3 risposte errate devono essere plausibili e dello stesso tipo della corretta
- Il testo della domanda non deve contenere la risposta
- Basa le domande SOLO su ciò che è scritto nella notizia fornita

Rispondi ESCLUSIVAMENTE con JSON valido. Zero testo prima o dopo. Zero markdown. Solo JSON grezzo:

{
  "date": "${date}",
  "stories": [
    {
      "id": 1,
      "titolo": "Titolo conciso max 10 parole",
      "riassunto": "2-3 righe che spiegano la notizia",
      "categoria": "cronaca",
      "fonti": ["Corriere della Sera"],
      "url": "https://www.corriere.it/...",
      "questions": [
        {"id": "1_1", "tipo": "chi",         "testo": "Domanda?", "opzioni": ["A", "B", "C", "D"], "corretta": 0},
        {"id": "1_2", "tipo": "cosa",        "testo": "Domanda?", "opzioni": ["A", "B", "C", "D"], "corretta": 0},
        {"id": "1_3", "tipo": "dove",        "testo": "Domanda?", "opzioni": ["A", "B", "C", "D"], "corretta": 0},
        {"id": "1_4", "tipo": "perche",      "testo": "Domanda?", "opzioni": ["A", "B", "C", "D"], "corretta": 0},
        {"id": "1_5", "tipo": "dettaglio",   "testo": "Domanda?", "opzioni": ["A", "B", "C", "D"], "corretta": 0},
        {"id": "1_6", "tipo": "conseguenza", "testo": "Domanda?", "opzioni": ["A", "B", "C", "D"], "corretta": 0}
      ]
    }
  ]
}`;

  const model = genAI.getGenerativeModel(
    { model: 'gemini-3.5-flash-lite' },
    { generationConfig: { responseMimeType: 'application/json' } },
  );

  async function attempt(promptText) {
    const result = await model.generateContent(promptText);
    const raw = result.response.text().trim();
    try {
      return JSON.parse(raw);
    } catch (e) {
      fs.writeFileSync('raw_response.txt', raw);
      throw e;
    }
  }

  let data;
  try {
    data = await attempt(prompt);
  } catch (e) {
    // Retry con 10 storie per ridurre l'output
    console.warn('  JSON parse fallito. Retry con 10 storie...');
    const fallbackPrompt = prompt.replace(
      'Seleziona le 12 notizie più rilevanti',
      'Seleziona le 10 notizie più rilevanti',
    );
    data = await attempt(fallbackPrompt);
    console.warn('  Retry ok (10 storie).');
  }

  return data;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function generate(date) {
  console.log(`\n[${new Date().toLocaleTimeString()}] Generating quiz for ${date}...`);

  // Skip if already generated
  const existing = await db.collection('quiz_days').doc(date).get();
  if (existing.exists) {
    console.log(`✓ Quiz per ${date} già presente in Firestore. Skip.\n`);
    return;
  }

  // Step 1
  console.log('  Fetching articles from NewsAPI...');
  const articles = await fetchArticles(date);

  // Step 2
  console.log('  Generating questions with Gemini...');
  const data = await generateQuestions(articles, date);

  const totalQ = data.stories.reduce((n, s) => n + (s.questions?.length || 0), 0);
  data.generated_at = new Date().toISOString();
  data.total_questions = totalQ;

  // Save
  await db.collection('quiz_days').doc(date).set(data);
  const filename = `quiz_${date}.json`;
  fs.writeFileSync(filename, JSON.stringify(data, null, 2));

  console.log(`\n✓ ${data.stories.length} storie · ${totalQ} domande`);
  console.log(`✓ Firestore: quiz_days/${date}`);
  console.log(`✓ Backup: ${filename}\n`);
}

const date = process.argv[2] || yesterday();

if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('Formato data non valido. Usa YYYY-MM-DD');
  process.exit(1);
}

generate(date).catch(err => { console.error('Errore:', err.message); process.exit(1); });
