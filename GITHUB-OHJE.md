# Julkaisu omalle GitHub-tilille

GitHubiin siirretään lähdekoodi. Sovelluksen ajaminen verkossa tarvitsee lisäksi Node-palvelimen: GitHub Pages tarjoaa staattisia tiedostoja eikä suorita tämän sovelluksen FIRMS- tai maanpeiterajapintoja.

## 1. Valmistelu Windowsissa

Asenna [Git](https://git-scm.com/downloads) ja [GitHub CLI](https://cli.github.com/), jos niitä ei vielä ole. Pura tämä paketti omaan hakemistoon. Avaa PowerShell siinä lampopoikkeamat-app-kansiossa, jossa package.json ja server.mjs ovat.

```powershell
git --version
gh --version
gh auth login
```

Valitse github.com, HTTPS ja kirjautuminen selaimella omalle tilillesi.

## 2. Luo uusi repositorio ja julkaise koodi

Komennot on tarkoitettu paketista purettuun kansioon, jossa ei vielä ole Git-repositoriota. Paketin .gitignore sulkee pois node_modules-kansion, .env-tiedostot, lokit ja zip-paketit; package-lock.json ja avaimeton .env.example kuuluvat koodiin.

```powershell
git init -b main
git add .
git status --short
git diff --cached --stat
git commit -m "Publish thermal-anomalies"
gh repo create thermal-anomalies --source=. --public --remote=origin --push
gh repo view --web
```

Repositorion englanninkielinen nimi on thermal-anomalies. Siitä tulee julkinen kirjautuneen käyttäjän tilille. Jos haluat yksityisen, vaihda --public arvoon --private ennen luontikomentoa. Valitse toinen nimi, jos thermal-anomalies on jo käytössä tililläsi. Jos Git pyytää nimeä ja sähköpostia, määritä ne projektikansiossa git config user.name ja git config user.email -komennoilla ja tee commit uudelleen.

Tarkista git status -listasta ennen committia, ettei mukana ole omia avaimia tai .env-tiedostoa. .gitignore ei poista jo aikaisemmin versionhallintaan lisättyjä tiedostoja. Tässä paketissa ei ole jaettavaa NASA-avainta.

## 3. Seuraavat päivitykset

Kopioi päivityksen lähdetiedostot samaan paikalliseen repositorioon säilyttäen Git-historia.

```powershell
git add .
git diff --cached --stat
git commit -m "Update thermal-anomalies"
git push
```

## 4. Sovellus verkkoon GitHub-repositoriosta

Valitse palvelu, joka ajaa Node-verkkopalvelimia, ja yhdistä siihen edellä luotu GitHub-repositorio. Käytä seuraavia asetuksia:

| Asetus | Arvo |
| --- | --- |
| Palvelutyyppi | Node-verkkopalvelin |
| Node | 22 tai uudempi |
| Asennuskomento | npm ci --omit=dev |
| Käynnistyskomento | npm start |
| Terveystarkistus | /api/health |
| Portti | Alustan PORT-ympäristömuuttuja; paikallinen oletus 4173 |
| Ulospäin tarvittavat yhteydet | firms.modaps.eosdis.nasa.gov ja esa-worldcover.s3.eu-central-1.amazonaws.com |
| Julkinen osoite | HTTPS |

Palvelin kuuntelee alustan antamaa porttia. Julkaise koko sovellus ja molemmat API-reitit samalla osoitteella. Staattisen public-kansion julkaiseminen yksin ei riitä. Koontikomentoa ei tarvita asennuksen lisäksi. Pitkien havainto- ja maanpeitehakujen takia alustan pyyntöaikarajan on riitettävä; selain sallii FIRMS-haulle 130 s ja maanpeite-erälle 190 s. Lyhyen aikarajan palvelu vaatii jatkokehitystä.

**NASA_FIRMS_MAP_KEY on valinnainen.** Ilman sitä jokainen käyttäjä syöttää oman avaimensa, ja sovellus kysyy sitä heti avattaessa. Jos tuotantoon otetaan yhteinen avain, aseta se palvelun ympäristömuuttujaksi (ei koodiin eikä repoon); palvelin käyttää sitä vain käyttäjille, joilla ei ole omaa avainta. Yhteistä avainta ei koskaan lähetetä selaimelle.

Avain muistetaan sivustokohtaisesti samassa selainprofiilissa. Eri osoite (esimerkiksi localhost ja julkaistu palvelu) tarvitsee oman syötön. Avaimen voi vaihtaa tai unohtaa sovelluksessa. Selain lähettää avaimen palvelimelle otsakkeessa, ja palvelin välittää sen NASA:lle; pidä pyyntöotsakkeet ja NASA:n avaimelliset URL-osoitteet poissa lokeista.

## Lähteet

Paikallisen lähdekoodin tuonti noudattaa [GitHubin ohjetta](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github) ja [gh repo create -dokumentaatiota](https://cli.github.com/manual/gh_repo_create). Staattisen julkaisun rajoitus on kuvattu [GitHub Pages -dokumentaatiossa](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages).
