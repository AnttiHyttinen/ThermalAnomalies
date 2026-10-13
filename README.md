# Kohteen kehitysanalyysi · 2026.10.13.1

Klikkaa karttakohdetta tai listan tietopainiketta. Sovellus hakee valitulle kohteelle 28 vrk:n VIIRS- ja MODIS NRT -aineiston. Vaihda tarvittaessa 14 vrk:een tai säädä paikallinen säde 1–20 km. Paina Hae kohde uudelleen. Tuloksena on FRP-aikasarja, nousun ajoitus, ylilentojen muutokset, pistekohtainen sijaintikuva, aineiston aukot ja CSV-vienti. MODIS näkyy erillisenä tukiaineistona. Tarkat kynnysarvot ovat sovelluksen Päättelyn perusteet -ikkunassa.

Tämä on satelliittihavaintojen tulkinta. Se ei vahvista syttymisaikaa, sammutusta, polttoainetta, katon romahtamista tai palanutta pinta-alaa. Lähekkäiset lähteet voivat sekoittua samaan hakusäteeseen. NRT-historian saatavuus riippuu NASA:sta; onnistunut tyhjä haku ei takaa peittoa. Kartan 14 vrk:n luokitus ja pidempi kohdeanalyysi esitetään erikseen.

Käyttäjän avainta ei tallenneta projektiin eikä palvelimen yhteiseksi avaimeksi.

Päivitys: korvaa projektin tiedostot, aja `npm install` tarvittaessa ja käynnistä palvelin uudelleen. Paketti sisältää myös tuotannon Node-riippuvuudet. GitHub-repon nimi säilyy `thermal-anomalies`.

---

# Lämpöpoikkeamat · paketti 2026.09.15.1

Sovellus auttaa löytämään rakennetun ympäristön lämpötapahtumia ja pysyvien lämpölähteiden poikkeamia. Se hakee NASA FIRMSin VIIRS-havainnot valitulta UTC-päivältä ja sitä edeltäviltä 13 päivältä. Kohteet ja niiden normaalitasot muodostetaan jokaisella ajolla uudelleen. Maailmanlaajuista kohde-, tehdas- tai rakennusluetteloa ei tarvita.

## Käynnistys ja päivitys

Vaatimus: **Node.js 22 tai uudempi** ja internetyhteys. Pura uusi paketti omaan tyhjään hakemistoon ja pysäytä aiempi Node-palvelin.

```bash
cd lampopoikkeamat-app
cp .env.example .env
npm run dev
```

Valinnainen NASA_FIRMS_MAP_KEY-ympäristömuuttuja on varattu tuotannon mahdolliselle yhteiselle avaimelle: jos se on asetettu, palvelin käyttää sitä käyttäjälle, jolla ei ole omaa avainta. Jos muuttuja puuttuu tai on tyhjä, sovellus käynnistyy normaalisti ja kysyy heti käyttäjän oman avaimen. Käyttäjän oma avain ohittaa aina yhteisen avaimen.

Paketointikorjaus 2026.09.05.2 sisältää **geotiff-kirjaston ja kaikki sen ajonaikaiset riippuvuudet node_modules-kansiossa**. Pura myös tämä kansio palvelimen viereen. Käynnistys ei vaadi erillistä npm-asennusta. Jos node_modules-kansio on jätetty purkamatta, aja projektikansiossa `npm ci`. Riippuvuuksien versiot on lukittu package-lock.json-tiedostoon. Sovelluksen versio on 2026.09.15.1. `npm start` käyttää palvelimen ympäristömuuttujia; `npm run dev` lukee myös `.env`-tiedoston. Portti on oletuksena 4173 ja sen voi vaihtaa PORT-ympäristömuuttujalla.

Versionumero näkyy kohdelistan päivitysajassa ja päättelyn perusteissa. CSS- ja moduulitiedostoilla on uusi versionumero sekä uudelleenvalidointia vaativat välimuistiotsakkeet. Vanha ladattu paketti ei siis korvaa uutta samoilla resurssiosoitteilla.

## Käyttö

