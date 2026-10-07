# Fast Git GUI

Ein schlankes Desktop-Tool, um viele lokale Git-Projekte schnell im Blick zu behalten. Gedacht für die Arbeit mit Agentic Coding: schnell sehen, was sich geändert hat, kurz prüfen, committen. Für alles Komplexere (Branches anlegen, Mergen, Rebase) ist weiterhin ein vollwertiger Editor die richtige Wahl.

Python-Backend, natives Webview (WebView2 unter Windows), GUI vollständig lokal ohne CDN.

## Funktionen

- **Projektliste** in der Sidebar mit Filter, Branch, Anzahl geänderter Dateien und Abstand zum Upstream (↓ hinter, ↑ voraus)
- **Projekte hinzufügen** einzeln oder per Ordner-Scan (findet Repos bis 3 Ebenen tief)
- **Historie** als Commit-Graph mit Branches, Tags und Remote-Refs; Klick auf einen Commit zeigt dessen Dateien und Diff
- **Änderungen** im Arbeitsverzeichnis mit Stage-Checkbox pro Datei, Aktualisierung alle 4 Sekunden
- **Commit** mit automatischem Stagen aller Änderungen, falls nichts gestaged ist
- **Fetch vor dem Commit** mit Warnung, wenn der lokale Stand hinter Origin liegt
- **Diff-Ansicht** mit Zeilennummern und Syntax-Highlighting (Pygments, praktisch alle gängigen Sprachen), optional ohne Whitespace-Änderungen
- **Branch-Wechsel** mit Suche, auch zu Branches, die nur auf dem Remote existieren
- Schnellzugriff auf den Projektordner und VS Code

Bewusst nicht enthalten: Editor, Branch anlegen, Mergen, Rebase, Push, Pull.

## Voraussetzungen

- Windows 10/11 mit WebView2-Runtime (in Windows 11 enthalten)
- Python 3.10 oder neuer
- Git im `PATH`

## Installation und Start

```bash
pip install -r requirements.txt
```

Start ohne Konsolenfenster: Doppelklick auf `fastgitgui.pyw`. Mit Konsole, zum Debuggen:

```bash
python app.py
```

## Bedienung

| Aktion | Bedienung |
| --- | --- |
| Datei im Diff wechseln | Pfeil auf/ab oder `J` / `K` |
| Commit ausführen | `Strg+Enter` in der Nachrichtenzeile |
| Alles neu laden | `F5` |
| Spaltenbreite ändern | Trennlinien ziehen (wird gemerkt) |

Ist nichts gestaged, committet das Tool alle Änderungen inklusive neuer Dateien. Ist etwas gestaged, wird nur das committet.

## Daten und Fehlersuche

Die Projektliste liegt in `%APPDATA%\fastgitgui\config.json`. Da ohne Konsole gestartet wird, landen unerwartete Fehler in `%APPDATA%\fastgitgui\error.log`.

Fetch-Vorgänge laufen ohne Rückfragen. Braucht ein Remote eine interaktive Anmeldung, schlägt der Fetch fehl; das Tool meldet das und committet trotzdem.

## Aufbau

```
app.py            Fenster und JS-API (pywebview)
gitops.py         git-CLI, Graph-Berechnung, Diff und Highlighting
fastgitgui.pyw    Starter ohne Konsole
web/              Oberfläche (HTML, CSS, JS, lokale Schriften)
```

## Lizenz

Apache License 2.0, siehe [LICENSE](LICENSE).
