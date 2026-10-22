require('dotenv').config();
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

admin.initializeApp({ credential: admin.credential.cert(require('./serviceAccount.json')) });
const db = admin.firestore();

async function clearArchive() {
  console.log('\nLettura documenti in quiz_days...');
  const snapshot = await db.collection('quiz_days').get();

  if (snapshot.empty) {
    console.log('Collection già vuota.');
  } else {
    console.log(`Trovati ${snapshot.size} documenti. Eliminazione in corso...`);
    const batch = db.batch();
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    console.log(`✓ ${snapshot.size} documenti eliminati da Firestore.`);
  }

  // Elimina i backup JSON locali
  const files = fs.readdirSync(__dirname).filter(f => /^quiz_\d{4}-\d{2}-\d{2}\.json$/.test(f));
  if (files.length === 0) {
    console.log('Nessun file JSON locale da eliminare.');
  } else {
    files.forEach(f => fs.unlinkSync(path.join(__dirname, f)));
    console.log(`✓ ${files.length} file JSON locali eliminati.`);
  }

  console.log('\nArchivio pulito. Ora esegui: node generate_archive.js\n');
}

clearArchive().catch(err => { console.error('Errore:', err.message); process.exit(1); });
