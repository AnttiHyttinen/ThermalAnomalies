import { formatDate } from "./format.js?v=20261013.2";
const n = (v) => Number.isFinite(v) ? new Intl.NumberFormat("fi-FI", {maximumFractionDigits:1}).format(v) : "—";
const e = (v) => String(v ?? "").replace(/[&<>"']/g,(c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const when = (p) => p ? `${formatDate(p.date)}${p.date.slice(0,4)} ${e(p.time)} UTC` : "—";

export function renderEvolution(a) {
  if (!a) return "";
  const onset = a.onset;
  const onsetText = onset ? `Ensimmäinen riittävään aiempaan vertailuun perustuva nousu: <strong>${when(onset.pass)}</strong> (${n(onset.pass.totalFrp)} MW; aiempi mediaani ${n(onset.median)} MW, ${onset.count} ylilentoa). Edellinen saman ryhmän havainto: ${when(onset.previous)}. ${onset.confirmed ? "Nousu toistuu saman ryhmän seuraavassa 36 tunnin sisään osuvassa havainnossa." : "Toistuvaa vahvistusta samasta ryhmästä 36 tunnin sisällä ei ole."} Väli rajaa havaittua muutosta, ei varmaa syttymisaikaa.` : "Riittävää ennen tapahtumaa mitattua vertailutasoa tai selvää nousua ei löydy. Ensimmäinen lämpöhavainto ei yksin ole syttymishetki.";
  const rows = a.changes.map((r) => {const p=r.pass;return `<tr><td>${when(p)}</td><td>${e(p.satellite)} / ${e(p.daynight)}</td><td>${n(p.totalFrp)}</td><td>${n(p.maxFrp)}</td><td>${p.pixelCount}</td><td>${n(p.radius95Km)}</td><td>${p.measuredPixelArea ? n(p.observedPixelAreaKm2) : "—"}</td><td>${r.ratio===null ? "—" : n(r.ratio)+"×"}${r.deltaHours!==null ? `<br><small>${n(r.deltaHours)} h</small>` : ""}</td><td>${e(r.labels.join(" · ") || "Ei selvää muutossignaalia / vertailu puuttuu")}</td></tr>`;}).join("");
  return `<h3>Kohteen kehitys · ${a.range.days} vuorokautta</h3>
  <p class="details-meta">${formatDate(a.range.start)}–${when({date:a.range.end,time:"23:59"})} · hakualueen säde ${n(a.radiusKm)} km · ${a.passes.length} VIIRS-ylilentoa. Kuluva vuorokausi on keskeneräinen. Alueen lähekkäiset palot voivat sekoittua: muuta sädettä tarvittaessa.</p>
  ${!a.coverageComplete ? `<p class="detail-warning">Haku on osittainen. Puuttuvat erät voivat muuttaa ajoitusta, huippua ja kehitystulkintaa.</p>` : ""}
  ${a.clipped ? `<p class="detail-warning">Havaintoja on alle 500 m:n päässä haun reunasta. Laajuus voi leikkautua; kokeile suurempaa sädettä.</p>` : ""}
  <div class="detail-grid evolution-metrics">
  <section class="detail-box"><h3>Suurin ylilentoteho</h3><strong>${n(a.peak?.totalFrp)} MW</strong><p>${when(a.peak)}</p></section>
  <section class="detail-box"><h3>Voimakkain pikseli</h3><strong>${n(a.pointPeak?.maxFrp)} MW</strong><p>${when(a.pointPeak)}</p></section>
  <section class="detail-box"><h3>Laajin 95 %:n havaintokehä</h3><strong>r95 ${n(a.widest?.radius95Km)} km</strong><p>${when(a.widest)}. Keskipisteestä mitattu havaintojen säde, ei paloalan reuna.</p></section></div>
  <section class="detail-box"><h3>Alku ja viimeisin havainto</h3><p>${onsetText}</p><p>Ensimmäinen lämpöhavainto: ${when(a.first)}. Viimeisin: ${when(a.last)}. Havaintojen loppuminen ei vahvista sammumista.</p></section>
  <h3>Ylilentojen teho ajan mukaan</h3><p class="details-meta">Piste = yhden VIIRS-ylilennon FRP-summa. Todellinen aika UTC, lineaarinen MW-asteikko. Väliaikoja ei interpoloida eikä puuttuvia havaintoja esitetä nollana.</p>${frpChart(a)}
  <h3>Lämpöpisteiden sijainti ylilennoittain</h3><label for="detail-pass">Valitse ylilento</label><select id="detail-pass">${a.passes.map((p,i) => `<option value="${i}"${p===a.peak ? " selected" : ""}>${when(p)} · ${e(p.satellite)} / ${e(p.daynight)} · ${n(p.totalFrp)} MW</option>`).join("")}</select><div id="detail-spatial"></div>
  <section class="detail-box"><h3>Kuinka suuri palo on?</h3><p>Aineisto kertoo havaitun säteilytehon, lämpöpikselien määrän ja niiden levinneisyyden. Tarkkaa palavaa tai palanutta pinta-alaa, liekkikorkeutta tai polttoainemäärää ei voi laskea näistä arvoista. Havaintopikselien yhteenlaskettu ala sisältää myös palamatonta maata ja voi sisältää päällekkäisyyttä.</p><p>Tehon kasvu pienessä jalanjäljessä sopii paikalliseen lämpöpiikkiin. Useammat ja kauemmas ulottuvat pisteet tukevat laajenemista. Kumpikaan ei yksilöi öljyä, rakennusta, ilotulitteita, räjähdystä tai säiliön katon romahtamista. VIIRS:n FRP arvioidaan karkeammalta M13-kanavalta ja voidaan jakaa usealle 375 m:n pikselille: yksittäinen maksimi ei ole säiliökohtainen mittaus.</p></section>
  <h3>Voimistumiset, supistumiset ja lämpöpiikit</h3><p>Vertailukohtana on edellinen saman satelliitin ja päivä/yö-luokan mitattu ylilento enintään 72 tunnin takaa. Katselukulma, pilvet ja savut voivat muuttaa havaintoja. Lyhytkestoisen palon kestoa ei saada ylilentojen väliltä.</p>
  <div class="table-scroll"><table><thead><tr><th>Aika UTC</th><th>Satelliitti / D–N</th><th>FRP MW</th><th>Max MW</th><th>Pikselit</th><th>r95 km</th><th>Pikseliala km²</th><th>FRP-suhde / väli</th><th>Havaittu muutos</th></tr></thead><tbody>${rows || '<tr><td colspan="9">Ei ajoitettuja hyväksytyn luottamuksen VIIRS-havaintoja.</td></tr>'}</tbody></table></div>
  <details><summary>MODIS-tukihavainnot (${a.support.length} ylilentoa)</summary><p>1 km:n aineisto erillisenä. Pikseleitä tai FRP:tä ei lisätä VIIRS-arvoihin eikä lukemia verrata suoraan anturien välillä.</p><div class="table-scroll"><table><thead><tr><th>Aika</th><th>Satelliitti</th><th>FRP MW</th><th>Max MW</th><th>Pikselit</th></tr></thead><tbody>${a.support.map((p) => `<tr><td>${when(p)}</td><td>${e(p.satellite)}</td><td>${n(p.totalFrp)}</td><td>${n(p.maxFrp)}</td><td>${p.pixelCount}</td></tr>`).join("")}</tbody></table></div></details>
  <details><summary>Aineiston aukot ja haun tila</summary><p>Yli 18 tunnin aukkoja lämpöhavaintojen välillä: ${a.gaps.length}. Ne eivät kerro pilvettömistä ylilennoista eivätkä sammumisesta. Pois rajattuja heikon/tuntemattoman luottamuksen pisteitä: ${a.excluded}. Ajoittamattomia VIIRS-ryhmiä: ${a.unTimed}.</p><ul>${a.gaps.map((g) => `<li>${when(g.start)} → ${when(g.end)}: ${n(g.hours)} h</li>`).join("")}</ul><ul>${a.sourceCoverage.map((s) => `<li>${e(s.source)}: ${s.successfulSegments}/${s.requestedSegments} hakuerää</li>`).join("")}${a.warnings.map((w) => `<li>${e(w)}</li>`).join("")}</ul><p>Aineisto: NASA FIRMS Area API, NRT. Onnistunut tyhjä hakuerä ei takaa historiallista saatavuutta tai satelliittipeittoa. Kartan 14 vrk:n luokitus säilyy erillisenä; tämä näkymä tutkii valittua paikallista aluetta.</p></details>
  <button id="detail-export" type="button">Lataa kehitysanalyysin CSV</button>`;
}

function frpChart(a) {
  const values=a.passes.filter((p) => Number.isFinite(p.totalFrp));
  if (!values.length) return "<p>Ei mitattua FRP-sarjaa.</p>";
  const start=Date.parse(a.range.start),end=Date.parse(a.range.end)+86400000,top=Math.max(1,...values.map((p) => p.totalFrp));
  const colors={N20:"#47d9c1",N21:"#ffca70",N:"#cba6ff"};
  return `<svg class="evolution-chart" viewBox="0 0 900 225" role="img" aria-label="Ylilentojen FRP ajan mukaan, megawattia"><path d="M60 10V190H880" fill="none" stroke="#8798a8"/><text x="4" y="20" fill="currentColor">${n(top)}</text><text x="15" y="190" fill="currentColor">0 MW</text>${values.map((p) => `<circle cx="${60+(Date.parse(p.at)-start)/(end-start)*815}" cy="${190-p.totalFrp/top*175}" r="4" fill="${colors[p.satellite]||"#a6b9ff"}"><title>${when(p)} ${e(p.satellite)}: ${n(p.totalFrp)} MW</title></circle>`).join("")}<text x="60" y="218" fill="currentColor">${formatDate(a.range.start)}</text><text x="810" y="218" fill="currentColor">${formatDate(a.range.end)}</text></svg><p class="details-meta">NOAA-20 turkoosi · NOAA-21 keltainen · S-NPP violetti. Tiedot myös taulukossa.</p>`;
}

export function renderSpatial(a, event, index) {
  const pass=a.passes[index];
  if (!pass) return "<p>Ei paikannettuja ylilentoja.</p>";
  const start=Date.parse(pass.at), end=start+20*60000;
  const selected = (p) => p.satellite===pass.satellite && p.daynight===pass.daynight && Date.parse(`${p.date}T${p.time}:00Z`)>=start && Date.parse(`${p.date}T${p.time}:00Z`)<=end;
  const scale=180/a.radiusKm;
  const dots=a.points.map((p) => {const active=selected(p);return `<circle cx="${210+(p.longitude-event.longitude)*111.32*Math.cos(event.latitude*Math.PI/180)*scale}" cy="${210-(p.latitude-event.latitude)*111.32*scale}" r="${active ? 4.5 : 1.6}" fill="${active ? "#ffac61" : "#678091"}"><title>${e(p.date)} ${e(p.time)} ${n(p.frp)} MW</title></circle>`;});
  return `<svg class="evolution-spatial" viewBox="0 0 420 430" role="img" aria-label="Lämpöpikselien keskipisteet suhteessa kohteeseen"><circle cx="210" cy="210" r="180" fill="none" stroke="#60788e"/><path d="M210 20V400M20 210H400" stroke="#344e63"/><text x="215" y="20" fill="currentColor">Pohjoinen</text>${dots.join("")}<text x="20" y="425" fill="currentColor">Säde ${n(a.radiusKm)} km · itä oikealla</text></svg><p>${when(pass)}: ${pass.pixelCount} pikseliä, r95 ${n(pass.radius95Km)} km. Oranssi = valittu ylilento, harmaa = koko jakson pisteet. Merkkien koko ei kuvaa paloalaa.</p>`;
}
