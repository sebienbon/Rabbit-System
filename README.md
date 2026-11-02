# Rabbit-System

Interface de réception hors ligne de Rabbit Tree. Le staff travaille dans cette interface ; le Google Sheet reste la base de référence et le staff n'y a plus accès.

- **Interface** : les fichiers à la racine (`index.html`, `js/`, …), servis par GitHub Pages. Elle garde tout dans le navigateur et envoie les opérations au Sheet en arrière-plan, même après une coupure Internet de plusieurs heures.
- **Serveur** : `dev/server/30.UI_api.gs`, à coller dans le projet Apps Script lié au Sheet, publié en application web (exécuter en tant que : moi, accès : tout le monde).
- **Tests** : dans `dev/`, `npm i` puis `node --test tests/*.test.js` (serveur sur un faux Sheet), `node tests/e2e.js` (shifts), `node tests/e2e-sales.js` (ventes) `node tests/e2e-expenses.js` (dépenses) et `node tests/e2e-cash.js` (caisse), dans Chrome avec coupure simulée.

## Ce que fait l'interface
- Ouverture et fermeture de shift (Cashouts&Cor, ligne Cash-out dans Entries Manual).
- Vente : un ou plusieurs clients, produits de Data activities (Service, Transport, Tour), paiement ou « Unpaid ». Une ligne par produit et par client dans Entries et Entries Manual, identiques à celles des anciens dialogues.
- Factures clients : encaisser des lignes Unpaid (comme l'ancien dialogue de facturation).
- Dépenses : les 10 boutons de l'ancien dialogue Daily Expenses, écrites comme lui (Entries, Entries Manual, « Expense… » dans New guest). « Others » est enregistré sous « other » (l'ancien dialogue les perdait).
- Caisse : phantom cash (« Cash not given » / « Cash not received », avec commentaire) et « Solved », écrits dans Cashouts&Cor comme l'ancienne fenêtre Phantom Cash ; Cash Supply (ligne Income Cash + ligne Expense Extern Cash). Le phantom cash du shift compte dans l'argent attendu à la fermeture.
- Ce shift : totaux par moyen de paiement, corrections et suppressions, remboursements (ligne Expense, vente marquée « Refunded »).
- Droits : le staff ne corrige que ses propres ventes de son shift ouvert ; le manager tout. Chaque opération est journalisée dans UI_Log avec les anciennes valeurs.

## Mise en place sur un Sheet
1. Dans Apps Script, lancer `UI_setup` une fois (crée UI_Users, UI_Log, UI_Shifts).
2. Dans UI_Users, une ligne par personne : identifiant, nom affiché, rôle (staff / manager / admin), adresse Gmail utilisée dans les colonnes Author, et un mot de passe dans « Set new password here » (chiffré puis effacé à la première connexion).
3. Déployer > Nouveau déploiement > Application web. Mettre l'URL `/exec` dans `js/config.js`.
4. Sur l'ordinateur de réception, se connecter une fois avec un compte manager en cochant « Make this the reception computer ».

## Publier une mise à jour
Changer `VERSION` dans `sw.js`. L'ordinateur de réception se recharge tout seul dès que personne n'est en train de saisir.

Actuellement branché sur la **copie de test** du Sheet.
