# BRICKSPLIT

Site static care, dintr-un **numar de set LEGO**, scoate o arhiva ZIP cu toate piesele
in format STL, **grupate pe culori** si **asezate pe patul imprimantei**, gata de feliat.

Scrii `10300`, apesi un buton, primesti arhiva. Fara cont, fara cheie API, fara niciun
pas manual. Tot procesul ruleaza in browser; site-ul isi citeste datele de la el insusi.

---

## Cum functioneaza

Repo-ul contine, in `data/`, doua lucruri:

- **inventarele** a peste 18.000 de seturi oficiale — ce piesa, ce culoare, cate bucati;
- **geometria** a peste 24.000 de piese, in fisiere LDraw `.dat`.

Cand scrii un numar de set, pagina cauta inventarul, construieste forma fiecarei piese
din fisierele LDraw, le grupeaza pe culori, le asaza pe placi de printare si impacheteaza
totul intr-un ZIP.

### Scara

O unitate LDraw inseamna exact **0.4 mm**, iar pasul dintre doi stud-uri este 8 mm. Nimic
nu se ghiceste: fisierele ies la marimea reala, in milimetri, cu Z in sus si asezate pe
planul de printare.

## Ce contine arhiva

```
<set>/
  CITESTE-MA.txt       rezumat, scara, sfaturi de printare
  inventar.csv         tabel complet (culoare, piesa, bucati, dimensiuni, volum)
  ghid-culori.html     ghid vizual cu mostre si necesarul de filament
  piese-fara-geometrie.txt   ce nu se poate printa si de ce
  culori/
    01_C0_Black/
      _CULOARE.txt     hex-ul filamentului, lista pieselor, gramaj estimat
      placi/           piesele deja aranjate pe pat: placa-01.stl, placa-02.stl, ...
      piese/           cate un STL per forma: 3001_Brick-2-x-4_x12.stl
    02_C71_Light-Bluish-Gray/ ...
```

Optional, `placi/` contine si `.3mf` cu aceeasi aranjare, cu culoarea inclusa, pentru
PrusaSlicer / Orca / Bambu Studio.

## Baza de date

`data/` este construita de un GitHub Action, nu de mana:

```
.github/workflows/build-data.yml   ruleaza saptamanal si la orice modificare a pipeline-ului
tools/build-data.mjs               descarca, filtreaza si scrie data/
```

Pipeline-ul descarca inventarele Rebrickable, pastreaza inventarul principal al fiecarui
set, ignora piesele de rezerva, apoi cloneaza biblioteca LDraw si pastreaza doar piesele
care apar efectiv in seturi impreuna cu sub-piesele si primitivele lor. Fiecare `.dat`
este curatat de comentarii, iar referintele interne sunt rescrise ca. cai explicite, ca
browserul sa nu incerce mai multe foldere degeaba.

O piesa imprimata sau turnata altfel (`3001pr0001`) nu are fisier LDraw propriu, dar are
aceeasi forma ca piesa de baza — exact ce ne trebuie la printare — asa ca pipeline-ul urca
pe lantul de relatii Rebrickable pana gaseste o piesa cu geometrie. Asta duce acoperirea
la ~97% din piesele unui set obisnuit.

Ce ramane pe dinafara: autocolante, piese textile, cabluri, componente electrice si
imprimeuri unice de minifigurina. Nu se printeaza oricum din plastic; sunt listate separat
in arhiva, cu cantitati.

## Structura codului

| Fisier | Rol |
|---|---|
| `js/zip.js` | citire si scriere ZIP fara librarii, peste `CompressionStream` nativ; ZIP64 |
| `js/ldraw.js` | citeste `.dat`: referinte, triunghiuri, patrulatere, sens BFC, scara 0.4 mm |
| `js/mesh.js` | STL binar, 3MF, aranjarea pe placi, estimarea de filament |
| `js/build.js` | leaga tot: cautare in catalog, incarcare set, grupare pe culori, arhiva |
| `js/viewer.js` | previzualizare 3D in WebGL2, cu instantiere hardware |
| `js/worker.js` | ruleaza totul pe un fir separat |
| `js/app.js` | interfata |

Zero dependinte externe: nici CDN, nici librarii.

## Test

```
node test/pipeline.test.mjs [numar-set]
```

Ruleaza pe baza de date reala si verifica: dimensiunile pieselor cunoscute (o caramida
2x4 trebuie sa iasa 32 x 16 x 11.2 mm), cautarea in catalog, incarcarea unui set intreg,
aranjarea pe placi fara ca nimic sa iasa din pat, structura arhivei, antetul STL binar,
inventarul CSV si validitatea 3MF-ului.

## Rulare locala

Pagina are nevoie de un server, pentru ca isi citeste datele prin `fetch` — deschisa
direct ca fisier, browserul blocheaza acele cereri.

```
npx http-server . -p 8080
```

## Cerinte de browser

`CompressionStream` cu `deflate-raw` (Chrome 103+, Firefox 113+, Safari 16.4+).
Previzualizarea cere WebGL2; daca lipseste, restul functioneaza normal.

## Surse si utilizare

Inventarele seturilor: [Rebrickable](https://rebrickable.com), care permite folosirea
datelor cu mentionarea sursei. Geometria pieselor:
[LDraw Parts Library](https://ldraw.org), redistribuibila sub CCAL 2.0.

Modelele LDraw sunt facute pentru randare, nu pentru printare: la unele piese slicerul va
repara automat mici erori in plasa.

Rezultatul este pentru printare personala, necomerciala. LEGO® este marca inregistrata a
Grupului LEGO, care nu sponsorizeaza si nu autorizeaza acest instrument.
