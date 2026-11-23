# Système de réception + Beds24 — récapitulatif pour l'intégration de la Staff App

*État au 23/11/2026. Rédigé à partir du dépôt `sebienbon/Rabbit-System` (commit `51e6c15`), de la feuille de production et de la configuration Beds24.*

Ce qui sert directement la Staff App est marqué 🟢 (existe déjà), 🟡 (proposition, pas encore construit) ou ⚠️ (point à vérifier avant de construire).

---

## 0. En bref

- **La réception est déjà la seule à parler à Beds24** pour l'argent : une synchro toutes les 5 minutes (Apps Script, API JSON v1 de Beds24). Elle lit les réservations, mais n'écrit dans Beds24 que des lignes de paiement.
- **Le check-out n'est enregistré nulle part aujourd'hui.** Le check-in commence à l'être (onglet Check-in, depuis le 18/11), mais aucun client réel n'est encore passé par là : l'onglet `CI_Guests` est vide.
- **Pour la Staff App, il faut** :
  1. une adresse en lecture seule « mouvements du jour » (à construire, ~1 fichier `.gs`) ;
  2. un bouton « Checked out » à la réception (à construire dans l'onglet Check-in) ;
  3. un correspondant fiable des noms d'unités (Bamboo 1, Gd mother 1…), aujourd'hui **pas lus** par la réception (voir §2.3).

---

## 1. Architecture et déploiement

### 1.1 Les trois morceaux

| Morceau | Technologie | Où ça tourne |
| --- | --- | --- |
| **Feuille « Reception - RABBIT TREE »** | Google Sheets | Drive du propriétaire. C'est la base de données de référence. |
| **Serveur** | Apps Script, projet **« reception v2 »** lié à la feuille, publié en **web app** | Serveurs Google, exécuté en tant que propriétaire |
| **Interface de réception** (app « Rabbit Tree Reception ») | Page web statique (HTML + JS modules), fonctionne **hors ligne** (IndexedDB + service worker) | GitHub Pages : `https://sebienbon.github.io/Rabbit-System/` |

Autres pages web servies par le même site :

- `gear.html` : l'app du staff gear (masques et vélos), en indonésien ;
- `checkin.html` : le check-in sur le téléphone du client ;
- `menu.html` : le QR des tables vers le menu du POS ;
- `checkin-qr.html` : le QR du comptoir à imprimer.

Le **POS du bar** (`sebienbon/rabbit-pos`) est une application séparée qui tourne **en local** sur l'ordinateur de réception (`http://localhost:8080`, ou l'adresse du PC sur le Wi-Fi). Il parle au même serveur Apps Script.

L'**ancien système** existe encore : 118 fichiers `.gs`/`.html` dans le même projet Apps Script (boutons-images du Control Board, dialogues de vente, clôture mensuelle, rapports). Le staff ne l'utilise plus depuis le 04/11. La clôture mensuelle et des rapports en dépendent encore.

### 1.2 Où est le code

Dépôt `github.com/sebienbon/Rabbit-System`, public, branche `main`, publié tel quel par GitHub Pages (racine du dépôt).

```
index.html, app.css, sw.js          app de réception (sw.js : VERSION à changer à chaque mise en ligne)
js/*.js                             modules de l'app (app.js, work.js, sync.js, db.js, checkindesk.js…)
checkin.html, menu.html, gear.html  pages annexes
vendor/tesseract/                   lecture du passeport sur le téléphone (aucun service extérieur)
dev/server/30.UI_api.gs             API de l'app : connexion, opérations hors ligne, lecture (pull)
dev/server/31.Beds24_sync.gs        synchro Beds24 ↔ Entries (namespace B24)
dev/server/32.Checkin.gs            check-in sur le téléphone + laissez-passer du menu (namespace CHECKIN)
dev/tests/                          tests serveur (faux Sheet, node --test) + tests navigateur (Playwright)
```

### 1.3 Comment le code arrive dans la vraie feuille

