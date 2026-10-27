# rigenera_archivio.ps1
# Rigenera i quiz dal 28 settembre al 26 ottobre con le nuove impostazioni
# Uso: .\rigenera_archivio.ps1

$start = [datetime]"2026-09-28"
$end   = [datetime]"2026-10-26"
$delay = 15  # secondi tra una data e l'altra

$current = $start
$total = 0
$errors = 0

while ($current -le $end) {
    $dateStr = $current.ToString("yyyy-MM-dd")
    Write-Host "`n=== $dateStr ===" -ForegroundColor Cyan

    node generate_quiz.js $dateStr --force

    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ERRORE su $dateStr" -ForegroundColor Red
        $errors++
    } else {
        $total++
    }

    $current = $current.AddDays(1)
    if ($current -le $end) {
        Write-Host "  Attendo ${delay}s..." -ForegroundColor DarkGray
        Start-Sleep -Seconds $delay
    }
}

Write-Host "`n==============================" -ForegroundColor Green
Write-Host "Completato: $total date ok, $errors errori" -ForegroundColor Green
