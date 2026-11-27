const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const sa = require('./serviceAccount.json');
initializeApp({ credential: cert(sa) });
const db = getFirestore();

const DATE = process.argv[2] || '2026-10-27';

db.collection('quiz_days').doc(DATE).get().then(doc => {
  if (!doc.exists) { console.log(`Nessun quiz per ${DATE}`); process.exit(0); }
  const data = doc.data();
  const stories = data.stories || [];

  console.log(`\n📰 Quiz ${DATE} — ${stories.length} storie\n`);

  let totDom = 0;
  const byCat = {};

  stories.forEach((s, i) => {
    const cat = s.categoria || s.category || '(no cat)';
    const nDom = (s.questions || []).length;
    totDom += nDom;
    if (!byCat[cat]) byCat[cat] = { storie: 0, domande: 0 };
    byCat[cat].storie++;
    byCat[cat].domande += nDom;

    const title = (s.titolo || s.title || s.headline || '').slice(0, 70);
    const fonti = Array.isArray(s.fonti) ? s.fonti.join(', ') : (s.source || s.url || '?');
    console.log(`  ${String(i+1).padStart(2)}. [${cat}] ${title}`);
    console.log(`      ${nDom} domande | fonte: ${fonti}`);
  });

  console.log(`\n📊 Per categoria:`);
  for (const [cat, v] of Object.entries(byCat).sort((a,b) => b[1].storie - a[1].storie)) {
    console.log(`   ${cat.padEnd(20)} storie: ${v.storie}  domande: ${v.domande}`);
  }
  console.log(`\n   TOTALE: ${stories.length} storie, ${totDom} domande`);
  process.exit(0);
});