- **Pas de `clasp`.** Les fichiers `dev/server/*.gs` sont **recopiés à la main** dans l'éditeur Apps Script du projet « reception v2 » (ID `1aqc5u3-Z7zwclnYekfzSxNpaW3ViXI1mr5_T96a1SJ8BETmmCN7P0by4`), sous les mêmes noms (`30.UI_api`, `31.Beds24_sync`, `32.Checkin`).
- **La web app** a une seule adresse, utilisée par l'app, le POS et le staff gear :
  `https://script.google.com/macros/s/AKfycbwtm3tI5vEvnxyzSFIsvcd2lJ7pQ3scoR_LweGWFXF3wJc4gf3Es9FcdXmE4K7yxNJKoA/exec`
  Exécution « en tant que moi » (propriétaire), accès « Tout le monde » (anonyme). Chaque action vérifie elle-même une session ou une clé.
- **Mettre à jour le serveur** = Déployer → Gérer les déploiements → crayon sur le déploiement existant → **Nouvelle version**. Jamais « Nouveau déploiement » : cela changerait l'adresse.
- **Exception : les déclencheurs horaires** (`B24_run`, `CI_cleanup`) exécutent le code **enregistré** (Head). Ils n'ont pas besoin d'un déploiement.
- **L'interface** : un `git push` sur `main` suffit, avec la constante `VERSION` de `sw.js` changée pour que les postes se mettent à jour.

⚠️ **Limite de 200 versions** par projet Apps Script : on est à **196**. Avant la prochaine série de déploiements, supprimer d'anciennes versions dans l'historique du projet.

### 1.4 Feuilles

| | Feuille | ID |
| --- | --- | --- |
| Production | **Reception - RABBIT TREE** | `1XE3T27M68a-HtEkhOBqsmoLJ1g5EMG5lQsnPdNPm5eI` |
| Copie de test | **Claude copy Reception - RABBIT TREE** | `1g10k_SBvMrHFp83IetrJWDtqCKMciS2Ij5wbFW9lftg` |

La copie de test a sa propre web app (`…AKfycbxjw8ldfWzInmkTP2K1c-OnyfkmA_zW2ekoEEBos1GTcxmMhgCBCUckXTt4oV1mconK`). ⚠️ Elle n'est **plus resynchronisée** depuis la mise en ligne du 04/11 : son code et ses onglets sont en retard.

En pratique, les tests se font surtout **hors Google** : `dev/tests/gas-shim.js` simule la feuille et Apps Script, avec 172 tests serveur et des scénarios navigateur Playwright.

### 1.5 Droits

| Qui | Droits |
| --- | --- |
| `sebien.legoff@gmail.com` (Sébastien) | Propriétaire de la feuille et du projet Apps Script. Seul à déployer. Les clés Beds24 sont dans ses Script Properties. |
| Comptes listés dans l'onglet `Protect` (therabbitreception1, therabbittreemanager, compte de service `script-writer-123@…`) | Éditeurs historiques de la feuille, pour l'ancien système de verrouillage des onglets |
| Staff de réception | Passe uniquement par l'app, avec ses comptes dans `UI_Users` (rôles `staff`, `manager`, `gear`). L'objectif est de retirer leur accès à la feuille. |
| Dépôt GitHub | `sebienbon`. Les sessions Claude poussent avec son autorisation. |

---

## 2. Données

### 2.1 Onglets de la feuille (production)

**Utilisés par la nouvelle réception :**