- **Tarkastelupäivä:** oletuksena kuluva UTC-päivä. Nuolilla edellinen/seuraava päivä, Tänään-painikkeella takaisin automaattisesti vaihtuvaan päivään. Käsin valittu historia pysyy paikallaan myös automaattisissa päivityksissä.
- **Huomiota vaativat:** oletus piilottaa normaaliksi havaitut pysyvät lähteet sekä kasvillisuustapahtumat, joilla on vähintään kaksi ajoitettua ylilentoa havaintopäivänä. Yksittäiset ja paikallaan toistuvat epäselvät havainnot säilyvät mukana. Epäselvät kohteet säilyvät mukana. Kaikki-suodatin näyttää piilotetutkin.
- **Muut suodattimet:** rakennettu ympäristö, pysyvät lähteet, niiden poikkeamat, kasvillisuus ja tuntematon. FRP:n vähimmäisraja on oletuksena 0; rajan nostaminen piilottaa myös kohteet, joilta FRP puuttuu.
- **Edelliset kuusi päivää:** valinnainen historiakonteksti. Pysyvä lähde ilman D0-havaintoa näkyy oletuksessakin tilaltaan tuntemattomana.
- **Karttapopup:** D0-huipun lisäksi koko 14 päivän suurin ylilentokohtainen FRP ja sen päivämäärä, esimerkiksi `14 vrk FRP-huippu 120 MW (29.8.)`. Tasatilanteessa näytetään viimeisin päivä.
- **Tiedot ja FRP:** suuri kohdeikkuna näyttää 14 päivän ylilentohuiput, kaikki ylilennot taulukossa, saman satelliitin päivä/yö-vertailumediaanit, FRP-suhteet, intensiteetti- ja laajuuspisteet sekä ulkopuoliset pikselit. Päivämäärät ovat muodossa `29.8.`. Pylvään valinta vaihtaa analyysipäivän.
- **Päättelyn perusteet:** suuri erillinen ikkuna, jossa luokittelun säännöt, tarkat rajat, näytön pisteytys ja rajoitukset. Oikean reunan Suuren palon sääntö -kohtaa ei ole.
- **Kartta:** tumma, vaalea ja harmaasävyinen OpenStreetMap-pohja. Koordinaattihaku hyväksyy esimerkiksi `60.3, 25.5`. Karttaa voi siirtää myös nuolinäppäimillä. Kartan siirto, koordinaattihaku ja zoomaus odottavat 4 sekuntia viimeisestä muutoksesta ennen havaintohakua. Päivänvaihto ja Päivitä toimivat heti.
- **CSV:** vie valitun näkymän kaikki kohteet, lämpötilanteet, ympäristöt, FRP-huiput ja havaintopäivät. Lista näyttää enintään 150 kohdetta; kartta ja vienti sisältävät kaikki suodattimeen sopivat kohteet.

## Mitä luotettavuuteen korjattiin

1. Yksittäiset ja pienet VIIRS-tapahtumat säilyvät mukana. Vanha suuruussuodatin saattoi poistaa juuri paikalliset palot.
2. Pysyvyys lasketaan D−13…D−1:n aineistosta, vähintään 9 havaintopäivänä 13:sta. Myös paikallisen ytimen tulee toistua 9 päivänä; liikkuva monipäiväinen rintama ei riitä.
3. D0 ei osallistu normaalitason tai jalanjäljen muodostamiseen. Historiallinen päivä analysoidaan vain siihen päivään asti kertyneistä lämpöhavainnoista.
4. FRP:tä verrataan saman satelliitin ja päivä/yö-luokan ylilentoihin. Vähintään kolme täydellistä vertailuylilentoa kolmelta päivältä vaaditaan. Mediaani–MAD vaatii kuusi ylilentoa viideltä päivältä; pienempi otos käyttää varovaista suhdevertailua.
5. Puuttuva vertailuryhmä, D0-havainto tai FRP ei ole nolla eikä normaalitaso. Neljäs pysyvän lähteen tila on **tila tuntematon**. Osittainen API-haku estää normaaliksi vahvistamisen.
6. Yksi ylilento ei jakaudu kellon puolituntirajalla kahdeksi. Saman satelliitin päällekkäiset pikselit poistetaan ylilennon sisältä. Eri satelliittien FRP:tä ei summata samaksi ylilennoksi.
7. Pysyvän lähteen **leviävä paloepäily** vaatii poikkeavan intensiteetin/laajuuden sekä vähintään kaksi normaalijalanjäljen ja 750 m:n puskurin ulkopuolista pikseliä kahdella ylilennolla. Ilman muutoskohtaa molempien on oltava D0:lta. Tunnistetun muutoskohdan yhteydessä myös sen jälkeiset päivät osallistuvat vertailuun; vahvistukseen kelpaavat D−2…D0:n ylilennot ja D0:n on oltava mukana. Pelkkä tehopiikki jää poikkeavaksi lämmöksi, syy tuntematon.
8. Usean päivän muutosta etsitään saman satelliitin ja päivä/yö-ryhmän aikasarjasta. Muutosta edeltävä taso suojaa normaalitasoa jatkuvan tapahtuman sulautumiselta. Satelliittien vaihtuva otanta ei yksin tee muutoskohtaa.
9. Hitaamman vanhan haun valmistuminen ei korvaa uuden päivän tuloksia. Uusi haku tyhjentää edelliset tulokset, ja virhetilanne näkyy pysyvästi. Keskeytys välittyy palvelimen NASA-hakuihin.

