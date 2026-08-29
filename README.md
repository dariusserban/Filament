# BRICKSPLIT

Site static care ia un export Mecabricks (`.zmbx`) al unui set LEGO si scoate o arhiva ZIP
cu toate piesele in STL, **grupate pe culori**, gata pentru printare 3D.

Totul ruleaza in browser. Nu exista server, nu se face upload si nu se contacteze niciun
serviciu extern in timpul procesarii.

---

## Cum se foloseste

1. Deschide `index.html` (local sau pe orice hosting static) si scrie codul setului,
   ex. `10300`. Butonul deschide cautarea pe Mecabricks pentru acel cod.
2. Pe Mecabricks: deschide modelul in **Workshop** → `File` → `Export` → format
   **Mecabricks (.zmbx)**. E nevoie de un cont gratuit.
3. Trage fisierul `.zmbx` in pagina. Se afiseaza statisticile, lista de culori si o
   previzualizare 3D.
4. Alege optiunile si apasa **Genereaza ZIP-ul**.

## Ce contine arhiva

```
<cod-set>/
  CITESTE-MA.txt       rezumat, scara folosita, sfaturi de printare, nota de utilizare
  inventar.csv         tabel complet (culoare, piesa, bucati, dimensiuni, volum, fisier)
  ghid-culori.html     ghid vizual cu mostre de culoare si necesarul estimat de filament
  culori/
    01_C21_Bright-Red/
      _CULOARE.txt     hex-ul filamentului, lista pieselor, gramaj estimat
      3001_Brick-2x4_x12.stl     <- o forma de piesa; "_x12" = 12 bucati
      _TOATE_Bright-Red.stl      <- optional: toate piesele culorii, in pozitia din model
    02_C26_Black/ ...
  model-complet.3mf    optional: modelul intreg, colorat, un obiect per culoare
```

Fisierele sunt in **milimetri**, cu **Z in sus**, fiecare piesa centrata pe XY si asezata
pe planul de printare.

## Cum se determina scara

Exportul Mecabricks este in unitati proprii. Aplicatia deduce scara reala din geometrie:
masoara distanta dintre stud-urile vecine ale fiecarei piese, ia valoarea cea mai frecventa
si o egaleaza cu **8 mm** (pasul real dintre doi stud-uri LEGO). In practica rezulta
10 mm per unitate. Valoarea se poate suprascrie manual din interfata, care afiseaza si
dimensiunile modelului asamblat.

## Structura codului

| Fisier | Rol |
|---|---|
| `js/zip.js` | citire si scriere ZIP fara librarii, peste `CompressionStream` nativ; suporta ZIP64 |
| `js/colors.js` | tabelul de culori Mecabricks (182 culori: nume, tip, hex, opacitate) |
| `js/engine.js` | parseaza `.mbx`, decodeaza geometria, ataseaza stud-uri/tuburi/pini, grupeaza pe culori, scrie STL si 3MF |
| `js/pack.js` | construieste arhiva finala: STL-uri, inventar, ghid de culori, README |
| `js/viewer.js` | previzualizare 3D in WebGL2, cu instantiere hardware si umbrire plata |
| `js/worker.js` | ruleaza engine+pack pe un fir separat |
| `js/app.js` | interfata; daca `Worker` nu e disponibil (ex. `file://`), lucreaza pe firul principal |

Formatul `.mbx` este JSON: `parts[]` (id, configuratie, matrice 4x4 pe linii, culoare),
`configurations[versiune][nume]` (fisierul de geometrie + stud-uri/tuburi/pini ca transformari),
`geometries[versiune][fisier]` (varfuri + fete impachetate cu flag-uri) si `details`
(geometriile de stud, tub, pin, logo). Descrierea campurilor urmeaza
[zmbx2gltf](https://github.com/iliazeus/zmbx2gltf) (MIT), de unde provine si tabelul de culori.

## Test

```
node test/pipeline.test.mjs
```

Construieste un `.zmbx` sintetic si verifica: numarul de piese si de culori, scara dedusa,
volumul si dimensiunile in mm, structura arhivei, antetul STL binar, inventarul CSV si
validitatea 3MF-ului. Arhiva generata poate fi verificata suplimentar cu `unzip -t`.

## Cerinte de browser

`CompressionStream` / `DecompressionStream` cu `deflate-raw` (Chrome 103+, Firefox 113+,
Safari 16.4+). Previzualizarea are nevoie de WebGL2; daca lipseste, restul functioneaza
normal si se afiseaza un mesaj in locul ei.

## Sursa pieselor si utilizare

Geometria provine exclusiv din fisierul `.zmbx` exportat de utilizator din Mecabricks —
acel fisier contine deja plasele 3D ale pieselor. Aplicatia **nu** descarca nimic de pe
Mecabricks: exportul este acoperit de conditiile lor de utilizare si legat de contul
propriu, deci pasul acela ramane manual, intentionat.

Rezultatul este pentru printare personala, necomerciala. LEGO® este marca inregistrata a
Grupului LEGO, care nu sponsorizeaza si nu autorizeaza acest instrument. Mecabricks™
apartine autorilor sai.