| Onglet | Rôle |
| --- | --- |
| `Entries` | Journal central : chaque vente, dépense, paiement, ligne de chambre (colonnes ci-dessous) |
| `Entries Manual` | Miroir d'Entries utilisé par l'ancienne compta. L'app y écrit les mêmes lignes. |
| `Data activities` | Catalogue : services (L), transports (M), tours (N), moyens de paiement (Q, T), **chambres (S) et leurs `roomId` Beds24 (U)**, exceptions de commission (V), lignes partenaires (W), boutons de dépense (X) |
| `New guest` | Clients ajoutés à la main (colonne F), plus les compagnons créés au check-in |
| `UI_Users`, `UI_Shifts`, `UI_Log` | Comptes de l'app, shifts (ouverture/fermeture), journal de toutes les opérations |
| `B24_DryRun` | Ce que la dernière passe de synchro Beds24 a fait |
| `B24_Control` | Écarts à vérifier par un manager (trop payé, annulation avec paiement, mode de paiement inconnu…) |
| `CI_Guests` | **Check-in** : une ligne par personne (voir 2.4) |
| `Gear_Log`, `Gear_Settings`, `SG` | Masques et vélos |
| `Cashouts&Cor`, `Settlements`, `Card Trans.`, `Commis.` | Caisse, terminal carte, commissions |
| `POS Bar` | Lignes envoyées par le POS du bar |

**Ancien système, encore présents :**

| Onglet | État |
| --- | --- |
| `24datafeed` | Flux Beds24 de l'ancien script `fetchBeds24Data` : nom, prénom, nom complet, arrivée, départ, montant (souvent `N/A`). Sert encore à la liste des clients. |
| `in/out` | Récap arrivées / séjours / départs de l'ancien script. ⚠️ **Plus mis à jour depuis le 03/11** (dernière valeur : « Recap for: 2026-11-03 »). |
| `BEDSDATA`, `POUCHDATA`, `data1 (never touch)`, `data2` | Imports et rapprochements de l'ancien système. À ne pas toucher. |
| `Temp`, `Temp2`, `Temp3` | Tampons des anciens dialogues |
| `Control Board`, `Protect` | Boutons-images et verrouillage de l'ancien système |
| `Daily balance`, `Counting`, `Bar Cash`, `Ext Cash Count`, `GAJI`, `Staff Libur` | Rapports, salaires et jours off du staff |

### 2.2 Colonnes d'`Entries`

| Col. | Contenu | Remarque |
| --- | --- | --- |
| A | Date | |
| B | Type | `Income`, `Expense`… |
| C | Sous-catégorie | `Room`, `Service`, `Tour`, `Transport`, `Other` |
| D | Objet | Pour une chambre : **le type de chambre Beds24** (`Twin Room`, `Bird Nest`…) |
| E–H | Qté, prix unitaire, total, prix réel | |
| I | Auteur | Email du réceptionniste, ou `Beds24 · <canal>` |
| J–L | Coûts | |
| M | Client (nom) | |
| N | Moyen de paiement | `Unpaid` = à payer |
| **O** | **Identifiant de ligne** : timestamp de 17 chiffres `yyyyMMddHHmmssSSS` (UTC+8) | **Clé unique de chaque ligne**, jamais le numéro de ligne |
| P | `Past` | Ligne d'un mois clos |
| Q | Commentaire | `From Beds24: still to pay`, `No-show (Black in Beds24) · …` |
| R | Pouchnation | |
| S | Statut | `Settled`, `Refunded`… |
| T | Vendeur | Commissions |
| **U** | **Numéro de réservation Beds24** (`bookId`) | Rempli sur les lignes de chambre |
| **V** | **Numéro de ligne de facture Beds24** (`invoiceId`) | Paiement déjà présent dans Beds24 |

### 2.3 Clients, réservations, chambres