Raja-arvot ja perustelut ovat sovelluksen Päättelyn perusteet -ikkunassa, lähdekoodissa `public/reasoning.js`. Laskenta on tiedostoissa `public/anomaly.js`, `public/event-type.js` ja `public/assessment.js`.

## Automaattinen maanpeite

Palvelin hakee lämpösolujen ympäristöstä alkuperäisiä kategorisia näytteitä **ESA WorldCover 2021 v200** -rasterista. Rasteri on maailmanlaajuinen maanpeitehavainto, ei ennalta laadittu kohdeluettelo. Rakennusten tai laitosten nimiä ei kysytä mistään. WorldCoverin 10 m:n kategorisia GeoTIFF-arvoja luetaan HTTP Range -pyynnöillä; RGB-karttatiiliä ei käytetä analyysiin.

Kunkin lämpösolun puskuroidusta ympäristöstä sekä erikseen arvioidun havaintopikselin sisäosasta otetaan 5 × 5 näytettä. Rakennetun alueen luokka vaatii vähintään 20 % rakennettuja sisäosan näytteitä. Pelkkä rakennettu puskuri tuottaa rajaympäristön. Rakennettu maanpeite nostaa kohteen listalla ylöspäin. Sekä sisäosasta että puskurista vähintään 85 % kasvillisuusnäytteitä ilman yhtään rakennettua näytettä voi antaa kasvillisuusluokan, jos kattavuus ja kaikkien lämpösolujen edustus riittävät. Näyteprosentit lasketaan tunnetuista näytteistä. Ne eivät ole palotodennäköisyyksiä tai täsmällisiä pinta-alaosuuksia.

Enintään 48 lämpösolua näytteistetään kohteesta; suurempaa kohdetta ei nimetä automaattisesti kasvillisuusvaltaiseksi vajaan otoksen perusteella. Ensin arvioidaan 60 priorisoitua kohdetta. “Arvioi lisää ympäristöjä” jatkaa tai yrittää puuttuvat haut uudelleen. Maanpeitehaku on erillinen, joten sen hitaus tai epäonnistuminen ei estä lämpöhavaintojen käyttöä. Hakemattomat ja epäonnistuneet kohteet säilyvät tuntemattomina ja oletuslistalla.

Tarvittavat ulkoiset yhteydet:

- `firms.modaps.eosdis.nasa.gov`: havaintohaku palvelimelta; MAP_KEY tarvitaan.
- `esa-worldcover.s3.eu-central-1.amazonaws.com`: maanpeiterasterin osahaku palvelimelta, ei avainta.
- `tile.openstreetmap.org`: karttatiilet selaimelta.

NASA-hakujen välimuisti erottaa päivän, kartta-alueen ja avaimen, kesto 10 minuuttia. Maanpeitearviot säilyvät palvelimen rajatussa muistivälimuistissa enintään vuorokauden. Käynnistys ei lataa maailmanlaajuista rasteria.

## Tulkinnan käytännön rajat

