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

// ─── STEP 1: fetch articles by category for variety ─────────────────────────
const CATEGORY_QUERIES = [
  { key: 'cronaca',      q: 'incidente OR omicidio OR indagini OR polizia' },
  { key: 'politica',     q: 'governo OR parlamento OR ministro OR premier' },
  { key: 'economia',     q: 'economia OR borsa OR azienda OR lavoro OR pil' },
  { key: 'sport',        q: 'calcio OR serie A OR tennis OR ciclismo OR motogp' },
  { key: 'spettacolo',   q: 'cinema OR musica OR festival OR attore OR cantante' },
  { key: 'cronaca_nera', q: 'processo OR condanna OR arrestato OR reato OR tribunale' },
];

async function fetchArticlesByCategory(date) {
  const seenUrls = new Set();
  const allArticles = [];

  for (const cat of CATEGORY_QUERIES) {
    const params = new URLSearchParams({
      domains: DOMAINS,
      q: cat.q,
      from: `${date}T00:00:00`,
      to:   `${date}T23:59:59`,
      language: 'it',
      sortBy: 'relevancy',
      pageSize: '10',
      apiKey: process.env.NEWSAPI_KEY,
    });

    const res = await fetch(`https://newsapi.org/v2/everything?${params}`);
    const data = await res.json();

    if (data.status === 'ok' && data.articles) {
      let added = 0;
      for (const a of data.articles) {
        if (a.url && !seenUrls.has(a.url) && a.title && a.title !== '[Removed]') {
          seenUrls.add(a.url);
          allArticles.push({ ...a, _suggestedCategory: cat.key });
          added++;
        }
      }
      console.log(`  [${cat.key}] ${added} articoli`);
    }
  }

  if (allArticles.length === 0) throw new Error('Nessun articolo trovato per questa data.');
  console.log(`  NewsAPI totale: ${allArticles.length} articoli unici da 6 categorie`);
  return allArticles;
}

// ─── STEP 2: generate questions with Gemini ──────────────────────────────────
async function generateQuestions(articles, date) {
  const label = formatLabel(date);

  // Pre-selezione deterministica: max 2 articoli per categoria → varietà garantita dal codice
  const perCat = {};
  const selected = articles
    .filter(a => a.title && a.title !== '[Removed]')
    .filter(a => {
      const cat = a._suggestedCategory || 'altro';
      perCat[cat] = (perCat[cat] || 0) + 1;
      return perCat[cat] <= 2;
    });

  const articleList = selected
    .map((a, i) => {
      const fonte = a.source?.name || a.url?.match(/([^/]+)\./)?.[1] || 'N/D';
      const desc = a.description ? `\n   ${a.description}` : '';
      const url = a.url ? `\n   URL: ${a.url}` : '';
      return `${i + 1}. [${a._suggestedCategory}][${fonte}] ${a.title}${desc}${url}`;
    })
    .join('\n\n');

  const prompt = `Sei un giornalista italiano esperto. Ecco le notizie italiane del ${label} estratte dalle principali testate, già selezionate e bilanciate per categoria:

${articleList}

Le storie sono già state selezionate: NON devi scegliere, devi generare le domande per TUTTE le storie elencate.

⚠️ ANTI-ALLUCINAZIONE: ogni storia nel JSON deve corrispondere ESATTAMENTE a uno degli URL forniti. NON inventare notizie. Il campo "url" deve essere copiato LETTERALMENTE dalla lista sopra senza alcuna modifica.

Genera esattamente 6 domande a risposta multipla in italiano per ogni storia:
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
- Il campo "url" deve essere copiato ESATTAMENTE dalla lista sopra, senza modifiche

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
    { model: 'gemini-2.0-flash-lite' },
    { generationConfig: { responseMimeType: 'application/json' } },
  );

  async function attempt(promptText) {
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try {
        const result = await model.generateContent(promptText);
        const raw = result.response.text().trim();
        try {
          return JSON.parse(raw);
        } catch (e) {
          fs.writeFileSync('raw_response.txt', raw);
          throw e;
        }
      } catch (e) {
        lastErr = e;
        const is503 = e.message && (e.message.includes('503') || e.message.includes('high demand') || e.message.includes('unavailable'));
        if (is503 && i < 2) {
          const wait = (i + 1) * 15000;
          console.warn(`  API 503 (tentativo ${i + 1}/3). Retry tra ${wait / 1000}s...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }

  let data;
  try {
    data = await attempt(prompt);
  } catch (e) {
    // Retry con meno storie per ridurre la dimensione dell'output
    console.warn('  JSON parse fallito. Retry con 10 storie...');
    const fallbackSelected = selected.slice(0, Math.min(selected.length, 10));
    const fallbackList = fallbackSelected
      .map((a, i) => {
        const fonte = a.source?.name || a.url?.match(/([^/]+)\./)?.[1] || 'N/D';
        const desc = a.description ? `\n   ${a.description}` : '';
        const url = a.url ? `\n   URL: ${a.url}` : '';
        return `${i + 1}. [${a._suggestedCategory}][${fonte}] ${a.title}${desc}${url}`;
      })
      .join('\n\n');
    const fallbackPrompt = prompt.replace(articleList, fallbackList);
    data = await attempt(fallbackPrompt);
    console.warn('  Retry ok (10 storie).');
  }

  return data;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function generate(date) {
  console.log(`\n[${new Date().toLocaleTimeString()}] Generating quiz for ${date}...`);

  // Skip if already generated (unless --force)
  const force = process.argv.includes('--force');
  const existing = await db.collection('quiz_days').doc(date).get();
  if (existing.exists && !force) {
    console.log(`✓ Quiz per ${date} già presente in Firestore. Skip.\n`);
    return;
  }
  if (existing.exists && force) {
    console.log(`  ⚠️ --force: sovrascrittura quiz per ${date}`);
  }

  // Step 1
  console.log('  Fetching articles from NewsAPI...');
  const articles = await fetchArticlesByCategory(date);

  // Step 2
  console.log('  Generating questions with Gemini...');
  const data = await generateQuestions(articles, date);

  // Step 3: URL validation — discard hallucinated stories
  const validUrls = new Set(articles.map(a => a.url).filter(Boolean));
  const before = data.stories.length;
  data.stories = data.stories.filter(s => {
    if (!s.url || !validUrls.has(s.url)) {
      console.warn(`  ⚠️ Scartata storia allucinata: "${s.titolo}" (URL non trovato nella lista)`);
      return false;
    }
    return true;
  });
  if (data.stories.length < before) {
    console.log(`  Validazione URL: ${before - data.stories.length} storie inventate rimosse, ${data.stories.length} valide`);
  }

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