- **Client** : identifié **par son nom** (texte libre, colonne M d'Entries ou F de New guest). Il n'y a pas d'identifiant client. Un compagnon de chambrée a son propre nom, donc sa propre facture.
- **Réservation** : le `bookId` Beds24 (colonne U, et colonne C de `CI_Guests`). Une **prolongation** est une réservation séparée dans Beds24 : la synchro la rattache au même client (même email, ou même nom).
- **Chambre** : deux niveaux dans Beds24.

| Beds24 « room » (type) | roomId | Unités (lits ou chambres) vues dans le calendrier Beds24 |
| --- | --- | --- |
| Familly Rabbit Cave (female) | 353054 | Rabbit Cave 1, 2, 3 |
| Twin Room | 460594 | 1, 2 |
| Single Room | 353950 | 1 |
| Flying Boat | 353329 | Flying Boat 1, 2 |
| Bola Bola | 460592 | 1, 2, 3 |
| Pillow Room | 460593 | 1, 2, 3 |
| Gd Ma Female Dorm | 353328 | Gd mother 1, Gd mother 2 |
| Tree House | 460595 | 1, 2, 3, baby1, baby2 |
| Bird Nest | 460596 | 1 |
| Double inside building | 353330 | **Passion**, **Bamboo 1** |
| White House | 460597 | **Bamboo 2**, **Rabbit Dream** |

**Ce que la réception connaît aujourd'hui : seulement le type** (colonne D d'Entries, champ `room` des arrivées). Ce nom est lu dans le libellé de la première ligne de facture Beds24 (`roomName_()` dans `31.Beds24_sync.gs`), pas dans le `roomId`. **L'unité (le lit ou la chambre précise) n'est lue nulle part.**

**Les noms de la Staff App** (« Bamboo 1, Gd Ma, Tree House ») mélangent donc deux niveaux :

- « Bamboo 1 » est une **unité** de « Double inside building » ;
- « Gd Ma » et « Tree House » sont des **types**.

⚠️ Pour le housekeeping, il faut l'**unité** :

- l'API v1 renvoie `roomId` et `unitId` (un numéro) sur chaque réservation ;
- le nom de l'unité est dans la configuration des chambres de Beds24 ;
- il faut une **table de correspondance** `roomId + unitId → nom Staff App`. Proposition : un nouvel onglet `Units` (roomId, unitId, nom Beds24, nom Staff App), rempli une fois puis tenu à la main.
- Attention aux pièges : « Bamboo 1 » et « Bamboo 2 » sont dans **deux types différents**, et deux dortoirs ont des unités nommées « 1, 2, 3 ».

### 2.4 Ce qui est enregistré aujourd'hui

| Moment | Où | Quoi |
| --- | --- | --- |
| **Arrivée (jour J)** | `Entries` (par la synchro Beds24) | Si la réservation n'est pas entièrement payée : une ligne `Room` **Unpaid** avec le reste dû (nom, type de chambre, `bookId` en U). Ce n'est **pas** un check-in : la ligne existe même si le client n'est pas encore là. |
| **Check-in** (depuis le 18/11) | `CI_Guests` | Une ligne par personne : session, `bookId`, nom de la réservation, nom de la personne, type de chambre, arrivée, **départ**, clé du téléphone (SHA-256), numéro de passeport, photo (Drive), statut `checked in`, par qui, **heure** (colonne O). Les compagnons sont aussi ajoutés dans `New guest`. *Encore aucune ligne réelle.* |
| **Paiement** | `Entries` (+ `Entries Manual`, + `UI_Log`) | La ligne Unpaid devient payée (Cash, Card…). Pour une chambre, la synchro envoie le paiement à Beds24 (ligne `[RT-…]`, numéro en V). |
| **Départ** | — | **Rien.** Aucun check-out, aucune heure de départ réelle. |
| **No-show** | `Entries` | Statut « Black » dans Beds24 : la ligne de chambre est marquée `No-show (Black in Beds24)` (le montant reste dû). |
| **Annulation** | `Entries` | Statut « Cancelled » dans Beds24 : la ligne Unpaid passe en `Cancelled` (montant 0). Une ligne déjà payée n'est jamais touchée : elle est signalée dans `B24_Control`. |

---

## 3. Beds24

### 3.1 Liaison existante 🟢