Tämä on seulontatyökalu. **FIRMS + maanpeite ei voi vahvistaa, palaako juuri rakennus, teollinen prosessi, metsässä oleva varasto vai jokin muu materiaali.** Pysyvyys ei todista teollisuutta. Pysyvän lähteen lähellä havaittu leviävä lämpö voi olla myös erillinen maastopalo. Jalostamoa tai räjähdevarastoa ei voi tunnistaa lämpösignaalista.

WorldCover kuvaa vuotta 2021. Uusi rakennus tai muuttunut maanpeite voi puuttua. Myös metsässä sijaitseva rakennuspalo voi jäädä kasvillisuusluokkaan. Ennen vuotta 2021 valittu historiallinen päivä käyttää myöhemmän vuoden ympäristörasteria; sitä ei pidä tulkita historiallisen ympäristön varmistukseksi. Kaikki-näkymä on käytettävissä, jos kasvillisuuskohteita ei haluta piilottaa.

NRT-lähteiden päiväsaatavuus vaihtelee: päivävalinta ei takaa koko NASA-arkiston saatavuutta. Sovellus ilmoittaa virheellisistä tai osittaisista hauista. Puuttuva havainto, pilvisyys tai keskeneräinen kuluva päivä ei sulje pois paloa. FRP on hetkellinen teho, ei energia. Rypäsala ja VIIRS-pikselien peittoala eivät ole palanut ala. Ympyrät ovat kohdemerkkejä.

Näytön asteikko on heuristinen. Mallia ei ole kalibroitu vahvistettujen maailmanlaajuisten metsä-, rakennus- ja teollisuuspalojen vertailuaineistolla; testien läpäisy ei todista tunnistustarkkuutta oikeissa palotapauksissa.

## Varmennus

Kehitystestien riippuvuudet asennetaan erikseen; niitä ei tarvita sovelluksen käyttämiseen.

```bash
npm ci
npm test
```

Regressiot kattavat pienet tapahtumat, 9/13-toistuvuuden, puuttuvat vertailuryhmät ja FRP:t, toistuvat pikselit, ylilennon kellorajavirheen, tulevien havaintojen poissulun, muutoskohdat, maanpeitteen epävarmuuden ja suodattimet. API-testit käyttävät simuloituja NASA-vastauksia. Käyttöliittymän DOM-testi käy läpi päivävalinnan, ison FRP-ikkunan ja kilpailevat haut; se ei ole selaimessa tehtävä visuaalinen testi.

## Aineistolähteet ja lisenssit

