# Ender Slicer (iPad-Web-App)

STL/3MF laden → im Browser zu G-Code slicen → per Moonraker direkt zu Klipper hochladen.
Läuft komplett lokal im Browser, ohne Server und ohne Build-Schritt.

## Auf GitHub Pages bringen
1. Neues Repo anlegen, **alle Dateien dieses Ordners** (inkl. `lib/`) in die Wurzel hochladen.
2. Settings → Pages → Branch `main` / `(root)` → Speichern.
3. Auf dem iPad in **Safari** die Seite öffnen → Teilen → **Zum Home-Bildschirm**.

## Klipper-Upload
Moonraker muss die Seite erlauben, sonst blockiert der Browser die Anfrage (CORS).
In `moonraker.conf` (Fluidd/Mainsail → Konfiguration):

```
[authorization]
cors_domains:
    https://DEIN-NAME.github.io
    http://192.168.*.*
    http://*.local
trusted_clients:
    192.168.0.0/16
```
Danach Moonraker neu starten. In der App unter „Drucker & Klipper“ die Adresse eintragen,
z. B. `192.168.1.50:81` (die Adresse deines Pi im WLAN, meist `192.168.…`).

### Wichtig: https-Seite → http-Drucker
GitHub Pages ist immer https, dein Drucker meist nur http. Safari blockiert solche
Anfragen („Mixed Content“). Zwei Wege:

- **Einfach:** Die App-Dateien zusätzlich auf den Pi legen (z. B. nach `~/ender-slicer`) und
  von dort ausliefern (`python3 -m http.server 8080` im Ordner oder ein Nginx-Eintrag).
  Dann die Seite per `http://PI-IP:8080` öffnen und zum Home-Bildschirm hinzufügen – alles http, kein Problem.
- Oder Moonraker per https erreichbar machen (Reverse-Proxy mit Zertifikat).

Ohne Upload geht immer: „G-Code speichern“ öffnet das iPad-Teilen-Menü (→ In Dateien sichern,
oder in Fluidd/Mainsail hochladen).

## Start-/End-G-Code
Unter „Start- & End-G-Code“ einfügen. Platzhalter wie `[first_nozzle_temp]`, `[first_bed_temp]`,
`[bed_temp]`, `[nozzle_temp]`, `[bed_x]`, `[bed_y]` werden ersetzt (die gängigen Orca-Namen
`[nozzle_temperature_initial_layer]` usw. ebenfalls). Die Werte werden im Browser gespeichert.

## Grenzen (bewusst „einfach“)
Keine Stützstrukturen, keine Nahtsteuerung, kein Ironing, keine Mehrfarb-/Mehrteil-Zuweisung,
keine Brücken-Optimierung. Für Einsteiger-/Alltagsteile mit Wänden, Füllung, Deckel/Boden, Skirt/Brim ausgelegt.