- **API JSON v1** (`https://api.beds24.com/json/…`) : `getBookings` (avec `includeInvoice: true`) et `setBooking` (pour ajouter une ligne de paiement).
- **Fréquence** : déclencheur horaire **`B24_run` toutes les 5 minutes** (installé par `B24_setup()`). Plus le bouton « Refresh » de l'app (pull avec `beds24: true`).
- **Fenêtre lue à chaque passe** (`readBookings_`) : arrivées de J−60 à J+30, en tranches d'une semaine, avec départ ≥ J−7. Les factures ne reviennent que pour moins de 100 réservations par appel.
- **Mode** : `B24_LIVE = yes`, `B24_START = 2026-11-04` (seules les arrivées à partir de cette date sont traitées).
- **L'ancien script** `fetchBeds24Data` remplit encore `24datafeed`, avec les mêmes clés.
- **Ce que fait une passe** (en-tête de `31.Beds24_sync.gs`) :
  1. un paiement saisi à la réception est envoyé à Beds24 ;
  2. un paiement saisi dans Beds24 est importé dans Entries ;
  3. le jour de l'arrivée, ce qui reste dû devient une ligne Unpaid ; si le prix baisse ensuite dans Beds24, la ligne baisse aussi ;
  4. annulation et no-show, comme décrit en 2.4.

### 3.2 Données disponibles

| Donnée | Dans Beds24 (API v1) | Lue par la réception aujourd'hui ? |
| --- | --- | --- |
| Arrivée / départ | `firstNight`, `lastNight` (départ = `lastNight` + 1 jour) | ✅ |
| Nom | `guestFirstName`, `guestName` ; email `guestEmail` | ✅ |
| Nombre de personnes | `numAdult`, `numChild` | ✅ (onglet Check-in) |
| Type de chambre | `roomId`, ou libellé de facture | ✅ (libellé) |
| **Unité / lit** | `unitId` | ❌ (voir 2.3) |
| Statut | `status` : `0` annulé, `1` confirmé, `2` nouveau, `3` demande, `4` Black (no-show) | ✅ |
| Canal | `referer` (Booking.com, Airbnb, Hostelworld…) | ✅ |
| **Heure d'arrivée prévue** | champ « arrival time » saisi par le client sur certains canaux | ❌ ⚠️ nom exact du champ à vérifier sur une vraie réponse avant de s'en servir |
| Check-in / check-out faits dans Beds24 | Le tableau de bord Beds24 a des boutons « Check in » | ❌ ⚠️ pas lu, et le staff ne s'en sert pas |

**Fonction prête à réutiliser** : `B24.arrivals(from, to)` dans `31.Beds24_sync.gs`. Elle renvoie, pour les arrivées entre deux dates : `{bookId, name, room, arrival, departure, guests, noShow, channel}`. C'est elle qui remplit l'onglet Check-in (`ci_arrivals`). Elle ne donne **pas** encore les **départs** du jour (il faut `departureFrom`/`departureTo`) ni l'unité.

### 3.3 Clés Beds24

- **Script Properties** du projet « reception v2 » (Projet → Paramètres → Propriétés du script) : `B24_API_KEY` (clé du compte) et `B24_PROP_KEY` (clé de la propriété), plus `B24_START` et `B24_LIVE`. Jamais dans le code ni dans le dépôt.
- `fetchBeds24Data` (ancien) utilise les mêmes clés.
- Un **seul login Beds24** est partagé par toute la réception.

---

## 4. Check-out

### 4.1 Où le déclarer 🟡 (proposition)

**Dans l'onglet Check-in de l'app**, qui est déjà le premier onglet et liste les réservations Beds24. On y ajoute une section **« Departures today »** :

- elle liste les départs du jour, en appelant Beds24 avec `departureFrom = departureTo = aujourd'hui` ;
- chaque réservation a un bouton **« Checked out »**, avec l'heure enregistrée automatiquement ;
- une seule touche, sans rien à taper, au moment où le client rend la clé ou règle sa facture ;
- si la facture du client a encore des lignes Unpaid, l'app l'affiche juste avant (« Rp 230.000 still to pay »), sans bloquer le check-out.

**Stockage** : un nouvel onglet `CI_Moves`, une ligne par événement, jamais modifiée :

