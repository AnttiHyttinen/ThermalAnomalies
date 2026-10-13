# Julkaisu Azure App Serviceen (Windows)

## Projektitiedostot

- `ThermalAnomalies.sln` + `ThermalAnomalies.njsproj` – avaa `.sln` Visual Studiossa (vaatii Node.js development -työkuorman).
- `server.cjs` – App Servicen (iisnode) käynnistystiedosto. iisnode lataa sen `require()`:lla ja antaa PORT-muuttujassa named pipen.
- `web.config` – ohjaa kaikki pyynnöt Node-sovellukselle, jolloin IIS ei jaa lähdekoodia suoraan.

Projektissa `Content`-tyyppiset tiedostot ja `node_modules` julkaistaan. `None`-tyyppiset tiedostot jäävät paikallisiksi, esimerkiksi testit, ohjeet ja `.env.example`. `.env` ja `old/` eivät ole projektissa. Uudet palvelin- tai `public`-tiedostot lisätään projektiin Visual Studiossa: Add → Existing Item. Lisää ne Content-tyyppisinä, jotta ne julkaistaan.

## Paikallinen ajo (F5)

F5 käynnistää `server.mjs`:n Node.js-debuggerilla portissa 4173 (`--env-file-if-exists=.env`) ja avaa selaimen.

## App Servicen asetukset (Azure Portal)

1. Luo Web App: Publish = Code, Runtime stack = **Node 22 LTS**, Operating System = **Windows**.
2. Settings → Configuration:
   - `WEBSITE_NODE_DEFAULT_VERSION` = `~22` (jos ei ole jo asetettu).
   - **HTTPS Only = On**. Sovellus estää avaimelliset HTTP-haut muualla kuin localhostissa.

## Julkaisu Visual Studiosta

1. Aja ensin `npm ci --omit=dev`, jotta paikallinen `node_modules` sisältää vain tuotantoriippuvuudet. Visual Studio julkaisee `node_modules`-kansion sellaisenaan.
2. Solution Explorer → projekti → **Publish** → Azure → Azure App Service (Windows) → valitse luomasi Web App → Finish → Publish.
3. Palauta kehitysriippuvuudet testejä varten komennolla `npm ci`.

## Vaihtoehto: Azure CLI

```powershell
.\scripts\publish-azure-node.ps1 -ResourceGroup <resurssiryhmä> -AppName <web-app-nimi>
```

Skripti kopioi ajonaikaiset tiedostot väliaikaiskansioon, asentaa tuotantoriippuvuudet, pakkaa ne zipiksi ja julkaisee ne komennolla `az webapp deploy`.

## Vianetsintä

Azure Portal → App Service → Log stream, tai Kudu (`https://<app>.scm.azurewebsites.net`) → `LogFiles\Application` / iisnode-lokit.