- [NASA FIRMS Area API](https://firms.modaps.eosdis.nasa.gov/api/area/)
- [NASA:n päiväsaatavuus](https://firms.modaps.eosdis.nasa.gov/api/data_availability/)
- [VIIRS-havaintokentät](https://www.earthdata.nasa.gov/data/tools/firms/active-fire-data-attributes-modis-viirs)
- [ESA WorldCover: aineisto, rajoitukset ja CC BY 4.0](https://esa-worldcover.org/en/data-access)
- Zanaga ym. (2022), [ESA WorldCover 10 m 2021 v200](https://doi.org/10.5281/zenodo.7254221).

© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium. Kartta © OpenStreetMap contributors. GeoTIFF.js ja kehitystestien LinkeDOM ovat niiden omien lisenssien alaisia riippuvuuksia.

## Päivitys 2026.09.15.1

- Rakennettu havaintopikselin sisäosa erotetaan rakennuksista paikannuspuskurissa. Sisäosassa ja puskurissa on kummassakin 25 maanpeitenäytettä lämpösolua kohden.
- Rakennettua luokkaa ei enää nimetä automaattisesti rakennuspaloksi. Kasvillisuusympäristö eritellään vallitsevan maanpeitteen mukaan.
- Kohteen yhteenveto näyttää havaintopäivän ajoitetut ylilennot, satelliitit, viimeisimmän havainnon ja saman ryhmän FRP-mediaanin suurimman ylityksen.
- Uudet lajittelut: FRP, uusin havainto ja ylitys normaalitasoon; valinnainen kahden ylilennon suodatin. CSV sisältää myös nämä tunnusluvut ja rakennetun maanpeitteen osuudet.
- Yksittäinen kasvillisuushavainto säilyy oletuksena tarkastettavana. Luokat eivät ole vahvistettuja palotyyppejä; maailmanlaajuista vertailuaineistoa tarkkuuden mittaamiseen ei ole käytetty.
- Seuraavan kehitysvaiheen tärkein tehtävä on todellisten esimerkkikohteiden arviointi samoilla kriteereillä (pysyvä prosessi, maastopalo, rakennettu ympäristö, epäselvä) ja väärien luokitusten mittaaminen. Vasta sen jälkeen on perusteltua säätää rajoja tai lisätä uusia palotyyppinimiä.

## GitHub ja oma avain

Vaiheittainen julkaisuohje on tiedostossa [GITHUB-OHJE.md](GITHUB-OHJE.md). Ohje käyttää englanninkielistä repon nimeä `thermal-anomalies`. Paketin .gitignore jättää node_modules-kansion, .env-tiedostot ja pakettiarkistot pois versionhallinnasta.

Sama sivuston osoite ja selainprofiili käyttävät samaa avaintallennusta. Avainta ei synkronoida GitHub-tiliin eikä muihin selaimiin. Selaintietojen tyhjennys poistaa sen; yksityinen selaus voi rajoittaa muistamista. Tallennuksen estyessä sovellus kertoo siitä ja avain toimii sivun avaamisen ajan. Selain lähettää käyttäjän avaimen oman Node-palvelimen X-FIRMS-MAP-Key-otsakkeessa, ja palvelin välittää sen NASA:lle. Älä tallenna tätä otsaketta tai NASA:n avaimellisia URL-osoitteita julkaisuympäristön pyyntölokeihin.

## Kartan automaattihaun korjaus 2026.09.08.3

Ajastimen selainkohtainen kutsukonteksti on korjattu. Kartan siirto ja zoomaus hakevat havainnot automaattisesti neljän sekunnin rauhoittumisen jälkeen. Uusi muutos aloittaa odotuksen alusta, vetäminen keskeyttää odottavan ajastimen ja Päivitä tekee heti yhden haun. Ajastuksen ja käyttöliittymän testeissä tarkistetaan myös uuden kartta-alueen välittyminen hakupyyntöön.

## OpenStreetMap-korjaus 2026.09.15.1

- Palvelimen Referrer-Policy on strict-origin-when-cross-origin; karttakuvissa on lisäksi sama asetus. Aiempi no-referrer esti OpenStreetMapin edellyttämän Referer-tiedon lähettämisen.
- Kartan liikuttaminen käyttää uudelleen näkyvät karttakuvat ja pyytää vain näkymään tulevat tiilet. Selain hoitaa välimuistin OSM:n otsakkeiden mukaan. Kartan ulkopuolisia tiiliä ei esiladata.
- NASA-havaintohaun neljän sekunnin viive ja käyttäjän oma API-avain säilyvät ennallaan.

Päivitä projektin tiedostot, käynnistä Node-palvelin uudelleen ja lataa sivu normaalisti uudelleen. Verkkopalveluun korjaus on myös julkaistava. Versio näkyy käyttöliittymässä muodossa 2026.09.15.1. Jos 403 jatkuu, tarkista selaimen Network-näkymästä, lähettääkö karttakuvan pyyntö todellisen sivusto-osoitteen Referer-tiedon. Laajennus tai välityspalvelin voi poistaa sen. Mahdollinen jo voimassa oleva palveluntarjoajan esto ei välttämättä poistu heti koodikorjauksella. Älä lisää pyyntöihin satunnaisia parametreja tai muuta osoitteita eston kiertämiseksi.

Ohje perustuu [OpenStreetMapin tiilipalvelun käyttöehtoihin](https://operations.osmfoundation.org/policies/tiles/).

## Vercel

Tuotanto: https://thermal-anomalies.vercel.app. `public/` julkaistaan staattisena ja `api/*.js` ajetaan Vercel-funktioina, jotka käyttävät `server.mjs`:n käsittelijää. Julkaisu tehdään aina erikseen komennolla `npx vercel deploy --prod`; GitHubiin vienti ei käynnistä Vercel-julkaisua (`git.deploymentEnabled: false`). Valinnainen `NASA_FIRMS_MAP_KEY` asetetaan Vercelin projektin ympäristömuuttujiin.