| Colonne | Exemple |
| --- | --- |
| At (heure réelle) | `23/11/2026 10:42` |
| Type | `checkin` / `checkout` / `checkout_auto` |
| Booking id | `96026082` |
| Guest | `Giulia Varcasia` |
| Room (type) | `Twin Room` |
| Unit | `1` (quand la correspondance des unités existera) |
| By | email du réceptionniste, ou `auto` |

Le check-in existant (`ci_validate`) y écrirait aussi sa ligne `checkin`. Le flux pour la Staff App vient ainsi d'un seul onglet.

À voir ensuite : renvoyer aussi le check-out vers Beds24 (bouton « Check out » du tableau de bord Beds24) ⚠️ à vérifier dans l'API avant de le promettre.

### 4.2 Client parti sans passer à la réception

Aujourd'hui, rien ne se passe : la réservation finit simplement à sa date.

Proposition 🟡 :

- **Clôture automatique** : à l'heure de check-out du jour (⚠️ heure à confirmer, voir §6), une passe du déclencheur écrit `checkout_auto` pour chaque départ du jour pas encore déclaré. La Staff App peut donc compter sur un départ « supposé » pour planifier le ménage.
- **Le housekeeping confirme** : la Staff App peut renvoyer « chambre vide constatée », ce qui est une vraie preuve de départ (voir §5, sens retour, optionnel).
- **Facture impayée** : un départ (déclaré ou automatique) avec des lignes Unpaid apparaît dans un encadré de la réception (« Left with an unpaid bill ») et dans `B24_Control`. L'argent n'est jamais touché automatiquement.

---

## 5. Exposer les données à la Staff App

### 5.1 Faisable : oui 🟡

**Même web app, une nouvelle action en lecture seule.** Pas besoin d'un nouveau déploiement d'adresse : la Staff App appelle l'URL `/exec` existante.

