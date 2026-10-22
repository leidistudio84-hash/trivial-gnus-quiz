// Genera quiz per tutti i giorni degli ultimi 30 giorni
// Salta i giorni già presenti in Firestore (idempotente)
// Uso: node generate_archive.js

const { execSync } = require('child_process');
const path = require('path');

const DELAY_MS = 10000; // 10s tra una chiamata e l'altra
const DAYS_BACK = 30;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getDates() {
  const dates = [];
  for (let i = DAYS_BACK; i >= 1; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}

async function run() {
  const dates = getDates();
  console.log(`\nArchivio: ${dates.length} giorni da generare`);
  console.log(`Dal ${dates[0]} al ${dates[dates.length - 1]}\n`);

  let ok = 0, skipped = 0, errors = 0;

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    console.log(`[${i + 1}/${dates.length}] ${date}`);

    try {
      execSync(
        `node "${path.join(__dirname, 'generate_quiz.js')}" ${date}`,
        { stdio: 'inherit', cwd: __dirname }
      );
      ok++;
    } catch (e) {
      console.error(`  ✗ Errore per ${date}: ${e.message}`);
      errors++;
    }

    if (i < dates.length - 1) {
      process.stdout.write(`  Attendo ${DELAY_MS / 1000}s...\n`);
      await sleep(DELAY_MS);
    }
  }

  console.log(`\n─────────────────────────────`);
  console.log(`✓ Generati:  ${ok}`);
  console.log(`⊘ Skippati:  ${skipped} (già presenti)`);
  console.log(`✗ Errori:    ${errors}`);
  console.log(`─────────────────────────────\n`);
}

run().catch(err => {
  console.error('Errore fatale:', err.message);
  process.exit(1);
});