Requête (POST, corps JSON en `text/plain` pour éviter le pré-vol CORS, comme le reste de l'app) :

```json
{ "action": "hk_moves", "key": "<clé secrète de la Staff App>", "date": "2026-11-23" }
```

Réponse proposée :

```json
{
  "ok": true,
  "date": "2026-11-23",
  "generatedAt": "2026-11-23T10:45:12+08:00",
  "arrivals": [
    { "bookId": "96026082", "guest": "Giulia Varcasia", "room": "Twin Room", "unit": "1",
      "guests": 2, "expectedTime": null, "checkedInAt": "2026-11-23T14:12:00+08:00", "status": "checked_in" }
  ],
  "departures": [
    { "bookId": "95817014", "guest": "Sophie James", "room": "Tree House", "unit": "2",
      "checkedOutAt": "2026-11-23T10:42:00+08:00", "by": "reception", "status": "checked_out" },
    { "bookId": "95811650", "guest": "Calum Hull-Flower", "room": "Tree House", "unit": "3",
      "checkedOutAt": null, "status": "expected" }
  ],
  "nextArrivalByUnit": { "Tree House/2": "2026-11-24", "Tree House/3": "2026-11-23" }
}
```

`nextArrivalByUnit` répond directement à la question « quand arrive le prochain client dans cette chambre ». Il utilise les réservations déjà lues sur 30 jours.

**Où l'écrire** : un fichier `dev/server/33.Housekeeping.gs` (namespace `HK`), appelé depuis `UIAPI.handle` de la même façon que `CHECKIN`. Il s'appuie sur `B24.arrivals` (à étendre aux départs et à l'unité) et sur l'onglet `CI_Moves`. Aucune donnée personnelle sensible n'en sort : pas de passeport, pas de photo, pas d'email, pas de montants.

### 5.2 Protection

- **Une clé dédiée**, longue et aléatoire, de 64 caractères hexadécimaux, rangée dans les Script Properties sous `HK_FEED_KEY`, et dans la configuration serveur de la Staff App. **Jamais dans du code envoyé à un navigateur.** Si la Staff App est une app web pure, l'appel doit passer par son propre serveur.
- Elle est comparée en temps constant. Une clé fausse renvoie `forbidden` après une petite attente (la même chose que pour les laissez-passer).
- La clé est **en lecture seule par construction** : l'action `hk_moves` ne sait rien écrire. Si la Staff App doit un jour renvoyer « chambre vide », ce sera une **autre** action avec une **autre** clé.
- Pour changer de clé, on remplace la propriété : effet immédiat, sans déploiement.

### 5.3 Limites connues

| Limite | Valeur / constat | Conséquence pour la Staff App |
| --- | --- | --- |
| **Temps d'exécution des déclencheurs** (compte gmail.com, gratuit) | 90 min par jour, au total | `B24_run` toutes les 5 min = 288 passes par jour. ⚠️ À surveiller (Exécutions du projet). **Ne pas ajouter de nouveau déclencheur fréquent** : `hk_moves` lit un cache au lieu d'appeler Beds24 à chaque requête. |
| **Appels sortants (UrlFetch)** | 20 000 par jour (gmail.com) | Une passe fait environ 14 appels Beds24, soit ~4 000 par jour. Marge correcte, à condition de ne pas appeler Beds24 à chaque requête de la Staff App. |
| **Exécutions simultanées de la web app** | ~30 | Interroger toutes les 1 à 5 minutes, pas plus. |
| **Latence d'un appel** | 0,5 à 3 s (démarrage à froid d'Apps Script) | Afficher la dernière réponse en attendant. |
| **Verrou global** (`LockService`) | Les écritures s'attendent jusqu'à 15 s, puis renvoient `busy` | `hk_moves` ne prend pas le verrou (lecture seule). |
| **Propriétés du script** | ~500 Ko au total | Sessions, laissez-passer et cache y vivent déjà. Le cache de `hk_moves` ira dans `CacheService`, pas dans les propriétés. |
| **Fraîcheur Beds24** | Jusqu'à 5 min de retard, plus le délai des canaux (2 à 3 min observés pour une prolongation) | Un départ ou une arrivée créés à l'instant peuvent manquer pendant quelques minutes. |
| **API Beds24 v1** | Plafond d'appels par période côté Beds24 (⚠️ valeur exacte à vérifier) | Une seule lecture Beds24 partagée par tout le monde, mise en cache. |
| **Versions Apps Script** | 196/200 | Faire le ménage avant d'ajouter `33.Housekeeping.gs`. |

**Plantages ou pièges déjà rencontrés :**

- un test daté en dur a fini par être refusé, parce que les opérations de plus de 14 jours sont refusées (protection contre une horloge déréglée) ;
- un double import (Cecile Roze) avant la mise en ligne, nettoyé à la main ;
- un « Nouveau déploiement » créé par erreur au lieu d'une « Nouvelle version » ;
- l'ancien récap `in/out` arrêté depuis le 03/11 sans alerte ;
- l'ancien service worker servait `index.html` à la place des pages annexes (corrigé le 18/11) ;
- un changement de chambre dans Beds24 ne baissait pas la ligne Unpaid (corrigé le 12/11).

---

## 6. Règles métier et décisions déjà prises

### 6.1 Règles à respecter

- **Beds24 est la source des réservations, la réception celle de l'argent encaissé sur place.** Règle du staff :
  - nouvelle nuit ou prolongation : dans **Beds24** ;
  - client qui paie tout de suite : paiement dans **Beds24** ;
  - client qui paie plus tard : à la **réception**, avec synchro automatique.
  - On **ne modifie jamais un paiement dans Beds24**, et l'option « Unpaid » a été retirée de Beds24.
- **Prolongation = réservation séparée** dans Beds24, rattachée au même client par la synchro.
- **Airbnb et Expedia Collect** sont toujours prépayés au canal : ligne `Transfer/Others`, jamais Unpaid.
- **Dortoirs vendus au lit** : Bola Bola, Pillow Room, Tree House, Gd Ma Female Dorm, Familly Rabbit Cave, Twin Room. Une unité = un lit. Deux personnes sur une seule réservation d'un dortoir déclenchent « Too many guests in booking » dans Beds24 : le prix doit être par personne × nombre de personnes, ou bien deux réservations. Pour la Staff App, **une unité libérée = un lit à refaire**, pas une chambre.
- **Chambres spéciales** :
  - « Double inside building » et « White House » regroupent des chambres nommées (Passion, Bamboo 1, Bamboo 2, Rabbit Dream) ;
  - White House accueille des locations au mois (« Tamu bulanan », prix 0 dans Beds24) ;
  - Familly Rabbit Cave et Gd Ma sont des dortoirs **féminins**.
- **Heures de check-in et de check-out** : ⚠️ **elles ne sont écrites nulle part dans le système**. La seule règle horaire codée concerne la location de matériel (retour avant 12:00 ou 18:00 le lendemain). À fixer avant de construire le check-out automatique (§4.2).
- **Horloge** : tout est en UTC+8 (heure de Lombok). L'identifiant de ligne d'Entries suit le fuseau du script (`Asia/Singapore`).

### 6.2 Ce qu'il ne faut surtout pas casser

1. **La colonne O d'Entries** (identifiant de 17 chiffres) et **les colonnes U et V** (réservation et ligne Beds24). Ce sont les clés de la synchro et des corrections hors ligne. Ne jamais insérer ou supprimer de colonnes dans Entries.
2. **Ne jamais écrire dans Beds24 depuis la Staff App**, ni modifier une ligne de paiement Beds24. La synchro compare les paiements des deux côtés : un paiement modifié ailleurs crée un écart, voire un doublon.
3. **L'adresse de la web app** : toujours « Nouvelle version » sur le déploiement existant. L'app hors ligne, le POS et le staff gear l'ont en dur.
4. **Les Script Properties** existantes : `B24_*`, `UI_*` (sessions, appareils, adresse du POS), `CI_*` (sessions de check-in, dossier des photos, laissez-passer).
5. **`Data activities`** : l'ordre et le sens des colonnes (Q à X). L'app et la synchro les lisent par position.
6. **Les déclencheurs** `B24_run` (toutes les 5 min) et `CI_cleanup` (chaque jour à 3 h), plus ceux de l'ancien système (clôture, rapports).
7. **`Entries Manual`** et les onglets `data1 (never touch)`, `BEDSDATA`, `POUCHDATA` : la clôture mensuelle en dépend.
8. **La règle « un paiement n'est jamais modifié automatiquement »** : la synchro ne baisse que des lignes Unpaid et signale le reste dans `B24_Control`.
9. **Les données personnelles** : passeports et photos restent dans `CI_Guests` et dans le dossier Drive privé. Ils ne doivent jamais apparaître dans un flux pour la Staff App. La photo est effacée 60 jours après le départ, le numéro au bout de 12 mois.

---

## 7. Proposition de mise en œuvre

| Étape | Contenu | Où |
| --- | --- | --- |
| 1 | Correspondance des unités : onglet `Units` (roomId, unitId, nom Beds24, nom Staff App) ; lecture de `unitId` dans `B24.arrivals` | `31.Beds24_sync.gs` + feuille |
| 2 | Départs du jour dans Beds24 (`departureFrom/To`) + cache de 2 min (`CacheService`) | `31.Beds24_sync.gs` |
| 3 | Onglet `CI_Moves` ; le check-in y écrit ; bouton « Checked out » dans l'onglet Check-in | `32.Checkin.gs`, `js/checkindesk.js` |
| 4 | Check-out automatique à l'heure de check-out (dans la passe `B24_run` existante, sans nouveau déclencheur) | `31` / `32` |
| 5 | Action `hk_moves` protégée par `HK_FEED_KEY` | `33.Housekeeping.gs` |
| 6 | (Optionnel) Retour « chambre vide constatée » depuis la Staff App, avec une clé séparée | `33.Housekeeping.gs` |

**À décider avant de construire :**

- l'heure de check-out (et de check-in) ;
- les noms des unités dans la Staff App ;
- la fréquence de lecture de la Staff App ;
- si la Staff App a un serveur (pour garder la clé hors du navigateur).
